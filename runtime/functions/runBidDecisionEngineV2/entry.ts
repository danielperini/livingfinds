import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * Compatibilidade legada.
 *
 * O antigo runBidDecisionEngineV2 operava em paralelo ao motor principal e
 * podia criar decisões concorrentes em OptimizationDecision e RuleExecution.
 * A partir desta versão, todas as chamadas são encaminhadas para o motor único.
 *
 * Não remover esta função enquanto existirem schedules, botões ou integrações
 * antigas apontando para este nome.
 */
Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);

    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const result = await base44.asServiceRole.functions.invoke(
      'runUnifiedDecisionEngine',
      {
        ...body,
        _service_role: true,
        source_function: 'runBidDecisionEngineV2:legacy-wrapper',
      },
    );

    return Response.json({
      ok: result?.data?.ok !== false,
      deprecated: true,
      replacement: 'runUnifiedDecisionEngine',
      result: result?.data || result || {},
    });
  } catch (error: any) {
    return Response.json(
      {
        ok: false,
        deprecated: true,
        replacement: 'runUnifiedDecisionEngine',
        error: error?.message || 'Falha ao encaminhar para o motor unificado',
      },
      { status: 500 },
    );
  }
});
