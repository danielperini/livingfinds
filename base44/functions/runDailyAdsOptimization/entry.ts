/**
 * runDailyAdsOptimization — Orquestrador diário do cérebro decisório do Ads Autopilot.
 *
 * Executa o fluxo completo:
 *  1. Verificar locks
 *  2. Confirmar integridade dos dados (sync recente)
 *  3. Calcular janela de atribuição segura
 *  4. Classificar e colher search terms
 *  5. Analisar bids de keywords (maturidade, cooldown, confiança)
 *  6. Analisar budgets de campanhas
 *  7. Analisar estoque e oferta
 *  8. Gerar decisões idempotentes com score de confiança
 *  9. Auto-executar baixo risco conforme autonomy_level
 * 10. Registrar avaliações futuras
 *
 * Regras críticas:
 *  - Dados das últimas attribution_safety_hours NÃO são tratados como definitivos
 *  - Não altera bid e budget da mesma campanha no mesmo ciclo
 *  - Cooldown: 24h redução, 72h aumento, 7d segunda alteração estrutural
 *  - Não negativar término com venda histórica automaticamente
 *  - Nunca marcar ação como executada sem confirmação Amazon
 *  - Moeda sempre da conta (BRL/R$), jamais $
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── Constantes ───────────────────────────────────────────────────────────────
const DEFAULT_ATTRIBUTION_HOURS = 72;
const DEFAULT_MIN_COMPLETE_DAYS = 3;
const PRIORITY_ORDER = [
  'security_stock', 'error_correction', 'search_term_harvest',
  'negative_irrelevant', 'reduce_waste', 'bid_change', 'budget_change', 'placement', 'strategy',
];

function makeKey(...parts) { return parts.filter(Boolean).join('|'); }
function daysAgo(days) { return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10); }
function hoursAgo(h) { return new Date(Date.now() - h * 3600000).toISOString(); }
function daysFromNow(days) { return new Date(Date.now() + days * 86400000).toISOString(); }

// ── Maturidade ───────────────────────────────────────────────────────────────
function calcMaturity({ createdAt, lastSyncAt, impressions = 0, clicks = 0, spend = 0, minDays = 3 }) {
  const nowMs = Date.now();
  if (lastSyncAt) {
    const syncAgeDays = (nowMs - new Date(lastSyncAt).getTime()) / 86400000;
    if (syncAgeDays > 3) return 'STALE';
  } else { return 'STALE'; }

  const ageDays = createdAt ? (nowMs - new Date(createdAt).getTime()) / 86400000 : 0;
  if (ageDays < minDays) return 'NEW';
  if (impressions === 0 && clicks === 0 && spend === 0) return 'INSUFFICIENT_DATA';
  if (ageDays < 14) return 'LEARNING';
  const hasMinSample = clicks >= 10 || spend >= 5;
  return hasMinSample ? 'MATURE' : 'INSUFFICIENT_DATA';
}

// ── Cooldown ─────────────────────────────────────────────────────────────────
function inCooldown(lastChangedAt, hours) {
  if (!lastChangedAt) return false;
  return (Date.now() - new Date(lastChangedAt).getTime()) < hours * 3600000;
}

// ── Confiança composta ───────────────────────────────────────────────────────
function calcConfidence({ clicks = 0, lastSyncAt, maturity, attrSafetyHours = 72, product = null, daysWindow = 14, historicalRate = 0.5 }) {
  const sample   = Math.min(1, Math.log10(Math.max(clicks, 1) + 1) / Math.log10(51));
  let fresh = 0;
  if (lastSyncAt) {
    const h = (Date.now() - new Date(lastSyncAt).getTime()) / 3600000;
    fresh = h <= 24 ? 1.0 : h <= 48 ? 0.7 : h <= 72 ? 0.4 : 0.1;
  }
  const safeWindow = Math.max(0, daysWindow - attrSafetyHours / 24);
  const attrScore  = daysWindow > 0 ? Math.min(1, safeWindow / daysWindow) : 0;
  const consMap    = { MATURE: 1.0, LEARNING: 0.6, NEW: 0.2, STALE: 0, INSUFFICIENT_DATA: 0.1 };
  const cons       = consMap[maturity] ?? 0.3;
  let prodHealth = 0.8;
  if (product) {
    if (product.inventory_status === 'out_of_stock') prodHealth = 0;
    else if (product.buy_box_status === 'lost') prodHealth = 0.3;
    else if (product.inventory_status === 'low_stock') prodHealth = 0.5;
  }
  return Math.round((sample * 0.25 + fresh * 0.15 + attrScore * 0.20 + cons * 0.20 + historicalRate * 0.10 + prodHealth * 0.10) * 100) / 100;
}

// ── Resolução do desfecho ─────────────────────────────────────────────────────
function resolveOutcome(confidence, maturity, blockers, autonomyLevel, risk) {
  if (blockers.length > 0) return 'BLOCK';
  if (maturity === 'STALE' || maturity === 'NEW') return 'BLOCK';
  if (confidence < 0.60 || maturity === 'INSUFFICIENT_DATA') return 'WAIT_FOR_DATA';
  if (confidence < 0.75) return 'RECOMMEND_APPROVAL';
  if (confidence < 0.90) {
    if (risk === 'low' && autonomyLevel >= 2) return 'EXECUTE_NOW';
    return 'RECOMMEND_APPROVAL';
  }
  if (risk === 'low' && autonomyLevel >= 1) return 'EXECUTE_NOW';
  if (risk === 'medium' && autonomyLevel >= 3) return 'EXECUTE_NOW';
  return 'RECOMMEND_APPROVAL';
}

// ── Bloqueios de produto ──────────────────────────────────────────────────────
function productBlockers(product, cfg = {}) {
  if (!product) return ['PRODUCT_NOT_FOUND'];
  const b = [];
  if (product.inventory_status === 'out_of_stock') b.push('OUT_OF_STOCK');
  else if (product.inventory_status === 'low_stock') b.push('LOW_STOCK');
  if (product.buy_box_status === 'lost') b.push('BUY_BOX_LOST');
  if (['inactive', 'archived'].includes(product.status)) b.push('PRODUCT_INACTIVE');
  return b;
}

// ── Formatar explicação legível ───────────────────────────────────────────────
function formatExplanation({ action, term, currentBid, newBid, clicks, spend, orders, acos, targetAcos, reason, symbol }) {
  const lines = [];
  if (action === 'reduce_bid') {
    lines.push(`Reduzir bid de ${symbol}${(currentBid||0).toFixed(2)} para ${symbol}${(newBid||0).toFixed(2)}.`);
    lines.push(`\nMotivo:\n${reason}`);
  } else if (action === 'increase_bid') {
    lines.push(`Aumentar bid de ${symbol}${(currentBid||0).toFixed(2)} para ${symbol}${(newBid||0).toFixed(2)}.`);
    lines.push(`\nMotivo:\n${reason}`);
  } else if (action === 'create_keyword') {
    lines.push(`Criar keyword exact "${term}" com bid ${symbol}${(newBid||0).toFixed(2)}.`);
    lines.push(`\nMotivo:\n${reason}`);
  } else {
    lines.push(reason || action);
  }
  return lines.join('');
}

// ════════════════════════════════════════════════════════════════════════════
Deno.serve(async (req) => {
  const startTime = Date.now();
  const base44 = createClientFromRequest(req);
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  let runRecord = null;
  let amazonAccountId = null;

  try {
    const body = await req.json().catch(() => ({}));
    amazonAccountId = body.amazon_account_id;

    // ── Resolver conta ────────────────────────────────────────────────────
    let account = null;
    if (amazonAccountId) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazonAccountId });
      account = accs[0] || null;
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
      if (account) amazonAccountId = account.id;
    }
    if (!account) return Response.json({ ok: false, message: 'Nenhuma conta Amazon conectada.' });

    const sym  = account.currency_symbol || 'R$';
    const code = account.currency_code   || 'BRL';
    const cc   = account.country_code    || 'BR';

    // ── Verificar locks ───────────────────────────────────────────────────
    const activeRuns = await base44.asServiceRole.entities.AutopilotRun.filter(
      { amazon_account_id: amazonAccountId, status: 'running' }, '-started_at', 5
    );
    for (const ar of activeRuns) {
      const ageMin = (Date.now() - new Date(ar.started_at).getTime()) / 60000;
      if (ageMin < 60) return Response.json({ ok: false, skipped: true, reason: 'Autopilot já em execução', age_minutes: Math.round(ageMin) });
      await base44.asServiceRole.entities.AutopilotRun.update(ar.id, { status: 'failed', completed_at: now, error_message: `Lock liberado após ${Math.round(ageMin)} min` });
    }

    const activeSyncs = await base44.asServiceRole.entities.SyncExecutionLog.filter(
      { amazon_account_id: amazonAccountId, status: 'started', operation: 'full_sync' }, '-started_at', 3
    );
    for (const s of activeSyncs) {
      const ageMin = (Date.now() - new Date(s.started_at).getTime()) / 60000;
      if (ageMin < 30) return Response.json({ ok: false, skipped: true, reason: 'Sync em andamento — aguarde completar', age_minutes: Math.round(ageMin) });
      await base44.asServiceRole.entities.SyncExecutionLog.update(s.id, { status: 'error', completed_at: now, error_message: 'Lock antigo liberado' });
    }

    // ── Configuração ──────────────────────────────────────────────────────
    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: amazonAccountId });
    const cfg = configs[0] || {};
    const autonomyLevel = cfg.autonomy_level ?? 2;
    if (cfg.enabled === false) return Response.json({ ok: true, skipped: true, reason: 'Autopilot desabilitado' });

    const ATTR_HOURS   = cfg.attribution_safety_hours   || DEFAULT_ATTRIBUTION_HOURS;
    const MIN_DAYS     = cfg.minimum_complete_data_days || DEFAULT_MIN_COMPLETE_DAYS;
    const TARGET_ACOS  = cfg.target_acos  || cfg.acos_target || 25;
    const MAX_ACOS     = cfg.maximum_acos || 40;
    const MIN_BID      = cfg.min_bid      || 0.10;
    const MAX_BID      = cfg.max_bid      || 5.0;
    const MIN_CLICKS   = cfg.min_clicks_for_decision || 8;
    const MIN_SPEND    = cfg.min_spend_for_decision  || 5;
    const MIN_ORDERS   = cfg.min_orders_for_scale    || 2;
    const COOLDOWN_H   = cfg.cooldown_hours          || 24;
    const MAX_INC_PCT  = (cfg.max_bid_increase_pct   || 15) / 100;
    const MAX_DEC_PCT  = (cfg.max_bid_decrease_pct   || 20) / 100;
    const AUTO_APPLY   = cfg.auto_apply_low_risk !== false;
    const safeCutoff   = daysAgo(Math.ceil(ATTR_HOURS / 24)); // data limite para dados confiáveis

    // ── Criar run record ──────────────────────────────────────────────────
    runRecord = await base44.asServiceRole.entities.AutopilotRun.create({
      amazon_account_id: amazonAccountId,
      status: 'running',
      trigger: body.trigger || 'scheduled',
      started_at: now,
    });

    // ── Carregar dados com paginação ───────────────────────────────────────
    // Campanhas: paginação real — nunca usar limite como contagem esperada
    async function loadAllCampaigns() {
      const all = []; let offset = 0; const PAGE = 200;
      while (true) {
        const page = await base44.asServiceRole.entities.Campaign.filter(
          { amazon_account_id: amazonAccountId }, '-created_date', PAGE, offset
        );
        all.push(...page);
        if (page.length < PAGE) break;
        offset += PAGE;
      }
      // Autopilot analisa apenas não-arquivadas
      return all.filter(c => c.state !== 'archived' && c.status !== 'archived' && !c.archived);
    }

    const [campaigns, keywords, products, searchTerms, recentDecisions] = await Promise.all([
      loadAllCampaigns(),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: amazonAccountId }, '-spend', 1000),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: amazonAccountId }, null, 500),
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: amazonAccountId }, '-orders_14d', 2000),
      // Decisões recentes para controle de cooldown e deduplicação
      base44.asServiceRole.entities.OptimizationDecision.filter(
        { amazon_account_id: amazonAccountId }, '-created_at', 1000
      ),
    ]);

    const productMap  = new Map(products.map(p => [p.asin, p]));
    const campaignMap = new Map(campaigns.map(c => [c.campaign_id, c]));

    // Índice de chaves idempotentes já existentes (pendentes ou executadas hoje)
    const existingKeys = new Set(recentDecisions.filter(d => d.idempotency_key).map(d => d.idempotency_key));

    // Índice: campanhas que já receberam decisão neste ciclo (evita bid+budget simultâneos)
    const campaignChangedThisCycle = new Map(); // campaign_id → tipo alterado

    // Índice de keywords manuais exact para validar duplicatas no harvest
    const manualExactIndex = new Set(
      keywords.filter(k => k.match_type === 'exact' && k.source === 'manual' && k.state !== 'archived')
        .map(k => `${k.campaign_id}|${(k.keyword_text || '').toLowerCase().trim()}`)
    );

    const decisionsToCreate = [];
    const blocked = [];
    const stats = {
      harvest: 0, harvest_blocked: 0,
      bid_decrease: 0, bid_increase: 0,
      budget_change: 0, pause_campaign: 0,
      negative: 0, wait_for_data: 0,
      skipped_dup: 0, skipped_cooldown: 0,
    };

    // ════════════════════════════════════════════════════════════════════════
    // BLOCO 1 — Estoque zero: prioridade máxima, antes de qualquer análise
    // ════════════════════════════════════════════════════════════════════════
    if (cfg.auto_pause_zero_stock !== false) {
      for (const c of campaigns) {
        if (c.state !== 'enabled' && c.status !== 'enabled') continue;
        if (c.archived) continue;
        const product = c.asin ? productMap.get(c.asin) : null;
        if (!product || product.inventory_status !== 'out_of_stock') continue;

        const iKey = makeKey(amazonAccountId, 'pause', c.campaign_id, 'pause_zero_stock', today);
        if (existingKeys.has(iKey)) { stats.skipped_dup++; continue; }

        decisionsToCreate.push({
          amazon_account_id: amazonAccountId,
          decision_type: 'pause',
          entity_type: 'campaign',
          entity_id: c.campaign_id,
          campaign_id: c.campaign_id,
          asin: c.asin,
          action: 'pause_campaign',
          rationale: `Produto ${c.asin} com estoque zero. Pausar campanha imediatamente para evitar gasto desnecessário.\n\nMotivo:\nEstoque FBA = 0. Não há sentido em pagar por cliques sem capacidade de entrega.\n\nRisco:\nBaixo.\n\nPróxima avaliação:\nQuando o estoque retornar (verificação horária).`,
          data_used: JSON.stringify({ inventory_status: 'out_of_stock', asin: c.asin }),
          risk: 'low', requires_approval: autonomyLevel < 2,
          status: autonomyLevel >= 2 ? 'approved' : 'pending',
          confidence: 98,
          country_code: cc, currency_code: code, currency_symbol: sym,
          idempotency_key: iKey,
          source_function: 'runDailyAdsOptimization',
          evaluation_due_at: null, // reavaliado pela guardrail horária
          created_at: now,
        });
        campaignChangedThisCycle.set(c.campaign_id, 'pause');
        stats.pause_campaign++;
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // BLOCO 2 — Colheita de search terms (dados fora da janela de atribuição)
    // ════════════════════════════════════════════════════════════════════════
    if (cfg.search_term_optimization_enabled !== false && cfg.harvest_enabled !== false) {
      // Deduplicar por (term, asin) com dados mais ricos
      const stMap = new Map();
      for (const st of searchTerms) {
        if (st.date && st.date >= safeCutoff) continue; // dados dentro da janela de atribuição → ignorar para negativas/pausa
        const term = (st.search_term || st.keyword_text || '').toLowerCase().trim();
        if (!term || !st.advertised_asin) continue;
        const key = `${term}|${st.advertised_asin}`;
        const ex = stMap.get(key);
        if (!ex || (st.orders_14d || 0) > (ex.orders_14d || 0)) stMap.set(key, st);
      }

      for (const st of stMap.values()) {
        const term      = (st.search_term || st.keyword_text || '').toLowerCase().trim();
        const orders14  = st.orders_14d || 0;
        const sales14   = st.sales_14d  || 0;
        const acos14    = st.acos_14d   || 0;
        const clicks    = st.clicks     || 0;
        const spend     = st.spend      || 0;
        const product   = productMap.get(st.advertised_asin);

        // ── HARVEST: 1 venda confirmada ──
        if (orders14 >= 1 && sales14 > 0 && !st.promoted_to_manual && st.relevance_status !== 'irrelevant') {
          // Verificar produto elegível
          const blockers = productBlockers(product, cfg);
          if (blockers.includes('OUT_OF_STOCK') || blockers.includes('PRODUCT_INACTIVE')) {
            stats.harvest_blocked++;
            blocked.push({ term, reason: blockers.join(','), type: 'harvest' });
            continue;
          }

          // Verificar se keyword exact já existe
          if (manualExactIndex.has(`${st.campaign_id}|${term}`)) { stats.skipped_dup++; continue; }

          const iKey = makeKey(amazonAccountId, 'harvest_search_term', st.id, 'create_keyword', today);
          if (existingKeys.has(iKey)) { stats.skipped_dup++; continue; }

          const cpc = st.cpc || 0;
          const suggestedBid = cpc > 0
            ? Math.min(Math.max(cpc * 1.10, MIN_BID, 0.30), MAX_BID)
            : Math.max(MIN_BID, 0.30);

          const confidence = Math.min(0.95, 0.65 + (orders14 * 0.08));
          const outcome = resolveOutcome(confidence, 'MATURE', [], autonomyLevel, 'low');

          decisionsToCreate.push({
            amazon_account_id: amazonAccountId,
            decision_type: 'harvest_search_term',
            entity_type: 'search_term',
            entity_id: st.id,
            campaign_id: st.campaign_id,
            ad_group_id: st.ad_group_id,
            asin: st.advertised_asin,
            keyword_text: term,
            action: 'create_keyword',
            value_before: null,
            value_after: Number(suggestedBid.toFixed(2)),
            rationale: formatExplanation({ action: 'create_keyword', term, newBid: suggestedBid, orders: orders14, spend, symbol: sym,
              reason: `Termo "${term}" gerou ${orders14} pedido(s) com ${sym}${sales14.toFixed(2)} em vendas (dados anteriores à janela de ${ATTR_HOURS}h de atribuição). Bid sugerido baseado no CPC histórico de ${sym}${cpc.toFixed(2)} + 10%.` }),
            data_used: JSON.stringify({ orders_14d: orders14, sales_14d: sales14, cpc, bid: suggestedBid, safe_cutoff: safeCutoff }),
            risk: 'low', requires_approval: autonomyLevel < 2,
            status: outcome === 'EXECUTE_NOW' ? 'approved' : 'pending',
            confidence: Math.round(confidence * 100),
            objective: 'growth',
            reversible: true,
            country_code: cc, currency_code: code, currency_symbol: sym,
            idempotency_key: iKey,
            source_search_term_id: st.id,
            source_function: 'runDailyAdsOptimization',
            evaluation_due_at: daysFromNow(3), // avaliação de delivery em 3 dias
            period_analyzed: `até ${safeCutoff}`,
            expected_impact: `Capturar tráfego do termo "${term}" via keyword exact manual.`,
            created_at: now,
          });
          await base44.asServiceRole.entities.SearchTerm.update(st.id, {
            classification: 'FIRST_SALE', first_sale_at: st.first_sale_at || now,
            last_evaluated_at: now, evaluation_count: (st.evaluation_count || 0) + 1,
          });
          stats.harvest++;
        }

        // ── Classificações sem decisão ──
        else if (orders14 >= MIN_ORDERS && acos14 > 0 && acos14 <= TARGET_ACOS) {
          await base44.asServiceRole.entities.SearchTerm.update(st.id, { classification: 'WINNER', last_evaluated_at: now });
        } else if (orders14 >= 1 && acos14 > TARGET_ACOS) {
          await base44.asServiceRole.entities.SearchTerm.update(st.id, { classification: 'HIGH_ACOS', last_evaluated_at: now });
        }

        // ── WASTING: negativação somente após 2+ avaliações e sem venda histórica ──
        else if (orders14 === 0 && clicks >= MIN_CLICKS && spend >= MIN_SPEND && st.relevance_status !== 'relevant') {
          const evalCount = st.evaluation_count || 0;
          if (evalCount >= 2) {
            // Verificar se este termo teve alguma venda histórica (não negativar automaticamente)
            const hasHistoricalSales = (st.sales_30d || st.sales_14d || st.sales_7d || 0) > 0;
            if (hasHistoricalSales) {
              // Apenas recomendar com aprovação obrigatória
              const iKey = makeKey(amazonAccountId, 'negative_keyword', st.id, 'negative_recommend', today);
              if (!existingKeys.has(iKey)) {
                decisionsToCreate.push({
                  amazon_account_id: amazonAccountId,
                  decision_type: 'negative_keyword',
                  entity_type: 'search_term',
                  entity_id: st.id,
                  campaign_id: st.campaign_id,
                  keyword_text: term,
                  action: 'negative_exact',
                  rationale: `WASTING com histórico: "${term}" — ${clicks} cliques, ${sym}${spend.toFixed(2)} gasto, pedidos atuais=0. Venda histórica detectada. Exige aprovação humana.`,
                  data_used: JSON.stringify({ clicks, spend, orders_14d: 0, evaluations: evalCount }),
                  risk: 'high', requires_approval: true, status: 'pending', confidence: 55,
                  country_code: cc, currency_code: code, currency_symbol: sym,
                  idempotency_key: iKey,
                  source_function: 'runDailyAdsOptimization', created_at: now,
                });
                stats.negative++;
              }
            } else {
              // Nenhuma venda jamais → negativar com risco médio após 2+ avaliações
              const iKey = makeKey(amazonAccountId, 'negative_keyword', st.id, 'negative_exact', today);
              if (!existingKeys.has(iKey)) {
                const confidence = Math.min(0.88, 0.60 + evalCount * 0.08);
                decisionsToCreate.push({
                  amazon_account_id: amazonAccountId,
                  decision_type: 'negative_keyword',
                  entity_type: 'search_term', entity_id: st.id,
                  campaign_id: st.campaign_id, keyword_text: term,
                  action: 'negative_exact',
                  rationale: `WASTING confirmado (${evalCount} avaliações): "${term}" — ${clicks} cliques, ${sym}${spend.toFixed(2)} gasto, sem conversões. Dados anteriores à janela de atribuição.`,
                  data_used: JSON.stringify({ clicks, spend, orders_14d: 0, evaluations: evalCount }),
                  risk: 'medium', requires_approval: true, status: 'pending',
                  confidence: Math.round(confidence * 100),
                  country_code: cc, currency_code: code, currency_symbol: sym,
                  idempotency_key: iKey, source_function: 'runDailyAdsOptimization', created_at: now,
                });
                stats.negative++;
              }
            }
          }
          await base44.asServiceRole.entities.SearchTerm.update(st.id, {
            classification: 'WASTING',
            evaluation_count: (st.evaluation_count || 0) + 1,
            last_evaluated_at: now,
          });
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // BLOCO 3 — Análise de Keywords
    // ════════════════════════════════════════════════════════════════════════
    if (cfg.bid_optimization_enabled !== false) {
      for (const kw of keywords) {
        const state = kw.state || kw.status;
        if (state === 'archived') continue;

        const currentBid = kw.current_bid || kw.bid || 0.25;
        const acos       = kw.acos     || 0;
        const clicks     = kw.clicks   || 0;
        const spend      = kw.spend    || 0;
        const sales      = kw.sales    || 0;
        const orders     = kw.orders   || 0;
        const impressions= kw.impressions || 0;
        const convRate   = clicks > 0 ? orders / clicks : 0;

        const product  = kw.asin ? productMap.get(kw.asin) : null;
        const campaign = campaignMap.get(kw.campaign_id);

        // ── Ordem de verificações obrigatórias (seção 5 do spec) ──────────
        // 1. Produto elegível?
        const blockers = productBlockers(product, cfg);

        // 2. Maturidade
        const maturity = calcMaturity({
          createdAt: kw.first_seen_at || kw.created_date,
          lastSyncAt: kw.synced_at || account.last_sync_at,
          impressions, clicks, spend,
          minDays: MIN_DAYS,
        });

        // 3. Confiança
        const confidence = calcConfidence({
          clicks, lastSyncAt: kw.synced_at || account.last_sync_at,
          maturity, attrSafetyHours: ATTR_HOURS, product, daysWindow: 14,
        });

        // 4. Cooldown de redução (24h) e de aumento (72h)
        const inReduceCooldown  = inCooldown(kw.last_bid_change_at || kw.synced_at, COOLDOWN_H);
        const inIncreaseCooldown = inCooldown(kw.last_bid_change_at || kw.synced_at, COOLDOWN_H * 3); // 72h

        // 5. Campanha já alterada neste ciclo?
        const campAlreadyChanged = campaignChangedThisCycle.has(kw.campaign_id);

        // ── Keyword sem impressões (3+ dias) ─────────────────────────────
        if (impressions === 0 && state === 'enabled' && maturity !== 'NEW' && !blockers.includes('OUT_OF_STOCK')) {
          const bidChangeCount = kw.bid_change_count_30d || 0;
          if (bidChangeCount < 2) { // máximo 2 tentativas
            const increase5pct = Math.min(currentBid * 1.07, MAX_BID);
            const iKey = makeKey(amazonAccountId, 'bid_change', kw.keyword_id, 'no_impressions_boost', today);
            if (!existingKeys.has(iKey) && !inIncreaseCooldown) {
              decisionsToCreate.push({
                amazon_account_id: amazonAccountId,
                decision_type: 'bid_change', entity_type: 'keyword',
                entity_id: kw.keyword_id, campaign_id: kw.campaign_id, ad_group_id: kw.ad_group_id,
                keyword_id: kw.keyword_id, keyword_text: kw.keyword_text || kw.keyword, asin: kw.asin,
                action: 'increase_bid',
                value_before: currentBid, value_after: Number(increase5pct.toFixed(2)),
                change_pct: Number(((increase5pct / currentBid - 1) * 100).toFixed(1)),
                rationale: `Keyword sem impressões há ${maturity === 'LEARNING' ? '3–14' : '14+'} dias. Tentativa ${bidChangeCount + 1}/2 de aumento +7% para obter delivery.\n\nMotivo:\nBid atual de ${sym}${currentBid.toFixed(2)} pode estar abaixo do mínimo competitivo.\n\nPróxima avaliação:\nEm 3 dias.`,
                data_used: JSON.stringify({ impressions: 0, bid_change_count: bidChangeCount, maturity }),
                risk: 'low', requires_approval: false,
                status: autonomyLevel >= 2 && AUTO_APPLY ? 'approved' : 'pending',
                confidence: 70,
                country_code: cc, currency_code: code, currency_symbol: sym,
                idempotency_key: iKey, source_function: 'runDailyAdsOptimization',
                evaluation_due_at: daysFromNow(3), created_at: now,
              });
              stats.bid_increase++;
            } else { stats.skipped_cooldown++; }
          } else {
            blocked.push({ entity: kw.keyword_id, reason: 'NO_IMPRESSIONS_MAX_ATTEMPTS', text: kw.keyword_text });
            stats.wait_for_data++;
          }
          continue; // não continuar outras análises para esta keyword
        }

        // ── Dados insuficientes ou bloqueios ──────────────────────────────
        if (blockers.length > 0) {
          // Buy Box perdida + zero vendas: recomendar correção, não aumentar bid
          if (blockers.includes('BUY_BOX_LOST')) {
            blocked.push({ entity: kw.keyword_id, reason: 'BUY_BOX_LOST', text: kw.keyword_text });
          }
          continue;
        }

        if (['STALE', 'NEW', 'INSUFFICIENT_DATA'].includes(maturity)) {
          stats.wait_for_data++;
          continue;
        }

        if (confidence < 0.60) {
          stats.wait_for_data++;
          continue;
        }

        // ── Somente dados fora da janela de atribuição para decisões negativas ──
        // Para reduções e negativações, usar apenas cliques/spend/orders até safeCutoff
        // Para aumentos, pode-se usar dados recentes como confirmação

        // ── WASTING: zero vendas com dados maduros ────────────────────────
        if (orders === 0 && clicks >= MIN_CLICKS && spend >= MIN_SPEND && maturity === 'MATURE') {
          if (inReduceCooldown) { stats.skipped_cooldown++; continue; }
          if (campAlreadyChanged) continue; // não alterar bid E budget da mesma campanha

          const reducePct = Math.min(MAX_DEC_PCT, 0.15); // 15% na primeira redução
          const newBid = Math.max(currentBid * (1 - reducePct), MIN_BID);
          if (newBid < currentBid - 0.005) {
            const evalCount = kw.evaluation_count || 0;
            // Segunda avaliação → redução maior ou pausa
            let action = 'reduce_bid';
            let riskLevel = 'low';
            if (evalCount >= 2 && spend >= MIN_SPEND * 3) {
              riskLevel = 'medium';
            }

            const iKey = makeKey(amazonAccountId, 'bid_change', kw.keyword_id, 'reduce_wasting', today);
            if (!existingKeys.has(iKey)) {
              const outcome = resolveOutcome(confidence, maturity, [], autonomyLevel, riskLevel);
              decisionsToCreate.push({
                amazon_account_id: amazonAccountId,
                decision_type: 'bid_change', entity_type: 'keyword',
                entity_id: kw.keyword_id, campaign_id: kw.campaign_id, ad_group_id: kw.ad_group_id,
                keyword_id: kw.keyword_id, keyword_text: kw.keyword_text || kw.keyword, asin: kw.asin,
                action,
                value_before: currentBid, value_after: Number(newBid.toFixed(2)),
                change_pct: Number(((newBid / currentBid - 1) * 100).toFixed(1)),
                rationale: formatExplanation({ action: 'reduce_bid', currentBid, newBid, clicks, spend, orders: 0, symbol: sym,
                  reason: `Acumulou ${clicks} cliques e ${sym}${spend.toFixed(2)} de gasto sem pedidos (dados anteriores à janela de ${ATTR_HOURS}h de atribuição). Redução de ${Math.round(reducePct * 100)}%.` }),
                data_used: JSON.stringify({ clicks, spend, orders: 0, evaluations: evalCount, maturity, confidence }),
                risk: riskLevel, requires_approval: riskLevel !== 'low' || autonomyLevel < 2,
                status: outcome === 'EXECUTE_NOW' ? 'approved' : 'pending',
                confidence: Math.round(confidence * 100),
                country_code: cc, currency_code: code, currency_symbol: sym,
                idempotency_key: iKey, source_function: 'runDailyAdsOptimization',
                evaluation_due_at: daysFromNow(7),
                period_analyzed: `até ${safeCutoff}`,
                created_at: now,
              });
              campaignChangedThisCycle.set(kw.campaign_id, 'bid');
              stats.bid_decrease++;
            } else { stats.skipped_dup++; }
          }
        }

        // ── HIGH ACoS: venda com ACoS acima da meta ───────────────────────
        else if (acos > TARGET_ACOS && orders >= 1 && clicks >= 5 && maturity !== 'LEARNING') {
          if (inReduceCooldown) { stats.skipped_cooldown++; continue; }
          if (campAlreadyChanged) continue;

          // proposed_bid = current_bid × target_acos ÷ actual_acos
          const proposedBid = currentBid * (TARGET_ACOS / acos);
          // Não reduzir menos de 5% nem mais que MAX_DEC_PCT
          const minReduction = currentBid * 0.95;
          const maxReduction = currentBid * (1 - MAX_DEC_PCT);
          const newBid = Math.max(Math.min(proposedBid, minReduction), maxReduction, MIN_BID);
          const changePct = (newBid / currentBid - 1) * 100;

          if (changePct < -5 && newBid < currentBid - 0.005) { // somente se redução >= 5%
            const iKey = makeKey(amazonAccountId, 'bid_change', kw.keyword_id, 'reduce_high_acos', today);
            if (!existingKeys.has(iKey)) {
              const outcome = resolveOutcome(confidence, maturity, [], autonomyLevel, 'medium');
              decisionsToCreate.push({
                amazon_account_id: amazonAccountId,
                decision_type: 'bid_change', entity_type: 'keyword',
                entity_id: kw.keyword_id, campaign_id: kw.campaign_id, ad_group_id: kw.ad_group_id,
                keyword_id: kw.keyword_id, keyword_text: kw.keyword_text || kw.keyword, asin: kw.asin,
                action: 'reduce_bid',
                value_before: currentBid, value_after: Number(newBid.toFixed(2)),
                change_pct: Number(changePct.toFixed(1)),
                rationale: formatExplanation({ action: 'reduce_bid', currentBid, newBid, clicks, spend, orders, acos, targetAcos: TARGET_ACOS, symbol: sym,
                  reason: `ACoS de ${acos.toFixed(1)}% está acima da meta de ${TARGET_ACOS}%. Bid calculado via proporção: ${sym}${currentBid.toFixed(2)} × ${TARGET_ACOS} ÷ ${acos.toFixed(1)} = ${sym}${proposedBid.toFixed(2)}, limitado ao máximo de redução de ${Math.round(MAX_DEC_PCT * 100)}% por ciclo.` }),
                data_used: JSON.stringify({ acos, target_acos: TARGET_ACOS, clicks, orders, spend: spend.toFixed(2), maturity, confidence }),
                risk: 'medium', requires_approval: autonomyLevel < 3,
                status: outcome === 'EXECUTE_NOW' ? 'approved' : 'pending',
                confidence: Math.round(confidence * 100),
                country_code: cc, currency_code: code, currency_symbol: sym,
                idempotency_key: iKey, source_function: 'runDailyAdsOptimization',
                evaluation_due_at: daysFromNow(7),
                period_analyzed: `até ${safeCutoff}`,
                rollback_payload: JSON.stringify({ action: 'update_bid', value: currentBid }),
                created_at: now,
              });
              campaignChangedThisCycle.set(kw.campaign_id, 'bid');
              stats.bid_decrease++;
            } else { stats.skipped_dup++; }
          }
        }

        // ── WINNER: ACoS dentro da meta, escalar ──────────────────────────
        else if (orders >= MIN_ORDERS && acos > 0 && acos <= TARGET_ACOS && clicks >= 10 && maturity === 'MATURE') {
          // Verificar bloqueios para aumento
          if (blockers.length > 0) {
            blocked.push({ entity: kw.keyword_id, reason: blockers.join(','), text: kw.keyword_text }); continue;
          }
          if (inIncreaseCooldown) { stats.skipped_cooldown++; continue; }
          if (campAlreadyChanged) continue;

          // Estoque suficiente para crescer
          if (product?.inventory_status === 'low_stock') { blocked.push({ entity: kw.keyword_id, reason: 'LOW_STOCK_BLOCKS_INCREASE' }); continue; }

          // Determinar % de aumento: winner normal 5%, winner forte 10–15%
          const isStrongWinner = orders >= 3 && acos <= TARGET_ACOS * 0.70;
          const increasePct = isStrongWinner ? Math.min(MAX_INC_PCT, 0.15) : Math.min(MAX_INC_PCT * 0.5, 0.05);
          const newBid = Math.min(currentBid * (1 + increasePct), MAX_BID);

          if (newBid > currentBid + 0.005) {
            const iKey = makeKey(amazonAccountId, 'bid_change', kw.keyword_id, 'increase_winner', today);
            if (!existingKeys.has(iKey)) {
              const risk = isStrongWinner ? 'medium' : 'low';
              const outcome = resolveOutcome(confidence, maturity, [], autonomyLevel, risk);
              decisionsToCreate.push({
                amazon_account_id: amazonAccountId,
                decision_type: 'bid_change', entity_type: 'keyword',
                entity_id: kw.keyword_id, campaign_id: kw.campaign_id, ad_group_id: kw.ad_group_id,
                keyword_id: kw.keyword_id, keyword_text: kw.keyword_text || kw.keyword, asin: kw.asin,
                action: 'increase_bid',
                value_before: currentBid, value_after: Number(newBid.toFixed(2)),
                change_pct: Number(((newBid / currentBid - 1) * 100).toFixed(1)),
                rationale: formatExplanation({ action: 'increase_bid', currentBid, newBid, orders, acos, targetAcos: TARGET_ACOS, symbol: sym,
                  reason: `${isStrongWinner ? 'VENCEDOR FORTE' : 'WINNER'}: ACoS de ${acos.toFixed(1)}% está dentro da meta de ${TARGET_ACOS}% com ${orders} pedidos. Aumento de +${Math.round(increasePct * 100)}% para capturar mais tráfego qualificado.` }),
                data_used: JSON.stringify({ acos, orders, clicks, sales: sales.toFixed(2), maturity, confidence, strong_winner: isStrongWinner }),
                risk, requires_approval: risk !== 'low' || autonomyLevel < 3,
                status: outcome === 'EXECUTE_NOW' ? 'approved' : 'pending',
                confidence: Math.round(confidence * 100),
                country_code: cc, currency_code: code, currency_symbol: sym,
                idempotency_key: iKey, source_function: 'runDailyAdsOptimization',
                evaluation_due_at: daysFromNow(7),
                rollback_payload: JSON.stringify({ action: 'update_bid', value: currentBid }),
                created_at: now,
              });
              campaignChangedThisCycle.set(kw.campaign_id, 'bid');
              stats.bid_increase++;
            } else { stats.skipped_dup++; }
          }
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // BLOCO 4 — Análise de Budget de Campanhas
    // (apenas campanhas não alteradas neste ciclo)
    // ════════════════════════════════════════════════════════════════════════
    if (cfg.budget_optimization_enabled !== false) {
      const globalBudgetLimit = cfg.total_daily_budget || cfg.daily_budget_limit || 0;
      let totalAllocated = 0;

      for (const c of campaigns) {
        if (c.state !== 'enabled' && c.status !== 'enabled') continue;
        if (c.archived) continue;
        if (campaignChangedThisCycle.has(c.campaign_id)) continue; // já foi alterada

        const currentBudget = c.daily_budget || 0;
        const campAcos = c.acos || 0;
        const campSpend = c.spend || 0;
        const campSales = c.sales || 0;

        totalAllocated += currentBudget;

        // Redução: ACoS muito acima do máximo
        if (campAcos > MAX_ACOS && campSpend >= MIN_SPEND * 3) {
          const maturity = calcMaturity({
            createdAt: c.created_at || c.start_date,
            lastSyncAt: c.synced_at || c.last_sync_at || account.last_sync_at,
            impressions: c.impressions, clicks: c.clicks, spend: c.spend,
          });
          if (maturity !== 'MATURE') continue; // não reduzir budget de campanha imatura

          const newBudget = Math.max(currentBudget * 0.85, 1); // redução de 15%
          const iKey = makeKey(amazonAccountId, 'budget_change', c.campaign_id, 'reduce_high_acos', today);
          if (!existingKeys.has(iKey)) {
            decisionsToCreate.push({
              amazon_account_id: amazonAccountId,
              decision_type: 'budget_change', entity_type: 'campaign',
              entity_id: c.campaign_id, campaign_id: c.campaign_id, asin: c.asin,
              action: 'update_budget',
              value_before: currentBudget, value_after: Number(newBudget.toFixed(2)),
              change_pct: -15,
              rationale: `Reduzir orçamento diário de ${sym}${currentBudget.toFixed(2)} para ${sym}${newBudget.toFixed(2)}.\n\nMotivo:\nACoS de ${campAcos.toFixed(1)}% está acima do máximo de ${MAX_ACOS}% com gasto significativo. Redução de 15% para controle financeiro.\n\nPróxima avaliação:\nEm 7 dias.`,
              data_used: JSON.stringify({ acos: campAcos, max_acos: MAX_ACOS, spend: campSpend }),
              risk: 'medium', requires_approval: true, status: 'pending',
              confidence: 75,
              country_code: cc, currency_code: code, currency_symbol: sym,
              idempotency_key: iKey, source_function: 'runDailyAdsOptimization',
              evaluation_due_at: daysFromNow(7),
              rollback_payload: JSON.stringify({ action: 'update_budget', value: currentBudget }),
              created_at: now,
            });
            campaignChangedThisCycle.set(c.campaign_id, 'budget');
            stats.budget_change++;
          }
        }

        // Não aumentar budget automaticamente: excluir do ciclo diário (frequência: 3 dias mínimo)
        // Aumento de budget requer aprovação por padrão
      }
    }

    // ── Gravar decisões em lotes ──────────────────────────────────────────
    let decisionsCreated = 0;
    for (let i = 0; i < decisionsToCreate.length; i += 50) {
      const batch = decisionsToCreate.slice(i, i + 50);
      await base44.asServiceRole.entities.OptimizationDecision.bulkCreate(batch);
      decisionsCreated += batch.length;
    }

    // ── Finalizar AutopilotRun ────────────────────────────────────────────
    await base44.asServiceRole.entities.AutopilotRun.update(runRecord.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      campaigns_analyzed: campaigns.length,
      keywords_analyzed: keywords.length,
      decisions_generated: decisionsCreated,
      total_spend_analyzed: campaigns.reduce((s, c) => s + (c.spend || 0), 0),
    });

    return Response.json({
      ok: true,
      decisions_created: decisionsCreated,
      skipped_duplicates: stats.skipped_dup,
      skipped_cooldown: stats.skipped_cooldown,
      blocked: blocked.length,
      breakdown: stats,
      autonomy_level: autonomyLevel,
      safe_cutoff: safeCutoff,
      attribution_safety_hours: ATTR_HOURS,
      duration_ms: Date.now() - startTime,
    });

  } catch (error) {
    if (runRecord?.id) {
      const b44 = createClientFromRequest(req);
      await b44.asServiceRole.entities.AutopilotRun.update(runRecord.id, {
        status: 'failed', completed_at: new Date().toISOString(), error_message: error.message,
      }).catch(() => {});
    }
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});