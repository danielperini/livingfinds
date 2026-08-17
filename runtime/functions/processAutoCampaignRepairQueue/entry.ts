import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function brazilHour() {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === 'hour')?.value || 0);
}

function isDue(item: any) {
  if (!item?.scheduled_at) return true;
  const timestamp = new Date(item.scheduled_at).getTime();
  return Number.isNaN(timestamp) || timestamp <= Date.now();
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    const hour = Number.isFinite(Number(body.hour)) ? Number(body.hour) : brazilHour();
    if (![0, 1, 2, 3, 13].includes(hour)) {
      return Response.json({ ok: true, skipped: true, hour, reason: 'Fora da janela Amazon' });
    }

    const allScheduled = await base44.asServiceRole.entities.AutoCampaignRepairQueue.filter({
      ...(body.amazon_account_id ? { amazon_account_id: body.amazon_account_id } : {}),
      status: 'scheduled',
    }, 'scheduled_at', 100).catch(() => []);

    const queue = allScheduled.filter(isDue).slice(0, 10);
    const results: any[] = [];

    for (const item of queue) {
      const attempts = Number(item.attempt_count || 0) + 1;

      await base44.asServiceRole.entities.AutoCampaignRepairQueue.update(item.id, {
        status: 'processing',
        started_at: new Date().toISOString(),
        attempt_count: attempts,
        last_error: null,
      });

      try {
        const response = await base44.asServiceRole.functions.invoke('repairIncompleteAutoCampaigns', {
          amazon_account_id: item.amazon_account_id,
          asins: [item.asin],
          campaign_ids: item.campaign_id ? [String(item.campaign_id)] : [],
          sku: item.sku || null,
          _window_execution: true,
          _service_role: true,
        });

        const data = response?.data || response || {};
        const matching = data?.results?.find((result: any) =>
          item.campaign_id
            ? String(result.campaign_id || '') === String(item.campaign_id)
            : String(result.asin || '') === String(item.asin)
        );
        const complete = data?.ok === true && matching?.complete === true;
        const retryable = Boolean(
          data?.retryable ||
          data?.status === 429 ||
          data?.circuit_open ||
          JSON.stringify(data || '').toLowerCase().includes('rate limit') ||
          JSON.stringify(data || '').toLowerCase().includes('throttl')
        );
        const retry = !complete && attempts < Number(item.max_attempts || 5);

        await base44.asServiceRole.entities.AutoCampaignRepairQueue.update(item.id, {
          status: complete ? 'completed' : retry ? 'scheduled' : 'failed',
          attempt_count: attempts,
          scheduled_at: retry ? new Date(Date.now() + (retryable ? 120000 : 60000)).toISOString() : item.scheduled_at,
          completed_at: complete || !retry ? new Date().toISOString() : null,
          last_error: complete
            ? null
            : String(matching?.error || data?.error || 'Campanha ainda incompleta').slice(0, 500),
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
        });
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
      scheduled_found: allScheduled.length,
      overdue_processed: results.length,
      spacing_seconds: 14,
      queue_identity: 'campaign_id',
      results,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao processar reparos AUTO' }, { status: 500 });
  }
});