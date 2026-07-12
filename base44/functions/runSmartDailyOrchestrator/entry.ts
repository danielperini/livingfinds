/**
 * runSmartDailyOrchestrator — Orquestrador Diário Inteligente v3
 *
 * Retorna < 10s — todas as etapas disparadas em fire-and-forget.
 * Decide o que executar com base no banco (TTL 20h + jobs existentes).
 * Cada etapa tem sua própria automação ou delega a funções especializadas.
 * Em caso de erro, a próxima execução detecta via SyncExecutionLog e tenta novamente.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

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

async function hasValidReportJobsForYesterday(base44: any, aid: string): Promise<boolean> {
  try {
    const yesterday = new Date(Date.now() - 3 * 3600000 - 86400000).toISOString().slice(0, 10);
    const jobs = await base44.asServiceRole.entities.AmazonAdsReportJob.filter(
      { amazon_account_id: aid }, '-created_date', 20
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

Deno.serve(async (req) => {
  const t0 = Date.now();
  const startedAt = nowIso();

  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const force = body.force === true;
    const today = todayBRT();

    // ── Resolver conta ──────────────────────────────────────────────────────
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(
      { status: 'connected' }, '-updated_date', 1
    ).catch(() => []);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });
    const aid = account.id;
    const bp = { amazon_account_id: aid };

    // ── Guard: já rodou hoje? ───────────────────────────────────────────────
    if (!force) {
      const alreadyRan = await wasRunTodaySuccessfully(base44, aid, 'smart_daily_orchestrator');
      if (alreadyRan) {
        return Response.json({ ok: true, skipped: true, reason: 'already_ran_today', date: today });
      }
    }

    // ── Verificar o que precisa ser feito (paralelo, sem await em cima) ─────
    const [
      catalogDone, salesDone, allJobsExist, campStateDone,
      invDone, manualTermsDone, eval72hDone, backupDone
    ] = await Promise.all([
      wasRunTodaySuccessfully(base44, aid, 'sync_catalog'),
      wasRunTodaySuccessfully(base44, aid, 'sync_sales'),
      hasValidReportJobsForYesterday(base44, aid),
      wasRunTodaySuccessfully(base44, aid, 'sync_campaign_states'),
      wasRunTodaySuccessfully(base44, aid, 'inventory_kickoff'),
      wasRunTodaySuccessfully(base44, aid, 'manual_campaign_terms'),
      wasRunTodaySuccessfully(base44, aid, 'evaluate_new_campaigns_72h'),
      wasRunTodaySuccessfully(base44, aid, 'daily_backup'),
    ]);

    // Verificar jobs pending para poll
    const pendingJobs = await base44.asServiceRole.entities.AmazonAdsReportJob.filter(
      { amazon_account_id: aid }, '-created_date', 10
    ).catch(() => []);
    const hasPending = pendingJobs.some((j: any) => ['pending', 'processing'].includes(j.status));

    // ── Montar plano de execução ────────────────────────────────────────────
    const plan: any[] = [];
    const taskQueue: Array<{ fn: string; payload: object; label: string }> = [];

    // Token: sempre
    taskQueue.push({ fn: 'refreshAmazonAdsTokenDailyOrHourly', payload: bp, label: 'token_refresh' });

    // Catálogo: 1x/dia
    if (!catalogDone || force) {
      taskQueue.push({ fn: 'syncProductCatalogV2', payload: bp, label: 'sync_catalog' });
    } else plan.push({ step: 'sync_catalog', skipped: true });

    // Vendas: 1x/dia
    if (!salesDone || force) {
      taskQueue.push({ fn: 'syncProductSalesMetrics', payload: bp, label: 'sync_sales' });
    } else plan.push({ step: 'sync_sales', skipped: true });

    // Relatórios: somente se não existirem jobs válidos
    if ((!allJobsExist) || force) {
      taskQueue.push({ fn: 'runDailyFullReportPipeline', payload: { ...bp, force: true }, label: 'daily_report_pipeline' });
    } else plan.push({ step: 'daily_report_pipeline', skipped: true, reason: 'jobs_exist' });

    // Poll de jobs pendentes
    if (hasPending) {
      taskQueue.push({ fn: 'pollAmazonAdsReportJobs', payload: { ...bp, max_jobs: 5 }, label: 'poll_report_jobs' });
    } else plan.push({ step: 'poll_report_jobs', skipped: true, reason: 'no_pending' });

    // Estados de campanhas: 1x/dia
    if (!campStateDone || force) {
      taskQueue.push({ fn: 'syncAdsCampaignStatesV2', payload: bp, label: 'sync_campaign_states' });
      taskQueue.push({ fn: 'syncAdGroupsAndKeywords', payload: bp, label: 'sync_ad_groups_keywords' });
    } else plan.push({ step: 'sync_campaign_states', skipped: true });

    // Inventário: 1x/dia
    if (!invDone || force) {
      taskQueue.push({ fn: 'checkInventoryChangesAndKickoff', payload: bp, label: 'inventory_kickoff' });
    } else plan.push({ step: 'inventory_kickoff', skipped: true });

    // Motor de decisão: sempre (idempotente internamente)
    taskQueue.push({ fn: 'runUnifiedDecisionEngine', payload: bp, label: 'decision_engine' });

    // Executar decisões aprovadas
    taskQueue.push({ fn: 'executeApprovedDecisionQueue', payload: bp, label: 'execute_decisions' });

    // Links de produto + guardrails: sempre
    taskQueue.push({ fn: 'fixProductCampaignLinksV2', payload: bp, label: 'product_links' });
    taskQueue.push({ fn: 'runHourlyAdsGuardrails', payload: bp, label: 'guardrails' });

    // Termos manuais: 1x/dia
    if (!manualTermsDone || force) {
      taskQueue.push({ fn: 'enforceManualCampaignMinTerms', payload: bp, label: 'manual_campaign_terms' });
    } else plan.push({ step: 'manual_campaign_terms', skipped: true });

    // Avaliação 72h: 1x/dia
    if (!eval72hDone || force) {
      taskQueue.push({ fn: 'evaluateNewCampaigns72h', payload: bp, label: 'evaluate_new_campaigns_72h' });
    } else plan.push({ step: 'evaluate_new_campaigns_72h', skipped: true });

    // Backup: 1x/dia
    if (!backupDone || force) {
      taskQueue.push({ fn: 'runBackupToDrive', payload: { ...bp, backup_type: 'daily_incremental' }, label: 'daily_backup' });
    } else plan.push({ step: 'daily_backup', skipped: true });

    // ── Disparar todas as tarefas em fire-and-forget ────────────────────────
    // Registrar o plano antes de disparar
    const dispatchedAt = nowIso();
    taskQueue.forEach(t => plan.push({ step: t.label, dispatched: true }));

    // Fire-and-forget: não aguardamos resultado (evita timeout do gateway)
    taskQueue.forEach(t => {
      base44.asServiceRole.functions.invoke(t.fn, { _service_role: true, ...t.payload })
        .then(async (res: any) => {
          const data = res?.data || res || {};
          const ok = data?.ok !== false;
          if (!ok) {
            // Análise de erro pela IA (assíncrono, não bloqueia)
            const errMsg = data?.error || 'unknown';
            try {
              await base44.asServiceRole.integrations.Core.InvokeLLM({
                prompt: `LivingFinds motor — Erro na etapa "${t.label}" conta ${aid} em ${today}.\nErro: ${errMsg}\nAnalise se é recuperável e retorne JSON: {can_retry, root_cause, is_recoverable, priority}.`,
                response_json_schema: {
                  type: 'object',
                  properties: {
                    can_retry: { type: 'boolean' },
                    root_cause: { type: 'string' },
                    is_recoverable: { type: 'boolean' },
                    priority: { type: 'string' },
                  },
                },
              }).then(async (analysis: any) => {
                await base44.asServiceRole.entities.SyncExecutionLog.create({
                  amazon_account_id: aid,
                  operation: `smart_orchestrator:error:${t.label}`,
                  trigger_type: 'automatic',
                  status: analysis?.is_recoverable ? 'warning' : 'error',
                  execution_date: today,
                  started_at: nowIso(),
                  completed_at: nowIso(),
                  error_message: `${errMsg} | root: ${analysis?.root_cause || '?'} | can_retry: ${analysis?.can_retry}`,
                }).catch(() => {});
              }).catch(() => {});
            } catch {}
          } else if (['sync_catalog', 'sync_sales', 'sync_campaign_states', 'inventory_kickoff', 'manual_campaign_terms', 'evaluate_new_campaigns_72h', 'daily_backup'].includes(t.label)) {
            // Registrar sucesso para TTL
            await base44.asServiceRole.entities.SyncExecutionLog.create({
              amazon_account_id: aid,
              operation: t.label,
              trigger_type: 'automatic',
              status: 'success',
              execution_date: today,
              started_at: nowIso(),
              completed_at: nowIso(),
              records_processed: data?.records_processed || data?.updated || 0,
            }).catch(() => {});
          }
        })
        .catch((e: any) => {
          base44.asServiceRole.entities.SyncExecutionLog.create({
            amazon_account_id: aid,
            operation: `smart_orchestrator:error:${t.label}`,
            trigger_type: 'automatic',
            status: 'error',
            execution_date: today,
            started_at: nowIso(),
            completed_at: nowIso(),
            error_message: e?.message?.slice(0, 300) || 'invoke failed',
          }).catch(() => {});
        });
    });

    // ── Registrar execução do orquestrador como sucesso (o resultado é o plano) ──
    const duration_ms = Date.now() - t0;
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'smart_daily_orchestrator',
      trigger_type: 'automatic',
      status: 'success',
      execution_date: today,
      started_at: startedAt,
      completed_at: dispatchedAt,
      duration_ms,
      records_processed: taskQueue.length,
      result_summary: JSON.stringify({
        tasks_dispatched: taskQueue.length,
        tasks_skipped: plan.filter(p => p.skipped).length,
        jobs_exist: allJobsExist,
        pending_jobs: hasPending,
      }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      orchestrator: 'smart_daily_v3',
      account_id: aid,
      date: today,
      tasks_dispatched: taskQueue.length,
      tasks_skipped: plan.filter(p => p.skipped).length,
      tasks: taskQueue.map(t => t.label),
      skipped: plan.filter(p => p.skipped).map(p => p.step),
      duration_ms,
      note: 'Todas as tarefas foram disparadas em background. Resultados em SyncExecutionLog.',
    });

  } catch (error: any) {
    console.error('[runSmartDailyOrchestrator]', error.message);
    return Response.json({ ok: false, error: error?.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});