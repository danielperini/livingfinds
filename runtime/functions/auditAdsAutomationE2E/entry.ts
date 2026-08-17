import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const MINUTE = 60_000;
const isEnabled = (row: any) => ['enabled', 'active'].includes(String(row?.state || row?.status || '').toLowerCase());
const ageMinutes = (value: string | undefined | null) => value ? Math.max(0, (Date.now() - new Date(value).getTime()) / MINUTE) : Number.POSITIVE_INFINITY;

function latest(rows: any[], ...fields: string[]) {
  return rows.reduce((best, row) => {
    const at = fields.map((field) => row?.[field]).find(Boolean);
    const bestAt = fields.map((field) => best?.[field]).find(Boolean);
    return !best || new Date(at || 0).getTime() > new Date(bestAt || 0).getTime() ? row : best;
  }, null as any);
}

Deno.serve(async (request) => {
  const base44 = createClientFromRequest(request);
  const body = await request.json().catch(() => ({}));
  const authenticated = await base44.auth.isAuthenticated().catch(() => false);
  if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

  const accounts = body.amazon_account_id
    ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
    : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, null, 20);
  const reports: any[] = [];

  for (const account of accounts) {
    const accountId = account.id;
    const [campaigns, products, keywords, decisions, queue, logs] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-updated_at', 2000).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, '-updated_at', 2000).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-updated_at', 3000).catch(() => []),
      base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-created_at', 1000).catch(() => []),
      base44.asServiceRole.entities.AmazonActionQueue.filter({ amazon_account_id: accountId }, '-created_at', 1000).catch(() => []),
      base44.asServiceRole.entities.SyncExecutionLog.filter({ amazon_account_id: accountId }, '-started_at', 500).catch(() => []),
    ]);
    const active = campaigns.filter(isEnabled);
    const autos = active.filter((c: any) => String(c.amazon_targeting_type || c.targeting_type || '').toUpperCase() === 'AUTO');
    const manuals = active.filter((c: any) => String(c.amazon_targeting_type || c.targeting_type || '').toUpperCase() === 'MANUAL');
    const activeKeywords = keywords.filter(isEnabled);
    const eligibleAsins = [...new Set(products.filter((product: any) =>
      product.status === 'active' &&
      ['in_stock', 'low_stock'].includes(product.inventory_status) &&
      Number(product.available_quantity || product.fba_inventory || 0) > 1 &&
      product.asin
    ).map((product: any) => product.asin))];
    const autoAsins = new Set(autos.map((campaign: any) => campaign.asin).filter(Boolean));
    const missingAutoAsins = eligibleAsins.filter((asin: string) => !autoAsins.has(asin));
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
    if (!manuals.length) alerts.push('NO_ACTIVE_MANUAL_CAMPAIGN');
    if (queueFailed.length) alerts.push('QUEUE_FAILURES');
    if (recentErrors.length) alerts.push('RECENT_SYNC_ERRORS');
    const health = alerts.some((a) => ['SYNC_STALE', 'DECISION_STALE', 'QUEUE_FAILURES'].includes(a)) ? 'critical'
      : alerts.length ? 'warning' : 'healthy';
    const report = {
      amazon_account_id: accountId,
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
        missing_auto_asins: missingAutoAsins,
      },
      alerts,
    };
    reports.push(report);
    if (body.persist !== false) await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'ads_automation_e2e_audit',
      trigger_type: body.trigger_type || 'scheduler',
      status: health === 'critical' ? 'error' : health === 'warning' ? 'warning' : 'success',
      started_at: report.checked_at,
      completed_at: new Date().toISOString(),
      records_processed: campaigns.length + products.length + keywords.length + decisions.length + queue.length,
      result_summary: JSON.stringify(report),
      error_message: alerts.length ? alerts.join(', ') : null,
    }).catch(() => {});
  }
  return Response.json({ ok: reports.every((r) => r.health !== 'critical'), reports });
});
