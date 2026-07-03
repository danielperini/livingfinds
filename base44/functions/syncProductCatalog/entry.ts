/** Sincroniza estoque FBA e catálogo com paginação completa. */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

let tokenCache = null;

const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const stateFromQty = (qty) => qty > 5 ? 'in_stock' : qty > 0 ? 'low_stock' : 'out_of_stock';

async function token() {
  if (tokenCache?.expiresAt > Date.now()) return tokenCache.value;
  const refreshToken = Deno.env.get('AMAZON_SP_REFRESH_TOKEN') || Deno.env.get('SP_REFRESH_TOKEN');
  const clientId = Deno.env.get('AMAZON_LWA_CLIENT_ID') || Deno.env.get('SP_CLIENT_ID');
  const clientSecret = Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || Deno.env.get('SP_CLIENT_SECRET');
  if (!refreshToken || !clientId || !clientSecret) throw new Error('Credenciais SP-API incompletas.');

  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || 'Falha no token SP-API');
  tokenCache = { value: data.access_token, expiresAt: Date.now() + (num(data.expires_in || 3600) - 60) * 1000 };
  return tokenCache.value;
}

function baseUrl(region) {
  const r = String(region || Deno.env.get('SP_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://sellingpartnerapi-eu.amazon.com';
  if (r.includes('FE')) return 'https://sellingpartnerapi-fe.amazon.com';
  return 'https://sellingpartnerapi-na.amazon.com';
}

async function get(path, region) {
  const res = await fetch(`${baseUrl(region)}${path}`, { headers: { 'x-amz-access-token': await token() } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`SP-API ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function allInventory(marketplaceId, region) {
  const items = [];
  let nextToken = null;
  do {
    const q = new URLSearchParams({ details: 'true', granularityType: 'Marketplace', granularityId: marketplaceId, marketplaceIds: marketplaceId });
    if (nextToken) q.set('nextToken', nextToken);
    const data = await get(`/fba/inventory/v1/summaries?${q}`, region);
    items.push(...(data?.payload?.inventorySummaries || []));
    nextToken = data?.payload?.pagination?.nextToken || data?.pagination?.nextToken || null;
  } while (nextToken);
  return items;
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const { amazon_account_id } = await request.json().catch(() => ({}));
    if (!amazon_account_id) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });

    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id);
    const marketplaceId = account.marketplace_id || 'A2Q3Y263D00KWC';
    const region = account.region || 'NA';
    const summaries = await allInventory(marketplaceId, region);
    const inventory = new Map();

    for (const item of summaries) {
      if (!item?.asin) continue;
      const d = item.inventoryDetails || {};
      const available = num(d.fulfillableQuantity);
      const total = num(item.totalQuantity);
      const qty = Math.max(available, total);
      inventory.set(item.asin, {
        sku: item.sellerSku || null,
        available,
        total,
        qty,
        reserved: num(d?.reservedQuantity?.totalReservedQuantity),
        inbound: num(d.inboundWorkingQuantity) + num(d.inboundShippedQuantity) + num(d.inboundReceivingQuantity),
      });
    }

    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id }, '-created_date', 5000);
    let updated = 0;
    let corrected = 0;

    for (const product of products) {
      const remote = inventory.get(product.asin);
      if (!remote) continue;

      const localQty = Math.max(
        num(product.fba_inventory),
        num(product.available_quantity),
        num(product.fulfillable_quantity),
        num(product.total_quantity),
        num(product.stock_quantity)
      );
      const qty = Math.max(remote.qty, localQty);
      if (product.inventory_status === 'out_of_stock' && qty > 0) corrected += 1;

      await base44.asServiceRole.entities.Product.update(product.id, {
        sku: remote.sku || product.sku,
        fba_inventory: qty,
        available_quantity: remote.available,
        total_quantity: remote.total,
        reserved_inventory: remote.reserved,
        inbound_inventory: remote.inbound,
        inventory_status: stateFromQty(qty),
        status: qty > 0 ? 'active' : product.status,
        catalog_sync_status: 'success',
        synced_at: new Date().toISOString(),
        last_catalog_sync_at: new Date().toISOString(),
      });
      updated += 1;
    }

    const campaignEvaluation = await base44.functions.invoke('evaluateAutoVsManualCampaigns', {
      amazon_account_id,
    }).then((res) => res?.data).catch((error) => ({ ok: false, error: error?.message || 'Falha na avaliação AUTO x manual' }));

    const target = inventory.get('B0GHP68123');
    return Response.json({
      ok: true,
      inventory_asins: inventory.size,
      updated,
      corrected_from_out_of_stock: corrected,
      campaign_evaluation: campaignEvaluation,
      verified_asin: {
        asin: 'B0GHP68123',
        found: Boolean(target),
        available_quantity: target?.available ?? null,
        total_quantity: target?.total ?? null,
        inventory_status: target ? stateFromQty(target.qty) : null,
      },
    });
  } catch (error) {
    console.error('[syncProductCatalog]', error);
    return Response.json({ ok: false, error: error?.message || 'Erro de sincronização' }, { status: 500 });
  }
});
