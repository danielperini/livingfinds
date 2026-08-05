import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { normalizeHolidayDates, resolveScheduledAdsDaypart } from '../../shared/scheduledAdsDaypartPolicy.ts';

const SOURCE = 'queueCanonicalCampaignDaypartState';
const active = (v: unknown) => ['enabled', 'active'].includes(String(v || '').toLowerCase());
const paused = (v: unknown) => String(v || '').toLowerCase() === 'paused';
const idOf = (c: any) => String(c.amazon_campaign_id || c.campaign_id || c.id || '');
const upper = (v: unknown) => String(v || '').trim().toUpperCase();

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
    const totals = { proposed: 0, queued: 0, executed_pause: 0, skipped: 0 };
    const results: any[] = [];

    for (const account of accounts) {
      const accountId = String(account.id);
      const [configs, campaigns, prior] = await Promise.all([
        base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: accountId }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-updated_at', 10000).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-created_at', 30000).catch(() => []),
      ]);
      const holidays = normalizeHolidayDates(configs[0]?.ads_holiday_dates || configs[0]?.holiday_dates || body.holiday_dates);
      const policy = resolveScheduledAdsDaypart(now, holidays);
      const existing = new Set(prior.map((d: any) => String(d.idempotency_key || '')).filter(Boolean));
      const proposed: any[] = [];
      const pauseDecisionIds: string[] = [];

      for (const campaign of campaigns) {
        const campaignId = idOf(campaign);
        if (!campaignId || campaign.archived === true || upper(campaign.campaign_type || 'SP') !== 'SP') continue;
        const automatic = upper(campaign.targeting_type) === 'AUTO';
        const shouldPause = policy.pauseAll || (policy.pauseAutomatic && automatic);
        const pausedByCycle = prior.some((d: any) =>
          d.source_function === SOURCE && String(d.campaign_id || '') === campaignId && d.action === 'pause_campaign' &&
          ['approved', 'executing', 'confirming', 'executed', 'confirmed'].includes(String(d.status || ''))
        );
        const shouldEnable = policy.restoreCampaigns && pausedByCycle;
        if (shouldPause && !active(campaign.state || campaign.status)) continue;
        if (shouldEnable && !paused(campaign.state || campaign.status)) continue;
        if (!shouldPause && !shouldEnable) continue;

        const action = shouldPause ? 'pause_campaign' : 'enable_campaign';
        const key = `${SOURCE}|${accountId}|${policy.windowKey}|${campaignId}|${action}`;
        if (existing.has(key)) { totals.skipped++; continue; }
        proposed.push({ campaignId, action, key, name: campaign.name || campaign.campaign_name || null });
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
            rationale: `${policy.window}: estado programado pelo dayparting canônico`,
            rule_key: `SCHEDULED_DAYPART_${policy.window}`,
            reason_code: `SCHEDULED_DAYPART_${policy.window}`,
            value_before: item.action === 'pause_campaign' ? 'ENABLED' : 'PAUSED',
            value_after: item.action === 'pause_campaign' ? 'PAUSED' : 'ENABLED',
            confidence: 1,
            risk: 'medium',
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
            model_version: 'canonical-campaign-daypart-v2',
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
          const execution = await base44.asServiceRole.functions.invoke('executePauseDecisionSafe', {
            decision_ids: pauseDecisionIds,
            _service_role: true,
          });
          const data = execution?.data || execution || {};
          totals.executed_pause += Number(data.executed || 0);
        }
      }
      results.push({ amazon_account_id: accountId, policy, dry_run: dryRun, proposed: proposed.length, pause_decisions: pauseDecisionIds.length });
    }

    return Response.json({ ok: true, engine: 'canonical-campaign-daypart-v2', totals, results });
  } catch (error: any) {
    return Response.json({ ok: false, engine: 'canonical-campaign-daypart-v2', error: error?.message || 'Falha ao aplicar estado do dayparting' }, { status: 500 });
  }
});
