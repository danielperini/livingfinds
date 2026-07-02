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
  // Pequeno delay para respeitar rate limit (1 req/s no Catalog Items API)
  await new Promise(r => setTimeout(r, 300));
  const res = await fetch(url, {
    headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    if (res.status === 429) throw new Error('Rate limit exceeded');
    return null;
  }
  return await res.json();
}

// Busca todos os ASINs do seller via Listings Items API (paginada)
async function fetchAllListings(marketplaceId, sellerId) {
  const token = await getSPToken();
  const baseUrl = getSPBaseUrl();
  const allItems = [];
  let nextToken = null;

  do {
    let url = `${baseUrl}/listings/2021-08-01/items/${sellerId}?marketplaceIds=${marketplaceId}&includedData=summaries&pageSize=10`;
    if (nextToken) url += `&pageToken=${encodeURIComponent(nextToken)}`;

    const res = await fetch(url, {
      headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Listings API ${res.status}: ${err.slice(0, 200)}`);
    }
    const data = await res.json();
    const items = data?.items || [];
    allItems.push(...items);
    nextToken = data?.pagination?.nextToken || null;
  } while (nextToken);

  return allItems;
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
    const sellerId = account.seller_id || Deno.env.get('AMAZON_SELLER_ID');

    let totalUpdated = 0;
    let newCreated = 0;
    const errors = [];

    // ── 1. FBA Inventory (estoque atual) ──
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

    // ── 2. Listings Items API — todos os ASINs do seller (inclusive sem estoque FBA) ──
    let listingsMap = {}; // asin -> sku
    if (sellerId) {
      try {
        const allListings = await fetchAllListings(marketplaceId, sellerId);
        for (const item of allListings) {
          const asin = item.summaries?.[0]?.asin || item.asin;
          const sku = item.sellerSku;
          if (asin) listingsMap[asin] = sku || null;
        }
      } catch (e) {
        errors.push(`Listings: ${e.message}`);
      }
    }

    // Union de todos os ASINs conhecidos (FBA inventory + Listings)
    const allKnownAsins = new Set([...Object.keys(inventoryMap), ...Object.keys(listingsMap)]);

    // ── 3. Buscar produtos existentes no banco ──
    const existingProducts = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id },
      '-created_date',
      2000
    );
    const existingAsinMap = new Map(existingProducts.map(p => [p.asin, p]));

    // ── 4. Criar produtos que estão na Amazon mas não na base ──
    for (const asin of allKnownAsins) {
      if (existingAsinMap.has(asin)) continue;
      const inv = inventoryMap[asin] || {};
      const sku = inv.sku || listingsMap[asin] || null;
      const newProduct = {
        amazon_account_id,
        asin,
        sku,
        fba_inventory: inv.fba_inventory || 0,
        reserved_inventory: inv.reserved_inventory || 0,
        inbound_inventory: inv.inbound_inventory || 0,
        inventory_status: (inv.fba_inventory || 0) > 5 ? 'in_stock' : (inv.fba_inventory || 0) > 0 ? 'low_stock' : 'out_of_stock',
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
          const image = catalogItem.images?.[0]?.images?.find(i => i.variant === 'MAIN')?.link
            || catalogItem.images?.[0]?.images?.[0]?.link;
          if (image) newProduct.product_image_url = image;
          newProduct.catalog_sync_status = 'success';
        }
      } catch {}
      try {
        await base44.asServiceRole.entities.Product.create(newProduct);
        newCreated++;
        existingAsinMap.set(asin, newProduct); // evitar duplicata
      } catch (e) {
        errors.push(`CreateASIN ${asin}: ${e.message}`);
      }
    }

    // ── 5. Atualizar produtos existentes (inventário + título) ──
    for (const product of existingProducts) {
      try {
        const asin = product.asin;
        const inv = inventoryMap[asin] || {};
        const updateData = {
          synced_at: new Date().toISOString(),
          catalog_sync_status: 'success',
          last_catalog_sync_at: new Date().toISOString(),
        };

        if (inv.fba_inventory !== undefined) {
          updateData.fba_inventory = inv.fba_inventory;
          updateData.reserved_inventory = inv.reserved_inventory || 0;
          updateData.inbound_inventory = inv.inbound_inventory || 0;
          updateData.sku = inv.sku || listingsMap[asin] || product.sku;
          updateData.inventory_status = inv.fba_inventory > 5 ? 'in_stock' : inv.fba_inventory > 0 ? 'low_stock' : 'out_of_stock';
        } else if (listingsMap[asin] !== undefined) {
          // Produto existe nos listings mas sem estoque FBA — manter out_of_stock
          updateData.sku = listingsMap[asin] || product.sku;
          updateData.inventory_status = product.inventory_status || 'out_of_stock';
        }

        // Título via SP-API Catalog Items (só se ainda não tem nome)
        if (!product.product_name || product.catalog_sync_status !== 'success') {
          try {
            const catalogItem = await getCatalogItem(asin, marketplaceId);
            if (catalogItem) {
              const summary = catalogItem.summaries?.[0] || {};
              if (summary.itemName?.trim()) updateData.product_name = summary.itemName.trim();
              const image = catalogItem.images?.[0]?.images?.find(i => i.variant === 'MAIN')?.link
                || catalogItem.images?.[0]?.images?.[0]?.link;
              if (image) updateData.product_image_url = image;
              if (summary.productType) updateData.category = summary.productType;
            }
          } catch (e) {
            updateData.catalog_sync_status = 'error';
            updateData.catalog_sync_error = e.message?.slice(0, 200);
          }
        }

        await base44.asServiceRole.entities.Product.update(product.id, updateData);
        totalUpdated++;
      } catch (e) {
        errors.push(`ASIN ${product.asin}: ${e.message}`);
      }
    }

    return Response.json({
      ok: true,
      total_updated: totalUpdated,
      new_created: newCreated,
      inventory_asins: Object.keys(inventoryMap).length,
      listings_asins: Object.keys(listingsMap).length,
      total_known_asins: allKnownAsins.size,
      marketplace_id: marketplaceId,
      seller_id: sellerId,
      duration_ms: Date.now() - startTime,
      errors: errors.slice(0, 10),
    });

  } catch (error) {
    console.error('[syncProductCatalog] Erro:', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});