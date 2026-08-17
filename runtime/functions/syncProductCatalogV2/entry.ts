import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { normalizeSku } from '../../shared/repricingPolicy.ts';

let tokenCache:any = null;
const num = (v:any) => Number.isFinite(Number(v)) ? Number(v) : 0;
const stockState = (qty:number) => qty > 5 ? 'in_stock' : qty > 0 ? 'low_stock' : 'out_of_stock';
const normSku = normalizeSku;

async function token() {
  if (tokenCache?.expiresAt > Date.now()) return tokenCache.value;
  const refresh = Deno.env.get('AMAZON_SP_REFRESH_TOKEN') || Deno.env.get('SP_REFRESH_TOKEN');
  const client = Deno.env.get('AMAZON_LWA_CLIENT_ID') || Deno.env.get('SP_CLIENT_ID');
  const secret = Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || Deno.env.get('SP_CLIENT_SECRET');
  if (!refresh || !client || !secret) throw new Error('Credenciais SP-API incompletas.');
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: client, client_secret: secret }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || 'Falha no token SP-API');
  tokenCache = { value: data.access_token, expiresAt: Date.now() + (num(data.expires_in || 3600) - 60) * 1000 };
  return tokenCache.value;
}

function apiBase(region:any) {
  const r = String(region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://sellingpartnerapi-eu.amazon.com';
  if (r.includes('FE')) return 'https://sellingpartnerapi-fe.amazon.com';
  return 'https://sellingpartnerapi-na.amazon.com';
}

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
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
    const items:any[] = [];
    const seen = new Set();
    let nextToken:any = null;
    let pages = 0;

    do {
      const query = new URLSearchParams({ details: 'true', granularityType: 'Marketplace', granularityId: marketplace, marketplaceIds: marketplace });
      if (nextToken) query.set('nextToken', nextToken);
      const call = await base44.asServiceRole.functions.invoke('amazonApiGateway', {
        amazon_account_id: body.amazon_account_id,
        api_family: 'SP_API_INVENTORY', operation: 'getInventorySummaries',
        endpoint: `${apiBase(account.region)}/fba/inventory/v1/summaries?${query}`,
        method: 'GET',
        headers: { 'x-amz-access-token': accessToken, 'x-amz-date': new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''), 'user-agent': 'LivingFinds/1.0 (Language=TypeScript)' },
        queue_type: 'READ', max_attempts: 5, _service_role: true,
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

    // Uma resposta vazia não prova estoque zero. Evita transformar todo o
    // catálogo em inativo quando a SP-API retorna payload incompleto.
    if (items.length === 0) {
      throw new Error('SP-API retornou inventário vazio; catálogo preservado sem marcar produtos como inativos.');
    }

    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: body.amazon_account_id }, '-created_date', 5000);
    const byAsin = new Map<string, any[]>();
    const bySku = new Map<string, any[]>();
    for (const product of products) {
      const asinKey = String(product.asin || '').trim().toUpperCase();
      const skuKey = normSku(product.sku);
      if (asinKey) byAsin.set(asinKey, [...(byAsin.get(asinKey) || []), product]);
      if (skuKey) bySku.set(skuKey, [...(bySku.get(skuKey) || []), product]);
    }
    let created = 0, updated = 0, corrected = 0, pendingCostConfirmation = 0, mappingConflicts = 0, markedAbsent = 0;
    const now = new Date().toISOString();
    const seenProductIds = new Set<string>();

    for (const item of items) {
      if (!item?.asin) continue;
      const asin = String(item.asin).trim().toUpperCase();
      const sku = item.sellerSku || null;
      const skuKey = normSku(sku);
      const details = item.inventoryDetails || {};
      const available = num(details.fulfillableQuantity);
      const total = num(item.totalQuantity);
      const skuMatches = skuKey ? bySku.get(skuKey) || [] : [];
      const asinMatches = byAsin.get(asin) || [];
      if (skuMatches.length > 1) {
        mappingConflicts++;
        continue;
      }
      // SKU do seller é a identidade canônica. ASIN só é fallback quando a
      // Amazon não retorna sellerSku e existe um único produto para o ASIN.
      const existing:any = skuMatches[0] || (!skuKey && asinMatches.length === 1 ? asinMatches[0] : null);
      if (existing?.id) seenProductIds.add(existing.id);
      const patch:any = {
        amazon_account_id: body.amazon_account_id,
        asin, sku: sku || existing?.sku || null,
        previous_inventory_status: existing?.inventory_status || null,
        previous_fba_inventory: num(existing?.fba_inventory),
        fba_inventory: total,
        available_quantity: available,
        total_quantity: total,
        reserved_inventory: num(details?.reservedQuantity?.totalReservedQuantity),
        inbound_inventory: num(details.inboundWorkingQuantity) + num(details.inboundShippedQuantity) + num(details.inboundReceivingQuantity),
        inventory_status: stockState(available),
        status: available > 0 ? 'active' : 'inactive',
        catalog_sync_status: 'success', synced_at: now, last_catalog_sync_at: now,
      };
      if (!existing?.cost_confirmed) pendingCostConfirmation++;

      if (existing) {
        if (existing.inventory_status === 'out_of_stock' && available > 0) corrected++;
        // Nunca altera custos ou confirmações informados pelo usuário.
        await base44.asServiceRole.entities.Product.update(existing.id, patch);
        updated++;
      } else {
        const createdProduct = await base44.asServiceRole.entities.Product.create({
          ...patch,
          product_name: sku || asin,
          display_name: '',
          is_new_asin: true,
          has_campaign: false,
          campaign_status: 'none',
          should_activate_campaign: false,
          first_available_date: now.slice(0, 10),
          cost_confirmation_required: true,
          cost_confirmed: false,
          cost_source: 'unknown',
          keyword_confidence_threshold: 0.95,
          auto_campaign_eligible: false,
        });
        byAsin.set(asin, [...(byAsin.get(asin) || []), createdProduct]);
        if (skuKey) bySku.set(skuKey, [...(bySku.get(skuKey) || []), createdProduct]);
        if (createdProduct?.id) seenProductIds.add(createdProduct.id);
        created++;
      }
    }

    for (const product of products) {
      if (!product?.id || product.status === 'archived' || seenProductIds.has(product.id)) continue;
      await base44.asServiceRole.entities.Product.update(product.id, {
        previous_inventory_status: product.inventory_status || null,
        previous_fba_inventory: num(product.fba_inventory),
        fba_inventory: 0,
        available_quantity: 0,
        total_quantity: 0,
        inventory_status: 'out_of_stock',
        status: 'inactive',
        catalog_sync_status: 'not_found',
        catalog_sync_error: 'SKU ausente na resposta completa da FBA Inventory API.',
        synced_at: now,
        last_catalog_sync_at: now,
      }).catch(() => {});
      markedAbsent++;
    }

    const completedAt = new Date().toISOString();
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: body.amazon_account_id,
      operation: 'sync_product_catalog_v2', status: 'success', trigger_type: body.trigger_type || 'manual',
      started_at: startedAt, completed_at: completedAt, records_processed: created + updated,
      result_summary: JSON.stringify({ pages, inventory_asins: items.length, created, updated, corrected, marked_absent: markedAbsent, mapping_conflicts: mappingConflicts, costs_preserved: true, pending_cost_confirmation: pendingCostConfirmation }).slice(0, 4000),
    }).catch(() => {});

    // Sinalizar dado fresco de SP-API para todas as páginas
    await base44.asServiceRole.entities.AmazonAccount.update(body.amazon_account_id, {
      sp_data_last_sync_at: completedAt,
      last_sync_at: completedAt,
    }).catch(() => {});

    return Response.json({ ok: true, pages, inventory_asins: items.length, created, updated, marked_absent: markedAbsent, mapping_conflicts: mappingConflicts, corrected_from_out_of_stock: corrected, costs_preserved: true, pending_cost_confirmation: pendingCostConfirmation });
  } catch (error:any) {
    return Response.json({ ok: false, error: error?.message || 'Erro de sincronização' }, { status: 500 });
  }
});
