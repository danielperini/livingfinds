import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

let tokenCache = null;
const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const stockState = (qty) => qty > 5 ? 'in_stock' : qty > 0 ? 'low_stock' : 'out_of_stock';

async function token() {
  if (tokenCache?.expiresAt > Date.now()) return tokenCache.value;
  const refresh = Deno.env.get('AMAZON_SP_REFRESH_TOKEN') || Deno.env.get('SP_REFRESH_TOKEN');
  const client = Deno.env.get('AMAZON_LWA_CLIENT_ID') || Deno.env.get('SP_CLIENT_ID');
  const secret = Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || Deno.env.get('SP_CLIENT_SECRET');
  if (!refresh || !client || !secret) throw new Error('Credenciais SP-API incompletas.');
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: client, client_secret: secret }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || 'Falha no token SP-API');
  tokenCache = { value: data.access_token, expiresAt: Date.now() + (num(data.expires_in || 3600) - 60) * 1000 };
  return tokenCache.value;
}

function base(region) {
  const r = String(region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://sellingpartnerapi-eu.amazon.com';
  if (r.includes('FE')) return 'https://sellingpartnerapi-fe.amazon.com';
  return 'https://sellingpartnerapi-na.amazon.com';
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const auth = await base44.auth.isAuthenticated().catch(() => false);
    if (!auth && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    if (!body.amazon_account_id) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });

    const account = await base44.asServiceRole.entities.AmazonAccount.get(body.amazon_account_id);
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });
    const marketplace = account.marketplace_id || 'A2Q3Y263D00KWC';
    const accessToken = await token();
    const items = [];
    const seen = new Set();
    let nextToken = null;
    let pages = 0;

    do {
      const query = new URLSearchParams({ details: 'true', granularityType: 'Marketplace', granularityId: marketplace, marketplaceIds: marketplace });
      if (nextToken) query.set('nextToken', nextToken);
      const call = await base44.asServiceRole.functions.invoke('amazonApiGateway', {
        amazon_account_id: body.amazon_account_id,
        api_family: 'SP_API_INVENTORY',
        operation: 'getInventorySummaries',
        endpoint: `${base(account.region)}/fba/inventory/v1/summaries?${query}`,
        method: 'GET',
        headers: {
          'x-amz-access-token': accessToken,
          'x-amz-date': new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''),
          'user-agent': 'LivingFinds/1.0 (Language=TypeScript)',
        },
        queue_type: 'READ',
        max_attempts: 5,
        _service_role: true,
      });
      const result = call?.data || call || {};
      if (!result.ok) throw new Error(result.errors?.[0]?.message || 'Falha ao consultar inventário');
      const data = result.payload || {};
      items.push(...(data?.payload?.inventorySummaries || data?.inventorySummaries || []));
      nextToken = data?.payload?.pagination?.nextToken || data?.pagination?.nextToken || null;
      pages++;
      if (nextToken && seen.has(nextToken)) throw new Error('nextToken repetido no inventário');
      if (nextToken) seen.add(nextToken);
      if (pages >= 100 && nextToken) throw new Error('Limite de 100 páginas atingido');
    } while (nextToken);

    const inventory = new Map();
    for (const item of items) {
      if (!item?.asin) continue;
      const details = item.inventoryDetails || {};
      const available = num(details.fulfillableQuantity);
      const total = num(item.totalQuantity);
      const qty = Math.max(available, total);
      inventory.set(item.asin, {
        sku: item.sellerSku || null,
        available,
        total,
        qty,
        reserved: num(details?.reservedQuantity?.totalReservedQuantity),
        inbound: num(details.inboundWorkingQuantity) + num(details.inboundShippedQuantity) + num(details.inboundReceivingQuantity),
      });
    }

    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: body.amazon_account_id }, '-created_date', 5000);
    let updated = 0;
    let corrected = 0;
    for (const product of products) {
      const remote = inventory.get(product.asin);
      if (!remote) continue;
      const localQty = Math.max(num(product.fba_inventory), num(product.available_quantity), num(product.fulfillable_quantity), num(product.total_quantity), num(product.stock_quantity));
      const qty = Math.max(remote.qty, localQty);
      if (product.inventory_status === 'out_of_stock' && qty > 0) corrected++;
      await base44.asServiceRole.entities.Product.update(product.id, {
        sku: remote.sku || product.sku,
        fba_inventory: qty,
        available_quantity: remote.available,
        total_quantity: remote.total,
        reserved_inventory: remote.reserved,
        inbound_inventory: remote.inbound,
        inventory_status: stockState(qty),
        status: qty > 0 ? 'active' : product.status,
        catalog_sync_status: 'success',
        synced_at: new Date().toISOString(),
        last_catalog_sync_at: new Date().toISOString(),
      });
      updated++;
    }

    return Response.json({ ok: true, pages, inventory_asins: inventory.size, updated, corrected_from_out_of_stock: corrected });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro de sincronização' }, { status: 500 });
  }
});
