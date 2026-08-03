import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { calculateEconomicSnapshot, determineProductJourneyState } from '../../shared/economicProductJourney.ts';

const n = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const ageHours = (value: unknown) => {
  const time = value ? new Date(String(value)).getTime() : NaN;
  return Number.isFinite(time) ? (Date.now() - time) / 3600000 : Number.POSITIVE_INFINITY;
};
const active = (value: unknown) => ['ENABLED', 'ACTIVE'].includes(String(value || '').toUpperCase());
const asinValid = (value: unknown) => /^B0[A-Z0-9]{8}$/.test(String(value || '').trim().toUpperCase());

function unitsSince(rows: any[], days: number) {
  const threshold = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return rows.filter((row) => String(row.date || '') >= threshold)
    .reduce((sum, row) => sum + n(row.units_ordered ?? row.units), 0);
}

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (body._service_role !== true) {
      const user = await base44.auth.me().catch(() => null);
      if (!user || user.role !== 'admin') return Response.json({ ok: false, error: 'Admin only' }, { status: 403 });
    }
    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1)
      : await base44.asServiceRole.entities.AmazonAccount.list('-updated_date', 20);
    const output: any[] = [];

    for (const account of accounts) {
      const aid = account.id;
      const [products, economicsRows, salesRows, campaigns, promotions, flags] = await Promise.all([
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, '-updated_date', Number(body.max_products || 500)),
        base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, '-updated_at', 3000),
        base44.asServiceRole.entities.SalesDaily.filter({ amazon_account_id: aid }, '-date', 10000),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-updated_date', 5000),
        base44.asServiceRole.entities.SearchTermPromotion.filter({ amazon_account_id: aid }, '-updated_at', 5000),
        base44.asServiceRole.entities.FeatureFlag.filter({ key: 'economic_product_journey_v1', amazon_account_id: aid }, '-updated_at', 1).catch(() => []),
      ]);
      const rollout = flags[0] || {};
      const execute = body.dry_run !== true && body.execute === true && rollout.enabled === true;
      const maxActions = Math.max(0, Math.min(20, n(body.max_actions ?? rollout.config?.max_actions_per_cycle ?? 5)));
      const safetyFactor = Math.min(1, Math.max(0.1, n(rollout.config?.target_acos_safety_factor) || 0.75));
      const bySku = new Map<string, any>();
      for (const row of economicsRows) {
        const key = String(row.sku || '').trim().toUpperCase();
        if (key && !bySku.has(key)) bySku.set(key, row);
      }
      let actions = 0;
      const accountResults: any[] = [];

      for (const product of products) {
        const sku = String(product.sku || '').trim();
        const asin = String(product.asin || '').trim().toUpperCase();
        if (!sku || !asinValid(asin)) continue;
        const economics = bySku.get(sku.toUpperCase()) || null;
        const productSales = salesRows.filter((row: any) =>
          String(row.sku || '').trim().toUpperCase() === sku.toUpperCase() || String(row.asin || '').trim().toUpperCase() === asin);
        const inventoryAvailable = n(product.available_quantity ?? product.fba_inventory);
        const inventoryKnown = product.last_catalog_sync_at && ageHours(product.last_catalog_sync_at) <= 24;
        const price = n(economics?.current_price ?? product.price);
        const referralFee = n(economics?.amazon_fee_amount) > 0
          ? n(economics.amazon_fee_amount)
          : price * n(economics?.amazon_fee_percent) / 100;
        const snapshotCalculation = calculateEconomicSnapshot({
          salePrice: price, productCost: economics?.unit_cost,
          referralFee, fbaFee: economics?.fba_fee,
          fulfillmentCost: economics?.logistics_cost_per_unit,
          inboundFreightCost: economics?.inbound_freight_per_unit,
          preparationCost: economics?.packaging_cost_per_unit,
          taxCost: economics?.tax_per_unit, couponCost: economics?.coupon_cost,
          discountCost: economics?.discount_cost, returnProvision: economics?.estimated_return_cost,
          otherVariableCost: economics?.other_variable_cost_per_unit,
          costConfirmed: economics?.costs_confirmed_by_user === true,
          feesFresh: ageHours(economics?.fees_verified_at) <= 24 && String(economics?.fees_source || '').startsWith('sp_api'),
          inventoryKnown, salesFresh: productSales.some((row: any) => ageHours(row.updated_at || row.created_date || `${row.date}T23:59:59Z`) <= 72),
          safetyFactor,
          estimatedConversionRate: n(product.conversion_rate_30d || economics?.decision_evidence?.conversion_rate),
        });
        const productCampaigns = campaigns.filter((campaign: any) =>
          String(campaign.asin || '').toUpperCase() === asin || String(campaign.sku || '').toUpperCase() === sku.toUpperCase() || String(campaign.name || campaign.campaign_name || '').toUpperCase().includes(asin));
        const autoActive = productCampaigns.some((campaign: any) => active(campaign.amazon_status || campaign.state || campaign.status) && String(campaign.targeting_type || campaign.targetingType || campaign.name || '').toUpperCase().includes('AUTO'));
        const productPromotions = promotions.filter((promotion: any) => String(promotion.asin || '').toUpperCase() === asin);
        const manualPending = productPromotions.some((promotion: any) => !['completed', 'failed_permanent'].includes(String(promotion.promotion_status || '')));
        const manualValidated = productPromotions.some((promotion: any) => promotion.promotion_status === 'completed' && promotion.manual_confirmed_at);
        const harvestCandidate = productPromotions.some((promotion: any) => promotion.same_sku_attribution_verified === true && n(promotion.same_sku_orders) > 0 && !promotion.destination_keyword_id);
        const units30 = unitsSince(productSales, 30);
        const units65 = unitsSince(productSales, 65);
        const lowVolume = units30 <= n(rollout.config?.low_volume_units_30d ?? 2) && units65 <= n(rollout.config?.low_volume_units_65d ?? 4);
        const next = determineProductJourneyState({
          archived: product.archived === true, inventoryKnown, inventoryAvailable,
          economics: snapshotCalculation,
          listingActive: product.status === 'active' && product.listing_suppressed !== true,
          buyable: product.listing_buyable !== false && product.offer_active !== false,
          cooldownActive: productPromotions.some((promotion: any) =>
            promotion.cooldown_until && new Date(promotion.cooldown_until).getTime() > Date.now()),
          protectedWinner: economics?.profit_protection_mode === 'normal' && n(economics?.profit_after_ads) > 0 && productPromotions.some((p: any) => n(p.same_sku_orders) > 0),
          manualValidated, manualPending, harvestCandidate, autoActive, lowVolume,
        });
        const capturedAt = new Date().toISOString();
        const snapshotKey = `economic-journey:${aid}:${sku.toUpperCase()}:${capturedAt.slice(0, 13)}`;
        let snapshot = (await base44.asServiceRole.entities.RepricingSnapshot.filter({ snapshot_key: snapshotKey }, '-created_at', 1).catch(() => []))[0];
        if (!snapshot) snapshot = await base44.asServiceRole.entities.RepricingSnapshot.create({
          amazon_account_id: aid, profile_id: account.ads_profile_id || '', marketplace_id: account.marketplace_id || '', seller_id: account.seller_id || '',
          product_id: product.id, sku, asin, snapshot_key: snapshotKey, current_price: price,
          ...snapshotCalculation, stock_qty: inventoryAvailable, inventory_available: inventoryAvailable,
          inventory_inbound: n(product.inbound_quantity), listing_status: product.status || 'unknown',
          buy_box_status: product.buy_box_status || 'unknown', units_sold_7d: unitsSince(productSales, 7), units_sold_14d: unitsSince(productSales, 14),
          units_sold_30d: units30, units_sold_65d: units65, target_acos: snapshotCalculation.target_acos,
          confidence: snapshotCalculation.actionable ? 1 : 0, action: snapshotCalculation.actionable ? 'hold' : 'blocked',
          blockers: snapshotCalculation.missing_fields, reasons: [next.reason], data_fresh: snapshotCalculation.actionable,
          source: 'amazon_sp_api+amazon_ads_api+persisted_cost', source_price: economics?.price_source || 'missing',
          source_inventory: product.inventory_source || 'sp_api_inventory', source_sales: 'sp_api_sales_daily',
          source_cost: economics?.cost_source || 'missing', source_fees: economics?.fees_source || 'missing',
          captured_at: capturedAt, evaluated_at: capturedAt, created_at: capturedAt,
        });
        for (const promotion of productPromotions.filter((row: any) => !row.economic_snapshot_id)) {
          await base44.asServiceRole.entities.SearchTermPromotion.update(promotion.id, {
            profile_id: account.ads_profile_id || '', marketplace_id: account.marketplace_id || '',
            economic_snapshot_id: snapshot.id, journey_state: next.state,
            updated_at: capturedAt,
          }).catch(() => {});
        }
        const previousState = product.decision_journey_state || null;
        const nextEvaluation = new Date(Date.now() + (lowVolume ? 72 : 24) * 3600000).toISOString();
        await base44.asServiceRole.entities.Product.update(product.id, {
          decision_journey_state: next.state, decision_journey_reason: next.reason,
          decision_journey_snapshot_id: snapshot.id, decision_journey_updated_at: capturedAt,
          decision_journey_next_evaluation_at: nextEvaluation,
          decision_journey_transition: { from: previousState, to: next.state, reason: next.reason, snapshot_id: snapshot.id, source_function: 'runEconomicProductJourney', at: capturedAt },
        });
        let delegated: any = null;
        if (execute && actions < maxActions && next.state === 'READY_FOR_DISCOVERY') {
          delegated = await base44.asServiceRole.functions.invoke('createAutoCampaignForAsin', {
            _service_role: true, amazon_account_id: aid, sku, asin,
            product_name: product.product_name || product.title || product.name || '',
            economic_snapshot_id: snapshot.id, source_function: 'runEconomicProductJourney',
          }).then((response: any) => response?.data || response || {}).catch((error: any) => ({ ok: false, error: error?.message }));
          actions++;
        }
        accountResults.push({ sku, asin, previous_state: previousState, state: next.state, reason: next.reason,
          economic_snapshot_id: snapshot.id, economics_actionable: snapshotCalculation.actionable,
          max_sustainable_cpc: snapshotCalculation.max_sustainable_cpc, low_volume: lowVolume, delegated });
      }
      let harvest: any = { skipped: true, reason: execute ? 'action_limit_or_no_candidates' : 'rollout_disabled_or_dry_run' };
      if (execute && actions < maxActions) {
        harvest = await base44.asServiceRole.functions.invoke('runImmediateSameSkuSearchTermHarvest', {
          _service_role: true, amazon_account_id: aid, max_promotions: Math.min(maxActions - actions, n(rollout.config?.max_promotions_per_cycle ?? 5)),
          lookback_days: 65, trigger_type: 'economic_product_journey',
        }).then((response: any) => response?.data || response || {}).catch((error: any) => ({ ok: false, error: error?.message }));
      }
      output.push({ amazon_account_id: aid, rollout_enabled: rollout.enabled === true, execution_enabled: execute,
        products: accountResults.length, actions_delegated: actions, results: accountResults, harvest });
    }
    return Response.json({ ok: true, engine: 'economic-product-journey-v1', started_at: startedAt, completed_at: new Date().toISOString(), accounts: output });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error), started_at: startedAt }, { status: 500 });
  }
});
