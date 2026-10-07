import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
Deno.serve(async request => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role && !(await base44.auth.isAuthenticated().catch(() => false))) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    if (!body.amazon_account_id || !body.asin || !String(body.keyword || '').trim()) return Response.json({ ok: false, error: 'Conta, ASIN e termo obrigatórios' }, { status: 400 });
    const response = await base44.asServiceRole.functions.invoke('runImmediateSameSkuSearchTermHarvest', {
      _service_role: true, amazon_account_id: body.amazon_account_id,
      target_asins: [body.asin], ...(body.sku ? { sku: body.sku } : {}),
      source_search_term: body.keyword, lookback_days: 30, max_promotions: 1,
      require_fresh_inventory: true, dry_run: body.dry_run === true,
      trigger_type: 'validated_manual_term_request',
    });
    const data = response?.data || response || {};
    const promoted = (data.reports || []).flatMap((r:any) => r.promoted_terms || []);
    const created = promoted[0];
    return Response.json({ ...data, ok: Boolean(created), blocked: !created,
      campaign_id: created?.campaign_id || created?.destination_campaign_id || null,
      error: created ? null : 'Termo não criado: exige conversão real do mesmo SKU, margem positiva e ausência de duplicação.',
      policy: 'same_sku_report_evidence_only' });
  } catch (error) { return Response.json({ ok: false, error: error.message }, { status: 500 }); }
});
