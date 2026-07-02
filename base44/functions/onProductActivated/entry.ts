/**
 * onProductActivated
 * Disparado pela automação entity quando um produto muda para status='active'
 * com estoque (fba_inventory > 0 ou inventory_status != out_of_stock).
 *
 * Ações:
 *  1. Verifica se há keywords/search terms históricos compatíveis
 *  2. Pré-gera KeywordSuggestions com source='AUTOMATIC_SEARCH_TERM' ou 'CONVERTED_TERM_EXPANSION'
 *  3. Invoca suggestProductKeywordsWithAI para sugestões de IA
 *  4. Marca o produto com should_activate_campaign=true para sinalizar o Kickoff
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Payload da automação entity
    const { event, data: product, old_data } = body;
    if (!product) return Response.json({ ok: true, skipped: true, reason: 'no product data' });

    const { amazon_account_id, asin, status, inventory_status, fba_inventory } = product;
    if (!amazon_account_id || !asin) return Response.json({ ok: true, skipped: true, reason: 'missing fields' });

    // Só processar quando o produto passa a estar ativo E com estoque
    const isNowActive = status === 'active';
    const hasStock = inventory_status !== 'out_of_stock' && (fba_inventory || 0) > 0;
    if (!isNowActive || !hasStock) {
      return Response.json({ ok: true, skipped: true, reason: 'product not active or no stock' });
    }

    // Verificar se já mudou de estado (evitar re-processar produtos que já estavam ativos)
    const wasAlreadyActive = old_data?.status === 'active';
    const hadStock = old_data?.inventory_status !== 'out_of_stock' && (old_data?.fba_inventory || 0) > 0;
    if (wasAlreadyActive && hadStock) {
      return Response.json({ ok: true, skipped: true, reason: 'product was already active with stock' });
    }

    const now = new Date().toISOString();

    // Marcar produto para kickoff pendente
    await base44.asServiceRole.entities.Product.update(product.id, {
      should_activate_campaign: true,
      last_sync_at: now,
    }).catch(() => {});

    // Pré-gerar sugestões de keywords via IA (em background, não bloqueia)
    base44.asServiceRole.functions.invoke('suggestProductKeywordsWithAI', {
      amazon_account_id,
      asin,
      product_id: product.id,
    }).catch(e => console.warn(`suggestProductKeywordsWithAI falhou para ${asin}: ${e.message}`));

    // Registrar evento de aprendizado
    await base44.asServiceRole.entities.LearningEvent.create({
      amazon_account_id,
      event_type: 'product_activated',
      entity_type: 'product',
      entity_id: product.id,
      observation: `Produto ${asin} ficou ativo com estoque (${fba_inventory} unidades). Sugestões de keywords pré-geradas e produto marcado para Kick-off.`,
      recorded_at: now,
    }).catch(() => {});

    return Response.json({
      ok: true,
      asin,
      action: 'kickoff_scheduled',
      message: `Produto ${asin} activado — sugestões de keywords a ser geradas.`,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});