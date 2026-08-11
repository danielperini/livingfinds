import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { clamp, numberValue, roundMoney } from '../../shared/profitGuardPolicy.ts';

const MAX_ACTIONS_PER_RUN = 150;
const DUE_TOLERANCE_MS = 5 * 60 * 1000;
const OVERDUE_LIMIT_MS = 12 * 60 * 60 * 1000;
const DAYPART_OPERATIONS = new Set([
  'daypart_bid_increase',
  'daypart_bid_decrease',
  'daypart_bid_restore',
  'keyword_bid_update',
  'keyword_bid_restore',
]);

const nowIso = () => new Date().toISOString();
const unwrap = (value: any) => value?.data || value || {};
const remoteId = (value: unknown) => /^\d+$/.test(String(value || '')) ? String(value) : '';

function parsePayload(value: any): any {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
}

async function scheduleRetry(base44: any, action: any, response: any) {
  const attempts = numberValue(action.attempt_count, 0) + 1;
  const maxAttempts = numberValue(action.max_attempts, 3);
  const retryable = response?.retryable || response?.rate_limited || response?.reschedule_async || [429, 500, 502, 503, 504, 524].includes(Number(response?.status));
  if (!retryable || attempts >= maxAttempts) {
    await base44.asServiceRole.entities.AmazonActionQueue.update(action.id, {
      status: 'failed',
      attempt_count: attempts,
      completed_at: nowIso(),
      last_error: String(response?.message || response?.error || response?.errors?.[0]?.message || `Amazon HTTP ${response?.status || 0}`).slice(0, 1000),
      result: JSON.stringify({ status: response?.status, request_id: response?.request_id, errors: response?.errors }).slice(0, 2000),
      updated_at: nowIso(),
    }).catch(() => {});
    return 'failed';
  }
  const retryAfter = Math.max(60, numberValue(response?.retry_after_seconds, 300));
  await base44.asServiceRole.entities.AmazonActionQueue.update(action.id, {
    status: 'pending',
    attempt_count: attempts,
    scheduled_at: new Date(Date.now() + retryAfter * 1000).toISOString(),
    last_error: String(response?.message || response?.error || response?.errors?.[0]?.message || `Amazon HTTP ${response?.status || 0}`).slice(0, 1000),
    result: JSON.stringify({ status: response?.status, request_id: response?.request_id, retry_after_seconds: retryAfter, errors: response?.errors }).slice(0, 2000),
    updated_at: nowIso(),
  }).catch(() => {});
  return 'retrying';
}

async function createRestore(base44: any, params: {
  accountId: string;
  action: any;
  keywordId: string;
  campaignId: string;
  payload: any;
  appliedBid: number;
}) {
  const restoreBid = numberValue(params.payload.restore_bid ?? params.payload.base_bid ?? params.payload.bid_before, 0);
  const restoreAt = params.payload.restore_at;
  if (restoreBid <= 0 || !restoreAt || String(params.action.operation).includes('restore')) return false;
  const restoreKey = `daypart_restore|${params.accountId}|${params.keywordId}|${String(restoreAt).slice(0, 13)}|${roundMoney(restoreBid)}`;
  const existing = await base44.asServiceRole.entities.AmazonActionQueue.filter({
    amazon_account_id: params.accountId,
    idempotency_key: restoreKey,
  }, null, 1).catch(() => []);
  if (existing.length) return false;
  await base44.asServiceRole.entities.AmazonActionQueue.create({
    amazon_account_id: params.accountId,
    operation: 'daypart_bid_restore',
    entity_type: 'keyword',
    entity_id: params.keywordId,
    keyword_id: params.keywordId,
    campaign_id: params.campaignId,
    payload: {
      bid: roundMoney(restoreBid),
      bid_before: roundMoney(params.appliedBid),
      base_bid: roundMoney(restoreBid),
      restore: true,
      source_action_id: params.action.id,
    },
    idempotency_key: restoreKey,
    scheduled_at: restoreAt,
    priority: 'high',
    confidence: numberValue(params.action.confidence, 100),
    status: 'pending',
    source: 'runScheduledBidAdjustments',
    attempt_count: 0,
    max_attempts: 3,
    created_at: nowIso(),
    updated_at: nowIso(),
  }).catch(() => {});
  return true;
}

Deno.serve(async (req) => {
  const startedAt = nowIso();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (!body._service_role) {
      const authenticated = await base44.auth.isAuthenticated().catch(() => false);
      if (!authenticated) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accountRows = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 1);
    const account = accountRows[0];
    if (!account) return Response.json({ ok: true, skipped: true, reason: 'Nenhuma conta conectada' });
    const aid = account.id;

    const [pending, approved, configRows, keywords] = await Promise.all([
      base44.asServiceRole.entities.AmazonActionQueue.filter({ amazon_account_id: aid, status: 'pending' }, 'scheduled_at', 500).catch(() => []),
      base44.asServiceRole.entities.AmazonActionQueue.filter({ amazon_account_id: aid, status: 'approved' }, 'scheduled_at', 500).catch(() => []),
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, '-updated_at', 1).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, null, 10000).catch(() => []),
    ]);
    const config = configRows[0] || {};
    if (config.dayparting_enabled === false) return Response.json({ ok: true, skipped: true, reason: 'Dayparting desabilitado' });
    const minBid = numberValue(config.min_bid, 0.20);
    const maxBid = numberValue(config.max_bid, 5.00);
    const nowMs = Date.now();
    const dueUntil = nowMs + DUE_TOLERANCE_MS;
    const overdueSince = nowMs - OVERDUE_LIMIT_MS;
    const keywordByRemoteId = new Map<string, any>();
    for (const keyword of keywords) {
      for (const id of [keyword.amazon_keyword_id, keyword.keyword_id].filter(Boolean)) {
        keywordByRemoteId.set(String(id), keyword);
      }
    }

    const seen = new Set<string>();
    const actions = [...pending, ...approved]
      .filter((action: any) => DAYPART_OPERATIONS.has(String(action.operation)))
      .filter((action: any) => {
        const scheduled = new Date(action.scheduled_at || 0).getTime();
        return Number.isFinite(scheduled) && scheduled <= dueUntil && scheduled >= overdueSince;
      })
      .filter((action: any) => numberValue(action.attempt_count, 0) < numberValue(action.max_attempts, 3))
      .filter((action: any) => {
        const key = String(action.idempotency_key || action.id || '');
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_ACTIONS_PER_RUN);

    if (!actions.length) {
      return Response.json({ ok: true, skipped: true, reason: 'Sem ações de bid vencidas', due_tolerance_minutes: 5 });
    }

    const stats = { completed: 0, retrying: 0, failed: 0, skipped: 0, restores_created: 0 };
    const results: any[] = [];

    for (const action of actions) {
      const payload = parsePayload(action.payload);
      const keywordId = remoteId(action.keyword_id || action.entity_id);
      const requestedBid = numberValue(payload.bid ?? payload.new_bid ?? payload.scheduled_bid, 0);
      if (!keywordId || requestedBid <= 0) {
        await base44.asServiceRole.entities.AmazonActionQueue.update(action.id, {
          status: 'skipped', completed_at: nowIso(), last_error: 'ID remoto ou bid ausente', updated_at: nowIso(),
        }).catch(() => {});
        stats.skipped++;
        continue;
      }

      const keyword = keywordByRemoteId.get(keywordId);
      const currentBid = numberValue(keyword?.current_bid || keyword?.bid || payload.bid_before, requestedBid);
      const boundedBid = roundMoney(clamp(requestedBid, minBid, maxBid));
      if (Math.abs(boundedBid - currentBid) < 0.005) {
        await base44.asServiceRole.entities.AmazonActionQueue.update(action.id, {
          status: 'completed', completed_at: nowIso(), result: JSON.stringify({ no_change: true, bid: boundedBid }), updated_at: nowIso(),
        }).catch(() => {});
        stats.completed++;
        results.push({ action_id: action.id, keyword_id: keywordId, status: 'no_change', bid: boundedBid });
        continue;
      }

      await base44.asServiceRole.entities.AmazonActionQueue.update(action.id, {
        status: 'running', started_at: nowIso(), updated_at: nowIso(),
      }).catch(() => {});

      const amazon = unwrap(await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        amazon_account_id: aid,
        _service_role: true,
        method: 'PUT',
        path: '/sp/keywords',
        content_type: 'application/vnd.spKeyword.v3+json',
        accept: 'application/vnd.spKeyword.v3+json',
        payload: { keywords: [{ keywordId, bid: boundedBid }] },
        max_attempts: 3,
      }).catch((error: any) => ({ ok: false, error: error.message, retryable: true })));

      if (amazon.ok !== true) {
        const status = await scheduleRetry(base44, action, amazon);
        if (status === 'failed') stats.failed++;
        else stats.retrying++;
        results.push({ action_id: action.id, keyword_id: keywordId, status, amazon_status: amazon.status, error: amazon.message || amazon.error || amazon.errors?.[0]?.message });
        continue;
      }

      const completedAt = nowIso();
      await base44.asServiceRole.entities.AmazonActionQueue.update(action.id, {
        status: 'completed',
        attempt_count: numberValue(action.attempt_count, 0) + 1,
        completed_at: completedAt,
        result: JSON.stringify({ bid: boundedBid, request_id: amazon.request_id, amazon_status: amazon.status }).slice(0, 1000),
        last_error: null,
        updated_at: completedAt,
      }).catch(() => {});
      if (keyword?.id) {
        await base44.asServiceRole.entities.Keyword.update(keyword.id, {
          current_bid: boundedBid,
          bid: boundedBid,
          last_bid_change_at: completedAt,
          synced_at: completedAt,
        }).catch(() => {});
      }
      await base44.asServiceRole.entities.AdsBidChangeLog.create({
        amazon_account_id: aid,
        keyword_id: keywordId,
        campaign_id: action.campaign_id || payload.campaign_id || keyword?.campaign_id || '',
        keyword: keyword?.keyword_text || keyword?.keyword || payload.keyword_text || payload.keyword || '',
        asin: action.asin || payload.asin || keyword?.asin || '',
        old_bid: currentBid,
        new_bid: boundedBid,
        change_pct: currentBid > 0 ? roundMoney((boundedBid - currentBid) / currentBid * 100) : 0,
        reason: action.operation,
        block_name: payload.block || payload.hour_block || '',
        classification: payload.classification || '',
        source: 'runScheduledBidAdjustments',
        status: 'executed',
        created_at: completedAt,
      }).catch(() => {});

      const restoreCreated = await createRestore(base44, {
        accountId: aid,
        action,
        keywordId,
        campaignId: String(action.campaign_id || keyword?.campaign_id || ''),
        payload,
        appliedBid: boundedBid,
      });
      if (restoreCreated) stats.restores_created++;
      stats.completed++;
      results.push({ action_id: action.id, keyword_id: keywordId, status: 'completed', bid_before: currentBid, bid_after: boundedBid });
    }

    return Response.json({
      ok: true,
      policy: { execute_only_due_actions: true, due_tolerance_minutes: 5, overdue_limit_hours: 12, centralized_amazon_gateway: true, multi_status_item_validation: true },
      actions_found: actions.length,
      stats,
      results,
      started_at: startedAt,
      completed_at: nowIso(),
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha nas alterações programadas de bid' }, { status: 500 });
  }
});
