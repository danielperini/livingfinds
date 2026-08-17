/**
 * syncProductsFromInventory — Importa produtos do inventário FBA via SP-API.
 * Marca novos ASINs com is_new_asin=true.
 * Evita sobrescrever dados existentes de campanha.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

async function getSpApiToken() {
  const cached = tokenCache['spapi'];
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
  // Usar credenciais SP-API (não Ads)
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: Deno.env.get('SP_REFRESH_TOKEN') || Deno.env.get('AMAZON_SP_REFRESH_TOKEN'),
    client_id: Deno.env.get('SP_CLIENT_ID') || Deno.env.get('AMAZON_LWA_CLIENT_ID'),
    client_secret: Deno.env.get('SP_CLIENT_SECRET') || Deno.env.get('AMAZON_LWA_CLIENT_SECRET'),
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || `SP-API token failed: ${JSON.stringify(data)}`);
  tokenCache['spapi'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

async function fetchFbaInventory(token, marketplaceId) {
  // Brasil (A2Q3Y263D00KWC) usa endpoint NA
  const endpoint = `https://sellingpartnerapi-na.amazon.com/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=${marketplaceId}&marketplaceIds=${marketplaceId}`;
  const res = await fetch(endpoint, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'x-amz-access-token': token,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`SP-API inventory error ${res.status}: ${err.slice(0, 200)}`);
  }
  const data = await res.json();
  return data?.payload?.inventorySummaries || [];
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
    if (!account) return Response.json({ error: 'Account not found' }, { status: 404 });

    const marketplaceId = account.marketplace_id || 'ATVPDKIKX0DER';

    // Criar SyncRun
    const syncRun = await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id,
      operation: 'syncProductsFromInventory',
      status: 'running',
      started_at: new Date().toISOString(),
    });

    let importedCount = 0;
    let newAsinCount = 0;
    let inventorySummaries = [];

    try {
      const token = await getSpApiToken();
      inventorySummaries = await fetchFbaInventory(token, marketplaceId);
    } catch (apiErr) {
      // Se SP-API falhar, registrar erro mas não falhar totalmente
      await base44.asServiceRole.entities.SyncRun.update(syncRun.id, {
        status: 'error',
        error_message: `SP-API: ${apiErr.message}`,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
      });
      return Response.json({ ok: false, error: apiErr.message, sp_api_error: true });
    }

    // Buscar produtos existentes para detectar novos ASINs
    const existingProducts = await base44.asServiceRole.entities.Product.filter({ amazon_account_id }, null, 2000);
    const existingAsinMap = new Map(existingProducts.map(p => [p.asin, p]));
    const now = new Date().toISOString();

    const upsertBatch = [];
    for (const item of inventorySummaries) {
      const asin = item.asin;
      const sku = item.sellerSku;
      if (!asin) continue;

      const totalQty = (item.inventoryDetails?.fulfillableQuantity || 0)
        + (item.inventoryDetails?.reservedQuantity?.totalReservedQuantity || 0);
      const inboundQty = item.inventoryDetails?.inboundShippingQuantity || 0;
      const inventoryStatus = totalQty === 0 ? 'out_of_stock' : totalQty < 10 ? 'low_stock' : 'in_stock';
      const isNew = !existingAsinMap.has(asin);
      if (isNew) newAsinCount++;

      const existing = existingAsinMap.get(asin);

      // Recalcular ads_eligibility_status após atualização de estoque
      // Respeitar ads_scope_status existente; se authorized, derivar elegibilidade real
      const existingScope = existing?.ads_scope_status || 'not_authorized';
      let adsEligibilityStatus = existing?.ads_eligibility_status || 'unknown';
      let adsIneligibilityReason = existing?.ads_ineligibility_reason || '';
      const availableQty = item.inventoryDetails?.fulfillableQuantity || 0; // apenas disponível
      if (existingScope === 'authorized') {
        // Manter estado específico de listing_suppressed/offer_inactive (gerido pela SP-API de listings)
        const lockedStates = ['listing_suppressed', 'offer_inactive', 'not_buyable', 'mapping_conflict', 'manual_block'];
        if (!lockedStates.includes(adsEligibilityStatus)) {
          if (availableQty <= 0) {
            adsEligibilityStatus = 'out_of_stock';
            adsIneligibilityReason = `Estoque disponível zero após sync (fulfillable=${availableQty})`;
          } else if (inventoryStatus === 'low_stock') {
            adsEligibilityStatus = 'low_stock';
            adsIneligibilityReason = `Estoque baixo: ${availableQty} unidades`;
          } else {
            adsEligibilityStatus = 'eligible';
            adsIneligibilityReason = '';
          }
        }
      }

      const record = {
        amazon_account_id,
        asin,
        sku: sku || existing?.sku || null,
        product_name: item.productName || existing?.product_name || asin,
        status: 'active',
        inventory_status: inventoryStatus,
        fba_inventory: totalQty,
        available_quantity: availableQty,
        inbound_inventory: inboundQty,
        is_new_asin: isNew,
        has_campaign: existing?.has_campaign || false,
        campaign_status: existing?.campaign_status || 'none',
        linked_campaign_id: existing?.linked_campaign_id || null,
        last_sync_at: now,
        synced_at: now,
        ads_eligibility_status: adsEligibilityStatus,
        ads_ineligibility_reason: adsIneligibilityReason,
        ads_last_eligibility_check_at: now,
        // Preservar ads_resume_pending se era out_of_stock e agora ficou elegível (será retomado pelo pauseAutoCampaigns)
        ads_resume_pending: existingScope === 'authorized' && adsEligibilityStatus === 'eligible' && existing?.ads_resume_pending === true
          ? true // manter para o processo de retomada decidir
          : existing?.ads_resume_pending || false,
      };

      if (!existing?.first_available_date) {
        record.first_available_date = new Date().toISOString().slice(0, 10);
      }

      upsertBatch.push({ isNew, asin, existing, record });
      importedCount++;
    }

    // Upsert em lote
    const toCreate = upsertBatch.filter(r => r.isNew).map(r => r.record);
    const toUpdate = upsertBatch.filter(r => !r.isNew).map(r => ({ id: r.existing.id, ...r.record }));

    if (toCreate.length > 0) {
      for (let i = 0; i < toCreate.length; i += 500) {
        await base44.asServiceRole.entities.Product.bulkCreate(toCreate.slice(i, i + 500));
      }
    }
    if (toUpdate.length > 0) {
      for (let i = 0; i < toUpdate.length; i += 500) {
        await base44.asServiceRole.entities.Product.bulkUpdate(toUpdate.slice(i, i + 500));
      }
    }

    await base44.asServiceRole.entities.SyncRun.update(syncRun.id, {
      status: 'success',
      records_received: inventorySummaries.length,
      records_upserted: importedCount,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
    });

    if (newAsinCount > 0) {
      await base44.asServiceRole.entities.LearningEvent.create({
        amazon_account_id,
        event_type: 'new_asins_imported',
        entity_type: 'account',
        entity_id: amazon_account_id,
        observation: `${newAsinCount} novos ASINs importados do inventário FBA`,
        recorded_at: now,
      });
    }

    return Response.json({ ok: true, imported: importedCount, new_asins: newAsinCount });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});