/**
 * importFromXano — Importa dados reais do Xano para a Base44
 *
 * Chama 3 endpoints do Xano:
 *   /amazon/dashboard
 *   /amazon/products
 *   /base44/dashboard_cards
 *
 * Payload: { amazon_account_id }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const XANO_BASE = 'https://x8ki-letl-twmt.n7.xano.io/api:living-finds-api';

async function callXano(path) {
  const xanoKey = Deno.env.get('XANO_API_KEY');
  const res = await fetch(`${XANO_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': xanoKey,
      'x-api-key': xanoKey,
      'Authorization': `Bearer ${xanoKey}`,
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok) throw new Error(`${path}: ${data?.message || data?.error || res.status}`);
  return data;
}

function normalizeArray(val, key) {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (key && val[key]) return val[key];
  const arrKey = Object.keys(val).find(k => Array.isArray(val[k]));
  return arrKey ? val[arrKey] : [];
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const amazonAccountId = body.amazon_account_id;
    if (!amazonAccountId) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    console.log('Fetching dashboard...');
    const rawCampaigns = await callXano('/amazon/analysis/campaigns');
    const allCampaigns = normalizeArray(rawCampaigns, 'campaigns');

    console.log(`Fetched ${allCampaigns.length} campaign(s) from Xano`);

    let campaignUpserted = 0;
    const today = new Date().toISOString().slice(0, 10);

    // Upsert campanhas reais com métricas do Xano
    for (const c of allCampaigns) {
      const campaignId = String(c.id || c.campaign_id || c.campaignId);
      if (!campaignId) continue;
      const orders = parseInt(c.orders || c.purchases || 0);
      const spend = parseFloat(c.spend || c.cost || 0);
      const sales = parseFloat(c.sales || 0);
      const clicks = parseInt(c.clicks || 0);
      const impressions = parseInt(c.impressions || 0);
      const acos = sales > 0 ? (spend / sales * 100) : 0;
      const roas = spend > 0 ? (sales / spend) : 0;
      const ctr = impressions > 0 ? (clicks / impressions * 100) : 0;
      const cpc = clicks > 0 ? (spend / clicks) : 0;
      const state = (c.state || c.status || '').toLowerCase() === 'enable' ? 'enabled'
        : (c.state || c.status || '').toLowerCase() === 'paus' ? 'paused'
        : 'enabled';

      const existing = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId, campaign_id: campaignId });
      const update = {
        name: c.name || c.campaignName || `Campaign ${campaignId}`,
        campaign_type: (c.type || c.campaign_type || 'SP').toUpperCase(),
        targeting_type: c.targeting_type || c.targetingType || 'MANUAL',
        state,
        daily_budget: parseFloat(c.daily_budget || c.budget || c.budgetAmount || 0),
        start_date: c.start_date || c.startDate || null,
        end_date: c.end_date || c.endDate || null,
        bidding_strategy: c.bidding_strategy || c.biddingStrategy || 'LEGACY',
        spend, sales, clicks, impressions, orders, acos, roas, ctr, cpc,
        synced_at: new Date().toISOString(),
      };

      if (existing.length > 0) {
        await base44.asServiceRole.entities.Campaign.update(existing[0].id, update);
      } else {
        await base44.asServiceRole.entities.Campaign.create({ ...update, amazon_account_id: amazonAccountId, campaign_id: campaignId });
      }
      campaignUpserted++;

      // Métrica diária atual
      const metricEx = await base44.asServiceRole.entities.CampaignMetricsDaily.filter({
        amazon_account_id: amazonAccountId, campaign_id: campaignId, date: today,
      });
      const metricRecord = { amazon_account_id: amazonAccountId, campaign_id: campaignId, date: today, spend, sales, clicks, impressions, orders, acos, roas, ctr, cpc };
      if (metricEx.length > 0) {
        await base44.asServiceRole.entities.CampaignMetricsDaily.update(metricEx[0].id, metricRecord);
      } else {
        await base44.asServiceRole.entities.CampaignMetricsDaily.create(metricRecord);
      }
    }

    // Produtos
    console.log('Fetching products...');
    const rawProducts = await callXano('/amazon/products');
    const allProducts = normalizeArray(rawProducts, 'products');
    console.log(`Fetched ${allProducts.length} product(s) from Xano`);
    let productUpserted = 0;

    for (const p of allProducts) {
      const asin = p.asin || p.asin1;
      if (!asin) continue;
      const revenue = parseFloat(p.total_revenue_30d || p.revenue || p.sales || 0);
      const units = parseInt(p.units_sold_30d || p.unitsSold || p.units || 0);
      const inventory = parseInt(p.fba_inventory || p.fulfillableQuantity || p.afn_fulfillable_quantity || 0);

      const existing = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: amazonAccountId, asin });
      const update = {
        name: p.name || p.productName || p.title || asin,
        sku: p.sku || p.sellerSku || null,
        status: p.status || p.productStatus || (inventory > 0 ? 'active' : 'inactive'),
        price: parseFloat(p.price || p.listPrice || 0),
        total_revenue_30d: revenue,
        units_sold_30d: units,
        fba_inventory: inventory,
        reserved_inventory: parseInt(p.reserved_inventory || p.reservedQuantity || 0),
        inbound_inventory: parseInt(p.inbound_inventory || p.inboundQuantity || 0),
        category: p.category || p.productCategory || null,
        image_url: p.image_url || p.mainImageUrl || p.image || null,
        synced_at: new Date().toISOString(),
      };

      if (existing.length > 0) {
        await base44.asServiceRole.entities.Product.update(existing[0].id, update);
      } else {
        await base44.asServiceRole.entities.Product.create({ ...update, amazon_account_id: amazonAccountId, asin });
      }
      productUpserted++;
    }

    // Guardar o último sync no account
    await base44.asServiceRole.entities.AmazonAccount.update(amazonAccountId, {
      last_sync_at: new Date().toISOString(),
      status: 'connected',
    });

    // Log de sync
    await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id: amazonAccountId,
      operation: 'importFromXano',
      status: 'success',
      records_received: allCampaigns.length + allProducts.length,
      records_upserted: campaignUpserted + productUpserted,
      duration_ms: Date.now() - startTime,
      started_at: new Date(Date.now() - (Date.now() - startTime)).toISOString(),
      completed_at: new Date().toISOString(),
    });

    return Response.json({
      ok: true,
      campaigns_upserted: campaignUpserted,
      products_upserted: productUpserted,
      duration_ms: Date.now() - startTime,
      message: `${campaignUpserted} campanhas + ${productUpserted} produtos importados do Xano`,
    });

  } catch (error) {
    console.error('Import from Xano failed:', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});