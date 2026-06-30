/**
 * enrichProductNames — busca nomes e imagens de produtos via SP-API Catalog Items
 * e atualiza Product.product_name + Product.product_image_url no banco.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

let _tokenCache = null;

async function getSpToken(refreshToken) {
  if (_tokenCache && _tokenCache.expires_at > Date.now() + 5000) return _tokenCache.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: Deno.env.get('ADS_CLIENT_ID') || '',
    client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
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

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    let amazonAccountId = body.amazon_account_id;

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

    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    if (!refreshToken) return Response.json({ ok: false, message: 'Sem refresh_token configurado' });

    const marketplaceId = account.marketplace_id || 'ATVPDKIKX0DER'; // US default
    const region = account.region || 'NA';
    const spBase = getSpEndpoint(region);

    // Buscar produtos sem nome
    const products = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id: amazonAccountId },
      '-created_date',
      500
    );

    const withoutName = products.filter(p => !p.product_name);
    if (withoutName.length === 0) {
      return Response.json({ ok: true, message: 'Todos os produtos já têm nome', enriched: 0 });
    }

    console.log(`[enrichProductNames] Enriquecendo ${withoutName.length} produtos sem nome`);

    const token = await getSpToken(refreshToken);

    // Processar em lotes de 20 (limite da API)
    let enriched = 0;
    const updates = [];

    for (let i = 0; i < withoutName.length; i += 20) {
      const batch = withoutName.slice(i, i + 20);
      const asins = batch.map(p => p.asin).join(',');

      try {
        const res = await fetch(
          `${spBase}/catalog/2022-04-01/items?identifiers=${asins}&identifiersType=ASIN&marketplaceIds=${marketplaceId}&includedData=summaries,images`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'x-amz-access-token': token,
              'Content-Type': 'application/json',
            },
          }
        );

        if (!res.ok) {
          console.warn(`[enrichProductNames] Batch ${i/20 + 1} falhou: HTTP ${res.status}`);
          // Fallback: usar SKU como nome
          for (const p of batch) {
            if (!p.product_name) {
              updates.push({ id: p.id, product_name: `ASIN ${p.asin}` });
            }
          }
          continue;
        }

        const data = await res.json();
        const itemMap = {};
        for (const item of (data.items || [])) {
          const asin = item.asin;
          const summary = item.summaries?.[0];
          const image = item.images?.[0]?.images?.find(img => img.variant === 'MAIN') || item.images?.[0]?.images?.[0];
          itemMap[asin] = {
            name: summary?.itemName || summary?.brandName || null,
            image: image?.link || null,
          };
        }

        for (const p of batch) {
          const info = itemMap[p.asin];
          if (info?.name) {
            updates.push({
              id: p.id,
              product_name: info.name,
              ...(info.image ? { product_image_url: info.image } : {}),
            });
            enriched++;
          } else {
            // Fallback: marcar com ASIN para não tentar de novo
            updates.push({ id: p.id, product_name: `ASIN ${p.asin}` });
          }
        }
      } catch (e) {
        console.warn(`[enrichProductNames] Erro no batch: ${e.message}`);
        for (const p of batch) {
          updates.push({ id: p.id, product_name: `ASIN ${p.asin}` });
        }
      }

      // Pequena pausa entre batches para evitar rate limit
      if (i + 20 < withoutName.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // Salvar tudo em bulk
    for (let i = 0; i < updates.length; i += 500) {
      await base44.asServiceRole.entities.Product.bulkUpdate(updates.slice(i, i + 500));
    }

    console.log(`[enrichProductNames] Concluído: ${enriched} enriquecidos de ${withoutName.length}`);
    return Response.json({
      ok: true,
      total: withoutName.length,
      enriched,
      fallback: withoutName.length - enriched,
    });

  } catch (error) {
    console.error('[enrichProductNames] Erro:', error.message);
    return Response.json({ ok: false, message: error.message }, { status: 500 });
  }
});