import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hourBR() {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === 'hour')?.value || 0);
}

function due(item: any) {
  if (!item?.scheduled_at) return true;
  const time = new Date(item.scheduled_at).getTime();
  return Number.isNaN(time) || time <= Date.now();
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    const hour = Number.isFinite(Number(body.hour)) ? Number(body.hour) : hourBR();
    const forceRun = body.force === true;
    if (!forceRun && ![0, 1, 2, 3, 13].includes(hour)) {
      return Response.json({ ok: true, skipped: true, hour, reason: 'Fora da janela Amazon' });
    }

    const scheduled = await base44.asServiceRole.entities.AutoCampaignRepairQueue.filter({
      ...(body.amazon_account_id ? { amazon_account_id: body.amazon_account_id } : {}),
      status: 'scheduled',
    }, 'scheduled_at', 100).catch(() => []);

    const rows = scheduled.filter(due).slice(0, 10);
    const results: any[] = [];

    for (const item of rows) {
      const attempts = Number(item.attempt_count || 0) + 1;
      await base44.asServiceRole.entities.AutoCampaignRepairQueue.update(item.id, {
        status: 'processing',
        started_at: new Date().toISOString(),
        attempt_count: attempts,
        last_error: null,
      });

      try {
        const response = await base44.asServiceRole.functions.invoke('repairIncompleteAutoCampaignById', {
          amazon_account_id: item.amazon_account_id,
          campaign_id: String(item.campaign_id || ''),
          asin: item.asin,
          sku: item.sku || null,
          _window_execution: true,
          _service_role: true,
        });
        const data = response?.data || response || {};
        const complete = data?.ok === true && data?.complete === true;
        const text = JSON.stringify(data || '').toLowerCase();
        const retryable = data?.status === 429 || data?.circuit_open || text.includes('rate limit') || text.includes('throttl');
        const retry = !complete && attempts < Number(item.max_attempts || 5);

        await base44.asServiceRole.entities.AutoCampaignRepairQueue.update(item.id, {
          status: complete ? 'completed' : retry ? 'scheduled' : 'failed',
          attempt_count: attempts,
          scheduled_at: retry ? new Date(Date.now() + (retryable ? 120000 : 60000)).toISOString() : item.scheduled_at,
          completed_at: complete || !retry ? new Date().toISOString() : null,
          last_error: complete ? null : String(data?.error || 'Campanha ainda incompleta').slice(0, 500),
        });

        results.push({
          id: item.id,
          asin: item.asin,
          campaign_id: item.campaign_id || null,
          ok: complete,
          retry_scheduled: retry,
          retryable,
        });
      } catch (error) {
        const retry = attempts < Number(item.max_attempts || 5);
        await base44.asServiceRole.entities.AutoCampaignRepairQueue.update(item.id, {
          status: retry ? 'scheduled' : 'failed',
          attempt_count: attempts,
          scheduled_at: retry ? new Date(Date.now() + 120000).toISOString() : item.scheduled_at,
          completed_at: retry ? null : new Date().toISOString(),
          last_error: String(error?.message || error).slice(0, 500),
        }).catch(() => {});
        results.push({
          id: item.id,
          asin: item.asin,
          campaign_id: item.campaign_id || null,
          ok: false,
          retry_scheduled: retry,
          error: error?.message || String(error),
        });
      }

      await wait(14000);
    }

    return Response.json({
      ok: true,
      hour,
      scheduled_found: scheduled.length,
      overdue_processed: results.length,
      queue_identity: 'campaign_id',
      spacing_seconds: 14,
      results,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro no processador AUTO V2' }, { status: 500 });
  }
});