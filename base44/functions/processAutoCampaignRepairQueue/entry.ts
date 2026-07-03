import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    const hour = Number(body.hour);
    if (![0, 1, 2, 3, 13].includes(hour)) return Response.json({ ok: true, skipped: true, hour });

    const queue = await base44.asServiceRole.entities.AutoCampaignRepairQueue.filter({
      ...(body.amazon_account_id ? { amazon_account_id: body.amazon_account_id } : {}),
      status: 'scheduled',
      queue_hour: hour,
    }, 'scheduled_at', 10);

    const results = [];
    for (const item of queue) {
      if (item.scheduled_at && new Date(item.scheduled_at).getTime() > Date.now()) continue;

      await base44.asServiceRole.entities.AutoCampaignRepairQueue.update(item.id, {
        status: 'processing',
        started_at: new Date().toISOString(),
        attempt_count: Number(item.attempt_count || 0) + 1,
      });

      try {
        const response = await base44.asServiceRole.functions.invoke('repairIncompleteAutoCampaigns', {
          amazon_account_id: item.amazon_account_id,
          asins: [item.asin],
          _window_execution: true,
          _service_role: true,
        });
        const data = response?.data || response || {};
        const complete = data?.ok === true && data?.results?.some((result: any) => result.asin === item.asin && result.complete === true);
        const attempts = Number(item.attempt_count || 0) + 1;
        const retry = !complete && attempts < Number(item.max_attempts || 5);

        await base44.asServiceRole.entities.AutoCampaignRepairQueue.update(item.id, {
          status: complete ? 'completed' : retry ? 'scheduled' : 'failed',
          attempt_count: attempts,
          completed_at: complete || !retry ? new Date().toISOString() : null,
          last_error: complete ? null : String(data?.results?.[0]?.error || data?.error || 'Campanha ainda incompleta').slice(0, 500),
        });

        results.push({ id: item.id, asin: item.asin, ok: complete, retry_scheduled: retry });
      } catch (error) {
        const attempts = Number(item.attempt_count || 0) + 1;
        const retry = attempts < Number(item.max_attempts || 5);
        await base44.asServiceRole.entities.AutoCampaignRepairQueue.update(item.id, {
          status: retry ? 'scheduled' : 'failed',
          attempt_count: attempts,
          completed_at: retry ? null : new Date().toISOString(),
          last_error: String(error?.message || error).slice(0, 500),
        });
        results.push({ id: item.id, asin: item.asin, ok: false, retry_scheduled: retry });
      }

      await wait(14000);
    }

    return Response.json({ ok: true, processed: results.length, spacing_seconds: 14, results });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao processar reparos AUTO' }, { status: 500 });
  }
});
