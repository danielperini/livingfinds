/**
 * harvestConvertedSearchTerms — Colheita diária de termos convertidos.
 *
 * Regras:
 *  - orders na janela segura >= 1 (fora das últimas 72h de atribuição)
 *  - sales > 0
 *  - relevance_status != irrelevant
 *  - promoted_to_manual != true
 *  - não existe keyword exact equivalente já criada
 *  - produto com oferta ativa e estoque
 *
 * Uma venda confirmada já é suficiente (não exige 7 dias, 20 cliques ou 2 vendas).
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function getSafeCutoffDate(attributionSafetyHours = 72) {
  const cutoffMs = Date.now() - attributionSafetyHours * 3600000;
  return new Date(cutoffMs).toISOString().slice(0, 10);
}

function makeIdempotencyKey(...parts) {
  return parts.join('|');
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  const base44 = createClientFromRequest(req);
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  try {
    const body = await req.json().catch(() => ({}));
    let account = null;
    const amazonAccountId = body.amazon_account_id;

    if (amazonAccountId) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazonAccountId });
      account = accs[0] || null;
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, message: 'Nenhuma conta conectada' });

    const aid = account.id;
    const currencySymbol = account.currency_symbol || 'R$';
    const currencyCode = account.currency_code || 'BRL';

    // Configuração
    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid });
    const cfg = configs[0] || {};
    const attributionSafetyHours = cfg.attribution_safety_hours || 72;
    const autonomyLevel = cfg.autonomy_level ?? 2;
    const safeCutoff = getSafeCutoffDate(attributionSafetyHours);

    // Carregar dados necessários
    const [searchTerms, products, existingKeywords, existingDecisions] = await Promise.all([
      base44.asServiceRole.entities.SearchTerm.filter(
        { amazon_account_id: aid }, '-orders_14d', 2000
      ),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 500),
      base44.asServiceRole.entities.Keyword.filter(
        { amazon_account_id: aid, source: 'manual' }, null, 2000
      ),
      base44.asServiceRole.entities.OptimizationDecision.filter(
        { amazon_account_id: aid, decision_type: 'harvest_search_term', status: 'pending' }, '-created_at', 500
      ),
    ]);

    const productMap = new Map(products.map(p => [p.asin, p]));
    const existingKeys = new Set(existingDecisions.map(d => d.idempotency_key).filter(Boolean));

    // Índice de keywords manuais exact já existentes por campanha
    // chave: campaign_id|keyword_text_normalizado
    const manualExactIndex = new Set(
      existingKeywords
        .filter(k => k.match_type === 'exact' && (k.state !== 'archived'))
        .map(k => `${k.campaign_id}|${(k.keyword_text || k.keyword || '').toLowerCase().trim()}`)
    );

    // Deduplicar search terms: manter o registro mais rico por (term, asin)
    const stMap = new Map();
    for (const st of searchTerms) {
      const term = (st.search_term || st.keyword_text || '').toLowerCase().trim();
      if (!term || !st.advertised_asin) continue;

      // Somente considerar dados fora da janela de atribuição
      // Se o único registro é recente (>= safeCutoff), pular
      if (st.date && st.date >= safeCutoff) continue;

      const key = `${term}|${st.advertised_asin}`;
      const ex = stMap.get(key);
      if (!ex || (st.orders_14d || 0) > (ex.orders_14d || 0)) stMap.set(key, st);
    }

    const decisions = [];
    const stats = { harvested: 0, skipped_no_stock: 0, skipped_already_promoted: 0, skipped_duplicate: 0, skipped_irrelevant: 0, blocked_attribution: 0 };

    for (const st of stMap.values()) {
      const term = (st.search_term || st.keyword_text || '').toLowerCase().trim();
      const orders14 = st.orders_14d || 0;
      const sales14 = st.sales_14d || 0;
      const cpc = st.cpc || 0;

      // Condição de colheita: 1 venda confirmada fora da janela de atribuição
      if (orders14 < 1 || sales14 <= 0) continue;

      // Já promovido
      if (st.promoted_to_manual) { stats.skipped_already_promoted++; continue; }

      // Irrelevante explícito
      if (st.relevance_status === 'irrelevant') { stats.skipped_irrelevant++; continue; }

      // Verificar produto
      const product = productMap.get(st.advertised_asin);
      if (!product) { stats.skipped_no_stock++; continue; }
      if (product.inventory_status === 'out_of_stock') { stats.skipped_no_stock++; continue; }
      if (product.status === 'inactive' || product.status === 'archived') { stats.skipped_no_stock++; continue; }

      // Verificar se keyword exact já existe nesta campanha
      const existsInCampaign = manualExactIndex.has(`${st.campaign_id}|${term}`);
      if (existsInCampaign) { stats.skipped_duplicate++; continue; }

      // Chave de idempotência: garante que não cria 2x no mesmo dia
      const iKey = makeIdempotencyKey(aid, 'harvest_search_term', st.id, 'create_keyword', today);
      if (existingKeys.has(iKey)) { stats.skipped_duplicate++; continue; }

      // Bid sugerido: CPC do search term + 10%, mínimo R$0.30, máximo configurado
      const minBid = cfg.min_bid || 0.10;
      const maxBid = cfg.max_bid || 5.0;
      const suggestedBid = cpc > 0
        ? Math.min(Math.max(cpc * 1.10, minBid, 0.30), maxBid)
        : Math.max(minBid, 0.30);

      // Confiança da decisão
      const confidence = Math.min(0.95, 0.65 + (orders14 * 0.10) + (sales14 > 20 ? 0.05 : 0));

      // Status inicial: aprovada automaticamente no nível 2+
      const status = (autonomyLevel >= 2 && cfg.auto_apply_low_risk !== false) ? 'approved' : 'pending';

      // Avaliações programadas
      const review3d = new Date(Date.now() + 3 * 86400000).toISOString();
      const review7d = new Date(Date.now() + 7 * 86400000).toISOString();

      decisions.push({
        amazon_account_id: aid,
        decision_type: 'harvest_search_term',
        entity_type: 'search_term',
        entity_id: st.id,
        campaign_id: st.campaign_id,
        ad_group_id: st.ad_group_id,
        asin: st.advertised_asin,
        keyword_text: term,
        action: 'create_keyword',
        value_before: null,
        value_after: Number(suggestedBid.toFixed(2)),
        rationale: `HARVEST: Termo "${term}" gerou ${orders14} pedido(s) com ${currencySymbol}${sales14.toFixed(2)} em vendas (dados anteriores à janela de ${attributionSafetyHours}h de atribuição). Criar keyword exact manual com bid ${currencySymbol}${suggestedBid.toFixed(2)}.`,
        data_used: JSON.stringify({
          orders_14d: orders14,
          sales_14d: sales14,
          cpc_source: cpc,
          bid_suggested: suggestedBid,
          safe_cutoff: safeCutoff,
          asin: st.advertised_asin,
        }),
        risk: 'low',
        requires_approval: autonomyLevel < 2,
        status,
        confidence: Math.round(confidence * 100),
        objective: 'growth',
        reversible: true,
        country_code: account.country_code || 'BR',
        currency_code: currencyCode,
        currency_symbol: currencySymbol,
        idempotency_key: iKey,
        source_search_term_id: st.id,
        source_campaign_id: st.campaign_id,
        source_function: 'harvestConvertedSearchTerms',
        // Avaliações: 3d para delivery, 7d para performance
        evaluation_due_at: review3d,
        period_analyzed: `${st.date || 'unknown'} → ${safeCutoff} (fora de atribuição)`,
        expected_impact: `Criar keyword exact "${term}" com bid ${currencySymbol}${suggestedBid.toFixed(2)} para capturar tráfego de alta conversão.`,
        created_at: now,
      });

      // Atualizar SearchTerm como FIRST_SALE / pendente de promoção
      await base44.asServiceRole.entities.SearchTerm.update(st.id, {
        classification: 'FIRST_SALE',
        first_sale_at: st.first_sale_at || now,
        last_evaluated_at: now,
        evaluation_count: (st.evaluation_count || 0) + 1,
      });

      stats.harvested++;
    }

    // Gravar decisões em lotes
    let created = 0;
    for (let i = 0; i < decisions.length; i += 50) {
      const batch = decisions.slice(i, i + 50);
      await base44.asServiceRole.entities.OptimizationDecision.bulkCreate(batch);
      created += batch.length;
    }

    // ── Negativar nas campanhas AUTO: para cada decisão de harvest, disparar negativação ──
    for (const d of decisions) {
      if (d.keyword_text && d.asin) {
        await base44.asServiceRole.functions.invoke('negateKeywordInAutoCampaign', {
          amazon_account_id: account.id,
          asin: d.asin,
          keyword_text: d.keyword_text,
          manual_campaign_id: d.campaign_id,
          triggered_by: 'harvest_search_terms',
        }).catch(e => console.warn('negateKeywordInAutoCampaign skip:', e.message));
      }
    }

    return Response.json({
      ok: true,
      harvested: created,
      stats,
      safe_cutoff: safeCutoff,
      attribution_safety_hours: attributionSafetyHours,
      duration_ms: Date.now() - startTime,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});