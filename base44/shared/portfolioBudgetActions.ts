import { amazonCampaignId, norm } from './portfolioBudgetMath.ts';

function commandOk(response: any) {
  const data = response?.data || response || {};
  if (data?.conflict_existing === true) return true;
  if (data?.ok === false) return false;
  if (data?.ok === true && Number(data?.status || 200) !== 207) return true;
  const success = data?.payload?.campaigns?.success || data?.payload?.success || [];
  return Array.isArray(success) && success.length > 0;
}

function requestId(response: any) {
  const data = response?.data || response || {};
  return String(data?.request_id || data?.amazon_request_id || '');
}

export async function writePacingAudit(base44: any, data: any) {
  await base44.asServiceRole.entities.OptimizationDecision.create({
    amazon_account_id: data.accountId,
    decision_type: data.decisionType,
    entity_type: data.entityType || 'campaign',
    entity_id: data.campaignId || 'account',
    campaign_id: data.campaignId || 'account',
    asin: data.asin || null,
    action: data.action,
    rationale: data.reason,
    current_value: typeof data.before === 'number' ? data.before : null,
    proposed_value: typeof data.after === 'number' ? data.after : null,
    value_before: typeof data.before === 'number' ? data.before : null,
    value_after: typeof data.after === 'number' ? data.after : null,
    risk: data.risk || 'low',
    requires_approval: false,
    approval_status: 'auto_approved',
    status: data.status || 'executed',
    queue_status: data.status === 'failed' ? 'failed' : 'completed',
    idempotency_key: data.idempotencyKey,
    source_function: 'runIntraDayBudgetPacingCycle',
    executed_at: data.status === 'failed' ? null : data.now,
    amazon_request_id: data.amazonRequestId || null,
    created_at: data.now,
    updated_at: data.now,
  }).catch(() => {});
}

async function alreadyExecuted(base44: any, accountId: string, key: string) {
  const rows = await base44.asServiceRole.entities.OptimizationDecision.filter(
    { amazon_account_id: accountId, idempotency_key: key }, '-created_at', 5,
  ).catch(() => []);
  return rows.some((row: any) => ['approved', 'executing', 'executed'].includes(norm(row?.status)));
}

export async function setCampaignState(base44: any, params: {
  accountId: string;
  profile: any;
  state: 'PAUSED' | 'ENABLED';
  reason: string;
  date: string;
  now: string;
  dryRun: boolean;
  resumeAfter?: string | null;
  windowKey?: string | null;
}) {
  const { accountId, profile, state, reason, date, now, dryRun, resumeAfter = null, windowKey = null } = params;
  const campaignId = amazonCampaignId(profile.campaign);
  const action = state === 'PAUSED' ? 'pause_campaign' : 'resume_campaign';
  const reasonCode = reason.split(':')[0];
  const key = `${accountId}|portfolio_pacing|${action}|${campaignId}|${date}|${windowKey || 'daily'}|${reasonCode}`;
  if (!campaignId || await alreadyExecuted(base44, accountId, key)) {
    return { ok: false, skipped: true, campaign_id: campaignId, reason: 'idempotent_or_missing_id' };
  }
  if (dryRun) return { ok: true, dry_run: true, campaign_id: campaignId, action, reason };

  const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
    amazon_account_id: accountId,
    operation: state === 'PAUSED' ? 'portfolio_pacing_pause' : 'portfolio_pacing_resume',
    method: 'PUT',
    path: '/sp/campaigns',
    content_type: 'application/vnd.spCampaign.v3+json',
    accept: 'application/vnd.spCampaign.v3+json',
    payload: { campaigns: [{ campaignId, state }] },
    max_attempts: 3,
    trigger_type: 'automatic',
    _service_role: true,
  }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));

  const ok = commandOk(response);
  const amazonRequestId = requestId(response);
  if (ok) {
    const patch = state === 'PAUSED'
      ? {
          state: 'paused', status: 'paused', original_state: profile.campaign?.original_state || 'enabled',
          archive_reason: reason, pacing_pause_reason: reason, pacing_paused_at: now,
          pacing_pause_date: date, pacing_resume_after: resumeAfter, last_activity_at: now,
        }
      : {
          state: 'enabled', status: 'enabled', archive_reason: null, pacing_pause_reason: null,
          pacing_paused_at: null, pacing_pause_date: null, pacing_resume_after: null, last_activity_at: now,
        };
    await base44.asServiceRole.entities.Campaign.update(profile.campaign.id, patch).catch(() => {});
  }

  await writePacingAudit(base44, {
    accountId,
    decisionType: state === 'PAUSED' ? 'portfolio_pacing_pause' : 'portfolio_pacing_resume',
    campaignId,
    asin: profile.asin,
    action,
    reason,
    risk: state === 'PAUSED' && profile.protected ? 'high' : 'low',
    idempotencyKey: key,
    amazonRequestId,
    status: ok ? 'executed' : 'failed',
    now,
  });

  return {
    ok, campaign_id: campaignId, asin: profile.asin, action, reason,
    request_id: amazonRequestId || null,
    error: ok ? null : String((response?.data || response || {})?.error || 'Amazon não confirmou a alteração'),
  };
}

export async function upsertDailyController(base44: any, params: {
  accountId: string;
  marketplaceId: string | null;
  date: string;
  cap: number;
  capSource: string;
  timezone: string;
  now: string;
  dryRun: boolean;
}) {
  const { accountId, marketplaceId, date, cap, capSource, timezone, now, dryRun } = params;
  const rows = await base44.asServiceRole.entities.AccountDailySpendController.filter(
    { amazon_account_id: accountId, spend_date: date }, '-updated_at', 2,
  ).catch(() => []);
  const current = rows[0] || null;
  if (dryRun) return current || {
    id: null, amazon_account_id: accountId, spend_date: date,
    user_daily_spend_cap: cap, effective_daily_spend_cap: cap,
    campaigns_paused_today: [], global_kill_switch: false,
  };
  if (current) {
    const patch = {
      marketplace_id: marketplaceId || current.marketplace_id || null,
      timezone, user_daily_spend_cap: cap, effective_daily_spend_cap: cap,
      daily_cap_source: capSource, updated_at: now,
    };
    await base44.asServiceRole.entities.AccountDailySpendController.update(current.id, patch).catch(() => {});
    return { ...current, ...patch };
  }
  return await base44.asServiceRole.entities.AccountDailySpendController.create({
    amazon_account_id: accountId, marketplace_id: marketplaceId, spend_date: date, timezone,
    user_daily_spend_cap: cap, effective_daily_spend_cap: cap, daily_cap_source: capSource,
    confirmed_spend: 0, estimated_pending_spend: 0, projected_total_spend: 0,
    remaining_spend: cap, cap_status: 'safe', spend_pacing: 'unknown', pacing_ratio: 0,
    global_kill_switch: false, campaigns_paused_today: [], created_at: now, updated_at: now,
  });
}

export function controllerLockActive(controller: any, runId: string) {
  const until = new Date(controller?.pacing_lock_until || 0).getTime();
  return Number.isFinite(until) && until > Date.now() && String(controller?.pacing_run_id || '') !== runId;
}

export async function acquireControllerLock(base44: any, controller: any, runId: string, now: string) {
  const lockUntil = new Date(Date.now() + 20 * 60_000).toISOString();
  await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
    pacing_run_id: runId, pacing_lock_until: lockUntil,
    last_pacing_engine_run_at: now, updated_at: now,
  });
}

export async function releaseControllerLock(base44: any, controller: any) {
  const now = new Date().toISOString();
  await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
    pacing_lock_until: now, updated_at: now,
  }).catch(() => {});
}

export function capStatus(utilization: number) {
  if (utilization >= 1) return 'cap_reached';
  if (utilization >= 0.95) return 'cap_imminent';
  if (utilization >= 0.85) return 'critical';
  if (utilization >= 0.70) return 'attention';
  return 'safe';
}

export function nextDayAt(hour: number) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const next = new Date(`${date}T${String(hour).padStart(2, '0')}:05:00-03:00`);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}
