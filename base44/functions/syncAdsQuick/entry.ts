/**
 * syncAdsQuick — fachada compatível para atualização rápida do Dashboard.
 *
 * Não faz polling bloqueante e não grava resumo de 30 dias na data atual.
 * O fluxo real fica em syncYesterdayClosedData + AmazonAdsReportJob.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (request) => {
  const startedMs = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const auth = await base44.auth.isAuthenticated().catch(() => false);
    if (!auth && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accountId = body.amazon_account_id;
    if (!accountId) {
      return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });
    }

    // Compatibilidade: quando um job já está completo, permitir processamento
    // explícito sem repetir a solicitação.
    if (body.action === 'download') {
      let job = null;
      if (body.job_id) {
        const rows = await base44.asServiceRole.entities.AmazonAdsReportJob.filter({ id: body.job_id }, null, 1).catch(() => []);
        job = rows[0] || null;
      } else if (body.report_id) {
        const rows = await base44.asServiceRole.entities.AmazonAdsReportJob.filter({
          amazon_account_id: accountId,
          report_id: body.report_id,
        }, '-created_at', 1).catch(() => []);
        job = rows[0] || null;
      }

      if (!job) {
        return Response.json({ ok: false, error: 'Job de relatório não encontrado' }, { status: 404 });
      }
      if (job.status === 'processed') {
        return Response.json({ ok: true, ready: true, already_processed: true, job_id: job.id });
      }
      if (!job.url || job.status !== 'completed') {
        return Response.json({
          ok: true,
          ready: false,
          pending: true,
          job_id: job.id,
          report_id: job.report_id,
          status: job.status,
          next_poll_at: job.next_poll_at,
          message: 'Relatório ainda está sendo processado pela Amazon.',
        });
      }

      const response = await base44.asServiceRole.functions.invoke('downloadAndProcessAmazonAdsReportJob', {
        job_id: job.id,
        _service_role: true,
      });
      const data = response?.data || response || {};
      return Response.json({ ...data, ready: data?.ok === true, duration_ms: Date.now() - startedMs });
    }

    // action=request e chamada padrão usam o mesmo pipeline idempotente.
    const response = await base44.asServiceRole.functions.invoke('syncYesterdayClosedData', {
      amazon_account_id: accountId,
      date: body.date || null,
      force: body.force === true,
      trigger_type: body.trigger_type || (body.action === 'request' ? 'dashboard_request' : 'dashboard_update_now'),
      _service_role: true,
    });
    const data = response?.data || response || {};

    return Response.json({
      ...data,
      asynchronous: true,
      action: body.action || 'request_and_schedule',
      duration_ms: Date.now() - startedMs,
    }, { status: data?.ok === false && data?.accepted !== true ? 502 : 200 });
  } catch (error: any) {
    return Response.json({
      ok: false,
      error: String(error?.message || 'Falha no sync rápido').slice(0, 500),
      asynchronous: true,
      previous_data_preserved: true,
      duration_ms: Date.now() - startedMs,
    }, { status: 500 });
  }
});
