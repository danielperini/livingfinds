/**
 * mineSearchTermOpportunities — Mineração de oportunidades de novas campanhas manuais
 *
 * Pesquisa search terms de TODAS as campanhas (AUTO e MANUAL) e identifica
 * termos que justificam criar uma nova campanha manual dedicada:
 *
 * Critérios de oportunidade:
 * 1. Termo com >= 1 venda (orders_14d >= 1) fora da janela de atribuição (72h)
 * 2. Ainda não promovido a manual (promoted_to_manual = false)
 * 3. Produto com estoque ativo
 * 4. Não existe keyword exact idêntica em nenhuma campanha manual do mesmo ASIN
 * 5. Não existe KeywordSuggestion já criada para o mesmo ASIN+keyword (evita duplicata)
 *
 * Bid sugerido:
 * - Se CPC conhecido: 50% do CPC (regra smartBidFromCpc)
 * - Senão: R$0.30 padrão
 *
 * Resultado: cria KeywordSuggestion com status="suggested" para aprovação no painel
 * E dispara negateKeywordInAutoCampaign se decisão for aprovada automaticamente.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const CPC_BID_RATIO = 0.50;
const DEFAULT_BID = 0.30;
const MIN_BID = 0.10;
const MAX_BID = 5.00;
const ATTRIBUTION_SAFETY_HOURS = 72;

function safeCutoff() {
  return new Date(Date.now() - ATTRIBUTION_SAFETY_HOURS * 3600000).toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const cutoff = safeCutoff();

    let payload = {};
    try { payload = await req.clone().json(); } catch {}

    const accounts = payload.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: payload.amazon_account_id })
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });

    const summary = {
      accounts_processed: 0,
      search_terms_scanned: 0,
      opportunities_found: 0,
      skipped_duplicate: 0,
      skipped_no_stock: 0,
      skipped_already_promoted: 0,
    };

    for (const account of accounts) {
      try {
        const aid = account.id;
        const currencySymbol = account.currency_symbol || 'R$';

        // Carregar tudo em paralelo
        const [searchTerms, products, existingKeywords, existingDecisions, existingSuggestions] = await Promise.all([
          base44.asServiceRole.entities.SearchTerm.filter(
            { amazon_account_id: aid }, '-orders_14d', 2000
          ),
          base44.asServiceRole.entities.Product.filter(
            { amazon_account_id: aid }, null, 500
          ),
          base44.asServiceRole.entities.Keyword.filter(
            { amazon_account_id: aid }, null, 2000
          ),
          base44.asServiceRole.entities.OptimizationDecision.filter(
            { amazon_account_id: aid, decision_type: 'harvest_search_term' }, '-created_at', 1000
          ),
          base44.asServiceRole.entities.KeywordSuggestion.filter(
            { amazon_account_id: aid }, null, 1000
          ),
        ]);

        const productMap = new Map(products.map(p => [p.asin, p]));

        // Índice de keywords manuais exact já existentes: "asin|keyword"
        const manualExactIndex = new Set(
          existingKeywords
            .filter(k => k.match_type === 'exact' && k.state !== 'archived')
            .map(k => `${k.asin || ''}|${(k.keyword_text || k.keyword || '').toLowerCase().trim()}`)
        );

        // Índice de decisões já criadas: "asin|keyword"
        const decisionsIndex = new Set(
          existingDecisions.map(d => `${d.asin || ''}|${(d.keyword_text || '').toLowerCase().trim()}`)
        );

        // Índice de sugestões já criadas: "asin|keyword"
        const suggestionsIndex = new Set(
          existingSuggestions.map(s => `${s.asin || ''}|${(s.keyword || '').toLowerCase().trim()}`)
        );

        // Deduplicar search terms: manter o melhor por (term, asin)
        const stMap = new Map();
        for (const st of searchTerms) {
          const term = (st.search_term || st.keyword_text || '').toLowerCase().trim();
          if (!term || !st.advertised_asin) continue;
          // Ignorar dados dentro da janela de atribuição
          if (st.date && st.date >= cutoff) continue;

          const key = `${term}|${st.advertised_asin}`;
          const ex = stMap.get(key);
          if (!ex || (st.orders_14d || 0) > (ex.orders_14d || 0)) stMap.set(key, st);
        }

        summary.search_terms_scanned += stMap.size;

        const suggestions = [];

        for (const st of stMap.values()) {
          const term = (st.search_term || st.keyword_text || '').toLowerCase().trim();
          const asin = st.advertised_asin;
          const orders14 = st.orders_14d || 0;
          const cpc = st.cpc || 0;

          // Deve ter pelo menos 1 venda fora da janela de atribuição
          if (orders14 < 1) continue;

          // Já promovido
          if (st.promoted_to_manual) { summary.skipped_already_promoted++; continue; }

          // Produto com estoque
          const product = productMap.get(asin);
          if (!product || product.inventory_status === 'out_of_stock' || product.status === 'archived') {
            summary.skipped_no_stock++;
            continue;
          }

          // Verificar duplicatas
          const dupKey = `${asin}|${term}`;
          if (manualExactIndex.has(dupKey) || decisionsIndex.has(dupKey) || suggestionsIndex.has(dupKey)) {
            summary.skipped_duplicate++;
            continue;
          }

          // Bid sugerido: 50% do CPC ou padrão R$0.30
          const suggestedBid = cpc > 0
            ? parseFloat(Math.min(Math.max(cpc * CPC_BID_RATIO, MIN_BID), MAX_BID).toFixed(2))
            : DEFAULT_BID;

          // Relevância baseada em pedidos
          const relevanceScore = Math.min(100, 50 + orders14 * 10 + (st.sales_14d > 0 ? 20 : 0));

          suggestions.push({
            amazon_account_id: aid,
            asin,
            sku: product.sku || '',
            keyword: term,
            normalized_keyword: term,
            match_type: 'exact',
            intent: 'commercial',
            tail_type: term.split(' ').length >= 3 ? 'long' : 'medium',
            relevance_score: relevanceScore,
            confidence: Math.min(95, relevanceScore),
            reason: `Termo com ${orders14} venda(s) nos últimos 14 dias (dados fora janela de 72h de atribuição). CPC observado: ${currencySymbol}${cpc.toFixed(2)}. Bid sugerido: ${currencySymbol}${suggestedBid.toFixed(2)} (50% do CPC).`,
            source: 'AUTOMATIC_SEARCH_TERM',
            source_search_term_id: st.id,
            source_campaign_id: st.campaign_id,
            status: 'suggested',
            recommended_bid: suggestedBid,
            recommended_budget: 10,
            maximum_profitable_cpc: cpc > 0 ? parseFloat((cpc * 0.8).toFixed(2)) : null,
            bid_confidence: cpc > 0 ? 'high' : 'low',
            already_exists: false,
            created_at: now,
          });

          // Marcar no índice local para não duplicar no mesmo run
          suggestionsIndex.add(dupKey);
          summary.opportunities_found++;
        }

        // Gravar em lotes
        for (let i = 0; i < suggestions.length; i += 50) {
          await base44.asServiceRole.entities.KeywordSuggestion.bulkCreate(suggestions.slice(i, i + 50));
        }

        summary.accounts_processed++;
      } catch (accError) {
        console.error(`Conta ${account.id}:`, accError.message);
      }
    }

    return Response.json({
      ok: true,
      rule: 'mine_search_term_opportunities',
      attribution_safety_hours: ATTRIBUTION_SAFETY_HOURS,
      cpc_bid_ratio: CPC_BID_RATIO,
      summary,
      executed_at: now,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});