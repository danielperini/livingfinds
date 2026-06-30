/**
 * summarizeForAI — Camada 3: Gera resumo consolidado para IA
 * Consome apenas 1 chamada de LLM por dia por conta.
 * 
 * Entrada: Dados já processados das Camadas 1 e 2.
 * Saída: Prompt estruturado para IA priorizar decisões.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, use_ai } = body;

    if (!amazon_account_id) {
      return Response.json({ error: 'amazon_account_id required' }, { status: 400 });
    }

    // Buscar dados consolidados das camadas anteriores
    const [campaigns, keywords, searchTerms, products, decisions, alerts] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id }, '-spend', 500),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id }, '-spend', 2000),
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id }, '-date', 2000),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id }, '-total_sales_30d', 200),
      base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id, status: 'pending' }, '-created_date', 100),
      base44.asServiceRole.entities.Alert.filter({ amazon_account_id, status: 'active' }, '-created_at', 50),
    ]);

    // Calcular métricas agregadas
    const totalSpend = campaigns.reduce((sum, c) => sum + (c.spend || 0), 0);
    const totalSales = campaigns.reduce((sum, c) => sum + (c.sales || 0), 0);
    const totalClicks = campaigns.reduce((sum, c) => sum + (c.clicks || 0), 0);
    const totalOrders = campaigns.reduce((sum, c) => sum + (c.orders || 0), 0);
    
    const acos = totalSales > 0 ? (totalSpend / totalSales * 100) : 0;
    const roas = totalSpend > 0 ? (totalSales / totalSpend) : 0;
    const ctr = totalClicks > 0 ? (totalClicks / (campaigns.reduce((sum, c) => sum + (c.impressions || 0), 0)) * 100) : 0;
    const cvr = totalClicks > 0 ? (totalOrders / totalClicks * 100) : 0;

    // Contar alertas por severidade
    const alertCounts = {
      critical: alerts.filter(a => a.severity === 'critical').length,
      high: alerts.filter(a => a.severity === 'high').length,
      medium: alerts.filter(a => a.severity === 'medium').length,
      low: alerts.filter(a => a.severity === 'low').length,
    };

    // Contar decisões pendentes por tipo
    const decisionCounts = {
      bid_change: decisions.filter(d => d.decision_type === 'bid_change').length,
      budget_change: decisions.filter(d => d.decision_type === 'budget_change').length,
      pause: decisions.filter(d => d.decision_type === 'pause').length,
      negative_keyword: decisions.filter(d => d.decision_type === 'negative_keyword').length,
      create_keyword: decisions.filter(d => d.decision_type === 'create_keyword').length,
      dayparting_rule: decisions.filter(d => d.decision_type === 'dayparting_rule').length,
    };

    // Identificar top problemas
    const topProblems = [];

    // 1. Campanhas com ACoS crítico
    const highACoSCampaigns = campaigns
      .filter(c => (c.acos || 0) > 50 && (c.spend || 0) > 5)
      .sort((a, b) => (b.acos || 0) - (a.acos || 0))
      .slice(0, 5);
    
    if (highACoSCampaigns.length > 0) {
      topProblems.push({
        type: 'high_acos_campaigns',
        count: highACoSCampaigns.length,
        examples: highACoSCampaigns.map(c => ({
          name: c.name || c.campaign_id,
          asin: c.asin,
          acos: c.acos,
          spend: c.spend,
        })),
      });
    }

    // 2. Keywords gastando sem venda
    const wastingKeywords = keywords
      .filter(k => (k.clicks || 0) >= 10 && (k.sales || 0) === 0 && (k.spend || 0) > 2)
      .sort((a, b) => (b.spend || 0) - (a.spend || 0))
      .slice(0, 10);
    
    if (wastingKeywords.length > 0) {
      topProblems.push({
        type: 'keywords_wasting_spend',
        count: wastingKeywords.length,
        total_wasted: wastingKeywords.reduce((sum, k) => sum + (k.spend || 0), 0),
        examples: wastingKeywords.map(k => ({
          keyword: k.keyword_text || k.keyword,
          clicks: k.clicks,
          spend: k.spend,
        })),
      });
    }

    // 3. Search terms candidatos a negativação
    const termsToNegate = searchTerms
      .filter(t => (t.clicks || 0) >= 15 && (t.orders_14d || t.orders_30d || t.orders || 0) === 0 && (t.spend || 0) > 5)
      .slice(0, 10);
    
    if (termsToNegate.length > 0) {
      topProblems.push({
        type: 'search_terms_to_negate',
        count: termsToNegate.length,
        examples: termsToNegate.map(t => ({
          term: t.search_term,
          clicks: t.clicks,
          spend: t.spend,
        })),
      });
    }

    // 4. Produtos sem estoque com campanha ativa
    const outOfStockProducts = products
      .filter(p => (p.fba_inventory || 0) === 0 && (p.linked_campaign_id || p.has_campaign))
      .slice(0, 5);
    
    if (outOfStockProducts.length > 0) {
      topProblems.push({
        type: 'out_of_stock_with_ads',
        count: outOfStockProducts.length,
        examples: outOfStockProducts.map(p => ({
          asin: p.asin,
          spend_30d: p.total_spend_30d,
        })),
      });
    }

    // 5. Orçamentos exaustos cedo
    const exhaustedBudgets = campaigns
      .filter(c => {
        const hour = new Date().getHours();
        const expectedPct = hour / 24;
        const actualPct = (c.current_spend || 0) / (c.daily_budget || 1);
        return actualPct > 0.8 && actualPct > expectedPct + 0.3;
      })
      .slice(0, 5);
    
    if (exhaustedBudgets.length > 0) {
      topProblems.push({
        type: 'budget_exhaustion_early',
        count: exhaustedBudgets.length,
        examples: exhaustedBudgets.map(c => ({
          name: c.name || c.campaign_id,
          budget_consumed_pct: ((c.current_spend || 0) / (c.daily_budget || 1) * 100).toFixed(0),
        })),
      });
    }

    // Identificar oportunidades
    const opportunities = [];

    // 1. Search terms candidatos a campanhas manuais
    const manualCandidates = searchTerms
      .filter(t => {
        const orders = t.orders_14d || t.orders_30d || t.orders || 0;
        const acos = t.acos_14d || t.acos_7d || t.acos || 0;
        return orders >= 3 && acos > 0 && acos <= 35;
      })
      .sort((a, b) => (b.orders_14d || b.orders_30d || b.orders || 0) - (a.orders_14d || a.orders_30d || a.orders || 0))
      .slice(0, 10);
    
    if (manualCandidates.length > 0) {
      opportunities.push({
        type: 'manual_campaign_candidates',
        count: manualCandidates.length,
        examples: manualCandidates.map(t => ({
          term: t.search_term,
          orders: t.orders_14d || t.orders_30d || t.orders || 0,
          acos: t.acos_14d || t.acos_7d || t.acos || 0,
          roas: t.roas_14d || t.roas_7d || t.roas || 0,
        })),
      });
    }

    // 2. Keywords com ROAS alto para aumento de bid
    const highROASKeywords = keywords
      .filter(k => (k.roas || 0) >= 4 && (k.sales || 0) > 5 && (k.current_bid || k.bid || 0) < 5)
      .sort((a, b) => (b.roas || 0) - (a.roas || 0))
      .slice(0, 10);
    
    if (highROASKeywords.length > 0) {
      opportunities.push({
        type: 'keywords_for_bid_increase',
        count: highROASKeywords.length,
        examples: highROASKeywords.map(k => ({
          keyword: k.keyword_text || k.keyword,
          roas: k.roas,
          current_bid: k.current_bid || k.bid,
        })),
      });
    }

    // 3. Campanhas eficientes para escala
    const scalableCampaigns = campaigns
      .filter(c => (c.roas || 0) >= 3 && (c.acos || 0) < 30 && (c.budget_consumed_pct || 0) < 70)
      .sort((a, b) => (b.roas || 0) - (a.roas || 0))
      .slice(0, 5);
    
    if (scalableCampaigns.length > 0) {
      opportunities.push({
        type: 'campaigns_for_scaling',
        count: scalableCampaigns.length,
        examples: scalableCampaigns.map(c => ({
          name: c.name || c.campaign_id,
          roas: c.roas,
          budget_consumed_pct: c.budget_consumed_pct,
        })),
      });
    }

    // Construir resumo executivo
    const executiveSummary = {
      period: 'Últimos 30 dias',
      generated_at: new Date().toISOString(),
      account_metrics: {
        total_spend: totalSpend.toFixed(2),
        total_sales: totalSales.toFixed(2),
        acos: acos.toFixed(1),
        roas: roas.toFixed(2),
        ctr: ctr.toFixed(2),
        cvr: cvr.toFixed(2),
        total_clicks: totalClicks,
        total_orders: totalOrders,
      },
      alerts_summary: {
        total: alerts.length,
        critical: alertCounts.critical,
        high: alertCounts.high,
        medium: alertCounts.medium,
        low: alertCounts.low,
      },
      decisions_pending: {
        total: decisions.length,
        by_type: decisionCounts,
      },
      top_problems,
      opportunities,
    };

    // Se use_ai=true, chamar LLM para priorização
    if (use_ai) {
      const prompt = `
Você é um especialista em Amazon Ads. Analise os dados abaixo e priorize as ações.

## Resumo da Conta
- Spend: $${totalSpend.toFixed(2)}
- Vendas: $${totalSales.toFixed(2)}
- ACoS: ${acos.toFixed(1)}% (meta: 25-30%)
- ROAS: ${roas.toFixed(2)}x (meta: 3-4x)
- CTR: ${ctr.toFixed(2)}%
- CVR: ${cvr.toFixed(2)}%

## Alertas Ativos
- Críticos: ${alertCounts.critical}
- Altos: ${alertCounts.high}
- Médios: ${alertCounts.medium}

## Decisões Pendentes
- Total: ${decisions.length}
- Mudanças de bid: ${decisionCounts.bid_change}
- Mudanças de budget: ${decisionCounts.budget_change}
- Pausas: ${decisionCounts.pause}
- Keywords negativas: ${decisionCounts.negative_keyword}

## Principais Problemas
${topProblems.map(p => `- ${p.type}: ${p.count} ocorrências`).join('\n')}

## Oportunidades
${opportunities.map(o => `- ${o.type}: ${o.count} ocorrências`).join('\n')}

## Sua Tarefa
1. Priorize as 3-5 ações MAIS IMPORTANTES para as próximas 24h.
2. Para cada ação, explique o PORQUÊ (impacto esperado).
3. Identifique conflitos (ex: aumentar budget em campanha com ACoS alto).
4. Sugira ações de baixo risco que podem ser automatizadas.

Responda em JSON:
{
  "prioritized_actions": [
    { "rank": 1, "action": "...", "reason": "...", "expected_impact": "...", "risk": "low|medium|high" }
  ],
  "conflicts_detected": ["..."],
  "low_risk_automations": ["..."]
}
`.trim();

      const llmResponse = await base44.integrations.Core.InvokeLLM({
        prompt,
        response_json_schema: {
          type: 'object',
          properties: {
            prioritized_actions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  rank: { type: 'number' },
                  action: { type: 'string' },
                  reason: { type: 'string' },
                  expected_impact: { type: 'string' },
                  risk: { type: 'string', enum: ['low', 'medium', 'high'] },
                },
                required: ['rank', 'action', 'reason', 'expected_impact', 'risk'],
              },
            },
            conflicts_detected: { type: 'array', items: { type: 'string' } },
            low_risk_automations: { type: 'array', items: { type: 'string' } },
          },
          required: ['prioritized_actions', 'conflicts_detected', 'low_risk_automations'],
        },
        model: 'gpt_4o_mini', // Modelo econômico
      });

      return Response.json({
        ok: true,
        amazon_account_id,
        executive_summary: executiveSummary,
        ai_prioritization: llmResponse,
        message: 'Resumo consolidado + priorização por IA (1 chamada)',
      });
    }

    // Sem IA: apenas retorna dados estruturados
    return Response.json({
      ok: true,
      amazon_account_id,
      executive_summary: executiveSummary,
      ai_prioritization: null,
      message: 'Resumo consolidado pronto para IA (use_ai=true para priorização)',
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});