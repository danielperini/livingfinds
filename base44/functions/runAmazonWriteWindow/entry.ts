/**
 * runAmazonWriteWindow — Janela de escrita Amazon Ads
 *
 * Dispara operações de escrita na Amazon durante a janela 16:00-18:00 BRT,
 * incluindo o pipeline de canonização de campanhas manuais.
 * Sem janela horária rígida para enforce_canonical (pode rodar a qualquer hora).
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

function brazilHour() {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === 'hour')?.value || 0);
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    const hour = Number(body.hour ?? brazilHour());
    const force = body.force === true;
    const operation = body.operation || 'all';

    if (operation === 'enforce_canonical' || operation === 'all') {
      const pendingLog = await base44.asServiceRole.entities.SyncExecutionLog.filter(
        { amazon_account_id: body.amazon_account_id || null, operation: 'enforce_canonical_manual_campaigns', status: 'success' },
        '-started_at', 1
      ).catch(() => []);
      const lastResult = pendingLog[0]?.result_summary ? JSON.parse(pendingLog[0].result_summary) : null;
      const stillPending = lastResult?.remaining_invalid > 0 || lastResult?.continuation_required === true || !lastResult;

      if (stillPending || force) {
        base44.asServiceRole.functions.invoke('enforceCanonicalManualCampaigns', {
          amazon_account_id: body.amazon_account_id || null,
          _service_role: true,
          max_per_run: Number(body.canonical_max_per_run || 20),
        }).catch(() => {});
      }

      if (operation === 'enforce_canonical') {
        return Response.json({ ok: true, dispatched: 'enforceCanonicalManualCampaigns', still_pending: stillPending });
      }
    }

    if (![16, 17].includes(hour) && !force) {
      return Response.json({ ok: true, skipped: true, hour, reason: 'Fora da janela 16:00-18:00 BRT' });
    }

    const response = await base44.asServiceRole.functions.invoke('processAmazonNightWindow', {
      amazon_account_id: body.amazon_account_id || null,
      hour,
      _service_role: true,
    });

    const data = response?.data || response || {};
    return Response.json({
      ok: data?.ok !== false,
      window: '16:00-18:00 America/Sao_Paulo',
      hour,
      result: data,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha na janela Amazon' }, { status: 500 });
  }
});