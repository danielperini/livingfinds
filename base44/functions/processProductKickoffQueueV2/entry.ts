import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function currentBrazilHour() {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === 'hour')?.value || 0);
}

function due(item: any) {
  if (!item?.scheduled_at) return true;
  const timestamp = new Date(item.scheduled_at).getTime();
  return Number.isNaN(timestamp) || timestamp <= Date.now();
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    const hour = Number(body.hour ?? currentBrazilHour());
    if (![0, 1, 2, 3, 13].includes(hour)) {
      return Response.json({ ok: true, skipped: true, reason: 'Fora da janela Amazon', hour });
    }

    const queue = (await base44.asServiceRole.entities.ProductKickoffQueue.filter({
      ...(body.amazon_account_id ? { amazon_account_id: body.amazon_account_id } : {}),
      status: 'scheduled',
    }, 'scheduled_at', 50).catch(() => [])).filter(due).slice(0, 5);

    const results: any[] = [];

    for (const item of queue) {
      const attempts = Number(item.attempt_count || 0) + 1;

      await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id, {
        status: 'processing',
        started_at: new Date().toISOString(),
        attempt_count: attempts,
        last_error: null,
      });

      try {
        const response = item.mode === 'manual_only'
          ? await base44.asServiceRole.functions.invoke('createManualCampaignV2', {
              amazon_account_id: item.amazon_account_id,
              asin: item.asin,
              sku: item.sku || null,
              product_name: item.product_name || item.asin,
              keyword: item.keyword,
              bid: 0.5,
              budget: 5,
              _window_execution: true,
              _service_role: true,
            })
          : await base44.asServiceRole.functions.invoke('autoKickoffProductV2', {
              amazon_account_id: item.amazon_account_id,
              asin: item.asin,
              sku: item.sku || null,
              product_name: item.product_name || item.asin,
              max_keywords: 4,
              minimum_ai_confidence: 0.90,
              _window_execution: true,
              _service_role: true,
            });

        const data = response?.data || response || {};
        const success = data?.ok === true;
        const text = String(data?.error || data?.message || '').toLowerCase();
        const is403 = data?.status === 403 || text.includes('403') || text.includes('forbidden') || text.includes('unauthorized');
        const retryable = Boolean(data?.retryable || data?.status === 429 || data?.circuit_open || is403 || text.includes('rate limit') || text.includes('throttl') || text.includes('time limit') || text.includes('timeout'));
        // 403: backoff maior (10 min) para dar tempo ao token ser renovado
        const backoffMs = is403 ? 10 * 60000 : 60000;
        const retry = !success && retryable && attempts < Number(item.max_attempts || 5);

        await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id, {
          status: success ? 'completed' : retry ? 'scheduled' : 'failed',
          completed_at: success || !retry ? new Date().toISOString() : null,
          scheduled_at: retry ? new Date(Date.now() + backoffMs).toISOString() : item.scheduled_at,
          last_error: success ? null : String(data?.errors?.[0]?.message || data?.error || data?.message || 'Falha no Kick-off').slice(0, 500),
        });

        results.push({ id: item.id, asin: item.asin, ok: success, retry_scheduled: retry, response: data });
      } catch (error) {
        const retry = attempts < Number(item.max_attempts || 5);
        await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id, {
          status: retry ? 'scheduled' : 'failed',
          scheduled_at: retry ? new Date(Date.now() + backoffMs).toISOString() : item.scheduled_at,
          completed_at: retry ? null : new Date().toISOString(),
          last_error: String(error?.message || error).slice(0, 500),
        });
        results.push({ id: item.id, asin: item.asin, ok: false, retry_scheduled: retry, error: error?.message || String(error) });
      }

      await wait(14000);
    }

    for (const accountId of [...new Set(queue.map((item: any) => item.amazon_account_id))]) {
      await base44.asServiceRole.functions.invoke('syncAds', {
        amazon_account_id: accountId,
        trigger_type: 'post_kickoff_queue',
        _service_role: true,
      }).catch(() => null);
      await base44.asServiceRole.functions.invoke('fixProductCampaignLinks', {
        amazon_account_id: accountId,
        _service_role: true,
      }).catch(() => null);
    }

    return Response.json({ ok: true, processed: results.length, spacing_seconds: 14, results });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao processar fila de Kick-off V2' }, { status: 500 });
  }
});