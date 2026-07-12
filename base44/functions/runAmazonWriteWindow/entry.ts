import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

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
    if (![16, 17].includes(hour)) {
      return Response.json({ ok: true, skipped: true, hour, reason: 'Fora da janela 16:00-18:00 BRT' });
    }

    const canonicalResponse = await base44.asServiceRole.functions.invoke('enforceCanonicalManualCampaigns', {
      amazon_account_id: body.amazon_account_id || null,
      max_per_run: Number(body.canonical_max_per_run || 10),
      _service_role: true,
    });
    const canonical = canonicalResponse?.data || canonicalResponse || {};

    const response = await base44.asServiceRole.functions.invoke('processAmazonNightWindow', {
      amazon_account_id: body.amazon_account_id || null,
      hour,
      _service_role: true,
    });

    const data = response?.data || response || {};
    return Response.json({
      ok: canonical?.ok !== false && data?.ok !== false,
      window: '16:00-18:00 America/Sao_Paulo',
      hour,
      canonical_manual_campaigns: canonical,
      continuation_required: Boolean(canonical?.continuation_required || data?.continuation_required),
      result: data,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Falha na janela Amazon' }, { status: 500 });
  }
});
