import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    const hour = Number(body.hour);
    if (![0, 1, 2, 3, 13].includes(hour)) return Response.json({ ok: true, skipped: true, hour });

    const queue = await base44.asServiceRole.entities.ProductKickoffQueue.filter({
      ...(body.amazon_account_id ? { amazon_account_id: body.amazon_account_id } : {}),
      status: 'scheduled',
      queue_hour: hour,
    }, 'scheduled_at', 5);

    const results = [];
    for (const item of queue) {
      if (item.scheduled_at && new Date(item.scheduled_at).getTime() > Date.now()) continue;

      await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id, {
        status: 'processing',
        started_at: new Date().toISOString(),
        attempt_count: Number(item.attempt_count || 0) + 1,
      });

      try {
        let response;
        if (item.mode === 'manual_only') {
          response = await base44.asServiceRole.functions.invoke('createManualCampaignV2', {
            amazon_account_id: item.amazon_account_id,
            asin: item.asin,
            sku: item.sku || null,
            product_name: item.product_name || item.asin,
            keyword: item.keyword,
            bid: 0.5,
            budget: 5,
            _service_role: true,
          });
        } else {
          response = await base44.asServiceRole.functions.invoke('autoKickoffProductV2', {
            amazon_account_id: item.amazon_account_id,
            asin: item.asin,
            sku: item.sku || null,
            product_name: item.product_name || item.asin,
            max_keywords: 4,
            _window_execution: true,
            _service_role: true,
          });
        }

        const data = response?.data || response || {};
        const success = data?.ok === true;
        const attempts = Number(item.attempt_count || 0) + 1;
        const retry = !success && attempts < Number(item.max_attempts || 5) && (data?.retryable || data?.status === 429 || data?.circuit_open);

        await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id, {
          status: success ? 'completed' : retry ? 'scheduled' : 'failed',
          attempt_count: attempts,
          completed_at: success || !retry ? new Date().toISOString() : null,
          last_error: success ? null : String(data?.errors?.[0]?.message || data?.error || data?.message || 'Falha no Kick-off').slice(0, 500),
        });

        results.push({ id: item.id, asin: item.asin, mode: item.mode, ok: success, retry_scheduled: retry });
      } catch (error) {
        const attempts = Number(item.attempt_count || 0) + 1;
        const retry = attempts < Number(item.max_attempts || 5);
        await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id, {
          status: retry ? 'scheduled' : 'failed',
          attempt_count: attempts,
          completed_at: retry ? null : new Date().toISOString(),
          last_error: String(error?.message || error).slice(0, 500),
        });
        results.push({ id: item.id, asin: item.asin, mode: item.mode, ok: false, retry_scheduled: retry });
      }

      await wait(14000);
    }

    return Response.json({ ok: true, processed: results.length, spacing_seconds: 14, results });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao processar fila de Kick-off V2' }, { status: 500 });
  }
});
