/**
 * importFromXano — Importa dados reais do Xano para a Base44
 *
 * Chama endpoints do Xano diretamente com X-API-Key (mesma da proxy já testada).
 *
 * Endpoints:
 *   /campaigns        → lista de campanhas
 *   /amazon/products  → produtos e métricas financeiras
 *
 * Payload: { amazon_account_id }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const XANO_BASE = Deno.env.get('XANO_BASE_URL')?.replace(/\/$/, '') || 'https://x8ki-letl-twmt.n7.xano.io/api:living-finds-api';

async function callXano(path) {
  const key = Deno.env.get('XANO_API_KEY');
  if (!key) throw new Error('XANO_API_KEY não configurada nos secrets');
  const res = await fetch(`${XANO_BASE}${path}`, {
    headers: {
      'X-API-Key': key,
      'x-api-key': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${path}: ${data?.message || data?.error || text.slice(0, 300)}`);
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

    // Campanhas de /campaigns
    const campaignsRaw = await callXano('/campaigns');
    const items = normalizeArray(campaignsRaw, 'items');

    let campaignUpserted = 0;
    for (const c of items) {
      const campaignId = String(c.amazon_campaign_id || c.id);
      if (!campaignId) continue;
      const state = ((c.status || '').toLowerCase() === 'enabled' ? 'enabled'
        : (c.status || '').toLowerCase() === 'paus' ? 'paused' : 'enabled');
      const existing = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId, campaign_id: campaignId });
      const record = {
        name: c.name || `Campaign ${campaignId}`,
        state,
        campaign_type: c.campaign_type || 'SP',
        targeting_type: c.targeting_type || 'MANUAL',
        daily_budget: c.daily_budget || 0,
        start_date: c.start_date || null,
        end_date: c.end_date || null,
        synced_at: new Date().toISOString(),
      };
      if (existing.length > 0) {
        await base44.asServiceRole.entities.Campaign.update(existing[0].id, record);
      } else {
        await base44.asServiceRole.entities.Campaign.create({ ...record, amazon_account_id: amazonAccountId, campaign_id: campaignId });
      }
      campaignUpserted++;
    }

    // Produtos de /amazon/products
    const productsRaw = await callXano('/amazon/products');
    const allProducts = normalizeArray(productsRaw, 'products');
    let productUpserted = 0;

    for (const p of allProducts) {
      const asin = p.asin || p.asin1;
      if (!asin) continue;
      const existing = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: amazonAccountId, asin });
      const revenue = p.sales || p.total_revenue_30d || 0;
      const units = p.units || p.units_sold_30d || 0;
      const inventory = p.fba_inventory || p.fulfillableQuantity || p.afn_fulfillable_quantity || 0;
      const update = {
        total_revenue_30d: revenue,
        units_sold_30d: units,
        fba_inventory: inventory,
        status: inventory > 0 ? 'active' : 'inactive',
        synced_at: new Date().toISOString(),
      };
      if (existing.length > 0) {
        await base44.asServiceRole.entities.Product.update(existing[0].id, update);
      } else {
        await base44.asServiceRole.entities.Product.create({ ...update, amazon_account_id: amazonAccountId, asin });
      }
      productUpserted++;
    }

    // Finalizar
    await base44.asServiceRole.entities.AmazonAccount.update(amazonAccountId, {
      last_sync_at: new Date().toISOString(),
      status: 'connected',
    });
    const ts = new Date().toISOString();
    await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id: amazonAccountId,
      operation: 'importFromXano',
      status: 'success',
      records_received: items.length + allProducts.length,
      records_upserted: campaignUpserted + productUpserted,
      duration_ms: Date.now() - startTime,
      started_at: ts,
      completed_at: ts,
    });

    return Response.json({
      ok: true,
      campaigns_upserted: campaignUpserted,
      products_upserted: productUpserted,
      message: `${campaignUpserted} campanhas + ${productUpserted} produtos importados`,
    });

  } catch (error) {
    console.error('Import from Xano failed:', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});