import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

/**
 * runDailyMasterOrchestrator v5
 *
 * Arquitetura: fila com cadência controlada — sem janelas horárias fixas.
 * - Responde em < 5s (fire-and-forget com log de despacho)
 * - Cada etapa tem TTL diário via SyncExecutionLog
 * - Sem `await wait()` acumulados → zero risco de timeout
 * - Sem referência a "janelas" ou horários específicos
 * - Idempotente: reexecuções no mesmo dia são seguras
 */

function todayBRT() { return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10); }
function nowIso() { return new Date().toISOString(); }

async function wasRunTodaySuccessfully(base44: any, aid: string, operation: string): Promise<boolean> {
  try {
    const logs = await base44.asServiceRole.entities.SyncExecutionLog.filter(
      { amazon_account_id: aid, operation, execution_date: todayBRT(), status: 'success' },
      '-started_at', 1
    );
    return logs.length > 0;
  } catch { return false; }
}

async function hasValidReportJobsToday(base44: any, aid: string): Promise<boolean> {
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

    // ── Resolver conta ────────────────────────────────────────────────────
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(
      { status: 'connected' }, '-updated_date', 1
    ).catch(() => []);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });
    const aid = account.id;
    const bp = { amazon_account_id: aid, _service_role: true };

    // Guard global: já rodou hoje com sucesso?
    if (!force) {
      const alreadyRan = await wasRunTodaySuccessfully(base44, aid, 'daily_master_orchestrator');
      if (alreadyRan) {
        return Response.json({ ok: true, skipped: true, reason: 'already_ran_today', date: today });
      }
    }

    // ── Verificar estado de cada etapa em paralelo ────────────────────────
    const [
      catalogDone, salesDone, allJobsExist,
      campStateDone, invDone, manualTermsDone,
      eval72hDone, backupDone,
    ] = await Promise.all([
      wasRunTodaySuccessfully(base44, aid, 'sync_catalog'),
      wasRunTodaySuccessfully(base44, aid, 'sync_sales'),
      hasValidReportJobsToday(base44, aid),
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

    // ── Montar fila (sem janelas horárias — apenas TTL diário) ────────────
    type Task = { fn: string; payload: object; label: string; ttl?: boolean };
    const queue: Task[] = [];
    const skipped: string[] = [];

    const add = (fn: string, label: string, extra: object = {}, ttl = false) =>
      queue.push({ fn, payload: { ...bp, ...extra }, label, ttl });

    // Sempre: token (idempotente, rápido)
    add('refreshAmazonAdsTokenDailyOrHourly', 'token_refresh');

    // 1x/dia: sincronizações de dados
    if (!catalogDone || force) add('syncProductCatalogV2', 'sync_catalog', {}, true);
    else skipped.push('sync_catalog');

    if (!salesDone || force) add('syncSalesDailyFromReports', 'sync_sales', {}, true);
    else skipped.push('sync_sales');

    // Relatórios: só se não existirem jobs válidos
    if (!allJobsExist || force) add('runDailyFullReportPipeline', 'daily_report_pipeline', { force: true });
    else skipped.push('daily_report_pipeline');

    // Poll: só se há jobs em andamento
    if (hasPending) add('pollAmazonAdsReportJobs', 'poll_report_jobs', { max_jobs: 5 });
    else skipped.push('poll_report_jobs');

    // 1x/dia: estados de campanha
    if (!campStateDone || force) {
      add('syncAdsCampaignStatesV2', 'sync_campaign_states', {}, true);
      add('syncAdGroupsAndKeywords', 'sync_ad_groups_keywords');
    } else skipped.push('sync_campaign_states');

    // 1x/dia: inventário
    if (!invDone || force) add('checkInventoryChangesAndKickoff', 'inventory_kickoff', {}, true);
    else skipped.push('inventory_kickoff');

    // Sempre: motor de decisão + execução (idempotentes)
    add('runUnifiedDecisionEngine', 'decision_engine');
    add('executeApprovedDecisionQueue', 'execute_decisions');

    // Sempre: links + guardrails
    add('fixProductCampaignLinksV2', 'product_links');
    add('runHourlyAdsGuardrails', 'guardrails');

    // 1x/dia
    if (!manualTermsDone || force) add('enforceManualCampaignMinTerms', 'manual_campaign_terms', {}, true);
    else skipped.push('manual_campaign_terms');

    if (!eval72hDone || force) add('evaluateNewCampaigns72h', 'evaluate_new_campaigns_72h', {}, true);
    else skipped.push('evaluate_new_campaigns_72h');

    // Bids iniciais: idempotente, só processa pendentes
    add('applyInitialBidsToAllCampaigns', 'apply_initial_bids', { batch_size: 10 });

    // 1x/dia: backup
    if (!backupDone || force) add('runBackupToDrive', 'daily_backup', { backup_type: 'daily_incremental' }, true);
    else skipped.push('daily_backup');

    // ── Disparar em fire-and-forget com intervalo mínimo entre tarefas ────
    // Intervalo de 800ms entre invocações para evitar sobrecarga da API interna
    // (não bloqueia a resposta — cada invoke retorna imediatamente)
    const TTL_LABELS = new Set(queue.filter(t => t.ttl).map(t => t.label));

    (async () => {
      for (let i = 0; i < queue.length; i++) {
        const t = queue[i];
        if (i > 0) await new Promise(r => setTimeout(r, 800)); // cadência mínima
        base44.asServiceRole.functions.invoke(t.fn, t.payload)
          .then(async (res: any) => {
            const data = res?.data || res || {};
            const ok = data?.ok !== false && !data?.error;
            if (!ok) {
              await base44.asServiceRole.entities.SyncExecutionLog.create({
                amazon_account_id: aid, operation: `orchestrator:fail:${t.label}`,
                trigger_type: 'automatic', status: 'error',
                execution_date: today, started_at: nowIso(), completed_at: nowIso(),
                error_message: (data?.error || 'erro desconhecido').slice(0, 300),
              }).catch(() => {});
            } else if (TTL_LABELS.has(t.label)) {
              await base44.asServiceRole.entities.SyncExecutionLog.create({
                amazon_account_id: aid, operation: t.label,
                trigger_type: 'automatic', status: 'success',
                execution_date: today, started_at: nowIso(), completed_at: nowIso(),
              }).catch(() => {});
            }
          })
          .catch(async (e: any) => {
            await base44.asServiceRole.entities.SyncExecutionLog.create({
              amazon_account_id: aid, operation: `orchestrator:fail:${t.label}`,
              trigger_type: 'automatic', status: 'error',
              execution_date: today, started_at: nowIso(), completed_at: nowIso(),
              error_message: (e?.message || 'invoke failed').slice(0, 300),
            }).catch(() => {});
          });
      }
    })();

    // ── Registrar execução ────────────────────────────────────────────────
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'daily_master_orchestrator',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: 'success',
      execution_date: today,
      started_at: startedAt,
      completed_at: nowIso(),
      duration_ms: Date.now() - t0,
      records_processed: queue.length,
      result_summary: JSON.stringify({
        dispatched: queue.length,
        skipped: skipped.length,
        tasks: queue.map(t => t.label),
        skipped_tasks: skipped,
      }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      orchestrator: 'daily_master_v5',
      account_id: aid,
      date: today,
      dispatched: queue.length,
      skipped: skipped.length,
      tasks: queue.map(t => t.label),
      skipped_tasks: skipped,
      duration_ms: Date.now() - t0,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});