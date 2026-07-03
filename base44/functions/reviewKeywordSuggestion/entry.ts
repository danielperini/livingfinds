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
    const s = found[0];
    if (!s) return Response.json({ ok: false, error: 'Sugestão não encontrada' }, { status: 404 });

    const products = s.asin ? await base44.asServiceRole.entities.Product.filter({ amazon_account_id: s.amazon_account_id, asin: s.asin }, '-updated_at', 1) : [];
    const product = products[0] || null;
    const productName = product?.product_name || product?.display_name || s.product_name || null;
    const sku = s.sku || product?.sku || null;

    if (action === 'approve') {
      const key = String(s.keyword || '').trim().toLowerCase();
      const existing = await base44.asServiceRole.entities.TermBank.filter({ amazon_account_id: s.amazon_account_id, normalized_term: key }, '-updated_at', 1);
      const term = {
        amazon_account_id: s.amazon_account_id,
        term: s.keyword,
        normalized_term: key,
        asin: s.asin || null,
        sku,
        product_name: productName,
        source: 'ai_suggestion',
        classification: 'new',
        match_type: s.match_type || 'exact',
        bid_initial: s.recommended_bid || 0.5,
        performance_score: Math.round((s.confidence || s.relevance_score || 0) * 100),
        last_seen_at: new Date().toISOString(),
      };
      if (existing.length) await base44.asServiceRole.entities.TermBank.update(existing[0].id, term);
      else await base44.asServiceRole.entities.TermBank.create(term);
      await base44.asServiceRole.entities.KeywordSuggestion.update(s.id, { status: 'approved', approved_at: new Date().toISOString() });
    } else {
      await base44.asServiceRole.entities.KeywordSuggestion.update(s.id, { status: 'rejected', deleted_by_user: true, rejected_at: new Date().toISOString() });
    }

    await base44.asServiceRole.entities.LearningEvent.create({
      amazon_account_id: s.amazon_account_id,
      event_type: action === 'approve' ? 'keyword_suggestion_approved' : 'keyword_suggestion_deleted',
      entity_type: 'keyword_suggestion',
      entity_id: s.id,
      asin: s.asin || null,
      keyword: s.keyword,
      outcome: action === 'approve' ? 'positive' : 'negative',
      source: s.source || 'ai_suggestion',
      metadata: JSON.stringify({ product_name: productName, sku, confidence: s.confidence || s.relevance_score || 0, reviewer: user.email || user.id }),
    });

    return Response.json({ ok: true, action, product_name: productName, sku });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao revisar sugestão' }, { status: 500 });
  }
});
