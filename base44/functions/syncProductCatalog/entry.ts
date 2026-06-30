/**
 * syncProductCatalog — Importa títulos e dados de produtos via SP-API (Catalog Items + FBA Inventory)
 * Usa credenciais SP-API corretas: AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_SP_REFRESH_TOKEN
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

async function getSPToken() {
  const cached = tokenCache['sp'];
  if (cached && cached.expires_at > Date.now()) return cached.access_token;

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: Deno.env.get('AMAZON_SP_REFRESH_TOKEN'),
    client_id: Deno.env.get('AMAZON_LWA_CLIENT_ID'),
    client_secret: Deno.env.get('AMAZON_LWA_CLIENT_SECRET'),
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`SP-API token failed: ${data.error_description || data.error}`);
  tokenCache['sp'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getSPBaseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://sellingpartnerapi-eu.amazon.com';
  if (r.includes('FE')) return 'https://sellingpartnerapi-fe.amazon.com';
  return 'https://sellingpartnerapi-na.amazon.com';
}

async function spGet(path, marketplaceId) {
  const token = await getSPToken();
  const url = `${getSPBaseUrl()}${path}`;
  const res = await fetch(url, {
    headers: {
      'x-amz-access-token': token,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`SP-API ${res.status} ${path}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function getCatalogItem(asin, marketplaceId) {
  const token = await getSPToken();
  const url = `${getSPBaseUrl()}/catalog/2022-04-01/items/${asin}?marketplaceIds=${marketplaceId}&includedData=summaries,images,attributes`;
  const res = await fetch(url, {
    headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
  });
  if (!res.ok) return null;
  return await res.json();
}

Deno.serve(async (req) => {
  const startTime = Date.now();

  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id } = body;
    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id);
    if (!account) return Response.json({ error: 'Conta não encontrada' }, { status: 404 });

    const marketplaceId = account.marketplace_id || Deno.env.get('AMAZON_MARKETPLACE_ID') || 'A2Q3Y263D00KWC'; // BR

    let totalUpdated = 0;
    const errors = [];

    // ── 1. FBA Inventory ──
    let inventoryMap = {};
    try {
      const invData = await spGet(
        `/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=${marketplaceId}&marketplaceIds=${marketplaceId}`,
        marketplaceId
      );
      const invList = invData?.payload?.inventorySummaries || [];
      for (const item of invList) {
        if (item.asin) {
          inventoryMap[item.asin] = {
            sku: item.sellerSku,
            fba_inventory: item.inventoryDetails?.fulfillableQuantity || item.totalQuantity || 0,
            reserved_inventory: item.inventoryDetails?.reservedQuantity?.totalReservedQuantity || 0,
            inbound_inventory: (item.inventoryDetails?.inboundWorkingQuantity || 0) + (item.inventoryDetails?.inboundShippedQuantity || 0),
          };
        }
      }
    } catch (e) {
      errors.push(`Inventory: ${e.message}`);
    }

    // ── 2. Buscar produtos existentes no banco ──
    const existingProducts = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id },
      '-created_date',
      500
    );

    // ── 3. Para cada produto, buscar título via Catalog Items SP-API ──
    for (const product of existingProducts) {
      try {
        const asin = product.asin;
        const inv = inventoryMap[asin] || {};
        const updateData = {
          synced_at: new Date().toISOString(),
          catalog_sync_status: 'success',
          last_catalog_sync_at: new Date().toISOString(),
        };

        // Inventário
        if (inv.fba_inventory !== undefined) {
          updateData.fba_inventory = inv.fba_inventory;
          updateData.reserved_inventory = inv.reserved_inventory || 0;
          updateData.inbound_inventory = inv.inbound_inventory || 0;
          updateData.sku = inv.sku || product.sku;
          updateData.inventory_status = inv.fba_inventory > 5 ? 'in_stock' : inv.fba_inventory > 0 ? 'low_stock' : 'out_of_stock';
        }

        // Título via SP-API Catalog Items
        try {
          const catalogItem = await getCatalogItem(asin, marketplaceId);
          if (catalogItem) {
            const summary = catalogItem.summaries?.[0] || {};
            const title = summary.itemName || null;
            const image = catalogItem.images?.[0]?.images?.find(i => i.variant === 'MAIN')?.link
              || catalogItem.images?.[0]?.images?.[0]?.link
              || null;

            if (title && title.trim()) {
              updateData.product_name = title.trim();
            }
            if (image) {
              updateData.product_image_url = image;
            }
            if (summary.productType) {
              updateData.category = summary.productType;
            }
          }
        } catch (e) {
          // título não crítico — continua
          updateData.catalog_sync_status = 'error';
          updateData.catalog_sync_error = e.message?.slice(0, 200);
        }

        await base44.asServiceRole.entities.Product.update(product.id, updateData);
        totalUpdated++;
      } catch (e) {
        errors.push(`ASIN ${product.asin}: ${e.message}`);
      }
    }

    // ── 4. Criar produtos do inventário que não existem ainda ──
    for (const [asin, inv] of Object.entries(inventoryMap)) {
      const exists = existingProducts.find(p => p.asin === asin);
      if (!exists) {
        try {
          const newProduct = {
            amazon_account_id,
            asin,
            sku: inv.sku,
            fba_inventory: inv.fba_inventory,
            reserved_inventory: inv.reserved_inventory,
            inbound_inventory: inv.inbound_inventory,
            inventory_status: inv.fba_inventory > 5 ? 'in_stock' : inv.fba_inventory > 0 ? 'low_stock' : 'out_of_stock',
            status: 'active',
            catalog_sync_status: 'pending',
            synced_at: new Date().toISOString(),
          };

          // Tentar obter título
          try {
            const catalogItem = await getCatalogItem(asin, marketplaceId);
            if (catalogItem) {
              const summary = catalogItem.summaries?.[0] || {};
              if (summary.itemName) newProduct.product_name = summary.itemName.trim();
              const image = catalogItem.images?.[0]?.images?.[0]?.link;
              if (image) newProduct.product_image_url = image;
              newProduct.catalog_sync_status = 'success';
            }
          } catch {}

          await base44.asServiceRole.entities.Product.create(newProduct);
          totalUpdated++;
        } catch (e) {
          errors.push(`CreateASIN ${asin}: ${e.message}`);
        }
      }
    }

    return Response.json({
      ok: true,
      total_updated: totalUpdated,
      inventory_asins: Object.keys(inventoryMap).length,
      marketplace_id: marketplaceId,
      duration_ms: Date.now() - startTime,
      errors: errors.slice(0, 10),
    });

  } catch (error) {
    console.error('[syncProductCatalog] Erro:', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});