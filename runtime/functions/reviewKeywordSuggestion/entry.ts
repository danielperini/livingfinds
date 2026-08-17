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

    // ── Invocar criação de campanha manual (v3 via createManualCampaignV2) ──────
    let campaignResult: any = {};
    let campaignStatus = 'unknown';
    let campaignError = null;

    try {
      const res = await base44.asServiceRole.functions.invoke('createManualCampaignV2', {
        amazon_account_id: suggestion.amazon_account_id,
        asin: suggestion.asin,
        keyword: suggestion.keyword,
        bid: suggestion.recommended_bid || 0.5,
        budget: suggestion.recommended_budget || 5,
        sku: sku || undefined,
        _service_role: true,
      });
      const data = res?.data || res || {};

      if (data.ok || data.already_exists) {
        campaignStatus = data.completion_status === 'complete' ? 'enabled'
          : data.already_exists ? 'enabled'
          : 'incomplete';
        campaignResult = data;

        // Marcar sugestão como criada
        await base44.asServiceRole.entities.KeywordSuggestion.update(id, {
          status: 'created',
          created_campaign_id: data.local_campaign_id || null,
          amazon_campaign_id: data.campaign_id ? String(data.campaign_id) : null,
          created_keyword_id: data.keyword_id || null,
          executed_at: now,
        }).catch(() => {});
      } else {
        // Traduzir erros comuns da Amazon para pt-BR
        const rawError = data.error || 'Falha ao criar campanha';
        if (rawError.includes('403') || rawError.includes('Unauthorized') || rawError.includes('Forbidden')) {
          campaignError = 'Token Amazon Ads expirado ou revogado. Reautorize em Integrações → Amazon.';
        } else if (rawError.includes('404')) {
          campaignError = 'Endpoint da Amazon não encontrado. Verifique a região da conta.';
        } else if (rawError.includes('OUT_OF_STOCK') || rawError.includes('estoque')) {
          campaignError = 'Produto sem estoque. Campanha não criada.';
        } else {
          campaignError = rawError;
        }
        campaignStatus = 'failed';
      }
    } catch (err: any) {
      const msg = err?.message || 'Erro ao invocar criação de campanha';
      campaignError = msg.includes('403') ? 'Token Amazon Ads expirado. Reautorize em Integrações → Amazon.' : msg;
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
        status: ['enabled', 'incomplete'].includes(campaignStatus) ? 'active' : 'paused',
        classification: campaignStatus === 'enabled' ? 'winner' : 'new',
        campaign_id: campaignResult?.local_campaign_id || null,
        amazon_campaign_id: campaignResult?.campaign_id ? String(campaignResult.campaign_id) : null,
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