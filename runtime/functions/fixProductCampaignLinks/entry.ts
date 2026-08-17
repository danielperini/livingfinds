import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));

    // Resolver amazon_account_id se não fornecido
    let aid = body.amazon_account_id;
    if (!aid) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, null, 1);
      aid = accs[0]?.id || null;
    }
    if (!aid) return Response.json({ ok: false, error: 'Nenhuma conta conectada' }, { status: 400 });

    const response = await base44.asServiceRole.functions.invoke('fixProductCampaignLinksV2', {
      ...body,
      amazon_account_id: aid,
      _service_role: true,
    });
    return Response.json(response?.data || response || {});
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao vincular produtos e campanhas' }, { status: 500 });
  }
});