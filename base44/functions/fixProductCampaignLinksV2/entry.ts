import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function stateOf(value) {
  const state = String(value || '').toLowerCase();
  if (['enabled', 'active', 'ativa', 'ativada', 'serving'].includes(state)) return 'enabled';
  if (['paused', 'pausada', 'disabled'].includes(state)) return 'paused';
  if (['incomplete', 'pending', 'draft', 'processing', 'pending_insertion', 'em inserção', 'em insercao'].includes(state)) return 'incomplete';
  if (['archived', 'ended', 'encerrada', 'deleted', 'removed'].includes(state)) return 'archived';
  return state;
}

function asinOf(campaign) {
  if (campaign.asin) return String(campaign.asin).toUpperCase();
  const name = String(campaign.name || campaign.campaign_name || '');
  const match = name.match(/B0[A-Z0-9]{8}/i);
  return match ? match[0].toUpperCase() : null;
}

function priorityOf(campaign) {
  const state = stateOf(campaign.amazon_status || campaign.state || campaign.status);
  if (state === 'enabled') return 4;
  if (state === 'incomplete') return 3;
  if (state === 'paused') return 2;
  return 1;
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
    const campaignsByAsin = new Map();

    for (const campaign of campaigns) {
      const asin = asinOf(campaign);
      const state = stateOf(campaign.amazon_status || campaign.state || campaign.status);
      if (!asin || state === 'archived' || campaign.api_missing === true) continue;
      if (!campaignsByAsin.has(asin)) campaignsByAsin.set(asin, []);
      campaignsByAsin.get(asin).push(campaign);
    }

    let updated = 0;
    let active = 0;
    let incomplete = 0;
    let paused = 0;
    let withoutCampaign = 0;

    for (const product of products) {
      const asin = String(product.asin || '').toUpperCase();
      const linked = (campaignsByAsin.get(asin) || []).sort((a, b) => priorityOf(b) - priorityOf(a));
      const campaign = linked[0];

      if (!campaign?.campaign_id) {
        await base44.asServiceRole.entities.Product.update(product.id, {
          linked_campaign_id: null,
          has_campaign: false,
          campaign_status: 'none',
          linked_campaign_name: null,
          campaign_link_updated_at: new Date().toISOString(),
        });
        withoutCampaign += 1;
        continue;
      }

      const rawState = stateOf(campaign.amazon_status || campaign.state || campaign.status);
      const status = rawState === 'enabled' ? 'active' : rawState === 'incomplete' ? 'incomplete' : 'paused';

      await base44.asServiceRole.entities.Product.update(product.id, {
        linked_campaign_id: String(campaign.campaign_id),
        has_campaign: true,
        campaign_status: status,
        linked_campaign_name: campaign.name || campaign.campaign_name || null,
        linked_campaign_count: linked.length,
        linked_campaign_ids: linked.map((item) => String(item.campaign_id)),
        campaign_link_updated_at: new Date().toISOString(),
      });

      updated += 1;
      if (status === 'active') active += 1;
      else if (status === 'incomplete') incomplete += 1;
      else paused += 1;
    }

    return Response.json({
      ok: true,
      updated,
      active,
      incomplete,
      paused,
      without_campaign: withoutCampaign,
      products_with_campaign: updated,
      message: `${active} ativo(s), ${incomplete} em inserção, ${paused} pausado(s), ${withoutCampaign} sem campanha.`,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao restaurar vínculos de campanhas' }, { status: 500 });
  }
});
