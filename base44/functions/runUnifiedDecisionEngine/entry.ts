import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * runUnifiedDecisionEngine
 *
 * Entrada canônica e única do motor de decisões do LivingFinds.
 * Toda execução delega ao motor determinístico principal, que concentra:
 * - metas e guardrails de PerformanceSettings;
 * - estoque e velocidade real via SP-API;
 * - métricas Amazon Ads persistidas;
 * - idempotência, cooldown e auditoria;
 * - geração de decisões para a fila oficial do Autopilot.
 *
 * Esta função existe para impedir que motores paralelos produzam decisões
 * concorrentes para a mesma conta, campanha ou keyword.
 */
Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);

    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const payload = {
      ...body,
      _service_role: true,
      source_function: body.source_function || 'runUnifiedDecisionEngine',
      engine_version: 'unified-v1',
    };

    const result = await base44.asServiceRole.functions.invoke(
      'runDeterministicDecisionEngine',
      payload,
    );

    const data = result?.data || result || {};

    return Response.json({
      ok: data?.ok !== false,
      engine: 'unified',
      delegated_to: 'runDeterministicDecisionEngine',
      amazon_account_id: body.amazon_account_id || null,
      result: data,
    });
  } catch (error: any) {
    return Response.json(
      {
        ok: false,
        engine: 'unified',
        error: error?.message || 'Falha no motor unificado de decisões',
      },
      { status: 500 },
    );
  }
});
