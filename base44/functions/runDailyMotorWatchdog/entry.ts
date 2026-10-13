import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { isDecisionExecutionConfirmed, shouldRecoverDailyCycle, shouldRepairSkuCoverage } from '../../shared/canonicalCyclePolicy.ts';

const nowIso = () => new Date().toISOString();
const todayBrt = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const dayBrt = (value: unknown) => value ? new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(String(value))) : '';
const minutesSince = (value: unknown) => {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? Math.max(0, (Date.now() - ms) / 60_000) : Number.POSITIVE_INFINITY;
};
const unwrap = (result: any) => result?.data ?? result;

async function record(base44: any, accountId: string, operation: string, status: string, fields: Record<string, unknown>) {
  return await base44.asServiceRole.entities.SyncExecutionLog.create({
    amazon_account_id: accountId,
    operation,
    trigger_type: 'daily_motor_watchdog',
    status,
    execution_date: todayBrt(),
    started_at: nowIso(),
    completed_at: nowIso(),
    ...fields,
  });
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role && !(await base44.auth.isAuthenticated().catch(() => false))) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 20);
    const reports: any[] = [];

    for (const account of accounts) {
      const accountId = String(account.id);
      const day = todayBrt();
      const [cyclesResult, recoveryResult, coverageResult] = await Promise.all([
        base44.asServiceRole.entities.SyncExecutionLog.filter({
          amazon_account_id: accountId, operation: 'v6sia_canonical_decision_cycle',
        }, '-started_at', 20).then((rows: any[]) => ({ rows, ok: true })).catch((error: any) => ({ rows: [], ok: false, error: error?.message || 'cycle_ledger_unavailable' })),
        base44.asServiceRole.entities.SyncExecutionLog.filter({
          amazon_account_id: accountId, operation: 'daily_motor_watchdog_recovery', execution_date: day,
        }, '-started_at', 10).then((rows: any[]) => ({ rows, ok: true })).catch((error: any) => ({ rows: [], ok: false, error: error?.message || 'recovery_ledger_unavailable' })),
        base44.asServiceRole.entities.SyncExecutionLog.filter({
          amazon_account_id: accountId, operation: 'daily_motor_watchdog_coverage', execution_date: day,
        }, '-started_at', 10).then((rows: any[]) => ({ rows, ok: true })).catch((error: any) => ({ rows: [], ok: false, error: error?.message || 'coverage_ledger_unavailable' })),
      ]);

      if (!cyclesResult.ok || !recoveryResult.ok || !coverageResult.ok) {
        reports.push({ amazon_account_id: accountId, ok: false, status: 'ledger_unavailable', errors: [
          'error' in cyclesResult ? cyclesResult.error : null,
          'error' in recoveryResult ? recoveryResult.error : null,
          'error' in coverageResult ? coverageResult.error : null,
        ].filter(Boolean) });
        continue;
      }

      const cycles = (cyclesResult.rows || []).filter((row: any) => dayBrt(row.completed_at || row.started_at) === day);
      const attempts = recoveryResult.rows || [];
      const coverageAttempts = coverageResult.rows || [];
      const latestCycle = cycles[0];
      const dailyCycleSucceeded = latestCycle?.status === 'success';
      const latestCycleAt = latestCycle?.completed_at || latestCycle?.started_at;
      const brtTime = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date());
      const [hour, minute] = brtTime.split(':').map(Number);
      const due = hour * 60 + minute >= 85;
      const lastRecovery = attempts[0];
      let recovered = false;
      let recoveryResultData: any = null;
      let lock: any = null;

      const shouldRecover = !dailyCycleSucceeded && shouldRecoverDailyCycle({
        due,
        confirmedSuccess: false,
        latestAttemptAgeMinutes: Math.min(minutesSince(latestCycleAt), minutesSince(lastRecovery?.started_at)),
        attemptsToday: attempts.length,
        maxAttempts: 3,
        retryIntervalMinutes: 20,
      });

      if (shouldRecover) {
        const ownerId = crypto.randomUUID();
        const lockResponse = unwrap(await base44.asServiceRole.functions.invoke('acquireAmazonSchedulerLock', {
          _service_role: true,
          amazon_account_id: accountId,
          lock_key: `daily_motor_watchdog:${day}`,
          owner_id: ownerId,
          ttl_ms: 900_000,
        }));
        if (lockResponse?.acquired !== true) {
          reports.push({ amazon_account_id: accountId, ok: false, status: 'recovery_already_running', daily_cycle_status: latestCycle?.status || 'missing' });
          continue;
        }
        lock = { owner_id: ownerId, lock_key: `daily_motor_watchdog:${day}` };
        const attemptId = `${day}-recovery-${attempts.length + 1}`;
        const startedAt = nowIso();
        let run: any;
        try {
          run = unwrap(await base44.asServiceRole.functions.invoke('runCanonicalDecisionCycle', {
            amazon_account_id: accountId,
            _service_role: true,
            dry_run: false,
            daily_close: true,
            trigger_type: 'daily_motor_watchdog_recovery',
            correlation_id: `scheduler-runCanonicalDecisionCycle-${day}`,
          }));
        } catch (error: any) {
          run = { ok: false, error: error?.response?.data?.error || error?.message || 'canonical_cycle_invoke_failed' };
        }
        recovered = run?.ok === true;
        recoveryResultData = { ok: recovered, error: run?.error || null, correlation_id: run?.correlation_id || null };
        await record(base44, accountId, 'daily_motor_watchdog_recovery', recovered ? 'success' : 'error', {
          duration_ms: Date.now() - Date.parse(startedAt),
          error_message: recovered ? null : String(run?.error || 'daily_cycle_not_confirmed').slice(0, 500),
          result_summary: JSON.stringify({ attempt: attempts.length + 1, cycle_status: run?.ok === true ? 'confirmed' : 'unconfirmed', correlation_id: run?.correlation_id || null }),
        }).catch(() => {});
      }

      const cycleConfirmed = dailyCycleSucceeded || recovered;
      let executor: any = { ok: false, skipped: true, reason: 'daily_cycle_not_confirmed' };
      let confirmation: any = { ok: false, skipped: true, reason: 'daily_cycle_not_confirmed' };
      if (cycleConfirmed) {
        try {
          executor = unwrap(await base44.asServiceRole.functions.invoke('executeApprovedDecisionQueue', {
            _service_role: true, amazon_account_id: accountId, max_decisions: 25,
            trigger_type: 'daily_motor_watchdog_e2e',
          }));
        } catch (error: any) {
          executor = { ok: false, error: error?.message || 'decision_executor_failed' };
        }
        try {
          confirmation = unwrap(await base44.asServiceRole.functions.invoke('confirmExecutedDecisions', {
            _service_role: true, amazon_account_id: accountId, trigger_type: 'daily_motor_watchdog_e2e',
          }));
        } catch (error: any) {
          confirmation = { ok: false, error: error?.message || 'decision_confirmation_failed' };
        }
      }

      let campaignSync: any = null;
      if (cycleConfirmed) {
        try {
          campaignSync = unwrap(await base44.asServiceRole.functions.invoke('syncAdsCampaignStatesV2', {
            _service_role: true, amazon_account_id: accountId, trigger_type: 'daily_motor_watchdog_remote_state_refresh',
          }));
        } catch (error: any) {
          campaignSync = { ok: false, error: error?.message || 'remote_campaign_sync_failed' };
        }
      }

      let e2e: any = null;
      let coverageRepair: any = null;
      try {
        e2e = unwrap(await base44.asServiceRole.functions.invoke('auditAdsAutomationE2E', {
          _service_role: true, amazon_account_id: accountId, persist: false, trigger_type: 'daily_motor_watchdog_e2e',
        }));
      } catch (error: any) {
        e2e = { ok: false, error: error?.message || 'e2e_audit_failed', reports: [] };
      }
      let audit = e2e?.reports?.find((row: any) => String(row.amazon_account_id) === accountId) || e2e?.reports?.[0] || null;
      const staleBeforeRefresh = audit?.ads?.stale_inventory_asins || [];
      const unknownBeforeRefresh = audit?.ads?.inventory_unknown_asins || [];
      let stockRefresh: any = null;
      if (staleBeforeRefresh.length || unknownBeforeRefresh.length) {
        try {
          stockRefresh = unwrap(await base44.asServiceRole.functions.invoke('syncProductCatalogV2', {
            _service_role: true, amazon_account_id: accountId, trigger_type: 'daily_motor_watchdog_stale_stock_refresh',
          }));
        } catch (error: any) {
          stockRefresh = { ok: false, error: error?.message || 'stock_refresh_failed' };
        }
        await record(base44, accountId, 'daily_motor_watchdog_stock_refresh', stockRefresh?.ok === true ? 'success' : 'error', {
          records_processed: staleBeforeRefresh.length + unknownBeforeRefresh.length,
          error_message: stockRefresh?.ok === true ? null : String(stockRefresh?.error || 'stock_refresh_not_confirmed').slice(0, 500),
          result_summary: JSON.stringify({ stale_asins_before: staleBeforeRefresh, unknown_asins_before: unknownBeforeRefresh, refreshed: stockRefresh?.ok === true }),
        }).catch(() => {});
        if (stockRefresh?.ok === true) {
          try {
            e2e = unwrap(await base44.asServiceRole.functions.invoke('auditAdsAutomationE2E', {
              _service_role: true, amazon_account_id: accountId, persist: false, trigger_type: 'daily_motor_watchdog_stock_verify',
            }));
            audit = e2e?.reports?.find((row: any) => String(row.amazon_account_id) === accountId) || e2e?.reports?.[0] || audit;
          } catch (error: any) {
            e2e = { ok: false, error: error?.message || 'stock_refresh_verification_failed', reports: [] };
          }
        }
      }
      const missingAsins = Array.isArray(audit?.ads?.missing_auto_asins) ? audit.ads.missing_auto_asins : [];
      const coverageCanRepair = shouldRepairSkuCoverage(missingAsins, coverageAttempts.length, 3) &&
        minutesSince(coverageAttempts[0]?.started_at) >= 20;

      if (coverageCanRepair) {
        let repair: any;
        try {
          repair = unwrap(await base44.asServiceRole.functions.invoke('ensureActiveProductCampaignCoverage', {
            _service_role: true,
            amazon_account_id: accountId,
            dry_run: false,
            max_products: 500,
            lookback_days: 65,
          run_harvest: false,
            trigger_type: 'daily_motor_watchdog_sku_coverage',
          }));
        } catch (error: any) {
          repair = { ok: false, error: error?.message || 'coverage_repair_failed' };
        }
        coverageRepair = { ok: repair?.ok === true, missing_before: missingAsins.length, error: repair?.error || null };
        await record(base44, accountId, 'daily_motor_watchdog_coverage', repair?.ok === true ? 'success' : 'error', {
          records_processed: missingAsins.length,
          error_message: repair?.ok === true ? null : String(repair?.error || 'coverage_repair_not_confirmed').slice(0, 500),
          result_summary: JSON.stringify({ missing_asins: missingAsins, repair: coverageRepair }).slice(0, 4000),
        }).catch(() => {});
        if (repair?.ok === true) {
          try {
            campaignSync = unwrap(await base44.asServiceRole.functions.invoke('syncAdsCampaignStatesV2', {
              _service_role: true, amazon_account_id: accountId, trigger_type: 'daily_motor_watchdog_post_repair_sync',
            }));
            e2e = unwrap(await base44.asServiceRole.functions.invoke('auditAdsAutomationE2E', {
              _service_role: true, amazon_account_id: accountId, persist: false, trigger_type: 'daily_motor_watchdog_verify',
            }));
          } catch (error: any) {
            campaignSync = { ok: false, error: error?.message || 'post_repair_campaign_sync_failed' };
            e2e = { ok: false, error: error?.message || 'coverage_verification_failed', reports: [] };
          }
        }
      }

      const verifiedAudit = e2e?.reports?.find((row: any) => String(row.amazon_account_id) === accountId) || e2e?.reports?.[0] || null;
      const remainingGaps = verifiedAudit?.ads?.missing_auto_asins || [];
      const staleInventoryAsins = verifiedAudit?.ads?.stale_inventory_asins || [];
      const inventoryUnknownAsins = verifiedAudit?.ads?.inventory_unknown_asins || [];
      const executionConfirmed = isDecisionExecutionConfirmed(executor, confirmation);
      const accountOk = cycleConfirmed && executionConfirmed && campaignSync?.ok === true && e2e?.ok === true && remainingGaps.length === 0 && staleInventoryAsins.length === 0 && inventoryUnknownAsins.length === 0;
      const report = {
        amazon_account_id: accountId,
        date: day,
        ok: accountOk,
        daily_cycle: { status: cycleConfirmed ? 'confirmed' : (latestCycle?.status || 'missing'), recovered, recovery: recoveryResultData },
        sku_coverage: {
          health: verifiedAudit?.health || 'unavailable',
          eligible_asins: verifiedAudit?.ads?.eligible_asins ?? null,
          eligible_asin_ids: verifiedAudit?.ads?.eligible_asin_ids || [],
          covered_auto_asins: verifiedAudit?.ads?.covered_auto_asins || [],
          missing_auto_asins_before: missingAsins,
          missing_auto_asins_after: remainingGaps,
          stale_inventory_asins: staleInventoryAsins,
          inventory_unknown_asins: inventoryUnknownAsins,
          stock_refresh: stockRefresh ? { ok: stockRefresh?.ok === true, error: stockRefresh?.error || null } : null,
          repair: coverageRepair,
        },
        execution: {
          executor: executor?.ok === true && executor?.skipped !== true && Number(executor?.failed || 0) === 0 && Number(executor?.remaining || 0) === 0 ? 'confirmed' : (executor?.skipped ? 'skipped' : 'failed'),
          confirmation: confirmation?.ok === true && confirmation?.skipped !== true && Number(confirmation?.divergences || 0) === 0 ? 'confirmed' : (confirmation?.skipped ? 'skipped' : 'failed'),
          executor_error: executor?.ok === true ? null : executor?.error || executor?.reason || null,
          confirmation_error: confirmation?.ok === true ? null : confirmation?.error || confirmation?.reason || null,
        },
        remote_campaign_sync: campaignSync?.ok === true ? 'confirmed' : 'failed',
        remote_campaign_sync_error: campaignSync?.ok === true ? null : campaignSync?.error || null,
        e2e_checked_at: verifiedAudit?.checked_at || null,
      };
      await record(base44, accountId, 'daily_motor_watchdog_e2e', accountOk ? 'success' : 'warning', {
        records_processed: verifiedAudit?.ads?.eligible_asins || 0,
        error_message: accountOk ? null : String([
          !cycleConfirmed ? 'daily_cycle_not_confirmed' : '',
          !executionConfirmed ? `execution_not_confirmed:${executor?.error || confirmation?.error || 'pending_or_divergent'}` : '',
          campaignSync?.ok !== true ? `remote_campaign_sync:${campaignSync?.error || 'not_confirmed'}` : '',
          e2e?.ok !== true ? `e2e_audit:${e2e?.error || 'not_confirmed'}` : '',
          remainingGaps.length ? `sku_coverage_gap:${remainingGaps.join(',')}` : '',
          staleInventoryAsins.length ? `stock_data_stale:${staleInventoryAsins.join(',')}` : '',
          inventoryUnknownAsins.length ? `stock_data_unknown:${inventoryUnknownAsins.join(',')}` : '',
        ].filter(Boolean).join('; ') || 'daily_watchdog_incomplete').slice(0, 500),
        result_summary: JSON.stringify(report).slice(0, 6000),
      }).catch(() => {});
      reports.push(report);
      if (lock) await base44.asServiceRole.functions.invoke('acquireAmazonSchedulerLock', {
        _service_role: true, amazon_account_id: accountId, lock_key: lock.lock_key, owner_id: lock.owner_id, action: 'release',
      }).catch(() => {});
    }

    return Response.json({ ok: reports.length > 0 && reports.every((report) => report.ok), watchdog: 'daily_motor_v6sia', reports });
  } catch (error: any) {
    return Response.json({ ok: false, watchdog: 'daily_motor_v6sia', error: String(error?.message || error).slice(0, 500) }, { status: 500 });
  }
});
