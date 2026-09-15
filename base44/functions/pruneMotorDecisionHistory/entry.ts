import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { productAdsEligibility } from '../../shared/productAdsEligibility.ts';

const TERMINAL_NON_EFFECTIVE = new Set(['blocked', 'skipped', 'cancelled', 'failed', 'failed_final', 'rejected']);
const EFFECTIVE_STATUSES = new Set(['executed', 'completed', 'confirmed', 'applied', 'success', 'succeeded']);
const OPEN_STATUSES = new Set(['pending', 'approved', 'scheduled', 'executing', 'processing', 'submitted', 'running']);
const MAX_ROWS = 5000;
const MAX_DELETE_PER_RUN = 1000;

function norm(value: any) { return String(value || '').trim().toLowerCase(); }
function upper(value: any) { return String(value || '').trim().toUpperCase(); }
function campaignId(row: any) { return String(row?.campaign_id || row?.amazon_campaign_id || ''); }
function isEffective(decision: any) {
  const status = norm(decision?.status);
  const queueStatus = norm(decision?.queue_status);
  const confirmation = norm(decision?.amazon_confirmation_status || decision?.confirmation_status);
  if (EFFECTIVE_STATUSES.has(status) || EFFECTIVE_STATUSES.has(queueStatus) || EFFECTIVE_STATUSES.has(confirmation)) return true;
  if (decision?.amazon_confirmed_at || decision?.confirmed_at) return true;
  if (decision?.executed_at && !TERMINAL_NON_EFFECTIVE.has(status)) return true;
  return false;
}
function isOpen(decision: any) {
  return OPEN_STATUSES.has(norm(decision?.status)) || OPEN_STATUSES.has(norm(decision?.queue_status));
}
function decisionAsin(decision: any, campaignById: Map<string, any>) {
  const direct = upper(decision?.asin || decision?.product_asin);
  if (direct) return direct;
  const cid = campaignId(decision);
  const campaign = cid ? campaignById.get(cid) : null;
  return upper(campaign?.asin || campaign?.product_asin);
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const dryRun = body.dry_run === true;
    const maxDelete = Math.min(Math.max(Number(body.max_delete || MAX_DELETE_PER_RUN), 1), MAX_DELETE_PER_RUN);
    const accounts = body.amazon_account_id
      ? [{ id: body.amazon_account_id }]
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 100).catch(() => []);

    const totals = { scanned: 0, preserved_effective_active: 0, preserved_open: 0, removed_non_effective: 0, removed_inactive_product: 0, removed_unresolved_product: 0, delete_errors: 0 };
    const reports: any[] = [];

    for (const account of accounts) {
      const [products, campaigns, decisions] = await Promise.all([
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: account.id }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: account.id }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: account.id }, '-created_at', MAX_ROWS).catch(() => []),
      ]);
      const productByAsin = new Map(products.filter((p: any) => p.asin).map((p: any) => [upper(p.asin), p]));
      const campaignById = new Map<string, any>();
      for (const campaign of campaigns) {
        const id = campaignId(campaign) || String(campaign?.id || '');
        if (id) campaignById.set(id, campaign);
      }

      const report = { amazon_account_id: account.id, scanned: decisions.length, preserved_effective_active: 0, preserved_open: 0, removed_non_effective: 0, removed_inactive_product: 0, removed_unresolved_product: 0, delete_errors: 0, candidates: [] as any[] };
      let deleted = 0;
      for (const decision of decisions) {
        if (deleted >= maxDelete) break;
        totals.scanned++;
        if (isOpen(decision)) {
          report.preserved_open++; totals.preserved_open++;
          continue;
        }

        const asin = decisionAsin(decision, campaignById);
        const product = asin ? productByAsin.get(asin) : null;
        const eligibility = productAdsEligibility(product);
        const activeProduct = Boolean(product && eligibility.active);
        const effective = isEffective(decision);

        if (effective && activeProduct) {
          report.preserved_effective_active++; totals.preserved_effective_active++;
          continue;
        }

        let reason = 'non_effective';
        if (!asin || !product) reason = 'unresolved_product';
        else if (!activeProduct) reason = 'inactive_product';

        report.candidates.push({ id: decision.id, asin: asin || null, status: decision.status || null, queue_status: decision.queue_status || null, reason });
        if (!dryRun) {
          try {
            await base44.asServiceRole.entities.OptimizationDecision.delete(decision.id);
          } catch {
            report.delete_errors++; totals.delete_errors++;
            continue;
          }
        }
        deleted++;
        if (reason === 'inactive_product') { report.removed_inactive_product++; totals.removed_inactive_product++; }
        else if (reason === 'unresolved_product') { report.removed_unresolved_product++; totals.removed_unresolved_product++; }
        else { report.removed_non_effective++; totals.removed_non_effective++; }
      }

      if (!dryRun) await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: account.id,
        operation: 'prune_motor_decision_history',
        trigger_type: body.trigger_type || 'unified_engine',
        status: report.delete_errors ? 'warning' : 'success',
        records_processed: report.scanned,
        records_imported: report.removed_non_effective + report.removed_inactive_product + report.removed_unresolved_product,
        message: `Histórico podado: não efetivas=${report.removed_non_effective}; produto inativo=${report.removed_inactive_product}; produto não resolvido=${report.removed_unresolved_product}; efetivas+ativas preservadas=${report.preserved_effective_active}; abertas preservadas=${report.preserved_open}`,
        started_at: new Date().toISOString(), completed_at: new Date().toISOString(),
      }).catch(() => {});
      reports.push(report);
    }

    return Response.json({
      ok: totals.delete_errors === 0,
      dry_run: dryRun,
      policy: 'preserve_open_or_effective_and_active_product; prune_terminal_non_effective_and_inactive_or_unresolved_product',
      max_delete_per_run: maxDelete,
      totals,
      accounts: reports.map(r => ({ ...r, candidates: r.candidates.slice(0, 100) })),
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});
