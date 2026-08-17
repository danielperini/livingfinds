/**
 * applyOptimizationRules — Camada 2: Motor de regras de otimização
 * Aplica regras de negócio sobre métricas calculadas (Camada 1).
 * Não usa IA. Gera decisões estruturadas para aprovação ou execução.
 * 
 * Regras implementadas:
 * 1. Redução de bid: ACoS alto + ROAS baixo + cliques mínimos
 * 2. Aumento de bid: ROAS bom + estoque + budget disponível
 * 3. Negativação: cliques >= limite + 0 vendas + gasto mínimo
 * 4. Pausa de campanha: sem estoque ou ACoS crítico
 * 5. Budget: ajuste por pacing e exaustão
 * 6. Harvest: search terms vencedores → campanha manual
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function determineRiskLevel(confidence, impact) {
  // Risk = (1 - confidence) × impact
  const impactWeight = { high: 3, medium: 2, low: 1 }[impact] || 2;
  const confidenceFactor = 1 - (confidence || 0.5);
  const score = confidenceFactor * impactWeight;
  
  if (score > 1.5) return 'high';
  if (score > 0.8) return 'medium';
  return 'low';
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, metrics_data, auto_apply_low_risk } = body;

    if (!amazon_account_id) {
      return Response.json({ error: 'amazon_account_id required' }, { status: 400 });
    }

    // Se não recebeu métricas calculadas, buscar da Camada 1
    let metrics = metrics_data;
    if (!metrics) {
      const metricsRes = await fetch('http://localhost:8000/functions/calculateMetrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amazon_account_id }),
      });
      const metricsData = await metricsRes.json();
      if (!metricsData.ok) throw new Error(metricsData.error);
      metrics = metricsData;
    }

    // Buscar configurações
    const budgetRules = await base44.asServiceRole.entities.BudgetRule.filter({ amazon_account_id });
    const rule = budgetRules[0] || {
      target_acos: 25,
      target_roas: 4,
      min_bid: 0.10,
      max_bid: 5.0,
      bid_increase_step: 0.10,
      bid_decrease_step: 0.25,
      click_limit_no_sales: 15,
      spend_limit_no_sales: 5,
    };

    const decisions = [];
    const errors = [];
    const today = new Date().toISOString().slice(0, 10);

    // === REGRA 1: Keywords com ACoS alto → Reduzir bid ===
    for (const kw of (metrics.keywords || [])) {
      if ((kw.state || kw.status) === 'archived') continue;

      const { acos, roas, cpc, spend, sales, clicks } = kw.metrics || {};
      const signals = kw.signals || {};
      const currentBid = kw.current_bid || kw.bid || 0.25;

      // Condição: ACoS acima da meta + ROAS abaixo + mínimo de cliques
      if (signals.has_high_acos && clicks >= 5) {
        const reduction = Math.max(rule.bid_decrease_step, currentBid * 0.15);
        const newBid = Math.max(currentBid - reduction, rule.min_bid);
        
        decisions.push({
          amazon_account_id,
          date: today,
          decision_type: 'bid_change',
          entity_type: 'keyword',
          entity_id: kw.keyword_id,
          campaign_id: kw.campaign_id,
          keyword_id: kw.keyword_id,
          keyword_text: kw.keyword || kw.keyword_text,
          asin: kw.asin,
          action: 'update_bid',
          value_before: currentBid,
          value_after: newBid,
          change_pct: safeDiv(newBid - currentBid, currentBid, 1),
          objective: 'profitability',
          rationale: `ACoS ${(acos || 0).toFixed(1)}% acima da meta ${rule.target_acos}%`,
          data_used: `Cliques: ${clicks}, Spend: $${(spend || 0).toFixed(2)}, Vendas: $${(sales || 0).toFixed(2)}`,
          sample_size: `${clicks} cliques`,
          confidence: 0.75,
          risk: determineRiskLevel(0.75, 'medium'),
          expected_impact: `Redução de ACoS em ~${(reduction / currentBid * 100).toFixed(0)}%`,
          reversible: true,
          requires_approval: true,
          status: 'pending',
          rule_applied: 'high_acos_reduce_bid',
        });
      }

      // Condição: Gasto sem venda
      if (signals.has_no_sales && spend >= rule.spend_limit_no_sales) {
        const newBid = Math.max(currentBid - rule.bid_decrease_step, rule.min_bid);
        
        decisions.push({
          amazon_account_id,
          date: today,
          decision_type: 'bid_change',
          entity_type: 'keyword',
          entity_id: kw.keyword_id,
          keyword_id: kw.keyword_id,
          keyword_text: kw.keyword || kw.keyword_text,
          asin: kw.asin,
          action: 'update_bid',
          value_before: currentBid,
          value_after: newBid,
          change_pct: safeDiv(newBid - currentBid, currentBid, 1),
          objective: 'profitability',
          rationale: `${clicks} cliques, $${(spend || 0).toFixed(2)} gastos sem vendas`,
          data_used: `Cliques: ${clicks}, Spend: $${(spend || 0).toFixed(2)}`,
          sample_size: `${clicks} cliques`,
          confidence: 0.80,
          risk: determineRiskLevel(0.80, 'low'),
          expected_impact: 'Redução de gasto desperdiçado',
          reversible: true,
          requires_approval: auto_apply_low_risk,
          status: auto_apply_low_risk ? 'scheduled' : 'pending',
          rule_applied: 'no_sales_reduce_bid',
        });
      }

      // Condição: Negativação (cliques >= limite + 0 vendas)
      if (clicks >= rule.click_limit_no_sales && sales === 0 && spend >= rule.spend_limit_no_sales) {
        decisions.push({
          amazon_account_id,
          date: today,
          decision_type: 'negative_keyword',
          entity_type: 'keyword',
          entity_id: kw.keyword_id,
          keyword_id: kw.keyword_id,
          keyword_text: kw.keyword || kw.keyword_text,
          asin: kw.asin,
          action: 'negative_keyword',
          value_before: currentBid,
          value_after: 0,
          change_pct: -100,
          objective: 'profitability',
          rationale: `${clicks} cliques, $${(spend || 0).toFixed(2)} sem vendas — atingir limite`,
          data_used: `Cliques: ${clicks}, Spend: $${(spend || 0).toFixed(2)}, Vendas: 0`,
          sample_size: `${clicks} cliques`,
          confidence: 0.85,
          risk: 'high',
          expected_impact: 'Eliminação de gasto desperdiçado',
          reversible: true,
          requires_approval: true,
          status: 'pending',
          rule_applied: 'waste_kw_negate',
        });
      }
    }

    // === REGRA 2: Keywords com bom desempenho → Aumentar bid ===
    for (const kw of (metrics.keywords || [])) {
      if ((kw.state || kw.status) === 'archived') continue;

      const { roas, acos, sales, clicks, profit } = kw.metrics || {};
      const signals = kw.signals || {};
      const currentBid = kw.current_bid || kw.bid || 0.25;

      // Condição: ROAS bom + vendas + profitável + estoque
      const product = (metrics.products || []).find(p => p.asin === kw.asin);
      const hasStock = product && (product.fba_inventory || 0) > 0;

      if (signals.is_profitable && roas >= rule.target_roas && sales > 0 && clicks >= 10 && hasStock) {
        const increase = Math.min(currentBid * 0.10, rule.bid_increase_step);
        const newBid = Math.min(currentBid + increase, rule.max_bid);

        decisions.push({
          amazon_account_id,
          date: today,
          decision_type: 'bid_change',
          entity_type: 'keyword',
          entity_id: kw.keyword_id,
          keyword_id: kw.keyword_id,
          keyword_text: kw.keyword || kw.keyword_text,
          asin: kw.asin,
          action: 'update_bid',
          value_before: currentBid,
          value_after: newBid,
          change_pct: safeDiv(newBid - currentBid, currentBid, 1),
          objective: 'growth',
          rationale: `Keyword rentável: ROAS ${(roas || 0).toFixed(2)}x, ${sales} vendas`,
          data_used: `Vendas: $${(sales || 0).toFixed(2)}, ROAS: ${(roas || 0).toFixed(2)}x, Profit: $${(profit || 0).toFixed(2)}`,
          sample_size: `${clicks} cliques`,
          confidence: 0.70,
          risk: determineRiskLevel(0.70, 'medium'),
          expected_impact: `Aumento de escala mantendo rentabilidade`,
          reversible: true,
          requires_approval: true,
          status: 'pending',
          rule_applied: 'performant_increase_bid',
        });
      }
    }

    // === REGRA 3: Campanhas sem estoque → Pausar ===
    for (const campaign of (metrics.campaigns || [])) {
      if (campaign.state === 'archived') continue;

      const product = (metrics.products || []).find(p => p.asin === campaign.asin);
      if (product && product.signals?.is_out_of_stock) {
        decisions.push({
          amazon_account_id,
          date: today,
          decision_type: 'pause',
          entity_type: 'campaign',
          entity_id: campaign.campaign_id,
          campaign_id: campaign.campaign_id,
          asin: campaign.asin,
          action: 'pause_campaign',
          value_before: campaign.daily_budget || 0,
          value_after: 0,
          change_pct: -100,
          objective: 'defense',
          rationale: `Produto ${campaign.asin} sem estoque (FBA: ${product.fba_inventory || 0})`,
          data_used: `Inventory: ${product.fba_inventory || 0}`,
          sample_size: 'N/A',
          confidence: 0.95,
          risk: 'high',
          expected_impact: 'Prevenção de gasto sem conversão',
          reversible: true,
          requires_approval: true,
          status: 'pending',
          rule_applied: 'no_stock_required',
        });
      }

      // === REGRA 4: Campanhas com ACoS crítico → Reduzir budget ===
      const { acos, spend, daily_budget } = campaign.metrics || {};
      if ((acos || 0) > rule.target_acos * 2 && (spend || 0) > 10) {
        const newBudget = Math.max((daily_budget || 10) * 0.7, 5);
        
        decisions.push({
          amazon_account_id,
          date: today,
          decision_type: 'budget_change',
          entity_type: 'campaign',
          entity_id: campaign.campaign_id,
          campaign_id: campaign.campaign_id,
          asin: campaign.asin,
          action: 'update_budget',
          value_before: daily_budget || 0,
          value_after: newBudget,
          change_pct: safeDiv(newBudget - (daily_budget || 0), daily_budget || 1, 1),
          objective: 'profitability',
          rationale: `ACoS ${(acos || 0).toFixed(1)}% muito acima da meta ${rule.target_acos}%`,
          data_used: `Spend: $${(spend || 0).toFixed(2)}, ACoS: ${(acos || 0).toFixed(1)}%`,
          sample_size: '30 dias',
          confidence: 0.75,
          risk: 'medium',
          expected_impact: `Redução de ACoS em ~30%`,
          reversible: true,
          requires_approval: true,
          status: 'pending',
          rule_applied: 'high_acos_reduce_budget',
        });
      }
    }

    // === REGRA 5: Search terms → Harvest para campanha manual ===
    const manualCandidates = (metrics.search_terms || []).filter(
      t => t.signals?.is_candidate_for_manual
    );

    if (manualCandidates.length > 0) {
      // Agrupar por ASIN
      const byAsin = {};
      for (const term of manualCandidates) {
        if (!byAsin[term.asin]) byAsin[term.asin] = [];
        byAsin[term.asin].push(term);
      }

      // Criar decisão de campanha manual por ASIN
      for (const [asin, terms] of Object.entries(byAsin)) {
        const topTerms = terms.sort((a, b) => (b.orders || 0) - (a.orders || 0)).slice(0, 10);
        const totalOrders = topTerms.reduce((sum, t) => sum + (t.orders || 0), 0);
        const totalSales = topTerms.reduce((sum, t) => sum + (t.sales || 0), 0);
        const avgAcos = topTerms.reduce((sum, t) => sum + (t.acos || 0), 0) / topTerms.length;
        const avgCpc = topTerms.reduce((sum, t) => sum + (t.cpc || 0), 0) / topTerms.length;
        const suggestedBid = Math.min(avgCpc * 1.10, rule.max_bid);

        decisions.push({
          amazon_account_id,
          date: today,
          decision_type: 'create_campaign',
          entity_type: 'campaign',
          asin,
          action: 'create_manual_campaign_exact',
          value_before: 0,
          value_after: suggestedBid,
          objective: 'growth',
          rationale: `${topTerms.length} termos com ${totalOrders} pedidos e ACoS médio ${(avgAcos || 0).toFixed(1)}%`,
          data_used: `Termos: ${topTerms.map(t => t.search_term).join(', ')}`,
          sample_size: `${totalOrders} pedidos, $${(totalSales || 0).toFixed(2)} vendas`,
          confidence: 0.85,
          risk: 'medium',
          expected_impact: 'Escala de termos vencedores em campanha dedicada',
          reversible: true,
          requires_approval: true,
          status: 'pending',
          rule_applied: 'harvest_manual_campaign',
          keywords_to_create: topTerms.map(t => ({
            keyword_text: t.search_term,
            suggested_bid: suggestedBid,
            match_type: 'exact',
          })),
        });
      }
    }

    // === REGRA 6: Search terms → Negativação ===
    const toNegate = (metrics.search_terms || []).filter(t => t.signals?.should_negate);
    if (toNegate.length > 0) {
      decisions.push({
        amazon_account_id,
        date: today,
        decision_type: 'negative_keyword',
        entity_type: 'search_term',
        action: 'negative_search_terms',
        objective: 'profitability',
        rationale: `${toNegate.length} termos para negativação`,
        data_used: toNegate.map(t => ({
          search_term: t.search_term,
          clicks: t.clicks,
          spend: t.spend,
        })),
        sample_size: `${toNegate.reduce((sum, t) => sum + t.clicks, 0)} cliques`,
        confidence: 0.85,
        risk: 'medium',
        expected_impact: 'Eliminação de gasto desperdiçado',
        reversible: true,
        requires_approval: true,
        status: 'pending',
        rule_applied: 'negate_search_terms',
        terms_to_negate: toNegate.map(t => ({
          search_term: t.search_term,
          campaign_id: t.campaign_id,
          reason: `${t.clicks} cliques, $${(t.spend || 0).toFixed(2)} sem vendas`,
        })),
      });
    }

    // Deduplicar decisões (priorizar ações mais agressivas)
    const deduped = Object.values(decisions.reduce((acc, d) => {
      const key = `${d.action}_${d.entity_type}_${d.entity_id || d.asin}`;
      const currentRisk = { high: 3, medium: 2, low: 1 }[d.risk] || 1;
      const existingRisk = acc[key] ? { high: 3, medium: 2, low: 1 }[acc[key].risk] || 1 : 0;
      
      if (!acc[key] || currentRisk >= existingRisk) {
        acc[key] = d;
      }
      return acc;
    }, {}));

    // Contagem por tipo
    const breakdown = {};
    for (const d of deduped) {
      breakdown[d.action] = (breakdown[d.action] || 0) + 1;
    }

    return Response.json({
      ok: true,
      amazon_account_id,
      decisions_generated: deduped.length,
      breakdown,
      decisions: deduped,
      rules_applied: {
        high_acos_reduce_bid: deduped.filter(d => d.rule_applied === 'high_acos_reduce_bid').length,
        no_sales_reduce_bid: deduped.filter(d => d.rule_applied === 'no_sales_reduce_bid').length,
        waste_kw_negate: deduped.filter(d => d.rule_applied === 'waste_kw_negate').length,
        performant_increase_bid: deduped.filter(d => d.rule_applied === 'performant_increase_bid').length,
        no_stock_required: deduped.filter(d => d.rule_applied === 'no_stock_required').length,
        high_acos_reduce_budget: deduped.filter(d => d.rule_applied === 'high_acos_reduce_budget').length,
        harvest_manual_campaign: deduped.filter(d => d.rule_applied === 'harvest_manual_campaign').length,
        negate_search_terms: deduped.filter(d => d.rule_applied === 'negate_search_terms').length,
      },
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});

function safeDiv(a, b, decimals = 2) {
  if (!b || b === 0) return 0;
  return Number(((a || 0) / b).toFixed(decimals));
}