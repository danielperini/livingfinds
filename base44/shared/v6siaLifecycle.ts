import type { V6SIADecisionLike } from './v6siaReviewEvidence.ts';
import { v6siaImplementationStatus } from './v6siaReviewEvidence.ts';

export type V6SIAEvidenceLinkContext = {
  amazon_account_id: string;
  profile_id?: string | null;
  marketplace_id?: string | null;
  correlation_id: string;
  review_log_id: string;
  created_at: string;
};

export function buildV6SIAEvidenceLinks(
  byTable: Record<string, Array<Record<string, any>> | null>,
  context: V6SIAEvidenceLinkContext,
) {
  const links: Array<Record<string, any>> = [];
  const errors: Array<{ source_table: string; source_record_id?: string; error: string }> = [];
  for (const [sourceTable, rows] of Object.entries(byTable)) {
    for (const row of rows || []) {
      const sourceRecordId = String(row?.id || '');
      if (!sourceRecordId) {
        errors.push({ source_table: sourceTable, error: 'source_record_id ausente' });
        continue;
      }
      links.push({
        ...context,
        source_table: sourceTable,
        source_record_id: sourceRecordId,
        source_report_id: row.source_report_id || row.report_id || null,
        source_job_id: row.report_job_id || row.job_id || null,
        source_date: row.date || row.assessment_date || row.spend_date || row.created_at || null,
        campaign_id: row.campaign_id || row.amazon_campaign_id || null,
        ad_group_id: row.ad_group_id || null,
        asin: row.asin || row.advertised_asin || row.advertised_product_id || null,
        sku: row.sku || row.advertised_sku || null,
      });
    }
  }
  return { links, errors };
}

export function v6siaReviewCompletion(input: {
  readsComplete: boolean;
  aiStatus: 'complete' | 'deferred' | 'failed' | 'incomplete';
  expectedEvidenceLinks: number;
  persistedEvidenceLinks: number;
  evidenceLinkErrors?: number;
}): 'success' | 'partial' | 'deferred' | 'error' {
  if (!input.readsComplete ||
      (input.evidenceLinkErrors || 0) > 0 ||
      input.persistedEvidenceLinks !== input.expectedEvidenceLinks) return 'partial';
  if (input.aiStatus === 'complete') return 'success';
  if (input.aiStatus === 'deferred') return 'deferred';
  return 'error';
}

export function v6siaReviewImplementationStatus(decisions: V6SIADecisionLike[]) {
  return v6siaImplementationStatus(decisions);
}
