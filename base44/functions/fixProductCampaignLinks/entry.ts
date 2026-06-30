import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id } = body;
    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    // Buscar TODAS as campanhas (não só criadas pelo app)
    const campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id }, '-created_date', 500);

    // Mapear por ASIN → campanha mais relevante (enabled > paused, mais recente)
    const asinCampaignMap = new Map();
    for (const c of campaigns) {
      if (!c.asin) continue;
      if (c.state === 'archived' || c.status === 'archived') continue;
      const existing = asinCampaignMap.get(c.asin);
      // Preferir enabled sobre paused
      if (!existing || (c.state === 'enabled' && existing.state !== 'enabled')) {
        asinCampaignMap.set(c.asin, {
          campaign_id: c.campaign_id,
          state: c.state || c.status || 'enabled',
        });
      }
    }

    // Buscar todos os produtos
    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id }, '-created_date', 500);

    let updated = 0;
    for (const product of products) {
      const campaignInfo = asinCampaignMap.get(product.asin);
      if (campaignInfo) {
        const campaignStatus = campaignInfo.state === 'enabled' ? 'active' : 'paused';
        // Atualizar sempre para garantir consistência
        await base44.asServiceRole.entities.Product.update(product.id, {
          linked_campaign_id: campaignInfo.campaign_id,
          has_campaign: true,
          campaign_status: campaignStatus,
        });
        updated++;
      } else if (product.linked_campaign_id || product.has_campaign) {
        // Produto tinha campanha mas não existe mais — limpar
        await base44.asServiceRole.entities.Product.update(product.id, {
          linked_campaign_id: null,
          has_campaign: false,
          campaign_status: 'none',
        });
      }
    }

    return Response.json({
      ok: true,
      updated,
      total_campaigns: campaigns.length,
      total_products: products.length,
      asins_with_campaigns: asinCampaignMap.size,
      message: `${updated} produtos vinculados a campanhas`,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});