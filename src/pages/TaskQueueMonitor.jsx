import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { CheckCircle, XCircle, Clock, Loader2, Play, RefreshCw, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react';

const STATUS_CONFIG = {
  pending:  { label: 'Pendente',   color: 'text-slate-400',   bg: 'bg-slate-500/10  border-slate-500/20'  },
  running:  { label: 'Executando', color: 'text-cyan-400',    bg: 'bg-cyan/10       border-cyan/20',       pulse: true },
  success:  { label: 'Concluído',  color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
  failed:   { label: 'Falhou',     color: 'text-red-400',     bg: 'bg-red-500/10    border-red-500/20'    },
  skipped:  { label: 'Ignorado',   color: 'text-amber-400',   bg: 'bg-amber-500/10  border-amber-500/20'  },
};

function StatusBadge({ status }) {
  const c = STATUS_CONFIG[status] || STATUS_CONFIG.pending;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${c.bg} ${c.color} ${c.pulse ? 'animate-pulse' : ''}`}>
      {status === 'running' && <Loader2 className="w-3 h-3 animate-spin" />}
      {status === 'success' && <CheckCircle className="w-3 h-3" />}
      {status === 'failed'  && <XCircle    className="w-3 h-3" />}
      {status === 'pending' && <Clock      className="w-3 h-3" />}
      {c.label}
    </span>
  );
}

function TaskRow({ task }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-surface-2/50 last:border-0">
      <div
        className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2/40 cursor-pointer transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <span className="text-slate-500 text-xs w-5 text-right font-mono">{task.priority}</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-white truncate">{task.task_name}</p>
          <p className="text-xs text-slate-500 font-mono truncate">{task.function_name}</p>
        </div>
        <StatusBadge status={task.status} />
        {task.duration_ms && (
          <span className="text-xs text-slate-500 tabular-nums">{(task.duration_ms / 1000).toFixed(1)}s</span>
        )}
        {open ? <ChevronUp className="w-4 h-4 text-slate-500 flex-shrink-0" /> : <ChevronDown className="w-4 h-4 text-slate-500 flex-shrink-0" />}
      </div>
      {open && (
        <div className="px-4 pb-3 space-y-2">
          {task.error_message && (
            <div className="flex items-start gap-2 p-2 bg-red-500/10 border border-red-500/20 rounded-lg">
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-red-400 font-mono break-all">{task.error_message}</p>
            </div>
          )}
          {task.result_summary && (
            <pre className="text-[10px] text-slate-400 bg-surface-2 rounded-lg p-3 overflow-x-auto max-h-32 font-mono">
              {(() => { try { return JSON.stringify(JSON.parse(task.result_summary), null, 2); } catch { return task.result_summary; } })()}
            </pre>
          )}
          <div className="flex gap-4 text-[10px] text-slate-500">
            {task.started_at   && <span>Início: {new Date(task.started_at).toLocaleTimeString('pt-BR')}</span>}
            {task.completed_at && <span>Fim: {new Date(task.completed_at).toLocaleTimeString('pt-BR')}</span>}
            <span>Tentativas: {task.attempt_count || 0}/{task.max_attempts || 1}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function TaskQueueMonitor() {
  const [tasks, setTasks]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [running, setRunning]   = useState(false);
  const [runMsg, setRunMsg]     = useState(null);
  const [account, setAccount]   = useState(null);
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().slice(0, 10));

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      const accs = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accs[0] || (await base44.entities.AmazonAccount.list())[0];
      setAccount(acc);
      if (!acc) return;
      const data = await base44.entities.TaskQueue.filter(
        { amazon_account_id: acc.id, scheduled_date: selectedDate }, 'priority', 50
      );
      setTasks(data);
    } finally {
      setLoading(false);
    }
  }, [selectedDate]);

  useEffect(() => { loadTasks(); }, [loadTasks]);

  // Auto-refresh quando há tarefas running
  useEffect(() => {
    const hasRunning = tasks.some(t => t.status === 'running');
    if (!hasRunning) return;
    const timer = setInterval(loadTasks, 5000);
    return () => clearInterval(timer);
  }, [tasks, loadTasks]);

  const runQueue = async () => {
    if (running || !account) return;
    setRunning(true);
    setRunMsg(null);
    try {
      const res = await base44.functions.invoke('runTaskQueue', { amazon_account_id: account.id });
      const d = res?.data || {};
      if (d.ok) {
        setRunMsg({ type: 'success', text: `✅ ${d.tasks_succeeded}/${d.tasks_total} tarefas concluídas (${d.duration_s}s)` });
      } else {
        setRunMsg({ type: 'warn', text: `⚠️ ${d.tasks_failed} falhou(aram). Veja detalhes abaixo.` });
      }
      await loadTasks();
    } catch (e) {
      setRunMsg({ type: 'error', text: e.message });
    } finally {
      setRunning(false);
      setTimeout(() => setRunMsg(null), 15000);
    }
  };

  const resetPending = async () => {
    if (!account) return;
    const failed = tasks.filter(t => t.status === 'failed');
    if (!failed.length) return;
    await Promise.all(failed.map(t => base44.entities.TaskQueue.update(t.id, { status: 'pending', error_message: null })));
    await loadTasks();
  };

  const today = new Date().toISOString().slice(0, 10);
  const counts = tasks.reduce((acc, t) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc; }, {});
  const totalDuration = tasks.filter(t => t.duration_ms).reduce((s, t) => s + t.duration_ms, 0);

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-white">Fila de Tarefas</h1>
          <p className="text-sm text-slate-400 mt-0.5">Execução sequencial com intervalo de 20s entre tarefas</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            type="date"
            value={selectedDate}
            onChange={e => setSelectedDate(e.target.value)}
            className="bg-surface-2 border border-surface-3 text-slate-300 text-sm rounded-lg px-3 py-2"
          />
          <button onClick={loadTasks} disabled={loading} className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {tasks.some(t => t.status === 'failed') && (
            <button onClick={resetPending} className="px-3 py-2 text-sm bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 rounded-lg transition-colors">
              Retentar Falhas
            </button>
          )}
          <button
            onClick={runQueue}
            disabled={running || !account}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold bg-cyan/10 border border-cyan/20 text-cyan hover:bg-cyan/20 rounded-lg transition-colors disabled:opacity-50"
          >
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {running ? 'Executando...' : 'Executar Agora'}
          </button>
        </div>
      </div>

      {runMsg && (
        <div className={`flex items-center gap-2 px-4 py-3 rounded-xl text-sm border ${
          runMsg.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300' :
          runMsg.type === 'warn'    ? 'bg-amber-500/10  border-amber-500/20  text-amber-300'   :
                                      'bg-red-500/10    border-red-500/20    text-red-300'
        }`}>
          {runMsg.text}
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: 'Total',      value: tasks.length,           color: 'text-white'       },
          { label: 'Pendentes',  value: counts.pending  || 0,   color: 'text-slate-400'   },
          { label: 'Executando', value: counts.running  || 0,   color: 'text-cyan-400'    },
          { label: 'Concluídos', value: counts.success  || 0,   color: 'text-emerald-400' },
          { label: 'Falhou',     value: counts.failed   || 0,   color: 'text-red-400'     },
        ].map(k => (
          <div key={k.label} className="bg-surface-1 border border-surface-2 rounded-xl p-4 text-center">
            <p className={`text-2xl font-bold ${k.color}`}>{k.value}</p>
            <p className="text-xs text-slate-500 mt-1">{k.label}</p>
          </div>
        ))}
      </div>

      {/* Estimativa de tempo */}
      {(counts.pending || 0) > 0 && (
        <div className="bg-surface-1 border border-cyan/20 rounded-xl px-4 py-3 flex items-center gap-3 text-sm">
          <Clock className="w-4 h-4 text-cyan flex-shrink-0" />
          <span className="text-slate-300">
            <span className="text-cyan font-semibold">{counts.pending}</span> tarefa(s) pendente(s) ·{' '}
            tempo estimado:{' '}
            <span className="text-white font-semibold">~{Math.ceil(counts.pending * 25 / 60)} min</span>
            {' '}(20s por intervalo + execução)
          </span>
          {totalDuration > 0 && (
            <span className="ml-auto text-slate-500 text-xs">Já executado: {(totalDuration / 1000).toFixed(0)}s</span>
          )}
        </div>
      )}

      {/* Lista de tarefas */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-300">
            Tarefas — {selectedDate === today ? 'Hoje' : selectedDate}
          </h2>
          <span className="text-xs text-slate-500">Ordenado por prioridade</span>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 text-cyan animate-spin" />
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-slate-500">
            <Clock className="w-8 h-8 text-slate-600 mb-2" />
            <p className="text-sm">Nenhuma tarefa para esta data.</p>
            <p className="text-xs mt-1">Clique em "Executar Agora" para criar e rodar as tarefas de hoje.</p>
          </div>
        ) : (
          tasks.map(task => <TaskRow key={task.id} task={task} />)
        )}
      </div>

      {/* Info da automação */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
        <h3 className="text-xs font-semibold text-slate-400 mb-3">Horário das Automações</h3>
        <div className="space-y-2 text-xs">
          {[
            { time: '06:00', label: 'Solicitar relatórios Amazon Ads',   fn: 'autoRequestAndDownloadReports', active: true  },
            { time: '06:40', label: 'Baixar e processar relatórios',     fn: 'scheduledAdsReportPoll',        active: true  },
            { time: '07:10', label: 'Fallback: baixar relatórios',       fn: 'scheduledAdsReportPoll',        active: true  },
            { time: '07:30', label: 'Fila de tarefas (sequencial 20s)',  fn: 'runTaskQueue',                  active: true  },
          ].map((row, i) => (
            <div key={i} className="flex items-center gap-3">
              <span className="w-12 text-right font-mono text-slate-300 font-semibold">{row.time}</span>
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${row.active ? 'bg-emerald-400' : 'bg-slate-600'}`} />
              <span className="text-slate-300 flex-1">{row.label}</span>
              <span className="text-slate-600 font-mono">{row.fn}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}