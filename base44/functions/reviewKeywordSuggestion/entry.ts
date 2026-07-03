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

    const products = suggestion.asin
      ? await base44.asServiceRole.entities.Product.filter({ amazon_account_id: suggestion.amazon_account_id, asin: suggestion.asin }, '-updated_at', 1)
      : [];
    const product = products[0] || null;
    const productName = product?.product_name || product?.display_name || suggestion.product_name || null;
    const sku = suggestion.sku || product?.sku || null;

    if (action === 'approve') {
      const creation = await base44.functions.invoke('createManualCampaignFromKeywordSuggestion', {
        amazon_account_id: suggestion.amazon_account_id,
        suggestion_ids: [suggestion.id],
      });
      const item = creation?.data?.results?.[0];
      if (!item?.ok && !item?.already_exists) {
        return Response.json({ ok: false, error: item?.error || creation?.data?.error || 'Falha ao criar campanha' }, { status: 422 });
      }

      const key = String(suggestion.keyword || '').trim().toLowerCase();
      const existing = await base44.asServiceRole.entities.TermBank.filter({ amazon_account_id: suggestion.amazon_account_id, normalized_term: key }, '-updated_at', 1);
      const baseRecord = {
        amazon_account_id: suggestion.amazon_account_id,
        term: suggestion.keyword,
        normalized_term: key,
        asin: suggestion.asin || null,
        sku,
        product_name: productName,
        source: 'ai_suggestion',
        match_type: suggestion.match_type || 'exact',
        status: item?.amazon_campaign_id ? 'active' : 'inactive',
        used_by_product: Boolean(item?.amazon_campaign_id),
        amazon_campaign_id: item?.amazon_campaign_id || null,
        bid_initial: suggestion.recommended_bid || 0.5,
        bid_current: item?.bid || suggestion.recommended_bid || 0.5,
        last_seen_at: new Date().toISOString(),
      };

      if (existing.length) {
        await base44.asServiceRole.entities.TermBank.update(existing[0].id, baseRecord);
      } else {
        await base44.asServiceRole.entities.TermBank.create({
          ...baseRecord,
          classification: 'new',
          impressions: 0,
          clicks: 0,
          spend: 0,
          sales: 0,
          orders: 0,
          acos: 0,
          roas: 0,
          cpc: 0,
          ctr: 0,
          conversion_rate: 0,
          performance_score: 0,
        });
      }
    } else {
      await base44.asServiceRole.entities.KeywordSuggestion.update(suggestion.id, {
        status: 'rejected',
        deleted_by_user: true,
        rejected_at: new Date().toISOString(),
      });
    }

    await base44.asServiceRole.entities.LearningEvent.create({
      amazon_account_id: suggestion.amazon_account_id,
      event_type: action === 'approve' ? 'keyword_suggestion_approved' : 'keyword_suggestion_deleted',
      entity_type: 'keyword_suggestion',
      entity_id: suggestion.id,
      asin: suggestion.asin || null,
      keyword: suggestion.keyword,
      outcome: action === 'approve' ? 'positive' : 'negative',
      source: suggestion.source || 'ai_suggestion',
      metadata: JSON.stringify({ product_name: productName, sku, confidence: suggestion.confidence || suggestion.relevance_score || 0, reviewer: user.email || user.id }),
    });

    return Response.json({ ok: true, action, product_name: productName, sku });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao revisar sugestão' }, { status: 500 });
  }
});
