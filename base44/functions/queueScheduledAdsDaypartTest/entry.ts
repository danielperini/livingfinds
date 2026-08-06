import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { bidMultiplierForRule, campaignMatchesRule, ruleMatchesNow, ruleWindowKey } from '../../shared/persistedDaypartRulePolicy.ts';

const SOURCE = 'queueScheduledAdsDaypartTest';
const active = (value: unknown) => ['enabled', 'active'].includes(String(value || '').toLowerCase());
const finite = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const campaignIdOf = (row: any) => String(row.amazon_campaign_id || row.campaign_id || row.id || '');

function parse(value: unknown): any {
  try { return JSON.parse(String(value || '{}')); } catch { return {}; }
}

function baselineFor(entity: any, prior: any[]): number {
  const entityId = String(entity.keyword_id || entity.id || '');
  const previous = prior.find((row) => String(row.entity_id || '') === entityId && row.source_function === SOURCE);
  const evidence = parse(previous?.data_used);
  return finite(evidence.baseline_bid, finite(entity.bid ?? entity.current_bid));
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    if (body._canonical_orchestrator !== 'runUnifiedDecisionEngine') {
      return Response.json({ ok: false, error: 'Execução permitida somente pelo motor canônico' }, { status: 403 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 50);
    const now = body.now ? new Date(body.now) : new Date();
    const dryRun = body.dry_run === true;
    const results: any[] = [];

    for (const account of accounts) {
      const accountId = String(account.id);
      const [rules, performanceRows, campaigns, keywords, prior] = await Promise.all([
        base44.asServiceRole.entities.AmazonScheduledRule.filter({ amazon_account_id: accountId, status: 'enabled' }, '-updated_at', 500).catch(() => []),
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-updated_at', 10000).catch(() => []),
        base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-updated_at', 30000).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-created_at', 30000).catch(() => []),
      ]);
      const settings = performanceRows[0] || {};
      const applicableRules = rules.filter((rule: any) => String(rule.action_type || '').toUpperCase() === 'BID_PERCENT' && ruleMatchesNow(rule, now));
      const campaignById = new Map(campaigns.map((campaign: any) => [campaignIdOf(campaign), campaign]));
      const protectedCampaignIds = new Set(campaigns.filter((campaign: any) =>
        campaign.protected_high_performance === true || finite(campaign.orders) > 0 && finite(campaign.sales) > 0
      ).map(campaignIdOf));
      const existingKeys = new Set(prior.map((row: any) => String(row.idempotency_key || '')).filter(Boolean));
      const proposed: any[] = [];
      const blocked: any[] = [];

      for (const rule of applicableRules) {
        const multiplier = bidMultiplierForRule(rule);
        for (const keyword of keywords) {
          if (!active(keyword.state || keyword.status)) continue;
          const campaignId = String(keyword.campaign_id || '');
          const campaign = campaignById.get(campaignId);
          if (!campaign || !campaignMatchesRule(rule, campaign)) continue;
          if (protectedCampaignIds.has(campaignId) && multiplier < 1) {
            blocked.push({ rule_id: rule.id, campaign_id: campaignId, keyword_id: keyword.keyword_id || keyword.id, reason: 'PROTECTED_WINNER' });
            continue;
          }

          const entityId = String(keyword.keyword_id || keyword.id || '');
          const baselineBid = baselineFor(keyword, prior);
          const currentBid = finite(keyword.bid ?? keyword.current_bid);
          const minBid = finite(settings.min_bid, 0.02);
          const maxBid = finite(settings.max_bid, Number.POSITIVE_INFINITY);
          const targetBid = Math.min(maxBid, Math.max(minBid, Math.round(baselineBid * multiplier * 100) / 100));
          if (!entityId || baselineBid <= 0 || Math.abs(targetBid - currentBid) < 0.005) continue;

          const key = `${SOURCE}|${accountId}|${ruleWindowKey(rule, now)}|keyword|${entityId}|set_bid`;
          if (existingKeys.has(key)) continue;
          existingKeys.add(key);
          proposed.push({ rule, entityId, campaignId, keyword, baselineBid, currentBid, targetBid, key, multiplier });
        }
      }

      const queued: any[] = [];
      if (!dryRun) {
        for (const item of proposed) {
          const decision = await base44.asServiceRole.entities.OptimizationDecision.create({
            amazon_account_id: accountId,
            decision_type: 'scheduled_ads_daypart',
            entity_type: 'keyword',
            entity_id: item.entityId,
            entity_name: item.keyword.keyword_text || item.keyword.keyword,
            campaign_id: item.campaignId,
            ad_group_id: item.keyword.ad_group_id || null,
            keyword_id: item.entityId,
            action: 'set_bid',
            canonical_action_type: 'BID_CHANGE',
            rationale: `${item.rule.rule_name}: bid ${(item.multiplier * 100).toFixed(0)}% do baseline`,
            rule_key: String(item.rule.id || item.rule.idempotency_key || ''),
            reason_code: 'PERSISTED_DAYPART_RULE',
            value_before: item.currentBid,
            value_after: item.targetBid,
            current_value: item.currentBid,
            proposed_value: item.targetBid,
            confidence: 1,
            risk: item.multiplier < 1 ? 'medium' : 'low',
            requires_approval: false,
            approval_status: 'auto_approved',
            status: 'approved',
            queue_status: 'pending',
            execution_mode: 'SCHEDULED_WINDOW',
            confirmation_required: true,
            confirmation_status: 'pending',
            idempotency_key: item.key,
            conflict_group: `${accountId}|keyword|${item.entityId}`,
            data_used: JSON.stringify({ scheduled_rule_id: item.rule.id, baseline_bid: item.baselineBid, multiplier: item.multiplier }),
            rollback_plan: JSON.stringify({ action: 'set_bid', value: item.currentBid }),
            source_function: SOURCE,
            model_version: 'persisted-daypart-v1',
            not_before: now.toISOString(),
            execute_before: new Date(now.getTime() + 45 * 60_000).toISOString(),
            max_attempts: 3,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          queued.push({ decision_id: decision.id, rule_id: item.rule.id, keyword_id: item.entityId });
        }

        for (const rule of applicableRules) {
          const count = proposed.filter((item) => item.rule.id === rule.id).length;
          await base44.asServiceRole.entities.AmazonScheduledRule.update(rule.id, {
            last_execution_at: now.toISOString(),
            last_execution_status: count ? 'queued' : 'no_changes',
            last_execution_count: count,
            amazon_response_status: count ? 202 : 204,
            amazon_response: JSON.stringify({ queued: count, confirmation_required: true }),
            last_error: null,
            updated_at: new Date().toISOString(),
          }).catch(() => {});
        }
      }

      results.push({
        amazon_account_id: accountId,
        dry_run: dryRun,
        matched_rules: applicableRules.length,
        proposed: proposed.length,
        queued: queued.length,
        blocked,
      });
    }

    return Response.json({
      ok: true,
      engine: 'persisted-bid-daypart-v1',
      dry_run: dryRun,
      accounts: results,
      totals: {
        matched_rules: results.reduce((sum, row) => sum + row.matched_rules, 0),
        proposed: results.reduce((sum, row) => sum + row.proposed, 0),
        queued: results.reduce((sum, row) => sum + row.queued, 0),
        blocked: results.reduce((sum, row) => sum + row.blocked.length, 0),
      },
    });
  } catch (error: any) {
    return Response.json({ ok: false, engine: 'persisted-bid-daypart-v1', error: error?.message || 'Falha ao aplicar regras persistidas de bid' }, { status: 500 });
  }
});
