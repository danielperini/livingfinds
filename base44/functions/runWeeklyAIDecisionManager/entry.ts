import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { boundedSoftRuleChange, classifyPortfolioCampaign, portfolioEfficiency } from '../../shared/weeklyAiDecisionManagerPolicy.ts';

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request); const body = await request.json().catch(() => ({}));
    if (!body._service_role && !await base44.auth.isAuthenticated().catch(() => false)) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    const accounts = body.amazon_account_id ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1) : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 50);
    const dryRun = body.dry_run !== false; const results: any[] = [];
    for (const account of accounts) {
      const aid = String(account.id); const now = new Date().toISOString();
      const [campaigns, metrics, decisions, rules] = await Promise.all([
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-updated_at', 10000).catch(() => []),
        base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 30000).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: aid }, '-created_at', 30000).catch(() => []),
        base44.asServiceRole.entities.DecisionRule.filter({ amazon_account_id: aid }, '-updated_at', 1000).catch(() => []),
      ]);
      const byCampaign = new Map<string, any>();
      for (const metric of metrics) { const id = String(metric.campaign_id || ''); if (!id) continue; const row = byCampaign.get(id) || { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0 }; row.impressions += Number(metric.impressions || 0); row.clicks += Number(metric.clicks || 0); row.spend += Number(metric.spend || 0); row.sales += Number(metric.sales || 0); row.orders += Number(metric.orders || 0); byCampaign.set(id, row); }
      const classified = campaigns.map((campaign: any) => { const data = byCampaign.get(String(campaign.campaign_id || campaign.amazon_campaign_id || campaign.id)) || {}; const classification = classifyPortfolioCampaign({ ...data, profit_after_ads: campaign.profit_after_ads, target_acos: campaign.target_acos, break_even_acos: campaign.break_even_acos }); return { campaign_id: campaign.campaign_id || campaign.amazon_campaign_id || campaign.id, classification, ...data }; });
      const kpis = portfolioEfficiency(classified);
      const decisionCounts = ['approved', 'executed', 'blocked', 'waiting_retry', 'confirming', 'confirmed', 'failed', 'expired', 'superseded'].reduce((out: any, status) => ({ ...out, [status]: decisions.filter((d: any) => d.status === status || d.confirmation_status === status).length }), {});
      const candidates = rules.filter((rule: any) => rule.source === 'claude_weekly' && rule.status === 'active').map((rule: any) => ({ rule_key: rule.rule_key, change: boundedSoftRuleChange(rule.rule_key, Number(rule.action?.value || 0), Number(rule.action?.recommended_value || rule.action?.value || 0)) })).filter((row: any) => row.change.allowed);
      const review = { weekly_review: true, events: ['WEEKLY_AI_REVIEW_STARTED', 'REPORTS_READY', 'PORTFOLIO_CLASSIFIED', 'ENGINE_DIAGNOSED'], kpis, classifications: classified.reduce((out: any, row: any) => ({ ...out, [row.classification]: (out[row.classification] || 0) + 1 }), {}), decision_counts: decisionCounts, soft_rule_candidates: candidates, dry_run: dryRun };
      if (!dryRun) await base44.asServiceRole.entities.DecisionRulePerformance.create({ amazon_account_id: aid, rule_key: 'WEEKLY_AI_MANAGER_REVIEW', rule_name: 'Weekly AI Decision Manager', decision_type: 'weekly_engine_review', times_used: 1, avg_impact_score: kpis.efficient_campaign_rate, updated_at: now });
      results.push({ amazon_account_id: aid, ...review, completed_at: now, event: 'WEEKLY_AI_REVIEW_COMPLETED' });
    }
    return Response.json({ ok: true, engine: 'weekly-ai-decision-manager-v1', dry_run: dryRun, results });
  } catch (error: any) { return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 }); }
});
