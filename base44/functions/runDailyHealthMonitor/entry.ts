/**
 * runDailyHealthMonitor v2 — Monitor e autocorreção de execuções diárias
 *
 * Roda a cada hora.
 * - Sem janelas horárias fixas (min_hour_brt removido)
 * - Verifica quais etapas falharam ou não rodaram hoje e retenta
 * - Cadência de 1.5s entre retries para evitar sobrecarga
 * - Máximo 2 retries por etapa por dia
 * - Cria Alert apenas para etapas críticas que esgotaram retries
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

function todayBRT() { return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10); }
function nowIso() { return new Date().toISOString(); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// Etapas monitoradas — sem min_hour_brt; qualquer hora é válida para retry
const REQUIRED_STEPS = [
  { operation: 'token_refresh',              fn: 'refreshAmazonAdsTokenDailyOrHourly', critical: true  },
  { operation: 'sync_catalog',               fn: 'syncProductCatalogV2',               critical: false },
  { operation: 'sync_sales',                 fn: 'syncSalesDailyFromReports',           critical: false },
  { operation: 'daily_report_pipeline',      fn: 'runDailyFullReportPipeline',          critical: true  },
  { operation: 'sync_campaign_states',       fn: 'syncAdsCampaignStatesV2',             critical: true  },
  { operation: 'inventory_kickoff',          fn: 'checkInventoryChangesAndKickoff',     critical: false },
  { operation: 'decision_engine',            fn: 'runUnifiedDecisionEngine',            critical: true  },
  { operation: 'execute_decisions',          fn: 'executeApprovedDecisionQueue',        critical: true  },
  { operation: 'confirm_decisions',          fn: 'confirmExecutedDecisions',            critical: false },
  { operation: 'audit_campaign_states',      fn: 'auditCampaignStateSync',              critical: false },
  { operation: 'product_links',              fn: 'fixProductCampaignLinksV2',           critical: false },
  { operation: 'manual_campaign_terms',      fn: 'enforceManualCampaignMinTerms',       critical: false },
  { operation: 'evaluate_new_campaigns_72h', fn: 'evaluateNewCampaigns72h',             critical: false },
];

const MAX_RETRIES_PER_STEP = 2;

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const today = todayBRT();

    // Resolver conta
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(
      { status: 'connected' }, '-updated_date', 1
    ).catch(() => []);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });
    const aid = account.id;

    // Carregar logs de hoje (único fetch)
    const logsToday = await base44.asServiceRole.entities.SyncExecutionLog.filter(
      { amazon_account_id: aid, execution_date: today },
      '-started_at', 200
    ).catch(() => []);

    // Indexar: última execução por operação
    const logByOp = new Map<string, any>();
    const retriesCount = new Map<string, number>();

    for (const log of logsToday) {
      const op = log.operation;
      if (!logByOp.has(op) || new Date(log.started_at || 0) > new Date(logByOp.get(op).started_at || 0)) {
        logByOp.set(op, log);
      }
      if ((log.trigger_type || '').includes('auto_retry')) {
        retriesCount.set(op, (retriesCount.get(op) || 0) + 1);
      }
    }

    const report: any[] = [];
    const retried: string[] = [];
    const alreadyOk: string[] = [];
    const skippedMaxRetries: string[] = [];

    for (const step of REQUIRED_STEPS) {
      const lastLog = logByOp.get(step.operation);
      const isSuccess = lastLog && ['success', 'completed', 'skipped', 'skipped_limit'].includes(lastLog.status);

      if (isSuccess) {
        alreadyOk.push(step.operation);
        report.push({ operation: step.operation, status: 'ok', last_run: lastLog.started_at });
        continue;
      }

      // Verificar limite de retries
      const retriesDone = retriesCount.get(step.operation) || 0;
      if (retriesDone >= MAX_RETRIES_PER_STEP) {
        skippedMaxRetries.push(step.operation);
        report.push({
          operation: step.operation,
          status: 'max_retries_reached',
          retries: retriesDone,
          last_error: lastLog?.error_message?.slice(0, 200),
        });
        if (step.critical) {
          await base44.asServiceRole.entities.Alert.create({
            amazon_account_id: aid,
            alert_type: 'sync_error',
            alert_family: 'sync',
            severity: 'high',
            status: 'active',
            title: `Automação falhou após ${MAX_RETRIES_PER_STEP} tentativas: ${step.operation}`,
            message: `A etapa "${step.operation}" falhou ${MAX_RETRIES_PER_STEP}x hoje (${today}). Último erro: ${lastLog?.error_message?.slice(0, 300) || 'desconhecido'}`,
            source_function: 'runDailyHealthMonitor',
            first_detected_at: nowIso(),
            last_detected_at: nowIso(),
            deduplication_key: `daily_health_fail_${step.operation}_${today}`,
          }).catch(() => {});
        }
        continue;
      }

      // Retry automático com cadência controlada
      const logStart = nowIso();
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: aid,
        operation: step.operation,
        trigger_type: `auto_retry_${retriesDone + 1}`,
        status: 'started',
        execution_date: today,
        started_at: logStart,
        error_message: `Monitor: retry ${retriesDone + 1}/${MAX_RETRIES_PER_STEP} — ${lastLog ? `último status: ${lastLog.status}` : 'não executado hoje'}`,
      }).catch(() => {});

      let retryOk = false;
      let retryError = '';
      try {
        const res = await base44.asServiceRole.functions.invoke(step.fn, {
          amazon_account_id: aid,
          _service_role: true,
          force: true,
        });
        const data = res?.data || res || {};
        retryOk = data?.ok !== false && !data?.error;
        retryError = data?.error || '';
      } catch (e: any) {
        retryError = e?.message || 'invoke failed';
      }

      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: aid,
        operation: step.operation,
        trigger_type: `auto_retry_${retriesDone + 1}`,
        status: retryOk ? 'success' : 'error',
        execution_date: today,
        started_at: logStart,
        completed_at: nowIso(),
        error_message: retryOk ? undefined : retryError?.slice(0, 300),
      }).catch(() => {});

      retried.push(step.operation);
      report.push({
        operation: step.operation,
        status: retryOk ? 'retried_ok' : 'retried_failed',
        retry_number: retriesDone + 1,
        error: retryOk ? undefined : retryError?.slice(0, 200),
      });

      // Cadência entre retries: evita saturar as APIs
      await sleep(1500);
    }

    // Resumo de saúde
    const allCriticalOk = REQUIRED_STEPS
      .filter(s => s.critical)
      .every(s => alreadyOk.includes(s.operation) || retried.includes(s.operation));

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'daily_health_monitor',
      trigger_type: 'automatic',
      status: allCriticalOk ? 'success' : 'warning',
      execution_date: today,
      started_at: new Date(t0).toISOString(),
      completed_at: nowIso(),
      duration_ms: Date.now() - t0,
      records_processed: retried.length,
      result_summary: JSON.stringify({
        ok: alreadyOk.length,
        retried: retried.length,
        max_retries_reached: skippedMaxRetries.length,
        all_critical_ok: allCriticalOk,
      }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      date: today,
      all_critical_ok: allCriticalOk,
      summary: {
        already_ok: alreadyOk.length,
        retried: retried.length,
        max_retries_reached: skippedMaxRetries.length,
      },
      report,
      duration_ms: Date.now() - t0,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message }, { status: 500 });
  }
});