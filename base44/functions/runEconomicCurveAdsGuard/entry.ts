import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const MIN_BID = 0.25;
const MAX_ACTIONS = 20;
const FRESHNESS_MINUTES = 45;
const DEFAULT_TARGET_ACOS = 15;
const DEFAULT_TARGET_MER = 0.05;
const Z95_ONE_SIDED = 1.645;

const n = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const text = (value: unknown) => String(value || '').trim();
const lower = (value: unknown) => text(value).toLowerCase();
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const roundBid = (value: number) => Math.max(MIN_BID, round2(value));
const enabled = (row: any) => ['enabled', 'active'].includes(lower(row?.state || row?.status));
const brtDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const ageMinutes = (value: unknown) => {
  const ts = new Date(String(value || 0)).getTime();
  return Number.isFinite(ts) ? Math.max(0, (Date.now() - ts) / 60000) : Infinity;
};

function daysAgo(days: number) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function resolveTargetMer(settings: any, body: any) {
  const direct = n(body.target_mer_pct, 0);
  if (direct > 0) return clamp(direct > 1 ? direct / 100 : direct, 0.005, 0.5);
  const configured = n(settings?.target_mer_pct ?? settings?.target_tacos ?? settings?.tacos_target, 0);
  if (configured > 0) return clamp(configured > 1 ? configured / 100 : configured, 0.005, 0.5);
  return DEFAULT_TARGET_MER;
}

function abcClass(rows: Array<{ asin: string; value: number }>) {
  const positive = rows.filter((row) => row.asin && row.value > 0).sort((a, b) => b.value - a.value);
  const total = positive.reduce((sum, row) => sum + row.value, 0);
  const result = new Map<string, string>();
  if (total <= 0) return result;
  let cumulative = 0;
  for (const row of positive) {
    cumulative += row.value;
    const share = cumulative / total;
    result.set(row.asin, share <= 0.80 ? 'A' : share <= 0.95 ? 'B' : 'C');
  }
  return result;
}

function economicMatrix(salesCurve: string, profitCurve: string) {
  const key = `${salesCurve || 'C'}${profitCurve || 'C'}`;
  const mapping: Record<string, string> = {
    AA: 'CORE_WINNER', AB: 'CORE', AC: 'REVENUE_TRAP',
    BA: 'GROWTH_OPPORTUNITY', BB: 'GROWTH', BC: 'DEFENSIVE',
    CA: 'NICHE_WINNER', CB: 'TEST', CC: 'LOW_PRIORITY',
  };
  return mapping[key] || 'LOW_PRIORITY';
}

function curveRiskFactor(state: string) {
  const factors: Record<string, number> = {
    CORE_WINNER: 1.00,
    CORE: 0.90,
    GROWTH_OPPORTUNITY: 0.90,
    GROWTH: 0.75,
    NICHE_WINNER: 0.70,
    TEST: 0.50,
    DEFENSIVE: 0.35,
    REVENUE_TRAP: 0.25,
    LOW_PRIORITY: 0.20,
  };
  return factors[state] ?? 0.35;
}

function statePriority(state: string) {
  const order: Record<string, number> = {
    LOW_PRIORITY: 9,
    REVENUE_TRAP: 8,
    DEFENSIVE: 7,
    TEST: 6,
    GROWTH: 5,
    CORE: 4,
    GROWTH_OPPORTUNITY: 3,
    NICHE_WINNER: 2,
    CORE_WINNER: 1,
  };
  return order[state] ?? 5;
}

function latestByCampaign(rows: any[]) {
  const result = new Map<string, any>();
  const sorted = [...rows].sort((a, b) => new Date(String(b.observed_at || b.updated_at || 0)).getTime() - new Date(String(a.observed_at || a.updated_at || 0)).getTime());
  for (const row of sorted) {
    const id = text(row.campaign_id || row.amazon_campaign_id);
    if (id && !result.has(id)) result.set(id, row);
  }
  return result;
}

function betaPosterior(params: { priorClicks: number; priorOrders: number; todayClicks: number; todayOrders: number; fallbackCvr: number }) {
  const historicalClicks = Math.max(0, params.priorClicks);
  const historicalOrders = clamp(params.priorOrders, 0, historicalClicks);
  const historicalCvr = historicalClicks > 0 ? historicalOrders / historicalClicks : clamp(params.fallbackCvr, 0.005, 0.50);
  const priorStrength = clamp(historicalClicks, 8, 30);
  const alpha0 = 1 + historicalCvr * priorStrength;
  const beta0 = 1 + (1 - historicalCvr) * priorStrength;
  const todayClicks = Math.max(0, params.todayClicks);
  const todayOrders = clamp(params.todayOrders, 0, todayClicks);
  const alpha = alpha0 + todayOrders;
  const beta = beta0 + Math.max(0, todayClicks - todayOrders);
  const mean = alpha / (alpha + beta);
  const variance = (alpha * beta) / (Math.pow(alpha + beta, 2) * (alpha + beta + 1));
  const sd = Math.sqrt(Math.max(variance, 0));
  const low95 = clamp(mean - Z95_ONE_SIDED * sd, 0, 1);
  return { alpha, beta, mean, sd, low95 };
}

function normalCdf(z: number) {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const erf = sign * (1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));
  return clamp(0.5 * (1 + erf), 0, 1);
}

function reductionPct(lossRatio: number, state: string, merOverTarget: boolean) {
  let reduction = statePriority(state) >= 8 ? 0.35 : statePriority(state) >= 6 ? 0.30 : statePriority(state) >= 4 ? 0.25 : 0.20;
  if (lossRatio >= 2.5) reduction = Math.max(reduction, 0.60);
  else if (lossRatio >= 1.75) reduction = Math.max(reduction, 0.45);
  else if (lossRatio >= 1.25) reduction = Math.max(reduction, 0.35);
  if (merOverTarget) reduction = Math.min(0.60, reduction + 0.05);
  return reduction;
}

Deno.serve(async (request) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, null, 100);

    const results: any[] = [];
    for (const account of accounts) {
      const accountId = account.id;
      const today = brtDate();
      const cutoff30d = daysAgo(30);
      const [settingsRows, products, economics, salesRows, intradayRows, terms, keywords, campaigns, decisions] = await Promise.all([
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.SalesDaily.filter({ amazon_account_id: accountId }, '-date', 10000).catch(() => []),
        base44.asServiceRole.entities.IntradaySpendSnapshot.filter({ amazon_account_id: accountId, spend_date: today }, '-observed_at', 10000).catch(() => []),
        base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: accountId }, '-updated_date', 10000).catch(() => []),
        base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-updated_at', 20000).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-created_at', 5000).catch(() => []),
      ]);

      const settings = settingsRows[0] || {};
      const accountTargetAcos = Math.max(1, n(settings.target_acos ?? settings.acos_target, DEFAULT_TARGET_ACOS));
      const targetMer = resolveTargetMer(settings, body);

      const productByAsin = new Map(products.filter((p: any) => text(p.asin)).map((p: any) => [text(p.asin).toUpperCase(), p]));
      const econByAsin = new Map(economics.filter((e: any) => text(e.asin)).map((e: any) => [text(e.asin).toUpperCase(), e]));
      const campaignById = new Map(campaigns.map((c: any) => [text(c.campaign_id || c.amazon_campaign_id || c.id), c]));

      const revenue30 = new Map<string, number>();
      const revenueToday = new Map<string, number>();
      for (const row of salesRows) {
        const asin = text(row.asin).toUpperCase();
        const date = text(row.date || row.sale_date).slice(0, 10);
        if (!asin || !date) continue;
        const revenue = n(row.ordered_product_sales ?? row.revenue ?? row.sales ?? row.total_sales);
        if (date >= cutoff30d && date <= today) revenue30.set(asin, (revenue30.get(asin) || 0) + revenue);
        if (date === today) revenueToday.set(asin, (revenueToday.get(asin) || 0) + revenue);
      }

      const profit30Rows: Array<{ asin: string; value: number }> = [];
      const revenue30Rows: Array<{ asin: string; value: number }> = [];
      for (const product of products) {
        const asin = text(product.asin).toUpperCase();
        if (!asin) continue;
        const econ = econByAsin.get(asin);
        const revenue = revenue30.get(asin) || n(product.total_sales_30d);
        revenue30Rows.push({ asin, value: Math.max(0, revenue) });
        const units = Math.max(0, n(product.total_units_30d));
        const profitWindow = n(econ?.profit_after_ads_14d, NaN);
        const unitProfit = n(econ?.profit_after_ads ?? product.profit_after_ads, 0);
        const profit = Number.isFinite(profitWindow) && profitWindow !== 0 ? profitWindow : unitProfit * units;
        profit30Rows.push({ asin, value: Math.max(0, profit) });
      }

      const salesCurve = abcClass(revenue30Rows);
      const profitCurve = abcClass(profit30Rows);

      const latestSnapshots = latestByCampaign(intradayRows);
      const freshCampaignMetrics = [...latestSnapshots.values()].filter((row: any) => ageMinutes(row.observed_at || row.updated_at || row.created_at) <= FRESHNESS_MINUTES);
      const totalSpendToday = freshCampaignMetrics.reduce((sum: number, row: any) => sum + n(row.spend ?? row.cost), 0);
      const totalRevenueToday = [...revenueToday.values()].reduce((sum, value) => sum + value, 0);
      const mer = totalSpendToday > 0 && totalRevenueToday > 0 ? totalSpendToday / totalRevenueToday : null;
      const merOverTarget = mer !== null && mer > targetMer;
      const merPressure = merOverTarget ? clamp(targetMer / mer!, 0.50, 1.00) : 1.00;

      const activeDecisionKeys = new Set(decisions
        .filter((d: any) => !['failed', 'failed_final', 'cancelled', 'expired', 'superseded', 'rolled_back'].includes(lower(d.status)))
        .map((d: any) => text(d.idempotency_key)));

      const activeKeywords = keywords.filter(enabled);
      const candidates: any[] = [];

      for (const term of terms) {
        const rowDate = text(term.date || term.report_date || term.metric_date || term.start_date).slice(0, 10);
        const updatedAt = term.updated_at || term.updated_date || term.synced_at || term.created_at;
        if (rowDate && rowDate !== today) continue;
        if (!rowDate && ageMinutes(updatedAt) > FRESHNESS_MINUTES) continue;

        const campaignId = text(term.campaign_id || term.amazon_campaign_id);
        const campaign = campaignById.get(campaignId);
        if (!campaign || !enabled(campaign)) continue;

        const asin = text(term.asin || campaign.asin).toUpperCase();
        const product = productByAsin.get(asin);
        const econ = econByAsin.get(asin);
        if (!asin || !product) continue;

        const stock = n(product.fba_inventory ?? product.available_quantity ?? product.fulfillable_quantity, 0);
        if (stock <= 0) continue;
        if (product.listing_buyable === false || product.listing_suppressed === true) continue;

        const spend = n(term.spend);
        const sales = n(term.sales_14d ?? term.sales);
        const orders = n(term.orders_14d ?? term.orders);
        const clicks = n(term.clicks);
        if (spend <= 0 || clicks <= 0) continue;
        const cpc = spend / clicks;

        const keywordText = text(term.keyword_text || term.keyword || term.search_term).toLocaleLowerCase('pt-BR');
        const keywordId = text(term.keyword_id || term.amazon_keyword_id);
        const keyword = activeKeywords.find((row: any) =>
          (keywordId && text(row.keyword_id || row.id) === keywordId) ||
          (text(row.campaign_id) === campaignId && text(row.ad_group_id) === text(term.ad_group_id) &&
            text(row.keyword_text || row.keyword).toLocaleLowerCase('pt-BR') === keywordText)
        );
        if (!keyword) continue;

        const currentBid = n(keyword.current_bid ?? keyword.bid ?? term.bid);
        if (currentBid <= MIN_BID) continue;

        const curveSales = salesCurve.get(asin) || 'C';
        const curveProfit = profitCurve.get(asin) || 'C';
        const matrixState = economicMatrix(curveSales, curveProfit);
        const riskFactor = curveRiskFactor(matrixState);

        const breakEvenAcos = Math.max(0, n(econ?.break_even_acos ?? product.break_even_acos_pct));
        const productTargetAcos = Math.max(1, n(econ?.target_acos, accountTargetAcos));
        const safeAcos = breakEvenAcos > 0 ? Math.min(productTargetAcos, breakEvenAcos * 0.75) : productTargetAcos;
        const contributionMargin = Math.max(0, n(econ?.contribution_margin_amount ?? econ?.profit_before_ads ?? product.available_profit_per_sale ?? product.contribution_margin));
        const maxProfitableSpend = Math.max(0, n(econ?.maximum_profitable_ad_spend ?? product.maximum_ad_spend_per_order, contributionMargin));
        const economicsComplete = ['complete'].includes(lower(econ?.economics_status)) || econ?.economic_data_complete === true || product.cost_confirmed === true;
        const noAdCapacity = economicsComplete && contributionMargin <= 0 && maxProfitableSpend <= 0;

        let baseLossBudget = noAdCapacity ? MIN_BID : clamp((maxProfitableSpend || contributionMargin || 5) * 0.25, 2.50, 15.00);
        const lossBudget = round2(Math.max(MIN_BID, baseLossBudget * riskFactor * merPressure));
        const allowedSpend = sales * safeAcos / 100;
        const loss = Math.max(0, spend - allowedSpend);
        const projectedNextClickLoss = loss + Math.max(cpc, MIN_BID);
        const lossRatio = lossBudget > 0 ? projectedNextClickLoss / lossBudget : Infinity;

        const ticket = Math.max(0, n(econ?.average_sale_price ?? econ?.current_price ?? product.price));
        const safeAcosFraction = safeAcos / 100;
        const cvrTarget = ticket > 0 && safeAcosFraction > 0 ? clamp(cpc / (ticket * safeAcosFraction), 0.001, 0.95) : 0;
        const nStat = cvrTarget > 0 && cvrTarget < 1 ? Math.ceil(Math.log(0.05) / Math.log(1 - cvrTarget)) : Number.POSITIVE_INFINITY;
        const nEconomic = cpc > 0 ? Math.max(2, Math.floor(lossBudget / cpc)) : Number.POSITIVE_INFINITY;
        const dryClickCeiling = Math.max(2, Math.min(nStat, nEconomic));

        const priorClicks = Math.max(0, n(keyword.clicks));
        const priorOrders = Math.max(0, n(keyword.orders ?? keyword.purchases));
        const fallbackCvr = Math.max(0.005, n(product.conversion_rate_30d, 5) > 1 ? n(product.conversion_rate_30d, 5) / 100 : n(product.conversion_rate_30d, 0.05));
        const posterior = betaPosterior({ priorClicks, priorOrders, todayClicks: clicks, todayOrders: orders, fallbackCvr });
        const probabilityBelowSustainable = posterior.sd > 0 && cvrTarget > 0 ? normalCdf((cvrTarget - posterior.mean) / posterior.sd) : 0;
        const safeCpc = ticket > 0 ? posterior.low95 * ticket * safeAcosFraction : 0;

        const currentAcos = sales > 0 ? spend / sales * 100 : null;
        const protectedWinner = keyword.protected_high_performance === true ||
          (orders > 0 && sales > 0 && currentAcos !== null && currentAcos <= safeAcos && matrixState === 'CORE_WINNER');
        if (protectedWinner) continue;

        const economicTrigger = projectedNextClickLoss >= lossBudget;
        const sequentialTrigger = orders === 0 && Number.isFinite(dryClickCeiling) && clicks >= dryClickCeiling;
        const bayesianTrigger = clicks >= 4 && cvrTarget > 0 && probabilityBelowSustainable >= 0.80 && safeCpc > 0 && currentBid > safeCpc;
        const merCurveTrigger = merOverTarget && statePriority(matrixState) >= 7 && loss > 0;
        if (!economicTrigger && !sequentialTrigger && !bayesianTrigger && !merCurveTrigger && !noAdCapacity) continue;

        const reduction = reductionPct(lossRatio, matrixState, merOverTarget);
        const cycleFloor = currentBid * (1 - Math.min(0.60, reduction));
        const bayesCap = safeCpc > 0 ? safeCpc : currentBid;
        const nextBid = roundBid(Math.max(currentBid * 0.40, Math.min(cycleFloor, bayesCap)));
        if (nextBid >= currentBid) continue;

        const entityId = text(keyword.keyword_id || keyword.id);
        const key = `economic-curve-guard:${accountId}:${entityId}:${today}:${nextBid.toFixed(2)}`;
        if (!entityId || activeDecisionKeys.has(key)) continue;

        const reasonCode = noAdCapacity
          ? 'ASIN_NO_AD_CAPACITY'
          : economicTrigger ? 'ASIN_DYNAMIC_LOSS_BUDGET'
          : sequentialTrigger ? 'SEQUENTIAL_DRY_CLICK_CEILING'
          : bayesianTrigger ? 'BAYESIAN_CVR_DETERIORATION'
          : 'ACCOUNT_MER_CURVE_PRESSURE';

        candidates.push({
          campaign, keyword, term, asin, entityId, campaignId, currentBid, nextBid, reduction,
          spend, sales, orders, clicks, cpc, currentAcos, safeAcos, breakEvenAcos,
          curveSales, curveProfit, matrixState, riskFactor, lossBudget, loss,
          projectedNextClickLoss, dryClickCeiling, posterior, probabilityBelowSustainable,
          safeCpc, contributionMargin, maxProfitableSpend, key, reasonCode,
          score: statePriority(matrixState) * 100 + Math.min(99, lossRatio * 10) + (merOverTarget ? 20 : 0),
        });
      }

      candidates.sort((a, b) => b.score - a.score || b.loss - a.loss);
      let created = 0;
      for (const item of candidates.slice(0, Math.min(MAX_ACTIONS, Math.max(1, n(body.max_actions, MAX_ACTIONS))))) {
        const rationale = `Guardrail econômico ABC: ASIN ${item.asin} curva vendas ${item.curveSales}/lucro ${item.curveProfit} (${item.matrixState}); loss budget R$ ${item.lossBudget.toFixed(2)}, perda estimada R$ ${item.loss.toFixed(2)} e próximo clique R$ ${item.projectedNextClickLoss.toFixed(2)}. ACoS seguro ${item.safeAcos.toFixed(2)}%, posterior CVR ${(item.posterior.mean * 100).toFixed(2)}% (limite inferior ${(item.posterior.low95 * 100).toFixed(2)}%), CPC seguro R$ ${item.safeCpc.toFixed(2)}. MER/TACoS da conta ${mer === null ? 'indisponível' : `${(mer * 100).toFixed(2)}%`} vs meta ${(targetMer * 100).toFixed(2)}%.`;
        await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id: accountId,
          entity_type: 'keyword',
          entity_id: item.entityId,
          keyword_id: item.entityId,
          keyword_text: text(item.keyword.keyword_text || item.keyword.keyword || item.term.search_term),
          campaign_id: item.campaignId,
          campaign_name: text(item.campaign.name || item.campaign.campaign_name),
          ad_group_id: text(item.keyword.ad_group_id || item.term.ad_group_id),
          asin: item.asin,
          sku: text(item.keyword.sku || item.term.sku || productByAsin.get(item.asin)?.sku),
          action: 'reduce_bid',
          canonical_action_type: 'BID_CHANGE',
          decision_type: 'economic_curve_ads_guard',
          rationale,
          reason_code: item.reasonCode,
          current_value: item.currentBid,
          proposed_value: item.nextBid,
          value_before: item.currentBid,
          value_after: item.nextBid,
          change_pct: -Math.round(item.reduction * 100),
          confidence: clamp(0.70 + Math.min(0.25, item.probabilityBelowSustainable * 0.25), 0, 0.99),
          risk: item.matrixState === 'CORE_WINNER' ? 'medium' : statePriority(item.matrixState) >= 7 ? 'critical' : 'high',
          requires_approval: false,
          status: body.dry_run === true ? 'proposed' : 'approved',
          queue_status: body.dry_run === true ? 'not_queued' : 'pending',
          execution_mode: 'EXPEDITED_QUEUE',
          priority_class: 'P1',
          requires_fresh_data: true,
          maximum_data_age_minutes: FRESHNESS_MINUTES,
          confirmation_required: true,
          confirmation_status: 'pending',
          conflict_group: `keyword_bid:${accountId}:${item.entityId}`,
          idempotency_key: item.key,
          source_function: 'runEconomicCurveAdsGuard',
          model_version: 'economic-curve-bayes-v1',
          economic_state: item.matrixState,
          intervention_state: item.reasonCode,
          current_cpc: round2(item.cpc),
          maximum_economic_cpc: round2(item.safeCpc),
          safe_cpc: round2(item.safeCpc),
          current_acos: item.currentAcos == null ? undefined : round2(item.currentAcos),
          target_acos: round2(item.safeAcos),
          expected_clicks_per_order: item.posterior.mean > 0 ? round2(1 / item.posterior.mean) : undefined,
          no_conversion_click_multiple: item.orders === 0 && item.posterior.mean > 0 ? round2(item.clicks / (1 / item.posterior.mean)) : 0,
          maximum_acquisition_spend: round2(item.maxProfitableSpend || item.contributionMargin),
          contribution_margin_per_order: round2(item.contributionMargin),
          posterior_cvr: item.posterior.mean,
          posterior_cvr_low_95: item.posterior.low95,
          probability_below_sustainable: item.probabilityBelowSustainable,
          raw_clicks: item.clicks,
          data_window_end: today,
          evaluated_at: new Date().toISOString(),
          max_attempts: 3,
          attempt_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        created++;
      }

      results.push({
        account_id: accountId,
        date: today,
        target_acos: accountTargetAcos,
        target_mer: targetMer,
        mer,
        mer_over_target: merOverTarget,
        total_spend_today: round2(totalSpendToday),
        total_revenue_today: round2(totalRevenueToday),
        evaluated_terms: terms.length,
        eligible_actions: candidates.length,
        decisions_created: created,
        dry_run: body.dry_run === true,
      });
    }

    return Response.json({
      ok: true,
      engine: 'economic-curve-ads-guard-v1',
      policy: {
        sales_curve: 'ABC 80/15/5 por faturamento real 30d',
        profit_curve: 'ABC 80/15/5 por lucro pós-Ads disponível',
        mer_guardrail: true,
        dynamic_loss_budget: true,
        sequential_zero_sale_ceiling: true,
        bayesian_cvr_guard: true,
        protects_core_winners: true,
        never_increases_bid: true,
        amazon_confirmation_required: true,
      },
      results,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error: any) {
    return Response.json({ ok: false, engine: 'economic-curve-ads-guard-v1', error: error?.message || 'Falha no guardrail econômico ABC/MER' }, { status: 500 });
  }
});
