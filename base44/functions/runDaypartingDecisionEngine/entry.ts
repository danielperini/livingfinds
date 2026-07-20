/**
 * Dayparting Decision Engine — Motor determinístico de otimização por hora/dia
 *
 * Pipeline:
 *  1. Carregar métricas horárias (UnifiedAdsMetricsHourly + HourlyMetric)
 *  2. Agregar por ASIN+KEYWORD+DAY_OF_WEEK+HOUR em janelas RECENT(14d)/BASELINE(28d)
 *  3. Calcular baseline da campanha (28d)
 *  4. Calcular TIME_SLOT_SCORE (0-100)
 *  5. Determinar SUSTAINABLE_CPC por slot
 *  6. Decidir ação: BID_UP / BID_DOWN_ACOS / BID_DOWN_CVR / NO_SALES / MAINTAIN / BLOCK
 *  7. Recency Check (TREND)
 *  8. Budget Protection
 *  9. Criar DaypartingDecision com status pending_approval
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const PIPELINE_VERSION = 'daypart-engine-v3-peak-aggressive';
const RULE_VERSION = '1.1';
const MIN_OCCURRENCES_MATURE = 4;
const MIN_ORDERS_BID_UP = 2;          // v3: reduzido de 3→2 (mais agressivo em picos)
const MIN_CLICKS_BID_UP = 15;         // v3: reduzido de 20→15
const ACOS_THRESHOLD_BID_UP = 0.85;   // v3: ampliado de 0.80→0.85 (janela maior de BID_UP)
const CVR_ADVANTAGE_BID_UP = 1.10;    // v3: reduzido de 1.15→1.10 (menos exigente em picos)
const MAX_BID_UP_AUTO = 0.20;         // HARD CAP: +20% max por ciclo (PRD)
const MAX_BID_UP_APPROVAL_THRESHOLD = 0.15; // > 15% exige approval mesmo em modo autônomo
const MIN_BID_UP = 0.03;
// v3: multiplicadores adicionais para slots PEAK (aprendido de HourlySalesPattern)
const PEAK_ELITE_BID_BONUS = 0.08;   // +8% adicional sobre o uplift calculado em slots PEAK_ELITE
const PEAK_STRONG_BID_BONUS = 0.04;  // +4% adicional em PEAK_STRONG
const MAX_BID_DOWN_ACOS = 0.15;       // -15% max por ciclo
const BID_DOWN_CVR_SOFT = 0.10;
const BID_DOWN_CVR_HARD = 0.15;      // hard máximo -15%
const CVR_WEAK_THRESHOLD = 0.70;      // CVR slot < baseline × 0.70
const ZERO_SALES_SOFT_MULT = 1.0;     // × TARGET_CPA
const ZERO_SALES_HARD_MULT = 1.5;
const ZERO_SALES_MIN_CLICKS = 5;
const TREND_DECAY_THRESHOLD = 0.20;   // deterioração > 20%
const TREND_IMPROVE_THRESHOLD = 0.20;
const DECISION_EXPIRY_DAYS = 14;
const MIN_BID_GLOBAL = 0.25;
const BID_FLOOR_RELATIVE = 0.40;     // HARD CAP: floor = max(perf.min_bid, current_bid × 0.40)

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function r2(v: number) { return parseFloat(v.toFixed(2)); }
function hoursLater(h: number) { return new Date(Date.now() + h * 3600 * 1000).toISOString(); }
function daysAgo(d: number) { return new Date(Date.now() - d * 86400000).toISOString(); }

const DAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];

function sustainableCpc(aov: number, cvr: number, targetAcos: number): number {
  if (aov <= 0 || cvr <= 0 || targetAcos <= 0) return 0;
  return parseFloat((aov * cvr * (targetAcos / 100)).toFixed(2));
}

function dataConfidenceLevel(occurrences: number, orders: number, clicks: number): string {
  if (occurrences >= 8 && orders >= 5 && clicks >= 50) return 'VERY_HIGH';
  if (occurrences >= 6 && orders >= 2 && clicks >= 20) return 'HIGH';
  if (occurrences >= MIN_OCCURRENCES_MATURE && clicks >= 10) return 'MEDIUM';
  return 'LOW';
}

// TIME_SLOT_SCORE (0-100)
function calcTimeSlotScore(slot: any, baseline: any, targetAcos: number): number {
  let score = 0;

  // 1. ACoS Efficiency (30pts)
  if (slot.acos > 0 && targetAcos > 0) {
    const acosEff = Math.max(0, (1 - slot.acos / targetAcos));
    score += Math.min(30, acosEff * 40);
  }

  // 2. CVR Strength vs baseline (25pts)
  if (slot.cvr > 0 && baseline.cvr > 0) {
    const cvrRatio = slot.cvr / baseline.cvr;
    score += Math.min(25, (cvrRatio - 0.5) * 25);
  }

  // 3. Sales Volume (20pts)
  if (slot.orders >= 5) score += 20;
  else if (slot.orders >= 3) score += 14;
  else if (slot.orders >= 1) score += 8;
  else if (slot.clicks >= 10) score += 3;

  // 4. ROAS (10pts)
  if (slot.roas >= 10) score += 10;
  else if (slot.roas >= 6) score += 7;
  else if (slot.roas >= 3) score += 4;
  else if (slot.roas >= 1) score += 2;

  // 5. Data Confidence (10pts)
  const conf = dataConfidenceLevel(slot.occurrences || 0, slot.orders, slot.clicks);
  if (conf === 'VERY_HIGH') score += 10;
  else if (conf === 'HIGH') score += 7;
  else if (conf === 'MEDIUM') score += 4;

  // 6. Recency Bonus (5pts)
  if (slot.trend_status === 'IMPROVING') score += 5;
  else if (slot.trend_status === 'STABLE') score += 3;
  else if (slot.trend_status === 'DECAYING') score -= 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function classifySlot(score: number): string {
  if (score >= 90) return 'ELITE_TIME';
  if (score >= 75) return 'STRONG_TIME';
  if (score >= 55) return 'NORMAL_TIME';
  if (score >= 35) return 'WEAK_TIME';
  return 'LOSS_TIME';
}

// ── PROFIT-SAFE inline para Dayparting ───────────────────────────────────
const ECONOMIC_SAFETY_FACTOR_DP = 0.80;
function buildDpEconCtx(bid: number, slot: any, breakEvenAcos: number, targetAcos: number, contribMargin: number) {
  const sustainable_acos = parseFloat((breakEvenAcos * ECONOMIC_SAFETY_FACTOR_DP).toFixed(2));
  const current_acos     = slot.acos || 0;
  const acos_headroom    = parseFloat((sustainable_acos - current_acos).toFixed(2));
  const current_profit   = parseFloat((slot.sales * contribMargin - slot.spend).toFixed(2));
  const sustainable_cpc  = (slot.aov > 0 && slot.cvr > 0 && targetAcos > 0)
    ? parseFloat((slot.aov * slot.cvr * (targetAcos / 100)).toFixed(2)) : 0;

  let acos_status: string;
  if (current_acos <= 0)                       acos_status = 'NO_DATA';
  else if (current_acos <= targetAcos)         acos_status = 'HEALTHY';
  else if (current_acos <= sustainable_acos)   acos_status = 'ABOVE_TARGET_BUT_PROFITABLE';
  else if (current_acos < breakEvenAcos)       acos_status = 'ECONOMIC_WARNING';
  else                                          acos_status = 'CRITICAL_ECONOMIC';

  const is_winner = current_acos > 0 && current_acos <= sustainable_acos
    && slot.orders >= 1 && current_profit > 0;

  return { sustainable_acos, acos_headroom, current_profit, sustainable_cpc,
           acos_status, is_winner, current_acos, targetAcos };
}

// ─── Decisão por slot ────────────────────────────────────────────────────
function decideForSlot(
  kw: any,
  slot: any,
  baseline: any,
  goal: any,
  budgetBlockedCamps: Set<string>,
  breakEvenAcos: number,
  contribMargin: number,
): { decision: string; proposedBid: number; pct: number; requiresApproval: boolean; reason: string; ruleId: string } | null {

  const curBid      = Number(kw.current_bid || kw.bid || 0);
  const targetAcos  = Number(goal.target_acos || 15);
  const maxBid      = Number(goal.max_bid || 2.5);
  const minBid      = Number(goal.min_bid || MIN_BID_GLOBAL);

  // PROFIT-SAFE context para este slot
  const econCtx = buildDpEconCtx(curBid, slot, breakEvenAcos, targetAcos, contribMargin);

  const slotAcos    = Number(slot.acos || 0);
  const slotCvr     = Number(slot.cvr  || 0);
  const slotCpc     = Number(slot.cpc  || 0);
  const slotOrders  = Number(slot.orders || 0);
  const slotClicks  = Number(slot.clicks || 0);
  const slotSpend   = Number(slot.spend || 0);
  const slotAov     = Number(slot.aov || 0);

  const baseCvr     = Number(baseline.cvr  || 0);
  const baseAcos    = Number(baseline.acos || 0);

  const sustnCpc    = sustainableCpc(slotAov, slotCvr, targetAcos);
  const conf        = dataConfidenceLevel(slot.occurrences || 0, slotOrders, slotClicks);
  const dataMature  = (slot.occurrences || 0) >= MIN_OCCURRENCES_MATURE;

  if (!dataMature) return null; // COLLECTING_DATA — sem decisão

  // ── BID_UP ──────────────────────────────────────────────────────────
  const canBidUp = (
    (conf === 'MEDIUM' || conf === 'HIGH' || conf === 'VERY_HIGH') &&
    slotOrders >= MIN_ORDERS_BID_UP &&
    slotClicks >= MIN_CLICKS_BID_UP &&
    slotAcos > 0 && slotAcos <= targetAcos * ACOS_THRESHOLD_BID_UP &&
    baseCvr > 0 && slotCvr >= baseCvr * CVR_ADVANTAGE_BID_UP &&
    (sustnCpc <= 0 || slotCpc <= sustnCpc) &&
    !budgetBlockedCamps.has(kw.campaign_id) &&
    slot.trend_status !== 'DECAYING'
  );

  if (canBidUp) {
    const acosHeadroom = targetAcos / slotAcos - 1;
    const cvrAdvantage = slotCvr / baseCvr - 1;
    let rawUplift = Math.min(acosHeadroom, cvrAdvantage);

    // v3: aplicar bonus de pico vindo do HourlySalesPattern (passado em slot.peak_bonus)
    const peakBonus = Number(slot.peak_bonus || 0);
    rawUplift = Math.min(MAX_BID_UP_AUTO, rawUplift + peakBonus);

    // HARD CAP: máximo +20% por ciclo (PRD)
    const pct = Math.max(MIN_BID_UP, Math.min(MAX_BID_UP_AUTO, rawUplift));
    const rawBid = curBid * (1 + pct);
    const newBid = r2(Math.min(maxBid, rawBid));
    const bidCapApplied = rawBid > maxBid || rawUplift > MAX_BID_UP_AUTO;
    if (newBid <= curBid + 0.01) return null;
    const requiresApproval = pct > MAX_BID_UP_APPROVAL_THRESHOLD;
    const peakLabel = peakBonus > 0 ? ` [PEAK+${(peakBonus * 100).toFixed(0)}%]` : '';
    return {
      decision: 'BID_UP',
      proposedBid: newBid,
      pct: r2(pct * 100),
      requiresApproval,
      bidCapApplied,
      bidFloorApplied: false,
      reason: `Elite slot ${DAY_LABELS[slot.day_of_week]} ${slot.hour}h: ACoS ${slotAcos.toFixed(1)}% vs meta ${targetAcos}%, CVR +${(cvrAdvantage * 100).toFixed(0)}% acima baseline${peakLabel}`,
      ruleId: peakBonus > 0 ? 'DAYPART_BID_UP_PEAK_AGGRESSIVE' : 'DAYPART_BID_UP_WINNER',
    };
  }

  // ── Zero Vendas ───────────────────────────────────────────────────────
  if (slotOrders === 0 && slotClicks > 0) {
    const aov = slotAov > 0 ? slotAov : (goal.avg_aov || 50);
    const targetCpa = aov * (targetAcos / 100);

    if (targetCpa > 0 && slotSpend < 0.75 * targetCpa) {
      return null; // WAIT
    }
    if (targetCpa > 0 && slotSpend >= ZERO_SALES_HARD_MULT * targetCpa && slotClicks >= ZERO_SALES_MIN_CLICKS) {
      // HARD CAP: floor = max(perf.min_bid, current_bid × 0.40)
      const floorBid = Math.max(minBid, curBid * BID_FLOOR_RELATIVE);
      const rawBid = curBid * 0.80;
      const newBid = r2(Math.max(floorBid, rawBid));
      const bidFloorApplied = rawBid < floorBid;
      const actualPct = r2(((newBid - curBid) / curBid) * 100);
      return {
        decision: 'NO_SALES_HARD',
        proposedBid: newBid,
        pct: actualPct,
        requiresApproval: true,
        bidFloorApplied,
        bidCapApplied: false,
        reason: `Zero vendas HARD: ${slotClicks} cliques, R$${slotSpend.toFixed(2)} gasto (${ZERO_SALES_HARD_MULT}× CPA alvo R$${targetCpa.toFixed(2)})${bidFloorApplied ? ' [floor 40% aplicado]' : ''}`,
        ruleId: 'DAYPART_ZERO_SALES_HARD',
      };
    }
    if (targetCpa > 0 && slotSpend >= ZERO_SALES_SOFT_MULT * targetCpa) {
      const floorBid = Math.max(minBid, curBid * BID_FLOOR_RELATIVE);
      const rawBid = curBid * 0.90;
      const newBid = r2(Math.max(floorBid, rawBid));
      const bidFloorApplied = rawBid < floorBid;
      const actualPct = r2(((newBid - curBid) / curBid) * 100);
      return {
        decision: 'NO_SALES_SOFT',
        proposedBid: newBid,
        pct: actualPct,
        requiresApproval: true,
        bidFloorApplied,
        bidCapApplied: false,
        reason: `Zero vendas SOFT: R$${slotSpend.toFixed(2)} gasto, CPA alvo R$${targetCpa.toFixed(2)}${bidFloorApplied ? ' [floor 40% aplicado]' : ''}`,
        ruleId: 'DAYPART_ZERO_SALES_SOFT',
      };
    }
    return null;
  }

  // ── BID_DOWN por ACoS alto ────────────────────────────────────────────
  if (slotAcos > targetAcos && slotOrders > 0 && baseCvr > 0 && slotCvr >= baseCvr * 0.85) {
    // PROFIT-SAFE: bloquear redução em winner sustentável que pioraria lucro
    if (econCtx.is_winner && econCtx.acos_status === 'ABOVE_TARGET_BUT_PROFITABLE') {
      const ratio = curBid > 0 ? (curBid * (1 - MAX_BID_DOWN_ACOS)) / curBid : 1;
      const expectedProfitDelta = econCtx.current_profit * ratio - econCtx.current_profit;
      if (expectedProfitDelta < 0) {
        return null; // BLOCK — WINNER_PROFIT_PROTECTION
      }
    }

    const targetRatio = targetAcos / slotAcos;
    const rawPct = 1 - targetRatio;
    const cappedPct = Math.min(MAX_BID_DOWN_ACOS, rawPct);
    const floorBid = Math.max(minBid, curBid * BID_FLOOR_RELATIVE);
    const rawBid = curBid * (1 - cappedPct);
    const newBid = r2(Math.max(floorBid, rawBid));
    const bidFloorApplied = rawBid < floorBid;
    const actualPct = r2(((newBid - curBid) / curBid) * 100);
    if (newBid >= curBid - 0.01) return null;
    const requiresApproval = Math.abs(actualPct) > 15;
    return {
      decision: 'BID_DOWN_ACOS',
      proposedBid: newBid,
      pct: actualPct,
      requiresApproval,
      bidFloorApplied,
      bidCapApplied: false,
      reason: `ACoS slot ${slotAcos.toFixed(1)}% > meta ${targetAcos}% (sustentável: ${econCtx.sustainable_acos}%). Ratio ${targetRatio.toFixed(2)}${bidFloorApplied ? ' [floor 40%]' : ''}`,
      ruleId: 'DAYPART_BID_DOWN_ACOS',
    };
  }

  // ── BID_DOWN por CVR fraco ────────────────────────────────────────────
  if (baseCvr > 0 && slotCvr < baseCvr * CVR_WEAK_THRESHOLD && slotClicks >= 10) {
    // PROFIT-SAFE: bloquear em winner sustentável
    if (econCtx.is_winner && econCtx.current_profit > 0) {
      return null; // BLOCK — WINNER_PROFIT_PROTECTION (CVR fraco mas ainda lucrativo)
    }

    const cycles = Number(slot.consecutive_down_cycles || 0);
    const redPct = cycles >= 2 ? BID_DOWN_CVR_HARD : BID_DOWN_CVR_SOFT;
    const floorBid = Math.max(minBid, curBid * BID_FLOOR_RELATIVE);
    const rawBid = curBid * (1 - redPct);
    const newBid = r2(Math.max(floorBid, rawBid));
    const bidFloorApplied = rawBid < floorBid;
    const actualPct = r2(((newBid - curBid) / curBid) * 100);
    if (newBid >= curBid - 0.01) return null;
    const requiresApproval = Math.abs(actualPct) > 15;
    return {
      decision: 'BID_DOWN_CVR',
      proposedBid: newBid,
      pct: actualPct,
      requiresApproval,
      bidFloorApplied,
      bidCapApplied: false,
      reason: `CVR slot ${(slotCvr * 100).toFixed(1)}% vs baseline ${(baseCvr * 100).toFixed(1)}% (< ${(CVR_WEAK_THRESHOLD * 100).toFixed(0)}%)${bidFloorApplied ? ' [floor 40%]' : ''}`,
      ruleId: 'DAYPART_BID_DOWN_CVR',
    };
  }

  return null;
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body   = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false, asin_filter } = body;

    // Resolver conta
    let account: any;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
      account = accs[0];
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({}, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta configurada' }, { status: 404 });

    const accountId = account.id;
    const now   = new Date().toISOString();
    const today = now.slice(0, 10);
    const cutoff14d = daysAgo(14);
    const cutoff28d = daysAgo(28);
    const cutoff60d = daysAgo(60);

    // Carregar configurações
    const [perfList, economicsList] = await Promise.all([
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, null, 1).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: accountId }, null, 500).catch(() => []),
    ]);
    const perf = perfList[0] || {};
    const avgBreakEven = economicsList.length > 0
      ? economicsList.reduce((s: number, e: any) => s + Number(e.break_even_acos || 30), 0) / economicsList.length
      : 30;
    const goal = {
      target_acos:  Number(perf.target_acos  || 15),
      max_bid:      Number(perf.max_bid      || 2.5),
      min_bid:      Number(perf.min_bid      || 0.25),
      avg_aov: (() => {
        if (!economicsList.length) return 50;
        const total = economicsList.reduce((s: number, e: any) => s + Number(e.current_price || e.average_sale_price || 0), 0);
        return total / economicsList.length;
      })(),
    };

    // Mapas econômicos por ASIN (break_even e contribution_margin)
    const dpBreakEvenMap = new Map<string, number>();
    const dpMarginMap    = new Map<string, number>();
    for (const e of economicsList) {
      if (e.asin) {
        dpBreakEvenMap.set(e.asin, Number(e.break_even_acos || 30));
        const m = Number(e.contribution_margin || e.profit_margin_pct || 0);
        dpMarginMap.set(e.asin, m > 1 ? m / 100 : m);
      }
    }

    // Carregar keywords ativas
    const kwFilter: any = { amazon_account_id: accountId };
    if (asin_filter) kwFilter.asin = asin_filter;
    const allKeywords = await base44.asServiceRole.entities.Keyword.filter(kwFilter, '-spend', 1000).catch(() => []);
    const activeKws = allKeywords.filter((k: any) => {
      const s = (k.state || k.status || '').toLowerCase();
      return s === 'enabled' || s === 'active';
    });

    // Carregar campanhas para verificar budget
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: accountId }, null, 500
    ).catch(() => []);
    const budgetBlockedCamps = new Set<string>(
      allCampaigns
        .filter((c: any) => {
          const spend  = Number(c.spend || c.current_spend || 0);
          const budget = Number(c.daily_budget || 0);
          return budget > 0 && spend / budget >= 0.90;
        })
        .map((c: any) => c.campaign_id)
    );

    // Carregar padrões aprendidos de pico (HourlySalesPattern)
    const peakPatterns = await base44.asServiceRole.entities.HourlySalesPattern.filter(
      { amazon_account_id: accountId }, null, 200
    ).catch(() => []);
    // Mapa: `${day_of_week}|${hour}` → { peak_bonus, classification, bid_multiplier }
    const peakMap = new Map<string, any>();
    for (const p of peakPatterns) {
      const bonus = p.classification === 'PEAK_ELITE'  ? PEAK_ELITE_BID_BONUS
                  : p.classification === 'PEAK_STRONG' ? PEAK_STRONG_BID_BONUS
                  : 0;
      peakMap.set(`${p.day_of_week}|${p.hour}`, {
        peak_bonus: bonus,
        classification: p.classification,
        bid_multiplier: p.bid_multiplier || 1.0,
        peak_score: p.peak_score || 0,
      });
    }

    // Carregar métricas horárias
    const hourlyMetrics = await base44.asServiceRole.entities.HourlyMetric.filter(
      { amazon_account_id: accountId }, '-date', 2000
    ).catch(() => []);

    // Agrupar métricas por keyword_id + day_of_week + hour
    // Chave: `${keyword_id}|${day}|${hour}`
    const slotMap = new Map<string, any>();

    for (const m of hourlyMetrics) {
      if (!m.keyword_id) continue;
      const mDate = new Date(m.date || m.created_date);
      if (isNaN(mDate.getTime())) continue;
      const day  = mDate.getDay(); // 0=Dom
      const hour = m.hour ?? mDate.getHours();
      const key  = `${m.keyword_id}|${day}|${hour}`;

      const isRecent   = (m.date || m.created_date) >= cutoff14d;
      const isBaseline = (m.date || m.created_date) >= cutoff28d;

      if (!slotMap.has(key)) {
        slotMap.set(key, {
          keyword_id: m.keyword_id,
          campaign_id: m.campaign_id,
          asin: m.asin,
          day_of_week: day,
          hour,
          occurrences: 0,
          impressions: 0, clicks: 0, spend: 0, orders: 0, sales: 0,
          impressions_14d: 0, clicks_14d: 0, spend_14d: 0, orders_14d: 0, sales_14d: 0,
        });
      }
      const slot = slotMap.get(key);
      slot.occurrences++;
      if (isBaseline) {
        slot.impressions += Number(m.impressions || 0);
        slot.clicks      += Number(m.clicks || 0);
        slot.spend       += Number(m.spend || 0);
        slot.orders      += Number(m.orders || m.conversions || 0);
        slot.sales       += Number(m.sales || m.revenue || 0);
      }
      if (isRecent) {
        slot.impressions_14d += Number(m.impressions || 0);
        slot.clicks_14d      += Number(m.clicks || 0);
        slot.spend_14d       += Number(m.spend || 0);
        slot.orders_14d      += Number(m.orders || m.conversions || 0);
        slot.sales_14d       += Number(m.sales || m.revenue || 0);
      }
    }

    // Calcular métricas derivadas por slot
    for (const [, slot] of slotMap) {
      slot.ctr  = slot.clicks > 0 ? slot.clicks / Math.max(slot.impressions, 1) : 0;
      slot.cvr  = slot.clicks > 0 ? slot.orders / slot.clicks : 0;
      slot.cpc  = slot.clicks > 0 ? slot.spend / slot.clicks : 0;
      slot.acos = slot.sales  > 0 ? (slot.spend / slot.sales) * 100 : 0;
      slot.roas = slot.spend  > 0 ? slot.sales / slot.spend : 0;
      slot.aov  = slot.orders > 0 ? slot.sales / slot.orders : 0;
      slot.cpa  = slot.orders > 0 ? slot.spend / slot.orders : 0;

      // Trend (14d vs 28d)
      const cvr14d  = slot.clicks_14d  > 0 ? slot.orders_14d / slot.clicks_14d : 0;
      const acos14d = slot.sales_14d   > 0 ? (slot.spend_14d / slot.sales_14d) * 100 : 0;
      slot.cvr_14d  = cvr14d;
      slot.acos_14d = acos14d;

      // Trend status
      if (slot.cvr > 0) {
        const cvrDelta  = (cvr14d - slot.cvr)  / Math.max(slot.cvr, 0.0001);
        const acosDelta = slot.acos > 0 ? (acos14d - slot.acos) / Math.max(slot.acos, 0.0001) : 0;
        if (cvrDelta >= TREND_IMPROVE_THRESHOLD && acosDelta <= 0) slot.trend_status = 'IMPROVING';
        else if (cvrDelta <= -TREND_DECAY_THRESHOLD || acosDelta >= TREND_DECAY_THRESHOLD) slot.trend_status = 'DECAYING';
        else slot.trend_status = 'STABLE';
      } else {
        slot.trend_status = 'UNKNOWN';
      }
    }

    // Calcular baseline por keyword (28d)
    const kwBaselineMap = new Map<string, any>();
    for (const [, slot] of slotMap) {
      const kwId = slot.keyword_id;
      if (!kwBaselineMap.has(kwId)) {
        kwBaselineMap.set(kwId, { clicks: 0, orders: 0, spend: 0, sales: 0, impressions: 0 });
      }
      const b = kwBaselineMap.get(kwId);
      b.clicks      += slot.clicks;
      b.orders      += slot.orders;
      b.spend       += slot.spend;
      b.sales       += slot.sales;
      b.impressions += slot.impressions;
    }
    for (const [kwId, b] of kwBaselineMap) {
      b.cvr  = b.clicks  > 0 ? b.orders / b.clicks : 0;
      b.acos = b.sales   > 0 ? (b.spend / b.sales) * 100 : 0;
      b.cpc  = b.clicks  > 0 ? b.spend / b.clicks : 0;
      b.roas = b.spend   > 0 ? b.sales / b.spend : 0;
      b.cpa  = b.orders  > 0 ? b.spend / b.orders : 0;
      kwBaselineMap.set(kwId, b);
    }

    // Gerar decisões
    const decisions: any[] = [];
    const kwMap = new Map<string, any>();
    for (const kw of activeKws) {
      kwMap.set(kw.keyword_id, kw);
    }

    for (const [slotKey, slot] of slotMap) {
      const kw = kwMap.get(slot.keyword_id);
      if (!kw) continue;
      if (asin_filter && kw.asin !== asin_filter) continue;

      const baseline = kwBaselineMap.get(slot.keyword_id) || { cvr: 0, acos: 0, cpc: 0, roas: 0, cpa: 0 };
      const score    = calcTimeSlotScore(slot, baseline, goal.target_acos);
      const classif  = slot.occurrences >= MIN_OCCURRENCES_MATURE ? classifySlot(score) : 'COLLECTING_DATA';

      // v3: enriquecer slot com bonus de pico aprendido
      const peakInfo = peakMap.get(`${slot.day_of_week}|${slot.hour}`);
      slot.peak_bonus          = peakInfo?.peak_bonus || 0;
      slot.learned_peak_class  = peakInfo?.classification || 'INSUFFICIENT_DATA';
      slot.learned_peak_score  = peakInfo?.peak_score || 0;

      // Contexto econômico por ASIN para PROFIT-SAFE
      const kwAsin     = slot.asin || kw.asin;
      const kwBreakEven = kwAsin ? (dpBreakEvenMap.get(kwAsin) || avgBreakEven) : avgBreakEven;
      const kwMargin    = kwAsin && dpMarginMap.has(kwAsin) ? dpMarginMap.get(kwAsin)! : (kwBreakEven / 100);

      const decisionData = slot.occurrences >= MIN_OCCURRENCES_MATURE
        ? decideForSlot(kw, slot, baseline, goal, budgetBlockedCamps, kwBreakEven, kwMargin)
        : null;

      if (!decisionData && classif !== 'COLLECTING_DATA') continue; // MAINTAIN — sem decisão necessária
      if (!decisionData && classif === 'COLLECTING_DATA') continue;

      const sustnCpc = sustainableCpc(slot.aov, slot.cvr, goal.target_acos);
      const conf     = dataConfidenceLevel(slot.occurrences, slot.orders, slot.clicks);
      const idempKey = `daypart:${accountId}:${slot.keyword_id}:${slot.day_of_week}:${slot.hour}:${today}`;
      const slotLabel = `${DAY_LABELS[slot.day_of_week]}_${slot.hour}h`;

      // Gate: se abs(bid_change_pct) > 15, força requires_approval=true (PRD)
      const finalRequiresApproval = decisionData!.requiresApproval || Math.abs(decisionData!.pct) > 15;

      decisions.push({
        amazon_account_id: accountId,
        campaign_id: slot.campaign_id || kw.campaign_id,
        keyword_id: slot.keyword_id,
        asin: slot.asin || kw.asin,
        keyword_text: kw.keyword_text,
        match_type: kw.match_type,
        day_of_week: slot.day_of_week,
        hour: slot.hour,
        slot_label: slotLabel,
        time_slot_score: score,
        slot_classification: classif,
        decision_type: decisionData!.decision,
        rule_id: decisionData!.ruleId,
        rule_version: RULE_VERSION,
        current_bid: Number(kw.current_bid || kw.bid || 0),
        proposed_bid: decisionData!.proposedBid,
        bid_change_pct: decisionData!.pct,
        bid_floor_applied: (decisionData as any).bidFloorApplied || false,
        bid_cap_applied: (decisionData as any).bidCapApplied || false,
        recency_protection_blocked: false,
        metric_window: '28D',
        decision_window: '14D',
        requires_approval: finalRequiresApproval,
        status: 'pending_approval',
        slot_acos: r2(slot.acos),
        slot_cvr: r2(slot.cvr),
        slot_cpc: r2(slot.cpc),
        slot_ctr: r2(slot.ctr),
        slot_orders: slot.orders,
        slot_clicks: slot.clicks,
        slot_spend: r2(slot.spend),
        slot_sales: r2(slot.sales),
        slot_impressions: slot.impressions,
        slot_roas: r2(slot.roas),
        slot_aov: r2(slot.aov),
        slot_cpa: r2(slot.cpa),
        baseline_cvr: r2(baseline.cvr),
        baseline_acos: r2(baseline.acos),
        baseline_cpc: r2(baseline.cpc),
        baseline_roas: r2(baseline.roas),
        baseline_cpa: r2(baseline.cpa),
        target_acos: goal.target_acos,
        sustainable_cpc: r2(sustnCpc),
        data_confidence: conf,
        data_mature: slot.occurrences >= MIN_OCCURRENCES_MATURE,
        occurrences: slot.occurrences,
        recent_acos_14d: r2(slot.acos_14d || 0),
        recent_cvr_14d: r2(slot.cvr_14d || 0),
        trend_status: slot.trend_status || 'UNKNOWN',
        reason: decisionData!.reason,
        idempotency_key: idempKey,
        expires_at: new Date(Date.now() + DECISION_EXPIRY_DAYS * 86400000).toISOString(),
        cycle_date: today,
        created_at: now,
      });
    }

    // Dedup por idempotency_key (não criar duplicata do mesmo slot no mesmo dia)
    if (!dry_run && decisions.length > 0) {
      const existingKeys = await base44.asServiceRole.entities.DaypartingDecision.filter(
        { amazon_account_id: accountId, cycle_date: today }, null, 500
      ).catch(() => []);
      const existingKeySet = new Set(existingKeys.map((d: any) => d.idempotency_key));
      const newDecisions = decisions.filter((d: any) => !existingKeySet.has(d.idempotency_key));

      if (newDecisions.length > 0) {
        for (let i = 0; i < newDecisions.length; i += 50) {
          await base44.asServiceRole.entities.DaypartingDecision.bulkCreate(newDecisions.slice(i, i + 50)).catch(() => {});
        }
      }
      return Response.json({
        ok: true, dry_run: false, cycle_date: today,
        pipeline_version: PIPELINE_VERSION,
        keywords_analyzed: activeKws.length,
        slots_analyzed: slotMap.size,
        decisions_generated: newDecisions.length,
        decisions_skipped_dedup: decisions.length - newDecisions.length,
        bid_up: newDecisions.filter((d: any) => d.decision_type === 'BID_UP').length,
        bid_down: newDecisions.filter((d: any) => d.decision_type.startsWith('BID_DOWN')).length,
        no_sales: newDecisions.filter((d: any) => d.decision_type.startsWith('NO_SALES')).length,
        duration_ms: Date.now() - t0,
      });
    }

    // DRY RUN
    const byType: Record<string, number> = {};
    for (const d of decisions) { byType[d.decision_type] = (byType[d.decision_type] || 0) + 1; }

    return Response.json({
      ok: true, dry_run: true, cycle_date: today,
      pipeline_version: PIPELINE_VERSION,
      keywords_analyzed: activeKws.length,
      slots_analyzed: slotMap.size,
      hourly_records_loaded: hourlyMetrics.length,
      decisions_generated: decisions.length,
      by_type: byType,
      sample: decisions.slice(0, 10).map(({ amazon_account_id: _, ...d }) => d),
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});