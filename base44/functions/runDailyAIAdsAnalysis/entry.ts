/**
 * runDailyAIAdsAnalysis — Análise IA diária por blocos: lê campanhas, keywords, produtos, anúncios,
 * gera decisões em bulk (bids, negativos, budget), suporta simulate_only.
 * Inclui regras de segurança fixas (budget, estoque, etc.).
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, simulate_only, auto_apply } = body;
    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    const today = new Date().toISOString().slice(0, 10);
    const startDate180 = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
    
    // Carregar TODOS os dados (180 dias) para análise completa de IA
    const [campaigns, keywords, products, dailyMetrics] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id }, '-spend', 1000),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id }, '-spend', 5000),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id }, null, 1000),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter(
        { amazon_account_id, date: { $gte: startDate180 } },
        '-date',
        50000
      ),
    ]);
    const budgetRules = await base44.asServiceRole.entities.BudgetRule.filter({ amazon_account_id });
    const budgetRule = budgetRules[0] || { target_acos: 25, target_roas: 4, total_daily_budget: 100, min_bid: 0.10, max_bid: 5.0, bid_increase_step: 0.10, bid_decrease_step: 0.25, auto_apply_bid_reduction: false };
    const { target_acos, target_roas, min_bid, max_bid, bid_increase_step, bid_decrease_step, auto_apply_bid_reduction } = budgetRule;

    // Calcular tendências de 180 dias para contexto de IA
    const historical180 = { spend: 0, sales: 0, clicks: 0, orders: 0 };
    for (const m of dailyMetrics) {
      historical180.spend += m.spend || 0;
      historical180.sales += m.sales || 0;
      historical180.clicks += m.clicks || 0;
      historical180.orders += m.orders || 0;
    }

    // Calcular tendências de 180 dias para IA
    const campaignTrends = {};
    for (const m of dailyMetrics) {
      const cid = m.campaign_id;
      if (!campaignTrends[cid]) campaignTrends[cid] = { days: [], spend: 0, sales: 0, clicks: 0, impressions: 0 };
      campaignTrends[cid].days.push(m.date);
      campaignTrends[cid].spend += m.spend || 0;
      campaignTrends[cid].sales += m.sales || 0;
      campaignTrends[cid].clicks += m.clicks || 0;
      campaignTrends[cid].impressions += m.impressions || 0;
    }

    const currentActiveBudget = campaigns.filter(c => c.state === 'enabled').reduce((s, c) => s + (c.daily_budget || 0), 0);
    const budgetExhausted = currentActiveBudget >= budgetRule.total_daily_budget;

    const decisions = [];
    const errors = [];

    // Bloco 1: Keywords (em blocos de 100)
    for (let b = 0; b < keywords.length; b += 100) {
      for (const kw of keywords.slice(b, b + 100)) {
        if ((kw.state || kw.status) === 'archived') continue;
        try {
          const bid = kw.current_bid || kw.bid || 0.25;
          const acos = kw.acos || 0;
          const roas = kw.roas || 0;
          const clicks = kw.clicks || 0;
          const spend = kw.spend || 0;
          const sales = kw.sales || 0;
          const product = products.find(p => p.asin === kw.asin);
          const hasStock = product && (product.fba_inventory || 0) > 0 && product.inventory_status !== 'out_of_stock';

          let rec = null;

          // Reduzir: ACOS alto + ROAS baixo
          if (acos > target_acos && roas < target_roas * 0.8 && clicks >= 5) {
            const newBid = Number(Math.max(bid - Math.max(bid_decrease_step, bid * 0.2), min_bid).toFixed(2));
            rec = { entity_type: 'keyword', entity_id: kw.keyword_id, keyword: kw.keyword || kw.keyword_text, action: 'update_bid', current_value: bid, recommended_value: newBid, delta: newBid - bid, delta_percent: ((newBid - bid) / bid * 100).toFixed(1), risk_level: 'medium', requires_approval: true, reason: `ACoS ${acos.toFixed(1)}% acima meta ${target_acos}%, ROAS ${roas.toFixed(2)}x abaixo`, evidence: `Cliques: ${clicks}, Spend: $${spend.toFixed(2)}, Vendas: $${sales.toFixed(2)}`, confidence_score: 0.75, rule_applied: 'high_acos_reduce_bid' };
          } else if (spend > 5 && sales === 0 && clicks >= 10) {
            // Reduzir sem venda
            const newBid = Number(Math.max(bid - Math.max(bid_decrease_step, bid * 0.2), min_bid).toFixed(2));
            rec = { entity_type: 'keyword', entity_id: kw.keyword_id, keyword: kw.keyword || kw.keyword_text, action: 'update_bid', current_value: bid, recommended_value: newBid, delta: newBid - bid, delta_percent: ((newBid - bid) / bid * 100).toFixed(1), risk_level: 'low', requires_approval: !(auto_apply && auto_apply_bid_reduction), reason: `Gasto alto sem conversão: $${spend.toFixed(2)} 0 vendas`, evidence: `Cliques: ${clicks}`, confidence_score: 0.8, rule_applied: 'no_sales_reduce_bid' };
          }

          // Aumentar: bom desempenho + estoque disponível + budget
          if (!rec && roas >= target_roas && acos < target_acos * 0.7 && sales > 0 && clicks >= 10 && hasStock && !budgetExhausted) {
            const increase = Math.min(bid * 0.15, bid_increase_step);
            const newBid = Number(Math.min(bid + increase, max_bid).toFixed(2));
            rec = { entity_type: 'keyword', entity_id: kw.keyword_id, keyword: kw.keyword || kw.keyword_text, action: 'update_bid', current_value: bid, recommended_value: newBid, delta: newBid - bid, delta_percent: ((newBid - bid) / bid * 100).toFixed(1), risk_level: 'medium', requires_approval: true, reason: `Keyword converts: ACoS ${acos.toFixed(1)}% abaixo da meta`, evidence: `Vendas: $${sales.toFixed(2)}, Cliques: ${clicks}`, confidence_score: 0.7, rule_applied: 'performant_increase_bid' };
          }

          // Negativação
          if (clicks >= 15 && spend > 5 && sales === 0) {
            const negative = {
              entity_type: 'keyword', entity_id: kw.keyword_id, keyword: kw.keyword || kw.keyword_text, action: 'negative_keyword', risk_level: 'high', requires_approval: true, reason: `${clicks} cliques, $${spend.toFixed(2)} sem vendas`, evidence: `Estoque: ${product?.fba_inventory || 0}`, confidence_score: 0.85, rule_applied: 'waste_kw_negate',
              current_value: bid, recommended_value: null, delta: 0, delta_percent: '-100'
            };
            if (rec && rec.action === 'update_bid') decisions.push(rec);
            decisions.push(negative);
          } else if (rec) {
            decisions.push(rec);
          }

          // delay entre blocos
          if (b > 0 && (body.throttle !== false)) await new Promise(r => setTimeout(r, 100));
        } catch (e) { errors.push(`kw ${kw.keyword_id}: ${e.message.slice(0, 100)}`); }
      }
    }

    // Bloco 2: Campanhas (em blocos de 25) — ações de budget
    for (let b = 0; b < campaigns.length; b += 25) {
      for (const c of campaigns.slice(b, b + 25)) {
        if (c.state === 'archived') continue;
        try {
          if ((c.acos || 0) > target_acos * 2 && (c.spend || 0) > 10) {
            const newBudget = Number(Math.max((c.daily_budget || 10) * 0.8, 5).toFixed(2));
            decisions.push({
              entity_type: 'campaign', entity_id: c.campaign_id, campaign_id: c.campaign_id, asin: c.asin, action: 'update_budget', current_value: c.daily_budget, recommended_value: newBudget, delta: newBudget - (c.daily_budget || 10), delta_percent: ((newBudget - (c.daily_budget || 10)) / (c.daily_budget || 10) * 100).toFixed(1), risk_level: 'medium', requires_approval: true, reason: `ACoS ${(c.acos || 0).toFixed(1)}% muito acima da meta`, evidence: `Spend: $${(c.spend || 0).toFixed(2)}`, confidence_score: 0.7, rule_applied: 'high_acos_pause_budget'
            });
          }
          const product = products.find(p => p.asin === c.asin);
          if (product && product.inventory_status === 'out_of_stock' && c.state !== 'paused') {
            decisions.push({
              entity_type: 'campaign', entity_id: c.campaign_id, campaign_id: c.campaign_id, asin: c.asin, action: 'pause_campaign', risk_level: 'high', requires_approval: true, reason: `ASIN ${c.asin} sem estoque`, evidence: `Campanha: ${c.name || c.campaign_id}`, confidence_score: 0.9, rule_applied: 'no_stock_required',
              current_value: null, recommended_value: null, delta: 0, delta_percent: '-100'
            });
          }
        } catch (e) { errors.push(`camp ${c.campaign_id}: ${e.message.slice(0, 100)}`); }
      }
      if (b > 0) await new Promise(r => setTimeout(r, 200));
    }

    // Dedup: manter ação com maior risco (ex: negative sobrepõe reduce)
    const deduped = Object.values(decisions.reduce((acc, d) => {
      const key = `${d.action}_${d.entity_type}_${d.entity_id}`;
      const priorR = { high: 3, medium: 2, low: 1 }[d.risk_level] || 1;
      const priorA = acc[key] ? { high: 3, medium: 2, low: 1 }[acc[key].risk_level] || 1 : 0;
      if (!acc[key] || priorR >= priorA) acc[key] = d;
      return acc;
    }, {}));

    if (simulate_only) {
      return Response.json({ ok: true, simulate_only: true, decisions_generated: deduped.length, breakdown: countActions(deduped), errors: errors.length > 0 ? errors : undefined, duration_ms: Date.now() - startTime });
    }

    const batch = deduped.map(d => ({
      amazon_account_id, date: today,
      entity_type: d.entity_type, entity_id: d.entity_id, campaign_id: d.campaign_id, asin: d.asin, keyword_id: d.keyword_id, keyword: d.keyword,
      action: d.action, current_value: d.current_value, recommended_value: d.recommended_value, delta: d.delta, delta_percent: d.delta_percent,
      reason: d.reason, evidence: d.evidence, risk_level: d.risk_level, confidence_score: d.confidence_score, requires_approval: d.requires_approval,
      rule_applied: d.rule_applied, model_used: 'blocked_queries_v1',
      status: (d.action === 'update_bid' || d.action === 'update_budget') && d.risk_level === 'low' && !d.requires_approval ? 'scheduled' : 'pending',
    }));

    let created = 0;
    if (batch.length > 0) {
      for (let i = 0; i < batch.length; i += 200) {
        await base44.asServiceRole.entities.AdsAiDecision.bulkCreate(batch.slice(i, i + 200));
        created += Math.min(200, batch.length - i);
      }
    }

    await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id, operation: 'dailyAIAdsAnalysis', status: 'success',
      records_received: keywords.length + campaigns.length + products.length,
      records_upserted: created, started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(), duration_ms: Date.now() - startTime,
    });

    return Response.json({
      ok: true, decisions_generated: created, simulate_only: !!simulate_only,
      breakdown: countActions(deduped), errors: errors.length > 0 ? errors : undefined,
      duration_ms: Date.now() - startTime,
    });

    function countActions(arr) {
      const counts = {};
      for (const d of arr) counts[d.action] = (counts[d.action] || 0) + 1;
      return counts;
    }
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});