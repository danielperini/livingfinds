import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const response = await base44.asServiceRole.functions.invoke('autoKickoffProductV3', {
      ...body,
      _service_role: true,
    });
    const data = response?.data || response || {};
    return Response.json(data, { status: data?.ok === false && !data?.scheduled ? 500 : 200 });
  } catch (error) {
    return Response.json({ ok: false, completion_status: 'incomplete', error: error?.message || 'Erro no Kick-off' }, { status: 500 });
  }
});
