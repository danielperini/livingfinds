import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

let tokenCache:any = null;
const num = (v:any) => Number.isFinite(Number(v)) ? Number(v) : 0;
const stockState = (qty:number) => qty > 5 ? 'in_stock' : qty > 0 ? 'low_stock' : 'out_of_stock';
const normSku = (value:any) => String(value || '').trim().toUpperCase().replace(/\s+/g, '');

const COSTS:Record<string,[number,number]> = {
'FBA-0100':[240,2],'SKU-002314V':[45,2],'FBA-0087C':[41,2],'SKU-002314A':[45,2],'FBA-0008V':[40,2],'FBA-0008P':[40,2],'FBA-0076B':[40,2],'FBA-0076A':[40,2],'FBA-0087':[40.95,0],'FBA-0087B':[40.95,2],'FBA-0010A':[52,48],'FBA-0072B':[44.1,2],'FBA-0083':[80,2],'V5-WDPF-0AV5':[50.4,2],'70-FCMB-TFYO':[83,1.5],'1T-4NZZ-5S38':[22.9,2],'RZ-3VOK-GD4I':[22.9,2],'FBA-0047B':[28,2],'1T-TZDB-HJSA':[19.99,2],'FBA-0072':[51.4,2],'8O-M2FX-4T4P':[22.9,2],'RI-7PWG-L37T':[21.9,2],'FBA-0088A':[23,2],'07-UMIB-CCP5':[19.99,2],'FBA-0045':[90,2],'FBA-0070':[50.4,2],'FBA-0010B':[57.55,2],'FBA-0073':[50.4,2],'FBA-0065PRCI':[20,1.5],'FBA-0080':[22,2],'FBA-0026P':[255,2],'FBA0017':[11,2],'FBA-0032':[47,2],'FBA-0074':[50.4,2],'FBA-0077A':[39.9,2],'FBA-0065AZ':[20,1.5],'FBA-0071':[52.5,2],'FBA-0077B':[44.1,2],'FBA-0077C':[47.25,2],'FBA-0065PR':[20,1.5],'FBA-0099A':[61,1.5],'FBA-0099':[68,1.5],'LIXEIRA17LITROS':[58,2],'CARRINHOESTOQUEE':[160,1.5],'FBA-0065RO':[20,1.5],'FBA-0065PRAC':[20,1.5],'FBA-0062VAR-001':[40,1.5],'FBA-0054':[58,2],'FBA-0065PRBE':[26,1.5],'FBA-0040A':[27,2],'54-I8UF-L01T':[13.5,2],'FBA-0030C':[76,1.5],'FBA-0062VAR-003':[40,1.5],'FBA-0062VAR-002':[40,1.5],'FBA-0024B':[38.5,1.5],'FBA-0057':[35,1.5],'FBA-0058':[59,1.5],'FBA-0056':[51.4,2],'FBA-0055':[72,2],'FBA-0047':[28,2],'FBA-0040':[25,1.5],'67-X650-F3O4':[55,2],'FBA-0030A':[62,4],'FBA-0034':[72,2],'FBA-0027':[233,2],'FBA-0020':[18,2],'FBA-0026':[255,2],'FBA-0018':[11,2],'FBA-0014':[12.5,2],'XK-MFCD-NNN9':[19,2],'FBA-0010':[54.6,2]
};

async function token() {
  if (tokenCache?.expiresAt > Date.now()) return tokenCache.value;
  const refresh = Deno.env.get('AMAZON_SP_REFRESH_TOKEN') || Deno.env.get('SP_REFRESH_TOKEN');
  const client = Deno.env.get('AMAZON_LWA_CLIENT_ID') || Deno.env.get('SP_CLIENT_ID');
  const secret = Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || Deno.env.get('SP_CLIENT_SECRET');
  if (!refresh || !client || !secret) throw new Error('Credenciais SP-API incompletas.');
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: client, client_secret: secret }),
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

function costPatch(sku:any, product:any = null) {
  const known = COSTS[normSku(sku)];
  if (known) {
    const [productCost, extraCost] = known;
    return {
      product_cost: productCost,
      extra_cost: extraCost,
      cost_source: 'historical_import',
      cost_confirmation_required: product?.cost_confirmed === true ? false : true,
      cost_confirmed: product?.cost_confirmed === true,
      keyword_confidence_threshold: 0.95,
      auto_campaign_eligible: product?.cost_confirmed === true,
    };
  }
  return {
    cost_confirmation_required: true,
    cost_confirmed: false,
    cost_source: 'unknown',
    keyword_confidence_threshold: 0.95,
    auto_campaign_eligible: false,
  };
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

    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: body.amazon_account_id }, '-created_date', 5000);
    const byAsin = new Map(products.map((p:any) => [String(p.asin || '').toUpperCase(), p]));
    const bySku = new Map(products.filter((p:any) => p.sku).map((p:any) => [normSku(p.sku), p]));
    let created = 0, updated = 0, corrected = 0, costsLoaded = 0, pendingCostConfirmation = 0;
    const now = new Date().toISOString();

    for (const item of items) {
      if (!item?.asin) continue;
      const asin = String(item.asin).trim().toUpperCase();
      const sku = item.sellerSku || null;
      const details = item.inventoryDetails || {};
      const available = num(details.fulfillableQuantity);
      const total = num(item.totalQuantity);
      const qty = Math.max(available, total);
      const existing:any = byAsin.get(asin) || bySku.get(normSku(sku));
      const patch:any = {
        amazon_account_id: body.amazon_account_id,
        asin, sku: sku || existing?.sku || null,
        fba_inventory: qty,
        available_quantity: available,
        total_quantity: total,
        reserved_inventory: num(details?.reservedQuantity?.totalReservedQuantity),
        inbound_inventory: num(details.inboundWorkingQuantity) + num(details.inboundShippedQuantity) + num(details.inboundReceivingQuantity),
        inventory_status: stockState(qty),
        status: qty > 0 ? 'active' : (existing?.status || 'inactive'),
        catalog_sync_status: 'success', synced_at: now, last_catalog_sync_at: now,
        ...costPatch(sku, existing),
      };
      if (COSTS[normSku(sku)]) costsLoaded++;
      if (patch.cost_confirmation_required) pendingCostConfirmation++;

      if (existing) {
        if (existing.inventory_status === 'out_of_stock' && qty > 0) corrected++;
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
        });
        byAsin.set(asin, createdProduct);
        if (sku) bySku.set(normSku(sku), createdProduct);
        created++;
      }
    }

    const completedAt = new Date().toISOString();
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: body.amazon_account_id,
      operation: 'sync_product_catalog_v2', status: 'success', trigger_type: body.trigger_type || 'manual',
      started_at: startedAt, completed_at: completedAt, records_processed: created + updated,
      result_summary: JSON.stringify({ pages, inventory_asins: items.length, created, updated, corrected, costs_loaded: costsLoaded, pending_cost_confirmation: pendingCostConfirmation }).slice(0, 4000),
    }).catch(() => {});

    // Sinalizar dado fresco de SP-API para todas as páginas
    await base44.asServiceRole.entities.AmazonAccount.update(body.amazon_account_id, {
      sp_data_last_sync_at: completedAt,
      last_sync_at: completedAt,
    }).catch(() => {});

    return Response.json({ ok: true, pages, inventory_asins: items.length, created, updated, corrected_from_out_of_stock: corrected, costs_loaded: costsLoaded, pending_cost_confirmation: pendingCostConfirmation });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro de sincronização' }, { status: 500 });
  }
});