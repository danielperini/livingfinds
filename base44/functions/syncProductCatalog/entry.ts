/**
 * syncProductCatalog — Importa catálogo de produtos via SP-API Catalog Items + FBA Inventory
 * Payload: { amazon_account_id, marketplace_id? }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

async function getLWAToken() {
  const cached = tokenCache['lwa'];
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: Deno.env.get('ADS_REFRESH_TOKEN'),
    client_id: Deno.env.get('ADS_CLIENT_ID'),
    client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'LWA token failed');
  tokenCache['lwa'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getSPBaseUrl(region) {
  const r = (region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU') || r.includes('EUROP')) return 'https://sellingpartnerapi-eu.amazon.com';
  if (r.includes('FE') || r.includes('JAPAN')) return 'https://sellingpartnerapi-fe.amazon.com';
  return 'https://sellingpartnerapi-na.amazon.com';
}

async function spCall(path, marketplaceId) {
  const token = await getLWAToken();
  const url = `${getSPBaseUrl()}${path}`;
  const res = await fetch(url, {
    headers: {
      'x-amz-access-token': token,
      'x-amz-marketplace-id': marketplaceId || 'ATVPDKIKX0DER',
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`SP-API ${res.status} ${path}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  let syncRunId = null;
  let base44;

  try {
    base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const amazonAccountId = body.amazon_account_id;
    if (!amazonAccountId) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    const marketplaceId = body.marketplace_id || 'ATVPDKIKX0DER';

    const syncRun = await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id: amazonAccountId,
      operation: 'syncProductCatalog',
      status: 'running',
      started_at: new Date().toISOString(),
    });
    syncRunId = syncRun.id;

    let totalReceived = 0, totalUpserted = 0;
    const errors = [];

    // ── FBA Inventory (todos os SKUs com stock) ──
    let inventoryMap = {};
    try {
      const invData = await spCall(`/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=${marketplaceId}&marketplaceIds=${marketplaceId}`, marketplaceId);
      const invList = invData?.payload?.inventorySummaries || [];
      for (const item of invList) {
        if (item.asin) {
          inventoryMap[item.asin] = {
            sku: item.sellerSku,
            fba_inventory: item.inventoryDetails?.fulfillableQuantity || item.totalQuantity || 0,
            reserved_inventory: (item.inventoryDetails?.reservedQuantity?.totalReservedQuantity) || 0,
            inbound_inventory: (item.inventoryDetails?.inboundWorkingQuantity || 0) + (item.inventoryDetails?.inboundShippedQuantity || 0),
          };
        }
      }
    } catch (e) { errors.push(`Inventory: ${e.message}`); }

    // ── Catalog Items (lista de ASINs do seller) ──
    try {
      const catData = await spCall(`/catalog/2022-04-01/items?marketplaceIds=${marketplaceId}&includedData=summaries,images,attributes,salesRanks&pageSize=20`, marketplaceId);
      const items = catData?.items || [];
      totalReceived += items.length;

      for (const item of items) {
        const asin = item.asin;
        const summary = item.summaries?.[0] || {};
        const image = item.images?.[0]?.images?.[0]?.link || null;
        const inv = inventoryMap[asin] || {};

        const existing = await base44.asServiceRole.entities.Product.filter({
          amazon_account_id: amazonAccountId,
          asin,
        });

        const record = {
          amazon_account_id: amazonAccountId,
          asin,
          sku: inv.sku || summary.sku || null,
          name: summary.itemName || summary.brand || asin,
          status: summary.status || 'active',
          category: summary.productType || null,
          price: summary.listPrice?.amount || null,
          image_url: image,
          fba_inventory: inv.fba_inventory || 0,
          reserved_inventory: inv.reserved_inventory || 0,
          inbound_inventory: inv.inbound_inventory || 0,
          synced_at: new Date().toISOString(),
        };

        if (existing.length > 0) {
          await base44.asServiceRole.entities.Product.update(existing[0].id, record);
        } else {
          await base44.asServiceRole.entities.Product.create(record);
        }
        totalUpserted++;
      }
    } catch (e) { errors.push(`Catalog: ${e.message}`); }

    // ── Upsert apenas inventário para ASINs que ainda não estão no catálogo ──
    try {
      for (const [asin, inv] of Object.entries(inventoryMap)) {
        const existing = await base44.asServiceRole.entities.Product.filter({
          amazon_account_id: amazonAccountId,
          asin,
        });
        if (existing.length === 0) {
          await base44.asServiceRole.entities.Product.create({
            amazon_account_id: amazonAccountId,
            asin,
            sku: inv.sku,
            fba_inventory: inv.fba_inventory,
            reserved_inventory: inv.reserved_inventory,
            inbound_inventory: inv.inbound_inventory,
            status: 'active',
            synced_at: new Date().toISOString(),
          });
          totalUpserted++;
          totalReceived++;
        } else {
          await base44.asServiceRole.entities.Product.update(existing[0].id, {
            sku: inv.sku || existing[0].sku,
            fba_inventory: inv.fba_inventory,
            reserved_inventory: inv.reserved_inventory,
            inbound_inventory: inv.inbound_inventory,
            synced_at: new Date().toISOString(),
          });
        }
      }
    } catch (e) { errors.push(`InventoryUpsert: ${e.message}`); }

    await base44.asServiceRole.entities.SyncRun.update(syncRunId, {
      status: errors.length > 0 && totalUpserted === 0 ? 'error' : errors.length > 0 ? 'partial' : 'success',
      records_received: totalReceived,
      records_upserted: totalUpserted,
      error_message: errors.join('; ') || null,
      duration_ms: Date.now() - startTime,
      completed_at: new Date().toISOString(),
    });

    return Response.json({ ok: true, totalReceived, totalUpserted, inventoryMapped: Object.keys(inventoryMap).length, errors });

  } catch (error) {
    if (syncRunId && base44) {
      await base44.asServiceRole.entities.SyncRun.update(syncRunId, {
        status: 'error', error_message: error.message,
        duration_ms: Date.now() - startTime, completed_at: new Date().toISOString(),
      }).catch(() => {});
    }
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});