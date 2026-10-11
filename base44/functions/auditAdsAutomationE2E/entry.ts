import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { campaignCoverageEligible } from '../../shared/campaignCoverageEligibility.ts';
import { assessAutomationStage } from '../../shared/adsAutomationHealth.ts';

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

async function readRows(name: string, load: () => Promise<any[]>) {
  try {
    const rows = await load();
    if (!Array.isArray(rows)) throw new Error('Expected an array from data source');
    return { name, rows, error: null as string | null };
  } catch (error: any) {
    return { name, rows: [] as any[], error: error?.message || String(error) };
  }
}

function combineStageStates(stages: any[]) {
  const states = stages.map((stage) => stage.state);
  if (states.includes('failed')) return 'failed';
  if (states.includes('stale')) return 'stale';
  if (states.includes('unknown')) return 'unknown';
  if (states.includes('running')) return 'running';
  if (states.every((state) => state === 'no_actions')) return 'no_actions';
  return 'healthy';
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
    const readResults = await Promise.all([
      readRows('campaigns', () => base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-updated_at', 2000)),
      readRows('products', () => base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, '-updated_at', 2000)),
      readRows('keywords', () => base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-updated_at', 3000)),
      readRows('decisions', () => base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-created_at', 1000)),
      readRows('queue', () => base44.asServiceRole.entities.AmazonActionQueue.filter({ amazon_account_id: accountId }, '-created_at', 1000)),
      readRows('logs', () => base44.asServiceRole.entities.SyncExecutionLog.filter({ amazon_account_id: accountId }, '-started_at', 500)),
    ]);
    const [campaignsResult, productsResult, keywordsResult, decisionsResult, queueResult, logsResult] = readResults;
    const campaigns = campaignsResult.rows;
    const products = productsResult.rows;
    const keywords = keywordsResult.rows;
    const decisions = decisionsResult.rows;
    const queue = queueResult.rows;
    const logs = logsResult.rows;
    const readErrors = readResults.filter((result) => result.error).map((result) => ({
      source: result.name, error: result.error,
    }));
    const active = campaigns.filter(isEnabled);
    const autos = active.filter((c: any) => String(c.amazon_targeting_type || c.targeting_type || '').toUpperCase() === 'AUTO');
    const manuals = active.filter((c: any) => String(c.amazon_targeting_type || c.targeting_type || '').toUpperCase() === 'MANUAL');
    const activeKeywords = keywords.filter(isEnabled);
    const eligibleAsins = [...new Set(products.filter(campaignCoverageEligible)
      .map((product: any) => String(product.asin).trim().toUpperCase()))];
    const autoAsins = new Set(autos.map((campaign: any) => campaign.asin).filter(Boolean));
    const missingAutoAsins = eligibleAsins.filter((asin: string) => !autoAsins.has(asin));
    const recentDecisions = decisions.filter((d: any) => ageMinutes(d.evaluated_at || d.created_at) <= 45);
    const executed = decisions.filter((d: any) => ['executed', 'completed'].includes(d.status) && ageMinutes(d.executed_at || d.updated_at || d.created_at) <= 24 * 60);
    const confirmed = decisions.filter((d: any) => d.confirmation_status === 'confirmed' && ageMinutes(d.confirmed_at || d.updated_at || d.created_at) <= 24 * 60);
    const queuePending = queue.filter((q: any) => ['pending', 'approved', 'running', 'submitted', 'processing'].includes(q.status));
    const queueFailed = queue.filter((q: any) => ['failed', 'blocked'].includes(q.status) && ageMinutes(q.updated_at || q.created_at) <= 6 * 60);
    const collectionStageChecks = [
      assessAutomationStage(logs, 'intraday_ads_report:request', 45),
      assessAutomationStage(logs, 'intraday_ads_report:poll', 45),
      assessAutomationStage(logs, 'intraday_ads_report:download', 45),
    ];
    const collectionState = combineStageStates(collectionStageChecks);
    const reportProcessing = assessAutomationStage(logs, 'daily_ai_report_analysis:', 36 * 60);
    const metricPersistence = assessAutomationStage(logs, 'intraday_ads_report:persist', 45);
    const latestDecision = latest(decisions, 'evaluated_at', 'created_at');
    const decisionAge = latestDecision ? ageMinutes(latestDecision.evaluated_at || latestDecision.created_at) : Number.POSITIVE_INFINITY;
    const decisionStage = {
      state: !latestDecision ? 'unknown' : decisionAge > 45 ? 'stale'
        : ['failed', 'error', 'rejected'].includes(String(latestDecision.status || '').toLowerCase()) ? 'failed'
        : 'healthy',
      latest_at: latestDecision?.evaluated_at || latestDecision?.created_at || null,
      age_minutes: Number.isFinite(decisionAge) ? decisionAge : null,
      status: latestDecision?.status || null,
      detail: !latestDecision ? 'NO_DECISION_EVIDENCE' : decisionAge > 45 ? 'DECISION_EVIDENCE_STALE' : 'DECISION_EVIDENCE_CURRENT',
    };
    const latestQueue = latest(queue, 'updated_at', 'created_at');
    const queueStage = {
      state: queueFailed.length ? 'failed' : queuePending.length ? 'running' : 'no_actions',
      latest_at: latestQueue?.updated_at || latestQueue?.created_at || null,
      pending: queuePending.length, failed: queueFailed.length,
    };
    const executionStage = assessAutomationStage(logs, 'ads_decision_execution', 45);
    const confirmationStage = assessAutomationStage(logs, 'confirm_executed_decisions', 45);
    const recentErrors = logs.filter((l: any) => l.operation !== 'ads_automation_e2e_audit'
      && ['error', 'failed'].includes(String(l.status).toLowerCase())
      && ageMinutes(l.completed_at || l.started_at) <= 90);
    const stageChecks = [
      ['COLLECTION', collectionState],
      ['REPORT_PROCESSING', reportProcessing.state],
      ['METRICS', metricPersistence.state],
      ['DECISION', decisionStage.state],
      ['QUEUE', queueStage.state],
      ['EXECUTION', executionStage.state],
      ['CONFIRMATION', confirmationStage.state],
    ] as const;
    const alerts: string[] = [];
    for (const { source } of readErrors) alerts.push(`DATA_READ_FAILED_${source.toUpperCase()}`);
    for (const [name, state] of stageChecks) {
      if (state === 'failed' || state === 'stale') alerts.push(`${name}_${state.toUpperCase()}`);
      else if (state === 'unknown') alerts.push(`${name}_UNKNOWN`);
    }
    if (active.length && !activeKeywords.length) alerts.push('ACTIVE_CAMPAIGNS_WITHOUT_ACTIVE_KEYWORDS');
    if (!autos.length) alerts.push('NO_ACTIVE_AUTO_CAMPAIGN');
    if (missingAutoAsins.length) alerts.push('AUTO_COVERAGE_GAP');
    if (!manuals.length) alerts.push('NO_ACTIVE_MANUAL_CAMPAIGN');
    if (queueFailed.length) alerts.push('QUEUE_FAILURES');
    if (recentErrors.length) alerts.push('RECENT_SYNC_ERRORS');
    const criticalAlerts = alerts.some((a) => a.startsWith('DATA_READ_FAILED_') || /_(FAILED|STALE)$/.test(a));
    const health = criticalAlerts ? 'critical' : alerts.length ? 'warning' : 'healthy';
    const report = {
      amazon_account_id: accountId,
      health,
      checked_at: new Date().toISOString(),
      stages: {
        collection: { state: collectionState, checks: collectionStageChecks },
        report_processing: reportProcessing,
        metrics: metricPersistence,
        decisions: { ...decisionStage, recent_45m: recentDecisions.length },
        queue: queueStage,
        execution: { ...executionStage, executed_24h: executed.length },
        confirmation: { ...confirmationStage, confirmed_24h: confirmed.length },
        data_reads: { ok: readErrors.length === 0, errors: readErrors },
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
    if (body.persist !== false) {
      const db = base44.asServiceRole;
      await db.entities.SyncExecutionLog.create({
        amazon_account_id: accountId,
        operation: 'ads_automation_e2e_audit',
        trigger_type: body.trigger_type || 'scheduler',
        status: health === 'critical' ? 'error' : health === 'warning' ? 'warning' : 'success',
        started_at: report.checked_at,
        completed_at: new Date().toISOString(),
        records_processed: campaigns.length + products.length + keywords.length + decisions.length + queue.length,
        result_summary: JSON.stringify(report),
        error_message: alerts.length ? alerts.join(', ') : null,
      }).catch((error: any) => console.error('[ads-watchdog] audit log write failed:', error?.message || String(error)));

      for (const code of alerts) {
        await db.functions.invoke('upsertOperationalAlert', {
          amazon_account_id: accountId,
          alert_type: 'ads_automation_watchdog',
          alert_family: 'system',
          severity: criticalAlerts ? 'critical' : 'medium',
          entity_type: 'account',
          entity_id: accountId,
          dedup_context: code,
          title: `Watchdog Ads: ${code}`,
          message: `Estágio ${code} precisa de atenção. Consulte os detalhes do relatório de saúde da automação.`,
          details: JSON.stringify({ code, stages: report.stages }),
          data_source: 'auditAdsAutomationE2E',
          data_freshness: 'stage_checked',
          source_function: 'auditAdsAutomationE2E',
        }).catch((error: any) => console.error('[ads-watchdog] alert upsert failed:', error?.message || String(error)));
      }

      const activeWatchdogAlerts = await db.entities.Alert.filter({
        amazon_account_id: accountId, alert_type: 'ads_automation_watchdog',
      }, '-updated_at', 200).catch(() => []);
      const dedupPrefix = `${accountId}::ads_automation_watchdog::account::${accountId}::`.toLowerCase();
      const currentCodes = new Set(alerts.map((code) => code.toLowerCase()));
      for (const alert of activeWatchdogAlerts) {
        if (!['active', 'acknowledged'].includes(String(alert.status || '').toLowerCase())) continue;
        const key = String(alert.deduplication_key || '').toLowerCase();
        if (!key.startsWith(dedupPrefix)) continue;
        const previousCode = key.slice(dedupPrefix.length);
        if (currentCodes.has(previousCode)) continue;
        await db.functions.invoke('upsertOperationalAlert', {
          amazon_account_id: accountId,
          alert_type: 'ads_automation_watchdog',
          entity_type: 'account',
          entity_id: accountId,
          dedup_context: previousCode,
          resolved: true,
          resolution_reason: 'watchdog_stage_recovered',
          title: `Watchdog Ads: ${previousCode.toUpperCase()}`,
          message: 'O estágio monitorado voltou a apresentar evidência recente.',
        }).catch((error: any) => console.error('[ads-watchdog] alert resolution failed:', error?.message || String(error)));
      }
    }
  }
  return Response.json({ ok: reports.every((r) => r.health !== 'critical'), reports });
});
