import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { productAdsEligibility } from '../../shared/productAdsEligibility.ts';
import { canonicalAccountSalesByDate } from '../../shared/salesDailyIntegrity.ts';

const SOURCE = 'runIntradaySalesRecovery';
const MIN_BID = 0.25;
const MAX_BID_STEP = 0.08;
const MAX_BUDGET_STEP = 0.10;
const MAX_ACTIONS = 10;
const FRESHNESS_MINUTES = 45;

const n = (v: unknown, f = 0) => Number.isFinite(Number(v)) ? Number(v) : f;
const s = (v: unknown) => String(v || '').trim();
const low = (v: unknown) => s(v).toLowerCase();
const upper = (v: unknown) => s(v).toUpperCase();
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const active = (row: any) => ['enabled', 'active'].includes(low(row?.state || row?.status));
const campaignId = (row: any) => s(row?.amazon_campaign_id || row?.campaign_id || row?.id);
const todayBrt = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const hourBrt = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(new Date())) % 24;
const minuteBrt = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', minute: '2-digit' }).format(new Date()));
const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
const confidence01 = (value: unknown) => {
  const raw = n(value, 0);
  return raw > 1 ? raw / 100 : raw;
};

function minimumMarginRate(settings: any): number {
  const raw = n(settings?.minimum_net_margin_pct ?? settings?.minimum_margin_pct ?? 15, 15);
  // Margin protection is never relaxed below the operational minimum of 15%.
  return clamp(raw > 1 ? raw / 100 : raw, 0.15, 0.80);
}

function maximumAdsSpendPerOrder(economics: any, product: any, minMarginRate: number): number {
  const price = n(economics?.current_price ?? economics?.average_sale_price ?? product?.amazon_price ?? product?.price);
  const contributionBeforeAds = n(economics?.contribution_margin_amount ?? economics?.profit_before_ads);
  // contributionBeforeAds already includes product, FBA and referral costs.
  if (price > 0 && contributionBeforeAds > 0) return Math.max(0, contributionBeforeAds - price * minMarginRate);
  return Math.max(0, n(product?.maximum_ad_spend_per_order ?? economics?.maximum_profitable_ad_spend));
}

function median(values: number[]) {
  const sorted = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function freshWithin(value: unknown, minutes: number) {
  const timestamp = new Date(String(value || '')).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp <= minutes * 60000;
}

function targetMer(settings: any) {
  const raw = n(settings?.target_mer_pct || settings?.target_tacos || settings?.tacos_target, 5);
  return clamp(raw > 1 ? raw / 100 : raw, 0.01, 0.40);
}

function dedupeCampaigns(rows: any[]) {
  const map = new Map<string, any>();
  for (const row of rows) {
    const id = campaignId(row);
    if (!id) continue;
    const prev = map.get(id);
    const ts = new Date(String(row.updated_at || row.updated_date || row.created_at || 0)).getTime();
    const prevTs = new Date(String(prev?.updated_at || prev?.updated_date || prev?.created_at || 0)).getTime();
    if (!prev || ts >= prevTs) map.set(id, row);
  }
  return [...map.values()];
}

function latestByCampaign(rows: any[]) {
  const map = new Map<string, any>();
  for (const row of [...rows].sort((a, b) => new Date(String(b.observed_at || b.updated_at || b.created_at || 0)).getTime() - new Date(String(a.observed_at || a.updated_at || a.created_at || 0)).getTime())) {
    const id = s(row.campaign_id || row.amazon_campaign_id);
    if (id && !map.has(id)) map.set(id, row);
  }
  return map;
}

function asinForCampaign(campaign: any, productAds: any[]) {
  const direct = upper(campaign?.asin || campaign?.advertised_asin);
  if (direct) return direct;
  const id = campaignId(campaign);
  return upper(productAds.find((row: any) => s(row?.campaign_id || row?.amazon_campaign_id) === id)?.asin);
}

Deno.serve(async (request) => {
  const started = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    if (body._canonical_orchestrator !== 'runUnifiedDecisionEngine') return Response.json({ ok: false, error: 'Uso exclusivo pelo motor canônico' }, { status: 403 });

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 20);
    const reports: any[] = [];

    for (const account of accounts) {
      const aid = String(account.id);
      const today = todayBrt();
      const hour = hourBrt();
      const cutoff14 = daysAgo(14);
      const [settingsRows, products, economics, campaignRows, productAds, keywords, dailyMetrics, intradayRows, salesRows, priorDecisions] = await Promise.all([
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.ProductAd.filter({ amazon_account_id: aid }, '-updated_at', 10000).catch(() => []),
        base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-updated_at', 20000).catch(() => []),
        base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 15000).catch(() => []),
        base44.asServiceRole.entities.IntradaySpendSnapshot.filter({ amazon_account_id: aid, spend_date: today }, '-observed_at', 10000).catch(() => []),
        base44.asServiceRole.entities.SalesDaily.filter({ amazon_account_id: aid }, '-date', 10000).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: aid }, '-created_at', 10000).catch(() => []),
      ]);

      const settings = settingsRows[0] || {};
      const targetAcos = Math.max(1, n(settings.target_acos || settings.acos_target, 15));
      const merTarget = targetMer(settings);
      const minCampaignBudget = Math.max(5, n(settings.minimum_campaign_budget, 5));
      const maxCampaignBudget = Math.max(minCampaignBudget, n(settings.maximum_campaign_budget, 100));
      const maxBid = Math.max(MIN_BID, n(settings.max_bid, 3));
      const minMarginRate = minimumMarginRate(settings);
      const productByAsin = new Map(products.filter((p: any) => p.asin).map((p: any) => [upper(p.asin), p]));
      const econByAsin = new Map(economics.filter((e: any) => e.asin).map((e: any) => [upper(e.asin), e]));
      const latest = latestByCampaign(intradayRows);
      const newestIntradayAt = intradayRows.reduce((latestAt: number, row: any) => Math.max(latestAt, new Date(String(row.observed_at || row.updated_at || row.created_at || 0)).getTime()), 0);
      const intradayDataFresh = newestIntradayAt > 0 && Date.now() - newestIntradayAt <= FRESHNESS_MINUTES * 60000;

      // Mesma fonte de verdade do Dashboard: nunca somar account_total + product rollup e nunca ignorar gross_revenue.
      const canonicalSales = canonicalAccountSalesByDate(salesRows);
      const todaySales = canonicalSales.get(today);
      const revenueToday = n(todaySales?.revenue, 0);
      const closedRevenue = [...canonicalSales.entries()]
        .filter(([date]) => date >= cutoff14 && date < today)
        .map(([, row]) => n(row.revenue))
        .filter((value) => value > 0);
      const baselineRevenue = median(closedRevenue);
      const elapsedFraction = clamp((hour + minuteBrt() / 60) / 24, 0, 1);
      const expectedFloor = baselineRevenue * elapsedFraction * 0.60;
      const revenueRatio = expectedFloor > 0 ? revenueToday / expectedFloor : 1;

      const campaigns = dedupeCampaigns(campaignRows).filter((row: any) => active(row) && upper(row.campaign_type || 'SP') === 'SP');
      const todayByCampaign = new Map<string, { spend: number; sales: number; orders: number; clicks: number }>();
      let spendToday = 0;
      for (const campaign of campaigns) {
        const id = campaignId(campaign);
        const snap = latest.get(id) || campaign;
        const m = {
          spend: n(snap.spend ?? snap.cost ?? campaign.current_spend ?? campaign.spend),
          sales: n(snap.sales ?? snap.attributed_sales ?? campaign.sales),
          orders: n(snap.orders ?? snap.purchases ?? campaign.orders),
          clicks: n(snap.clicks ?? campaign.clicks),
        };
        todayByCampaign.set(id, m);
        spendToday += m.spend;
      }

      const tacos = revenueToday > 0 ? spendToday / revenueToday : null;
      // The 06:04 unified lifecycle restores eligible coverage for the new
      // day. From 07:00 onward, use fresh intraday evidence to diagnose weak
      // morning delivery rather than waiting until 10:00 to cut waste or
      // recover economically safe campaigns.
      const recoveryActive = intradayDataFresh && hour >= 7 && hour <= 21 && baselineRevenue > 0 && expectedFloor > 0 && revenueToday < expectedFloor && spendToday > 0;
      const growthAllowed = recoveryActive && tacos !== null && tacos <= Math.max(0.20, merTarget * 4);

      const histByCampaign = new Map<string, { spend: number; sales: number; orders: number; clicks: number }>();
      for (const row of dailyMetrics) {
        const date = s(row.date).slice(0, 10);
        if (!date || date < cutoff14 || date >= today) continue;
        const id = s(row.campaign_id || row.amazon_campaign_id);
        if (!id) continue;
        const agg = histByCampaign.get(id) || { spend: 0, sales: 0, orders: 0, clicks: 0 };
        agg.spend += n(row.spend); agg.sales += n(row.sales); agg.orders += n(row.orders); agg.clicks += n(row.clicks);
        histByCampaign.set(id, agg);
      }

      const activeKeys = new Set(priorDecisions
        .filter((d: any) => !['failed', 'failed_final', 'cancelled', 'expired', 'rejected', 'skipped', 'superseded'].includes(low(d.status)))
        .map((d: any) => s(d.idempotency_key)));
      const hourKey = `${today}T${String(hour).padStart(2, '0')}`;
      const losers: any[] = [];
      const winners: any[] = [];

      for (const campaign of campaigns) {
        const id = campaignId(campaign);
        const asin = asinForCampaign(campaign, productAds);
        const product = productByAsin.get(asin);
        const eligibility = productAdsEligibility(product);
        if (!id || !asin || !eligibility.eligible) continue;
        const econ = econByAsin.get(asin) || {};
        const economicConfidence = confidence01(econ.final_economic_confidence ?? econ.economic_data_confidence ?? econ.confidence);
        const spApiDataFresh = freshWithin(product?.last_confirmed_at || product?.last_synced_at || product?.updated_at, 24 * 60);
        const economicsDataFresh = freshWithin(econ?.calculated_at || econ?.updated_at || econ?.created_at, 24 * 60);
        const todayM = todayByCampaign.get(id) || { spend: 0, sales: 0, orders: 0, clicks: 0 };
        const hist = histByCampaign.get(id) || { spend: 0, sales: 0, orders: 0, clicks: 0 };
        const histAcos = hist.sales > 0 ? hist.spend / hist.sales * 100 : null;
        const todayAcos = todayM.sales > 0 ? todayM.spend / todayM.sales * 100 : null;
        const breakEvenAcos = Math.max(0, n(econ.break_even_acos ?? product?.break_even_acos_pct));
        const safeAcos = breakEvenAcos > 0 ? Math.min(targetAcos, breakEvenAcos * 0.75) : targetAcos;
        const profitAfterAds = n(econ.profit_after_ads ?? product?.profit_after_ads, 0);
        const budget = n(campaign.daily_budget || campaign.budget, 0);
        const maximumAdsPerOrder = maximumAdsSpendPerOrder(econ, product, minMarginRate);
        const admission = {
          product_state: 'ACTIVE',
          listing_status: String(product?.listing_status || product?.status || 'active'),
          offer_status: String(product?.offer_status || product?.status || 'active'),
          buyable: product?.listing_buyable !== false,
          inventory_available: eligibility.stock,
          stock_coverage_days: product?.stock_coverage_days ?? product?.inventory_coverage_days ?? null,
          sp_api_data_fresh: spApiDataFresh,
          economics_data_fresh: economicsDataFresh,
          economics_complete: maximumAdsPerOrder > 0 && n(econ.safe_max_cpc ?? econ.maximum_economic_cpc) > 0,
          economic_confidence: economicConfidence,
          safe_max_cpc: n(econ.safe_max_cpc ?? econ.maximum_economic_cpc),
          target_acos: safeAcos,
          current_acos: todayAcos,
          profit_after_ads: profitAfterAds,
          same_sku_orders: todayM.orders,
          winner_protected: false,
        };
        const adsSpendPerOrder = todayM.orders > 0 ? todayM.spend / todayM.orders : todayM.spend;
        const drySpend = todayM.orders === 0 && todayM.spend >= Math.max(2.5, maximumAdsPerOrder || 5);
        const marginCapBreached = maximumAdsPerOrder > 0 && adsSpendPerOrder > maximumAdsPerOrder * 1.02;
        const inefficientToday = todayAcos !== null && todayAcos > Math.max(safeAcos * 1.5, safeAcos + 5);

        if (drySpend || marginCapBreached || inefficientToday) {
          losers.push({ campaign, id, asin, todayM, todayAcos, safeAcos, budget, product, econ, economicConfidence, admission, maximumAdsPerOrder, adsSpendPerOrder, marginCapBreached });
          continue;
        }
        const historicalWinner = hist.orders >= 2 && hist.sales > hist.spend && histAcos !== null && histAcos <= safeAcos && profitAfterAds > 0;
        const todayWinner = todayM.orders >= 1 && todayM.sales > todayM.spend && todayAcos !== null && todayAcos <= safeAcos * 1.20 && profitAfterAds > 0;
        if (historicalWinner || todayWinner) winners.push({ campaign, id, asin, todayM, hist, histAcos, todayAcos, safeAcos, budget, product, econ, economicConfidence, admission: { ...admission, winner_protected: true }, todayWinner });
      }

      losers.sort((a, b) => (b.todayM.spend - b.todayM.sales) - (a.todayM.spend - a.todayM.sales));
      winners.sort((a, b) => Number(b.todayWinner) - Number(a.todayWinner) || b.hist.orders - a.hist.orders || (a.histAcos ?? 999) - (b.histAcos ?? 999));

      const queued: any[] = [];
      let freedBudget = 0;
      const createDecision = async (data: any) => {
        const { admission = {}, ...decisionData } = data;
        let evidence: any = {};
        try { evidence = JSON.parse(String(decisionData.data_used || '{}')); } catch { evidence = {}; }
        const rollbackPlan = decisionData.rollback_plan || JSON.stringify({
          action: String(decisionData.action || '').includes('budget') ? 'set_budget' : 'set_bid',
          value: decisionData.value_before ?? decisionData.current_value ?? null,
        });
        return base44.asServiceRole.entities.OptimizationDecision.create({
          ...decisionData,
          amazon_account_id: aid,
          decision_type: 'intraday_sales_recovery',
          status: 'approved', queue_status: 'pending', priority_class: 'P1', execution_mode: 'EXECUTE_NOW',
          execute_before: new Date(Date.now() + FRESHNESS_MINUTES * 60000).toISOString(),
          requires_fresh_data: true, maximum_data_age_minutes: FRESHNESS_MINUTES,
          confirmation_required: true, confirmation_status: 'pending',
          requires_approval: false, approval_status: 'auto_approved_deterministic',
          data_scope_validated: true, data_scope_status: 'VALID', data_window_end: today,
          rollback_plan: rollbackPlan,
          data_used: JSON.stringify({
            ...evidence,
            admission: {
              verified: true,
              observed_at: new Date(newestIntradayAt).toISOString(),
              data_fresh: intradayDataFresh,
              ads_data_fresh: intradayDataFresh,
              sp_api_data_fresh: admission.sp_api_data_fresh === true,
              economics_data_fresh: admission.economics_data_fresh === true,
              economics_complete: admission.economics_complete === true,
              ...admission,
            },
          }),
          source_function: SOURCE, model_version: 'sales-recovery-v1.2-admission-evidence',
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });
      };

      if (recoveryActive && body.dry_run !== true) {
        for (const loser of losers.slice(0, 5)) {
          if (queued.length >= MAX_ACTIONS) break;
          // Protection can use 60% economic confidence, but only when the
          // same run confirmed inventory, listing and economic inputs.
          if (loser.economicConfidence < 0.60 || !loser.admission.sp_api_data_fresh || !loser.admission.economics_data_fresh || !loser.admission.economics_complete) continue;
          // Margin breach is the fastest protection: lower the responsible
          // keyword bids in the same 15-minute cycle before reducing budget.
          if (loser.marginCapBreached) {
            const bidFactor = clamp(loser.maximumAdsPerOrder / Math.max(loser.adsSpendPerOrder, 0.01), 0.45, 0.75);
            const loserKeywords = keywords
              .filter((kw: any) => active(kw) && s(kw.campaign_id || kw.amazon_campaign_id) === loser.id)
              .sort((a: any, b: any) => n(b.spend) - n(a.spend))
              .slice(0, 3);
            for (const kw of loserKeywords) {
              if (queued.length >= MAX_ACTIONS) break;
              const keywordId = s(kw.keyword_id || kw.id);
              const currentBid = n(kw.current_bid ?? kw.bid);
              const nextBid = r2(Math.max(MIN_BID, Math.min(maxBid, currentBid * bidFactor, n(loser.econ.safe_max_cpc, maxBid))));
              const key = `MARGIN_CAP|${aid}|${keywordId}|${hourKey}|${nextBid.toFixed(2)}`;
              if (!keywordId || currentBid <= 0 || nextBid >= currentBid - 0.009 || activeKeys.has(key)) continue;
              const decision = await createDecision({
                admission: loser.admission,
                entity_type: 'keyword', entity_id: keywordId, keyword_id: keywordId,
                keyword_text: kw.keyword_text || kw.keyword || null, campaign_id: loser.id,
                campaign_name: loser.campaign.name || loser.campaign.campaign_name || null,
                ad_group_id: kw.ad_group_id || null, asin: loser.asin, sku: loser.product?.sku || null,
                action: 'reduce_bid', canonical_action_type: 'KEYWORD_BID_CHANGE',
                rationale: `MARGEM: Ads por pedido R$ ${loser.adsSpendPerOrder.toFixed(2)} excede o teto R$ ${loser.maximumAdsPerOrder.toFixed(2)} para preservar ${(minMarginRate * 100).toFixed(0)}% de margem líquida. Bid reduzido antes do orçamento.`,
                rule_key: 'INTRADAY_MARGIN_CAP_REDUCE_BID', reason_code: 'INTRADAY_MARGIN_CAP_REDUCE_BID',
                value_before: currentBid, value_after: nextBid, current_value: currentBid, proposed_value: nextBid,
                target_acos: loser.safeAcos, confidence: 0.97, risk: 'low',
                idempotency_key: key, conflict_group: `${aid}|keyword|${keywordId}`,
                data_used: JSON.stringify({ ads_spend_per_order: loser.adsSpendPerOrder, maximum_ads_spend_per_order: loser.maximumAdsPerOrder, min_margin_pct: minMarginRate * 100, today_orders: loser.todayM.orders, today_spend: loser.todayM.spend }),
              });
              queued.push({ decision_id: decision.id, action: 'reduce_bid', campaign_id: loser.id, keyword_id: keywordId, asin: loser.asin, before: currentBid, after: nextBid });
            }
          }
          if (loser.budget <= minCampaignBudget) continue;
          const pct = loser.marginCapBreached ? 0.40 : loser.todayM.spend >= 10 ? 0.20 : 0.15;
          const nextBudget = r2(Math.max(minCampaignBudget, loser.budget * (1 - pct)));
          if (nextBudget >= loser.budget - 0.01) continue;
          const key = `SALES_RECOVERY|${aid}|${loser.id}|REDUCE_BUDGET|${hourKey}|${nextBudget.toFixed(2)}`;
          if (activeKeys.has(key)) continue;
          const decision = await createDecision({
            admission: loser.admission,
            entity_type: 'campaign', entity_id: loser.id, campaign_id: loser.id,
            campaign_name: loser.campaign.name || loser.campaign.campaign_name || null,
            asin: loser.asin, sku: loser.product?.sku || null,
            action: 'reduce_budget', canonical_action_type: 'CAMPAIGN_BUDGET_CHANGE',
            rationale: loser.marginCapBreached
              ? `MARGEM: Ads por pedido R$ ${loser.adsSpendPerOrder.toFixed(2)} acima do teto R$ ${loser.maximumAdsPerOrder.toFixed(2)}; budget reduzido após bids.`
              : `RECOVERY: campanha improdutiva cede budget. Hoje gasto R$ ${loser.todayM.spend.toFixed(2)}, pedidos ${loser.todayM.orders}, vendas R$ ${loser.todayM.sales.toFixed(2)}.`,
            rule_key: 'INTRADAY_SALES_RECOVERY_REALLOCATE_FROM_LOSER', reason_code: 'INTRADAY_SALES_RECOVERY_REALLOCATE_FROM_LOSER',
            value_before: loser.budget, value_after: nextBudget, confidence: 0.93, risk: 'medium',
            idempotency_key: key, conflict_group: `${aid}|campaign|${loser.id}`,
            data_used: JSON.stringify({ revenue_today: revenueToday, sales_source: todaySales?.source || null, expected_floor: expectedFloor, tacos, campaign_spend: loser.todayM.spend, campaign_orders: loser.todayM.orders, ads_spend_per_order: loser.adsSpendPerOrder, maximum_ads_spend_per_order: loser.maximumAdsPerOrder }),
          });
          freedBudget += loser.budget - nextBudget;
          queued.push({ decision_id: decision.id, action: 'reduce_budget', campaign_id: loser.id, asin: loser.asin, before: loser.budget, after: nextBudget });
        }

        if (growthAllowed && freedBudget > 0) {
          for (const winner of winners.slice(0, 5)) {
            if (queued.length >= MAX_ACTIONS) break;
            // Expansion remains stricter than protection: it needs a mature
            // economic packet so it will pass the executor without relying on
            // a later optimistic interpretation of the data.
            if (winner.economicConfidence < 0.90 || !winner.admission.sp_api_data_fresh || !winner.admission.economics_data_fresh || !winner.admission.economics_complete) continue;
            const kw = keywords.filter((k: any) => active(k) && s(k.campaign_id || k.amazon_campaign_id) === winner.id)
              .filter((k: any) => {
                const orders = n(k.orders ?? k.purchases), sales = n(k.sales), spend = n(k.spend);
                const acos = sales > 0 ? spend / sales * 100 : null;
                return orders >= 1 && sales > spend && (acos === null || acos <= winner.safeAcos);
              }).sort((a: any, b: any) => n(b.orders ?? b.purchases) - n(a.orders ?? a.purchases))[0];

            if (kw) {
              const keywordId = s(kw.keyword_id || kw.id);
              const currentBid = n(kw.current_bid ?? kw.bid);
              const step = winner.todayWinner ? MAX_BID_STEP : 0.05;
              const nextBid = r2(Math.min(maxBid, Math.max(MIN_BID, currentBid * (1 + step))));
              const key = `SALES_RECOVERY|${aid}|${keywordId}|INCREASE_BID|${hourKey}|${nextBid.toFixed(2)}`;
              if (keywordId && currentBid > 0 && nextBid > currentBid + 0.009 && !activeKeys.has(key)) {
                const decision = await createDecision({
                  admission: winner.admission,
                  entity_type: 'keyword', entity_id: keywordId, keyword_id: keywordId,
                  keyword_text: kw.keyword_text || kw.keyword || null, campaign_id: winner.id,
                  campaign_name: winner.campaign.name || winner.campaign.campaign_name || null,
                  ad_group_id: kw.ad_group_id || null, asin: winner.asin, sku: winner.product?.sku || null,
                  action: 'increase_bid', canonical_action_type: 'KEYWORD_BID_CHANGE',
                  rationale: `RECOVERY: keyword vencedora recebe +${Math.round(step * 100)}% após retirada de budget de perdedores.`,
                  rule_key: 'INTRADAY_SALES_RECOVERY_PROMOTE_WINNER', reason_code: 'INTRADAY_SALES_RECOVERY_PROMOTE_WINNER',
                  value_before: currentBid, value_after: nextBid, current_value: currentBid, proposed_value: nextBid,
                  target_acos: winner.safeAcos, confidence: winner.todayWinner ? 0.94 : 0.86, risk: 'low',
                  idempotency_key: key, conflict_group: `${aid}|keyword|${keywordId}`,
                  data_used: JSON.stringify({ revenue_today: revenueToday, expected_floor: expectedFloor, tacos, hist_orders: winner.hist.orders, hist_acos: winner.histAcos, today_orders: winner.todayM.orders }),
                });
                queued.push({ decision_id: decision.id, action: 'increase_bid', campaign_id: winner.id, keyword_id: keywordId, asin: winner.asin, before: currentBid, after: nextBid });
              }
            }

            if (queued.length >= MAX_ACTIONS || freedBudget <= 0 || winner.budget <= 0 || winner.todayM.spend < winner.budget * 0.75) continue;
            const transfer = Math.min(freedBudget, winner.budget * MAX_BUDGET_STEP);
            if (transfer < 0.50) continue;
            const nextBudget = r2(Math.min(maxCampaignBudget, winner.budget + transfer));
            const key = `SALES_RECOVERY|${aid}|${winner.id}|INCREASE_BUDGET|${hourKey}|${nextBudget.toFixed(2)}`;
            if (nextBudget <= winner.budget + 0.01 || activeKeys.has(key)) continue;
            const decision = await createDecision({
              admission: winner.admission,
              entity_type: 'campaign', entity_id: winner.id, campaign_id: winner.id,
              campaign_name: winner.campaign.name || winner.campaign.campaign_name || null,
              asin: winner.asin, sku: winner.product?.sku || null,
              action: 'increase_budget', canonical_action_type: 'CAMPAIGN_BUDGET_CHANGE',
              rationale: 'RECOVERY: transferência budget-neutral de campanha improdutiva para campanha vencedora comprovada.',
              rule_key: 'INTRADAY_SALES_RECOVERY_TRANSFER_TO_WINNER', reason_code: 'INTRADAY_SALES_RECOVERY_TRANSFER_TO_WINNER',
              value_before: winner.budget, value_after: nextBudget, confidence: 0.91, risk: 'low',
              idempotency_key: key, conflict_group: `${aid}|campaign|${winner.id}`,
              data_used: JSON.stringify({ transfer_amount: nextBudget - winner.budget, revenue_today: revenueToday, expected_floor: expectedFloor, tacos, hist_orders: winner.hist.orders, hist_acos: winner.histAcos }),
            });
            freedBudget = Math.max(0, freedBudget - (nextBudget - winner.budget));
            queued.push({ decision_id: decision.id, action: 'increase_budget', campaign_id: winner.id, asin: winner.asin, before: winner.budget, after: nextBudget });
          }
        }
      }

      // Growth is owned exclusively by runUnifiedDecisionEngine. Recovery may
      // recommend expansion from today's evidence, but never invokes a second
      // campaign-growth pass with an independent correlation/idempotency scope.
      const servingGrowth = growthAllowed && revenueRatio < 0.40
        ? { ok: true, recommended: true, owner: 'runUnifiedDecisionEngine', reason: 'revenue_below_intraday_floor' }
        : { ok: true, skipped: true, owner: 'runUnifiedDecisionEngine' };

      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: aid, sync_type: 'intraday_sales_recovery', status: 'completed', source_function: SOURCE,
        records_processed: campaigns.length, records_imported: queued.length,
        message: recoveryActive
          ? `RECOVERY ativo: receita canônica R$ ${r2(revenueToday)} vs piso R$ ${r2(expectedFloor)}; TACoS ${tacos == null ? 'n/a' : `${(tacos * 100).toFixed(1)}%`}; ${losers.length} perdedor(es), ${winners.length} vencedor(es), ${queued.length} decisão(ões).`
          : `RECOVERY inativo: receita canônica R$ ${r2(revenueToday)} vs piso R$ ${r2(expectedFloor)}.`,
        started_at: new Date(started).toISOString(), completed_at: new Date().toISOString(),
      }).catch(() => null);

      reports.push({
        amazon_account_id: aid, date: today, hour_brt: hour,
        recovery_active: recoveryActive, growth_allowed: growthAllowed,
        revenue_today: r2(revenueToday), sales_source: todaySales?.source || null,
        baseline_daily_revenue_median_14d: r2(baselineRevenue), expected_revenue_floor_now: r2(expectedFloor), revenue_ratio_to_floor: r2(revenueRatio),
        spend_today: r2(spendToday), tacos: tacos == null ? null : r2(tacos * 100), target_tacos: r2(merTarget * 100),
        losers: losers.map((x) => ({ campaign_id: x.id, asin: x.asin, spend: r2(x.todayM.spend), orders: x.todayM.orders, sales: r2(x.todayM.sales), acos: x.todayAcos == null ? null : r2(x.todayAcos) })),
        winners: winners.map((x) => ({ campaign_id: x.id, asin: x.asin, orders_14d: x.hist.orders, acos_14d: x.histAcos == null ? null : r2(x.histAcos), orders_today: x.todayM.orders, acos_today: x.todayAcos == null ? null : r2(x.todayAcos) })),
        queued, serving_growth: servingGrowth,
        policy: { canonical_sales_only: true, dedupe_campaigns: true, global_spend_increase_only_with_v18_guardrails: true, reallocate_from_losers_to_winners: true, bid_step_max_pct: 8, budget_step_max_pct: 10, top_of_search_change: false, amazon_confirmation_required: true },
      });
    }

    return Response.json({ ok: true, engine: 'INTRADAY_SALES_RECOVERY_V1', reports, duration_ms: Date.now() - started });
  } catch (error: any) {
    return Response.json({ ok: false, engine: 'INTRADAY_SALES_RECOVERY_V1', error: error?.message || String(error) }, { status: 500 });
  }
});
