/**
 * reviewKeywordSuggestion
 *
 * approve → chama createManualCampaignFromKeywordSuggestion imediatamente e
 *           grava o termo no TermBank com o status real da campanha criada.
 * delete  → rejeita a sugestão e registra evento de aprendizado.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const id = body.suggestion_id;
    const action = body.action;
    if (!id || !['approve', 'delete'].includes(action)) {
      return Response.json({ ok: false, error: 'Parâmetros inválidos' }, { status: 400 });
    }

    const found = await base44.asServiceRole.entities.KeywordSuggestion.filter({ id }, null, 1);
    const suggestion = found[0];
    if (!suggestion) return Response.json({ ok: false, error: 'Sugestão não encontrada' }, { status: 404 });

    const now = new Date().toISOString();
    const products = suggestion.asin
      ? await base44.asServiceRole.entities.Product.filter(
          { amazon_account_id: suggestion.amazon_account_id, asin: suggestion.asin }, '-updated_at', 1
        )
      : [];
    const product = products[0] || null;
    const productName = product?.product_name || product?.display_name || suggestion.product_name || null;
    const sku = suggestion.sku || product?.sku || null;

    // ── DELETE ────────────────────────────────────────────────────────────────
    if (action === 'delete') {
      if (suggestion.status === 'rejected' || suggestion.deleted_by_user === true) {
        return Response.json({ ok: true, action, already_processed: true });
      }
      await base44.asServiceRole.entities.KeywordSuggestion.update(id, {
        status: 'rejected',
        deleted_by_user: true,
        rejected_at: now,
      });
      await base44.asServiceRole.entities.LearningEvent.create({
        amazon_account_id: suggestion.amazon_account_id,
        event_type: 'keyword_suggestion_deleted',
        entity_type: 'keyword_suggestion',
        entity_id: id,
        asin: suggestion.asin || null,
        keyword: suggestion.keyword,
        outcome: 'negative',
        source: suggestion.source || 'ai_suggestion',
        metadata: JSON.stringify({ product_name: productName, sku, reviewer: user.email || user.id }),
      }).catch(() => {});
      return Response.json({ ok: true, action: 'delete', product_name: productName });
    }

    // ── APPROVE ───────────────────────────────────────────────────────────────
    // Idempotência: se já foi criada retorna o status atual
    if (['approved', 'created'].includes(suggestion.status)) {
      const campStatus = suggestion.campaign_status || suggestion.status;
      return Response.json({
        ok: true,
        action,
        already_processed: true,
        campaign_status: campStatus,
        product_name: productName,
        amazon_campaign_id: suggestion.amazon_campaign_id,
      });
    }

    // Marcar como aprovada imediatamente (feedback para o usuário)
    await base44.asServiceRole.entities.KeywordSuggestion.update(id, {
      status: 'approved',
      approved_at: now,
      approved_by: user.email || user.id,
    });

    // ── Invocar criação de campanha manual ────────────────────────────────────
    let campaignResult: any = {};
    let campaignStatus = 'unknown';
    let campaignError = null;

    try {
      const res = await base44.asServiceRole.functions.invoke('createManualCampaignFromKeywordSuggestion', {
        amazon_account_id: suggestion.amazon_account_id,
        suggestion_ids: [id],
        _service_role: true,
      });
      const data = res?.data || res || {};
      const itemResult = data?.results?.[0] || {};

      if (itemResult.ok) {
        // Determinar status real da campanha criada
        // createManualCampaignFromKeywordSuggestion marca como 'created' mas não retorna completion_status
        // Buscar campanha criada para obter estado real
        if (itemResult.amazon_campaign_id) {
          const camps = await base44.asServiceRole.entities.Campaign.filter(
            { amazon_account_id: suggestion.amazon_account_id, campaign_id: String(itemResult.amazon_campaign_id) }, null, 1
          ).catch(() => []);
          const camp = camps[0];
          campaignStatus = camp?.status || camp?.state || 'enabled';
        } else {
          campaignStatus = 'enabled';
        }
        campaignResult = itemResult;
      } else if (itemResult.already_exists) {
        campaignStatus = 'enabled';
        campaignResult = itemResult;
      } else {
        campaignError = itemResult.error || data.error || 'Falha ao criar campanha';
        campaignStatus = 'failed';
      }
    } catch (err: any) {
      campaignError = err?.message || 'Erro ao invocar criação de campanha';
      campaignStatus = 'failed';
    }

    // ── Atualizar sugestão com status final da campanha ───────────────────────
    await base44.asServiceRole.entities.KeywordSuggestion.update(id, {
      campaign_status: campaignStatus,
      ...(campaignError ? { error: campaignError, status: 'failed' } : {}),
    }).catch(() => {});

    // ── Gravar/atualizar no TermBank com status real ───────────────────────────
    if (!campaignError && suggestion.asin && suggestion.keyword) {
      const normFn = (s: string) => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
      const termRows = await base44.asServiceRole.entities.TermBank.filter(
        { amazon_account_id: suggestion.amazon_account_id, asin: suggestion.asin },
        null, 200
      ).catch(() => []);
      const existing = (termRows as any[]).find(
        (t: any) => normFn(t.term) === normFn(suggestion.keyword)
      );
      const termPayload = {
        amazon_account_id: suggestion.amazon_account_id,
        asin: suggestion.asin,
        term: suggestion.keyword,
        term_normalized: normFn(suggestion.keyword),
        product_name: productName || '',
        match_type: 'exact',
        source: 'manual_kickoff',
        status: ['enabled', 'active'].includes(campaignStatus) ? 'active' : campaignStatus === 'incomplete' ? 'active' : 'paused',
        classification: campaignStatus === 'enabled' ? 'winner' : 'new',
        campaign_id: campaignResult?.campaign_record_id || null,
        amazon_campaign_id: campaignResult?.amazon_campaign_id || null,
        keyword_id: campaignResult?.keyword_id || null,
        bid_initial: suggestion.recommended_bid || 0.5,
        bid_current: suggestion.recommended_bid || 0.5,
        last_seen_at: now,
        created_at: now,
      };
      if (existing) {
        await base44.asServiceRole.entities.TermBank.update(existing.id, termPayload).catch(() => {});
      } else {
        await base44.asServiceRole.entities.TermBank.create(termPayload).catch(() => {});
      }
    }

    // ── Registrar evento de aprendizado ───────────────────────────────────────
    await base44.asServiceRole.entities.LearningEvent.create({
      amazon_account_id: suggestion.amazon_account_id,
      event_type: 'keyword_suggestion_approved',
      entity_type: 'keyword_suggestion',
      entity_id: id,
      asin: suggestion.asin || null,
      keyword: suggestion.keyword,
      outcome: campaignError ? 'negative' : 'positive',
      source: suggestion.source || 'ai_suggestion',
      metadata: JSON.stringify({
        product_name: productName, sku,
        campaign_status: campaignStatus,
        reviewer: user.email || user.id,
        error: campaignError,
      }),
    }).catch(() => {});

    if (campaignError) {
      return Response.json({
        ok: false,
        action,
        error: campaignError,
        campaign_status: 'failed',
        product_name: productName,
      });
    }

    return Response.json({
      ok: true,
      action,
      product_name: productName,
      campaign_status: campaignStatus,
      amazon_campaign_id: campaignResult?.amazon_campaign_id,
      keyword: suggestion.keyword,
      asin: suggestion.asin,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao revisar sugestão' }, { status: 500 });
  }
});