import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function stateOf(value) {
  const state = String(value || '').toLowerCase();
  if (['enabled', 'active', 'ativa', 'ativada'].includes(state)) return 'enabled';
  if (['paused', 'pausada'].includes(state)) return 'paused';
  if (['archived', 'ended', 'encerrada', 'deleted'].includes(state)) return 'archived';
  return state;
}

function asinOf(campaign) {
  if (campaign.asin) return String(campaign.asin).toUpperCase();
  const name = String(campaign.name || campaign.campaign_name || '');
  const match = name.match(/B0[A-Z0-9]{8}/i);
  return match ? match[0].toUpperCase() : null;
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    if (!body.amazon_account_id) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });

    const campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: body.amazon_account_id }, '-updated_at', 5000);
    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: body.amazon_account_id }, '-updated_at', 5000);
    const map = new Map();

    for (const campaign of campaigns) {
      const asin = asinOf(campaign);
      const state = stateOf(campaign.state || campaign.status);
      if (!asin || state === 'archived') continue;
      const current = map.get(asin);
      const currentState = current ? stateOf(current.state || current.status) : null;
      if (!current || (state === 'enabled' && currentState !== 'enabled')) map.set(asin, campaign);
    }

    let updated = 0;
    let active = 0;
    let paused = 0;

    for (const product of products) {
      const campaign = map.get(String(product.asin || '').toUpperCase());
      if (!campaign?.campaign_id) continue;
      const status = stateOf(campaign.state || campaign.status) === 'enabled' ? 'active' : 'paused';
      await base44.asServiceRole.entities.Product.update(product.id, {
        linked_campaign_id: String(campaign.campaign_id),
        has_campaign: true,
        campaign_status: status,
        linked_campaign_name: campaign.name || campaign.campaign_name || null,
        campaign_link_updated_at: new Date().toISOString(),
      });
      updated++;
      if (status === 'active') active++;
      else paused++;
    }

    return Response.json({ ok: true, updated, active, paused, message: `${active} produto(s) com campanha ativa devem exibir Pausar.` });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao restaurar vínculos de campanhas' }, { status: 500 });
  }
});
