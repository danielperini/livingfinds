/**
 * analyzeSearchTermsWithRules — Analisa termos de pesquisa com regras avançadas
 * 
 * Regras implementadas:
 * 1. Falha de Conversão (Listing Problem)
 *    - 50+ cliques, 0 vendas → problema de conversão (não de keyword)
 *    - Ação: auditoria de listing, não negativação
 * 
 * 2. Candidato a Campanha Manual
 *    - 3+ pedidos, ACoS <= 35% → criar campanha manual EXACT
 *    - Bid inicial = CPC médio × 1,10
 * 
 * 3. Migração para Manual
 *    - 1-2 pedidos, ACoS <= 30% → migrar para manual EXACT
 * 
 * 4. Winner (Campanha Manual Existente)
 *    - 5+ pedidos, ROAS >= 4 → aumentar bid 10-15%
 * 
 * 5. Negativação
 *    - 15+ cliques, 0 pedidos, spend > $5 → negativar
 * 
 * 6. Ineficiente
 *    - 10+ cliques, 0 pedidos → observar, reduzir bid se ACoS alto
 * 
 * 7. Evidência Inicial
 *    - 1-2 pedidos, dados limitados → manter, coletar mais dados
 * 
 * 8. Insuficiente Dados
 *    - <10 cliques → manter em observação
 * 
 * 9. Observar
 *    - Dados mistos, sem ação clara → manter monitoramento
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function analyzeTerm(term, accountMetrics) {
  const { targetAcos = 30, targetRoas = 3.33, avgConversionRate = 0.10 } = accountMetrics;
  
  const clicks = term.clicks || 0;
  const orders = term.orders || term.orders_14d || term.orders_30d || 0;
  const spend = term.spend || 0;
  const sales = term.sales || term.sales_14d || term.sales_30d || 0;
  const acos = term.acos || term.acos_14d || term.acos_7d || 0;
  const roas = term.roas || term.roas_14d || term.roas_7d || 0;
  const cpc = term.cpc || (clicks > 0 ? spend / clicks : 0);
  const cvr = clicks > 0 ? orders / clicks : 0;
  
  const recommendations = [];
  let primaryClassification = 'insufficient_data';
  let confidence = 0;
  let clickLimit = 0;

  // Regra 1: Falha de Conversão (50+ cliques, 0 vendas)
  if (clicks >= 50 && orders === 0) {
    primaryClassification = 'conversion_failure';
    confidence = 0.95;
    clickLimit = 50;
    recommendations.push({
      type: 'audit_listing',
      priority: 'high',
      rationale: `50+ cliques sem vendas indica problema de conversão (preço, reviews, estoque, imagens).`,
      actions: ['Verificar preço vs concorrência', 'Auditar reviews e rating', 'Checar estoque e Buy Box', 'Otimizar imagens e A+ Content'],
    });
  }
  // Regra 2: Candidato a Campanha Manual (3+ pedidos, ACoS <= 35%)
  else if (orders >= 3 && acos > 0 && acos <= 35) {
    primaryClassification = 'manual_candidate';
    confidence = 0.90;
    const suggestedBid = Math.min(cpc * 1.10, 5.0);
    recommendations.push({
      type: 'create_manual_exact',
      priority: 'high',
      suggestedBid,
      rationale: `Termo com ${orders} pedidos e ACoS ${(acos).toFixed(1)}%. Criar campanha MANUAL-EXACT.`,
      formula: `Bid = CPC médio ($${cpc.toFixed(2)}) × 1,10 = $${suggestedBid.toFixed(2)}`,
    });
  }
  // Regra 3: Migração para Manual (1-2 pedidos, ACoS <= 30%)
  else if (orders >= 1 && orders <= 2 && acos > 0 && acos <= 30) {
    primaryClassification = 'migrate_to_manual';
    confidence = 0.75;
    const suggestedBid = Math.min(cpc * 1.10, 4.0);
    recommendations.push({
      type: 'migrate_to_manual_exact',
      priority: 'medium',
      suggestedBid,
      rationale: `Termo com ${orders} pedido(s) e ACoS ${(acos).toFixed(1)}%. Migrar para MANUAL-EXACT.`,
    });
  }
  // Regra 4: Winner (5+ pedidos, ROAS >= 4)
  else if (orders >= 5 && roas >= 4) {
    primaryClassification = 'winner';
    confidence = 0.95;
    const bidIncrease = cpc * 0.15;
    recommendations.push({
      type: 'increase_bid_winner',
      priority: 'high',
      suggestedBid: cpc + bidIncrease,
      rationale: `Winner comprovado: ${orders} pedidos, ROAS ${roas.toFixed(2)}x. Aumentar bid 15%.`,
    });
  }
  // Regra 5: Negativação (15+ cliques, 0 pedidos, spend > $5)
  else if (clicks >= 15 && orders === 0 && spend > 5) {
    primaryClassification = 'negate';
    confidence = 0.85;
    clickLimit = 15;
    recommendations.push({
      type: 'negative_exact',
      priority: 'medium',
      rationale: `15+ cliques, $${spend.toFixed(2)} gastos, 0 pedidos. Negativar em EXACT.`,
    });
  }
  // Regra 6: Ineficiente (10+ cliques, 0 pedidos)
  else if (clicks >= 10 && orders === 0) {
    primaryClassification = 'inefficient';
    confidence = 0.70;
    clickLimit = 10;
    recommendations.push({
      type: 'reduce_bid_or_observe',
      priority: 'low',
      rationale: `10+ cliques sem conversão. Reduzir bid 20% ou observar.`,
      suggestedBid: cpc * 0.80,
    });
  }
  // Regra 7: Evidência Inicial (1-2 pedidos, dados limitados)
  else if (orders >= 1 && orders <= 2 && clicks < 50) {
    primaryClassification = 'initial_evidence';
    confidence = 0.60;
    recommendations.push({
      type: 'maintain_collect_data',
      priority: 'low',
      rationale: `Evidência inicial de conversão. Manter e coletar mais dados.`,
    });
  }
  // Regra 8: Insuficiente Dados (<10 cliques)
  else if (clicks < 10) {
    primaryClassification = 'insufficient_data';
    confidence = 0.40;
    recommendations.push({
      type: 'maintain_observe',
      priority: 'low',
      rationale: `Dados insuficientes (<10 cliques). Manter em observação.`,
    });
  }
  // Regra 9: Observar (dados mistos)
  else {
    primaryClassification = 'observar';
    confidence = 0.50;
    recommendations.push({
      type: 'maintain_monitor',
      priority: 'low',
      rationale: `Desempenho misto. Manter monitoramento.`,
    });
  }

  return {
    ...term,
    primaryClassification,
    confidence,
    clickLimit,
    recommendations,
    metrics: { clicks, orders, spend, sales, acos, roas, cpc, cvr },
  };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    let amazonAccountId = body.amazon_account_id;
    
    if (!amazonAccountId) {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-last_sync_at', 1);
      if (accounts.length === 0) return Response.json({ error: 'Nenhuma conta Amazon encontrada' }, { status: 404 });
      amazonAccountId = accounts[0].id;
    }

    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazonAccountId);
    if (!account) return Response.json({ error: 'Conta não encontrada' }, { status: 404 });

    // Buscar metas da conta
    const rules = await base44.asServiceRole.entities.BudgetRule.filter({ amazon_account_id: amazonAccountId });
    const targetAcos = rules[0]?.target_acos || 30;
    const targetRoas = rules[0]?.target_roas || 3.33;

    // Buscar search terms
    const searchTerms = await base44.asServiceRole.entities.SearchTerm.filter({
      amazon_account_id: amazonAccountId,
    }, '-date', 5000);

    console.log(`[analyzeSearchTermsWithRules] ${searchTerms.length} termos encontrados`);

    // Buscar produtos para preço médio
    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: amazonAccountId }, '-created_date', 100);
    const avgProductPrice = products.length > 0 
      ? products.reduce((sum, p) => sum + (p.price || p.average_price || 100), 0) / products.length 
      : 100;

    // Calcular conversão média da conta
    const totalClicks = searchTerms.reduce((sum, t) => sum + (t.clicks || 0), 0);
    const totalOrders = searchTerms.reduce((sum, t) => sum + (t.orders_14d || t.orders_30d || t.orders || 0), 0);
    const avgConversionRate = totalClicks > 0 ? totalOrders / totalClicks : 0.10;
    
    const accountMetrics = {
      targetAcos,
      targetRoas,
      avgConversionRate,
      avgProductPrice,
    };

    // Analisar cada termo
    const analyzedTerms = searchTerms.map(term => {
      const orders = term.orders_14d || term.orders_30d || term.orders || 0;
      const sales = term.sales_14d || term.sales_30d || term.sales || 0;
      return analyzeTerm({
        ...term,
        orders,
        sales,
        acos: term.acos_14d || term.acos_7d || term.acos || 0,
        roas: term.roas_14d || term.roas_7d || term.roas || 0,
        campaign_type: term.match_type === 'auto' ? 'AUTO' : 'MANUAL',
      }, accountMetrics);
    });

    // Agrupar por classificação
    const grouped = {
      conversion_failure: analyzedTerms.filter(t => t.primaryClassification === 'conversion_failure'),
      manual_candidate: analyzedTerms.filter(t => t.primaryClassification === 'manual_candidate'),
      migrate_to_manual: analyzedTerms.filter(t => t.primaryClassification === 'migrate_to_manual'),
      winner: analyzedTerms.filter(t => t.primaryClassification === 'winner'),
      negate: analyzedTerms.filter(t => t.primaryClassification === 'negate'),
      inefficient: analyzedTerms.filter(t => t.primaryClassification === 'inefficient'),
      initial_evidence: analyzedTerms.filter(t => t.primaryClassification === 'initial_evidence'),
      insufficient_data: analyzedTerms.filter(t => t.primaryClassification === 'insufficient_data'),
      observar: analyzedTerms.filter(t => t.primaryClassification === 'observar'),
    };

    // Criar recomendações de ações
    const actions = [];
    
    // Campanhas manuais para termos de alto desempenho
    const topTerms = analyzedTerms
      .filter(t => t.primaryClassification === 'manual_candidate' || t.primaryClassification === 'migrate_to_manual')
      .sort((a, b) => (b.orders || 0) - (a.orders || 0))
      .slice(0, 10);

    if (topTerms.length > 0) {
      actions.push({
        type: 'create_manual_campaigns',
        priority: 'high',
        terms: topTerms.map(t => ({
          search_term: t.search_term || t.keyword_text,
          clicks: t.clicks,
          orders: t.orders,
          sales: t.sales,
          spend: t.spend,
          acos: t.acos,
          roas: t.roas,
          suggested_bid: t.recommendations.find(r => r.type === 'create_manual_exact' || r.type === 'migrate_to_manual_exact')?.suggestedBid || t.cpc,
        })),
        rationale: `${topTerms.length} termos com desempenho comprovado para campanhas manuais EXACT.`,
      });
    }

    // Termos para negativação
    const negateTerms = analyzedTerms.filter(t => t.primaryClassification === 'negate');
    if (negateTerms.length > 0) {
      actions.push({
        type: 'negative_keywords',
        priority: 'medium',
        count: negateTerms.length,
        terms: negateTerms.slice(0, 20).map(t => ({
          search_term: t.search_term || t.keyword_text,
          clicks: t.clicks,
          spend: t.spend,
          click_limit: t.clickLimit,
        })),
        rationale: `${negateTerms.length} termos atingiram limite de cliques sem conversão.`,
      });
    }

    // Falhas de conversão para auditoria
    const failures = analyzedTerms.filter(t => t.primaryClassification === 'conversion_failure');
    if (failures.length > 0) {
      actions.push({
        type: 'audit_conversion_failures',
        priority: 'high',
        count: failures.length,
        terms: failures.slice(0, 10).map(t => ({
          search_term: t.search_term || t.keyword_text,
          clicks: t.clicks,
          spend: t.spend,
          campaign_name: t.campaign_name,
        })),
        rationale: `${failures.length} termos com 50+ cliques e 0 vendas. Auditoria de listing necessária.`,
      });
    }

    console.log(`[analyzeSearchTermsWithRules] ${analyzedTerms.length} termos analisados`);
    console.log(`  - Falhas conversão: ${failures.length}`);
    console.log(`  - Candidatos manual: ${grouped.manual_candidate.length + grouped.migrate_to_manual.length}`);
    console.log(`  - Winners: ${grouped.winner.length}`);
    console.log(`  - Negativar: ${negateTerms.length}`);

    return Response.json({
      ok: true,
      amazon_account_id: amazonAccountId,
      analyzed_count: analyzedTerms.length,
      grouped,
      actions,
      account_metrics: accountMetrics,
      message: `${analyzedTerms.length} termos analisados com regras avançadas`,
    });
  } catch (error) {
    console.error('[analyzeSearchTermsWithRules] Erro:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});