import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const res = await base44.functions.invoke('syncAllAmazonApis', body);
    return Response.json({ ...(res?.data || {}), redirected_to: 'syncAllAmazonApis' });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});
