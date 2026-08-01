/**
 * syncListingEnhancementData
 * Sincroniza listing atual de cada produto via SP-API Listings Items.
 * Persiste snapshot, campos editáveis, ausentes e issues Amazon.
 * Não altera campanhas, bids ou keywords patrocinadas.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MARKETPLACE_ID = Deno.env.get('AMAZON_MARKETPLACE_ID') || 'A2Q3Y263D00KWC';
// Prioridade: variáveis LWA padrão (confirmadas por checkSpApiConnection), fallback para variáveis SP
const SP_CLIENT_ID = Deno.env.get('AMAZON_LWA_CLIENT_ID') || Deno.env.get('SP_CLIENT_ID') || '';
const SP_CLIENT_SECRET = Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || Deno.env.get('SP_CLIENT_SECRET') || '';
const SP_REFRESH_TOKEN = Deno.env.get('AMAZON_SP_REFRESH_TOKEN') || Deno.env.get('SP_REFRESH_TOKEN') || '';

async function getSpAccessToken(): Promise<string> {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: SP_REFRESH_TOKEN,
      client_id: SP_CLIENT_ID,
      client_secret: SP_CLIENT_SECRET,
    }).toString(),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`SP-API token error: ${res.status} ${err}`);
  }
  const data = await res.json();
  return data.access_token;
}

function spApiBase(region: string): string {
  const normalized = String(region || 'NA').toUpperCase();
  if (normalized.includes('EU')) return 'https://sellingpartnerapi-eu.amazon.com';
  if (normalized.includes('FE')) return 'https://sellingpartnerapi-fe.amazon.com';
  return 'https://sellingpartnerapi-na.amazon.com';
}

async function fetchListingItem(base44: any, account: any, accessToken: string, sellerId: string, sku: string, marketplaceId: string): Promise<any> {
  const encodedSku = encodeURIComponent(sku);
  const endpoint = `${spApiBase(account.region)}/listings/2021-08-01/items/${sellerId}/${encodedSku}?marketplaceIds=${marketplaceId}&includedData=summaries,attributes,issues,offers,fulfillmentAvailability`;
  const response = await base44.asServiceRole.functions.invoke('amazonApiGateway', {
    amazon_account_id: account.id, api_family: 'SP_API_LISTINGS', operation: 'getListingsItem',
    endpoint, method: 'GET',
    headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
    queue_type: 'READ', max_attempts: 5, _service_role: true,
  });
  const result = response?.data || response || {};
  if (result.status === 404 || result.status_code === 404) return null;
  if (!result.ok) throw new Error(result.errors?.[0]?.message || result.error || `Falha ao consultar listing ${sku}`);
  return result.payload?.payload || result.payload || result;
}

async function fetchProductTypeDefinition(accessToken: string, productType: string, marketplaceId: string): Promise<any> {
  const url = `https://sellingpartnerapi-na.amazon.com/definitions/2020-09-01/productTypes/${encodeURIComponent(productType)}?marketplaceIds=${marketplaceId}&requirements=LISTING`;
  const res = await fetch(url, {
    headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
  });
  if (!res.ok) return null;
  return res.json();
}

function extractEditableFields(schema: any): { editable: string[]; required: string[] } {
  if (!schema?.schema?.properties) return { editable: [], required: [] };
  const editable: string[] = [];
  const required: string[] = schema?.schema?.required || [];
  for (const [key, def] of Object.entries(schema.schema.properties as Record<string, any>)) {
    const enforcement = def?.['x-amazon-attributes']?.enforcement;
    if (enforcement !== 'NOT_APPLICABLE') editable.push(key);
  }
  return { editable, required };
}

function extractMissingFields(attributes: any, required: string[]): string[] {
  const missing: string[] = [];
  for (const field of required) {
    const val = attributes?.[field];
    if (!val || (Array.isArray(val) && val.length === 0)) missing.push(field);
  }
  return missing;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, asin, sku: skuParam, limit = 10, basic_only = false } = body;

    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id obrigatório' }, { status: 400 });

    // Buscar conta
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id });
    const account = accounts[0];
    if (!account) return Response.json({ error: 'Conta não encontrada' }, { status: 404 });

    const sellerId = account.seller_id || Deno.env.get('AMAZON_SELLER_ID') || '';
    const marketplaceId = account.marketplace_id || MARKETPLACE_ID;

    if (!sellerId) {
      return Response.json({ ok: false, error: 'seller_id não configurado. Configure o Seller ID em Integrações → Amazon (SP-API).' }, { status: 400 });
    }

    // Buscar produtos
    let products: any[];
    if (asin) {
      products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id, asin });
    } else if (skuParam) {
      products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id, sku: skuParam });
    } else {
      products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id, status: 'active' }, '-created_date', limit);
    }

    if (!products.length) return Response.json({ ok: true, synced: 0, message: 'Nenhum produto encontrado' });

    let accessToken: string;
    try {
      accessToken = await getSpAccessToken();
    } catch (e: any) {
      return Response.json({ ok: false, error: `Erro ao obter token SP-API: ${e.message}` }, { status: 503 });
    }

    const now = new Date().toISOString();
    const results: any[] = [];

    for (const product of products) {
      const sku = product.sku;
      if (!sku) { results.push({ asin: product.asin, status: 'skipped', reason: 'no_sku' }); continue; }

      try {
        const listing = await fetchListingItem(base44, account, accessToken, sellerId, sku, marketplaceId);

        if (!listing) {
          await base44.asServiceRole.entities.Product.update(product.id, {
            listing_status: 'not_found',
            listing_buyable: false,
            listing_checked_at: now,
          }).catch(() => {});
          results.push({ asin: product.asin, sku, status: 'not_found' });
          continue;
        }

        // Extrair dados do listing
        const summaries = listing.summaries?.[0] || {};
        const attributes = listing.attributes || {};
        const issues = listing.issues || [];
        const offers = listing.offers || [];

        const productType = summaries.itemClassification || listing.productType || '';

        // Buscar Product Type Definition
        let schemaFields: any = null;
        let editableFields: string[] = [];
        let requiredFields: string[] = [];

        if (productType && basic_only !== true) {
          const ptDef = await fetchProductTypeDefinition(accessToken, productType, marketplaceId).catch(() => null);
          if (ptDef) {
            const extracted = extractEditableFields(ptDef);
            editableFields = extracted.editable;
            requiredFields = extracted.required;
            schemaFields = { product_type: productType, editable: editableFields, required: requiredFields };
          }
        }

        const missingFields = extractMissingFields(attributes, requiredFields);

        // Extrair campos principais
        const titleArr = attributes?.item_name || attributes?.title || [];
        const title = Array.isArray(titleArr) ? (titleArr[0]?.value || '') : (titleArr || '');

        const bulletsArr = attributes?.bullet_point || [];
        const bullets = Array.isArray(bulletsArr) ? bulletsArr.map((b: any) => b?.value || b).filter(Boolean) : [];

        const descArr = attributes?.product_description || attributes?.description || [];
        const description = Array.isArray(descArr) ? (descArr[0]?.value || '') : (descArr || '');

        const termsArr = attributes?.generic_keyword || attributes?.search_terms || [];
        const organicTerms = Array.isArray(termsArr) ? termsArr.map((t: any) => t?.value || t).filter(Boolean) : [];

        const imagesArr = attributes?.main_product_image_locator || attributes?.other_product_image_locator_1 ? [
          ...(attributes?.main_product_image_locator || []),
          ...(attributes?.other_product_image_locator_1 || []),
          ...(attributes?.other_product_image_locator_2 || []),
          ...(attributes?.other_product_image_locator_3 || []),
        ] : [];

        const priceVal = offers?.[0]?.price?.listingPrice?.amount || 0;
        const listingStates = (Array.isArray(summaries.status)
          ? summaries.status
          : [summaries.status])
          .map((value: any) => String(value || '').toUpperCase())
          .filter(Boolean);
        const blockingIssues = issues.filter((issue: any) =>
          String(issue?.severity || '').toUpperCase() === 'ERROR'
        );
        const listingBuyable = listingStates.includes('BUYABLE') && blockingIssues.length === 0;

        await base44.asServiceRole.entities.Product.update(product.id, {
          ...(title ? { product_name: title, display_name: title } : {}),
          ...(priceVal > 0 ? { price: priceVal, price_source: 'sp_api_listings_items' } : {}),
          listing_status: listingBuyable ? 'active' : 'inactive',
          listing_buyable: listingBuyable,
          listing_checked_at: now,
          listing_issues_count: issues.length,
          catalog_sync_status: 'success',
          catalog_sync_error: null,
        });

        // Persistir snapshot
        const existingSnaps = await base44.asServiceRole.entities.ListingSnapshot.filter({ amazon_account_id, asin: product.asin }, '-created_at', 1).catch(() => []);
        const snapData = {
          amazon_account_id,
          marketplace_id: marketplaceId,
          product_id: product.id,
          asin: product.asin,
          sku,
          product_type: productType,
          title,
          bullets: JSON.stringify(bullets),
          description,
          organic_terms: JSON.stringify(organicTerms),
          attributes: JSON.stringify(attributes),
          images: JSON.stringify(imagesArr),
          price: priceVal,
          offer_data: JSON.stringify({ offers }),
          schema_fields: JSON.stringify(schemaFields || {}),
          required_fields: JSON.stringify(requiredFields),
          missing_fields: JSON.stringify(missingFields),
          amazon_issues: JSON.stringify(issues),
          sync_source: 'sp_api',
          sync_status: 'success',
          synced_at: now,
          created_at: now,
        };

        let snapshotId: string;
        if (existingSnaps.length > 0) {
          await base44.asServiceRole.entities.ListingSnapshot.update(existingSnaps[0].id, { ...snapData });
          snapshotId = existingSnaps[0].id;
        } else {
          const created = await base44.asServiceRole.entities.ListingSnapshot.create(snapData);
          snapshotId = created.id;
        }

        results.push({
          asin: product.asin,
          sku,
          status: 'synced',
          product_type: productType,
          editable_fields: editableFields.length,
          missing_fields: missingFields.length,
          issues_count: issues.length,
          snapshot_id: snapshotId,
        });

      } catch (e: any) {
        results.push({ asin: product.asin, sku, status: 'error', error: e.message });
      }
    }

    const synced = results.filter(r => r.status === 'synced').length;
    return Response.json({ ok: true, synced, total: products.length, results });

  } catch (error: any) {
    console.error('[syncListingEnhancementData]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});
