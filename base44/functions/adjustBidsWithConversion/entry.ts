/**
 * adjustBidsWithConversion v3 — Motor determinístico de otimização de lances
 *
 * Pipeline de 12 passos (executados em ordem):
 *  1. VALIDAR DADOS — apenas keywords com dados frescos e confiáveis
 *  2. BLOQUEAR — estoque zero, listing bloqueado, dados stale, reconciliation pending
 *  3. IDENTIFICAR ZERO-SALE WASTE — gasto sem conversão relevante
 *  4. REDUZIR PRIMEIRO — targets com maior Spend/Target CPA (pior retorno primeiro)
 *  5. PROTEGER WINNERS — ACoS <= 12% nunca recebem redução
 *  6. REATIVAR WINNERS PAUSADOS — somente se elegíveis
 *  7. AUMENTAR BUDGET — winners limitados por orçamento (via campanha)
 *  8. AUMENTAR BID — winners sem limitação de budget e CPC < sustentável
 *  9. NÃO ESCALAR — targets com ACoS > 15% bloqueados de aumento
 * 10. RECALCULAR PROJECTED ACOS — após cada decisão
 * 11. PARAR — assim que projeção <= 15%
 * 12. COOLDOWN — registrar e bloquear por 48h
 *
 * Estratégia sempre Down Only (nunca altera bidding_strategy da campanha).
 * Cooldown: 48h por keyword_id.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── Constantes ─────────────────────────────────────────────────────────────
const MIN_BID           = 0.25;
const MAX_BID_DEFAULT   = 2.50;
const MAX_DECREASE_PCT  = 0.20;   // -20% cap por ciclo
const MAX_INCREASE_PCT  = 0.08;   // +8% cap por ciclo
const COOLDOWN_HOURS    = 48;
const WINNER_ACOS_MAX   = 12;     // ACoS <= 12% = winner protegido
const TARGET_ACOS_MAX   = 15;     // ACoS > 15% = não escalar
const WASTE_SPEND_MIN   = 10;     // R$10 gasto mínimo para ser waste
const WASTE_CLICKS_MIN  = 5;      // 5 cliques mínimos para ser waste
const PROJECTED_ACOS_TARGET = 15; // parar reduções quando projeção <= 15%

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function r2(v: number) { return parseFloat(v.toFixed(2)); }

// ── Tipos ──────────────────────────────────────────────────────────────────
interface KwDecision {
  kw: any;
  action: 'decrease' | 'increase' | 'reactivate' | 'budget_increase' | 'hold' | 'block';
  newBid?: number;
  reason: string;
  priority: number;       // menor = mais urgente (para ordenar reduções)
  spendPerTargetCpa?: number;
  projectedAcos?: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function sustainableCpc(aov: number, cvr: number, targetAcos: number): number {
  // CPC máximo sustentável = AOV × CVR × target_acos
  return aov * cvr * (targetAcos / 100);
}

function projectedAcosAfterBidChange(
  spend: number, sales: number, clicks: number,
  oldBid: number, newBid: number
): number {
  if (sales <= 0 || clicks <= 0 || oldBid <= 0) return 999;
  // Ajusta spend proporcional à variação de bid, mantendo CVR
  const bidRatio     = newBid / oldBid;
  const newSpend     = spend * bidRatio;
  const projectedAcos = (newSpend / sales) * 100;
  return projectedAcos;
}

// ── Pipeline principal ─────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body   = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false } = body;

    // ── Resolver conta ──────────────────────────────────────────────────────
    let account: any;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
      account = accs[0];
      if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({}, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: true, skipped: true, reason: 'Nenhuma conta configurada' });

    const accountId = account.id;
    const now       = new Date().toISOString();
    const cutoff48h = new Date(Date.now() - COOLDOWN_HOURS * 3600 * 1000).toISOString();
    const stale7d   = new Date(Date.now() - 7 * 86400 * 1000).toISOString();

    // ── PerformanceSettings ─────────────────────────────────────────────────
    const perfList = await base44.asServiceRole.entities.PerformanceSettings.filter(
      { amazon_account_id: accountId }, null, 1
    ).catch(() => []);
    const perf       = perfList[0] || {};
    const targetAcos = Number(perf.target_acos || 15);
    const maxBid     = Number(perf.max_bid || MAX_BID_DEFAULT);

    // ── PASSO 12 — Cooldown: IDs em cooldown ───────────────────────────────
    const recentLogs = await base44.asServiceRole.entities.AdsBidChangeLog.filter(
      { amazon_account_id: accountId }, '-created_date', 2000
    ).catch(() => []);
    const onCooldown = new Set<string>(
      recentLogs
        .filter((l: any) => (l.created_at || l.created_date || '') > cutoff48h && l.source === 'adjustBidsWithConversion')
        .map((l: any) => String(l.keyword_id))
    );

    // ── Dados de suporte: produtos e campanhas ──────────────────────────────
    const [allProducts, allCampaigns] = await Promise.all([
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, null, 1000).catch(() => []),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, null, 1000).catch(() => []),
    ]);

    // Map produto por ASIN
    const productMap = new Map<string, any>();
    for (const p of allProducts) { if (p.asin) productMap.set(p.asin, p); }

    // Map campanha por campaign_id
    const campaignMap = new Map<string, any>();
    for (const c of allCampaigns) {
      if (c.campaign_id) campaignMap.set(c.campaign_id, c);
      if (c.amazon_campaign_id) campaignMap.set(c.amazon_campaign_id, c);
    }

    // ── Buscar todas as keywords ────────────────────────────────────────────
    const allKeywords = await base44.asServiceRole.entities.Keyword.filter(
      { amazon_account_id: accountId }, '-spend', 2000
    ).catch(() => []);

    // ───────────────────────────────────────────────────────────────────────
    // PASSO 1 — VALIDAR DADOS
    // Apenas keywords com bid > 0 e dados mínimos (ou sem dados = pode ajustar)
    // ───────────────────────────────────────────────────────────────────────
    const validated = allKeywords.filter((kw: any) => {
      const bid   = Number(kw.current_bid || kw.bid || 0);
      const state = (kw.state || kw.status || '').toLowerCase();
      if (bid <= 0) return false;
      if (state === 'archived') return false;
      return true;
    });

    // ───────────────────────────────────────────────────────────────────────
    // PASSO 2 — BLOQUEAR keywords de produtos inelegíveis
    // ───────────────────────────────────────────────────────────────────────
    const decisions: KwDecision[] = [];
    const blocked: any[] = [];

    for (const kw of validated) {
      const kwId     = String(kw.keyword_id || kw.id);
      const kwState  = (kw.state || kw.status || '').toLowerCase();
      const product  = kw.asin ? productMap.get(kw.asin) : null;
      const campaign = kw.campaign_id ? campaignMap.get(kw.campaign_id) : null;

      // Bloquear: estoque zero
      if (product && Number(product.fba_inventory || 0) === 0 && product.inventory_status !== 'in_stock') {
        blocked.push({ kwId, reason: 'estoque_zero', asin: kw.asin });
        continue;
      }

      // Bloquear: listing bloqueado/suprimido
      if (product && (product.listing_suppressed === true || product.listing_buyable === false || product.offer_active === false)) {
        blocked.push({ kwId, reason: 'listing_bloqueado', asin: kw.asin });
        continue;
      }

      // Bloquear: dados stale (last_seen_at > 7 dias)
      const lastSeen = kw.last_seen_at || kw.synced_at || '';
      if (lastSeen && lastSeen < stale7d) {
        blocked.push({ kwId, reason: 'dados_stale', keyword_text: kw.keyword_text });
        continue;
      }

      // Bloquear: campanha em reconciliation
      if (campaign && campaign.reconciliation_status === 'review_required') {
        blocked.push({ kwId, reason: 'reconciliation_pending', campaign_id: kw.campaign_id });
        continue;
      }

      // Cooldown ativo
      if (onCooldown.has(kwId)) {
        blocked.push({ kwId, reason: 'cooldown', keyword_text: kw.keyword_text });
        continue;
      }

      // Keyword pausada externamente (não é block, mas não ajustamos)
      if (kwState === 'paused') {
        // Checar se é winner para reativação (PASSO 6)
        const acos = Number(kw.acos || 0);
        if (acos > 0 && acos <= WINNER_ACOS_MAX && Number(kw.orders || 0) >= 1) {
          decisions.push({
            kw, action: 'reactivate',
            reason: `Winner pausado (ACoS ${acos.toFixed(1)}% ≤ ${WINNER_ACOS_MAX}%) — elegível para reativação`,
            priority: 50,
          });
        }
        continue;
      }

      // Acumular para classificação
      const spend   = Number(kw.spend  || 0);
      const sales   = Number(kw.sales  || 0);
      const clicks  = Number(kw.clicks || 0);
      const orders  = Number(kw.orders || 0);
      const acos    = Number(kw.acos   || 0);
      const bid     = Number(kw.current_bid || kw.bid || 0);

      // ──────────────────────────────────────────────────────────────────
      // PASSO 3 — IDENTIFICAR ZERO-SALE WASTE
      // ──────────────────────────────────────────────────────────────────
      const isWaste = orders === 0 && spend >= WASTE_SPEND_MIN && clicks >= WASTE_CLICKS_MIN;

      // ──────────────────────────────────────────────────────────────────
      // PASSO 5 — PROTEGER WINNERS (ACoS <= 12%)
      // ──────────────────────────────────────────────────────────────────
      const isWinner = acos > 0 && acos <= WINNER_ACOS_MAX && orders >= 1;

      // ──────────────────────────────────────────────────────────────────
      // PASSO 9 — NÃO ESCALAR targets acima de 15%
      // ──────────────────────────────────────────────────────────────────
      const isOverTarget = acos > TARGET_ACOS_MAX;

      // Calcular Spend/TargetCPA (para priorizar reduções — PASSO 4)
      const targetCpa   = sales > 0 && orders > 0 ? (sales / orders) * (targetAcos / 100) : 0;
      const spendPerTCpa = targetCpa > 0 ? spend / targetCpa : 0;

      // ──────────────────────────────────────────────────────────────────
      // PASSO 4 — REDUZIR PRIMEIRO (waste + ACoS alto)
      // ──────────────────────────────────────────────────────────────────
      if (!isWinner) {
        if (isWaste) {
          const newBid = r2(Math.max(MIN_BID, bid * (1 - 0.15)));
          if (newBid < bid - 0.01) {
            decisions.push({
              kw, action: 'decrease', newBid,
              reason: `Zero-sale waste: ${clicks} cliques, R$${spend.toFixed(2)} gasto, 0 pedidos → -15%`,
              priority: 10 + (spendPerTCpa > 0 ? Math.min(spendPerTCpa, 10) : 0), // pior waste = maior prioridade
              spendPerTargetCpa: spendPerTCpa,
            });
            continue;
          }
        }

        if (isOverTarget && acos > 0 && orders > 0) {
          // Redução proporcional à fórmula econômica
          const rawFactor = targetAcos / acos;
          const factor    = Math.max(1 - MAX_DECREASE_PCT, rawFactor);
          const newBid    = r2(Math.max(MIN_BID, bid * factor));
          if (newBid < bid - 0.01) {
            const projAcos = projectedAcosAfterBidChange(spend, sales, clicks, bid, newBid);
            decisions.push({
              kw, action: 'decrease', newBid,
              reason: `ACoS ${acos.toFixed(1)}% > meta ${targetAcos.toFixed(1)}% → bid × ${factor.toFixed(2)}`,
              priority: 20 + (spendPerTCpa > 0 ? Math.min(spendPerTCpa, 10) : 0),
              spendPerTargetCpa: spendPerTCpa,
              projectedAcos: projAcos,
            });
            continue;
          }
        }
      }

      // ──────────────────────────────────────────────────────────────────
      // PASSO 7 — AUMENTAR BUDGET (winner limitado por budget)
      // ──────────────────────────────────────────────────────────────────
      if (isWinner && campaign) {
        const budgetConsumed = Number(campaign.current_spend || campaign.spend || 0);
        const dailyBudget   = Number(campaign.daily_budget || 0);
        const budgetRatio   = dailyBudget > 0 ? budgetConsumed / dailyBudget : 0;
        const budgetLimited = budgetRatio >= 0.90; // >= 90% consumido = limitado

        if (budgetLimited) {
          // Registra como budget_increase (ação de campanha, não de keyword)
          decisions.push({
            kw, action: 'budget_increase',
            reason: `Winner (ACoS ${acos.toFixed(1)}%) limitado por budget (${(budgetRatio*100).toFixed(0)}% consumido) — aumentar orçamento da campanha`,
            priority: 60,
          });
          continue;
        }
      }

      // ──────────────────────────────────────────────────────────────────
      // PASSO 8 — AUMENTAR BID (winner sem limitação de budget)
      // ──────────────────────────────────────────────────────────────────
      if (isWinner && clicks >= 10 && bid < maxBid) {
        const aov  = orders > 0 ? sales / orders : 0;
        const cvr  = clicks > 0 ? orders / clicks : 0;
        const maxSustainableCpc = sustainableCpc(aov, cvr, targetAcos);
        const currentCpc        = clicks > 0 ? spend / clicks : 0;

        if (maxSustainableCpc > 0 && currentCpc < maxSustainableCpc * 0.85) {
          const headroom = (targetAcos - acos) / targetAcos;
          const boostPct = Math.min(MAX_INCREASE_PCT, Math.max(0.03, headroom * MAX_INCREASE_PCT));
          const newBid   = r2(Math.min(maxBid, bid * (1 + boostPct)));
          if (newBid > bid + 0.01) {
            decisions.push({
              kw, action: 'increase', newBid,
              reason: `Winner (ACoS ${acos.toFixed(1)}%), CPC R$${currentCpc.toFixed(2)} < sustentável R$${maxSustainableCpc.toFixed(2)} → +${(boostPct*100).toFixed(0)}%`,
              priority: 80,
            });
            continue;
          }
        }
      }

      // Sem decisão — hold
    }

    // ── PASSO 4 — Ordenar reduções por Spend/TargetCPA (pior retorno primeiro) ──
    decisions.sort((a, b) => a.priority - b.priority);

    // ── PASSOS 10 & 11 — Projeção acumulada e parada antecipada ────────────
    // Calcular ACoS atual total (base para projeção)
    let totalSpendBase  = 0;
    let totalSalesBase  = 0;
    for (const kw of validated) {
      totalSpendBase += Number(kw.spend  || 0);
      totalSalesBase += Number(kw.sales  || 0);
    }
    const currentProjectedAcos = totalSalesBase > 0
      ? (totalSpendBase / totalSalesBase) * 100
      : 999;

    // Simular impacto acumulado das reduções
    let runningSpend = totalSpendBase;
    const stoppedAt: string | null = null;
    const decisionsToExecute: KwDecision[] = [];

    for (const d of decisions) {
      if (d.action === 'decrease') {
        const kw      = d.kw;
        const bid     = Number(kw.current_bid || kw.bid || 0);
        const newBid  = d.newBid!;
        const clicks  = Number(kw.clicks || 0);
        if (bid > 0 && clicks > 0) {
          const spendDelta = (kw.spend || 0) * (newBid / bid - 1);
          runningSpend += spendDelta;
        }
        const projAcos = totalSalesBase > 0 ? (runningSpend / totalSalesBase) * 100 : 999;
        d.projectedAcos = projAcos;

        // PASSO 11 — parar se projeção já atingiu a meta
        if (projAcos <= PROJECTED_ACOS_TARGET) {
          decisionsToExecute.push(d); // inclui esta última
          break;
        }
      }
      decisionsToExecute.push(d);
    }

    // ── Executar / dry-run ──────────────────────────────────────────────────
    const results: any[] = [];
    let increased   = 0;
    let decreased   = 0;
    let reactivated = 0;
    let budgetMarked = 0;
    let errors      = 0;

    for (const d of decisionsToExecute) {
      const kw     = d.kw;
      const kwId   = String(kw.keyword_id || kw.id);
      const curBid = Number(kw.current_bid || kw.bid || 0);

      const resultBase = {
        keyword_id: kwId,
        keyword_text: kw.keyword_text,
        campaign_id: kw.campaign_id,
        asin: kw.asin,
        action: d.action,
        current_bid: curBid,
        new_bid: d.newBid,
        acos: kw.acos,
        spend: kw.spend,
        orders: kw.orders,
        clicks: kw.clicks,
        projected_acos: d.projectedAcos,
        spend_per_target_cpa: d.spendPerTargetCpa,
        reason: d.reason,
      };

      if (dry_run) {
        results.push(resultBase);
        if (d.action === 'increase') increased++;
        else if (d.action === 'decrease') decreased++;
        else if (d.action === 'reactivate') reactivated++;
        else if (d.action === 'budget_increase') budgetMarked++;
        continue;
      }

      // ── Reativação de winner pausado ─────────────────────────────────────
      if (d.action === 'reactivate') {
        const enableRes = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
          _service_role: true,
          amazon_account_id: accountId,
          path: '/sp/keywords',
          method: 'PUT',
          content_type: 'application/vnd.spKeyword.v3+json',
          payload: { keywords: [{ keywordId: kwId, state: 'ENABLED' }] },
        }).catch(e => ({ ok: false, error: e.message }));

        const ok = enableRes?.ok === true || enableRes?.status === 207;
        if (ok) {
          await base44.asServiceRole.entities.Keyword.update(kw.id, { state: 'enabled', status: 'enabled' }).catch(() => {});
          reactivated++;
          results.push({ ...resultBase, status: 'reactivated' });
        } else {
          errors++;
          results.push({ ...resultBase, status: 'error', error: JSON.stringify(enableRes).slice(0, 200) });
        }
        await sleep(150);
        continue;
      }

      // ── Budget increase — não mexe no bid, registra apenas ───────────────
      if (d.action === 'budget_increase') {
        budgetMarked++;
        results.push({ ...resultBase, status: 'budget_action_needed' });
        // Logar como alerta para acompanhamento
        await base44.asServiceRole.entities.AdsBidChangeLog.create({
          amazon_account_id: accountId,
          campaign_id: kw.campaign_id,
          keyword_id: kwId,
          keyword_text: kw.keyword_text,
          action: 'budget_increase_flagged',
          reason: d.reason,
          source: 'adjustBidsWithConversion',
          created_at: now,
        }).catch(() => {});
        continue;
      }

      // ── Ajuste de bid (increase / decrease) ──────────────────────────────
      const newBid = d.newBid!;
      const putRes = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        _service_role: true,
        amazon_account_id: accountId,
        path: '/sp/keywords',
        method: 'PUT',
        content_type: 'application/vnd.spKeyword.v3+json',
        payload: { keywords: [{ keywordId: kwId, bid: newBid }] },
      }).catch(e => ({ ok: false, error: e.message }));

      const apiOk = putRes?.ok === true || putRes?.status === 207;

      if (!apiOk) {
        errors++;
        results.push({ ...resultBase, status: 'error_amazon', error: JSON.stringify(putRes).slice(0, 200) });
        continue;
      }

      // Atualizar localmente
      await base44.asServiceRole.entities.Keyword.update(kw.id, {
        current_bid: newBid,
        bid: newBid,
        last_seen_at: now,
      }).catch(() => {});

      // PASSO 12 — Registrar no log de cooldown
      await base44.asServiceRole.entities.AdsBidChangeLog.create({
        amazon_account_id: accountId,
        campaign_id: kw.campaign_id,
        keyword_id: kwId,
        asin: kw.asin,
        keyword_text: kw.keyword_text,
        match_type: kw.match_type,
        bid_before: curBid,
        bid_after: newBid,
        change_pct: curBid > 0 ? (newBid - curBid) / curBid * 100 : 0,
        action: d.action,
        acos_at_change: kw.acos || 0,
        target_acos_at_change: targetAcos,
        orders_at_change: kw.orders || 0,
        clicks_at_change: kw.clicks || 0,
        spend_at_change: kw.spend || 0,
        reason: d.reason,
        confidence: 80,
        source: 'adjustBidsWithConversion',
        bidding_strategy: 'down_only',
        projected_acos_after: d.projectedAcos,
        created_at: now,
      }).catch(() => {});

      if (d.action === 'increase') increased++;
      else decreased++;

      results.push({ ...resultBase, status: 'applied' });
      await sleep(150);
    }

    // ── Sumário ─────────────────────────────────────────────────────────────
    const finalProjectedAcos = totalSalesBase > 0
      ? (runningSpend / totalSalesBase) * 100
      : null;

    return Response.json({
      ok: true,
      dry_run,
      pipeline: '12-step-v3',
      target_acos: targetAcos,
      max_bid: maxBid,
      // Contadores de pipeline
      total_keywords_fetched: allKeywords.length,
      step1_validated: validated.length,
      step2_blocked: blocked.length,
      step4_decisions: decisionsToExecute.length,
      // Resultados
      keywords_increased: increased,
      keywords_decreased: decreased,
      keywords_reactivated: reactivated,
      keywords_budget_flagged: budgetMarked,
      keywords_on_cooldown: onCooldown.size,
      errors,
      // ACoS projetado
      current_projected_acos: currentProjectedAcos > 900 ? null : r2(currentProjectedAcos),
      final_projected_acos: finalProjectedAcos && finalProjectedAcos < 900 ? r2(finalProjectedAcos) : null,
      projected_target_reached: finalProjectedAcos !== null && finalProjectedAcos <= PROJECTED_ACOS_TARGET,
      // Detalhe
      blocked_keywords: blocked,
      results,
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});