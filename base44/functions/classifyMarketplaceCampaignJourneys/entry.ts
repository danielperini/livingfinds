import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const text = (value: unknown) => String(value || '').trim().toUpperCase();
const n = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const enabled = (value: unknown) => ['enabled', 'active'].includes(String(value || '').toLowerCase());

function classify(campaign: any, product: any, economics: any, terms: any[]) {
  const stock = Math.max(
    n(product?.fba_inventory),
    n(product?.available_quantity),
    n(product?.total_quantity),
    n(product?.stock_quantity),
  );
  const buyable = product?.listing_buyable !== false && product?.buy_box_eligible !== false;
  const costKnown = n(economics?.unit_cost ?? economics?.total_variable_cost_per_unit ?? economics?.cost) > 0;
  const margin = n(economics?.contribution_margin_percent ?? economics?.margin_percent ?? economics?.margin_pct);
  const impressions = terms.reduce((s, row) => s + n(row.impressions), 0);
  const clicks = terms.reduce((s, row) => s + n(row.clicks), 0);
  const sameSkuOrders = terms.reduce((s, row) => s + n(row.same_sku_orders), 0);
  const spend = terms.reduce((s, row) => s + n(row.spend), 0);
  const sales = terms.reduce((s, row) => s + n(row.same_sku_sales), 0);
  const acos = sales > 0 ? spend / sales * 100 : 0;
  const auto = String(campaign.targeting_type || '').toUpperCase() === 'AUTO';
  const manualExact = !auto && String(campaign.match_type || campaign.keyword_match_type || '').toLowerCase() === 'exact';
  const created = new Date(String(campaign.created_at || campaign.start_date || 0)).getTime();
  const learning = !Number.isFinite(created) || Date.now() - created < 72 * 3600000;

  if (String(campaign.state || campaign.status).toLowerCase() === 'archived') return { lifecycle: 'MATURITY', journey: 'ARCHIVED', economic: 'inactive', risk: 'none', opportunity: 'none' };
  if (!buyable) return { lifecycle: 'DEFENSIVE', journey: 'INCOMPLETE', economic: 'blocked', risk: 'not_buyable', opportunity: 'none' };
  if (stock <= 0) return { lifecycle: 'DEFENSIVE', journey: 'OUT_OF_STOCK', economic: 'blocked', risk: 'out_of_stock', opportunity: 'none' };
  if (!costKnown || margin <= 0) return { lifecycle: 'LAUNCH', journey: 'INCOMPLETE', economic: 'pending', risk: 'economics_pending', opportunity: 'none' };
  if (!enabled(campaign.state || campaign.status)) return { lifecycle: 'LAUNCH', journey: 'INCOMPLETE', economic: 'pending', risk: 'structure', opportunity: 'repair' };
  if (auto && sameSkuOrders > 0 && sales > spend) return { lifecycle: 'SCALE', journey: 'DISCOVERY_AUTO_ACTIVE', economic: 'profitable', risk: 'controlled', opportunity: 'harvest' };
  if (auto) return { lifecycle: 'LAUNCH', journey: learning ? 'INITIAL_LEARNING' : 'SEARCH_TERM_COLLECTION', economic: 'learning', risk: 'controlled', opportunity: 'discovery' };
  if (manualExact && sameSkuOrders >= 2 && sales > spend && acos > 0 && acos < 45) return { lifecycle: 'SCALE', journey: 'PROTECTED_WINNER', economic: 'profitable', risk: 'low', opportunity: 'scale_small' };
  if (manualExact && learning) return { lifecycle: 'LAUNCH', journey: 'MANUAL_EXACT_LEARNING', economic: 'learning', risk: 'controlled', opportunity: impressions === 0 ? 'delivery_recovery' : 'learn' };
  if (spend > 0 && sameSkuOrders === 0 && clicks > 0) return { lifecycle: 'DEFENSIVE', journey: 'DEFENSIVE', economic: 'at_risk', risk: 'no_same_sku_sale', opportunity: 'reduce_gradually' };
  return { lifecycle: 'TRACTION', journey: manualExact ? 'MANUAL_EXACT_OPTIMIZATION' : 'TERM_EVALUATION', economic: 'valid', risk: 'controlled', opportunity: 'optimize' };
}

export default async function (request: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!(await base44.auth.isAuthenticated().catch(() => false)) && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    const accountId = body.amazon_account_id || null;
    const filter = accountId ? { amazon_account_id: accountId } : {};
    const [campaigns, products, economicRows, terms] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter(filter, '-updated_date', 2000).catch(() => []),
      base44.asServiceRole.entities.Product.filter(filter, '-updated_date', 2000).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter(filter, '-updated_date', 5000).catch(() => []),
      base44.asServiceRole.entities.SearchTerm.filter(filter, '-last_seen_at', 5000).catch(() => []),
    ]);

    const productByKey = new Map<string, any>();
    for (const row of products) {
      if (row.asin) productByKey.set(`A:${text(row.asin)}`, row);
      if (row.sku) productByKey.set(`S:${text(row.sku)}`, row);
    }
    const economicsByKey = new Map<string, any>();
    for (const row of economicRows) {
      if (row.asin) economicsByKey.set(`A:${text(row.asin)}`, row);
      if (row.sku) economicsByKey.set(`S:${text(row.sku)}`, row);
    }
    const termsByCampaign = new Map<string, any[]>();
    for (const row of terms) {
      const key = String(row.campaign_id || '');
      if (!key) continue;
      const list = termsByCampaign.get(key);
      if (list) list.push(row); else termsByCampaign.set(key, [row]);
    }

    const classifiedAt = new Date().toISOString();
    const summary: Record<string, number> = {};
    const patches: any[] = [];

    for (const campaign of campaigns) {
      const asinKey = `A:${text(campaign.asin)}`;
      const skuKey = `S:${text(campaign.sku)}`;
      const product = productByKey.get(asinKey) || productByKey.get(skuKey) || null;
      const economics = economicsByKey.get(asinKey) || economicsByKey.get(skuKey) || null;
      const rows = termsByCampaign.get(String(campaign.amazon_campaign_id || campaign.campaign_id || '')) || [];
      const state = classify(campaign, product, economics, rows);
      patches.push({
        id: campaign.id,
        product_lifecycle_stage: state.lifecycle,
        campaign_journey_stage: state.journey,
        economic_state: state.economic,
        risk_state: state.risk,
        opportunity_state: state.opportunity,
        journey_classified_at: classifiedAt,
      });
      summary[state.journey] = (summary[state.journey] || 0) + 1;
    }

    let classified = 0;
    for (let i = 0; i < patches.length; i += 200) {
      const batch = patches.slice(i, i + 200);
      await base44.asServiceRole.entities.Campaign.bulkUpdate(batch);
      classified += batch.length;
    }

    return Response.json({ ok: true, classified, journey_summary: summary, dry_run: false });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro inesperado' }, { status: 500 });
  }
}