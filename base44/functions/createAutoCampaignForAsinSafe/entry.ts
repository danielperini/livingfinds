import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function isAutoCampaign(campaign) {
  const targeting = String(campaign?.targeting_type || campaign?.targetingType || '').toUpperCase();
  const name = String(campaign?.campaign_name || campaign?.name || '').toUpperCase();
  return targeting === 'AUTO' || name.includes('AUTO');
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const { amazon_account_id, asin, sku, product_name } = body;
    if (!amazon_account_id || !asin) {
      return Response.json({ ok: false, error: 'amazon_account_id e asin são obrigatórios' }, { status: 400 });
    }

    const campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id, asin }, '-created_date', 100);
    const existingAuto = campaigns.find((campaign) =>
      isAutoCampaign(campaign) &&
      campaign.archived !== true &&
      !['archived', 'ended'].includes(String(campaign.state || campaign.status).toLowerCase())
    );

    if (existingAuto?.campaign_id) {
      return Response.json({
        ok: true,
        already_exists: true,
        campaign_id: String(existingAuto.campaign_id),
        campaign_name: existingAuto.campaign_name || existingAuto.name,
        daily_budget: existingAuto.daily_budget || null,
        state: existingAuto.state || existingAuto.status || 'enabled',
        message: 'Campanha automática já existente e confirmada.',
      });
    }

    try {
      const response = await base44.functions.invoke('createAutoCampaignForAsin', {
        amazon_account_id,
        asin,
        sku: sku || null,
        product_name: product_name || asin,
      });

      const data = response?.data || {};
      if (data.ok) return Response.json(data);

      const text = `${data.error || ''} ${data.amazon_error || ''} ${data.response_sample || ''}`.toLowerCase();
      const duplicate = text.includes('duplicate') || text.includes('already exists') || text.includes('já existe');

      if (duplicate) {
        const refreshed = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id, asin }, '-created_date', 100);
        const reconciled = refreshed.find((campaign) => isAutoCampaign(campaign) && campaign.archived !== true);
        if (reconciled?.campaign_id) {
          return Response.json({
            ok: true,
            already_exists: true,
            campaign_id: String(reconciled.campaign_id),
            campaign_name: reconciled.campaign_name || reconciled.name,
            daily_budget: reconciled.daily_budget || null,
            message: 'Campanha automática existente reconciliada com sucesso.',
          });
        }
      }

      return Response.json({
        ok: false,
        error: data.error || 'Falha ao criar campanha automática.',
        http_status: data.http_status || null,
        request_id: data.request_id || null,
        amazon_error: data.amazon_error || null,
      }, { status: 200 });
    } catch (error) {
      const refreshed = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id, asin }, '-created_date', 100);
      const reconciled = refreshed.find((campaign) => isAutoCampaign(campaign) && campaign.archived !== true);
      if (reconciled?.campaign_id) {
        return Response.json({
          ok: true,
          already_exists: true,
          campaign_id: String(reconciled.campaign_id),
          campaign_name: reconciled.campaign_name || reconciled.name,
          message: 'Campanha automática encontrada após reconciliação.',
        });
      }

      return Response.json({
        ok: false,
        error: error?.message || 'Erro ao criar campanha automática.',
      }, { status: 200 });
    }
  } catch (error) {
    return Response.json({
      ok: false,
      error: error?.message || 'Erro inesperado no Kick-off.',
    }, { status: 200 });
  }
});
