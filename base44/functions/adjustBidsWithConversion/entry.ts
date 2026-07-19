/**
 * Amazon Ads Goal Orchestrator v1
 * ─────────────────────────────────────────────────────────────────────────
 * Motor determinístico de otimização de lances — 18 regras do PRD.
 *
 * Pipeline:
 *  1. Goal Resolution
 *  2. Band Classification → Account Mode
 *  3. Campaign Tiering (A/B/C/D)
 *  4. Strategy Selection (CUT_FIRST / SCALE_WINNERS / HYBRID / REBALANCE / MAINTAIN)
 *  5. Root Cause Detection
 *  6. Data Validation & Blocking (stale, stock=0, listing, reconciliation, cooldown)
 *  7. Zero-Sale Waste Engine
 *  8. Action Ranking & Simulation (scoring)
 *  9. Stop Rule: projecta ACoS → para quando atingir target
 * 10. Lever Execution (bid ↓ → budget ↑ → reactivate → bid ↑)
 * 11. Cooldown Registration
 * 12. Goal Conflict Detection
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── Constantes ───────────────────────────────────────────────────────────
const PIPELINE_VERSION   = 'goal-orchestrator-v1';
const RULE_VERSION       = '1.0';
const MIN_BID            = 0.25;
const MAX_DECREASE_PCT   = 0.20;
const MAX_INCREASE_PCT   = 0.08;
const BUDGET_INCREASE_PCT= 0.20;
const THROTTLE_MS        = 200;
const MAX_KW_BATCH       = 10;
const MAX_KEYWORDS       = 500;     // timeout safety
const WINNER_ACOS        = 12;      // <= 12% = winner
const TARGET_ACOS_CEIL   = 15;      // > 15% = não escalar
const STALE_DAYS         = 7;
const COOLDOWN_BID_H     = 48;
const COOLDOWN_BUDGET_H  = 24;
const WASTE_SOFT_FACTOR  = 1.0;
const WASTE_HARD_FACTOR  = 1.5;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function r2(v: number)     { return parseFloat(v.toFixed(2)); }
function hoursLater(h: number): string { return new Date(Date.now() + h*3600*1000).toISOString(); }

// ── Helpers econômicos ────────────────────────────────────────────────────
function sustainableCpc(aov: number, cvr: number, targetAcos: number): number {
  return aov * cvr * (targetAcos / 100);
}
function actionScore(impact: number, conf: number, risk: number, rev: number): number {
  return (impact * conf) / (risk * Math.max(rev, 1));
}
function projectAcosAfterBidChange(spend: number, sales: number, oldBid: number, newBid: number): number {
  if (sales <= 0 || oldBid <= 0) return 999;
  return ((spend * (newBid / oldBid)) / sales) * 100;
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

// ── Band Classification → Account Mode ───────────────────────────────────
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

// ── Campaign Tiering ──────────────────────────────────────────────────────
function tierCampaign(c: any, targetAcos: number, breakEvenAcos: number) {
  const spend   = Number(c.spend  || c.current_spend || 0);
  const sales   = Number(c.sales  || 0);
  const orders  = Number(c.orders || 0);
  const clicks  = Number(c.clicks || 0);
  const daily   = Number(c.daily_budget || 0);
  const acos    = sales > 0 ? (spend / sales) * 100 : (spend > 0 ? 999 : 0);
  const budRatio= daily > 0 ? spend / daily : 0;

  let tier = 'D';
  if (acos <= WINNER_ACOS && orders >= 1)           tier = 'A';
  else if (acos > 0 && acos <= targetAcos)          tier = 'B';
  else if (acos > targetAcos && acos <= 25)         tier = 'C';

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

// ── Strategy Selection ────────────────────────────────────────────────────
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

// ── Goal Conflict Detection ───────────────────────────────────────────────
function detectConflict(goal: any, metrics: any): { conflict: boolean; detail?: string } {
  const impliedAcos = 100 / goal.target_roas;
  if (Math.abs(impliedAcos - goal.target_acos) > 5) {
    return { conflict: true, detail: `target_roas ${goal.target_roas}x implica ACoS ${impliedAcos.toFixed(1)}% mas target_acos=${goal.target_acos}%` };
  }
  if (goal.target_acos < 10 && goal.daily_budget_limit > 100 && metrics.account_acos > 25) {
    return { conflict: true, detail: `Meta ACoS ${goal.target_acos}% muito agressiva vs budget R$${goal.daily_budget_limit} com ACoS atual ${metrics.account_acos.toFixed(1)}%` };
  }
  return { conflict: false };
}

// ── Data Blocking ─────────────────────────────────────────────────────────
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

  // Emergency overrides (ignoram cooldown mas bloqueiam alteração)
  if (prod && Number(prod.fba_inventory || 0) === 0 && prod.inventory_status !== 'in_stock') {
    return { blocked: true, reason: 'estoque_zero', isEmergency: true };
  }
  if (prod && (prod.listing_suppressed === true || prod.listing_buyable === false || prod.offer_active === false)) {
    return { blocked: true, reason: 'listing_bloqueado', isEmergency: true };
  }
  // Dados stale
  const lastSeen = kw.last_seen_at || kw.synced_at || '';
  if (lastSeen && lastSeen < stale7d) {
    return { blocked: true, reason: 'dados_stale' };
  }
  // Reconciliation
  if (camp?.reconciliation_status === 'review_required') {
    return { blocked: true, reason: 'reconciliation_pending' };
  }
  // Cooldown
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

    // ── Resolver conta ──────────────────────────────────────────────────
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

    // ── 0. KILL SWITCH GUARD ────────────────────────────────────────
    const brtDateForKs = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const todayBRTForKs = brtDateForKs.toISOString().slice(0, 10);
    const ksControllers = await base44.asServiceRole.entities.AccountDailySpendController.filter(
      { amazon_account_id: accountId, spend_date: todayBRTForKs }, null, 1
    ).catch(() => []);
    const ksController = ksControllers[0];
    if (ksController?.global_kill_switch === true) {
      return Response.json({
        ok: true,
        skipped: true,
        reason: 'Kill Switch ativo — nenhum bid ou budget alterado',
        kill_switch_activated_at: ksController.kill_switch_activated_at,
        duration_ms: Date.now() - t0,
      });
    }

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

    // Map break_even por ASIN
    const breakEvenMap = new Map<string, number>();
    for (const e of economicsList) {
      if (e.asin) breakEvenMap.set(e.asin, Number(e.break_even_acos || 30));
    }

    // ── Cooldown lookup ────────────────────────────────────────────────
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

    // ── Carregar dados ─────────────────────────────────────────────────
    const [allCampaigns, allProducts, allKeywords] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, null, 1000).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, null, 1000).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-spend', MAX_KEYWORDS).catch(() => []),
    ]);

    // Maps de lookup
    const productMap  = new Map<string, any>();
    const campaignMap = new Map<string, any>();
    for (const p of allProducts) { if (p.asin) productMap.set(p.asin, p); }
    for (const c of allCampaigns) {
      if (c.campaign_id)       campaignMap.set(c.campaign_id, c);
      if (c.amazon_campaign_id) campaignMap.set(c.amazon_campaign_id, c);
    }

    // Filtrar apenas campanhas operacionais (não arquivadas)
    const activeCampaigns = allCampaigns.filter((c: any) => {
      const s = (c.state || c.status || '').toLowerCase();
      return s !== 'archived' && c.archived !== true;
    });

    // ── 2. ACCOUNT METRICS ─────────────────────────────────────────────
    let totalSpend = 0, totalSales = 0, totalOrders = 0, totalClicks = 0;
    for (const c of activeCampaigns) {
      totalSpend  += Number(c.spend  || c.current_spend || 0);
      totalSales  += Number(c.sales  || 0);
      totalOrders += Number(c.orders || 0);
      totalClicks += Number(c.clicks || 0);
    }
    const accountAcos = totalSales > 0 ? (totalSpend / totalSales) * 100 : 0;
    const metrics = {
      total_spend: totalSpend,
      total_sales: totalSales,
      total_orders: totalOrders,
      account_acos: accountAcos,
      gap: accountAcos - goal.target_acos,
      max_spend_at_current_sales: totalSales * (goal.target_acos / 100),
      required_sales_at_current_spend: goal.target_acos > 0 ? totalSpend / (goal.target_acos / 100) : 0,
    };

    // ── 2. BAND CLASSIFICATION → ACCOUNT MODE ─────────────────────────
    const band = classifyBand(accountAcos, goal.target_acos);
    const accountMode = mode_override || bandToMode(band);

    // ── 3. CAMPAIGN TIERING ────────────────────────────────────────────
    const campaignProfiles: any[] = activeCampaigns.map((c: any) => {
      const breakEven = c.asin ? (breakEvenMap.get(c.asin) || avgBreakEven) : avgBreakEven;
      return { ...tierCampaign(c, goal.target_acos, breakEven), campaign: c };
    });
    const profileByCampId = new Map<string, any>();
    for (const p of campaignProfiles) {
      if (p.campaign?.campaign_id) profileByCampId.set(p.campaign.campaign_id, p);
      if (p.campaign?.amazon_campaign_id) profileByCampId.set(p.campaign.amazon_campaign_id, p);
    }

    // ── 4. STRATEGY SELECTION ──────────────────────────────────────────
    const strategy = selectStrategy(campaignProfiles, metrics, accountMode, goal.target_acos);

    // ── 12. GOAL CONFLICT ──────────────────────────────────────────────
    const conflictCheck = detectConflict(goal, metrics);

    // ── 5 & 6. ROOT CAUSE + BLOCKING + DECISION BUILDING ─────────────
    const blocked: any[] = [];
    const bidDecreaseDecisions: any[] = [];
    const bidIncreaseDecisions: any[] = [];
    const reactivateDecisions:  any[] = [];

    for (const kw of allKeywords) {
      const kwId = String(kw.keyword_id || kw.id);
      const bid  = Number(kw.current_bid || kw.bid || 0);
      if (bid <= 0) continue;

      const kwState = (kw.state || kw.status || '').toLowerCase();
      if (kwState === 'archived') continue;

      // Blocking
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

      const isWinner = acos > 0 && acos <= WINNER_ACOS && orders >= 1;

      // ── PASSO 6: Reativar winner pausado ──────────────────────────────
      if (kwState === 'paused') {
        if (isWinner) {
          const prod = kw.asin ? productMap.get(kw.asin) : null;
          const hasStock = !prod || Number(prod.fba_inventory || 0) > 0;
          if (hasStock) {
            reactivateDecisions.push({
              goal: 'scale_winners', current_value: acos, target: goal.target_acos,
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
              reason: `Winner pausado (ACoS ${acos.toFixed(1)}%, ${orders} pedidos) com stock OK → reativar`,
              _kw: kw,
            });
          }
        }
        continue;
      }

      // ── PASSO 5: Proteger winners (nunca reduzir) ─────────────────────
      // ── PASSO 7: Zero-Sale Waste ──────────────────────────────────────
      if (!isWinner) {
        if (orders === 0 && clicks >= 5 && spend > 0) {
          // Calcular Target CPA como proxy
          const acctAovProxy = totalOrders > 0 ? totalSales / totalOrders : 50;
          const tCpa  = acctAovProxy * (goal.target_acos / 100);
          const soft  = tCpa * WASTE_SOFT_FACTOR;
          const hard  = tCpa * WASTE_HARD_FACTOR;

          if (spend >= soft) {
            const redPct = spend >= hard ? 0.20 : 0.15;
            const newBid = r2(Math.max(goal.min_bid, bid * (1 - redPct)));
            if (newBid < bid - 0.01) {
              const impact = ((bid - newBid) / bid) * 100;
              bidDecreaseDecisions.push({
                goal: 'reduce_acos', current_value: acos, target: goal.target_acos,
                gap: acos - goal.target_acos, root_cause: 'TRAFFIC_QUALITY',
                strategy_macro: strategy, action: 'bid_decrease',
                entity_type: 'keyword', entity_id: kwId, entity_name: kw.keyword_text,
                asin: kw.asin, campaign_id: kw.campaign_id,
                current_config: { bid, spend, clicks, orders },
                proposed_config: { bid: newBid },
                expected_impact_pct: impact, confidence: 82, risk_level: 'low',
                action_score: actionScore(impact, 82, 1, 24),
                rule_id: `ORCH-WASTE-${spend >= hard ? 'HARD' : 'SOFT'}-${RULE_VERSION}`,
                rule_version: RULE_VERSION,
                cooldown_until: hoursLater(COOLDOWN_BID_H),
                next_review_at: hoursLater(COOLDOWN_BID_H),
                reason: `Zero-sale waste: ${clicks} cliques, R$${spend.toFixed(2)}, 0 pedidos → -${(redPct*100).toFixed(0)}% (${spend >= hard ? 'hard' : 'soft'} limit)`,
                _kw: kw,
              });
              continue;
            }
          }
        }

        // ── PASSO 4: Reduzir ACoS alto (CPC_PROBLEM) ───────────────────
        if (acos > goal.target_acos && orders > 0) {
          // Não esmagar se root cause = CVR (problema de listing, não de bid)
          if (profile?.rootCause === 'CVR_PROBLEM') continue;

          const factor = Math.max(1 - MAX_DECREASE_PCT, goal.target_acos / acos);
          const newBid = r2(Math.max(goal.min_bid, bid * factor));
          if (newBid < bid - 0.01) {
            const impact = ((bid - newBid) / bid) * 100;
            const spendPerTCpa = totalOrders > 0
              ? spend / ((totalSales / totalOrders) * (goal.target_acos / 100))
              : 0;
            const rsk = acos > breakEven * 0.9 ? 'high' : 'medium';
            bidDecreaseDecisions.push({
              goal: 'reduce_acos', current_value: acos, target: goal.target_acos,
              gap: acos - goal.target_acos, root_cause: 'CPC_PROBLEM',
              strategy_macro: strategy, action: 'bid_decrease',
              entity_type: 'keyword', entity_id: kwId, entity_name: kw.keyword_text,
              asin: kw.asin, campaign_id: kw.campaign_id,
              current_config: { bid, acos, spend, orders },
              proposed_config: { bid: newBid },
              expected_impact_pct: impact, confidence: 85,
              risk_level: rsk,
              action_score: actionScore(impact, 85, rsk === 'high' ? 2 : 1.5, 48),
              rule_id: `ORCH-BID-DOWN-${profile?.tier || 'C'}-${RULE_VERSION}`,
              rule_version: RULE_VERSION,
              cooldown_until: hoursLater(COOLDOWN_BID_H),
              next_review_at: hoursLater(COOLDOWN_BID_H),
              reason: `ACoS ${acos.toFixed(1)}% > meta ${goal.target_acos}% → bid × ${factor.toFixed(2)} (-${impact.toFixed(0)}%). Spend/TargetCPA: ${spendPerTCpa.toFixed(1)}`,
              _kw: kw,
            });
          }
        }
      }

      // ── PASSO 8: Aumentar bid de winner (sem budget limitation) ────────
      if (accountMode === 'SCALE' || accountMode === 'MAINTAIN') {
        if (!isWinner || acos > goal.target_acos) continue;
        if (clicks < 10 || orders < 1 || bid >= goal.max_bid) continue;
        if (profile?.rootCause === 'BUDGET_PROBLEM') continue; // Passo 7 primeiro

        const aov  = sales / orders;
        const cvr  = orders / clicks;
        const maxCpc = sustainableCpc(aov, cvr, goal.target_acos);
        const curCpc = spend / clicks;
        if (maxCpc <= 0 || curCpc >= maxCpc * 0.85) continue;

        const headroom = (goal.target_acos - acos) / goal.target_acos;
        const boostPct = Math.min(MAX_INCREASE_PCT, Math.max(0.03, headroom * MAX_INCREASE_PCT));
        const newBid   = r2(Math.min(goal.max_bid, bid * (1 + boostPct)));
        if (newBid <= bid + 0.01) continue;

        bidIncreaseDecisions.push({
          goal: 'scale_winners', current_value: acos, target: goal.target_acos,
          gap: acos - goal.target_acos, root_cause: 'VISIBILITY_PROBLEM',
          strategy_macro: strategy, action: 'bid_increase',
          entity_type: 'keyword', entity_id: kwId, entity_name: kw.keyword_text,
          asin: kw.asin, campaign_id: kw.campaign_id,
          current_config: { bid, acos, cpc: r2(curCpc), sustainable_cpc: r2(maxCpc) },
          proposed_config: { bid: newBid },
          expected_impact_pct: boostPct * 100, confidence: 70, risk_level: 'low',
          action_score: actionScore(boostPct * 100, 70, 1, 48),
          rule_id: `ORCH-BID-UP-A-${RULE_VERSION}`,
          rule_version: RULE_VERSION,
          cooldown_until: hoursLater(COOLDOWN_BID_H),
          next_review_at: hoursLater(COOLDOWN_BID_H),
          reason: `Winner (ACoS ${acos.toFixed(1)}%), CPC R$${curCpc.toFixed(2)} < sustentável R$${maxCpc.toFixed(2)} → +${(boostPct*100).toFixed(0)}%`,
          _kw: kw,
        });
      }
    }

    // ── PASSO 7: Budget increase para winners limitados ─────────────────
    const budgetIncreaseDecisions: any[] = [];
    for (const p of campaignProfiles) {
      const c   = p.campaign;
      const cId = String(c.campaign_id || c.id);
      if (cooldownBudgetIds.has(cId)) continue;
      if (p.tier !== 'A' || p.budRatio < 0.90) continue;
      const daily = Number(c.daily_budget || 0);
      if (daily <= 0) continue;
      const newBudget = r2(Math.min(goal.daily_budget_limit, daily * (1 + BUDGET_INCREASE_PCT)));
      if (newBudget <= daily + 0.50) continue;

      budgetIncreaseDecisions.push({
        goal: 'scale_winners', current_value: p.acos, target: goal.target_acos,
        gap: p.acos - goal.target_acos, root_cause: 'BUDGET_PROBLEM',
        strategy_macro: strategy, action: 'budget_increase',
        entity_type: 'campaign', entity_id: cId, entity_name: c.name || c.campaign_name,
        asin: c.asin, campaign_id: cId,
        current_config: { daily_budget: daily, budget_ratio: r2(p.budRatio) },
        proposed_config: { daily_budget: newBudget },
        expected_impact_pct: BUDGET_INCREASE_PCT * 100, confidence: 75, risk_level: 'low',
        action_score: actionScore(20, 75, 1, 24),
        rule_id: `ORCH-BUDGET-UP-A-${RULE_VERSION}`,
        rule_version: RULE_VERSION,
        cooldown_until: hoursLater(COOLDOWN_BUDGET_H),
        next_review_at: hoursLater(COOLDOWN_BUDGET_H),
        reason: `Winner (ACoS ${p.acos.toFixed(1)}%) com ${(p.budRatio*100).toFixed(0)}% budget consumido → +${(BUDGET_INCREASE_PCT*100).toFixed(0)}% orçamento`,
        _camp: c,
      });
    }

    // ── 8. ACTION RANKING & SIMULATION ────────────────────────────────
    // Ordenar reduções por action_score (maior impacto/confiança)
    bidDecreaseDecisions.sort((a: any, b: any) => b.action_score - a.action_score);

    // ── 9. STOP RULE: simular impacto acumulado, parar quando ACoS projetado <= target ──
    let runningSpend = totalSpend;
    const toExecuteDecreases: any[] = [];

    for (const d of bidDecreaseDecisions) {
      if (accountMode === 'MAINTAIN' || accountMode === 'SCALE') {
        // Em MAINTAIN/SCALE, só executa waste removal, não reduções agressivas
        if (d.root_cause === 'CPC_PROBLEM') continue;
      }

      const kw     = d._kw;
      const oldBid = Number(kw?.current_bid || kw?.bid || 0);
      const newBid = Number(d.proposed_config?.bid || oldBid);
      const kwSpend= Number(kw?.spend || 0);
      if (oldBid > 0 && kwSpend > 0) {
        runningSpend += kwSpend * (newBid / oldBid - 1);
      }
      const projAcos = totalSales > 0 ? (runningSpend / totalSales) * 100 : 999;
      d.projected_acos_after = r2(projAcos);
      toExecuteDecreases.push(d);

      // PASSO 11: parar se projeção já atingiu a meta
      if (projAcos <= goal.target_acos) break;
    }

    // Pipeline de execução ordenada (PRD §9):
    // 1. Waste/bid decreases → 2. Budget increases (winners) → 3. Reactivations → 4. Bid increases
    const orderedDecisions: any[] = [
      ...toExecuteDecreases,
      ...budgetIncreaseDecisions,
      ...reactivateDecisions,
      ...bidIncreaseDecisions,
    ];

    // Calcular projeção final
    const finalProjAcos = totalSales > 0 ? (runningSpend / totalSales) * 100 : null;

    // ── Actions by lever counter ───────────────────────────────────────
    const actionsByLever: Record<string, number> = {};
    for (const d of orderedDecisions) {
      actionsByLever[d.action] = (actionsByLever[d.action] || 0) + 1;
    }

    // ─── DRY RUN ──────────────────────────────────────────────────────
    if (dry_run) {
      // Limpar refs internas
      const cleanDecisions = orderedDecisions.map(({ _kw, _camp, ...rest }: any) => rest);
      return Response.json({
        ok: true,
        dry_run: true,
        pipeline_version: PIPELINE_VERSION,
        account_mode: accountMode,
        strategy_chosen: strategy,
        goal_conflict: conflictCheck.conflict,
        goal_conflict_detail: conflictCheck.detail,
        projected_acos_before: totalSales > 0 ? r2(accountAcos) : null,
        projected_acos_after: finalProjAcos ? r2(finalProjAcos) : null,
        target_reached: finalProjAcos !== null && finalProjAcos <= goal.target_acos,
        actions_by_lever: actionsByLever,
        target_acos: goal.target_acos,
        max_bid: goal.max_bid,
        // Debug
        account_acos: r2(accountAcos),
        band,
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

    // ─── EXECUÇÃO REAL ─────────────────────────────────────────────────
    let executedCount = 0;
    let errorsCount   = 0;
    const executedDecisions: any[] = [];

    // 1. Batch bid changes (decrease + increase em lotes de MAX_KW_BATCH)
    const kwDecisions = [...toExecuteDecreases, ...bidIncreaseDecisions];
    for (let i = 0; i < kwDecisions.length; i += MAX_KW_BATCH) {
      const batch = kwDecisions.slice(i, i + MAX_KW_BATCH);
      const payload = batch.map((d: any) => ({
        keywordId: d.entity_id,
        bid: d.proposed_config.bid,
      }));

      const res = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        _service_role: true,
        amazon_account_id: accountId,
        path: '/sp/keywords',
        method: 'PUT',
        content_type: 'application/vnd.spKeyword.v3+json',
        payload: { keywords: payload },
      }).catch((e: any) => ({ ok: false, error: e.message }));

      const ok = res?.ok === true || res?.status === 207;
      for (const d of batch) {
        if (ok) {
          if (d._kw?.id) {
            await base44.asServiceRole.entities.Keyword.update(d._kw.id, {
              current_bid: d.proposed_config.bid,
              bid: d.proposed_config.bid,
              last_seen_at: now,
            }).catch(() => {});
          }
          // Log cooldown (PASSO 12)
          await base44.asServiceRole.entities.AdsBidChangeLog.create({
            amazon_account_id: accountId,
            campaign_id: d.campaign_id,
            keyword_id: d.entity_id,
            asin: d.asin,
            keyword_text: d.entity_name,
            match_type: d._kw?.match_type,
            bid_before: d.current_config?.bid,
            bid_after: d.proposed_config?.bid,
            change_pct: d.current_config?.bid > 0
              ? ((Number(d.proposed_config.bid) - Number(d.current_config.bid)) / Number(d.current_config.bid)) * 100
              : 0,
            action: d.action,
            acos_at_change: d.current_value,
            target_acos_at_change: d.target,
            orders_at_change: d._kw?.orders || 0,
            clicks_at_change: d._kw?.clicks || 0,
            spend_at_change: d._kw?.spend || 0,
            reason: d.reason,
            confidence: d.confidence,
            rule_id: d.rule_id,
            source: 'adjustBidsWithConversion',
            bidding_strategy: 'down_only',
            projected_acos_after: d.projected_acos_after,
            created_at: now,
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
        _service_role: true,
        amazon_account_id: accountId,
        path: '/sp/campaigns',
        method: 'PUT',
        content_type: 'application/vnd.spCampaign.v3+json',
        payload: { campaigns: [{ campaignId: String(campAmazonId), budget: { budget: d.proposed_config.daily_budget, budgetType: 'DAILY' } }] },
      }).catch((e: any) => ({ ok: false, error: e.message }));

      const ok = res?.ok === true || res?.status === 207;
      if (ok) {
        if (d._camp?.id) {
          await base44.asServiceRole.entities.Campaign.update(d._camp.id, { daily_budget: d.proposed_config.daily_budget }).catch(() => {});
        }
        await base44.asServiceRole.entities.CampaignChangeHistory.create({
          amazon_account_id: accountId,
          campaign_id: d.entity_id,
          asin: d.asin,
          change_type: 'orchestrator_budget',
          field_changed: 'daily_budget',
          old_value: String(d.current_config.daily_budget),
          new_value: String(d.proposed_config.daily_budget),
          reason: d.reason,
          acos_at_change: d.current_value,
          target_acos_at_change: d.target,
          applied_at: now,
          source: 'adjustBidsWithConversion',
          created_at: now,
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
        _service_role: true,
        amazon_account_id: accountId,
        path: '/sp/keywords',
        method: 'PUT',
        content_type: 'application/vnd.spKeyword.v3+json',
        payload: { keywords: [{ keywordId: d.entity_id, state: 'ENABLED' }] },
      }).catch((e: any) => ({ ok: false, error: e.message }));

      const ok = res?.ok === true || res?.status === 207;
      if (ok) {
        if (d._kw?.id) {
          await base44.asServiceRole.entities.Keyword.update(d._kw.id, { state: 'enabled', status: 'enabled' }).catch(() => {});
        }
        await base44.asServiceRole.entities.AdsBidChangeLog.create({
          amazon_account_id: accountId,
          campaign_id: d.campaign_id,
          keyword_id: d.entity_id,
          keyword_text: d.entity_name,
          action: 'keyword_reactivate',
          acos_at_change: d.current_value,
          reason: d.reason,
          source: 'adjustBidsWithConversion',
          created_at: now,
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
      ok: true,
      dry_run: false,
      pipeline_version: PIPELINE_VERSION,
      account_mode: accountMode,
      strategy_chosen: strategy,
      goal_conflict: conflictCheck.conflict,
      goal_conflict_detail: conflictCheck.detail,
      projected_acos_before: totalSales > 0 ? r2(accountAcos) : null,
      projected_acos_after: finalProjAcos ? r2(finalProjAcos) : null,
      target_reached: finalProjAcos !== null && finalProjAcos <= goal.target_acos,
      actions_by_lever: actionsByLever,
      target_acos: goal.target_acos,
      max_bid: goal.max_bid,
      keywords_executed: executedCount,
      errors: errorsCount,
      decisions: executedDecisions,
      blocked: blocked.slice(0, 50),
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});