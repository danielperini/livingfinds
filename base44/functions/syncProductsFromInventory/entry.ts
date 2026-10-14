/**
 * Backward-compatible entry point for legacy callers.
 * All inventory reads and writes are owned by syncProductCatalogV2 so every
 * caller gets the same paginated SP-API snapshot, SKU mapping and stock fields.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && body._service_role !== true) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }
    if (!body.amazon_account_id) {
      return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });
    }

    const result = await base44.asServiceRole.functions.invoke('syncProductCatalogV2', {
      ...body,
      _service_role: true,
      trigger_type: body.trigger_type || 'legacy_syncProductsFromInventory_delegated',
    });
    const data = result?.data || result || {};
    return Response.json({
      ...data,
      source: 'syncProductCatalogV2',
      inventory_records: data.inventory_asins || 0,
    }, { status: data.ok === true ? 200 : 502 });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao sincronizar estoque FBA' }, { status: 500 });
  }
});
