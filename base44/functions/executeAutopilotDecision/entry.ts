import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const response = await base44.functions.invoke('executeAutopilotDecisionV2', body);
    return Response.json(response?.data || response || {});
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao executar decisão' }, { status: 500 });
  }
});
