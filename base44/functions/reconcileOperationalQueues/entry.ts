import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { productAdsEligibility } from '../../shared/productAdsEligibility.ts';

const RETRYABLE_ERROR = /(\b429\b|rate.?limit|throttl|timeout|timed.?out|network|temporar|\b502\b|\b503\b|\b504\b|\b524\b|connection reset|circuit.?open)/i;
const MAX_ROWS_PER_QUEUE = 500;

function errorText(item: any) {
  return String(item?.last_error || item?.error_code || '').trim();
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
  return ['not_authorized', 'manual_block', 'mapping_conflict'].includes(String(product?.ads_scope_status || '').toLowerCase());
}

function productKey(accountId: string, asin: string) {
  return `${accountId}|${String(asin || '').trim().toUpperCase()}`;
}

async function productsForAccount(base44: any, accountId: string) {
  const rows = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, '-updated_at', 500).catch(() => []);
  return new Map(rows.map((product: any) => [productKey(accountId, product.asin), product]));
}

async function reconcileAccount(base44: any, accountId: string, dryRun: boolean) {
  const products = await productsForAccount(base44, accountId);
  const [kickoff, autoRepair, keywordRepair] = await Promise.all([
    base44.asServiceRole.entities.ProductKickoffQueue.filter({ amazon_account_id: accountId, status: 'failed' }, '-updated_at', MAX_ROWS_PER_QUEUE).catch(() => []),
    base44.asServiceRole.entities.AutoCampaignRepairQueue.filter({ amazon_account_id: accountId, status: 'failed' }, '-updated_at', MAX_ROWS_PER_QUEUE).catch(() => []),
    base44.asServiceRole.entities.KeywordRepairQueue.filter({ amazon_account_id: accountId, status: 'failed' }, '-updated_at', MAX_ROWS_PER_QUEUE).catch(() => []),
  ]);

  const result = { scanned: kickoff.length + autoRepair.length + keywordRepair.length, retried: 0, waiting_stock: 0, cancelled_scope: 0, terminal: 0, proposed: [] as any[] };
  const apply = async (entity: string, id: string, action: string, patch: Record<string, unknown>) => {
    result.proposed.push({ entity, id, action });
    if (!dryRun) await base44.asServiceRole.entities[entity].update(id, patch).catch(() => {});
  };

  const reconcile = async (entity: string, item: any, options: { stockPatch: Record<string, unknown>; scopePatch: Record<string, unknown>; eligibilityPatch: Record<string, unknown> }) => {
    const product = products.get(productKey(accountId, item.asin));
    if (!product) {
      // Sem produto canônico não é sinônimo de falta de estoque. Mantemos a falha
      // visível para reconciliação de catálogo, sem inventar uma ação na Amazon.
      result.terminal++;
      return;
    }
    const eligibility = productAdsEligibility(product);
    if (!eligibility.inStock) {
      result.waiting_stock++;
      await apply(entity, item.id, 'waiting_stock', options.stockPatch);
      return;
    }
    if (isScopeBlocked(product)) {
      result.cancelled_scope++;
      await apply(entity, item.id, 'cancelled_scope', options.scopePatch);
      return;
    }
    if (!eligibility.eligible) {
      result.cancelled_scope++;
      await apply(entity, item.id, 'cancelled_eligibility_guard', options.eligibilityPatch);
      return;
    }
    if (canRetry(item)) {
      result.retried++;
      await apply(entity, item.id, 'retry_scheduled', {
        status: 'scheduled', retryable: true, scheduled_at: retryAt(item), completed_at: null,
        last_error: `Retry automático agendado após erro transitório: ${errorText(item).slice(0, 320)}`,
        error_code: 'retry_scheduled_reconciled',
      });
      return;
    }
    result.terminal++;
  };

  for (const item of kickoff) {
    const product = products.get(productKey(accountId, item.asin));
    const eligibility = productAdsEligibility(product);
    await reconcile('ProductKickoffQueue', item, {
      stockPatch: {
        status: 'waiting_stock', retryable: true, scheduled_at: null, completed_at: null,
        last_error: `Aguardando estoque confirmado (${eligibility.reason}); sem chamada à Amazon.`,
        error_code: 'waiting_stock_reconciled', waiting_stock_since: item.waiting_stock_since || new Date().toISOString(), stock_quantity_at_wait: eligibility.stock,
      },
      scopePatch: {
        status: 'cancelled', retryable: false, completed_at: new Date().toISOString(),
        last_error: `Bloqueio de escopo preservado: ads_scope_status=${product?.ads_scope_status || 'not_authorized'}.`, error_code: 'ads_scope_not_authorized',
      },
      eligibilityPatch: {
        status: 'cancelled', retryable: false, completed_at: new Date().toISOString(),
        last_error: `Kick-off bloqueado pela elegibilidade do produto (${eligibility.reason}).`, error_code: 'ads_product_not_eligible',
      },
    });
  }

  for (const item of autoRepair) {
    const product = products.get(productKey(accountId, item.asin));
    const eligibility = productAdsEligibility(product);
    await reconcile('AutoCampaignRepairQueue', item, {
      stockPatch: {
        status: 'waiting_stock', retryable: true, completed_at: null, scheduled_at: null,
        last_error: `Reparo adiado: ${eligibility.reason}; campanha não será modificada sem estoque.`, error_code: 'waiting_stock_reconciled',
      },
      scopePatch: {
        status: 'cancelled', retryable: false, completed_at: new Date().toISOString(),
        last_error: `Reparo cancelado pelo escopo autorizado (${product?.ads_scope_status || 'not_authorized'}).`, error_code: 'ads_scope_not_authorized',
      },
      eligibilityPatch: {
        status: 'cancelled', retryable: false, completed_at: new Date().toISOString(),
        last_error: `Reparo bloqueado pela elegibilidade do produto (${eligibility.reason}).`, error_code: 'ads_product_not_eligible',
      },
    });
  }

  for (const item of keywordRepair) {
    const product = products.get(productKey(accountId, item.asin));
    const eligibility = productAdsEligibility(product);
    await reconcile('KeywordRepairQueue', item, {
      stockPatch: {
        status: 'waiting_stock', retryable: true, scheduled_at: null, completed_at: null,
        last_error: `Reparo de keyword aguardando estoque (${eligibility.reason}).`, error_code: 'waiting_stock_reconciled',
      },
      scopePatch: {
        status: 'cancelled', retryable: false, completed_at: new Date().toISOString(),
        last_error: `Reparo de keyword cancelado pelo escopo (${product?.ads_scope_status || 'not_authorized'}).`, error_code: 'ads_scope_not_authorized',
      },
      eligibilityPatch: {
        status: 'cancelled', retryable: false, completed_at: new Date().toISOString(),
        last_error: `Reparo de keyword bloqueado pela elegibilidade do produto (${eligibility.reason}).`, error_code: 'ads_product_not_eligible',
      },
    });
  }
  return result;
}

Deno.serve(async (request) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });
    const dryRun = body.dry_run === true;
    const accounts = body.amazon_account_id
      ? [{ id: body.amazon_account_id }]
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 100).catch(() => []);
    const totals = { scanned: 0, retried: 0, waiting_stock: 0, cancelled_scope: 0, terminal: 0 };
    const byAccount: any[] = [];
    for (const account of accounts) {
      const reconciliation = await reconcileAccount(base44, account.id, dryRun);
      byAccount.push({ amazon_account_id: account.id, ...reconciliation });
      for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += reconciliation[key];
      if (!dryRun) {
        await base44.asServiceRole.entities.SyncExecutionLog.create({
          amazon_account_id: account.id, operation: 'reconcile_operational_queues', trigger_type: body.trigger_type || 'scheduler',
          status: reconciliation.terminal ? 'warning' : 'success', started_at: new Date(startedAt).toISOString(), completed_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt, records_processed: reconciliation.scanned,
          result_summary: `retry=${reconciliation.retried}; aguardando_estoque=${reconciliation.waiting_stock}; escopo=${reconciliation.cancelled_scope}; terminais=${reconciliation.terminal}`,
        }).catch(() => {});
      }
    }
    return Response.json({ ok: true, dry_run: dryRun, totals, accounts: byAccount });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});
