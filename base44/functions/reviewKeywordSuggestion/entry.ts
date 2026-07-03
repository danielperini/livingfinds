import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function slotFromId(id) {
  const text = String(id || '0');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return Math.abs(hash) % 4;
}

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

    const alreadyApproved = action === 'approve' && (
      ['approved', 'created'].includes(suggestion.status) ||
      ['scheduled', 'processing', 'completed'].includes(suggestion.queue_status)
    );
    const alreadyDeleted = action === 'delete' && (
      suggestion.status === 'rejected' || suggestion.deleted_by_user === true
    );
    if (alreadyApproved || alreadyDeleted) {
      return Response.json({
        ok: true,
        action,
        already_processed: true,
        completed_ui: true,
        queue_hour: action === 'approve' ? suggestion.queue_hour ?? slotFromId(suggestion.id) : null,
      });
    }

    const products = suggestion.asin
      ? await base44.asServiceRole.entities.Product.filter({ amazon_account_id: suggestion.amazon_account_id, asin: suggestion.asin }, '-updated_at', 1)
      : [];
    const product = products[0] || null;
    const productName = product?.product_name || product?.display_name || suggestion.product_name || null;
    const sku = suggestion.sku || product?.sku || null;
    const now = new Date().toISOString();

    if (action === 'approve') {
      const hour = slotFromId(suggestion.id);
      await base44.asServiceRole.entities.KeywordSuggestion.update(suggestion.id, {
        status: 'approved',
        approved_at: now,
        approved_by: user.email || user.id,
        queue_status: 'scheduled',
        queue_hour: hour,
        queue_window: `${String(hour).padStart(2, '0')}:00-${String(hour + 1).padStart(2, '0')}:00`,
        queued_at: now,
      });
    } else {
      await base44.asServiceRole.entities.KeywordSuggestion.update(suggestion.id, {
        status: 'rejected',
        deleted_by_user: true,
        rejected_at: now,
        queue_status: 'completed',
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

    return Response.json({
      ok: true,
      action,
      completed_ui: true,
      product_name: productName,
      sku,
      queue_hour: action === 'approve' ? slotFromId(suggestion.id) : null,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao revisar sugestão' }, { status: 500 });
  }
});
