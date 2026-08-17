import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * syncFullDaily
 * Agendamento esperado no Base44: todos os dias às 00:00 no fuso America/Sao_Paulo.
 * Executa todas as integrações Amazon por meio de syncAllAmazonApis.
 */
Deno.serve(async (request) => {
  const startedAt = Date.now();

  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));

    const response = await base44.asServiceRole.functions.invoke('syncAllAmazonApis', {
      amazon_account_id: body.amazon_account_id || null,
      trigger_type: body.trigger_type || 'automatic_midnight',
      _service_role: true,
    });

    const data = response?.data || response || {};
    return Response.json({
      ...data,
      scheduler: {
        frequency: 'daily',
        local_time: '00:00',
        timezone: 'America/Sao_Paulo',
      },
      duration_ms: data.duration_ms || Date.now() - startedAt,
    });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error?.message || 'Falha no sync diário geral',
      scheduler: {
        frequency: 'daily',
        local_time: '00:00',
        timezone: 'America/Sao_Paulo',
      },
      duration_ms: Date.now() - startedAt,
    }, { status: 500 });
  }
});
