/**
 * runTaskQueue
 *
 * Orquestrador de fila de tarefas diárias com intervalo de 20s entre cada execução.
 * - Lê tarefas pendentes do dia com status "pending" ordenadas por prioridade
 * - Executa uma a uma via base44.asServiceRole.functions.invoke
 * - Aguarda 20s entre cada tarefa para respeitar rate limits da Amazon Ads API
 * - Atualiza status (running → success/failed) em tempo real
 * - Idempotente: tarefas já executadas hoje são ignoradas
 *
 * Chamado pela automação agendada diária após o download dos relatórios (07:30 BRT).
 * Pode ser invocado manualmente pela página TaskQueueMonitor.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const INTERVAL_MS = 20_000; // 20s entre tarefas

async function invokeFunction(fnName: string, payload: any): Promise<any> {
  const appId = Deno.env.get('BASE44_APP_ID') || '';
  const res = await fetch(`https://api.base44.app/api/apps/${appId}/functions/${fnName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return await res.json().catch(() => ({}));
}

// Tarefas padrão do dia — executadas em ordem de prioridade (menor = primeiro)
const DEFAULT_DAILY_TASKS = [
  { task_name: 'Sync Estados de Campanhas',      function_name: 'syncAdsCampaignStatesV2',         priority: 1, payload: {} },
  { task_name: 'Reparar Campanhas Incompletas',   function_name: 'repairIncompleteAutoCampaigns',    priority: 2, payload: { asins: null } },
  { task_name: 'Fila Reparo AUTO Campaigns',      function_name: 'processAutoCampaignRepairQueueV2', priority: 3, payload: {} },
  { task_name: 'Fila Reparo Keywords EXACT',      function_name: 'processKeywordRepairQueue',        priority: 4, payload: {} },
  { task_name: 'Corrigir Vínculos Produto→Camp',  function_name: 'fixProductCampaignLinksV2',        priority: 5, payload: {} },
  { task_name: 'Smart Bid (CPC-based)',            function_name: 'smartBidFromCpc',                  priority: 6, payload: {} },
  { task_name: 'Calibrar Bids Sem Impressão',     function_name: 'calibrateBidsNoImpressions',       priority: 7, payload: {} },
  { task_name: 'Harvest Search Terms',            function_name: 'harvestConvertedSearchTerms',      priority: 8, payload: {} },
  { task_name: 'Otimização Diária de Bids (IA)',  function_name: 'runDailyAdsOptimization',          priority: 9, payload: { analysis_only: true, execute_actions: false } },
];

Deno.serve(async (req) => {
  const startMs = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Resolver conta
    const accounts = await base44.asServiceRole.entities.AmazonAccount.list('-created_date', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon encontrada' });

    const aid = body.amazon_account_id || account.id;
    const today = new Date().toISOString().slice(0, 10);

    // ── Preencher fila do dia se ainda não foi criada ──
    const existingToday = await base44.asServiceRole.entities.TaskQueue.filter(
      { amazon_account_id: aid, scheduled_date: today }, 'priority', 50
    ).catch(() => []);

    if (existingToday.length === 0) {
      console.log(`[runTaskQueue] Criando ${DEFAULT_DAILY_TASKS.length} tarefas para ${today}...`);
      await base44.asServiceRole.entities.TaskQueue.bulkCreate(
        DEFAULT_DAILY_TASKS.map(t => ({
          ...t,
          amazon_account_id: aid,
          scheduled_date: today,
          status: 'pending',
          attempt_count: 0,
        }))
      );
    }

    // ── Buscar tarefas pendentes do dia ──
    const tasks = await base44.asServiceRole.entities.TaskQueue.filter(
      { amazon_account_id: aid, scheduled_date: today, status: 'pending' },
      'priority', 50
    ).catch(() => []);

    if (tasks.length === 0) {
      return Response.json({ ok: true, message: 'Nenhuma tarefa pendente para hoje', today });
    }

    console.log(`[runTaskQueue] ${tasks.length} tarefa(s) pendente(s) para ${today}`);
    const results: any[] = [];

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      const taskPayload = { ...(task.payload || {}), amazon_account_id: aid, _service_role: true };

      // Marcar como running
      await base44.asServiceRole.entities.TaskQueue.update(task.id, {
        status: 'running',
        started_at: new Date().toISOString(),
        attempt_count: (task.attempt_count || 0) + 1,
      }).catch(() => {});

      console.log(`[runTaskQueue] [${i + 1}/${tasks.length}] Executando: ${task.task_name} (${task.function_name})`);
      const taskStart = Date.now();
      let taskOk = false;
      let taskError = '';
      let taskSummary = '';

      try {
        const res = await invokeFunction(task.function_name, taskPayload);
        const d = res?.data || res || {};
        taskOk = d?.ok !== false && !d?.error;
        taskSummary = JSON.stringify(d).slice(0, 500);
        if (!taskOk) taskError = d?.error || 'Retornou ok=false';
      } catch (e: any) {
        taskError = e?.message || String(e);
        taskOk = false;
      }

      const duration = Date.now() - taskStart;

      // Atualizar status da tarefa
      await base44.asServiceRole.entities.TaskQueue.update(task.id, {
        status: taskOk ? 'success' : 'failed',
        completed_at: new Date().toISOString(),
        duration_ms: duration,
        result_summary: taskSummary,
        error_message: taskError || null,
      }).catch(() => {});

      results.push({ task_name: task.task_name, function_name: task.function_name, ok: taskOk, duration_ms: duration, error: taskError || undefined });
      console.log(`[runTaskQueue] ${taskOk ? '✅' : '❌'} ${task.task_name} (${(duration / 1000).toFixed(1)}s)`);

      // Intervalo de 20s entre tarefas (exceto após a última)
      if (i < tasks.length - 1) {
        console.log(`[runTaskQueue] Aguardando 20s antes da próxima tarefa...`);
        await new Promise(r => setTimeout(r, INTERVAL_MS));
      }
    }

    const succeeded = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;
    const totalMs = Date.now() - startMs;

    console.log(`[runTaskQueue] ✅ Fila concluída: ${succeeded} ok, ${failed} falhou (${(totalMs / 1000).toFixed(0)}s total)`);

    return Response.json({
      ok: failed === 0,
      today,
      tasks_total: results.length,
      tasks_succeeded: succeeded,
      tasks_failed: failed,
      duration_s: (totalMs / 1000).toFixed(1),
      results,
    });

  } catch (err: any) {
    console.error('[runTaskQueue] Erro crítico:', err.message);
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});