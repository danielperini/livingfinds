/**
 * runAcosBidReductionEngine — Motor Determinístico de Redução de ACoS por Keyword
 *
 * Consolidado dentro do ecossistema do runUnifiedDecisionEngine.
 * NÃO é um motor paralelo: é invocado pelo runDeterministicDecisionEngine
 * como etapa 10e, ou diretamente para execução isolada.
 *
 * Fluxo:
 *   1. Identificar keywords ativas acima do ACoS-meta
 *   2. Verificar sugestão Amazon
 *   3. Primeira redução: -10% (ou sugestão Amazon se 5–15%)
 *   4. Aguardar 48h → reavaliar
 *   5. Segunda redução: -5% se ainda acima da meta
 *   6. Estabilizar quando atingir meta
 *
 * Guardrails:
 *   - Não processa campanhas pausadas/arquivadas/incompletas
 *   - Não processa keywords pausadas/arquivadas
 *   - Não processa produtos sem estoque ou fora do escopo autorizado
 *   - Não cria decisão duplicada dentro de 48h para a mesma keyword
 *   - Exige evidência mínima: ≥5 cliques, gasto > 0, ≥1 janela válida
 *   - Keywords sem venda → regra no_sales (não ACoS)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const ADS_CLIENT_ID = Deno.env.get('ADS_CLIENT_ID') || '';
const ADS_CLIENT_SECRET = Deno.env.get('ADS_CLIENT_SECRET') || '';
const ADS_REGION = Deno.env.get('ADS_REGION') || 'na';

const ENDPOINT_MAP: Record<string, string> = {
  na: 'https://advertising-api.amazon.com',
  eu: 'https://advertising-api-eu.amazon.com',
  fe: 'https://advertising-api-fe.amazon.com',
};

// ── Configurações desta rotina ──────────────────────────────────────────────
const CFG = {
  MIN_CLICKS: 5,
  MIN_SPEND: 0.01,
  COOLDOWN_48H: 48 * 3600 * 1000,        // ms
  STABILIZE_COOLDOWN: 72 * 3600 * 1000,  // ms após estabilização
  FIRST_REDUCTION_PCT: 0.10,             // 10%
  SECOND_REDUCTION_PCT: 0.05,            // 5%
  SUGGESTION_MIN_PCT: 0.05,              // Sugestão Amazon: mínimo 5%
  SUGGESTION_MAX_PCT: 0.15,              // Sugestão Amazon: limitar se > 15%
  IMPRESSION_DROP_THRESHOLD: 0.40,       // queda > 40% = visibility_drop
  WINNER_HOLD_MARGIN: 0.10,              // ACoS até 10% acima da meta = hold se lucrativo
  ACCUMULATION_APPROVAL_THRESHOLD: 0.25, // >25% acumulado = exige aprovação humana
  MAX_BID_FLOOR: 0.40,                   // nunca abaixo deste valor
};

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function uuid(): string { return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

// ── Classificar status de ACoS ───────────────────────────────────────────────
function classifyAcosStatus(currentAcos: number, targetAcos: number): {
  status: 'below_target' | 'at_target' | 'slightly_above_target' | 'high' | 'critical';
  acos_gap: number;
} {
  const gap = currentAcos - targetAcos;
  let status: 'below_target' | 'at_target' | 'slightly_above_target' | 'high' | 'critical';
  if (currentAcos <= targetAcos) status = currentAcos < targetAcos * 0.95 ? 'below_target' : 'at_target';
  else if (currentAcos <= targetAcos * 1.10) status = 'slightly_above_target';
  else if (currentAcos <= targetAcos * 1.50) status = 'high';
  else status = 'critical';
  return { status, acos_gap: Math.round(gap * 10) / 10 };
}

// ── Resolver meta de ACoS por hierarquia ────────────────────────────────────
function resolveTargetAcos(kw: any, campaign: any, product: any, accountSettings: any): {
  target_acos: number;
  source: string;
} {
  // 1. keyword-level target
  if (kw.target_acos && Number(kw.target_acos) > 0) {
    return { target_acos: Number(kw.target_acos), source: 'keyword' };
  }
  // 2. produto
  if (product?.break_even_acos_pct && Number(product.break_even_acos_pct) > 0) {
    return { target_acos: Number(product.break_even_acos_pct), source: 'product' };
  }
  // 3. campanha
  if (campaign?.target_acos && Number(campaign.target_acos) > 0) {
    return { target_acos: Number(campaign.target_acos), source: 'campaign' };
  }
  // 4. conta / PerformanceSettings
  if (accountSettings?.target_acos && Number(accountSettings.target_acos) > 0) {
    return { target_acos: Number(accountSettings.target_acos), source: 'account_settings' };
  }
  // 5. default
  return { target_acos: 20, source: 'system_default' };
}

// ── Obter token Ads ──────────────────────────────────────────────────────────
async function getAdsToken(refreshToken: string): Promise<string | null> {
  if (!refreshToken || !ADS_CLIENT_ID || !ADS_CLIENT_SECRET) return null;
  try {
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: ADS_CLIENT_ID,
        client_secret: ADS_CLIENT_SECRET,
      }).toString(),
    });
    if (!res.ok) return null;
    return (await res.json()).access_token || null;
  } catch { return null; }
}

// ── Buscar sugestão de bid da Amazon Ads API ─────────────────────────────────
async function fetchAmazonBidSuggestion(
  accessToken: string, profileId: string, keywordId: string, adGroupId: string
): Promise<{ suggested: number | null; lower: number | null; upper: number | null }> {
  const endpoint = ENDPOINT_MAP[ADS_REGION] || ENDPOINT_MAP.na;
  try {
    const res = await fetch(`${endpoint}/sp/keywords/bidRecommendations`, {
      method: 'POST',
      headers: {
        'Amazon-Advertising-API-ClientId': ADS_CLIENT_ID,
        'Amazon-Advertising-API-Scope': profileId,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/vnd.spkeywordBidRecommendation.v3+json',
        'Accept': 'application/vnd.spkeywordBidRecommendation.v3+json',
      },
      body: JSON.stringify({
        adGroupId,
        keywords: [{ keywordId }],
      }),
    });
    if (!res.ok) return { suggested: null, lower: null, upper: null };
    const data = await res.json();
    const rec = data?.keywordsBidRecommendations?.[0];
    if (!rec) return { suggested: null, lower: null, upper: null };
    return {
      suggested: rec.recommendedBid?.rangeMedian ?? rec.recommendedBid?.suggested ?? null,
      lower: rec.recommendedBid?.rangeStart ?? null,
      upper: rec.recommendedBid?.rangeEnd ?? null,
    };
  } catch { return { suggested: null, lower: null, upper: null }; }
}

// ── Aplicar bid na Amazon Ads API ─────────────────────────────────────────────
async function applyBidOnAmazon(
  accessToken: string, profileId: string, keywordId: string, newBid: number
): Promise<{ ok: boolean; http_status: number; request_id: string; confirmed_bid: number | null; error?: string }> {
  const endpoint = ENDPOINT_MAP[ADS_REGION] || ENDPOINT_MAP.na;
  const payload = { keywords: [{ keywordId, bid: newBid }] };
  try {
    const res = await fetch(`${endpoint}/sp/keywords`, {
      method: 'PUT',
      headers: {
        'Amazon-Advertising-API-ClientId': ADS_CLIENT_ID,
        'Amazon-Advertising-API-Scope': profileId,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/vnd.spKeyword.v3+json',
        'Accept': 'application/vnd.spKeyword.v3+json',
      },
      body: JSON.stringify(payload),
    });
    const requestId = res.headers.get('x-amzn-RequestId') || res.headers.get('x-amzn-requestid') || uuid();
    const httpStatus = res.status;
    if (httpStatus === 429) return { ok: false, http_status: 429, request_id: requestId, confirmed_bid: null, error: 'rate_limit' };
    if (httpStatus >= 500) return { ok: false, http_status: httpStatus, request_id: requestId, confirmed_bid: null, error: 'server_error' };
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, http_status: httpStatus, request_id: requestId, confirmed_bid: null, error: body.slice(0, 200) };
    }
    const data = await res.json().catch(() => ({}));
    const success = (data?.keywords?.success || []);
    const confirmed_bid = success[0]?.bid ?? null;
    return { ok: success.length > 0, http_status: httpStatus, request_id: requestId, confirmed_bid };
  } catch (e: any) {
    return { ok: false, http_status: 0, request_id: '', confirmed_bid: null, error: e.message };
  }
}

// ── HANDLER PRINCIPAL ─────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const t0 = Date.now();
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  try {
    const base44 = createClientFromRequest(req);
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    const body = await req.json().catch(() => ({}));
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    // ── Resolver conta ─────────────────────────────────────────────────────
    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada.' });
    const aid = account.id;
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';

    const dry_run = body.dry_run === true;

    // ── Verificar freshness dos dados ──────────────────────────────────────
    const dataAgeH = account.last_sync_at
      ? (Date.now() - new Date(account.last_sync_at).getTime()) / 3600000 : 999;
    if (dataAgeH > 48) {
      return Response.json({ ok: false, skipped: true, reason: `Dados desatualizados (${Math.round(dataAgeH)}h). Execute sync primeiro.` });
    }

    // ── Carregar configurações de performance ──────────────────────────────
    let accountSettings: any = null;
    try {
      const ps = await base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1);
      if (ps[0]) accountSettings = { target_acos: ps[0].target_acos, min_bid: ps[0].min_bid, max_bid: ps[0].max_bid };
    } catch {}
    const minBid = Math.max(CFG.MAX_BID_FLOOR, accountSettings?.min_bid || 0.40);
    const maxBid = accountSettings?.max_bid || 5.00;

    // ── Carregar dados ─────────────────────────────────────────────────────
    const cutoff14d = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const [keywords, campaigns, products, existingCycles, pendingDecisions] = await Promise.all([
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-spend', 1000),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 300),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid, status: 'active' }, null, 200),
      base44.asServiceRole.entities.KeywordBidOptimizationCycle.filter(
        { amazon_account_id: aid }, '-created_at', 500
      ).catch(() => [] as any[]),
      base44.asServiceRole.entities.OptimizationDecision.filter(
        { amazon_account_id: aid, status: 'approved' }, null, 500
      ).catch(() => [] as any[]),
    ]);

    // ── Índices ────────────────────────────────────────────────────────────
    const campaignMap = new Map<string, any>();
    for (const c of campaigns) {
      if (c.campaign_id) campaignMap.set(c.campaign_id, c);
      if (c.amazon_campaign_id) campaignMap.set(c.amazon_campaign_id, c);
    }

    const productMap = new Map<string, any>();
    for (const p of products) { if (p.asin) productMap.set(p.asin, p); }

    // Índice de ciclos ativos por keyword_id
    const activeCycleByKw = new Map<string, any>();
    for (const cyc of existingCycles) {
      if (!cyc.keyword_id) continue;
      const existing = activeCycleByKw.get(cyc.keyword_id);
      if (!existing || new Date(cyc.created_at || 0) > new Date(existing.created_at || 0)) {
        activeCycleByKw.set(cyc.keyword_id, cyc);
      }
    }

    // Índice de decisões pending por keyword_id (para evitar duplicatas)
    const pendingByKw = new Set<string>();
    for (const d of pendingDecisions) {
      if (d.keyword_id) pendingByKw.add(d.keyword_id);
    }

    // ── Scope guard: ASINs autorizados/elegíveis ───────────────────────────
    const eligibleAsins = new Set<string>();
    for (const p of products) {
      if (!p.asin) continue;
      if (p.ads_scope_status === 'authorized' && p.ads_eligibility_status === 'eligible') {
        eligibleAsins.add(p.asin);
      }
    }

    // ── Obter token Ads para execução ──────────────────────────────────────
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
    let accessToken: string | null = null;
    if (!dry_run && profileId) {
      accessToken = await getAdsToken(refreshToken);
    }

    // ── Loop principal ─────────────────────────────────────────────────────
    const results: any[] = [];
    const stats = {
      evaluated: 0,
      skipped_campaign: 0,
      skipped_scope: 0,
      skipped_no_evidence: 0,
      skipped_no_sales_rule: 0,
      skipped_winner_hold: 0,
      skipped_cooldown: 0,
      skipped_at_target: 0,
      skipped_pending_decision: 0,
      first_reduction_10pct: 0,
      first_reduction_amazon_suggestion: 0,
      second_reduction_5pct: 0,
      stabilized: 0,
      visibility_drop: 0,
      requires_approval: 0,
      evaluation_reevaluated: 0,
    };

    // ── Processar reavaliações de ciclos com 48h vencidas ──────────────────
    const now_ms = Date.now();
    for (const cyc of existingCycles) {
      if (cyc.cycle_status !== 'waiting_48h_evaluation') continue;
      if (!cyc.evaluation_due_at) continue;
      const due = new Date(cyc.evaluation_due_at).getTime();
      if (now_ms < due) continue; // ainda não venceu

      stats.evaluation_reevaluated++;

      // Buscar keyword atual
      const kws = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid, keyword_id: cyc.keyword_id }, null, 1).catch(() => [] as any[]);
      const kw = kws[0];
      if (!kw) {
        await base44.asServiceRole.entities.KeywordBidOptimizationCycle.update(cyc.id, {
          cycle_status: 'cancelled', stop_reason: 'keyword_not_found', updated_at: now,
        }).catch(() => {});
        continue;
      }

      const postImpressions = kw.impressions || 0;
      const postAcos = kw.acos || 0;
      const postOrders = kw.orders || 0;

      const impressionChangePct = cyc.pre_change_impressions > 0
        ? ((postImpressions - cyc.pre_change_impressions) / cyc.pre_change_impressions) * 100
        : 0;
      const acosChangePct = cyc.pre_change_acos > 0
        ? ((postAcos - cyc.pre_change_acos) / cyc.pre_change_acos) * 100
        : 0;

      const updates: any = {
        post_change_impressions: postImpressions,
        post_change_acos: postAcos,
        post_change_orders: postOrders,
        impression_change_pct: Math.round(impressionChangePct * 10) / 10,
        acos_change_pct: Math.round(acosChangePct * 10) / 10,
        current_acos: postAcos,
        updated_at: now,
      };

      // Impressões zeradas
      if (postImpressions === 0 && cyc.pre_change_impressions > 0) {
        updates.cycle_status = 'zero_impressions';
        updates.stop_reason = 'impressions_zeroed_after_bid_reduction';
        await base44.asServiceRole.entities.KeywordBidOptimizationCycle.update(cyc.id, updates).catch(() => {});
        continue;
      }

      // Queda > 40%
      if (impressionChangePct < -(CFG.IMPRESSION_DROP_THRESHOLD * 100)) {
        updates.cycle_status = 'visibility_drop';
        updates.visibility_drop_detected = true;
        updates.stop_reason = `Impressões caíram ${Math.abs(Math.round(impressionChangePct))}% após redução`;
        await base44.asServiceRole.entities.KeywordBidOptimizationCycle.update(cyc.id, updates).catch(() => {});
        stats.visibility_drop++;
        continue;
      }

      // Parou de vender após redução
      if (postOrders === 0 && (cyc.pre_change_orders || 0) > 0 && (kw.clicks || 0) >= CFG.MIN_CLICKS) {
        updates.cycle_status = 'no_sales_after_reduction';
        updates.stop_reason = 'Keyword parou de converter após redução de bid — encaminhar para regra no_sales';
        await base44.asServiceRole.entities.KeywordBidOptimizationCycle.update(cyc.id, updates).catch(() => {});
        continue;
      }

      // Atingiu a meta
      const { target_acos } = cyc;
      if (postAcos > 0 && target_acos > 0 && postAcos <= target_acos * 1.03) {
        updates.cycle_status = 'stabilized';
        updates.stabilized_at = now;
        updates.stop_reason = `ACoS ${postAcos.toFixed(1)}% atingiu meta ${target_acos}%`;
        await base44.asServiceRole.entities.KeywordBidOptimizationCycle.update(cyc.id, updates).catch(() => {});
        stats.stabilized++;
        // Atualizar keyword com status de estabilização
        await base44.asServiceRole.entities.Keyword.update(kw.id, {
          bid_optimization_status: 'stabilized',
          updated_at: now,
        }).catch(() => {});
        continue;
      }

      // Ainda acima da meta — segunda redução de 5%
      if (postAcos > 0 && target_acos > 0 && postAcos > target_acos && postOrders > 0 && !pendingByKw.has(cyc.keyword_id)) {
        const currentBid = kw.bid || kw.current_bid || 0.25;
        const totalReductionSoFar = cyc.total_reduction_pct || 0;

        // Exigir aprovação humana se redução acumulada > 25%
        const requiresApproval = totalReductionSoFar + CFG.SECOND_REDUCTION_PCT * 100 > CFG.ACCUMULATION_APPROVAL_THRESHOLD * 100;

        const newBid = Math.max(minBid, Math.round(currentBid * (1 - CFG.SECOND_REDUCTION_PCT) * 100) / 100);
        if (newBid < currentBid - 0.005) {
          updates.cycle_status = requiresApproval ? 'requires_approval' : 'reduced_again';
          updates.second_reduction_pct = CFG.SECOND_REDUCTION_PCT * 100;
          updates.total_reduction_pct = totalReductionSoFar + CFG.SECOND_REDUCTION_PCT * 100;
          updates.current_bid = newBid;
          updates.requires_human_approval = requiresApproval;
          updates.evaluation_due_at = new Date(now_ms + CFG.COOLDOWN_48H).toISOString();

          if (!requiresApproval) {
            // Criar OptimizationDecision de segunda redução
            const iKey = `acos_reduce_5pct|${aid}|${cyc.keyword_id}|${today}`;
            const dec = await base44.asServiceRole.entities.OptimizationDecision.create({
              amazon_account_id: aid,
              decision_type: 'bid_change',
              entity_type: 'keyword',
              entity_id: cyc.keyword_id,
              campaign_id: cyc.campaign_id,
              keyword_id: cyc.keyword_id,
              keyword_text: cyc.keyword_text,
              asin: cyc.asin,
              action: 'set_bid',
              value_before: currentBid,
              value_after: newBid,
              rationale: `[ACoS Reduction -5%] ACoS ${postAcos.toFixed(1)}% ainda acima da meta ${target_acos}% após 48h. Segunda redução -5%: R$${currentBid.toFixed(2)} → R$${newBid.toFixed(2)}. Impressões: ${impressionChangePct > 0 ? '+' : ''}${Math.round(impressionChangePct)}%.`,
              rule_key: 'acos_bid_reduce_5',
              risk: 'low',
              status: 'approved',
              requires_approval: false,
              idempotency_key: iKey,
              source_function: 'runAcosBidReductionEngine',
              created_at: now,
            }).catch(() => null);

            if (dec?.id) updates.optimization_decision_id = dec.id;
            stats.second_reduction_5pct++;
          } else {
            stats.requires_approval++;
          }

          await base44.asServiceRole.entities.KeywordBidOptimizationCycle.update(cyc.id, updates).catch(() => {});
        } else {
          // Bid já no mínimo
          await base44.asServiceRole.entities.KeywordBidOptimizationCycle.update(cyc.id, {
            cycle_status: 'stabilized',
            stop_reason: 'Bid já no mínimo permitido',
            updated_at: now,
          }).catch(() => {});
        }
      } else {
        // Dados incompletos para segunda redução
        await base44.asServiceRole.entities.KeywordBidOptimizationCycle.update(cyc.id, {
          ...updates,
          cycle_status: 'insufficient_data',
          stop_reason: 'Dados insuficientes para segunda redução (sem vendas ou ACoS inválido)',
        }).catch(() => {});
      }
    }

    // ── Detectar novas keywords acima da meta ──────────────────────────────
    for (const kw of keywords) {
      stats.evaluated++;

      const kwId = kw.keyword_id || kw.id;
      if (!kwId) continue;

      // Filtrar apenas keywords ativas
      const kwState = (kw.state || kw.status || '').toLowerCase();
      if (kwState !== 'enabled') continue;

      // Verificar campanha
      const campaign = campaignMap.get(kw.campaign_id);
      if (!campaign) { stats.skipped_campaign++; continue; }
      const campState = (campaign.state || campaign.status || '').toLowerCase();
      if (!['enabled', 'active'].includes(campState)) { stats.skipped_campaign++; continue; }
      // Ignorar campanhas incompletas
      if (campaign.is_incomplete || campState === 'incomplete') { stats.skipped_campaign++; continue; }

      // Escopo autorizado
      const asin = kw.asin || campaign.asin || null;
      if (asin && !eligibleAsins.has(asin)) { stats.skipped_scope++; continue; }

      // Verificar produto: estoque
      const product = asin ? productMap.get(asin) : null;
      if (product && (product.fba_inventory || 0) <= 0) { stats.skipped_scope++; continue; }

      // Evidência mínima: ≥5 cliques, gasto > 0
      const clicks = kw.clicks || 0;
      const spend = kw.spend || 0;
      const orders = kw.orders || 0;
      const acos = kw.acos || 0;
      if (clicks < CFG.MIN_CLICKS || spend <= CFG.MIN_SPEND) { stats.skipped_no_evidence++; continue; }

      // Keywords sem venda → regra no_sales, não esta
      if (orders === 0 || acos === 0) { stats.skipped_no_sales_rule++; continue; }

      // Resolver meta de ACoS
      const { target_acos, source: targetSource } = resolveTargetAcos(kw, campaign, product, accountSettings);
      const { status: acosStatus, acos_gap } = classifyAcosStatus(acos, target_acos);

      // Não está acima da meta
      if (['below_target', 'at_target'].includes(acosStatus)) { stats.skipped_at_target++; continue; }

      // Hold: slightly_above_target + keyword lucrativa (ACoS ≤ target * 1.10 com vendas sólidas)
      if (acosStatus === 'slightly_above_target') {
        // Verificar tendência de melhora: se tem vendas e acos próximo, dar hold
        const isWinner = orders >= 2 && acos <= target_acos * 1.10;
        if (isWinner) { stats.skipped_winner_hold++; continue; }
      }

      // Verificar se já existe decisão pending para esta keyword
      if (pendingByKw.has(kwId)) { stats.skipped_pending_decision++; continue; }

      // Verificar cooldown de 48h (ciclo ativo recente)
      const lastCycle = activeCycleByKw.get(kwId);
      if (lastCycle) {
        const lastTs = new Date(lastCycle.executed_at || lastCycle.created_at || 0).getTime();
        const timeSince = now_ms - lastTs;

        // Ainda em espera de 48h
        if (lastCycle.cycle_status === 'waiting_48h_evaluation' && timeSince < CFG.COOLDOWN_48H) {
          stats.skipped_cooldown++;
          continue;
        }
        // Estabilizado: congelar por 72h
        if (lastCycle.cycle_status === 'stabilized') {
          const stabilizedAt = new Date(lastCycle.stabilized_at || lastCycle.updated_at || 0).getTime();
          if (now_ms - stabilizedAt < CFG.STABILIZE_COOLDOWN) {
            stats.skipped_cooldown++;
            continue;
          }
        }
        // Visibility drop: aguardar mais 48h
        if (['visibility_drop', 'zero_impressions'].includes(lastCycle.cycle_status)) {
          if (timeSince < CFG.COOLDOWN_48H) { stats.skipped_cooldown++; continue; }
        }
      }

      // ── Calcular nova redução de bid ─────────────────────────────────────
      const currentBid = kw.bid || kw.current_bid || 0.25;
      let newBid = currentBid;
      let usedSuggestion = false;
      let suggestionLimited = false;
      let suggestedBid: number | null = null;
      let suggestedLower: number | null = null;
      let suggestedUpper: number | null = null;
      let reductionLabel = 'acos_bid_reduce_10';

      // Passo 1: verificar sugestão Amazon
      if (!dry_run && accessToken && profileId && kw.ad_group_id) {
        const suggestion = await fetchAmazonBidSuggestion(accessToken, profileId, kwId, kw.ad_group_id);
        suggestedBid = suggestion.suggested;
        suggestedLower = suggestion.lower;
        suggestedUpper = suggestion.upper;

        if (suggestedBid !== null && suggestedBid < currentBid) {
          const suggReductionPct = (currentBid - suggestedBid) / currentBid;
          if (suggReductionPct >= CFG.SUGGESTION_MIN_PCT && suggReductionPct <= CFG.SUGGESTION_MAX_PCT) {
            // Sugestão dentro do intervalo aceitável: usar
            newBid = Math.max(minBid, Math.round(suggestedBid * 100) / 100);
            usedSuggestion = true;
            reductionLabel = 'acos_bid_reduce_amazon_suggestion';
            stats.first_reduction_amazon_suggestion++;
          } else if (suggReductionPct > CFG.SUGGESTION_MAX_PCT) {
            // Sugestão excessiva: limitar a 10%
            newBid = Math.max(minBid, Math.round(currentBid * (1 - CFG.FIRST_REDUCTION_PCT) * 100) / 100);
            usedSuggestion = false;
            suggestionLimited = true;
            stats.first_reduction_10pct++;
          } else {
            // Sugestão menor que 5%: usar redução manual de 10%
            newBid = Math.max(minBid, Math.round(currentBid * (1 - CFG.FIRST_REDUCTION_PCT) * 100) / 100);
            stats.first_reduction_10pct++;
          }
        } else {
          // Sem sugestão ou sugestão >= bid atual: redução manual de 10%
          newBid = Math.max(minBid, Math.round(currentBid * (1 - CFG.FIRST_REDUCTION_PCT) * 100) / 100);
          stats.first_reduction_10pct++;
        }
      } else {
        // Sem acesso a API: redução manual de 10%
        newBid = Math.max(minBid, Math.round(currentBid * (1 - CFG.FIRST_REDUCTION_PCT) * 100) / 100);
        stats.first_reduction_10pct++;
      }

      // Verificar se bid já está no mínimo
      if (newBid >= currentBid - 0.005) {
        stats.skipped_cooldown++;
        continue;
      }

      const actualReductionPct = Math.round(((currentBid - newBid) / currentBid) * 1000) / 10;

      // Exigir aprovação se redução acumulada já supera 25%
      const totalCyclePct = (lastCycle?.total_reduction_pct || 0) + actualReductionPct;
      const requiresApproval = totalCyclePct > CFG.ACCUMULATION_APPROVAL_THRESHOLD * 100;

      // ── Criar OptimizationDecision ───────────────────────────────────────
      const iKey = `${reductionLabel}|${aid}|${kwId}|${today}`;
      let decisionId: string | null = null;
      if (!dry_run) {
        const dec = await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id: aid,
          decision_type: 'bid_change',
          entity_type: 'keyword',
          entity_id: kwId,
          campaign_id: kw.campaign_id,
          keyword_id: kwId,
          keyword_text: kw.keyword_text,
          asin,
          action: 'set_bid',
          value_before: currentBid,
          value_after: newBid,
          rationale: `[ACoS Reduction ${usedSuggestion ? 'Amazon Suggestion' : `-${actualReductionPct}%`}] ACoS ${acos.toFixed(1)}% (${acosStatus}) vs meta ${target_acos}% (${targetSource}). Bid: R$${currentBid.toFixed(2)} → R$${newBid.toFixed(2)}${usedSuggestion ? ` (sugestão Amazon R$${(suggestedBid || 0).toFixed(2)})` : ''}${suggestionLimited ? ' (sugestão limitada pelo guardrail)' : ''}. Cliques: ${clicks}, Spend: R$${spend.toFixed(2)}, Pedidos: ${orders}.`,
          rule_key: reductionLabel,
          risk: requiresApproval ? 'high' : 'low',
          status: requiresApproval ? 'pending' : 'approved',
          requires_approval: requiresApproval,
          idempotency_key: iKey,
          source_function: 'runAcosBidReductionEngine',
          created_at: now,
        }).catch(() => null);
        decisionId = dec?.id || null;
        if (requiresApproval) stats.requires_approval++;
      }

      // ── Criar/atualizar ciclo de otimização ─────────────────────────────
      const cycleRecord: any = {
        amazon_account_id: aid,
        campaign_id: kw.campaign_id,
        ad_group_id: kw.ad_group_id || '',
        keyword_id: kwId,
        keyword_text: kw.keyword_text || '',
        match_type: kw.match_type || '',
        asin: asin || '',
        target_acos,
        target_acos_source: targetSource,
        initial_acos: acos,
        current_acos: acos,
        acos_gap,
        acos_status: acosStatus,
        initial_bid: currentBid,
        current_bid: newBid,
        amazon_suggested_bid: suggestedBid,
        amazon_suggested_bid_lower: suggestedLower,
        amazon_suggested_bid_upper: suggestedUpper,
        amazon_suggestion_used: usedSuggestion,
        amazon_suggestion_limited: suggestionLimited,
        first_reduction_pct: actualReductionPct,
        total_reduction_pct: actualReductionPct,
        cycle_number: (lastCycle?.cycle_number || 0) + 1,
        cycle_status: dry_run ? 'detected' : (requiresApproval ? 'requires_approval' : 'executed'),
        executed_at: dry_run ? null : now,
        evaluation_due_at: dry_run ? null : new Date(now_ms + CFG.COOLDOWN_48H).toISOString(),
        pre_change_impressions: kw.impressions || 0,
        pre_change_acos: acos,
        pre_change_cpc: kw.cpc || 0,
        pre_change_orders: orders,
        optimization_decision_id: decisionId,
        idempotency_key: iKey,
        requires_human_approval: requiresApproval,
        created_at: now,
        updated_at: now,
      };

      if (!dry_run) {
        await base44.asServiceRole.entities.KeywordBidOptimizationCycle.create(cycleRecord).catch(() => {});
      }

      results.push({
        keyword_text: kw.keyword_text,
        keyword_id: kwId,
        campaign_id: kw.campaign_id,
        asin,
        current_acos: acos,
        target_acos,
        target_acos_source: targetSource,
        acos_status: acosStatus,
        bid_before: currentBid,
        amazon_suggested_bid: suggestedBid,
        bid_after: newBid,
        reduction_pct: actualReductionPct,
        used_amazon_suggestion: usedSuggestion,
        suggestion_limited: suggestionLimited,
        status: dry_run ? 'dry_run' : (requiresApproval ? 'requires_approval' : 'executed'),
        evaluation_due_at: cycleRecord.evaluation_due_at,
        requires_approval: requiresApproval,
      });

      // Rate limit
      if (!dry_run && results.length > 1) await sleep(200);
    }

    return Response.json({
      ok: true,
      dry_run,
      engine: 'acos_bid_reduction_v1',
      account_id: aid,
      data_age_hours: Math.round(dataAgeH),
      stats,
      reductions_applied: results.length,
      results,
      note: 'Motor de redução de ACoS determinístico. Ciclos registrados em KeywordBidOptimizationCycle. Reavaliações ocorrem 48h após cada redução.',
      duration_ms: Date.now() - t0,
    });

  } catch (error: any) {
    console.error('[runAcosBidReductionEngine]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});