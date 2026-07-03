import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const result = await base44.functions.invoke('requestProductReportsV2', body);
    return Response.json(result?.data || result || {});
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao solicitar relatórios' }, { status: 500 });
  }
});