import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const STEPS = [
  ['yesterday_closed_data', 'syncYesterdayClosedData'],
  ['unified_reports_access_test', 'testUnifiedReportsAccess'],
  ['unified_reports_daily', 'syncUnifiedAdsReportsDaily'],
  ['unified_reports_hourly', 'syncUnifiedAdsReportsHourly'],
  ['reconcile_unified_vs_legacy', 'reconcileUnifiedVsLegacyMetrics'],
  ['product_campaign_links', 'fixProductCampaignLinks'],
  ['prepare_all_campaign_repairs', 'prepareAllCampaignRepairs'],
  ['auto_campaign_repair_queue_v2', 'processAutoCampaignRepairQueueV2'],
  ['exact_keyword_integrity_scan', 'scanExactKeywordIntegrity'],
  ['exact_keyword_repair_queue', 'processKeywordRepairQueue'],
  ['night_amazon_queue', 'processAmazonNightWindow'],
  ['bid_decision_v2', 'runBidDecisionEngineV2'],
  ['bid_outcomes', 'evaluateBidChangeOutcomesV2'],
  ['learner', 'runLearnerCycle'],
  ['auto_vs_manual', 'evaluateAutoVsManualCampaigns'],
];

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const targetAccountId = body.amazon_account_id || null;
    const triggerType = body.trigger_type || 'automatic_midnight';

    const accounts = targetAccountId
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: targetAccountId })
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });

    if (!accounts.length) {
      return Response.json({
        ok: true,
        accounts_processed: 0,
        message: 'Nenhuma conta Amazon conectada.',
      });
    }

    const results = [];

    for (const account of accounts) {
      const accountResult: any = {
        amazon_account_id: account.id,
        started_at: new Date().toISOString(),
        steps: [],
        ok: true,
      };

      for (const [stepName, functionName] of STEPS) {
        const stepStarted = Date.now();

        try {
          const response = await base44.asServiceRole.functions.invoke(functionName, {
            amazon_account_id: account.id,
            trigger_type: triggerType,
            force: body.force === true,
            _service_role: true,
          });

          const data = response?.data || response || {};
          const stepOk = data?.ok !== false;

          accountResult.steps.push({
            step: stepName,
            function: functionName,
            ok: stepOk,
            duration_ms: Date.now() - stepStarted,
            summary: data,
          });

          if (!stepOk) accountResult.ok = false;
        } catch (error) {
          accountResult.ok = false;
          accountResult.steps.push({
            step: stepName,
            function: functionName,
            ok: false,
            duration_ms: Date.now() - stepStarted,
            error: error?.message || String(error),
          });
        }
      }

      const completedAt = new Date().toISOString();
      accountResult.completed_at = completedAt;
      accountResult.duration_ms =
        new Date(completedAt).getTime() - new Date(accountResult.started_at).getTime();

      await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
        last_sync_at: completedAt,
        error_message: accountResult.ok
          ? null
          : 'Uma ou mais etapas do sync geral falharam.',
      }).catch(() => {});

      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: account.id,
        operation: 'sync_all_amazon_apis',
        status: accountResult.ok ? 'success' : 'error',
        trigger_type: triggerType,
        started_at: accountResult.started_at,
        completed_at: completedAt,
        records_processed: accountResult.steps.filter((step: any) => step.ok).length,
        result_summary: JSON.stringify(accountResult.steps).slice(0, 4000),
        error_message: accountResult.ok
          ? null
          : accountResult.steps
              .filter((step: any) => !step.ok)
              .map((step: any) => `${step.step}: ${step.error || 'falha'}`)
              .join(' | ')
              .slice(0, 1000),
      }).catch(() => {});

      results.push(accountResult);
    }

    return Response.json({
      ok: results.every((item: any) => item.ok),
      trigger_type: triggerType,
      amazon_source_of_truth: true,
      ads_metrics_source: 'amazon_ads_api',
      dashboard_metrics_window_days: 30,
      yesterday_closed_sync: 'automatic',
      amazon_write_policy: 'queued_00_04_and_13_14_except_pause',
      repair_preparation_policy: 'all_incomplete_campaigns_queued_by_campaign_id',
      auto_campaign_integrity: 'campaign_ad_group_product_ad_required',
      exact_group_integrity: 'at_least_one_enabled_exact_keyword_required',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startedMs,
      accounts_processed: results.length,
      results,
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error?.message || 'Erro no sincronizador geral Amazon',
        started_at: startedAt,
        duration_ms: Date.now() - startedMs,
      },
      { status: 500 },
    );
  }
});