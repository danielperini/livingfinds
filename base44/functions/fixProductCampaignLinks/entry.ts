import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id } = body;
    
    if (!amazon_account_id) {
      return Response.json({ error: 'amazon_account_id required' }, { status: 400 });
    }

    // Buscar todas as campanhas AUTO criadas pelo app
    const campaigns = await base44.asServiceRole.entities.Campaign.filter({ 
      amazon_account_id,
      created_by_app: true 
    });

    if (campaigns.length === 0) {
      return Response.json({ ok: true, updated: 0, message: 'Nenhuma campanha criada pelo app encontrada' });
    }

    // Extrair ASINs das campanhas
    const asinCampaignMap = new Map();
    campaigns.forEach(c => {
      if (c.asin && !asinCampaignMap.has(c.asin)) {
        asinCampaignMap.set(c.asin, {
          campaign_id: c.campaign_id,
          state: c.state || c.status || 'enabled',
        });
      }
    });

    // Buscar produtos sem linked_campaign_id mas que têm campanha
    const products = await base44.asServiceRole.entities.Product.filter({ 
      amazon_account_id 
    });

    let updated = 0;
    for (const product of products) {
      const campaignInfo = asinCampaignMap.get(product.asin);
      if (campaignInfo && (!product.linked_campaign_id || !product.has_campaign)) {
        await base44.asServiceRole.entities.Product.update(product.id, {
          linked_campaign_id: campaignInfo.campaign_id,
          has_campaign: true,
          campaign_status: campaignInfo.state === 'enabled' ? 'active' : 'paused',
        });
        updated++;
      }
    }

    await base44.asServiceRole.entities.LearningEvent.create({
      amazon_account_id,
      event_type: 'data_fix',
      entity_type: 'product',
      observation: `Corrigida vinculação de ${updated} produtos com campanhas existentes`,
      recorded_at: new Date().toISOString(),
    });

    return Response.json({ 
      ok: true, 
      updated,
      total_campaigns: campaigns.length,
      message: `${updated} produtos atualizados com linked_campaign_id` 
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});