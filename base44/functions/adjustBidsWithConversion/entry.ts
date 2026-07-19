/**
 * Amazon Ads Goal Orchestrator v2 — PROFIT-SAFE
 * ─────────────────────────────────────────────────────────────────────────
 * Motor determinístico com proteção absoluta de rentabilidade.
 *
 * Regras fundamentais (PRD Profit-Safe):
 *  - MAX +20% por ciclo em qualquer aumento (bid, budget)
 *  - Hierarquia: TARGET_ACOS → SUSTAINABLE_ACOS → BREAK_EVEN_ACOS
 *  - WINNER_PROFIT_PROTECTION: bloquear reduções que reduzam lucro
 *  - ABOVE_TARGET_BUT_PROFITABLE: não cortar sem verificar lucro esperado
 *  - Waste removal (zero vendas) sempre permitido
 *  - Budget increase somente em winners com ACoS <= sustainable e budget limitado
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── Constantes ───────────────────────────────────────────────────────────
const PIPELINE_VERSION   = 'goal-orchestrator-v2-profit-safe';
const RULE_VERSION       = '2.0';
const MIN_BID            = 0.25;
const MAX_INCREASE_PCT   = 0.20;   // PROFIT-SAFE hard cap +20% por ciclo
const MAX_DECREASE_PCT   = 0.20;
const BUDGET_INCREASE_PCT= 0.20;   // PROFIT-SAFE hard cap +20% por ciclo
const THROTTLE_MS        = 200;
const MAX_KW_BATCH       = 10;
const MAX_KEYWORDS       = 500;
const STALE_DAYS         = 7;
const COOLDOWN_BID_H     = 48;
const COOLDOWN_BUDGET_H  = 24;
const WASTE_SOFT_FACTOR  = 1.0;
const WASTE_HARD_FACTOR  = 1.5;
const ECONOMIC_SAFETY_FACTOR = 0.80; // sustainable_acos = break_even × 0.80

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function r2(v: number)     { return parseFloat(v.toFixed(2)); }
function hoursLater(h: number): string { return new Date(Date.now() + h*3600*1000).toISOString(); }

// ── PROFIT-SAFE GUARDRAIL (inline) ────────────────────────────────────────

function buildEconomicCtx(p: {
  current_acos: number; target_acos: number; break_even_acos: number;
  spend: number; sales: number; orders: number; clicks: number;
  aov: number; cvr: number; contribution_margin: number;
}) {
  const sustainable_acos = r2(p.break_even_acos * ECONOMIC_SAFETY_FACTOR);
  const acos_headroom    = r2(sustainable_acos - p.current_acos);
  const current_profit   = r2(p.sales * p.contribution_margin - p.spend);
  const sustainable_cpc  = (p.aov > 0 && p.cvr > 0 && p.target_acos > 0)
    ? r2(p.aov * p.cvr * (p.target_acos / 100)) : 0;

  let acos_status: string;
  if (p.current_acos <= 0)                                  acos_status = 'NO_DATA';
  else if (p.current_acos <= p.target_acos)                 acos_status = 'HEALTHY';
  else if (p.current_acos <= sustainable_acos)              acos_status = 'ABOVE_TARGET_BUT_PROFITABLE';
  else if (p.current_acos < p.break_even_acos)              acos_status = 'ECONOMIC_WARNING';
  else                                                       acos_status = 'CRITICAL_ECONOMIC';

  const is_winner = (
    p.current_acos > 0 &&
    p.current_acos <= sustainable_acos &&
    p.orders >= 1 &&
    current_profit > 0
  );
  const can_scale = is_winner && acos_headroom > 0 && p.clicks >= 10 && p.cvr > 0;

  return { sustainable_acos, acos_headroom, current_profit, sustainable_cpc,
           acos_status, is_winner, can_scale };
}

// Retorna bid seguro para aumento, ou null se bloqueado
function profitSafeBidUp(currentBid: number, rawBid: number, maxBid: number, ctx: any): {
  allowed: boolean; final_bid: number; change_pct: number; cap_applied: boolean; block_reason?: string;
} {
  if (!ctx.can_scale) return { allowed: false, final_bid: currentBid, change_pct: 0, cap_applied: false,
    block_reason: ctx.acos_status === 'CRITICAL_ECONOMIC' ? 'CRITICAL_ECONOMIC_NO_SCALE' : 'NOT_WINNER_OR_NO_HEADROOM' };

  // ACoS esperado após aumento — deve ficar dentro do sustentável
  const ratio = currentBid > 0 ? rawBid / currentBid : 1;
  const expected_acos_after = r2(ctx.sustainable_acos > 0 ? ctx.acos_status === 'HEALTHY'
    ? (rawBid / currentBid) * (ctx.sustainable_acos * 0.5) // estimativa conservadora
    : ctx.sustainable_acos * ratio : 999);

  // Hard cap +20% por ciclo
  const maxByCycle   = r2(currentBid * (1 + MAX_INCREASE_PCT));
  const cap_applied  = rawBid > maxByCycle;
  let   capped       = Math.min(rawBid, maxByCycle);

  // Economic cap: não ultrapassar sustainable_cpc
  if (ctx.sustainable_cpc > 0 && capped > ctx.sustainable_cpc) capped = ctx.sustainable_cpc;

  const final_bid  = r2(Math.min(maxBid, capped));
  if (final_bid <= currentBid + 0.01) return { allowed: false, final_bid: currentBid, change_pct: 0,
    cap_applied, block_reason: 'NO_MEANINGFUL_INCREASE' };

  return { allowed: true, final_bid, change_pct: r2(((final_bid - currentBid) / currentBid) * 100), cap_applied };
}

// Retorna bid seguro para redução, respeitando proteção de winners
function profitSafeBidDown(currentBid: number, proposedBid: number, minBid: number, ctx: any, isWaste: boolean): {
  allowed: boolean; final_bid: number; change_pct: number; block_reason?: string;
} {
  // Waste removal (zero vendas) — sempre permitido
  if (isWaste) {
    const final_bid = r2(Math.max(minBid, proposedBid));
    return { allowed: true, final_bid, change_pct: r2(((final_bid - currentBid) / currentBid) * 100) };
  }

  // WINNER PROFIT PROTECTION — bloquear se redução reduz lucro
  if (ctx.is_winner && ctx.acos_status !== 'CRITICAL_ECONOMIC' && ctx.current_profit > 0) {
    const ratio = currentBid > 0 ? proposedBid / currentBid : 1;
    const expected_profit_delta = r2(ctx.current_profit * ratio - ctx.current_profit);
    if (expected_profit_delta < 0) {
      return { allowed: false, final_bid: currentBid, change_pct: 0,
        block_reason: `WINNER_PROFIT_PROTECTION (lucro estimado: -R$${Math.abs(expected_profit_delta).toFixed(2)})` };
    }
  }

  // ABOVE_TARGET_BUT_PROFITABLE — bloquear redução que prejudica lucro
  if (ctx.acos_status === 'ABOVE_TARGET_BUT_PROFITABLE' && ctx.current_profit > 0) {
    const ratio = currentBid > 0 ? proposedBid / currentBid : 1;
    const expected_profit_delta = r2(ctx.current_profit * ratio - ctx.current_profit);
    if (expected_profit_delta < 0) {
      return { allowed: false, final_bid: currentBid, change_pct: 0,
        block_reason: `ABOVE_TARGET_BUT_PROFITABLE — redução reduziria lucro em R$${Math.abs(expected_profit_delta).toFixed(2)}` };
    }
  }

  const final_bid = r2(Math.max(minBid, proposedBid));
  return { allowed: true, final_bid, change_pct: r2(((final_bid - currentBid) / currentBid) * 100) };
}

// ── Helpers ───────────────────────────────────────────────────────────────
function sustainableCpc(aov: number, cvr: number, targetAcos: number): number {
  return aov * cvr * (targetAcos / 100);
}
function actionScore(impact: number, conf: number, risk: number, rev: number): number {
  return (impact * conf) / (risk * Math.max(rev, 1));
}

// ── Goal Resolution ───────────────────────────────────────────────────────
function resolveGoal(perf: any, avgBreakEven: number) {
  return {
    target_acos:        Number(perf?.target_acos        || 15),
    max_acos:           Number(perf?.max_acos            || Math.min(avgBreakEven * 0.9, 25)),
    target_roas:        Number(perf?.target_roas         || 4),
    target_tacos:       Number(perf?.target_tacos        || 5),
    max_cpc:            Number(perf?.max_cpc             || 2.5),
    min_bid:            Number(perf?.min_bid             || MIN_BID),
    max_bid:            Number(perf?.max_bid             || 2.5),
    daily_budget_limit: Number(perf?.daily_budget_limit  || 80),
    top_of_search_limit:Number(perf?.top_of_search_limit || 50),
  };
}

function classifyBand(acos: number, targetAcos: number): string {
  if (acos <= 12)              return 'EXCELLENT';
  if (acos <= targetAcos)      return 'HEALTHY';
  if (acos <= targetAcos + 1)  return 'TOLERANCE';
  if (acos <= 20)              return 'WARNING';
  return 'CRITICAL';
}
function bandToMode(band: string): string {
  if (band === 'EXCELLENT')    return 'SCALE';
  if (band === 'HEALTHY' || band === 'TOLERANCE') return 'MAINTAIN';
  return 'CUT';
}

function tierCampaign(c: any, targetAcos: number, breakEvenAcos: number) {
  const spend   = Number(c.spend  || c.current_spend || 0);
  const sales   = Number(c.sales  || 0);
  const orders  = Number(c.orders || 0);
  const clicks  = Number(c.clicks || 0);
  const daily   = Number(c.daily_budget || 0);
  const acos    = sales > 0 ? (spend / sales) * 100 : (spend > 0 ? 999 : 0);
  const budRatio= daily > 0 ? spend / daily : 0;

  let tier = 'D';
  if (acos > 0 && acos <= targetAcos * ECONOMIC_SAFETY_FACTOR && orders >= 1) tier = 'A'; // winner econômico
  else if (acos > 0 && acos <= targetAcos) tier = 'B';
  else if (acos > targetAcos && acos <= 25) tier = 'C';

  const aov = orders > 0 ? sales / orders : 0;
  const cvr = clicks > 0 ? orders / clicks : 0;
  const maxCpc = sustainableCpc(aov, cvr, targetAcos);
  const curCpc = clicks > 0 ? spend / clicks : 0;

  let rootCause = 'UNKNOWN';
  if (spend === 0 || clicks === 0)                   rootCause = 'VISIBILITY_PROBLEM';
  else if (curCpc > maxCpc && maxCpc > 0)            rootCause = 'CPC_PROBLEM';
  else if (curCpc <= maxCpc && acos > targetAcos && orders > 0) rootCause = 'CVR_PROBLEM';
  else if (budRatio >= 0.90 && tier === 'A')         rootCause = 'BUDGET_PROBLEM';
  else if (orders === 0 && clicks >= 5)              rootCause = 'TRAFFIC_QUALITY';
  else if (clicks < 10)                              rootCause = 'VISIBILITY_PROBLEM';

  return {
    acos, spend, sales, orders, clicks, budRatio, breakEvenAcos,
    tier, rootCause,
    wasteCapacity: tier === 'D' ? spend : 0,
    scaleCapacity: tier === 'A' && budRatio >= 0.85 ? daily * 0.2 : 0,
    sustainableCpcVal: maxCpc,
  };
}

function selectStrategy(profiles: any[], metrics: any, mode: string, targetAcos: number): string {
  if (mode === 'SCALE')    return 'SCALE_WINNERS';
  if (mode === 'MAINTAIN') return 'MAINTAIN';
  const totalWaste = profiles.reduce((s: number, p: any) => s + (p.wasteCapacity || 0), 0);
  const spendGap   = metrics.total_spend - metrics.max_spend_at_current_sales;
  const hasTierD   = profiles.some((p: any) => p.tier === 'D' && p.spend > 5);
  const hasTierA   = profiles.some((p: any) => p.tier === 'A' && p.budRatio >= 0.9);
  if (totalWaste >= spendGap * 0.8) return 'CUT_FIRST';
  if (hasTierD && hasTierA)         return 'REBALANCE';
  if (totalWaste > 0)               return 'HYBRID';
  return 'CUT_FIRST';
}

function detectConflict(goal: any, metrics: any): { conflict: boolean; detail?: string } {
  const impliedAcos = 100 / goal.target_roas;
  if (Math.abs(impliedAcos - goal.target_acos) > 5) {
    return { conflict: true, detail: `target_roas ${goal.target_roas}x implica ACoS ${impliedAcos.toFixed(1)}% mas target_acos=${goal.target_acos}%` };
  }
  return { conflict: false };
}

function shouldBlock(
  kw: any,
  productMap: Map<string, any>,
  campaignMap: Map<string, any>,
  stale7d: string,
  cooldownBidIds: Set<string>,
): { blocked: boolean; reason: string; isEmergency?: boolean } {
  const kwId = String(kw.keyword_id || kw.id);
  const prod  = kw.asin ? productMap.get(kw.asin) : null;
  const camp  = kw.campaign_id ? campaignMap.get(kw.campaign_id) : null;

  if (prod && Number(prod.fba_inventory || 0) === 0 && prod.inventory_status !== 'in_stock') {
    return { blocked: true, reason: 'estoque_zero', isEmergency: true };
  }
  if (prod && (prod.listing_suppressed === true || prod.listing_buyable === false || prod.offer_active === false)) {
    return { blocked: true, reason: 'listing_bloqueado', isEmergency: true };
  }
  const lastSeen = kw.last_seen_at || kw.synced_at || '';
  if (lastSeen && lastSeen < stale7d) {
    return { blocked: true, reason: 'dados_stale' };
  }
  if (camp?.reconciliation_status === 'review_required') {
    return { blocked: true, reason: 'reconciliation_pending' };
  }
  if (cooldownBidIds.has(kwId)) {
    return { blocked: true, reason: 'cooldown_48h' };
  }
  return { blocked: false, reason: '' };
}

// ─────────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body   = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false, mode_override } = body;

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
    const stale7d   = new Date(Date.now() - STALE_DAYS * 86400 * 1000).toISOString();
    const cutoff48h = new Date(Date.now() - COOLDOWN_BID_H  * 3600 * 1000).toISOString();
    const cutoff24h = new Date(Date.now() - COOLDOWN_BUDGET_H * 3600 * 1000).toISOString();

    // ── 0. KILL SWITCH GUARD ────────────────────────────────────────────
    const todayBRT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).toISOString().slice(0, 10);
    const ksControllers = await base44.asServiceRole.entities.AccountDailySpendController.filter(
      { amazon_account_id: accountId, spend_date: todayBRT }, null, 1
    ).catch(() => []);
    const ksController = ksControllers[0];
    if (ksController?.global_kill_switch === true) {
      return Response.json({ ok: true, skipped: true,
        reason: 'Kill Switch ativo — nenhum bid ou budget alterado',
        kill_switch_activated_at: ksController.kill_switch_activated_at,
        duration_ms: Date.now() - t0 });
    }

    // ── 0b. GOAL_ALIGNMENT_GUARD ────────────────────────────────────────
    let goalAlignmentStatus = 'UNCHECKED';
    let goalTensionActive   = false;
    let safeModeActive      = false;
    let recencyProtectionActive = false;
    try {
      const perfListGA = await base44.asServiceRole.entities.PerformanceSettings.filter(
        { amazon_account_id: accountId }, null, 1
      ).catch(() => []);
      const perfGA = perfListGA[0] || {};
      const targetAcosGA = Number(perfGA.target_acos || 15);
      const aiAutoOptimization = perfGA.ai_auto_optimization === true;

      const snaps = await base44.asServiceRole.entities.PerformanceTrendSnapshot.filter(
        { amazon_account_id: accountId }, '-snapshot_date', 1
      ).catch(() => []);
      const snap = snaps[0];
      const account14dAcos = snap?.acos_14d || 0;

      if (account14dAcos > 0 && targetAcosGA > 0) {
        if (targetAcosGA < 8 && account14dAcos > 20 && !aiAutoOptimization) {
          goalAlignmentStatus = 'MISCONFIGURED'; safeModeActive = true;
        } else if (targetAcosGA < account14dAcos * 0.70 && account14dAcos <= 16) {
          goalAlignmentStatus = 'GOAL_TENSION'; goalTensionActive = true;
        } else {
          goalAlignmentStatus = 'ALIGNED';
        }
      }
      if (snap?.recency_protection_active) recencyProtectionActive = true;

      if (ksControllers[0]) {
        await base44.asServiceRole.entities.AccountDailySpendController.update(ksControllers[0].id, {
          goal_alignment_status: goalAlignmentStatus,
          goal_alignment_checked_at: now,
          recency_protection_active: recencyProtectionActive,
          acos_14d_at_last_check: account14dAcos,
          trend_classification: snap?.trend_classification || 'INSUFFICIENT_DATA',
        }).catch(() => {});
      }

      if (safeModeActive) {
        return Response.json({ ok: true, skipped: true,
          reason: 'SAFE_MODE ativo — target_acos misconfigured. Ajuste PerformanceSettings.target_acos.',
          goal_alignment_status: goalAlignmentStatus, duration_ms: Date.now() - t0 });
      }
    } catch { /* guardrail não bloqueia */ }

    // ── 1. GOAL RESOLUTION ──────────────────────────────────────────────
    const [perfList, economicsList] = await Promise.all([
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, null, 1).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: accountId }, null, 500).catch(() => []),
    ]);
    const perf = perfList[0] || {};
    const avgBreakEven = economicsList.length > 0
      ? economicsList.reduce((s: number, e: any) => s + Number(e.break_even_acos || 30), 0) / economicsList.length
      : 30;
    const goal = resolveGoal(perf, avgBreakEven);

    const breakEvenMap = new Map<string, number>();
    const marginMap    = new Map<string, number>();
    for (const e of economicsList) {
      if (e.asin) {
        breakEvenMap.set(e.asin, Number(e.break_even_acos || 30));
        // contribution_margin antes de ads (em fração)
        const margin = Number(e.contribution_margin || e.profit_margin_pct || 0);
        marginMap.set(e.asin, margin > 1 ? margin / 100 : margin); // aceita % ou fração
      }
    }

    // ── Cooldown ────────────────────────────────────────────────────────
    const [recentBidLogs, recentBudgetLogs] = await Promise.all([
      base44.asServiceRole.entities.AdsBidChangeLog.filter({ amazon_account_id: accountId }, '-created_date', 2000).catch(() => []),
      base44.asServiceRole.entities.CampaignChangeHistory.filter({ amazon_account_id: accountId }, '-created_date', 500).catch(() => []),
    ]);
    const cooldownBidIds = new Set<string>(
      recentBidLogs
        .filter((l: any) => (l.created_at || l.created_date || '') > cutoff48h && l.source === 'adjustBidsWithConversion')
        .map((l: any) => String(l.keyword_id))
    );
    const cooldownBudgetIds = new Set<string>(
      recentBudgetLogs
        .filter((l: any) => (l.created_at || l.created_date || '') > cutoff24h && l.source === 'adjustBidsWithConversion')
        .map((l: any) => String(l.campaign_id))
    );

    // ── Carregar dados ──────────────────────────────────────────────────
    const [allCampaigns, allProducts, allKeywords] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, null, 1000).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, null, 1000).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-spend', MAX_KEYWORDS).catch(() => []),
    ]);

    const productMap  = new Map<string, any>();
    const campaignMap = new Map<string, any>();
    for (const p of allProducts) { if (p.asin) productMap.set(p.asin, p); }
    for (const c of allCampaigns) {
      if (c.campaign_id)        campaignMap.set(c.campaign_id, c);
      if (c.amazon_campaign_id) campaignMap.set(c.amazon_campaign_id, c);
    }

    const activeCampaigns = allCampaigns.filter((c: any) => {
      const s = (c.state || c.status || '').toLowerCase();
      return s !== 'archived' && c.archived !== true;
    });

    // ── 2. ACCOUNT METRICS ──────────────────────────────────────────────
    let totalSpend = 0, totalSales = 0, totalOrders = 0, totalClicks = 0;
    for (const c of activeCampaigns) {
      totalSpend  += Number(c.spend  || c.current_spend || 0);
      totalSales  += Number(c.sales  || 0);
      totalOrders += Number(c.orders || 0);
      totalClicks += Number(c.clicks || 0);
    }
    const accountAcos = totalSales > 0 ? (totalSpend / totalSales) * 100 : 0;
    const metrics = {
      total_spend: totalSpend, total_sales: totalSales, total_orders: totalOrders,
      account_acos: accountAcos,
      gap: accountAcos - goal.target_acos,
      max_spend_at_current_sales: totalSales * (goal.target_acos / 100),
      required_sales_at_current_spend: goal.target_acos > 0 ? totalSpend / (goal.target_acos / 100) : 0,
    };

    const band        = classifyBand(accountAcos, goal.target_acos);
    const accountMode = mode_override || bandToMode(band);

    // ── 3. CAMPAIGN TIERING ─────────────────────────────────────────────
    const campaignProfiles: any[] = activeCampaigns.map((c: any) => {
      const breakEven = c.asin ? (breakEvenMap.get(c.asin) || avgBreakEven) : avgBreakEven;
      return { ...tierCampaign(c, goal.target_acos, breakEven), campaign: c };
    });
    const profileByCampId = new Map<string, any>();
    for (const p of campaignProfiles) {
      if (p.campaign?.campaign_id)       profileByCampId.set(p.campaign.campaign_id, p);
      if (p.campaign?.amazon_campaign_id) profileByCampId.set(p.campaign.amazon_campaign_id, p);
    }

    const strategy     = selectStrategy(campaignProfiles, metrics, accountMode, goal.target_acos);
    const conflictCheck = detectConflict(goal, metrics);

    // ── 5 & 6. KEYWORD DECISIONS ────────────────────────────────────────
    const blocked: any[] = [];
    const bidDecreaseDecisions: any[] = [];
    const bidIncreaseDecisions: any[] = [];
    const reactivateDecisions:  any[] = [];

    // Conta AOV médio para fallback
    const acctAovProxy = totalOrders > 0 ? totalSales / totalOrders : 50;

    for (const kw of allKeywords) {
      const kwId    = String(kw.keyword_id || kw.id);
      const bid     = Number(kw.current_bid || kw.bid || 0);
      if (bid <= 0) continue;

      const kwState = (kw.state || kw.status || '').toLowerCase();
      if (kwState === 'archived') continue;

      const blockResult = shouldBlock(kw, productMap, campaignMap, stale7d, cooldownBidIds);
      if (blockResult.blocked) {
        blocked.push({ entity_id: kwId, entity_type: 'keyword', reason: blockResult.reason, detail: kw.keyword_text });
        continue;
      }

      const spend   = Number(kw.spend  || 0);
      const sales   = Number(kw.sales  || 0);
      const orders  = Number(kw.orders || 0);
      const clicks  = Number(kw.clicks || 0);
      const acos    = Number(kw.acos   || 0);
      const profile = kw.campaign_id ? profileByCampId.get(kw.campaign_id) : null;
      const breakEven = kw.asin ? (breakEvenMap.get(kw.asin) || avgBreakEven) : avgBreakEven;

      // ── PROFIT-SAFE CONTEXT por keyword ────────────────────────────────
      const aov   = orders > 0 ? sales / orders : acctAovProxy;
      const cvr   = clicks > 0 ? orders / clicks : 0;
      const contribMargin = kw.asin && marginMap.has(kw.asin)
        ? marginMap.get(kw.asin)!
        : (breakEven / 100); // fallback: break_even como proxy de margem

      const econCtx = buildEconomicCtx({
        current_acos: acos, target_acos: goal.target_acos, break_even_acos: breakEven,
        spend, sales, orders, clicks, aov, cvr, contribution_margin: contribMargin,
      });
      // ───────────────────────────────────────────────────────────────────

      const isWinner = econCtx.is_winner;

      // ── Reativar winner pausado ─────────────────────────────────────────
      if (kwState === 'paused') {
        if (isWinner) {
          const prod = kw.asin ? productMap.get(kw.asin) : null;
          const hasStock = !prod || Number(prod.fba_inventory || 0) > 0;
          if (hasStock) {
            reactivateDecisions.push({
              goal: 'scale_winners', current_value: acos, target: goal.target_acos,
              sustainable_acos: econCtx.sustainable_acos, acos_status: econCtx.acos_status,
              gap: acos - goal.target_acos, root_cause: 'VISIBILITY_PROBLEM',
              strategy_macro: strategy, action: 'keyword_reactivate',
              entity_type: 'keyword', entity_id: kwId, entity_name: kw.keyword_text,
              asin: kw.asin, campaign_id: kw.campaign_id,
              current_config: { state: 'paused', acos, orders },
              proposed_config: { state: 'enabled' },
              expected_impact_pct: 15, confidence: 70, risk_level: 'low',
              action_score: actionScore(15, 70, 1, 0),
              rule_id: `ORCH-REACTIVATE-A-${RULE_VERSION}`,
              rule_version: RULE_VERSION,
              cooldown_until: hoursLater(COOLDOWN_BID_H),
              next_review_at: hoursLater(COOLDOWN_BID_H),
              reason: `Winner pausado (ACoS ${acos.toFixed(1)}%, sustentável ${econCtx.sustainable_acos}%) → reativar`,
              _kw: kw,
            });
          }
        }
        continue;
      }

      // ── PRIORIDADE 1: Zero-Sale Waste (sempre permitido) ───────────────
      // Ordem PRD §17: waste first, winners last
      if (orders === 0 && clicks >= 5 && spend > 0) {
        const tCpa = acctAovProxy * (goal.target_acos / 100);
        const soft = tCpa * WASTE_SOFT_FACTOR;
        const hard = tCpa * WASTE_HARD_FACTOR;

        if (spend >= soft) {
          const redPct = spend >= hard ? 0.20 : 0.15;
          const rawBid = bid * (1 - redPct);
          const downResult = profitSafeBidDown(bid, rawBid, goal.min_bid, econCtx, true /* isWaste */);
          if (downResult.allowed && downResult.final_bid < bid - 0.01) {
            const impact = Math.abs(downResult.change_pct);
            bidDecreaseDecisions.push({
              goal: 'reduce_waste', current_value: acos, target: goal.target_acos,
              sustainable_acos: econCtx.sustainable_acos, acos_status: econCtx.acos_status,
              gap: acos - goal.target_acos, root_cause: 'TRAFFIC_QUALITY',
              strategy_macro: strategy, action: 'bid_decrease',
              entity_type: 'keyword', entity_id: kwId, entity_name: kw.keyword_text,
              asin: kw.asin, campaign_id: kw.campaign_id,
              current_config: { bid, spend, clicks, orders },
              proposed_config: { bid: downResult.final_bid },
              expected_impact_pct: impact, confidence: 82, risk_level: 'low',
              action_score: actionScore(impact, 82, 1, 24),
              rule_id: `ORCH-WASTE-${spend >= hard ? 'HARD' : 'SOFT'}-${RULE_VERSION}`,
              rule_version: RULE_VERSION,
              cooldown_until: hoursLater(COOLDOWN_BID_H),
              next_review_at: hoursLater(COOLDOWN_BID_H),
              reason: `Zero-sale waste: ${clicks} cliques, R$${spend.toFixed(2)}, 0 pedidos → ${downResult.change_pct.toFixed(0)}%`,
              _kw: kw,
            });
            continue;
          }
        }
      }

      // ── PRIORIDADE 2: Reduzir ACoS alto com PROFIT-SAFE CHECK ──────────
      // Só para não-winners com CPC_PROBLEM; CVR_PROBLEM = problema de listing, não de bid
      if (!isWinner && acos > goal.target_acos && orders > 0) {
        if (profile?.rootCause === 'CVR_PROBLEM') continue;

        const effectiveMaxDecrease = goalTensionActive ? 0.05 : MAX_DECREASE_PCT;
        const factor   = Math.max(1 - effectiveMaxDecrease, goal.target_acos / acos);
        const rawBid   = bid * factor;
        const downResult = profitSafeBidDown(bid, rawBid, goal.min_bid, econCtx, false);

        if (!downResult.allowed) {
          blocked.push({ entity_id: kwId, entity_type: 'keyword',
            reason: downResult.block_reason, detail: kw.keyword_text,
            acos, sustainable_acos: econCtx.sustainable_acos, acos_status: econCtx.acos_status });
          continue;
        }
        if (downResult.final_bid < bid - 0.01) {
          const impact = Math.abs(downResult.change_pct);
          const rsk = acos > breakEven * 0.9 ? 'high' : 'medium';
          bidDecreaseDecisions.push({
            goal: 'reduce_acos', current_value: acos, target: goal.target_acos,
            sustainable_acos: econCtx.sustainable_acos, break_even_acos: breakEven,
            acos_status: econCtx.acos_status,
            gap: acos - goal.target_acos, root_cause: 'CPC_PROBLEM',
            strategy_macro: strategy, action: 'bid_decrease',
            entity_type: 'keyword', entity_id: kwId, entity_name: kw.keyword_text,
            asin: kw.asin, campaign_id: kw.campaign_id,
            current_config: { bid, acos, spend, orders },
            proposed_config: { bid: downResult.final_bid },
            expected_impact_pct: impact, confidence: 85,
            risk_level: rsk,
            action_score: actionScore(impact, 85, rsk === 'high' ? 2 : 1.5, 48),
            rule_id: `ORCH-BID-DOWN-${profile?.tier || 'C'}-${RULE_VERSION}`,
            rule_version: RULE_VERSION,
            cooldown_until: hoursLater(COOLDOWN_BID_H),
            next_review_at: hoursLater(COOLDOWN_BID_H),
            reason: `ACoS ${acos.toFixed(1)}% > meta ${goal.target_acos}% (sustentável: ${econCtx.sustainable_acos}%) → ${downResult.change_pct.toFixed(0)}%`,
            _kw: kw,
          });
        }
        continue; // não escalar não-winner
      }

      // ── PRIORIDADE 3: Aumentar bid de winner com PROFIT-SAFE CHECK ──────
      if (accountMode === 'SCALE' || accountMode === 'MAINTAIN') {
        if (!isWinner) continue;
        if (clicks < 10 || orders < 1 || bid >= goal.max_bid) continue;
        if (profile?.rootCause === 'BUDGET_PROBLEM') continue; // budget primeiro

        const curCpc   = clicks > 0 ? spend / clicks : 0;
        const maxCpc   = econCtx.sustainable_cpc;
        if (maxCpc > 0 && curCpc >= maxCpc * 0.85) continue;

        // Raw bid baseado no headroom econômico (não mais em target_acos simples)
        const headroomFraction = Math.max(0, econCtx.acos_headroom) / 100;
        const rawBoost  = Math.max(0.03, Math.min(0.20, headroomFraction));
        const rawBid    = bid * (1 + rawBoost);

        const upResult = profitSafeBidUp(bid, rawBid, goal.max_bid, econCtx);
        if (!upResult.allowed) {
          blocked.push({ entity_id: kwId, entity_type: 'keyword',
            reason: upResult.block_reason, detail: kw.keyword_text,
            acos_status: econCtx.acos_status });
          continue;
        }

        bidIncreaseDecisions.push({
          goal: 'scale_winners', current_value: acos, target: goal.target_acos,
          sustainable_acos: econCtx.sustainable_acos, break_even_acos: breakEven,
          acos_status: econCtx.acos_status, acos_headroom: econCtx.acos_headroom,
          current_profit: econCtx.current_profit,
          gap: acos - goal.target_acos, root_cause: 'VISIBILITY_PROBLEM',
          strategy_macro: strategy, action: 'bid_increase',
          entity_type: 'keyword', entity_id: kwId, entity_name: kw.keyword_text,
          asin: kw.asin, campaign_id: kw.campaign_id,
          current_config: { bid, acos, cpc: r2(curCpc), sustainable_cpc: r2(maxCpc) },
          proposed_config: { bid: upResult.final_bid },
          expected_impact_pct: upResult.change_pct, confidence: 70, risk_level: 'low',
          cap_applied: upResult.cap_applied,
          action_score: actionScore(upResult.change_pct, 70, 1, 48),
          rule_id: `ORCH-BID-UP-A-${RULE_VERSION}`,
          rule_version: RULE_VERSION,
          cooldown_until: hoursLater(COOLDOWN_BID_H),
          next_review_at: hoursLater(COOLDOWN_BID_H),
          reason: `Winner ACoS ${acos.toFixed(1)}% / sustentável ${econCtx.sustainable_acos}%, headroom ${econCtx.acos_headroom.toFixed(1)}pts → +${upResult.change_pct.toFixed(0)}%${upResult.cap_applied ? ' [cap +20%]' : ''}`,
          _kw: kw,
        });
      }
    }

    // ── Budget increase para winners limitados ─────────────────────────
    const budgetIncreaseDecisions: any[] = [];
    for (const p of campaignProfiles) {
      const c   = p.campaign;
      const cId = String(c.campaign_id || c.id);
      if (cooldownBudgetIds.has(cId)) continue;
      if (p.tier !== 'A' || p.budRatio < 0.90) continue;
      const daily = Number(c.daily_budget || 0);
      if (daily <= 0) continue;

      // PROFIT-SAFE: budget só aumenta se winner com ACoS <= sustainable
      const campBreakEven = c.asin ? (breakEvenMap.get(c.asin) || avgBreakEven) : avgBreakEven;
      const campSustainable = r2(campBreakEven * ECONOMIC_SAFETY_FACTOR);
      if (p.acos > campSustainable) continue; // ECONOMIC_WARNING ou CRITICAL — não aumentar budget

      const rawBudget = daily * (1 + BUDGET_INCREASE_PCT);
      const newBudget = r2(Math.min(goal.daily_budget_limit, rawBudget));
      if (newBudget <= daily + 0.50) continue;

      budgetIncreaseDecisions.push({
        goal: 'scale_winners', current_value: p.acos, target: goal.target_acos,
        sustainable_acos: campSustainable, break_even_acos: campBreakEven,
        acos_status: p.acos <= goal.target_acos ? 'HEALTHY' : 'ABOVE_TARGET_BUT_PROFITABLE',
        gap: p.acos - goal.target_acos, root_cause: 'BUDGET_PROBLEM',
        strategy_macro: strategy, action: 'budget_increase',
        entity_type: 'campaign', entity_id: cId, entity_name: c.name || c.campaign_name,
        asin: c.asin, campaign_id: cId,
        current_config: { daily_budget: daily, budget_ratio: r2(p.budRatio) },
        proposed_config: { daily_budget: newBudget },
        expected_impact_pct: BUDGET_INCREASE_PCT * 100, confidence: 75, risk_level: 'low',
        cap_applied: rawBudget > newBudget,
        action_score: actionScore(20, 75, 1, 24),
        rule_id: `ORCH-BUDGET-UP-A-${RULE_VERSION}`,
        rule_version: RULE_VERSION,
        cooldown_until: hoursLater(COOLDOWN_BUDGET_H),
        next_review_at: hoursLater(COOLDOWN_BUDGET_H),
        reason: `Winner (ACoS ${p.acos.toFixed(1)}% / sustentável ${campSustainable}%) com ${(p.budRatio*100).toFixed(0)}% budget → +${(BUDGET_INCREASE_PCT*100).toFixed(0)}% [cap +20%]`,
        _camp: c,
      });
    }

    // ── Ranking & Stop Rule ─────────────────────────────────────────────
    bidDecreaseDecisions.sort((a: any, b: any) => b.action_score - a.action_score);

    let runningSpend = totalSpend;
    const toExecuteDecreases: any[] = [];
    for (const d of bidDecreaseDecisions) {
      if ((accountMode === 'MAINTAIN' || accountMode === 'SCALE') && d.root_cause === 'CPC_PROBLEM') continue;
      const kw     = d._kw;
      const oldBid = Number(kw?.current_bid || kw?.bid || 0);
      const newBid = Number(d.proposed_config?.bid || oldBid);
      const kwSpend= Number(kw?.spend || 0);
      if (oldBid > 0 && kwSpend > 0) runningSpend += kwSpend * (newBid / oldBid - 1);
      const projAcos = totalSales > 0 ? (runningSpend / totalSales) * 100 : 999;
      d.projected_acos_after = r2(projAcos);
      toExecuteDecreases.push(d);
      if (projAcos <= goal.target_acos) break;
    }

    // Pipeline: waste/bid_down → budget_up → reactivate → bid_up
    const orderedDecisions: any[] = [
      ...toExecuteDecreases,
      ...budgetIncreaseDecisions,
      ...reactivateDecisions,
      ...bidIncreaseDecisions,
    ];

    const finalProjAcos = totalSales > 0 ? (runningSpend / totalSales) * 100 : null;
    const actionsByLever: Record<string, number> = {};
    for (const d of orderedDecisions) {
      actionsByLever[d.action] = (actionsByLever[d.action] || 0) + 1;
    }

    // ─── DRY RUN ────────────────────────────────────────────────────────
    if (dry_run) {
      const cleanDecisions = orderedDecisions.map(({ _kw, _camp, ...rest }: any) => rest);
      return Response.json({
        ok: true, dry_run: true,
        pipeline_version: PIPELINE_VERSION,
        account_mode: accountMode, strategy_chosen: strategy,
        goal_conflict: conflictCheck.conflict, goal_conflict_detail: conflictCheck.detail,
        projected_acos_before: totalSales > 0 ? r2(accountAcos) : null,
        projected_acos_after: finalProjAcos ? r2(finalProjAcos) : null,
        target_reached: finalProjAcos !== null && finalProjAcos <= goal.target_acos,
        actions_by_lever: actionsByLever,
        target_acos: goal.target_acos, max_bid: goal.max_bid,
        avg_break_even_acos: r2(avgBreakEven),
        avg_sustainable_acos: r2(avgBreakEven * ECONOMIC_SAFETY_FACTOR),
        account_acos: r2(accountAcos), band,
        total_keywords_fetched: allKeywords.length,
        total_blocked: blocked.length,
        total_decisions: orderedDecisions.length,
        campaign_tiers: {
          A: campaignProfiles.filter((p: any) => p.tier === 'A').length,
          B: campaignProfiles.filter((p: any) => p.tier === 'B').length,
          C: campaignProfiles.filter((p: any) => p.tier === 'C').length,
          D: campaignProfiles.filter((p: any) => p.tier === 'D').length,
        },
        decisions: cleanDecisions,
        blocked: blocked.slice(0, 50),
        duration_ms: Date.now() - t0,
      });
    }

    // ─── EXECUÇÃO REAL ──────────────────────────────────────────────────
    let executedCount = 0;
    let errorsCount   = 0;
    const executedDecisions: any[] = [];

    // 1. Bid changes em batch
    const kwDecisions = [...toExecuteDecreases, ...bidIncreaseDecisions];
    for (let i = 0; i < kwDecisions.length; i += MAX_KW_BATCH) {
      const batch = kwDecisions.slice(i, i + MAX_KW_BATCH);
      const payload = batch.map((d: any) => ({ keywordId: d.entity_id, bid: d.proposed_config.bid }));

      const res = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        _service_role: true, amazon_account_id: accountId,
        path: '/sp/keywords', method: 'PUT',
        content_type: 'application/vnd.spKeyword.v3+json',
        payload: { keywords: payload },
      }).catch((e: any) => ({ ok: false, error: e.message }));

      const ok = res?.ok === true || res?.status === 207;
      for (const d of batch) {
        if (ok) {
          if (d._kw?.id) {
            await base44.asServiceRole.entities.Keyword.update(d._kw.id, {
              current_bid: d.proposed_config.bid, bid: d.proposed_config.bid, last_seen_at: now,
            }).catch(() => {});
          }
          await base44.asServiceRole.entities.AdsBidChangeLog.create({
            amazon_account_id: accountId, campaign_id: d.campaign_id,
            keyword_id: d.entity_id, asin: d.asin, keyword_text: d.entity_name,
            match_type: d._kw?.match_type,
            bid_before: d.current_config?.bid, bid_after: d.proposed_config?.bid,
            change_pct: d.current_config?.bid > 0
              ? ((Number(d.proposed_config.bid) - Number(d.current_config.bid)) / Number(d.current_config.bid)) * 100 : 0,
            action: d.action, acos_at_change: d.current_value,
            target_acos_at_change: d.target, orders_at_change: d._kw?.orders || 0,
            clicks_at_change: d._kw?.clicks || 0, spend_at_change: d._kw?.spend || 0,
            reason: d.reason, confidence: d.confidence, rule_id: d.rule_id,
            source: 'adjustBidsWithConversion', bidding_strategy: 'down_only',
            projected_acos_after: d.projected_acos_after, created_at: now,
          }).catch(() => {});
          executedCount++;
          executedDecisions.push({ ...d, status: 'applied', _kw: undefined, _camp: undefined });
        } else {
          errorsCount++;
          executedDecisions.push({ ...d, status: 'error', error: JSON.stringify(res).slice(0, 150), _kw: undefined, _camp: undefined });
        }
      }
      await sleep(THROTTLE_MS);
    }

    // 2. Budget increases
    for (const d of budgetIncreaseDecisions) {
      const campAmazonId = d._camp?.amazon_campaign_id || d.entity_id;
      const res = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        _service_role: true, amazon_account_id: accountId,
        path: '/sp/campaigns', method: 'PUT',
        content_type: 'application/vnd.spCampaign.v3+json',
        payload: { campaigns: [{ campaignId: String(campAmazonId), budget: { budget: d.proposed_config.daily_budget, budgetType: 'DAILY' } }] },
      }).catch((e: any) => ({ ok: false, error: e.message }));

      const ok = res?.ok === true || res?.status === 207;
      if (ok) {
        if (d._camp?.id) {
          await base44.asServiceRole.entities.Campaign.update(d._camp.id, { daily_budget: d.proposed_config.daily_budget }).catch(() => {});
        }
        await base44.asServiceRole.entities.CampaignChangeHistory.create({
          amazon_account_id: accountId, campaign_id: d.entity_id, asin: d.asin,
          change_type: 'orchestrator_budget', field_changed: 'daily_budget',
          old_value: String(d.current_config.daily_budget), new_value: String(d.proposed_config.daily_budget),
          reason: d.reason, acos_at_change: d.current_value, target_acos_at_change: d.target,
          applied_at: now, source: 'adjustBidsWithConversion', created_at: now,
        }).catch(() => {});
        executedCount++;
        executedDecisions.push({ ...d, status: 'applied', _kw: undefined, _camp: undefined });
      } else {
        errorsCount++;
        executedDecisions.push({ ...d, status: 'error', _kw: undefined, _camp: undefined });
      }
      await sleep(THROTTLE_MS);
    }

    // 3. Reactivations
    for (const d of reactivateDecisions) {
      const res = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        _service_role: true, amazon_account_id: accountId,
        path: '/sp/keywords', method: 'PUT',
        content_type: 'application/vnd.spKeyword.v3+json',
        payload: { keywords: [{ keywordId: d.entity_id, state: 'ENABLED' }] },
      }).catch((e: any) => ({ ok: false, error: e.message }));

      const ok = res?.ok === true || res?.status === 207;
      if (ok) {
        if (d._kw?.id) {
          await base44.asServiceRole.entities.Keyword.update(d._kw.id, { state: 'enabled', status: 'enabled' }).catch(() => {});
        }
        await base44.asServiceRole.entities.AdsBidChangeLog.create({
          amazon_account_id: accountId, campaign_id: d.campaign_id,
          keyword_id: d.entity_id, keyword_text: d.entity_name,
          action: 'keyword_reactivate', acos_at_change: d.current_value,
          reason: d.reason, source: 'adjustBidsWithConversion', created_at: now,
        }).catch(() => {});
        executedCount++;
        executedDecisions.push({ ...d, status: 'reactivated', _kw: undefined });
      } else {
        errorsCount++;
        executedDecisions.push({ ...d, status: 'error', _kw: undefined });
      }
      await sleep(THROTTLE_MS);
    }

    return Response.json({
      ok: true, dry_run: false,
      pipeline_version: PIPELINE_VERSION,
      account_mode: accountMode, strategy_chosen: strategy,
      goal_conflict: conflictCheck.conflict, goal_conflict_detail: conflictCheck.detail,
      projected_acos_before: totalSales > 0 ? r2(accountAcos) : null,
      projected_acos_after: finalProjAcos ? r2(finalProjAcos) : null,
      target_reached: finalProjAcos !== null && finalProjAcos <= goal.target_acos,
      actions_by_lever: actionsByLever,
      target_acos: goal.target_acos, max_bid: goal.max_bid,
      avg_break_even_acos: r2(avgBreakEven),
      avg_sustainable_acos: r2(avgBreakEven * ECONOMIC_SAFETY_FACTOR),
      keywords_executed: executedCount, errors: errorsCount,
      decisions: executedDecisions, blocked: blocked.slice(0, 50),
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});