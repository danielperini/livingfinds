/**
 * runSmartDailyOrchestrator — Orquestrador Diário Inteligente v4
 *
 * Retorna < 10s — todas as etapas disparadas em fire-and-forget.
 * Guard TTL: 1x/dia por operação (via SyncExecutionLog).
 * Relatórios: não solicita se jobs do dia já existem.
 * Falhas: loga no SyncExecutionLog e a próxima execução retenta.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

function nowIso() { return new Date().toISOString(); }
function todayBRT() { return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10); }

async function wasRunTodaySuccessfully(base44: any, aid: string, operation: string): Promise<boolean> {
  try {
    const logs = await base44.asServiceRole.entities.SyncExecutionLog.filter(
      { amazon_account_id: aid, operation, execution_date: todayBRT(), status: 'success' },
      '-started_at', 1
    );
    return logs.length > 0;
  } catch { return false; }
}

async function hasValidReportJobsForToday(base44: any, aid: string): Promise<boolean> {
  try {
    const yesterday = new Date(Date.now() - 3 * 3600000 - 86400000).toISOString().slice(0, 10);
    const jobs = await base44.asServiceRole.entities.AmazonAdsReportJob.filter(
      { amazon_account_id: aid }, '-created_date', 30
    );
    const required = ['spCampaigns', 'spSearchTerm', 'spAdvertisedProduct'];
    return required.every(rt =>
      jobs.some((j: any) =>
        j.report_type_id === rt &&
        ['pending', 'processing', 'completed', 'processed'].includes(j.status) &&
        (j.end_date || '') >= yesterday
      )
    );
  } catch { return false; }
}

async function logStep(base44: any, aid: string, operation: string, status: string, msg: string) {
  const today = todayBRT();
  await base44.asServiceRole.entities.SyncExecutionLog.create({
    amazon_account_id: aid,
    operation,
    trigger_type: 'automatic',
    status,
    execution_date: today,
    started_at: nowIso(),
    completed_at: nowIso(),
    error_message: msg?.slice(0, 300) || undefined,
  }).catch(() => {});
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  const startedAt = nowIso();

  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Auth: permite service_role interno OU usuário autenticado
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const force = body.force === true;
    const today = todayBRT();

    // ── Resolver conta ───────────────────────────────────────────────────────
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(
      { status: 'connected' }, '-updated_date', 1
    ).catch(() => []);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });
    const aid = account.id;
    const bp = { amazon_account_id: aid };

    // ── Guard global: já rodou hoje? ─────────────────────────────────────────
    if (!force) {
      const alreadyRan = await wasRunTodaySuccessfully(base44, aid, 'smart_daily_orchestrator');
      if (alreadyRan) {
        return Response.json({ ok: true, skipped: true, reason: 'already_ran_today', date: today });
      }
    }

    // ── Verificar estado de cada etapa em paralelo ───────────────────────────
    const [
      catalogDone, salesDone, allJobsExist, campStateDone,
      invDone, manualTermsDone, eval72hDone, backupDone,
    ] = await Promise.all([
      wasRunTodaySuccessfully(base44, aid, 'sync_catalog'),
      wasRunTodaySuccessfully(base44, aid, 'sync_sales'),
      hasValidReportJobsForToday(base44, aid),
      wasRunTodaySuccessfully(base44, aid, 'sync_campaign_states'),
      wasRunTodaySuccessfully(base44, aid, 'inventory_kickoff'),
      wasRunTodaySuccessfully(base44, aid, 'manual_campaign_terms'),
      wasRunTodaySuccessfully(base44, aid, 'evaluate_new_campaigns_72h'),
      wasRunTodaySuccessfully(base44, aid, 'daily_backup'),
    ]);

    const pendingJobs = await base44.asServiceRole.entities.AmazonAdsReportJob.filter(
      { amazon_account_id: aid }, '-created_date', 10
    ).catch(() => []);
    const hasPending = pendingJobs.some((j: any) => ['pending', 'processing'].includes(j.status));

    // ── Montar fila de tarefas ───────────────────────────────────────────────
    type Task = { fn: string; payload: object; label: string; isTtlStep?: boolean };
    const taskQueue: Task[] = [];
    const skipped: string[] = [];

    const push = (fn: string, label: string, extra: object = {}, isTtlStep = false) =>
      taskQueue.push({ fn, payload: { _service_role: true, ...bp, ...extra }, label, isTtlStep });

    // Token: sempre
    push('refreshAmazonAdsTokenDailyOrHourly', 'token_refresh');

    // Catálogo: 1x/dia
    if (!catalogDone || force) push('syncProductCatalogV2', 'sync_catalog', {}, true);
    else skipped.push('sync_catalog');

    // Vendas: 1x/dia
    if (!salesDone || force) push('syncSalesDailyFromReports', 'sync_sales', {}, true);
    else skipped.push('sync_sales');

    // Relatórios: só se não existirem jobs válidos (evita duplicatas)
    if (!allJobsExist || force) push('runDailyFullReportPipeline', 'daily_report_pipeline', { force: true });
    else skipped.push('daily_report_pipeline');

    // Poll: só se há jobs pendentes
    if (hasPending) push('pollAmazonAdsReportJobs', 'poll_report_jobs', { max_jobs: 5 });
    else skipped.push('poll_report_jobs');

    // Estados de campanha: 1x/dia
    if (!campStateDone || force) {
      push('syncAdsCampaignStatesV2', 'sync_campaign_states', {}, true);
      push('syncAdGroupsAndKeywords', 'sync_ad_groups_keywords');
    } else skipped.push('sync_campaign_states');

    // Inventário: 1x/dia
    if (!invDone || force) push('checkInventoryChangesAndKickoff', 'inventory_kickoff', {}, true);
    else skipped.push('inventory_kickoff');

    // Motor de decisão: sempre (idempotente)
    push('runUnifiedDecisionEngine', 'decision_engine');
    push('executeApprovedDecisionQueue', 'execute_decisions');

    // Links e guardrails: sempre
    push('fixProductCampaignLinksV2', 'product_links');
    push('runHourlyAdsGuardrails', 'guardrails');

    // Termos manuais: 1x/dia
    if (!manualTermsDone || force) push('enforceManualCampaignMinTerms', 'manual_campaign_terms', {}, true);
    else skipped.push('manual_campaign_terms');

    // Avaliação 72h: 1x/dia
    if (!eval72hDone || force) push('evaluateNewCampaigns72h', 'evaluate_new_campaigns_72h', {}, true);
    else skipped.push('evaluate_new_campaigns_72h');

    // Backup: 1x/dia (já tem automação própria às 02:00, aqui é redundância de segurança)
    if (!backupDone || force) push('runBackupToDrive', 'daily_backup', { backup_type: 'daily_incremental' }, true);
    else skipped.push('daily_backup');

    // ── Disparar todas em fire-and-forget ────────────────────────────────────
    const TTL_STEPS = new Set(taskQueue.filter(t => t.isTtlStep).map(t => t.label));

    taskQueue.forEach(t => {
      base44.asServiceRole.functions.invoke(t.fn, t.payload)
        .then(async (res: any) => {
          const data = res?.data || res || {};
          const ok = data?.ok !== false && !data?.error;
          if (!ok) {
            await logStep(base44, aid, `orchestrator:fail:${t.label}`, 'error', data?.error || 'unknown error');
          } else if (TTL_STEPS.has(t.label)) {
            // Marcar TTL: impede execução duplicada no mesmo dia
            await logStep(base44, aid, t.label, 'success', '');
          }
        })
        .catch(async (e: any) => {
          await logStep(base44, aid, `orchestrator:fail:${t.label}`, 'error', e?.message || 'invoke failed');
        });
    });

    // ── Registrar orquestrador como sucesso ──────────────────────────────────
    const duration_ms = Date.now() - t0;
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'smart_daily_orchestrator',
      trigger_type: 'automatic',
      status: 'success',
      execution_date: today,
      started_at: startedAt,
      completed_at: nowIso(),
      duration_ms,
      records_processed: taskQueue.length,
      result_summary: JSON.stringify({
        dispatched: taskQueue.length,
        skipped: skipped.length,
        tasks: taskQueue.map(t => t.label),
        skipped_tasks: skipped,
      }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      orchestrator: 'smart_daily_v4',
      account_id: aid,
      date: today,
      dispatched: taskQueue.length,
      skipped: skipped.length,
      tasks: taskQueue.map(t => t.label),
      skipped_tasks: skipped,
      duration_ms,
    });

  } catch (error: any) {
    console.error('[runSmartDailyOrchestrator]', error.message);
    return Response.json({ ok: false, error: error?.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});