import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import {
  normalizeHolidayDates,
  resolveScheduledAdsDaypart,
  targetBidFromBaseline,
} from '../../shared/scheduledAdsDaypartPolicy.ts';

const SOURCE = 'queueScheduledAdsDaypartTest';
const active = (value: unknown) => ['enabled', 'active'].includes(String(value || '').toLowerCase());
const paused = (value: unknown) => String(value || '').toLowerCase() === 'paused';
const upper = (value: unknown) => String(value || '').trim().toUpperCase();
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

function decisionKey(accountId: string, windowKey: string, entityType: string, entityId: string, action: string) {
  return `${SOURCE}|${accountId}|${windowKey}|${entityType}|${entityId}|${action}`;
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 50);
    if (!accounts.length) return Response.json({ ok: true, skipped: true, reason: 'Nenhuma conta conectada' });

    const now = body.now ? new Date(body.now) : new Date();
    if (!Number.isFinite(now.getTime())) return Response.json({ ok: false, error: 'Data de teste inválida' }, { status: 400 });
    const results: any[] = [];

    for (const account of accounts) {
      const accountId = String(account.id);
      const [performanceRows, configRows, campaigns, keywords, prior] = await Promise.all([
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: accountId }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-updated_at', 10000).catch(() => []),
        base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-updated_at', 30000).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-created_at', 30000).catch(() => []),
      ]);
      const settings = { ...(configRows[0] || {}), ...(performanceRows[0] || {}) };
      const holidays = normalizeHolidayDates(settings.ads_holiday_dates || settings.holiday_dates || body.holiday_dates);
      const policy = resolveScheduledAdsDaypart(now, holidays);

      // Esta função é deliberadamente teste-first. Somente uma combinação explícita
      // de feature flag + chamada canônica pode criar decisões na fila.
      const canonical = body._canonical_orchestrator === 'runUnifiedDecisionEngine';
      const liveEnabled = settings.scheduled_daypart_test_live === true && body.enable_live_test === true && canonical;
      const dryRun = body.dry_run !== false || !liveEnabled;
      const protectedCampaignIds = new Set(campaigns.filter((campaign: any) =>
        campaign.protected_high_performance === true || finite(campaign.orders) > 0 && finite(campaign.sales) > 0
      ).map(campaignIdOf));
      const existingKeys = new Set(prior.map((row: any) => String(row.idempotency_key || '')).filter(Boolean));
      const proposed: any[] = [];
      const queued: any[] = [];
      const blocked: any[] = [];

      const campaignById = new Map(campaigns.map((campaign: any) => [campaignIdOf(campaign), campaign]));
      for (const campaign of campaigns) {
        const campaignId = campaignIdOf(campaign);
        if (!campaignId || upper(campaign.campaign_type || 'SP') !== 'SP' || campaign.archived === true) continue;
        const isAuto = upper(campaign.targeting_type) === 'AUTO';
        const mustPause = policy.pauseAll || policy.pauseAutomatic && isAuto;
        const wasPausedByCycle = prior.some((row: any) =>
          row.source_function === SOURCE && String(row.campaign_id || '') === campaignId &&
          row.action === 'pause_campaign' && ['approved', 'executing', 'confirming', 'executed', 'confirmed'].includes(String(row.status || ''))
        );
        const mustEnable = policy.restoreCampaigns && wasPausedByCycle;
        if (!mustPause && !mustEnable) continue;
        if (protectedCampaignIds.has(campaignId)) {
          blocked.push({ campaign_id: campaignId, action: mustPause ? 'pause_campaign' : 'enable_campaign', reason: 'PROTECTED_WINNER' });
          continue;
        }
        if (mustPause && !active(campaign.state || campaign.status)) continue;
        if (mustEnable && !paused(campaign.state || campaign.status)) continue;
        const action = mustPause ? 'pause_campaign' : 'enable_campaign';
        const key = decisionKey(accountId, policy.windowKey, 'campaign', campaignId, action);
        if (existingKeys.has(key)) continue;
        proposed.push({
          idempotency_key: key, entity_type: 'campaign', entity_id: campaignId,
          campaign_id: campaignId, campaign_name: campaign.name || campaign.campaign_name,
          action, value_before: mustPause ? 'ENABLED' : 'PAUSED', value_after: mustPause ? 'PAUSED' : 'ENABLED',
          reason: `${policy.window}: ciclo de dayparting programado em modo de teste`,
        });
      }

      for (const keyword of keywords) {
        if (!active(keyword.state || keyword.status)) continue;
        const campaignId = String(keyword.campaign_id || '');
        const campaign = campaignById.get(campaignId);
        if (!campaign || protectedCampaignIds.has(campaignId)) {
          if (campaign) blocked.push({ campaign_id: campaignId, keyword_id: keyword.keyword_id || keyword.id, action: 'set_bid', reason: 'PROTECTED_WINNER' });
          continue;
        }
        const entityId = String(keyword.keyword_id || keyword.id || '');
        const baselineBid = baselineFor(keyword, prior);
        const currentBid = finite(keyword.bid ?? keyword.current_bid);
        const targetBid = targetBidFromBaseline(baselineBid, policy.bidMultiplier, finite(settings.min_bid, 0.02));
        if (!entityId || baselineBid <= 0 || targetBid <= 0 || Math.abs(targetBid - currentBid) < 0.005) continue;
        const key = decisionKey(accountId, policy.windowKey, 'keyword', entityId, 'set_bid');
        if (existingKeys.has(key)) continue;
        proposed.push({
          idempotency_key: key, entity_type: 'keyword', entity_id: entityId, keyword_id: entityId,
          campaign_id: campaignId, ad_group_id: keyword.ad_group_id || null,
          entity_name: keyword.keyword_text || keyword.keyword,
          action: 'set_bid', value_before: currentBid, value_after: targetBid,
          reason: `${policy.window}: bid ${(policy.bidMultiplier * 100).toFixed(0)}% do baseline`,
          evidence: { baseline_bid: baselineBid, multiplier: policy.bidMultiplier, window: policy.window },
        });
      }

      if (!dryRun) {
        for (const proposal of proposed) {
          const decision = await base44.asServiceRole.entities.OptimizationDecision.create({
            amazon_account_id: accountId,
            decision_type: 'scheduled_ads_daypart_test',
            entity_type: proposal.entity_type,
            entity_id: proposal.entity_id,
            entity_name: proposal.entity_name || proposal.campaign_name || null,
            campaign_id: proposal.campaign_id,
            campaign_name: proposal.campaign_name || null,
            ad_group_id: proposal.ad_group_id || null,
            keyword_id: proposal.keyword_id || null,
            action: proposal.action,
            canonical_action_type: proposal.action === 'set_bid' ? 'BID_CHANGE' : 'CAMPAIGN_STATE_CHANGE',
            rationale: proposal.reason,
            rule_key: `SCHEDULED_DAYPART_${policy.window}`,
            reason_code: `SCHEDULED_DAYPART_${policy.window}`,
            value_before: proposal.value_before,
            value_after: proposal.value_after,
            current_value: proposal.value_before,
            proposed_value: proposal.value_after,
            confidence: 1,
            risk: proposal.action === 'pause_campaign' ? 'high' : 'medium',
            requires_approval: false,
            approval_status: 'auto_approved_test',
            status: 'approved',
            queue_status: 'pending',
            execution_mode: proposal.action.includes('campaign') ? 'SCHEDULED_WINDOW' : 'STANDARD_QUEUE',
            confirmation_required: true,
            confirmation_status: 'pending',
            idempotency_key: proposal.idempotency_key,
            conflict_group: `${accountId}|${proposal.entity_type}|${proposal.entity_id}`,
            data_used: JSON.stringify(proposal.evidence || { window: policy.window }),
            rollback_plan: JSON.stringify({ action: proposal.action === 'pause_campaign' ? 'enable_campaign' : proposal.action === 'enable_campaign' ? 'pause_campaign' : 'set_bid', value: proposal.value_before }),
            source_function: SOURCE,
            model_version: 'scheduled-ads-daypart-test-v1',
            not_before: now.toISOString(),
            execute_before: new Date(now.getTime() + 45 * 60_000).toISOString(),
            max_attempts: 3,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          queued.push({ ...proposal, decision_id: decision.id });
        }
      }

      results.push({
        amazon_account_id: accountId,
        dry_run: dryRun,
        live_feature_enabled: liveEnabled,
        policy,
        holiday_dates_loaded: holidays.size,
        proposed,
        queued,
        blocked,
        limitation: 'Bids de product targets/ad groups automáticos permanecem fora da fila até existir executor canônico confirmado; campanhas AUTO são controladas por estado nas janelas úteis.',
      });
    }

    return Response.json({
      ok: true,
      engine: 'scheduled-ads-daypart-test-v1',
      dry_run: results.every((row) => row.dry_run),
      accounts: results,
      totals: {
        proposed: results.reduce((sum, row) => sum + row.proposed.length, 0),
        queued: results.reduce((sum, row) => sum + row.queued.length, 0),
        blocked: results.reduce((sum, row) => sum + row.blocked.length, 0),
      },
    });
  } catch (error: any) {
    return Response.json({ ok: false, engine: 'scheduled-ads-daypart-test-v1', error: error?.message || 'Falha no dayparting de teste' }, { status: 500 });
  }
});
