import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { campaignCoverageEligible, campaignCoverageAsin, campaignCoverageProductEligible } from '../../shared/campaignCoverageEligibility.ts';
import { availableAdsStock, hasFreshAdsInventory } from '../../shared/stockAdsPolicy.ts';
import { createAuditOutcome } from '../../shared/auditOutcome.ts';

const MINUTE = 60_000;
const isEnabled = (row: any) => ['enabled', 'active'].includes(String(row?.state || row?.status || '').toLowerCase());
const ageMinutes = (value: string | undefined | null) => value ? Math.max(0, (Date.now() - new Date(value).getTime()) / MINUTE) : Number.POSITIVE_INFINITY;
const safeError = (value: unknown) => String((value as Error)?.message || value || 'source_read_failed')
  .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  .replace(/Atza\|[^\s]+/gi, '[redacted]')
  .replace(/(?:token|secret|password|authorization)\s*[:=]\s*[^,\s"]+/gi, '[redacted]')
  .replace(/[\r\n\t]+/g, ' ').slice(0, 500);

function latest(rows: any[], ...fields: string[]) {
  return rows.reduce((best, row) => {
    const at = fields.map((field) => row?.[field]).find(Boolean);
    const bestAt = fields.map((field) => best?.[field]).find(Boolean);
    return !best || new Date(at || 0).getTime() > new Date(bestAt || 0).getTime() ? row : best;
  }, null as any);
}

Deno.serve(async (request) => {
  let correlationId: string = crypto.randomUUID();
  const sourceErrors: Array<{ source: string; amazon_account_id?: string; error: string }> = [];
  try {
  const base44 = createClientFromRequest(request);
  const body = await request.json().catch(() => ({}));
  correlationId = String(body.correlation_id || '').trim() || correlationId;
  const read = async (source: string, operation: () => Promise<any[]>, amazonAccountId?: string) => {
    try {
      const rows = await operation();
      if (!Array.isArray(rows)) throw new Error('invalid_source_response');
      return rows;
    } catch (error) {
      sourceErrors.push({ source, ...(amazonAccountId ? { amazon_account_id: amazonAccountId } : {}), error: safeError(error) });
      return [];
    }
  };
  const authenticated = await base44.auth.isAuthenticated().catch(() => false);
  if (!authenticated && !body._service_role) {
    const outcome = createAuditOutcome({ correlationId, technicalFailure: true, technicalStatus: 'authentication_error',
      sourceErrors: [{ source: 'authentication', error: 'Não autorizado' }] });
    return Response.json({ ...outcome, error: 'Não autorizado', reports: [] }, { status: 401 });
  }

  const accounts = await read('AmazonAccount', () => body.amazon_account_id
    ? base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1)
    : base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, undefined, 20));
  const reports: any[] = [];
  const partialReasons: string[] = [];
  if (accounts.length === 0 && sourceErrors.length === 0) partialReasons.push('no_connected_accounts');

  for (const account of accounts) {
    const accountId = account.id;
    const [campaigns, products, keywords, decisions, queue, logs] = await Promise.all([
      read('Campaign', () => base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-updated_at', 2000), accountId),
      read('Product', () => base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, '-updated_at', 2000), accountId),
      read('Keyword', () => base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-updated_at', 3000), accountId),
      read('OptimizationDecision', () => base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-created_at', 1000), accountId),
      read('AmazonActionQueue', () => base44.asServiceRole.entities.AmazonActionQueue.filter({ amazon_account_id: accountId }, '-created_at', 1000), accountId),
      read('SyncExecutionLog', () => base44.asServiceRole.entities.SyncExecutionLog.filter({ amazon_account_id: accountId }, '-started_at', 500), accountId),
    ]);
    for (const [source, rows, limit] of [['Campaign', campaigns, 2000], ['Product', products, 2000], ['Keyword', keywords, 3000],
      ['OptimizationDecision', decisions, 1000], ['AmazonActionQueue', queue, 1000], ['SyncExecutionLog', logs, 500]] as const) {
      if (rows.length >= limit) partialReasons.push(`${accountId}:${source}_limit_reached`);
    }
    const active = campaigns.filter(isEnabled);
    const autos = active.filter((c: any) => String(c.amazon_targeting_type || c.targeting_type || '').toUpperCase() === 'AUTO');
    const manuals = active.filter((c: any) => String(c.amazon_targeting_type || c.targeting_type || '').toUpperCase() === 'MANUAL');
    const activeKeywords = keywords.filter(isEnabled);
    const validActivationProducts = products.filter(campaignCoverageProductEligible);
    const inventoryUnknownAsins = [...new Set(validActivationProducts.filter((product: any) => availableAdsStock(product) < 0)
      .map((product: any) => String(product.asin).trim().toUpperCase()))];
    const coverageCandidates = validActivationProducts.filter(campaignCoverageEligible);
    const staleInventoryAsins = [...new Set(coverageCandidates.filter((product: any) => !hasFreshAdsInventory(product))
      .map((product: any) => String(product.asin).trim().toUpperCase()))];
    const eligibleAsins = [...new Set(coverageCandidates.filter((product: any) => hasFreshAdsInventory(product))
      .map((product: any) => String(product.asin).trim().toUpperCase()))];
    const autoAsins = new Set(autos.map(campaignCoverageAsin).filter(Boolean));
    const missingAutoAsins = eligibleAsins.filter((asin: string) => !autoAsins.has(asin));
    const coveredAutoAsins = eligibleAsins.filter((asin: string) => autoAsins.has(asin));
    const recentDecisions = decisions.filter((d: any) => ageMinutes(d.evaluated_at || d.created_at) <= 45);
    const executed = decisions.filter((d: any) => ['executed', 'completed'].includes(d.status) && ageMinutes(d.executed_at || d.updated_at || d.created_at) <= 24 * 60);
    const confirmed = decisions.filter((d: any) => d.confirmation_status === 'confirmed' && ageMinutes(d.confirmed_at || d.updated_at || d.created_at) <= 24 * 60);
    const queuePending = queue.filter((q: any) => ['pending', 'approved', 'running', 'submitted', 'processing'].includes(q.status));
    const queueFailed = queue.filter((q: any) => ['failed', 'blocked'].includes(q.status) && ageMinutes(q.updated_at || q.created_at) <= 6 * 60);
    const latestSync = latest(logs, 'completed_at', 'started_at');
    const latestDecision = latest(decisions, 'evaluated_at', 'created_at');
    const syncFresh = ageMinutes(latestSync?.completed_at || latestSync?.started_at) <= 45;
    const decisionFresh = ageMinutes(latestDecision?.evaluated_at || latestDecision?.created_at) <= 45;
    const recentErrors = logs.filter((l: any) => ['error', 'failed'].includes(l.status) && ageMinutes(l.completed_at || l.started_at) <= 90);
    const alerts: string[] = [];
    if (!syncFresh) alerts.push('SYNC_STALE');
    if (!decisionFresh) alerts.push('DECISION_STALE');
    if (active.length && !activeKeywords.length) alerts.push('ACTIVE_CAMPAIGNS_WITHOUT_ACTIVE_KEYWORDS');
    if (!autos.length) alerts.push('NO_ACTIVE_AUTO_CAMPAIGN');
    if (missingAutoAsins.length) alerts.push('AUTO_COVERAGE_GAP');
    if (staleInventoryAsins.length) alerts.push('STOCK_DATA_STALE');
    if (inventoryUnknownAsins.length) alerts.push('STOCK_DATA_UNKNOWN');
    if (!manuals.length) alerts.push('NO_ACTIVE_MANUAL_CAMPAIGN');
    if (queueFailed.length) alerts.push('QUEUE_FAILURES');
    if (recentErrors.length) alerts.push('RECENT_SYNC_ERRORS');
    const health = alerts.some((a) => ['SYNC_STALE', 'DECISION_STALE', 'QUEUE_FAILURES'].includes(a)) ? 'critical'
      : alerts.length ? 'warning' : 'healthy';
    const report = {
      amazon_account_id: accountId,
      correlation_id: correlationId,
      health,
      checked_at: new Date().toISOString(),
      stages: {
        ingestion: { fresh: syncFresh, latest_at: latestSync?.completed_at || latestSync?.started_at || null },
        decisions: { fresh: decisionFresh, recent_45m: recentDecisions.length, latest_at: latestDecision?.evaluated_at || latestDecision?.created_at || null },
        queue: { pending: queuePending.length, failed_6h: queueFailed.length },
        execution: { executed_24h: executed.length },
        confirmation: { confirmed_24h: confirmed.length },
      },
      ads: {
        active_campaigns: active.length,
        active_automatic_campaigns: autos.length,
        active_manual_campaigns: manuals.length,
        active_keywords: activeKeywords.length,
        eligible_asins: eligibleAsins.length,
        eligible_asin_ids: eligibleAsins,
        covered_auto_asins: coveredAutoAsins,
        missing_auto_asins: missingAutoAsins,
        stale_inventory_asins: staleInventoryAsins,
        inventory_unknown_asins: inventoryUnknownAsins,
      },
      alerts,
    };
    reports.push(report);
    if (body.persist !== false) await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      correlation_id: correlationId,
      operation: 'ads_automation_e2e_audit',
      trigger_type: body.trigger_type || 'scheduler',
      status: sourceErrors.length ? 'error' : health === 'critical' || health === 'warning' ? 'warning' : 'success',
      started_at: report.checked_at,
      completed_at: new Date().toISOString(),
      records_processed: campaigns.length + products.length + keywords.length + decisions.length + queue.length,
      result_summary: JSON.stringify(report),
      error_message: sourceErrors.length ? sourceErrors.map(item => `${item.source}:${item.error}`).join('; ').slice(0, 1000) : null,
    }).catch((error: unknown) => sourceErrors.push({ source: 'SyncExecutionLog.create', amazon_account_id: accountId, error: safeError(error) }));
  }
  const criticalAlerts = reports.flatMap(report => report.health === 'critical'
    ? report.alerts.map((alert: string) => ({ amazon_account_id: report.amazon_account_id, alert }))
    : []);
  const partial = partialReasons.length > 0 || sourceErrors.length > 0;
  const outcome = createAuditOutcome({ correlationId, criticalAlerts, partial, technicalFailure: sourceErrors.length > 0,
    sourceErrors, completedAt: new Date().toISOString() });
  return Response.json({ ...outcome, partial_reasons: partialReasons, reports }, { status: sourceErrors.length ? 500 : 200 });
  } catch (error) {
    sourceErrors.push({ source: 'audit_handler', error: safeError(error) });
    const outcome = createAuditOutcome({ correlationId, technicalFailure: true, sourceErrors, completedAt: new Date().toISOString() });
    return Response.json({ ...outcome, error: safeError(error), reports: [] }, { status: 500 });
  }
});
