/**
 * runTaskQueue — Processa UMA tarefa pendente por chamada.
 *
 * Design sem timeout:
 * - Cada invocação pega a próxima tarefa "pending" (menor prioridade), executa e atualiza status.
 * - A automação chama a cada 2 minutos; assim 9 tarefas levam ~18 min com pausa natural entre elas.
 * - Idempotente: tarefas já executadas hoje são ignoradas.
 * - action="init" — apenas cria a fila do dia sem executar.
 * - action="run"  — executa a próxima tarefa pendente (default).
 * - action="status" — retorna resumo da fila sem executar.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const DEFAULT_DAILY_TASKS = [
  { task_name: 'Sync Estados de Campanhas',      function_name: 'syncAdsCampaignStatesV2',         priority: 1,  payload: {} },
  { task_name: 'Reparar Campanhas Incompletas',   function_name: 'repairIncompleteAutoCampaigns',    priority: 2,  payload: {} },
  { task_name: 'Fila Reparo AUTO Campaigns',      function_name: 'processAutoCampaignRepairQueueV2', priority: 3,  payload: {} },
  { task_name: 'Fila Reparo Keywords EXACT',      function_name: 'processKeywordRepairQueue',        priority: 4,  payload: {} },
  { task_name: 'Corrigir Vínculos Produto→Camp',  function_name: 'fixProductCampaignLinksV2',        priority: 5,  payload: {} },
  { task_name: 'Smart Bid (CPC-based)',            function_name: 'smartBidFromCpc',                  priority: 6,  payload: {} },
  { task_name: 'Calibrar Bids Sem Impressão',     function_name: 'calibrateBidsNoImpressions',       priority: 7,  payload: {} },
  { task_name: 'Harvest Search Terms',            function_name: 'harvestConvertedSearchTerms',      priority: 8,  payload: {} },
  { task_name: 'Otimização Diária de Bids (IA)',  function_name: 'runDailyAdsOptimization',          priority: 9,  payload: { analysis_only: true, execute_actions: false } },
];

async function invokeFunction(fnName: string, payload: any): Promise<any> {
  const appId = Deno.env.get('BASE44_APP_ID') || '';
  const res = await fetch(`https://api.base44.app/api/apps/${appId}/functions/${fnName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 300) }; }
}

async function ensureQueueCreated(base44: any, aid: string, today: string) {
  const existing = await base44.asServiceRole.entities.TaskQueue.filter(
    { amazon_account_id: aid, scheduled_date: today }, 'priority', 50
  ).catch(() => []);

  if (existing.length === 0) {
    await base44.asServiceRole.entities.TaskQueue.bulkCreate(
      DEFAULT_DAILY_TASKS.map(t => ({
        ...t,
        amazon_account_id: aid,
        scheduled_date: today,
        status: 'pending',
        attempt_count: 0,
        max_attempts: 1,
      }))
    );
    console.log(`[runTaskQueue] Fila criada: ${DEFAULT_DAILY_TASKS.length} tarefas para ${today}`);
    return DEFAULT_DAILY_TASKS.length;
  }
  return existing.length;
}

Deno.serve(async (req) => {
  const startMs = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const action = body.action || 'run';

    // Resolver conta
    const accounts = await base44.asServiceRole.entities.AmazonAccount.list('-created_date', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon encontrada' });

    const aid = body.amazon_account_id || account.id;
    const today = new Date().toISOString().slice(0, 10);

    // Garantir que a fila do dia existe
    await ensureQueueCreated(base44, aid, today);

    // ── STATUS ──
    if (action === 'status' || action === 'init') {
      const allTasks = await base44.asServiceRole.entities.TaskQueue.filter(
        { amazon_account_id: aid, scheduled_date: today }, 'priority', 50
      ).catch(() => []);
      const counts = allTasks.reduce((acc: any, t: any) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc; }, {});
      return Response.json({ ok: true, today, counts, total: allTasks.length, tasks: allTasks });
    }

    // ── RUN: processar a próxima tarefa pendente ──
    const pending = await base44.asServiceRole.entities.TaskQueue.filter(
      { amazon_account_id: aid, scheduled_date: today, status: 'pending' },
      'priority', 1
    ).catch(() => []);

    if (pending.length === 0) {
      // Verificar resumo geral
      const all = await base44.asServiceRole.entities.TaskQueue.filter(
        { amazon_account_id: aid, scheduled_date: today }, 'priority', 50
      ).catch(() => []);
      const counts = all.reduce((acc: any, t: any) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc; }, {});
      return Response.json({ ok: true, message: 'Nenhuma tarefa pendente', today, counts, done: true });
    }

    const task = pending[0];
    const taskPayload = { ...(task.payload || {}), amazon_account_id: aid };

    // Marcar como running
    await base44.asServiceRole.entities.TaskQueue.update(task.id, {
      status: 'running',
      started_at: new Date().toISOString(),
      attempt_count: (task.attempt_count || 0) + 1,
    }).catch(() => {});

    console.log(`[runTaskQueue] Executando: ${task.task_name} (${task.function_name})`);
    const taskStart = Date.now();
    let taskOk = false;
    let taskError = '';
    let taskSummary = '';

    try {
      const res = await invokeFunction(task.function_name, taskPayload);
      const d = res?.data || res || {};
      taskOk = d?.ok !== false && !d?.error;
      taskSummary = JSON.stringify(d).slice(0, 800);
      if (!taskOk) taskError = d?.error || 'Retornou ok=false';
    } catch (e: any) {
      taskError = e?.message || String(e);
    }

    const duration = Date.now() - taskStart;

    await base44.asServiceRole.entities.TaskQueue.update(task.id, {
      status: taskOk ? 'success' : 'failed',
      completed_at: new Date().toISOString(),
      duration_ms: duration,
      result_summary: taskSummary,
      error_message: taskError || null,
    }).catch(() => {});

    // Quantas ainda pendentes?
    const remaining = await base44.asServiceRole.entities.TaskQueue.filter(
      { amazon_account_id: aid, scheduled_date: today, status: 'pending' },
      'priority', 50
    ).catch(() => []);

    console.log(`[runTaskQueue] ${taskOk ? '✅' : '❌'} ${task.task_name} (${(duration/1000).toFixed(1)}s) — ${remaining.length} pendente(s)`);

    return Response.json({
      ok: taskOk,
      today,
      executed: { task_name: task.task_name, function_name: task.function_name, duration_ms: duration, error: taskError || undefined },
      remaining_pending: remaining.length,
      done: remaining.length === 0,
      duration_s: ((Date.now() - startMs) / 1000).toFixed(1),
    });

  } catch (err: any) {
    console.error('[runTaskQueue] Erro crítico:', err.message);
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});