/**
 * calculateMetrics — Camada 1: Cálculos matemáticos puros de todas as métricas
 * Não usa IA. Calcula: ACoS, ROAS, TACoS, CPC, CTR, conversão, break-even, etc.
 * Retorna dados estruturados para o motor de regras (Camada 2).
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function safeDiv(a, b, decimals = 2) {
  if (!b || b === 0) return 0;
  const result = (a || 0) / b;
  return Number(result.toFixed(decimals));
}

function calculateBreakEvenACoS(marginPct) {
  // Break-even ACoS = Margem de lucro (%)
  // ACoS máximo antes de ter prejuízo
  return marginPct || 30; // padrão 30% se não informado
}

function calculateTargetCPM(bid, ctr) {
  // CPM estimado = (Bid × CTR) × 1000
  return (bid || 0) * (ctr || 0) * 1000;
}

function calculateProfit(sales, spend, marginPct) {
  // Lucro = Vendas × Margem - Spend
  const grossProfit = (sales || 0) * ((marginPct || 30) / 100);
  return grossProfit - (spend || 0);
}

function daysSince(dateStr) {
  if (!dateStr) return 999;
  const date = new Date(dateStr);
  const now = new Date();
  return Math.floor((now - date) / (1000 * 60 * 60 * 24));
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, entity_type, entity_id } = body;

    if (!amazon_account_id) {
      return Response.json({ error: 'amazon_account_id required' }, { status: 400 });
    }

    // Buscar regras e configurações da conta
    const budgetRules = await base44.asServiceRole.entities.BudgetRule.filter({ amazon_account_id });
    const rule = budgetRules[0] || {
      target_acos: 25,
      target_roas: 4,
      min_bid: 0.10,
      max_bid: 5.0,
      margin_pct: 30,
    };

    const marginPct = rule.margin_pct || 30;
    const breakEvenACoS = calculateBreakEvenACoS(marginPct);

    // Carregar dados conforme tipo de entidade
    let campaigns = [], keywords = [], searchTerms = [], products = [];

    if (!entity_type || entity_type === 'campaign') {
      campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id }, '-spend', 1000);
    }
    if (!entity_type || entity_type === 'keyword') {
      keywords = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id }, '-spend', 5000);
    }
    if (!entity_type || entity_type === 'search_term') {
      searchTerms = await base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id }, '-date', 5000);
    }
    if (!entity_type || entity_type === 'product') {
      products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id }, '-total_sales_30d', 500);
    }

    // Processar campanhas
    const processedCampaigns = campaigns.map(c => {
      const spend = c.spend || 0;
      const sales = c.sales || 0;
      const clicks = c.clicks || 0;
      const impressions = c.impressions || 0;
      const orders = c.orders || 0;
      const dailyBudget = c.daily_budget || 0;
      const currentSpend = c.current_spend || spend;

      const acos = safeDiv(spend, sales, 1);
      const roas = safeDiv(sales, spend, 2);
      const cpc = safeDiv(spend, clicks, 2);
      const ctr = safeDiv(clicks, impressions, 2);
      const cvr = safeDiv(orders, clicks, 3);
      const profit = calculateProfit(sales, spend, marginPct);
      const tacos = safeDiv(spend, sales, 1); // TACoS = Spend / Sales
      const budgetConsumedPct = dailyBudget > 0 ? safeDiv(currentSpend, dailyBudget, 1) : 0;
      const daysRunning = daysSince(c.start_date);

      // Sinais de alerta
      const hasNoSales = clicks >= 10 && sales === 0;
      const hasHighACoS = acos > rule.target_acos * 1.5;
      const hasLowROAS = roas > 0 && roas < rule.target_roas * 0.7;
      const isBudgetExhausted = budgetConsumedPct > 90;
      const isLearning = daysRunning < 7 && clicks < 30;

      return {
        ...c,
        metrics: {
          spend, sales, clicks, impressions, orders,
          acos, roas, cpc, ctr, cvr, profit, tacos,
          budget_consumed_pct: budgetConsumedPct,
          break_even_acos: breakEvenACoS,
          target_acos: rule.target_acos,
          target_roas: rule.target_roas,
        },
        signals: {
          has_no_sales: hasNoSales,
          has_high_acos: hasHighACoS,
          has_low_roas: hasLowROAS,
          is_budget_exhausted: isBudgetExhausted,
          is_learning: isLearning,
          is_profitable: profit > 0,
          is_above_break_even: acos < breakEvenACoS,
        },
        days_running: daysRunning,
      };
    });

    // Processar keywords
    const processedKeywords = keywords.map(kw => {
      const spend = kw.spend || 0;
      const sales = kw.sales || 0;
      const clicks = kw.clicks || 0;
      const impressions = kw.impressions || 0;
      const orders = kw.orders || 0;
      const bid = kw.current_bid || kw.bid || 0.25;

      const acos = safeDiv(spend, sales, 1);
      const roas = safeDiv(sales, spend, 2);
      const cpc = safeDiv(spend, clicks, 2);
      const ctr = safeDiv(clicks, impressions, 2);
      const cvr = safeDiv(orders, clicks, 3);
      const profit = calculateProfit(sales, spend, marginPct);
      const targetCPM = calculateTargetCPM(bid, ctr);

      // Sinais
      const hasNoSales = clicks >= 10 && sales === 0;
      const hasHighACoS = acos > rule.target_acos;
      const hasLowROAS = roas > 0 && roas < rule.target_roas;
      const hasNoImpressions = impressions === 0 && clicks === 0;
      const isProfitable = profit > 0;

      return {
        ...kw,
        metrics: {
          spend, sales, clicks, impressions, orders,
          acos, roas, cpc, ctr, cvr, profit,
          target_cpm: targetCPM,
          break_even_acos: breakEvenACoS,
          target_acos: rule.target_acos,
          target_roas: rule.target_roas,
        },
        signals: {
          has_no_sales: hasNoSales,
          has_high_acos: hasHighACoS,
          has_low_roas: hasLowROAS,
          has_no_impressions: hasNoImpressions,
          is_profitable: isProfitable,
          is_above_break_even: acos < breakEvenACoS,
        },
      };
    });

    // Processar search terms
    const processedSearchTerms = searchTerms.map(term => {
      const clicks = term.clicks || 0;
      const orders = term.orders_14d || term.orders_30d || term.orders || 0;
      const spend = term.spend || 0;
      const sales = term.sales_14d || term.sales_30d || term.sales || 0;

      const acos = safeDiv(spend, sales, 1);
      const roas = safeDiv(sales, spend, 2);
      const cpc = safeDiv(spend, clicks, 2);
      const cvr = safeDiv(orders, clicks, 3);
      const profit = calculateProfit(sales, spend, marginPct);

      // Classificação por desempenho
      let classification = 'insufficient_data';
      if (clicks >= 50 && orders === 0) classification = 'conversion_failure';
      else if (orders >= 3 && acos > 0 && acos <= 35) classification = 'manual_candidate';
      else if (orders >= 1 && orders <= 2 && acos > 0 && acos <= 30) classification = 'migrate_to_manual';
      else if (orders >= 5 && roas >= 4) classification = 'winner';
      else if (clicks >= 15 && orders === 0 && spend > 5) classification = 'negate';
      else if (clicks >= 10 && orders === 0) classification = 'inefficient';
      else if (clicks < 10) classification = 'insufficient_data';

      return {
        ...term,
        metrics: {
          clicks, orders, spend, sales, acos, roas, cpc, cvr, profit,
          break_even_acos: breakEvenACoS,
        },
        classification,
        signals: {
          is_candidate_for_manual: classification === 'manual_candidate' || classification === 'migrate_to_manual',
          should_negate: classification === 'negate',
          is_winner: classification === 'winner',
          is_conversion_failure: classification === 'conversion_failure',
        },
      };
    });

    // Processar produtos
    const processedProducts = products.map(p => {
      const spend30d = p.total_spend_30d || 0;
      const sales30d = p.total_sales_30d || p.total_revenue_30d || 0;
      const units30d = p.total_units_30d || p.units_sold_30d || 0;
      const fbaInventory = p.fba_inventory || 0;
      const acos = safeDiv(spend30d, sales30d, 1);
      const roas = safeDiv(sales30d, spend30d, 2);
      const profit = calculateProfit(sales30d, spend30d, marginPct);
      const daysOutOfStock = fbaInventory === 0 ? 999 : 0;

      return {
        ...p,
        metrics: {
          spend_30d: spend30d,
          sales_30d: sales30d,
          units_30d: units30d,
          acos, roas, profit,
          break_even_acos: breakEvenACoS,
        },
        signals: {
          is_out_of_stock: fbaInventory === 0,
          is_low_stock: fbaInventory > 0 && fbaInventory < 5,
          is_profitable: profit > 0,
          has_no_campaign: !(p.has_campaign || p.linked_campaign_id),
        },
      };
    });

    // Consolidar resultados
    const summary = {
      campaigns: {
        total: processedCampaigns.length,
        active: processedCampaigns.filter(c => c.state === 'enabled' && !c.archived).length,
        profitable: processedCampaigns.filter(c => c.signals.is_profitable).length,
        high_acos: processedCampaigns.filter(c => c.signals.has_high_acos).length,
        no_sales: processedCampaigns.filter(c => c.signals.has_no_sales).length,
        budget_exhausted: processedCampaigns.filter(c => c.signals.is_budget_exhausted).length,
      },
      keywords: {
        total: processedKeywords.length,
        profitable: processedKeywords.filter(k => k.signals.is_profitable).length,
        high_acos: processedKeywords.filter(k => k.signals.has_high_acos).length,
        no_sales: processedKeywords.filter(k => k.signals.has_no_sales).length,
        no_impressions: processedKeywords.filter(k => k.signals.has_no_impressions).length,
      },
      search_terms: {
        total: processedSearchTerms.length,
        manual_candidates: processedSearchTerms.filter(t => t.signals.is_candidate_for_manual).length,
        to_negate: processedSearchTerms.filter(t => t.signals.should_negate).length,
        winners: processedSearchTerms.filter(t => t.signals.is_winner).length,
        conversion_failures: processedSearchTerms.filter(t => t.signals.is_conversion_failure).length,
      },
      products: {
        total: processedProducts.length,
        profitable: processedProducts.filter(p => p.signals.is_profitable).length,
        out_of_stock: processedProducts.filter(p => p.signals.is_out_of_stock).length,
        low_stock: processedProducts.filter(p => p.signals.is_low_stock).length,
        no_campaign: processedProducts.filter(p => p.signals.has_no_campaign).length,
      },
    };

    return Response.json({
      ok: true,
      amazon_account_id,
      margin_pct: marginPct,
      break_even_acos: breakEvenACoS,
      summary,
      campaigns: processedCampaigns,
      keywords: processedKeywords,
      search_terms: processedSearchTerms,
      products: processedProducts,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});