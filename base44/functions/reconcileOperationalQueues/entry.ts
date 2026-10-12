import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { productAdsEligibility } from '../../shared/productAdsEligibility.ts';
import { classifyV6SIAFailure, sanitizeV6SIAError } from '../../shared/v6siaFailurePolicy.ts';

const RETRYABLE_ERROR = /(\b429\b|rate.?limit|throttl|timeout|timed.?out|network|temporar|\b502\b|\b503\b|\b504\b|\b524\b|connection reset|circuit.?open)/i;
const MAX_ROWS_PER_QUEUE = 1000;
const STALE_PROCESSING_MINUTES = 90;
const STALE_SCHEDULED_HOURS = 24;

function errorText(item: any) { return String(item?.last_error || item?.error_code || '').trim(); }
function norm(value: any) { return String(value || '').trim().toLowerCase(); }
function ageMs(value: any) {
  const time = new Date(String(value || '')).getTime();
  return Number.isFinite(time) ? Math.max(0, Date.now() - time) : Number.POSITIVE_INFINITY;
}
function canRetry(item: any) {
  const attempts = Number(item?.attempt_count || 0);
  const maxAttempts = Math.max(1, Number(item?.max_attempts || 5));
  return attempts < maxAttempts && (item?.retryable === true || RETRYABLE_ERROR.test(errorText(item)));
}
function retryAt(item: any) {
  const attempts = Math.max(0, Number(item?.attempt_count || 0));
  const delayMinutes = Math.min(120, 5 * (2 ** Math.min(attempts, 4)));
  return new Date(Date.now() + delayMinutes * 60_000).toISOString();
}
function isScopeBlocked(product: any) {
  return ['not_authorized', 'manual_block', 'mapping_conflict'].includes(norm(product?.ads_scope_status));
}
function productKey(accountId: string, asin: string) { return `${accountId}|${String(asin || '').trim().toUpperCase()}`; }
function campaignKey(accountId: string, campaignId: any) { return `${accountId}|${String(campaignId || '').trim()}`; }
function isCampaignInactive(campaign: any) {
  const state = norm(campaign?.state || campaign?.status);
  return ['paused', 'archived', 'deleted', 'inactive', 'ended'].includes(state);
}
function queueTimestamp(item: any) {
  return item?.updated_at || item?.updated_date || item?.started_at || item?.scheduled_at || item?.created_at || item?.created_date || null;
}
function staleQueueReason(item: any) {
  const status = norm(item?.status);
  const age = ageMs(queueTimestamp(item));
  if (status === 'processing' && age >= STALE_PROCESSING_MINUTES * 60_000) return 'stale_processing';
  if (status === 'scheduled' && age >= STALE_SCHEDULED_HOURS * 60 * 60_000) return 'stale_scheduled';
  return null;
}

async function productsForAccount(base44: any, accountId: string) {
  const rows = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, '-updated_at', 1000).catch(() => []);
  return new Map<string, any>(rows.map((product: any) => [productKey(accountId, product.asin), product]));
}
async function campaignsForAccount(base44: any, accountId: string) {
  const rows = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []);
  return new Map<string, any>(rows.map((campaign: any) => [campaignKey(accountId, campaign.campaign_id || campaign.amazon_campaign_id || campaign.id), campaign]));
}

async function reconcileAccount(base44: any, accountId: string, dryRun: boolean) {
  const [products, campaigns] = await Promise.all([productsForAccount(base44, accountId), campaignsForAccount(base44, accountId)]);
  const statuses = ['failed', 'scheduled', 'processing'];
  const load = async (entity: string) => {
    const groups = await Promise.all(statuses.map(status => base44.asServiceRole.entities[entity].filter({ amazon_account_id: accountId, status }, '-updated_at', MAX_ROWS_PER_QUEUE).catch(() => [])));
    const unique = new Map<string, any>();
    for (const row of groups.flat()) if (row?.id) unique.set(String(row.id), row);
    return [...unique.values()];
  };
  const [kickoff, autoRepair, keywordRepair] = await Promise.all([
    load('ProductKickoffQueue'), load('AutoCampaignRepairQueue'), load('KeywordRepairQueue'),
  ]);

  const result = { scanned: kickoff.length + autoRepair.length + keywordRepair.length, retried: 0, waiting_stock: 0, cancelled_scope: 0, cancelled_inactive_campaign: 0, stale_recovered: 0, terminal: 0, untouched: 0, failure_evidence: [] as any[], proposed: [] as any[] };
  const apply = async (entity: string, id: string, action: string, patch: Record<string, unknown>) => {
    result.proposed.push({ entity, id, action });
    if (!dryRun) await base44.asServiceRole.entities[entity].update(id, patch).catch(() => {});
  };

  const reconcile = async (entity: string, item: any) => {
    const now = new Date().toISOString();
    const product = products.get(productKey(accountId, item.asin));
    const campaignId = item.campaign_id || item.amazon_campaign_id;
    const campaign = campaignId ? campaigns.get(campaignKey(accountId, campaignId)) : null;

    if (campaign && isCampaignInactive(campaign)) {
      result.cancelled_inactive_campaign++;
      await apply(entity, item.id, 'cancelled_inactive_campaign', {
        status: 'cancelled', retryable: false, scheduled_at: null, completed_at: now,
        error_code: 'campaign_inactive_queue_cleaned',
        last_error: `Fila encerrada: campanha ${campaignId} está ${norm(campaign.state || campaign.status)} e não deve voltar ao ciclo operacional.`,
      });
      return;
    }

    if (!product) {
      if (staleQueueReason(item)) {
        result.terminal++;
        await apply(entity, item.id, 'cancelled_missing_product', {
          status: 'cancelled', retryable: false, scheduled_at: null, completed_at: now,
          error_code: 'product_missing_queue_cleaned', last_error: 'Fila obsoleta encerrada: produto canônico não encontrado.',
        });
      } else result.untouched++;
      return;
    }

    const eligibility = productAdsEligibility(product);
    if (!eligibility.inStock) {
      result.waiting_stock++;
      await apply(entity, item.id, 'waiting_stock', {
        status: 'waiting_stock', retryable: true, scheduled_at: null, completed_at: null,
        error_code: 'waiting_stock_reconciled', last_error: `Aguardando estoque confirmado (${eligibility.reason}); sem mutação Amazon.`,
      });
      return;
    }
    if (isScopeBlocked(product)) {
      result.cancelled_scope++;
      await apply(entity, item.id, 'cancelled_scope', {
        status: 'cancelled', retryable: false, scheduled_at: null, completed_at: now,
        error_code: 'ads_scope_not_authorized', last_error: `Fila encerrada pelo escopo autorizado (${product?.ads_scope_status}).`,
      });
      return;
    }
    if (!eligibility.eligible) {
      result.cancelled_scope++;
      await apply(entity, item.id, 'cancelled_eligibility_guard', {
        status: 'cancelled', retryable: false, scheduled_at: null, completed_at: now,
        error_code: 'ads_product_not_eligible', last_error: `Fila encerrada pela elegibilidade canônica do produto (${eligibility.reason}).`,
      });
      return;
    }

    const staleReason = staleQueueReason(item);
    if (staleReason) {
      const attempts = Number(item?.attempt_count || 0);
      const maxAttempts = Math.max(1, Number(item?.max_attempts || 5));
      if (attempts < maxAttempts) {
        result.stale_recovered++;
        await apply(entity, item.id, 'stale_requeued', {
          status: 'scheduled', retryable: true, scheduled_at: retryAt(item), started_at: null, completed_at: null,
          error_code: `${staleReason}_requeued`, last_error: `Fila ${staleReason} recuperada automaticamente; nova tentativa agendada.`,
        });
      } else {
        result.terminal++;
        await apply(entity, item.id, 'stale_cancelled_max_attempts', {
          status: 'cancelled', retryable: false, scheduled_at: null, completed_at: now,
          error_code: `${staleReason}_max_attempts`, last_error: `Fila ${staleReason} encerrada após atingir ${maxAttempts} tentativas.`,
        });
      }
      return;
    }

    if (norm(item.status) === 'failed' && canRetry(item)) {
      result.retried++;
      await apply(entity, item.id, 'retry_scheduled', {
        status: 'scheduled', retryable: true, scheduled_at: retryAt(item), completed_at: null,
        error_code: 'retry_scheduled_reconciled', last_error: `Retry automático agendado após erro transitório: ${errorText(item).slice(0, 320)}`,
      });
      return;
    }
    if (norm(item.status) === 'failed') {
      result.terminal++;
      if (ageMs(queueTimestamp(item)) <= 24 * 60 * 60_000 && result.failure_evidence.length < 30) {
        const error = sanitizeV6SIAError(errorText(item) || 'Falha sem mensagem registrada');
        result.failure_evidence.push({
          queue_id: String(item.id),
          queue_entity: entity,
          action: String(item.action || item.operation || entity),
          error_class: classifyV6SIAFailure(error),
          error,
          error_code: String(item.error_code || '').slice(0, 120),
          asin: String(item.asin || '').slice(0, 20),
          sku: String(item.sku || '').slice(0, 80),
          campaign_id: String(item.campaign_id || item.amazon_campaign_id || '').slice(0, 64),
          attempt_count: Number(item.attempt_count || 0),
          max_attempts: Number(item.max_attempts || 5),
          last_attempt_at: item.updated_at || item.updated_date || item.completed_at || null,
        });
      }
    }
    else result.untouched++;
  };

  for (const item of kickoff) await reconcile('ProductKickoffQueue', item);
  for (const item of autoRepair) await reconcile('AutoCampaignRepairQueue', item);
  for (const item of keywordRepair) await reconcile('KeywordRepairQueue', item);
  return result;
}

async function superviseRecentQueueFailures(base44: any, accountId: string, failures: any[]) {
  if (!failures.length) return { skipped: true, reason: 'no_recent_terminal_failures' };
  const fingerprintSource = failures
    .map((item) => [item.queue_entity, item.queue_id, item.error_class, item.error_code, item.error, item.attempt_count, item.max_attempts].join('|'))
    .sort()
    .join('\n');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fingerprintSource));
  const fingerprint = Array.from(new Uint8Array(digest)).slice(0, 16).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const correlationId = `queue-failure-${fingerprint}`;
  const existing = await base44.asServiceRole.entities.V6SIAReviewLog.filter({
    amazon_account_id: accountId,
    correlation_id: correlationId,
  }, '-created_at', 1).catch(() => []);
  if (existing.length) return { skipped: true, reason: 'failure_fingerprint_already_reviewed', report_id: existing[0].id || null };

  const response = await base44.asServiceRole.functions.invoke('superviseV6SIA', {
    amazon_account_id: accountId,
    _service_role: true,
    supervision_type: 'execution_failure',
    trigger_type: 'operational_queue_terminal_failure',
    correlation_id: correlationId,
    failures,
  }).catch((error: any) => ({ data: { ok: false, status: 'error', error: sanitizeV6SIAError(error) } }));
  const data = response?.data || response || {};
  return {
    skipped: false,
    status: data.status || (data.ok ? 'success' : 'error'),
    report_id: data.report_id || null,
    data_quality_status: data.data_quality_status || null,
    reason: data.reason ? sanitizeV6SIAError(data.reason) : data.error ? sanitizeV6SIAError(data.error) : null,
    action: 'diagnosis_only_no_queue_or_amazon_mutation',
  };
}

Deno.serve(async (request) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });
    const dryRun = body.dry_run === true;
    const accounts = body.amazon_account_id ? [{ id: body.amazon_account_id }] : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 100).catch(() => []);
    const totals = { scanned: 0, retried: 0, waiting_stock: 0, cancelled_scope: 0, cancelled_inactive_campaign: 0, stale_recovered: 0, terminal: 0, untouched: 0 };
    const byAccount: any[] = [];
    for (const account of accounts) {
      const reconciliation = await reconcileAccount(base44, account.id, dryRun);
      const aiSupervision = dryRun
        ? { skipped: true, reason: 'dry_run' }
        : await superviseRecentQueueFailures(base44, account.id, reconciliation.failure_evidence);
      byAccount.push({ amazon_account_id: account.id, ...reconciliation });
      byAccount[byAccount.length - 1].ai_supervision = aiSupervision;
      for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += reconciliation[key];
      if (!dryRun) await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: account.id, operation: 'reconcile_operational_queues', trigger_type: body.trigger_type || 'scheduler',
        status: reconciliation.terminal ? 'warning' : 'success', started_at: new Date(startedAt).toISOString(), completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt, records_processed: reconciliation.scanned,
        result_summary: `retry=${reconciliation.retried}; stale_recuperada=${reconciliation.stale_recovered}; aguardando_estoque=${reconciliation.waiting_stock}; escopo=${reconciliation.cancelled_scope}; campanha_inativa=${reconciliation.cancelled_inactive_campaign}; terminais=${reconciliation.terminal}; intactas=${reconciliation.untouched}`,
      }).catch(() => {});
    }

    const historyPrune = body.skip_history_prune === true
      ? { ok: true, skipped: true }
      : await base44.asServiceRole.functions.invoke('pruneMotorDecisionHistory', {
          amazon_account_id: body.amazon_account_id || null,
          _service_role: true,
          dry_run: dryRun,
          max_delete: body.max_history_delete || 1000,
          trigger_type: body.trigger_type || 'operational_queue_reconciliation',
        }).then((r: any) => r?.data || r).catch((error: any) => ({ ok: false, error: error?.message || String(error) }));

    return Response.json({
      ok: historyPrune?.ok !== false,
      dry_run: dryRun,
      totals,
      accounts: byAccount,
      history_prune: historyPrune,
      policy: { stale_processing_minutes: STALE_PROCESSING_MINUTES, stale_scheduled_hours: STALE_SCHEDULED_HOURS, motor_history: 'preserve open or effective decisions for active products only' },
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});
