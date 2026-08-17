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

function inAmazonWindow() {
  return [0, 1, 2, 3, 13].includes(brazilHour());
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      return Response.json({ ok: false, error: 'Gateway restrito a chamadas internas' }, { status: 403 });
    }

    const outsideWindow = !inAmazonWindow();
    const bypassDelay = body.skip_outside_window_delay === true;
    const deferredSeconds = outsideWindow && !bypassDelay ? 30 : 0;

    if (deferredSeconds > 0) await wait(30000);

    const response = await base44.asServiceRole.functions.invoke('amazonApiGatewayCore', {
      ...body,
      _service_role: true,
    });
    const data = response?.data || response || {};

    return Response.json({
      ...data,
      outside_window: outsideWindow,
      deferred_seconds: deferredSeconds,
      message: outsideWindow
        ? data?.ok
          ? `Comando Amazon executado após postergação de ${deferredSeconds} segundos fora da janela.`
          : data?.errors?.[0]?.message || data?.error || `Comando Amazon postergado por ${deferredSeconds} segundos fora da janela.`
        : data?.message || data?.errors?.[0]?.message || null,
    });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error?.message || 'Erro ao postergar comando Amazon',
      deferred_seconds: 30,
    }, { status: 500 });
  }
});