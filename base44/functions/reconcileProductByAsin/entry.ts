/**
 * reconcileProductByAsin — força reconciliação idempotente de um ASIN usando dados reais da SP-API.
 *
 * Não cria produto manualmente. A persistência só ocorre dentro de syncProductCatalogV2
 * quando o ASIN é confirmado no retorno real de inventário FBA.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const normAsin = (value:any) => String(value || '').trim().toUpperCase();

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const auth = await base44.auth.isAuthenticated().catch(() => false);
    if (!auth && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accountId = body.amazon_account_id;
    const asin = normAsin(body.asin);
    if (!accountId) {
      return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });
    }
    if (!/^B[A-Z0-9]{9}$/.test(asin)) {
      return Response.json({ ok: false, error: 'ASIN inválido' }, { status: 400 });
    }

    const before = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id: accountId, asin },
      '-updated_date',
      2,
    ).catch(() => []);

    const syncResponse = await base44.asServiceRole.functions.invoke('syncProductCatalogV2', {
      amazon_account_id: accountId,
      asin,
      required_asins: [asin],
      trigger_type: body.trigger_type || 'asin_reconciliation',
      _service_role: true,
    });
    const sync = syncResponse?.data || syncResponse || {};

    if (!sync.ok) {
      throw new Error(sync.error || 'Falha ao sincronizar catálogo pela SP-API');
    }

    const after = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id: accountId, asin },
      '-updated_date',
      2,
    ).catch(() => []);
    const product = after[0] || null;
    const required = Array.isArray(sync.required_asins)
      ? sync.required_asins.find((item:any) => normAsin(item?.asin) === asin)
      : null;
    const confirmedInFba = required?.found_in_fba_inventory === true;

    const result = {
      asin,
      found_before: before.length > 0,
      found_after: !!product,
      created_now: before.length === 0 && !!product,
      updated_now: before.length > 0 && !!product,
      confirmed_in_fba_inventory: confirmedInFba,
      product_id: product?.id || null,
      sku: product?.sku || null,
      quantity: product ? Number(product.fba_inventory ?? product.available_quantity ?? product.total_quantity ?? 0) : null,
      inventory_status: product?.inventory_status || null,
      product_status: product?.status || null,
      sync_summary: {
        pages: sync.pages,
        inventory_asins: sync.inventory_asins,
        created: sync.created,
        updated: sync.updated,
        missing_required_asins: sync.missing_required_asins || [],
      },
    };

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'reconcile_product_by_asin',
      status: confirmedInFba && product ? 'success' : 'warning',
      trigger_type: body.trigger_type || 'manual',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      records_processed: product ? 1 : 0,
      result_summary: JSON.stringify(result).slice(0, 4000),
      error_message: confirmedInFba
        ? null
        : `ASIN ${asin} não foi confirmado no inventário FBA retornado pela SP-API; nenhum produto fictício foi criado.`,
    }).catch(() => {});

    return Response.json({
      ok: confirmedInFba && !!product,
      ...result,
      message: confirmedInFba && product
        ? `ASIN ${asin} reconciliado com dados reais da SP-API.`
        : `ASIN ${asin} não apareceu no inventário FBA. Verifique se a oferta é FBM ou se o SKU está em outro marketplace/conta.`,
    }, { status: confirmedInFba && product ? 200 : 409 });
  } catch (error:any) {
    return Response.json({
      ok: false,
      error: String(error?.message || 'Erro ao reconciliar produto').slice(0, 500),
    }, { status: 500 });
  }
});