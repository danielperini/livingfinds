import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function nowBR() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));

    if (!body._service_role) {
      return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });
    }

    const time = nowBR();
    const hour = Number(time.hour);
    const minute = Number(time.minute);

    let cycle = body.cycle || null;
    if (!cycle) {
      if (hour === 6 && minute < 40) cycle = '0600';
      if (hour === 6 && minute >= 40) cycle = '0640';
      if (body.force === true && !cycle) cycle = '0640';
    }

    const payload = {
      amazon_account_id: body.amazon_account_id || null,
      force: true,
      _service_role: true,
    };

    if (cycle === '0600') {
      const response = await base44.asServiceRole.functions.invoke(
        'runMorningRecovery0600',
        payload,
      );
      const result = response?.data || response || {};
      return Response.json({
        ok: result?.ok !== false,
        cycle: '06:00',
        result,
      });
    }

    if (cycle === '0640') {
      const response = await base44.asServiceRole.functions.invoke(
        'runMorningReports0640',
        payload,
      );
      const result = response?.data || response || {};
      return Response.json({
        ok: result?.ok !== false,
        cycle: '06:40',
        result,
      });
    }

    return Response.json({
      ok: true,
      skipped: true,
      brazil_time: `${time.hour}:${time.minute}`,
      next_cycles: [
        '06:00 repescagem',
        '06:40 relatórios, sinais ML, reconciliação e análise',
      ],
    });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error?.message || 'Erro no despachante matinal',
    }, { status: 500 });
  }
});
