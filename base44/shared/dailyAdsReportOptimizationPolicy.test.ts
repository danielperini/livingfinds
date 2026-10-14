import {
  assessDailyReportOptimization,
  isCanonicalDailyReportJob,
  isDailyReportOptimizationSuccessful,
  previousBrazilCalendarDate,
  REQUIRED_DAILY_SP_REPORTS,
} from './dailyAdsReportOptimizationPolicy.ts';

const completeReports = [...REQUIRED_DAILY_SP_REPORTS];

Deno.test('daily report gate accepts only canonical campaign, search-term and advertised-product grains', () => {
  if (!isCanonicalDailyReportJob({ report_type_id: 'spCampaigns', group_by: ['campaign'] })) {
    throw new Error('campaign report rejected');
  }
  if (!isCanonicalDailyReportJob({ report_type_id: 'spSearchTerm', group_by: '["searchTerm"]' })) {
    throw new Error('search term report rejected');
  }
  if (
    !isCanonicalDailyReportJob({ report_type_id: 'spAdvertisedProduct', group_by: ['advertiser'] })
  ) throw new Error('advertised product report rejected');
  if (
    isCanonicalDailyReportJob({ report_type_id: 'spCampaigns', group_by: ['campaignPlacement'] })
  ) throw new Error('placement report must not satisfy campaign report');
});

Deno.test('daily report optimization only runs after previous BRT day reports mature', () => {
  const now = new Date('2026-10-14T10:24:00.000Z'); // 07:24 BRT
  const result = assessDailyReportOptimization({
    now,
    reportDate: '2026-10-13',
    processedReportTypes: completeReports,
  });
  if (result.eligible || result.reason !== 'waiting_for_closed_day_report_maturation') {
    throw new Error(`unexpected assessment: ${JSON.stringify(result)}`);
  }
  if (previousBrazilCalendarDate(now) !== '2026-10-13') {
    throw new Error('BRT date boundary is incorrect');
  }
});

Deno.test('daily report optimization blocks partial or stale-day reports', () => {
  const now = new Date('2026-10-14T12:00:00.000Z');
  const incomplete = assessDailyReportOptimization({
    now,
    reportDate: '2026-10-13',
    processedReportTypes: ['spCampaigns', 'spSearchTerm'],
  });
  if (incomplete.eligible || !incomplete.reason.includes('spAdvertisedProduct')) {
    throw new Error(`incomplete report set was accepted: ${JSON.stringify(incomplete)}`);
  }
  const stale = assessDailyReportOptimization({
    now,
    reportDate: '2026-10-12',
    processedReportTypes: completeReports,
  });
  if (stale.eligible || stale.reason !== 'latest_closed_day_report_not_ready') {
    throw new Error(`stale report was accepted: ${JSON.stringify(stale)}`);
  }
});

Deno.test('daily report optimization is idempotent and retries stale work after lease/cooldown', () => {
  const now = new Date('2026-10-14T12:00:00.000Z');
  const input = { now, reportDate: '2026-10-13', processedReportTypes: completeReports };
  const completed = assessDailyReportOptimization({
    ...input,
    existingRun: { status: 'success', started_at: '2026-10-14T10:00:00.000Z' },
  });
  if (completed.eligible || completed.reason !== 'already_optimized_for_report_date') {
    throw new Error(`completed daily run was not idempotent: ${JSON.stringify(completed)}`);
  }
  const active = assessDailyReportOptimization({
    ...input,
    existingRun: { status: 'processing', started_at: '2026-10-14T11:40:00.000Z' },
  });
  if (active.eligible || active.reason !== 'optimization_already_running') {
    throw new Error(`active daily run was duplicated: ${JSON.stringify(active)}`);
  }
  const stale = assessDailyReportOptimization({
    ...input,
    existingRun: { status: 'processing', started_at: '2026-10-14T10:00:00.000Z' },
  });
  if (!stale.eligible || !stale.retry_stale_run) {
    throw new Error(`stale daily run was not recoverable: ${JSON.stringify(stale)}`);
  }
  const cooldown = assessDailyReportOptimization({
    ...input,
    existingRun: { status: 'error', completed_at: '2026-10-14T11:45:00.000Z' },
  });
  if (cooldown.eligible || cooldown.reason !== 'retry_cooldown') {
    throw new Error(`retry cooldown was not enforced: ${JSON.stringify(cooldown)}`);
  }
  const retry = assessDailyReportOptimization({
    ...input,
    existingRun: { status: 'error', completed_at: '2026-10-14T11:20:00.000Z' },
  });
  if (!retry.eligible || retry.reason !== 'retry_failed_optimization') {
    throw new Error(`failed daily run was not retryable: ${JSON.stringify(retry)}`);
  }
});

Deno.test('daily report optimization is successful only after clean Amazon confirmation', () => {
  const confirmed = {
    responseOk: true,
    dataOk: true,
    failedActions: 0,
    confirmationOk: true,
    confirmationDivergences: 0,
    confirmationRetries: 0,
  };
  if (!isDailyReportOptimizationSuccessful(confirmed)) throw new Error('clean run not accepted');
  for (
    const failure of [
      { failedActions: 1 },
      { confirmationOk: false },
      { confirmationDivergences: 1 },
      { confirmationRetries: 1 },
      { skipped: true },
    ]
  ) {
    if (isDailyReportOptimizationSuccessful({ ...confirmed, ...failure })) {
      throw new Error(`partial run was marked successful: ${JSON.stringify(failure)}`);
    }
  }
});
