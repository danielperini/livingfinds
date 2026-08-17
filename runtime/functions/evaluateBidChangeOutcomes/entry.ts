import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const sum = (rows, key) => rows.reduce((total, row) => total + Number(row?.[key] || 0), 0);
const pct = (before, after) => before > 0 ? ((after - before) / before) * 100 : after > 0 ? 100 : 0;

function aggregate(rows) {
  const spend = sum(rows, 'spend');
  const sales = sum(rows, 'sales');
  const orders = sum(rows, 'orders');
  const clicks = sum(rows, 'clicks');
  const impressions = sum(rows, 'impressions');
  return {
    spend,
    sales,
    orders,
    clicks,
    impressions,
    acos: sales > 0 ? spend / sales * 100 : 0,
    roas: spend > 0 ? sales / spend : 0,
    conversion_rate: clicks > 0 ? orders / clicks * 100 : 0,
  };
}

function classify(before, after) {
  if (after.clicks < 5 && after.orders === 0) return ['insufficient_data', 'wait_more_data'];
  const roasChange = pct(before.roas, after.roas);
  const salesChange = pct(before.sales, after.sales);
  const acosChange = pct(before.acos, after.acos);
  if ((roasChange >= 10 || salesChange >= 15) && acosChange <= 15) return ['positive', 'keep'];
  if (roasChange <= -15 || acosChange >= 20) return ['negative', 'revert'];
  return ['neutral', 'wait_more_data'];
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const auth = await base44.auth.isAuthenticated().catch(() => false);
    if (!auth && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    if (!body.amazon_account_id) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });

    const history = await base44.asServiceRole.entities.BidHistory.filter({ amazon_account_id: body.amazon_account_id }, '-created_at', 500);
    const now = Date.now();
    let evaluated = 0;
    let skipped = 0;

    for (const item of history) {
      if (item.ml_learning_status === 'learned' || item.evaluated_at) { skipped++; continue; }
      const executedAt = item.executed_at || item.created_at;
      if (!executedAt || now - new Date(executedAt).getTime() < 7 * 86400000) { skipped++; continue; }

      const decisions = item.decision_id ? await base44.asServiceRole.entities.OptimizationDecision.filter({ id: item.decision_id }, null, 1) : [];
      const decision = decisions[0] || {};
      const campaignId = decision.campaign_id || item.campaign_id || null;
      if (!campaignId) { skipped++; continue; }

      const metrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: body.amazon_account_id, campaign_id: campaignId }, '-date', 90);
      const changeDate = new Date(executedAt);
      const beforeStart = new Date(changeDate.getTime() - 7 * 86400000).toISOString().slice(0, 10);
      const changeDay = changeDate.toISOString().slice(0, 10);
      const afterEnd = new Date(changeDate.getTime() + 7 * 86400000).toISOString().slice(0, 10);
      const beforeRows = metrics.filter((m) => m.date >= beforeStart && m.date < changeDay);
      const afterRows = metrics.filter((m) => m.date >= changeDay && m.date < afterEnd);
      const before = aggregate(beforeRows);
      const after = aggregate(afterRows);
      const [outcome, nextAction] = classify(before, after);

      await base44.asServiceRole.entities.BidHistory.update(item.id, {
        evaluation_period_days: 7,
        evaluation_start_at: changeDay,
        evaluation_end_at: afterEnd,
        impressions_before: before.impressions,
        clicks_before: before.clicks,
        spend_before: before.spend,
        sales_before: before.sales,
        orders_before: before.orders,
        acos_before: before.acos,
        roas_before: before.roas,
        conversion_rate_before: before.conversion_rate,
        impressions_after: after.impressions,
        clicks_after: after.clicks,
        spend_after: after.spend,
        sales_after: after.sales,
        orders_after: after.orders,
        acos_after: after.acos,
        roas_after: after.roas,
        conversion_rate_after: after.conversion_rate,
        performance_change_pct: pct(before.roas, after.roas),
        outcome,
        recommended_next_action: nextAction,
        ml_learning_status: 'learned',
        evaluated_at: new Date().toISOString(),
      });

      await base44.asServiceRole.entities.LearningEvent.create({
        amazon_account_id: body.amazon_account_id,
        event_type: 'bid_change_evaluated',
        entity_type: item.entity_type || 'keyword',
        entity_id: item.entity_id || item.keyword_id || campaignId,
        asin: decision.asin || item.asin || null,
        keyword: decision.keyword_text || item.entity_name || null,
        outcome,
        source: 'bid_history_ml',
        metadata: JSON.stringify({
          bid_before: item.bid_before ?? item.old_bid ?? null,
          bid_after: item.bid_after ?? item.new_bid ?? null,
          change_pct: item.change_pct ?? null,
          campaign_id: campaignId,
          before,
          after,
          recommended_next_action: nextAction,
        }),
      }).catch(() => {});
      evaluated++;
    }

    return Response.json({ ok: true, evaluated, skipped, total: history.length });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao avaliar histórico de bids' }, { status: 500 });
  }
});
