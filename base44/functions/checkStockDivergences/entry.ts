// Compara fba_inventory do banco local com a Amazon SP-API e retorna divergências
// Também atualiza automaticamente os registros divergentes no banco
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const stockState = (qty) => qty > 5 ? 'in_stock' : qty > 0 ? 'low_stock' : 'out_of_stock';

async function getSpToken() {
  const refresh = Deno.env.get('AMAZON_SP_REFRESH_TOKEN') || Deno.env.get('SP_REFRESH_TOKEN');
  const client = Deno.env.get('AMAZON_LWA_CLIENT_ID') || Deno.env.get('SP_CLIENT_ID');
  const secret = Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || Deno.env.get('SP_CLIENT_SECRET');
  if (!refresh || !client || !secret) throw new Error('Credenciais SP-API incompletas');
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: client, client_secret: secret }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) throw new Error(data.error_description || 'Falha no token SP-API');
  return data.access_token;
}

function apiBase(region) {
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
    if (!auth && !body._service_role) return Response.json({ error: 'Não autorizado' }, { status: 401 });

    const accounts = body.amazon_account_id
      ? [await base44.asServiceRole.entities.AmazonAccount.get(body.amazon_account_id)].filter(Boolean)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });

    if (!accounts.length) return Response.json({ ok: true, divergences: [], total: 0 });

    const allDivergences = [];
    let totalAutoFixed = 0;

    for (const account of accounts) {
      const marketplace = account.marketplace_id || 'A2Q3Y263D00KWC';
      const base = apiBase(account.region);
      const accessToken = await getSpToken().catch(() => null);
      if (!accessToken) continue;

      // Buscar inventário real da Amazon
      const amazonQty = new Map(); // asin → qty
      let nextToken = null;
      let pages = 0;
      do {
        const query = new URLSearchParams({ details: 'true', granularityType: 'Marketplace', granularityId: marketplace, marketplaceIds: marketplace });
        if (nextToken) query.set('nextToken', nextToken);
        const res = await fetch(`${base}/fba/inventory/v1/summaries?${query}`, {
          headers: { 'x-amz-access-token': accessToken, 'user-agent': 'LivingFinds/1.0' },
        });
        if (!res.ok) break;
        const data = await res.json().catch(() => ({}));
        const summaries = data?.payload?.inventorySummaries || data?.inventorySummaries || [];
        for (const item of summaries) {
          if (!item?.asin) continue;
          const details = item.inventoryDetails || {};
          const qty = Math.max(num(details.fulfillableQuantity), num(item.totalQuantity));
          amazonQty.set(String(item.asin).toUpperCase(), qty);
        }
        nextToken = data?.payload?.pagination?.nextToken || data?.pagination?.nextToken || null;
        pages++;
        if (pages >= 50) break;
      } while (nextToken);

      if (!amazonQty.size) continue;

      // Buscar produtos locais
      const products = await base44.asServiceRole.entities.Product.filter(
        { amazon_account_id: account.id, status: 'active' }, null, 1000
      ).catch(() => []);

      const now = new Date().toISOString();

      for (const product of products) {
        const asin = String(product.asin || '').toUpperCase();
        if (!amazonQty.has(asin)) continue;

        const amazonStock = amazonQty.get(asin);
        const localStock = num(product.fba_inventory);

        // Divergência: diferença > 0 unidades
        if (amazonStock !== localStock) {
          allDivergences.push({
            asin: product.asin,
            sku: product.sku || null,
            product_name: product.display_name || product.product_name || product.asin,
            local_stock: localStock,
            amazon_stock: amazonStock,
            local_status: product.inventory_status,
            amazon_status: stockState(amazonStock),
            campaign_status: product.campaign_status || 'none',
            account_id: account.id,
            product_id: product.id,
          });

          // Auto-corrigir imediatamente
          await base44.asServiceRole.entities.Product.update(product.id, {
            fba_inventory: amazonStock,
            inventory_status: stockState(amazonStock),
            status: amazonStock > 0 ? 'active' : (product.status || 'inactive'),
            previous_fba_inventory: localStock,
            previous_inventory_status: product.inventory_status,
            last_sync_at: now,
            synced_at: now,
          }).catch(() => {});
          totalAutoFixed++;
        }
      }
    }

    return Response.json({
      ok: true,
      divergences: allDivergences,
      total: allDivergences.length,
      auto_fixed: totalAutoFixed,
      checked_at: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[checkStockDivergences]', error?.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});