/**
 * enrichProductNames — busca nomes via Catalog Items API (ASIN) e Listings Items API (SKU)
 * Suporta: token via refresh_token (ADS_REFRESH_TOKEN) OU sp_access_token direto no payload
 * Marketplace Brasil: A2Q3Y263D00KWC
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

let _tokenCache = null;

async function getSpTokenFromRefresh(refreshToken, clientId, clientSecret) {
  if (_tokenCache && _tokenCache.expires_at > Date.now() + 5000) return _tokenCache.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Token error: ${data.error_description || data.error}`);
  _tokenCache = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getSpEndpoint(region) {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://sellingpartnerapi-eu.amazon.com';
  if (r.includes('FE')) return 'https://sellingpartnerapi-fe.amazon.com';
  return 'https://sellingpartnerapi-na.amazon.com';
}

async function fetchSellerId(spBase, token) {
  try {
    const res = await fetch(`${spBase}/sellers/v1/marketplaceParticipations`, {
      headers: { 'x-amz-access-token': token },
    });
    if (!res.ok) {
      const t = await res.text();
      console.log(`[sellerId] HTTP ${res.status}: ${t.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    const participation = data.payload?.[0];
    return participation?.seller?.sellerId || null;
  } catch (e) {
    console.log(`[sellerId] erro: ${e.message}`);
    return null;
  }
}

async function fetchByCatalogAsin(spBase, token, asin, marketplaceId) {
  try {
    const url = `${spBase}/catalog/2022-04-01/items/${asin}?marketplaceIds=${marketplaceId}&includedData=summaries,images`;
    const res = await fetch(url, { headers: { 'x-amz-access-token': token } });
    if (!res.ok) {
      const errText = await res.text();
      console.log(`[catalog] ASIN ${asin} HTTP ${res.status}: ${errText.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    const summary = data.summaries?.find(s => s.marketplaceId === marketplaceId) || data.summaries?.[0];
    const name = summary?.itemName || null;
    const imageGroup = data.images?.find(ig => ig.marketplaceId === marketplaceId) || data.images?.[0];
    const image = imageGroup?.images?.find(i => i.variant === 'MAIN')?.link || imageGroup?.images?.[0]?.link || null;
    const brand = summary?.brandName || null;
    return name ? { name, image, brand, source: 'catalog_asin' } : null;
  } catch (e) {
    console.log(`[catalog] ASIN ${asin} erro: ${e.message}`);
    return null;
  }
}

async function fetchByListingsSku(spBase, token, sellerId, sku, marketplaceId) {
  if (!sellerId) return null;
  try {
    const encodedSku = encodeURIComponent(sku);
    const url = `${spBase}/listings/2021-08-01/items/${sellerId}/${encodedSku}?marketplaceIds=${marketplaceId}&includedData=summaries,attributes`;
    const res = await fetch(url, { headers: { 'x-amz-access-token': token } });
    if (!res.ok) {
      const t = await res.text();
      console.log(`[listings] SKU ${sku} HTTP ${res.status}: ${t.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    const summary = data.summaries?.find(s => s.marketplaceId === marketplaceId) || data.summaries?.[0];
    const name = summary?.itemName || data.attributes?.item_name?.[0]?.value || null;
    const image = summary?.mainImage?.link || null;
    const brand = summary?.brandName || data.attributes?.brand?.[0]?.value || null;
    return name ? { name, image, brand, source: 'listings_sku' } : null;
  } catch (e) {
    console.log(`[listings] SKU ${sku} erro: ${e.message}`);
    return null;
  }
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    let amazonAccountId = body.amazon_account_id;
    const forceAll = body.force_all === true;
    const singleAsin = body.asin || null;
    // Token SP-API direto (access token já obtido externamente)
    const spAccessTokenDirect = body.sp_access_token || null;

    let account = null;
    if (amazonAccountId) {
      account = await base44.asServiceRole.entities.AmazonAccount.get(amazonAccountId).catch(() => null);
    }
    if (!account) {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: user.id });
      account = accounts[0] || (await base44.asServiceRole.entities.AmazonAccount.list())[0] || null;
    }
    if (!account) return Response.json({ ok: false, message: 'Nenhuma conta encontrada' });
    amazonAccountId = account.id;

    const marketplaceId = account.marketplace_id || 'A2Q3Y263D00KWC';
    const region = account.region || 'NA';
    const spBase = getSpEndpoint(region);

    // Obter token SP-API: prioridade ao token direto > secrets canónicos AMAZON_LWA_* > fallback SP_*
    let token = spAccessTokenDirect;
    if (!token) {
      const clientId = Deno.env.get('AMAZON_LWA_CLIENT_ID') || Deno.env.get('SP_CLIENT_ID') || '';
      const clientSecret = Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || Deno.env.get('SP_CLIENT_SECRET') || '';
      const refreshToken = Deno.env.get('AMAZON_SP_REFRESH_TOKEN') || Deno.env.get('SP_REFRESH_TOKEN') || account.ads_refresh_token;
      if (!clientId || clientId.startsWith('amzn1.sp.solution')) {
        return Response.json({ ok: false, message: 'AMAZON_LWA_CLIENT_ID inválido ou ausente. Deve começar com amzn1.application-oa2-client.', note: 'sp_api_config_error' });
      }
      if (!refreshToken) return Response.json({ ok: false, message: 'AMAZON_SP_REFRESH_TOKEN não configurado' });
      try {
        token = await getSpTokenFromRefresh(refreshToken, clientId, clientSecret);
      } catch (e) {
        return Response.json({ ok: false, message: `Falha ao obter token SP-API: ${e.message}` });
      }
    }

    // Obter sellerId
    let sellerId = account.seller_id || null;
    if (!sellerId) {
      sellerId = await fetchSellerId(spBase, token);
      if (sellerId) {
        await base44.asServiceRole.entities.AmazonAccount.update(amazonAccountId, { seller_id: sellerId });
        console.log(`[enrichProductNames] sellerId descoberto e salvo: ${sellerId}`);
      }
    }

    // Buscar produtos alvo
    const allProducts = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id: amazonAccountId }, '-created_date', 500
    );

    let targets;
    if (singleAsin) {
      targets = allProducts.filter(p => p.asin === singleAsin);
    } else if (forceAll) {
      targets = allProducts.filter(p => !p.display_name?.trim());
    } else {
      targets = allProducts.filter(p =>
        !p.product_name?.trim() ||
        p.catalog_sync_status === 'error' ||
        p.catalog_sync_status === 'pending' ||
        p.catalog_sync_status === 'not_found'
      );
    }

    if (targets.length === 0) {
      return Response.json({ ok: true, message: 'Nenhum produto pendente de enriquecimento', enriched: 0, total: 0 });
    }

    console.log(`[enrichProductNames] ${targets.length} produtos. Marketplace: ${marketplaceId}. SellerID: ${sellerId || 'N/A'}. Token: ${token ? token.slice(0, 12) + '...' : 'NONE'}`);

    // Marcar como "syncing"
    await base44.asServiceRole.entities.Product.bulkUpdate(
      targets.map(p => ({ id: p.id, catalog_sync_status: 'syncing' }))
    );

    let enriched = 0, notFound = 0;
    const updates = [];
    const results = [];

    for (const p of targets) {
      if (p.display_name?.trim()) {
        updates.push({ id: p.id, catalog_sync_status: 'success' });
        enriched++;
        continue;
      }

      let found = null;

      // Prioridade 1: Listings Items API (precisa de sellerId + SKU)
      if (sellerId && p.sku) {
        found = await fetchByListingsSku(spBase, token, sellerId, p.sku, marketplaceId);
      }

      // Prioridade 2: Catalog Items API pelo ASIN
      if (!found && p.asin) {
        found = await fetchByCatalogAsin(spBase, token, p.asin, marketplaceId);
      }

      const now = new Date().toISOString();
      if (found?.name) {
        updates.push({
          id: p.id,
          product_name: found.name,
          ...(found.image ? { product_image_url: found.image } : {}),
          ...(found.brand ? { brand: found.brand } : {}),
          catalog_sync_status: 'success',
          last_catalog_sync_at: now,
          catalog_sync_error: null,
          catalog_sync_attempts: (p.catalog_sync_attempts || 0) + 1,
        });
        enriched++;
        results.push({ asin: p.asin, sku: p.sku, name: found.name, source: found.source });
      } else {
        updates.push({
          id: p.id,
          catalog_sync_status: 'not_found',
          last_catalog_sync_at: now,
          catalog_sync_error: sellerId
            ? `Não encontrado no marketplace ${marketplaceId}`
            : `Sem sellerId — verifique permissões SP-API`,
          catalog_sync_attempts: (p.catalog_sync_attempts || 0) + 1,
        });
        notFound++;
        results.push({ asin: p.asin, sku: p.sku, name: null, source: 'not_found' });
      }

      await new Promise(r => setTimeout(r, 300));
    }

    for (let i = 0; i < updates.length; i += 500) {
      await base44.asServiceRole.entities.Product.bulkUpdate(updates.slice(i, i + 500));
    }

    console.log(`[enrichProductNames] Resultado: ${enriched} encontrados, ${notFound} não encontrados`);

    return Response.json({
      ok: true,
      total: targets.length,
      enriched,
      not_found: notFound,
      results,
      marketplace_used: marketplaceId,
      seller_id_used: sellerId || 'não encontrado',
    });

  } catch (error) {
    console.error('[enrichProductNames] Erro:', error.message, error.stack?.slice(0, 300));
    return Response.json({ ok: false, message: error.message });
  }
});