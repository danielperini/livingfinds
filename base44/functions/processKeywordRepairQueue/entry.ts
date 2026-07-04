import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hourBR() {
  const p = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  return Number(p.find((x) => x.type === 'hour')?.value || 0);
}

function isDue(item: any) {
  if (!item?.scheduled_at) return true;
  const timestamp = new Date(item.scheduled_at).getTime();
  return Number.isNaN(timestamp) || timestamp <= Date.now();
}

Deno.serve(async (req) => {
  try {
    const b = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    const hour = Number.isFinite(Number(body.hour)) ? Number(body.hour) : hourBR();
    if (![0, 1, 2, 3, 13].includes(hour)) {
      return Response.json({ ok: true, skipped: true, hour, reason: 'Fora da janela Amazon' });
    }

    const scheduled = await b.asServiceRole.entities.KeywordRepairQueue.filter({
      ...(body.amazon_account_id ? { amazon_account_id: body.amazon_account_id } : {}),
      status: 'scheduled',
    }, 'scheduled_at', 100).catch(() => []);

    const rows = scheduled.filter(isDue).slice(0, 10);
    const results: any[] = [];

    for (const item of rows) {
      const attempts = Number(item.attempt_count || 0) + 1;
      await b.asServiceRole.entities.KeywordRepairQueue.update(item.id, {
        status: 'processing',
        attempt_count: attempts,
        started_at: new Date().toISOString(),
        last_error: null,
      });

      try {
        const response = await b.asServiceRole.functions.invoke('repairExactAdGroupIntegrity', {
          amazon_account_id: item.amazon_account_id,
          asin: item.asin,
          sku: item.sku || null,
          campaign_id: item.campaign_id || null,
          ad_group_id: item.ad_group_id || null,
          minimum_ai_confidence: 0.90,
          _window_execution: true,
          _service_role: true,
        });
        const data = response?.data || response || {};
        const matching = data?.results?.find((x: any) =>
          item.campaign_id
            ? String(x.campaign_id || '') === String(item.campaign_id)
            : String(x.asin || '') === String(item.asin)
        );
        const ok = matching?.complete === true || data?.complete === true;
        const retry = !ok && attempts < Number(item.max_attempts || 5);

        await b.asServiceRole.entities.KeywordRepairQueue.update(item.id, {
          status: ok ? 'completed' : retry ? 'scheduled' : 'failed',
          attempt_count: attempts,
          scheduled_at: retry ? new Date(Date.now() + 60000).toISOString() : item.scheduled_at,
          completed_at: ok || !retry ? new Date().toISOString() : null,
          last_error: ok ? null : String(matching?.error || data?.error || 'Grupo ainda sem anúncio ou keyword').slice(0, 500),
        });

        results.push({
          id: item.id,
          asin: item.asin,
          campaign_id: item.campaign_id || null,
          ok,
          retry_scheduled: retry,
        });
      } catch (e) {
        const retry = attempts < Number(item.max_attempts || 5);
        await b.asServiceRole.entities.KeywordRepairQueue.update(item.id, {
          status: retry ? 'scheduled' : 'failed',
          attempt_count: attempts,
          scheduled_at: retry ? new Date(Date.now() + 120000).toISOString() : item.scheduled_at,
          completed_at: retry ? null : new Date().toISOString(),
          last_error: String(e?.message || e).slice(0, 500),
        }).catch(() => {});
        results.push({
          id: item.id,
          asin: item.asin,
          campaign_id: item.campaign_id || null,
          ok: false,
          retry_scheduled: retry,
          error: e?.message || String(e),
        });
      }

      await wait(14000);
    }

    return Response.json({
      ok: true,
      hour,
      scheduled_found: scheduled.length,
      overdue_processed: results.length,
      spacing_seconds: 14,
      minimum_ai_confidence: 0.90,
      queue_identity: 'campaign_id',
      integrity_required: ['enabled_product_ad', 'enabled_exact_keyword'],
      results,
    });
  } catch (e) {
    return Response.json({ ok: false, error: e?.message || 'Erro na fila de integridade EXACT' }, { status: 500 });
  }
});