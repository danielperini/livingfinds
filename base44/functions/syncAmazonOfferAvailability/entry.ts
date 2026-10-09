import { offerOnlyProductPatch } from '../../shared/offerInventoryPolicy.ts';
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { listingBuyability } from '../../shared/listingOfferStatus.ts';
import { availableAdsStock } from '../../shared/stockAdsPolicy.ts';

const MARKETPLACE_ID = Deno.env.get('AMAZON_MARKETPLACE_ID') || 'A2Q3Y263D00KWC';

function spBase(region: string) {
  const value = String(region || 'NA').toUpperCase();
  if (value.includes('EU')) return 'https://sellingpartnerapi-eu.amazon.com';
  if (value.includes('FE')) return 'https://sellingpartnerapi-fe.amazon.com';
  return 'https://sellingpartnerapi-na.amazon.com';
}

async function fetchListing(base44: any, account: any, endpoint: string, sellerId: string, sku: string, marketplaceId: string) {
  const url = `${endpoint}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}?marketplaceIds=${marketplaceId}&includedData=summaries,issues,offers,fulfillmentAvailability`;
  const response = await base44.asServiceRole.functions.invoke('amazonApiGateway', {
    amazon_account_id: account.id,
    api_family: 'SP_API_LISTINGS',
    operation: 'getListingsItem',
    endpoint: url,
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    // Para Listings Items, 404 significa simplesmente que aquele SKU não possui
    // listing no marketplace consultado. É estado de catálogo, não falha de sync.
    expected_statuses: [404],
    queue_type: 'READ',
    skip_outside_window_delay: true,
    max_attempts: 5,
    _service_role: true,
  });
  const result = response?.data || response || {};
  if (Number(result.status || result.status_code) === 404) return { notFound: true, data: null };
  if (!result.ok) throw new Error(result.errors?.[0]?.message || result.error || `Listings Items ${sku} falhou`);
  return { notFound: false, data: result.payload?.payload || result.payload || result };
}

function availability(listing: any) {
  const summaries = Array.isArray(listing?.summaries) ? listing.summaries : [];
  const { states,statusKnown,offerActive,buyable,suppressed,issueCodes } = listingBuyability(summaries,listing?.issues);
  const fulfillmentRows = Array.isArray(listing?.fulfillmentAvailability) ? listing.fulfillmentAvailability : [];
  const mfnRows = fulfillmentRows.filter((row: any) => {
    const channel = String(row?.fulfillmentChannelCode || row?.fulfillment_channel_code || '').toUpperCase();
    return channel && channel !== 'AFN' && !channel.includes('AMAZON');
  });
  const mfnQuantity = mfnRows.reduce((sum: number, row: any) => {
    const value = Number(row?.quantity ?? row?.availableQuantity ?? row?.available_quantity ?? 0);
    return sum + (Number.isFinite(value) ? Math.max(0, value) : 0);
  }, 0);
  return {
    offer_active: offerActive,
    listing_status_confirmed: statusKnown,
    listing_suppressed: suppressed,
    listing_buyable: buyable,
    listing_issue_codes: issueCodes,
    reason: suppressed
      ? 'Listing suprimido pela Amazon'
      : !statusKnown
      ? 'Status da oferta não retornado pela Amazon'
      : !offerActive
      ? `Oferta não ativa na Amazon (${states.join(',')})`
      : !buyable
      ? `Oferta sem status BUYABLE na Amazon (${states.join(',')})`
      : '',
    fulfillment_channel: mfnRows.length ? 'MFN' : 'AFN',
    mfn_quantity: mfnRows.length ? mfnQuantity : null,
  };
}

/** Consulta a Amazon antes de permitir que campanhas sejam mantidas/reativadas. */
Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const maxProducts = Math.min(Math.max(Number(body.max_products || 25), 1), 500);
    const requestedSkus = new Set((Array.isArray(body.skus) ? body.skus : [])
      .map((value: any) => String(value || '').trim().toUpperCase()).filter(Boolean));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id })
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });
    const results: any[] = [];

    for (const account of accounts as any[]) {
      const sellerId = account.seller_id || Deno.env.get('AMAZON_SELLER_ID') || '';
      if (!sellerId) {
        results.push({ account_id: account.id, ok: false, error: 'seller_id não configurado' });
        continue;
      }
      const productRows = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: account.id }, '-updated_date', 5000).catch(() => []);
      const products = requestedSkus.size
        ? productRows.filter((product: any) => requestedSkus.has(String(product.sku || '').trim().toUpperCase())).slice(0, maxProducts)
        : productRows.filter((p:any)=>availableAdsStock(p)>0)
          .sort((a:any,b:any)=>(Date.parse(a.listing_checked_at||'')||0)-(Date.parse(b.listing_checked_at||'')||0))
          .slice(0,maxProducts);
      const now = new Date().toISOString();
      let verified = 0, unavailable = 0, failed = 0;
      for (const product of products as any[]) {
        if (!product.sku || product.status === 'archived') continue;
        try {
          const listing = await fetchListing(base44, account, spBase(account.region), sellerId, product.sku, account.marketplace_id || MARKETPLACE_ID);
          const observed: any = listing.notFound
            ? { offer_active: false, listing_suppressed: false, listing_buyable: false, listing_status_confirmed: true, reason: 'SKU não encontrado na Amazon' }
            : availability(listing.data);
          // Resposta sem summary.status é inconclusiva: nunca substitui um estado válido anterior.
          const signal: any = observed.listing_status_confirmed === false
            ? {
                ...observed,
                offer_active: product.offer_active,
                listing_suppressed: product.listing_suppressed,
                listing_buyable: product.listing_buyable,
              }
            : observed;
          await base44.asServiceRole.entities.Product.update(product.id,
            offerOnlyProductPatch(product,signal,observed,now));
          verified++;
          if (!signal.listing_buyable) unavailable++;
        } catch (error: any) {
          // Falha de consulta nunca transforma uma oferta conhecida em indisponível.
          failed++;
          console.warn(`[offer-availability] ${product.sku}: ${error?.message}`);
        }
      }
      results.push({ account_id: account.id, verified, unavailable, failed });
    }
    return Response.json({ ok: true, results });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha ao verificar disponibilidade Amazon' }, { status: 500 });
  }
});
