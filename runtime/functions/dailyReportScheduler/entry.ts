import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const response = await base44.asServiceRole.functions.invoke('syncFullDaily', {
      amazon_account_id: body.amazon_account_id || null,
      trigger_type: 'automatic_midnight',
      _service_role: true,
    });
    return Response.json({ ...(response?.data || {}), redirected_to: 'syncFullDaily' });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Falha na rotina diária' }, { status: 500 });
  }
});
