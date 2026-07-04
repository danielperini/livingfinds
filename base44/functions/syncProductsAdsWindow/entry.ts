import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function brazilHour() {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === 'hour')?.value || 0);
}

function inWindow() {
  return [0, 1, 2, 3, 13].includes(brazilHour());
}

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }
    if (!body.amazon_account_id) {
      return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });
    }

    if (!body._window_execution && !inWindow()) {
      return Response.json({
        ok: true,
        scheduled: true,
        message: 'Sincronização de Produtos & Ads mantida para a próxima janela automática.',
        windows: ['00:00-04:00', '13:00-14:00'],
      });
    }

    const accountId = body.amazon_account_id;
    const steps = [];
    const run = async (name: string, functionName: string) => {
      const stepStarted = Date.now();
      try {
        const response = await base44.asServiceRole.functions.invoke(functionName, {
          amazon_account_id: accountId,
          trigger_type: 'products_ads_window',
          _service_role: true,
        });
        const data = response?.data || response || {};
        const ok = data?.ok !== false;
        steps.push({ name, ok, duration_ms: Date.now() - stepStarted, summary: data });
        return ok;
      } catch (error) {
        steps.push({ name, ok: false, duration_ms: Date.now() - stepStarted, error: error?.message || String(error) });
        return false;
      }
    };

    await run('ads', 'syncAds');
    await run('catalog_inventory', 'syncProductCatalogV2');
    await run('product_campaign_links', 'fixProductCampaignLinks');
    await run('campaign_repair_preparation', 'prepareAllCampaignRepairs');

    const completedAt = new Date().toISOString();
    const ok = steps.every((step) => step.ok);

    await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
      last_sync_at: completedAt,
      products_ads_last_sync_at: completedAt,
      products_ads_sync_status: ok ? 'success' : 'partial',
    }).catch(() => {});

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'products_ads_window_sync',
      status: ok ? 'success' : 'error',
      trigger_type: 'scheduled_window',
      started_at: startedAt,
      completed_at: completedAt,
      records_processed: steps.filter((step) => step.ok).length,
      result_summary: JSON.stringify(steps).slice(0, 4000),
      error_message: ok ? null : steps.filter((step) => !step.ok).map((step) => `${step.name}: ${step.error || 'falha'}`).join(' | ').slice(0, 1000),
    }).catch(() => {});

    return Response.json({
      ok,
      started_at: startedAt,
      completed_at: completedAt,
      windows: ['00:00-04:00', '13:00-14:00'],
      steps,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro na sincronização de Produtos & Ads', started_at: startedAt }, { status: 500 });
  }
});
