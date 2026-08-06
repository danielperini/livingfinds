import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { campaignMatchesRule, ruleMatchesNow, ruleWindowKey } from '../../shared/persistedDaypartRulePolicy.ts';

const SOURCE = 'queueCanonicalCampaignDaypartState';
const active = (value: unknown) => ['enabled', 'active'].includes(String(value || '').toLowerCase());
const paused = (value: unknown) => String(value || '').toLowerCase() === 'paused';
const idOf = (campaign: any) => String(campaign.amazon_campaign_id || campaign.campaign_id || campaign.id || '');

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
    const totals = { matched_rules: 0, proposed: 0, queued: 0, executed_pause: 0, skipped: 0 };
    const results: any[] = [];

    for (const account of accounts) {
      const accountId = String(account.id);
      const [rules, campaigns, prior] = await Promise.all([
        base44.asServiceRole.entities.AmazonScheduledRule.filter({ amazon_account_id: accountId, status: 'enabled' }, '-updated_at', 500).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-updated_at', 10000).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-created_at', 30000).catch(() => []),
      ]);
      const applicableRules = rules.filter((rule: any) => ['PAUSE_CAMPAIGN', 'ENABLE_CAMPAIGN'].includes(String(rule.action_type || '').toUpperCase()) && ruleMatchesNow(rule, now));
      totals.matched_rules += applicableRules.length;
      const existing = new Set(prior.map((decision: any) => String(decision.idempotency_key || '')).filter(Boolean));
      const proposed: any[] = [];
      const pauseDecisionIds: string[] = [];

      for (const rule of applicableRules) {
        const action = String(rule.action_type).toUpperCase() === 'PAUSE_CAMPAIGN' ? 'pause_campaign' : 'enable_campaign';
        for (const campaign of campaigns) {
          const campaignId = idOf(campaign);
          if (!campaignId || campaign.archived === true || !campaignMatchesRule(rule, campaign)) continue;
          if (action === 'pause_campaign' && !active(campaign.state || campaign.status)) continue;
          if (action === 'enable_campaign' && !paused(campaign.state || campaign.status)) continue;

          const key = `${SOURCE}|${accountId}|${ruleWindowKey(rule, now)}|${campaignId}|${action}`;
          if (existing.has(key)) { totals.skipped++; continue; }
          existing.add(key);
          proposed.push({ rule, campaignId, action, key, name: campaign.name || campaign.campaign_name || null });
        }
      }

      totals.proposed += proposed.length;
      if (!dryRun) {
        for (const item of proposed) {
          const decision = await base44.asServiceRole.entities.OptimizationDecision.create({
            amazon_account_id: accountId,
            decision_type: 'scheduled_campaign_daypart',
            entity_type: 'campaign',
            entity_id: item.campaignId,
            campaign_id: item.campaignId,
            campaign_name: item.name,
            action: item.action,
            canonical_action_type: 'CAMPAIGN_STATE_CHANGE',
            rationale: `${item.rule.rule_name}: regra persistida de dayparting`,
            rule_key: String(item.rule.id || item.rule.idempotency_key || ''),
            reason_code: 'PERSISTED_DAYPART_RULE',
            value_before: item.action === 'pause_campaign' ? 'ENABLED' : 'PAUSED',
            value_after: item.action === 'pause_campaign' ? 'PAUSED' : 'ENABLED',
            confidence: 1,
            risk: item.action === 'pause_campaign' ? 'high' : 'medium',
            requires_approval: false,
            approval_status: 'auto_approved',
            status: 'approved',
            queue_status: 'pending',
            execution_mode: 'SCHEDULED_WINDOW',
            confirmation_required: true,
            confirmation_status: 'pending',
            idempotency_key: item.key,
            conflict_group: `${accountId}|campaign|${item.campaignId}`,
            source_function: SOURCE,
            model_version: 'persisted-daypart-v1',
            data_used: JSON.stringify({ scheduled_rule_id: item.rule.id, rule_name: item.rule.rule_name }),
            not_before: now.toISOString(),
            execute_before: new Date(now.getTime() + 45 * 60_000).toISOString(),
            max_attempts: 3,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          totals.queued++;
          if (item.action === 'pause_campaign') pauseDecisionIds.push(String(decision.id));
        }

        if (pauseDecisionIds.length) {
          const execution = await base44.asServiceRole.functions.invoke('executePauseDecisionSafe', { decision_ids: pauseDecisionIds, _service_role: true });
          const data = execution?.data || execution || {};
          totals.executed_pause += Number(data.executed || 0);
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

      results.push({ amazon_account_id: accountId, dry_run: dryRun, matched_rules: applicableRules.length, proposed: proposed.length });
    }

    return Response.json({ ok: true, engine: 'persisted-campaign-daypart-v1', totals, results });
  } catch (error: any) {
    return Response.json({ ok: false, engine: 'persisted-campaign-daypart-v1', error: error?.message || 'Falha ao aplicar regras persistidas de campanha' }, { status: 500 });
  }
});
