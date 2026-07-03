import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, asin, sku, product_name, mode = 'auto_only', manual_term = '' } = body;
    if (!amazon_account_id || !asin) return Response.json({ ok: false, error: 'Conta e ASIN são obrigatórios' }, { status: 400 });

    const campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id, asin }, '-created_date', 100);
    const active = campaigns.filter((c) => !['archived', 'ended'].includes(String(c.state || c.status).toLowerCase()));
    if (active.length >= 25) return Response.json({ ok: false, error: 'Limite de 25 campanhas por produto atingido', blocked: true }, { status: 409 });

    const auto = await base44.functions.invoke('createAutoCampaignForAsin', {
      amazon_account_id,
      asin,
      sku,
      product_name,
    });
    if (!auto?.data?.ok && !String(auto?.data?.error || '').toLowerCase().includes('already exists')) {
      return Response.json({ ok: false, error: auto?.data?.error || 'Falha ao criar campanha automática' }, { status: 502 });
    }

    let manualCreated = 0;
    if (mode === 'auto_plus_manual' && String(manual_term).trim()) {
      if (active.length + 1 >= 25) return Response.json({ ok: false, error: 'Sem espaço para nova campanha manual' }, { status: 409 });
      const manual = await base44.functions.invoke('createManualCampaignFromKeywordSuggestion', {
        amazon_account_id,
        asin,
        sku,
        product_name,
        keyword: String(manual_term).trim(),
        match_type: 'exact',
        bid: 0.50,
      });
      if (!manual?.data?.ok) return Response.json({ ok: false, error: manual?.data?.error || 'Falha ao criar termo manual' }, { status: 502 });
      manualCreated = 1;
    }

    const suggestions = await base44.functions.invoke('suggestProductKeywordsWithAI', {
      amazon_account_id,
      asin,
    }).catch(() => null);
    const all = [...(suggestions?.data?.long_tail || []), ...(suggestions?.data?.medium_tail || [])]
      .filter((s) => s?.status === 'suggested' && s?.id);

    const remainingSlots = Math.max(0, 25 - active.length - manualCreated - 1);
    const autoCreate = all
      .filter((s) => Number(s.confidence || 0) >= 0.95)
      .slice(0, remainingSlots);
    const pending = all.filter((s) => Number(s.confidence || 0) < 0.95);

    for (const suggestion of pending) {
      await base44.asServiceRole.entities.AgentAction.create({
        amazon_account_id,
        action: 'create_manual_campaign',
        asin,
        keyword: suggestion.keyword,
        reason: 'Sugestão do Kick-off aguardando aprovação',
        evidence: JSON.stringify({ confidence: suggestion.confidence, source: 'kickoff_auto_analysis' }),
        risk_level: 'medium',
        requires_approval: true,
        status: 'pending',
      }).catch(() => {});
    }

    let createdFromAI = 0;
    for (const suggestion of autoCreate) {
      const res = await base44.functions.invoke('createManualCampaignFromKeywordSuggestion', {
        amazon_account_id,
        suggestion_ids: [suggestion.id],
      }).catch(() => null);
      if (res?.data?.ok || res?.data?.results?.some((r) => r.ok || r.already_exists)) createdFromAI += 1;
    }

    const now = new Date().toISOString();
    await base44.asServiceRole.entities.LearningEvent.create({
      amazon_account_id,
      event_type: 'kickoff_v2_completed',
      entity_type: 'product',
      entity_id: asin,
      observation: JSON.stringify({ auto_campaign: true, manual_created: manualCreated + createdFromAI, pending_approval: pending.length, max_campaigns: 25 }),
      recorded_at: now,
    }).catch(() => {});

    return Response.json({
      ok: true,
      message: 'Kick-off enviado com sucesso',
      auto_campaign_created: true,
      manual_campaigns_created: manualCreated + createdFromAI,
      pending_approval: pending.length,
      campaign_limit: 25,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro no Kick-off' }, { status: 500 });
  }
});
