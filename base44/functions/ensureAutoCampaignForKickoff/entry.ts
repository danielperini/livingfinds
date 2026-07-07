/**
 * ensureAutoCampaignForKickoff
 *
 * Garante que todo Kick-off tenha uma campanha AUTO completa:
 *  1. Verifica se já existe campanha AUTO para o ASIN (ENABLED/PAUSED/em criação)
 *  2. Se sim: vincula, ativa se necessário, repara componentes faltantes
 *  3. Se não: cria via autoKickoffProductV2 e registra ciclo de lifecycle
 *
 * Chamado por: autoKickoffProductV3 (substituindo ou complementando)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function norm(s: string) {
  return (s || '').toLowerCase().trim();
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const now = new Date().toISOString();

  try {
    const body = await req.json().catch(() => ({}));
    const serviceRole = body._service_role === true;
    if (!serviceRole) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { amazon_account_id, asin, sku, product_id, dry_run = false } = body;
    if (!amazon_account_id || !asin) {
      return Response.json({ ok: false, error: 'amazon_account_id e asin são obrigatórios' }, { status: 400 });
    }

    // ── Verificar campanha AUTO existente ──────────────────────────────
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id, asin }, null, 100
    );
    const autoCampaigns = allCampaigns.filter((c: any) => {
      const targeting = norm(c.targeting_type || c.campaign_type || '');
      const name = norm(c.name || c.campaign_name || '');
      const state = norm(c.state || c.status || '');
      return (targeting === 'auto' || name.includes('auto')) && state !== 'archived';
    });

    const activeCampaign = autoCampaigns.find((c: any) => {
      const state = norm(c.state || c.status || '');
      return state === 'enabled' || state === 'paused' || state === 'incomplete';
    });

    if (activeCampaign) {
      // Campanha existe — verificar completude
      const adGroups = await base44.asServiceRole.entities.AdGroup.filter(
        { amazon_account_id, campaign_id: activeCampaign.campaign_id }, null, 10
      );
      const productAds = await base44.asServiceRole.entities.ProductAd.filter(
        { amazon_account_id, campaign_id: activeCampaign.campaign_id }, null, 10
      );
      const hasAdGroup = adGroups.length > 0;
      const hasProductAd = productAds.some((pa: any) => pa.asin === asin);
      const isEnabled = norm(activeCampaign.state || activeCampaign.status || '') === 'enabled';
      const isComplete = hasAdGroup && hasProductAd && isEnabled;

      if (!isComplete && !dry_run) {
        // Enfileirar reparo
        await base44.asServiceRole.entities.AmazonActionQueue.create({
          amazon_account_id,
          operation: 'repair_auto_campaign',
          entity_type: 'campaign',
          entity_id: activeCampaign.campaign_id,
          payload: { asin, campaign_id: activeCampaign.campaign_id, sku, needs_ad_group: !hasAdGroup, needs_product_ad: !hasProductAd },
          idempotency_key: `repair_auto_${asin}_${activeCampaign.campaign_id}`,
          priority: 'high',
          status: 'pending',
          scheduled_at: now,
          source: 'ensureAutoCampaignForKickoff',
        });
        // Atualizar status da campanha no banco
        await base44.asServiceRole.entities.Campaign.update(activeCampaign.id, {
          state: 'incomplete',
          completion_status: 'incomplete',
        }).catch(() => {});
      }

      return Response.json({
        ok: true,
        action: isComplete ? 'existing_complete' : 'existing_repair_queued',
        campaign_id: activeCampaign.campaign_id,
        campaign_name: activeCampaign.name || activeCampaign.campaign_name,
        is_complete: isComplete,
        has_ad_group: hasAdGroup,
        has_product_ad: hasProductAd,
        is_enabled: isEnabled,
        dry_run,
      });
    }

    // ── Nenhuma AUTO existe → criar ────────────────────────────────────
    if (dry_run) {
      return Response.json({ ok: true, action: 'would_create', asin, dry_run: true });
    }

    const kickoffRes = await base44.asServiceRole.functions.invoke('autoKickoffProductV2', {
      amazon_account_id, asin, sku, product_id, _service_role: true, force_create: true,
    });
    const kickoff = kickoffRes?.data || {};

    if (!kickoff?.ok && !kickoff?.scheduled) {
      return Response.json({
        ok: false, action: 'kickoff_failed',
        error: kickoff?.error || 'Falha ao criar campanha AUTO',
        campaign_id: kickoff?.auto_campaign?.campaign_id || null,
      });
    }

    const campaignId = kickoff?.auto_campaign?.campaign_id || null;

    // Registrar lifecycle para keywords criadas pela IA
    if (campaignId && Array.isArray(kickoff?.ai_keywords)) {
      const now48h = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      const records = kickoff.ai_keywords.map((kw: any) => ({
        amazon_account_id,
        asin,
        sku: sku || '',
        campaign_id: campaignId,
        ad_group_id: kickoff?.auto_campaign?.ad_group_id || '',
        keyword_id: kw.keyword_id || '',
        keyword_text: kw.keyword_text || kw.keyword || '',
        normalized_keyword: (kw.keyword_text || kw.keyword || '').toLowerCase().trim(),
        match_type: kw.match_type || 'broad',
        source: 'ai_generated',
        status: 'experimental',
        enabled_at: now,
        evaluation_due_at: now48h,
        created_at: now,
        updated_at: now,
      }));
      if (records.length > 0) {
        await base44.asServiceRole.entities.KeywordLifecycle.bulkCreate(records);
      }
    }

    return Response.json({
      ok: true,
      action: 'created',
      campaign_id: campaignId,
      kickoff,
    });
  } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
});