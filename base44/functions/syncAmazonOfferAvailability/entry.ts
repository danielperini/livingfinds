import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MARKETPLACE_ID = Deno.env.get('AMAZON_MARKETPLACE_ID') || 'A2Q3Y263D00KWC';

function spBase(region: string) {
  const value = String(region || 'NA').toUpperCase();
  if (value.includes('EU')) return 'https://sellingpartnerapi-eu.amazon.com';
  if (value.includes('FE')) return 'https://sellingpartnerapi-fe.amazon.com';
  return 'https://sellingpartnerapi-na.amazon.com';
}

async function getAccessToken() {
  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: Deno.env.get('AMAZON_SP_REFRESH_TOKEN') || Deno.env.get('SP_REFRESH_TOKEN') || '',
      client_id: Deno.env.get('AMAZON_LWA_CLIENT_ID') || Deno.env.get('SP_CLIENT_ID') || '',
      client_secret: Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || Deno.env.get('SP_CLIENT_SECRET') || '',
    }).toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || `Token SP-API HTTP ${response.status}`);
  return String(data.access_token);
}

async function fetchListing(base44: any, account: any, accessToken: string, endpoint: string, sellerId: string, sku: string, marketplaceId: string) {
  const url = `${endpoint}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}?marketplaceIds=${marketplaceId}&includedData=summaries,issues,offers,fulfillmentAvailability`;
  const response = await base44.asServiceRole.functions.invoke('amazonApiGateway', {
    amazon_account_id: account.id, api_family: 'SP_API_LISTINGS', operation: 'getListingsItem',
    endpoint: url, method: 'GET',
    headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
    queue_type: 'READ', max_attempts: 5, _service_role: true,
  });
  const result = response?.data || response || {};
  if (Number(result.status || result.status_code) === 404) return { notFound: true, data: null };
  if (!result.ok) throw new Error(result.errors?.[0]?.message || result.error || `Listings Items ${sku} falhou`);
  return { notFound: false, data: result.payload?.payload || result.payload || result };
}

function availability(listing: any) {
  const summaries = Array.isArray(listing?.summaries) ? listing.summaries : [];
  const states = summaries.map((summary: any) => String(summary?.status || '').toUpperCase()).filter(Boolean);
  const activeStates = new Set(['ACTIVE', 'BUYABLE', 'DISCOVERABLE']);
  const offerActive = states.length === 0 || states.some((state: string) => activeStates.has(state));
  const issues = Array.isArray(listing?.issues) ? listing.issues : [];
  const suppressed = issues.some((issue: any) => {
    const actions = Array.isArray(issue?.enforcementActions) ? issue.enforcementActions.join('|').toUpperCase() : '';
    return actions.includes('LISTING_SUPPRESSED') || actions.includes('SEARCH_SUPPRESSED');
  });
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
    listing_suppressed: suppressed,
    listing_buyable: offerActive && !suppressed,
    reason: suppressed ? 'Listing suprimido pela Amazon' : !offerActive ? `Oferta não ativa na Amazon (${states.join(',') || 'sem status'})` : '',
    fulfillment_channel: mfnRows.length ? 'MFN' : 'AFN',
    mfn_quantity: mfnRows.length ? mfnQuantity : null,
  };
}

/** Consulta a Amazon antes de permitir que campanhas sejam mantidas/reativadas. */
Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const maxProducts = Math.min(Math.max(Number(body.max_products || 100), 1), 500);
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id })
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });
    const token = await getAccessToken();
    const results: any[] = [];

    for (const account of accounts as any[]) {
      const sellerId = account.seller_id || Deno.env.get('AMAZON_SELLER_ID') || '';
      if (!sellerId) {
        results.push({ account_id: account.id, ok: false, error: 'seller_id não configurado' });
        continue;
      }
      const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: account.id }, '-updated_date', maxProducts).catch(() => []);
      const now = new Date().toISOString();
      let verified = 0, unavailable = 0, failed = 0;
      for (const product of products as any[]) {
        if (!product.sku) continue;
        try {
          const listing = await fetchListing(base44, account, token, spBase(account.region), sellerId, product.sku, account.marketplace_id || MARKETPLACE_ID);
          const signal: any = listing.notFound
            ? { offer_active: false, listing_suppressed: false, listing_buyable: false, reason: 'SKU não encontrado na Amazon' }
            : availability(listing.data);
          const effectiveQuantity = signal.fulfillment_channel === 'MFN'
            ? Number(signal.mfn_quantity || 0)
            : Number(product.available_quantity ?? product.fba_inventory ?? 0);
          const eligibility = signal.listing_suppressed ? 'listing_suppressed'
            : !signal.offer_active ? 'offer_inactive'
            : !signal.listing_buyable ? 'not_buyable'
            : effectiveQuantity <= 0 ? 'out_of_stock'
            : 'eligible';
          await base44.asServiceRole.entities.Product.update(product.id, {
            ...signal,
            ...(signal.fulfillment_channel === 'MFN' ? {
              available_quantity: effectiveQuantity,
              fba_inventory: effectiveQuantity,
              inventory_status: effectiveQuantity > 5 ? 'in_stock' : effectiveQuantity > 0 ? 'low_stock' : 'out_of_stock',
              status: effectiveQuantity > 0 ? 'active' : 'inactive',
              catalog_sync_status: 'listing_mfn_verified',
            } : {}),
            ads_eligibility_status: eligibility,
            ads_ineligibility_reason: signal.reason || (eligibility === 'out_of_stock' ? 'Estoque disponível zero' : ''),
            ads_last_eligibility_check_at: now,
          });
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
