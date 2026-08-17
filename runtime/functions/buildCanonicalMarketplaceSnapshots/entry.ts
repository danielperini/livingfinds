import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { productGate } from '../../shared/campaignDeliveryGovernor.ts';
import {
  calculateEconomicCpc,
  estimateBayesianConversion,
  estimateCanonicalElasticity,
  forecastDemand,
  probabilityAtLeastOneSale,
  simulateProfitCurve,
} from '../../shared/marketplaceDecisionMath.ts';

const SOURCE = 'buildCanonicalMarketplaceSnapshots';
const MODEL_VERSION = 'marketplace-snapshot-v1';
const numberValue = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const upper = (value: unknown) => String(value || '').trim().toUpperCase();
const lower = (value: unknown) => String(value || '').trim().toLowerCase();
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};
const isoAgeHours = (value: unknown) => {
  const timestamp = new Date(String(value || '')).getTime();
  return Number.isFinite(timestamp) ? Math.max(0, (Date.now() - timestamp) / 3600000) : Infinity;
};

function brtDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(date);
}

function dateDaysAgo(days: number) {
  return brtDate(new Date(Date.now() - days * 86400000));
}

function decisionWindow(minutes = 15) {
  const size = minutes * 60000;
  return new Date(Math.floor(Date.now() / size) * size).toISOString();
}

async function list(entity: any, filters: Record<string, unknown>, sort = '-updated_at', limit = 10000) {
  return entity.filter(filters, sort, limit).catch(() => []);
}

function keyOf(row: any) {
  return `${upper(row?.sku)}|${upper(row?.asin)}`;
}

function matchesProduct(row: any, product: any) {
  return (upper(product.sku) && upper(row.sku) === upper(product.sku)) ||
    (upper(product.asin) && upper(row.asin) === upper(product.asin));
}

function aggregate(rows: any[], product: any, startDate: string, endDate: string) {
  return rows.filter((row) => matchesProduct(row, product) && String(row.assessment_date || '') >= startDate && String(row.assessment_date || '') <= endDate)
    .reduce((total, row) => ({
      impressions: total.impressions + numberValue(row.impressions),
      clicks: total.clicks + numberValue(row.clicks),
      spend: total.spend + numberValue(row.spend),
      sales: total.sales + numberValue(row.ads_sales),
      orders: total.orders + numberValue(row.orders_ads),
      realSales: total.realSales + numberValue(row.real_sales),
      units: total.units + numberValue(row.units_real),
    }), { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0, realSales: 0, units: 0 });
}

function latestForProduct(rows: any[], product: any) {
  return rows.filter((row) => matchesProduct(row, product))
    .sort((a, b) => String(b.assessment_date || b.updated_at || '').localeCompare(String(a.assessment_date || a.updated_at || '')))[0] || null;
}

function latestIntradayByCampaign(rows: any[]) {
  const result = new Map<string, any>();
  for (const row of [...rows].sort((a, b) => String(b.observed_at || '').localeCompare(String(a.observed_at || '')))) {
    const id = String(row.campaign_id || '');
    if (id && !result.has(id)) result.set(id, row);
  }
  return result;
}

function currentProductMetrics(params: {
  product: any;
  assessmentRows: any[];
  assessmentDate: string;
  dailyClose: boolean;
  campaigns: any[];
  productAds: any[];
  intradayByCampaign: Map<string, any>;
}) {
  const { product, assessmentRows, assessmentDate, dailyClose, campaigns, productAds, intradayByCampaign } = params;
  if (dailyClose) return aggregate(assessmentRows, product, assessmentDate, assessmentDate);
  const campaignIds = new Set<string>();
  for (const campaign of campaigns) {
    if (matchesProduct(campaign, product)) campaignIds.add(String(campaign.amazon_campaign_id || campaign.campaign_id || campaign.id || ''));
  }
  for (const ad of productAds) {
    if (matchesProduct(ad, product)) campaignIds.add(String(ad.campaign_id || ''));
  }
  const metrics = { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0, realSales: 0, units: 0 };
  for (const campaignId of campaignIds) {
    const row = intradayByCampaign.get(campaignId);
    if (!row) continue;
    metrics.impressions += numberValue(row.impressions);
    metrics.clicks += numberValue(row.clicks);
    metrics.spend += numberValue(row.spend);
    metrics.sales += numberValue(row.sales);
    metrics.orders += numberValue(row.orders);
  }
  return metrics;
}

function economicInputs(product: any, economics: any, metrics: any) {
  const price = numberValue(economics?.current_price || economics?.average_sale_price || product.price);
  const productCost = numberValue(economics?.unit_cost || product.product_cost);
  const inboundFreight = numberValue(economics?.inbound_freight_per_unit);
  const preparationCost = numberValue(economics?.packaging_cost_per_unit);
  const fulfillmentCost = numberValue(economics?.logistics_cost_per_unit);
  const fbaFee = numberValue(economics?.fba_fee);
  const fixedAmazonFee = numberValue(economics?.amazon_fixed_fee);
  const returnProvision = numberValue(economics?.estimated_return_cost);
  const otherVariable = numberValue(economics?.other_variable_cost_per_unit);
  const referralFeePct = numberValue(economics?.amazon_fee_percent);
  const taxPct = 7;
  const adsPerOrder = metrics.orders > 0 ? metrics.spend / metrics.orders : numberValue(economics?.estimated_ads_cost_per_order);
  const fixedCosts = productCost + inboundFreight + preparationCost + fulfillmentCost + fbaFee + fixedAmazonFee + returnProvision + otherVariable;
  const proportionalFees = price * (referralFeePct + taxPct) / 100;
  const contributionMargin = numberValue(economics?.contribution_margin_amount, price - fixedCosts - proportionalFees);
  const marginRate = price > 0 ? contributionMargin / price * 100 : 0;
  const targetAcos = numberValue(economics?.target_acos, 20);
  const breakEvenAcos = numberValue(economics?.break_even_acos, marginRate);
  const allowableCandidates = [numberValue(economics?.maximum_profitable_ad_spend), contributionMargin, price * targetAcos / 100]
    .filter((value) => value > 0);
  const allowable = allowableCandidates.length ? Math.min(...allowableCandidates) : 0;
  const confidenceRaw = numberValue(economics?.final_economic_confidence || economics?.decision_confidence);
  const confidence = clamp(confidenceRaw > 1 ? confidenceRaw / 100 : confidenceRaw, 0, 1);
  const complete = lower(economics?.economics_status) === 'complete' && price > 0 && productCost > 0 && contributionMargin > 0 && confidence >= 0.5;
  const floor = numberValue(economics?.minimum_profitable_price) ||
    (1 - (referralFeePct + taxPct + Math.max(15, numberValue(economics?.minimum_margin_pct, 15))) / 100 > 0
      ? fixedCosts / (1 - (referralFeePct + taxPct + Math.max(15, numberValue(economics?.minimum_margin_pct, 15))) / 100)
      : 0);
  return {
    price, productCost, inboundFreight, preparationCost, fulfillmentCost, fbaFee, fixedAmazonFee,
    returnProvision, otherVariable, referralFeePct, taxPct, adsPerOrder, fixedCosts,
    contributionMargin, marginRate, targetAcos, breakEvenAcos, allowable, confidence, complete, floor,
  };
}

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const accounts = body.amazon_account_id
      ? await list(base44.asServiceRole.entities.AmazonAccount, { id: body.amazon_account_id }, '-updated_at', 1)
      : await list(base44.asServiceRole.entities.AmazonAccount, { status: 'connected' }, '-updated_at', 100);
    const window = String(body.decision_window || decisionWindow(numberValue(body.window_minutes, 15)));
    const dailyClose = body.window_type === 'daily_close' || body.daily_close === true;
    const assessmentDate = String(body.assessment_date || (dailyClose ? dateDaysAgo(1) : brtDate()));
    const windowStart = dailyClose ? `${assessmentDate}T03:00:00.000Z` : window;
    const windowEnd = dailyClose
      ? `${brtDate(new Date(new Date(`${assessmentDate}T12:00:00Z`).getTime() + 86400000))}T02:59:59.999Z`
      : new Date(new Date(window).getTime() + numberValue(body.window_minutes, 15) * 60000 - 1).toISOString();
    const runId = String(body.run_id || `${SOURCE}|${Date.now()}`);
    const accountResults: any[] = [];

    for (const account of accounts) {
      const accountId = String(account.id);
      const [products, economicsRows, assessments, histories, campaigns, productAds, intradayRows, existing] = await Promise.all([
        list(base44.asServiceRole.entities.Product, { amazon_account_id: accountId }, '-updated_at', 5000),
        list(base44.asServiceRole.entities.ProductEconomics, { amazon_account_id: accountId }, '-updated_at', 5000),
        list(base44.asServiceRole.entities.DailyProductAdsAssessment, { amazon_account_id: accountId }, '-assessment_date', 50000),
        list(base44.asServiceRole.entities.ProductEconomicsHistory, { amazon_account_id: accountId }, '-changed_at', 20000),
        list(base44.asServiceRole.entities.Campaign, { amazon_account_id: accountId }, '-updated_at', 5000),
        list(base44.asServiceRole.entities.ProductAd, { amazon_account_id: accountId }, '-updated_at', 10000),
        list(base44.asServiceRole.entities.IntradaySpendSnapshot, { amazon_account_id: accountId, spend_date: brtDate() }, '-observed_at', 20000),
        list(base44.asServiceRole.entities.RepricingSnapshot, { amazon_account_id: accountId, decision_window: window }, '-created_at', 10000),
      ]);
      const existingKeys = new Set(existing.map((row) => String(row.snapshot_key || '')));
      const intradayByCampaign = latestIntradayByCampaign(intradayRows);
      const snapshots: any[] = [];

      for (const product of products) {
        const asin = upper(product.asin);
        const sku = upper(product.sku);
        if (!asin || !sku) continue;
        const snapshotKey = [accountId, account.ads_profile_id || 'unknown_profile', account.marketplace_id || account.marketplace || 'unknown_marketplace', asin, sku, window].join('|');
        if (existingKeys.has(snapshotKey)) continue;
        const economics = economicsRows.find((row) => matchesProduct(row, product)) || null;
        const latestAssessment = latestForProduct(assessments, product);
        const current = currentProductMetrics({ product, assessmentRows: assessments, assessmentDate, dailyClose, campaigns, productAds, intradayByCampaign });
        const endDate = dailyClose ? assessmentDate : dateDaysAgo(1);
        const m7 = aggregate(assessments, product, dateDaysAgo(7), endDate);
        const m14 = aggregate(assessments, product, dateDaysAgo(14), endDate);
        const m30 = aggregate(assessments, product, dateDaysAgo(30), endDate);
        const dailySamples = assessments.filter((row) => matchesProduct(row, product) && String(row.assessment_date || '') >= dateDaysAgo(65) && String(row.assessment_date || '') <= endDate)
          .map((row) => ({ date: String(row.assessment_date), units: numberValue(row.units_real), price: numberValue(economics?.current_price || product.price), stockQty: numberValue(product.fba_inventory ?? product.available_quantity, -1), adsSpend: numberValue(row.spend) }));
        const forecast = forecastDemand(dailySamples, endDate);
        const economic = economicInputs(product, economics, current);
        const posterior = estimateBayesianConversion({ clicks: m30.clicks, orders: m30.orders, priorAlpha: numberValue(body.prior_alpha, 1), priorBeta: numberValue(body.prior_beta, 19), sustainableThreshold: economic.targetAcos > 0 && economic.price > 0 ? economic.allowable / economic.price : 0.05 });
        const economicCpc = calculateEconomicCpc({ conversionRate: posterior.mean, conversionLowerBound: posterior.lower, allowableAdSpendPerOrder: economic.allowable, safetyFactor: numberValue(body.safety_factor, 0.85) });
        const historyPoints = histories.filter((row) => matchesProduct(row, product)).flatMap((row) => {
          const points: any[] = [];
          if (numberValue(row.price_before) > 0 && numberValue(row.units_before) > 0) points.push({ date: String(row.changed_at || row.effective_from || ''), price: numberValue(row.price_before), units: numberValue(row.units_before), stockQty: numberValue(row.stock_before, -1), adsSpend: numberValue(row.ads_cost_before) });
          if (numberValue(row.price_after) > 0 && numberValue(row.units_after) > 0) points.push({ date: String(row.changed_at || row.effective_from || ''), price: numberValue(row.price_after), units: numberValue(row.units_after), stockQty: numberValue(row.stock_after, -1), adsSpend: numberValue(row.ads_cost_after) });
          return points;
        });
        const elasticity = estimateCanonicalElasticity(historyPoints);
        const profitCurve = simulateProfitCurve({
          currentPrice: economic.price, economicFloor: economic.floor, variableCostPerUnit: economic.fixedCosts,
          referralFeePct: economic.referralFeePct, salesTaxPct: economic.taxPct,
          baselineDailyUnits: forecast.predicted1d || numberValue(product.daily_sales_velocity_30d),
          adsSpendPerDay: current.spend, elasticity, maximumChangePct: numberValue(body.max_price_change_pct, 2) / 100,
        });
        const gate = productGate(product);
        const stock = numberValue(product.fba_inventory ?? product.available_quantity ?? product.fulfillable_quantity, -1);
        const inbound = numberValue(product.inbound_inventory);
        const reserved = numberValue(product.reserved_inventory);
        const coverage = numberValue(product.days_of_supply, -1);
        const listingActive = !['inactive', 'not_found', 'error'].includes(lower(product.listing_status || product.status));
        const offerActive = product.offer_active !== false;
        const buyable = product.listing_buyable !== false;
        const adsFreshAt = dailyClose ? latestAssessment?.updated_at || latestAssessment?.created_at || `${assessmentDate}T23:59:59Z`
          : Array.from(intradayByCampaign.values()).map((row) => row.observed_at).filter(Boolean).sort().at(-1) || latestAssessment?.updated_at || null;
        const spFreshAt = product.last_sync_at || product.synced_at || product.updated_at || null;
        const economicsFreshAt = economics?.updated_at || economics?.ads_cost_verified_at || economics?.fees_verified_at || null;
        const adsFresh = dailyClose
          ? String(latestAssessment?.assessment_date || '') === assessmentDate && latestAssessment?.data_status === 'complete'
          : isoAgeHours(adsFreshAt) <= 1;
        const spFresh = isoAgeHours(spFreshAt) <= 24;
        const economicsFresh = isoAgeHours(economicsFreshAt) <= 24 * 7;
        const dataFresh = adsFresh && spFresh && economicsFresh;
        const acos = current.sales > 0 ? current.spend / current.sales * 100 : null;
        const profitAfterAds = current.units * economic.contributionMargin - current.spend;
        const winner = current.orders >= 2 && current.sales > 0 && profitAfterAds > 0 && acos !== null && (economic.targetAcos <= 0 || acos <= economic.targetAcos);
        const stockoutProbability = forecast.predicted14d && stock > 0 ? clamp(forecast.predicted14d / stock, 0, 1) : stock <= 0 ? 1 : 0;
        const probabilitySale = probabilityAtLeastOneSale(posterior.lower, Math.max(1, Math.ceil(1 / Math.max(posterior.mean, 0.001))));
        const probabilityProfit = clamp(probabilitySale * economic.confidence * (profitAfterAds >= 0 ? 1 : 0.35), 0, 1);
        const riskState = !dataFresh ? 'DATA_PENDING' : !gate.eligible ? gate.code : !economic.complete ? 'ECONOMICS_PENDING' : profitAfterAds < 0 ? 'LOSS_CONFIRMED' : stockoutProbability >= 0.8 ? 'STOCKOUT_RISK' : 'NORMAL';
        const productState = !gate.eligible ? gate.code : !dataFresh ? 'DATA_PENDING' : !economic.complete ? 'ECONOMICS_PENDING' : winner ? 'PROTECTED_WINNER' : current.impressions <= 0 ? 'READY_FOR_DISCOVERY' : 'ACTIVE_OPTIMIZATION';
        const repricingAllowed = dataFresh && gate.eligible && economic.complete && elasticity.confidence >= 0.90 && forecast.confidence >= 0.90;

        snapshots.push({
          amazon_account_id: accountId,
          marketplace_id: account.marketplace_id || account.marketplace || null,
          profile_id: account.ads_profile_id || null,
          seller_id: account.seller_id || account.merchant_id || null,
          product_id: product.id,
          sku, asin, snapshot_key: snapshotKey, correlation_id: runId, run_id: runId,
          decision_window: window, window_start: windowStart, window_end: windowEnd, captured_at: new Date().toISOString(),
          data_freshness_status: dataFresh ? 'FRESH' : 'STALE', ads_data_fresh_at: adsFreshAt,
          sp_api_data_fresh_at: spFreshAt, economics_data_fresh_at: economicsFreshAt,
          listing_status: product.listing_status || product.status, offer_status: product.offer_status || (offerActive ? 'active' : 'inactive'),
          buyable, buy_box_status: product.buy_box_status || product.featured_offer_status || 'unknown',
          inventory_available: stock, inventory_inbound: inbound, inventory_reserved: reserved,
          stock_qty: stock, stock_coverage_days: coverage >= 0 ? coverage : null,
          sales_velocity: numberValue(product.daily_sales_velocity_30d), current_price: economic.price, sale_price: economic.price,
          economic_floor: round(economic.floor), price_ceiling: numberValue(economics?.manual_max_price), proposed_price: profitCurve.best?.price || economic.price,
          product_cost: economic.productCost, referral_fee: round(economic.price * economic.referralFeePct / 100), referral_fee_pct: economic.referralFeePct,
          fba_fee: economic.fbaFee, fulfillment_cost: economic.fulfillmentCost, inbound_freight: economic.inboundFreight,
          preparation_cost: economic.preparationCost, tax_cost: round(economic.price * economic.taxPct / 100), tax_pct: economic.taxPct,
          coupon_cost: 0, discount_cost: 0, return_provision: economic.returnProvision, other_variable_cost: economic.otherVariable,
          ad_spend: current.spend, ad_sales: current.sales, ad_orders: current.orders,
          impressions_1d: current.impressions, impressions_7d: m7.impressions, impressions_14d: m14.impressions, impressions_30d: m30.impressions,
          clicks_1d: current.clicks, clicks_7d: m7.clicks, clicks_14d: m14.clicks, clicks_30d: m30.clicks,
          spend_1d: round(current.spend), spend_7d: round(m7.spend), spend_14d: round(m14.spend), spend_30d: round(m30.spend),
          same_sku_orders: current.orders, same_sku_sales: current.sales, halo_orders: 0, halo_sales: 0,
          total_attributed_orders: current.orders, total_attributed_sales: current.sales,
          cpc: current.clicks > 0 ? round(current.spend / current.clicks) : 0,
          ctr: current.impressions > 0 ? round(current.clicks / current.impressions, 6) : 0,
          cvr: current.clicks > 0 ? round(current.orders / current.clicks, 6) : 0,
          current_acos: acos, roas: current.spend > 0 ? round(current.sales / current.spend) : 0,
          tacos: current.realSales > 0 ? round(current.spend / current.realSales * 100) : null,
          target_acos: economic.targetAcos, break_even_acos: economic.breakEvenAcos,
          margin_before_ads: economic.contributionMargin, margin_rate: economic.marginRate,
          allowable_ad_spend_per_order: economic.allowable, maximum_profitable_cpa: economic.allowable,
          maximum_economic_cpc: economicCpc.maximumEconomicCpc, safe_max_cpc: economicCpc.safeMaxCpc,
          profit_after_ads: round(profitAfterAds), profit_per_order: current.orders > 0 ? round(profitAfterAds / current.orders) : null,
          profit_per_click: current.clicks > 0 ? round(profitAfterAds / current.clicks) : null,
          contribution_margin: economic.contributionMargin, economic_confidence: economic.confidence,
          predicted_sales_1d: forecast.predicted1d, predicted_sales_3d: forecast.predicted3d,
          predicted_sales_7d: forecast.predicted7d, predicted_sales_14d: forecast.predicted14d,
          sales_forecast_low: forecast.low, sales_forecast_median: forecast.median, sales_forecast_high: forecast.high,
          forecast_status: forecast.status, forecast_confidence: forecast.confidence,
          price_elasticity: elasticity.elasticity, elasticity_status: elasticity.status, elasticity_confidence: elasticity.confidence,
          predicted_conversion_rate: posterior.mean, predicted_conversion_rate_low: posterior.lower, predicted_conversion_rate_high: posterior.upper,
          cvr_posterior_alpha: posterior.posteriorAlpha, cvr_posterior_beta: posterior.posteriorBeta,
          probability_cvr_above_threshold: posterior.probabilityAboveThreshold,
          predicted_acos: posterior.mean > 0 && economic.price > 0 ? round(economicCpc.maximumEconomicCpc / (posterior.mean * economic.price) * 100) : null,
          predicted_profit: profitCurve.best?.expectedProfit ?? null,
          probability_of_sale: probabilitySale, probability_of_profitable_sale: probabilityProfit,
          probability_of_stockout: stockoutProbability, probability_of_loss: clamp(profitAfterAds < 0 ? 0.5 + (1 - economic.confidence) * 0.5 : 1 - probabilityProfit, 0, 1),
          prediction_confidence: Math.min(forecast.confidence, posterior.observations >= 20 ? 1 : posterior.observations / 20),
          model_version: MODEL_VERSION, profit_curve: JSON.stringify(profitCurve),
          product_state: productState, campaign_state: product.campaign_status || 'unknown',
          economic_state: economic.complete ? (profitAfterAds < 0 ? 'LOSS_CONFIRMED' : 'ECONOMICALLY_VALID') : 'ECONOMICS_PENDING',
          risk_state: riskState, opportunity_state: winner ? 'PROTECTED_WINNER' : probabilityProfit >= 0.70 ? 'GROWTH_CANDIDATE' : 'LEARNING',
          winner_protected: winner, low_volume_guarded: m30.units <= 2,
          growth_allowed: dataFresh && gate.eligible && economic.complete && profitAfterAds >= 0,
          repricing_allowed: repricingAllowed, bid_increase_allowed: dataFresh && gate.eligible && economic.complete && profitAfterAds >= 0,
          bid_reduction_allowed: dataFresh && gate.eligible, pause_allowed: false,
          budget_increase_allowed: dataFresh && gate.eligible && economic.complete && coverage >= 14,
          confidence: Math.min(economic.confidence, forecast.confidence || economic.confidence),
          action: 'hold', blockers: [!dataFresh ? 'STALE_DATA' : null, !gate.eligible ? gate.code : null, !economic.complete ? 'ECONOMICS_INCOMPLETE' : null].filter(Boolean),
          reasons: [`Snapshot canônico ${dailyClose ? `do fechamento ${assessmentDate}` : 'intradiário'}; nenhuma ação é executada nesta etapa.`],
          validation_preview_status: 'not_required', data_fresh: dataFresh, source: 'canonical_unified_marketplace_engine',
          evaluated_at: new Date().toISOString(), created_at: new Date().toISOString(),
        });
      }

      let created: any[] = [];
      if (snapshots.length && body.persist !== false) {
        await base44.asServiceRole.entities.RepricingSnapshot.bulkCreate(snapshots);
        created = await list(base44.asServiceRole.entities.RepricingSnapshot, { amazon_account_id: accountId, run_id: runId }, '-created_at', 10000);
      }
      const rows = created.length ? created : snapshots;
      accountResults.push({
        amazon_account_id: accountId, profile_id: account.ads_profile_id || null, decision_window: window,
        assessment_date: assessmentDate, daily_close: dailyClose, analyzed: products.length,
        snapshots_created: snapshots.length, snapshots_reused: existing.length,
        fresh: rows.filter((row) => row.data_fresh === true).length,
        blocked: rows.filter((row) => row.data_fresh !== true || row.repricing_allowed !== true).length,
        loss_confirmed: rows.filter((row) => row.economic_state === 'LOSS_CONFIRMED').length,
        winners: rows.filter((row) => row.winner_protected === true).length,
        snapshot_ids: rows.map((row) => row.id).filter(Boolean),
        snapshots: body.include_snapshots === true ? rows : undefined,
      });
    }

    const completedAt = new Date().toISOString();
    return Response.json({
      ok: true, source: SOURCE, model_version: MODEL_VERSION, run_id: runId,
      decision_window: window, assessment_date: assessmentDate, daily_close: dailyClose,
      accounts: accountResults, started_at: startedAt, completed_at: completedAt,
    });
  } catch (error: any) {
    return Response.json({ ok: false, source: SOURCE, error: error?.message || 'Falha ao criar snapshots canônicos' }, { status: 500 });
  }
});
