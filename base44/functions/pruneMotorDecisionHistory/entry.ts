import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { productAdsEligibility } from '../../shared/productAdsEligibility.ts';

const TERMINAL_NON_EFFECTIVE = new Set(['blocked', 'skipped', 'cancelled', 'failed', 'failed_final', 'rejected', 'expired']);
const EFFECTIVE_STATUSES = new Set(['executed', 'completed', 'confirmed', 'applied', 'success', 'succeeded']);
const OPEN_STATUSES = new Set(['pending', 'approved', 'scheduled', 'executing', 'processing', 'submitted', 'running']);
const MAX_ROWS = 5000;
const MAX_DELETE_PER_RUN = 5000;

function norm(value: any) { return String(value || '').trim().toLowerCase(); }
function upper(value: any) { return String(value || '').trim().toUpperCase(); }
function campaignId(row: any) { return String(row?.campaign_id || row?.amazon_campaign_id || ''); }
function entityAsin(row: any, campaignById: Map<string, any>) {
  const direct = upper(row?.asin || row?.product_asin);
  if (direct) return direct;
  const cid = campaignId(row);
  const campaign = cid ? campaignById.get(cid) : null;
  return upper(campaign?.asin || campaign?.product_asin);
}
function isOpen(row: any) {
  return OPEN_STATUSES.has(norm(row?.status)) || OPEN_STATUSES.has(norm(row?.queue_status));
}
function isEffective(row: any) {
  const status = norm(row?.status);
  const queueStatus = norm(row?.queue_status);
  const confirmation = norm(row?.amazon_confirmation_status || row?.confirmation_status);
  if (EFFECTIVE_STATUSES.has(status) || EFFECTIVE_STATUSES.has(queueStatus) || EFFECTIVE_STATUSES.has(confirmation)) return true;
  if (row?.amazon_confirmed_at || row?.confirmed_at) return true;
  if (row?.executed_at && !TERMINAL_NON_EFFECTIVE.has(status)) return true;
  if (!status && (row?.new_bid != null || row?.bid_after != null || row?.value_after != null) && (row?.created_at || row?.created_date)) return true;
  return false;
}
function removalReason(row: any, productByAsin: Map<string, any>, campaignById: Map<string, any>) {
  const asin = entityAsin(row, campaignById);
  const product = asin ? productByAsin.get(asin) : null;
  const eligibility = productAdsEligibility(product);
  const activeProduct = Boolean(product && eligibility.active);
  if (!asin || !product) return { reason: 'unresolved_product', asin: asin || null, activeProduct, effective: isEffective(row) };
  if (!activeProduct) return { reason: 'inactive_product', asin, activeProduct, effective: isEffective(row) };
  if (!isEffective(row)) return { reason: 'non_effective', asin, activeProduct, effective: false };
  return { reason: null, asin, activeProduct, effective: true };
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const dryRun = true; // History is evidence: this endpoint is now audit-only for every caller.
    const maxDelete = Math.min(Math.max(Number(body.max_delete || MAX_DELETE_PER_RUN), 1), MAX_DELETE_PER_RUN);
    const accounts = body.amazon_account_id
      ? [{ id: body.amazon_account_id }]
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 100).catch(() => []);

    const totals = {
      scanned: 0, scanned_decisions: 0, scanned_bid_logs: 0,
      preserved_effective_active: 0, preserved_open: 0,
      removed_non_effective: 0, removed_inactive_product: 0, removed_unresolved_product: 0,
      removed_decisions: 0, removed_bid_logs: 0, delete_errors: 0,
    };
    const reports: any[] = [];

    for (const account of accounts) {
      const [products, campaigns, decisions, bidLogs] = await Promise.all([
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: account.id }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: account.id }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: account.id }, '-created_at', MAX_ROWS).catch(() => []),
        base44.asServiceRole.entities.AdsBidChangeLog.filter({ amazon_account_id: account.id }, '-created_at', MAX_ROWS).catch(() => []),
      ]);

      const productByAsin = new Map<string, any>(products.filter((p: any) => p.asin).map((p: any) => [upper(p.asin), p]));
      const campaignById = new Map<string, any>();
      for (const campaign of campaigns) {
        const id = campaignId(campaign) || String(campaign?.id || '');
        if (id) campaignById.set(id, campaign);
      }

      const report = {
        amazon_account_id: account.id,
        scanned: decisions.length + bidLogs.length,
        scanned_decisions: decisions.length,
        scanned_bid_logs: bidLogs.length,
        preserved_effective_active: 0,
        preserved_open: 0,
        removed_non_effective: 0,
        removed_inactive_product: 0,
        removed_unresolved_product: 0,
        removed_decisions: 0,
        removed_bid_logs: 0,
        delete_errors: 0,
        candidates: [] as any[],
      };

      totals.scanned += report.scanned;
      totals.scanned_decisions += decisions.length;
      totals.scanned_bid_logs += bidLogs.length;
      let deleted = 0;

      const processRows = async (rows: any[], entityName: 'OptimizationDecision' | 'AdsBidChangeLog') => {
        for (const row of rows) {
          if (deleted >= maxDelete) break;
          if (entityName === 'OptimizationDecision' && isOpen(row)) {
            report.preserved_open++; totals.preserved_open++;
            continue;
          }
          const evaluation = removalReason(row, productByAsin, campaignById);
          if (!evaluation.reason) {
            report.preserved_effective_active++; totals.preserved_effective_active++;
            continue;
          }
          report.candidates.push({ entity: entityName, id: row.id, asin: evaluation.asin, status: row.status || null, queue_status: row.queue_status || null, reason: evaluation.reason });
          deleted++; // Bounded candidate inspection only; no records are deleted.

        }
      };

      await processRows(decisions, 'OptimizationDecision');
      if (deleted < maxDelete) await processRows(bidLogs, 'AdsBidChangeLog');

      reports.push(report);
    }

    return Response.json({
      ok: totals.delete_errors === 0,
      dry_run: dryRun,
      read_only: true,
      policy: 'preserve_all_history; audit_candidates_only',
      max_delete_per_run: maxDelete,
      totals,
      accounts: reports.map(r => ({ ...r, candidates: r.candidates.slice(0, 100) })),
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});
