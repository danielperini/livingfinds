import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function saoPauloNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    hour: Number(p.hour || 0),
    minute: Number(p.minute || 0),
    day: `${p.year}-${p.month}-${p.day}`,
  };
}

function nextSlot() {
  const { hour, day } = saoPauloNow();

  if ([0, 1, 2, 3, 13].includes(hour)) {
    return {
      hour,
      window: hour === 13 ? '13:00-14:00' : `${String(hour).padStart(2, '0')}:00-${String(hour + 1).padStart(2, '0')}:00`,
      at: new Date(),
      execute_now: true,
    };
  }

  if (hour < 13) {
    return {
      hour: 13,
      window: '13:00-14:00',
      at: new Date(`${day}T13:00:00-03:00`),
      execute_now: false,
    };
  }

  const tomorrow = new Date(`${day}T12:00:00-03:00`);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const nextDay = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(tomorrow);

  return {
    hour: 0,
    window: '00:00-01:00',
    at: new Date(`${nextDay}T00:00:00-03:00`),
    execute_now: false,
  };
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const mode = body.mode === 'manual_only' ? 'manual_only' : 'auto_plus_four';

    if (!body.amazon_account_id || !body.asin) {
      return Response.json({ ok: false, error: 'Conta e ASIN são obrigatórios' }, { status: 400 });
    }
    if (mode === 'manual_only' && !String(body.keyword || '').trim()) {
      return Response.json({ ok: false, error: 'Informe o termo exato' }, { status: 400 });
    }

    const slot = nextSlot();
    const existing = await base44.asServiceRole.entities.ProductKickoffQueue.filter(
      {
        amazon_account_id: body.amazon_account_id,
        asin: body.asin,
        mode,
        status: 'scheduled',
      },
      '-created_date',
      1,
    ).catch(() => []);

    let queueItem = existing[0] || null;
    if (queueItem) {
      queueItem = await base44.asServiceRole.entities.ProductKickoffQueue.update(queueItem.id, {
        queue_hour: slot.hour,
        queue_window: slot.window,
        scheduled_at: slot.at.toISOString(),
        status: 'scheduled',
        last_error: null,
      });
    } else {
      queueItem = await base44.asServiceRole.entities.ProductKickoffQueue.create({
        amazon_account_id: body.amazon_account_id,
        asin: body.asin,
        sku: body.sku || null,
        product_name: body.product_name || body.asin,
        mode,
        keyword: mode === 'manual_only' ? String(body.keyword || '').trim() : null,
        status: 'scheduled',
        queue_hour: slot.hour,
        queue_window: slot.window,
        scheduled_at: slot.at.toISOString(),
        attempt_count: 0,
        max_attempts: 5,
      });
    }

    let execution = null;
    let executionDeferred = false;
    let executionError = null;

    if (slot.execute_now) {
      try {
        const response = await base44.asServiceRole.functions.invoke('processProductKickoffQueueV2', {
          amazon_account_id: body.amazon_account_id,
          hour: slot.hour,
          _service_role: true,
        });
        execution = response?.data || response || null;
        executionDeferred = !(execution?.processed > 0);
      } catch (error) {
        executionDeferred = true;
        executionError = String(error?.message || error).slice(0, 300);
        await base44.asServiceRole.entities.ProductKickoffQueue.update(queueItem.id, {
          status: 'scheduled',
          queue_hour: slot.hour,
          queue_window: slot.window,
          scheduled_at: new Date().toISOString(),
          last_error: executionError,
        }).catch(() => null);
      }
    }

    const executed = Boolean(slot.execute_now && execution?.processed > 0);
    return Response.json({
      ok: true,
      queued: true,
      scheduled: !executed,
      executed,
      execution_deferred: executionDeferred,
      execution_error: executionError,
      queue_id: queueItem?.id || null,
      queue_hour: slot.hour,
      queue_window: slot.window,
      scheduled_at: slot.at.toISOString(),
      execution,
      message: executed
        ? `Kick-off enviado para execução para ${body.asin}.`
        : executionDeferred
          ? `Kick-off salvo na fila para ${body.asin}. A Amazon limitou a execução imediata; nova tentativa ocorrerá automaticamente nesta janela.`
          : `Kick-off programado para ${slot.window}.`,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao programar o Kick-off' }, { status: 500 });
  }
});