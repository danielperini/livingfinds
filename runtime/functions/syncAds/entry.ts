import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const response = await base44.asServiceRole.functions.invoke('syncAdsCampaignStatesV2', {
      ...body,
      _service_role: true,
    });
    return Response.json(response?.data || response || {});
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao sincronizar campanhas Ads' }, { status: 500 });
  }
});
