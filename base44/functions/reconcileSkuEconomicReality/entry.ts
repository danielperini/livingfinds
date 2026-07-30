import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import {
  calculateEconomicCpc,
  calculateSkuWindowEconomics,
  calculateSmoothedSameSkuCvr,
  classifyEconomicCircuit,
} from '../../shared/skuEconomicGuard.ts';

const brtDay = (offsetDays = 1) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(Date.now() - offsetDays * 86400000));
const norm = (value: unknown) => String(value || '').trim().toUpperCase();
const ratio = (value: unknown) => {
  const number = Number(value || 0);
  return number > 1 ? number / 100 : number;
};

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }
    const day = body.date || brtDay(1);
    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id })
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });
    const results: any[] = [];

    for (const account of accounts as any[]) {
      const [products, economics, adsRows, salesRows, existingAssessments] = await Promise.all([
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: account.id }, null, 500).catch(() => []),
        base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: account.id }, null, 500).catch(() => []),
        base44.asServiceRole.entities.UnifiedAdsMetricsDaily.filter({ amazon_account_id: account.id, date: day }, null, 5000).catch(() => []),
        base44.asServiceRole.entities.SalesDaily.filter({ amazon_account_id: account.id, date: day }, null, 5000).catch(() => []),
        base44.asServiceRole.entities.DailyProductAdsAssessment.filter({ amazon_account_id: account.id, assessment_date: day }, null, 1000).catch(() => []),
      ]);
      const productByAsin = new Map(products.map((product: any) => [norm(product.asin), product]));
      const productBySku = new Map(products.map((product: any) => [norm(product.sku), product]));
      const econByAsin = new Map(economics.filter((item: any) => item.asin).map((item: any) => [norm(item.asin), item]));
      const econBySku = new Map(economics.filter((item: any) => item.sku).map((item: any) => [norm(item.sku), item]));
      const existingByAsin = new Map(existingAssessments.map((item: any) => [norm(item.asin), item]));
      const grouped = new Map<string, any>();

      for (const row of adsRows as any[]) {
        const asin = norm(row.advertised_asin || row.advertised_product_id);
        const sku = norm(row.advertised_sku);
        const product = productByAsin.get(asin) || productBySku.get(sku);
        const key = asin || norm(product?.asin);
        if (!key) continue;
        const aggregate = grouped.get(key) || {
          asin: key, sku: sku || norm(product?.sku), spend: 0, clicks: 0, impressions: 0,
          sameSkuOrders: 0, sameSkuSales: 0, sameSkuUnits: 0, totalAttributedSales: 0, haloSales: 0,
        };
        aggregate.spend += Number(row.cost || 0);
        aggregate.clicks += Number(row.clicks || 0);
        aggregate.impressions += Number(row.impressions || 0);
        aggregate.sameSkuOrders += Number(row.same_sku_orders ?? row.promoted_purchases ?? 0);
        aggregate.sameSkuSales += Number(row.same_sku_sales ?? row.promoted_sales ?? 0);
        aggregate.sameSkuUnits += Number(row.same_sku_units ?? row.promoted_units_sold ?? 0);
        aggregate.totalAttributedSales += Number(row.total_attributed_sales ?? row.sales ?? 0);
        aggregate.haloSales += Number(row.halo_sales || 0);
        grouped.set(key, aggregate);
      }

      const realByAsin = new Map<string, { revenue: number; units: number }>();
      for (const row of salesRows as any[]) {
        const key = norm(row.asin);
        if (!key) continue;
        const aggregate = realByAsin.get(key) || { revenue: 0, units: 0 };
        aggregate.revenue += Number(row.ordered_product_sales || 0);
        aggregate.units += Number(row.units_ordered || 0);
        realByAsin.set(key, aggregate);
      }

      const now = new Date().toISOString();
      let reconciled = 0, lossConfirmed = 0, mismatch = 0;
      for (const [asin, ads] of grouped.entries()) {
        const product: any = productByAsin.get(asin) || productBySku.get(ads.sku);
        const econ: any = econByAsin.get(asin) || econBySku.get(ads.sku);
        const real = realByAsin.get(asin) || { revenue: 0, units: 0 };
        const marginPerOrder = Number(econ?.contribution_margin_amount || 0);
        const realContributionMargin = real.units * marginPerOrder;
        const breakEvenAcos = ratio(econ?.contribution_margin_percent || product?.break_even_acos || product?.break_even_acos_pct);
        const configuredTarget = ratio(econ?.target_acos || product?.target_acos || 0.15);
        const targetAcos = Math.min(configuredTarget || 0.15, breakEvenAcos > 0 ? breakEvenAcos * 0.8 : configuredTarget || 0.15);
        const cvr = calculateSmoothedSameSkuCvr({
          sameSkuOrders: ads.sameSkuOrders,
          clicks: ads.clicks,
          asinPriorCvr: Number(econ?.historical_cvr || 0),
          priorWeight: 20,
          fallbackCvr: 0.05,
        });
        const cpc = calculateEconomicCpc({ contributionMarginPerOrder: marginPerOrder, sameSkuCvr: cvr.cvr, safetyFactor: 0.8 });
        const window = calculateSkuWindowEconomics({
          sameSkuOrders: ads.sameSkuOrders, sameSkuSales: ads.sameSkuSales,
          totalAttributedSales: ads.totalAttributedSales, spend: ads.spend, clicks: ads.clicks,
          contributionMarginPerOrder: marginPerOrder, targetAcos,
          realSkuRevenue: real.revenue, realContributionMargin,
        });
        const circuit = classifyEconomicCircuit({
          listingBuyable: product?.listing_buyable === true,
          offerActive: product?.offer_active === true,
          listingSuppressed: product?.listing_suppressed === true,
          realAdCostRatio: window.real_ad_cost_ratio,
          targetAcos, breakEvenAcos,
          realProfitAfterAds: window.real_profit_after_ads,
        });
        const idempotencyKey = `sku_economic_reconciliation|${account.id}|${asin}|${day}`;
        const assessment = {
          amazon_account_id: account.id, marketplace_id: account.marketplace_id,
          assessment_date: day, product_id: product?.id, asin, sku: ads.sku || product?.sku,
          spend: ads.spend, ads_sales: ads.sameSkuSales, real_sales: real.revenue,
          real_sku_revenue: real.revenue, real_sku_units: real.units, real_contribution_margin: realContributionMargin,
          same_sku_attributed_sales: ads.sameSkuSales, same_sku_orders: ads.sameSkuOrders, same_sku_units: ads.sameSkuUnits,
          halo_sales: ads.haloSales || window.halo_sales, total_attributed_sales: ads.totalAttributedSales,
          attribution_gap_amount: window.attribution_gap_amount, attribution_gap_percent: window.attribution_gap_percent,
          economic_attribution_status: real.revenue > 0 ? window.economic_attribution_status : 'INSUFFICIENT_DATA',
          real_ad_cost_ratio: window.real_ad_cost_ratio, real_profit_after_ads: window.real_profit_after_ads,
          economic_circuit_state: circuit, same_sku_cvr: cvr.cvr, same_sku_cvr_source: cvr.source,
          maximum_economic_cpc: cpc.maximum_economic_cpc, safe_max_cpc: cpc.safe_max_cpc,
          break_even_acos: breakEvenAcos, target_acos: targetAcos,
          clicks: ads.clicks, impressions: ads.impressions,
          cpc: window.cpc, cvr: cvr.cvr, acos: window.same_sku_acos,
          profit_after_ads: window.real_profit_after_ads,
          data_status: real.revenue > 0 ? 'complete' : 'reconciliation_pending',
          confidence: real.revenue > 0 && ads.sameSkuSales > 0 ? 95 : 70,
          recommended_action: circuit === 'LOSS_CONFIRMED' ? 'reduce_worst_entity_then_reassess'
            : circuit === 'DEFENSIVE' ? 'block_growth_and_reduce_inefficient_entities'
            : circuit === 'NOT_BUYABLE' ? 'pause_all_campaigns' : 'monitor',
          idempotency_key: idempotencyKey, updated_at: now, created_at: now,
        };
        const existing: any = existingByAsin.get(asin);
        if (existing?.id) await base44.asServiceRole.entities.DailyProductAdsAssessment.update(existing.id, assessment);
        else await base44.asServiceRole.entities.DailyProductAdsAssessment.create(assessment);
        if (product?.id) {
          await base44.asServiceRole.entities.Product.update(product.id, {
            economic_circuit_state: circuit,
            economic_attribution_status: assessment.economic_attribution_status,
            economic_growth_blocked: ['DEFENSIVE', 'LOSS_CONFIRMED', 'NOT_BUYABLE'].includes(circuit)
              || assessment.economic_attribution_status === 'HALO_OR_PERIOD_MISMATCH',
            economic_last_reconciled_at: now,
          }).catch(() => {});
        }
        reconciled++;
        if (circuit === 'LOSS_CONFIRMED') lossConfirmed++;
        if (assessment.economic_attribution_status === 'HALO_OR_PERIOD_MISMATCH') mismatch++;
      }
      results.push({ account_id: account.id, date: day, reconciled, loss_confirmed: lossConfirmed, attribution_mismatch: mismatch });
    }
    return Response.json({ ok: true, started_at: startedAt, completed_at: new Date().toISOString(), results });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha na reconciliação econômica por SKU' }, { status: 500 });
  }
});
