import { buildV6SIAEvidenceLinks, shouldForceV6SIANewAnalysis, v6siaReviewCompletion, v6siaReviewImplementationStatus } from './v6siaLifecycle.ts';

Deno.test('E2E V6SIA complete path links all source rows and keeps sent actions pending confirmation', async () => {
  const { links, errors } = buildV6SIAEvidenceLinks({
    UnifiedAdsMetricsDaily: [{ id: 'metric-1', source_report_id: 'report-1', date: '2026-10-11' }],
    SearchTerm: [{ id: 'term-1', campaign_id: 'campaign-1', search_term: 'microfone usb' }],
    SalesDaily: [{ id: 'sale-1', asin: 'B0HLMF8PPD', sku: 'FBA-0122' }],
  }, { amazon_account_id: 'account-1', review_log_id: 'review-1', correlation_id: 'run-1', created_at: '2026-10-12T12:00:00Z' });
  const persisted: any[] = [];
  for (let offset = 0; offset < links.length; offset += 2) persisted.push(...links.slice(offset, offset + 2));
  if (errors.length || persisted.length !== 3 || persisted[0].source_report_id !== 'report-1') throw new Error('all metric/report rows must be linked');
  if (v6siaReviewCompletion({ readsComplete: true, aiStatus: 'complete', expectedEvidenceLinks: 3, persistedEvidenceLinks: persisted.length }) !== 'success') throw new Error('complete evidence plus completed AI should complete the review');
  if (v6siaReviewImplementationStatus([{ status: 'executed', confirmation_status: 'pending' }]) !== 'pending_confirmation') throw new Error('sent Amazon write is not implementation');
});

Deno.test('E2E V6SIA flags the review partial after query or link persistence failure', () => {
  const missingId = buildV6SIAEvidenceLinks({ SearchTerm: [{ search_term: 'sem id' }] }, {
    amazon_account_id: 'a', review_log_id: 'r', correlation_id: 'c', created_at: 'now',
  });
  const queryFailure = v6siaReviewCompletion({ readsComplete: false, aiStatus: 'complete', expectedEvidenceLinks: 0, persistedEvidenceLinks: 0 });
  const persistenceFailure = v6siaReviewCompletion({ readsComplete: true, aiStatus: 'complete', expectedEvidenceLinks: 4, persistedEvidenceLinks: 2, evidenceLinkErrors: 1 });
  if (!missingId.errors.length || queryFailure !== 'partial' || persistenceFailure !== 'partial') throw new Error('incomplete source/link path must be surfaced');
});

Deno.test('E2E V6SIA never labels truncated AI output as completed', () => {
  const truncatedOutput = v6siaReviewCompletion({ readsComplete: true, aiStatus: 'incomplete', expectedEvidenceLinks: 2, persistedEvidenceLinks: 2 });
  if (truncatedOutput !== 'error') throw new Error('length-limited AI output must not complete');
});

Deno.test('E2E V6SIA reports mixed confirmed and failed Amazon actions individually', () => {
  const implementation = v6siaReviewImplementationStatus([
    { id: 'one', status: 'completed', confirmation_status: 'confirmed' },
    { id: 'two', status: 'failed', confirmation_status: 'not_applicable' },
  ]);
  if (implementation !== 'partial') throw new Error('one failed action must remain visible as partial');
  if (v6siaReviewCompletion({ readsComplete: true, aiStatus: 'deferred', expectedEvidenceLinks: 0, persistedEvidenceLinks: 0 }) !== 'deferred') throw new Error('AI budget deferral must be explicit');
});

Deno.test('E2E V6SIA daily review bypasses result cache but execution failure only forces on explicit request', () => {
  if (!shouldForceV6SIANewAnalysis('daily_portfolio', false)) throw new Error('daily review must request a fresh OpenAI analysis');
  if (shouldForceV6SIANewAnalysis('execution_failure', false)) throw new Error('execution failure must respect cache/budget policy unless forced');
  if (!shouldForceV6SIANewAnalysis('execution_failure', true)) throw new Error('explicit force must request fresh analysis');
});
