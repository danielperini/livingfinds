import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function nextSlot() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(p.hour || 0);
  const day = `${p.year}-${p.month}-${p.day}`;
  if (hour < 3) return { hour: hour + 1, window: `${String(hour + 1).padStart(2, '0')}:00-${String(hour + 2).padStart(2, '0')}:00`, at: new Date(`${day}T${String(hour + 1).padStart(2, '0')}:00:00-03:00`) };
  if (hour < 14) return { hour: 13, window: '13:00-14:00', at: new Date(`${day}T13:00:00-03:00`) };
  const tomorrow = new Date(`${day}T12:00:00-03:00`);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const nextDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(tomorrow);
  return { hour: 0, window: '00:00-01:00', at: new Date(`${nextDay}T00:00:00-03:00`) };
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const mode = body.mode === 'manual_only' ? 'manual_only' : 'auto_plus_four';
    if (!body.amazon_account_id || !body.asin) return Response.json({ ok: false, error: 'Conta e ASIN são obrigatórios' }, { status: 400 });
    if (mode === 'manual_only' && !String(body.keyword || '').trim()) return Response.json({ ok: false, error: 'Informe o termo exato' }, { status: 400 });

    const slot = nextSlot();
    const functionName = mode === 'manual_only' ? 'createManualCampaignFromKeywordSuggestion' : 'autoKickoffProduct';
    const payload = mode === 'manual_only'
      ? { amazon_account_id: body.amazon_account_id, asin: body.asin, sku: body.sku || null, product_name: body.product_name || body.asin, keyword: String(body.keyword).trim(), match_type: 'exact', bid: 0.5, _window_execution: true, _service_role: true }
      : { amazon_account_id: body.amazon_account_id, asin: body.asin, sku: body.sku || null, product_name: body.product_name || body.asin, max_keywords: 4, minimum_ai_confidence: 0.95, _window_execution: true, _service_role: true };

    const payloadJson = JSON.stringify(payload);
    const existing = await base44.asServiceRole.entities.AmazonDeferredCommand.filter({ function_name: functionName, payload_json: payloadJson, status: 'scheduled' }, '-created_date', 1).catch(() => []);
    if (!existing.length) {
      await base44.asServiceRole.entities.AmazonDeferredCommand.create({
        amazon_account_id: body.amazon_account_id,
        function_name: functionName,
        payload_json: payloadJson,
        status: 'scheduled',
        queue_hour: slot.hour,
        queue_window: slot.window,
        priority: 'normal',
        attempt_count: 0,
        max_attempts: 5,
        scheduled_at: slot.at.toISOString(),
        source: 'product_kickoff',
      });
    }

    return Response.json({
      ok: true,
      scheduled: true,
      queue_hour: slot.hour,
      queue_window: slot.window,
      scheduled_at: slot.at.toISOString(),
      message: `Kick-off programado para ${slot.window}. As campanhas serão criadas automaticamente com intervalo de 14 segundos.`,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao programar o Kick-off' }, { status: 500 });
  }
});
