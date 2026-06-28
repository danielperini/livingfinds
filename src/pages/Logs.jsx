import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { xanoRequest, toArray } from '@/lib/useXano';
import { Activity, Loader2, RefreshCw, CheckCircle, XCircle, Clock, Play, AlertCircle } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';

function ReportsPipeline() {
  const [state, setState] = useState('idle');
  const [statusData, setStatusData] = useState(null);

  const loadStatus = async () => {
    try {
      const d = await xanoRequest('GET', '/reports/status');
      setStatusData(d);
    } catch {}
  };

  useEffect(() => { loadStatus(); }, []);

  const runPipeline = async () => {
    setState('loading');
    try {
      await xanoRequest('POST', '/reports/pipeline/run');
      setState('success');
      await loadStatus();
      setTimeout(() => setState('idle'), 4000);
    } catch (err) {
      setState('error');
      setTimeout(() => setState('idle'), 4000);
    }
  };

  const steps = ['request', 'poll', 'download', 'process', 'recalculate', 'analyze'];

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-sm font-semibold text-white">Amazon Reports Pipeline</h2>
          <p className="text-xs text-slate-400 mt-0.5">Dispara o pipeline completo de relatórios Amazon via Xano.</p>
        </div>
        <button onClick={runPipeline} disabled={state === 'loading'}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg transition-colors ${
            state === 'success' ? 'bg-emerald-600/20 text-emerald-400 border border-emerald-600/30' :
            state === 'error' ? 'bg-red-600/20 text-red-400 border border-red-600/30' :
            'bg-cyan hover:bg-cyan/90 text-white'
          } disabled:opacity-60`}>
          {state === 'loading' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          {state === 'loading' ? 'Executando...' : state === 'success' ? 'Iniciado!' : state === 'error' ? 'Erro' : 'Rodar Pipeline Amazon'}
        </button>
      </div>
      {/* Pipeline steps */}
      <div className="flex items-center gap-1 flex-wrap">
        {steps.map((step, i) => (
          <div key={step} className="flex items-center gap-1">
            <span className={`text-xs px-2 py-1 rounded font-medium ${
              statusData?.current_step === step ? 'bg-cyan/20 text-cyan border border-cyan/30' :
              statusData?.completed_steps?.includes(step) ? 'bg-emerald-400/10 text-emerald-400' :
              'bg-surface-2 text-slate-500'
            }`}>{step}</span>
            {i < steps.length - 1 && <span className="text-slate-700">→</span>}
          </div>
        ))}
      </div>
      {statusData && (
        <div className="mt-3 flex items-center gap-3 text-xs text-slate-400">
          {statusData.status && <StatusBadge status={statusData.status} size="xs" />}
          {statusData.last_run && <span>Último run: {new Date(statusData.last_run).toLocaleString('pt-BR')}</span>}
        </div>
      )}
    </div>
  );
}

export default function Logs() {
  const [runs, setRuns] = useState([]);
  const [xanoLogsData, setXanoLogsData] = useState([]);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('syncs');

  const load = async () => {
    setLoading(true);
    try {
      const [r, e, xl] = await Promise.allSettled([
        base44.entities.SyncRun.list('-created_date', 50),
        base44.entities.LearningEvent.list('-created_date', 50),
        xanoRequest('GET', '/logs'),
      ]);
      if (r.status === 'fulfilled') setRuns(r.value);
      if (e.status === 'fulfilled') setEvents(e.value);
      if (xl.status === 'fulfilled') setXanoLogsData(toArray(xl.value, 'logs'));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const tabs = [
    { id: 'syncs', label: `Sincronizações (${runs.length})` },
    { id: 'xano', label: `Xano Logs (${xanoLogsData.length})` },
    { id: 'events', label: `Eventos (${events.length})` },
    { id: 'reports', label: 'Reports Pipeline' },
  ];

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <Activity className="w-5 h-5 text-cyan" />
          </div>
          <h1 className="text-lg font-bold text-white">Logs & Observabilidade</h1>
        </div>
        <button onClick={load} className="flex items-center gap-2 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm rounded-lg transition-colors">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Atualizar
        </button>
      </div>

      <div className="flex border-b border-surface-2 overflow-x-auto">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${tab === t.id ? 'border-cyan text-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-7 h-7 text-cyan animate-spin" /></div>
      ) : tab === 'reports' ? (
        <ReportsPipeline />
      ) : tab === 'syncs' ? (
        runs.length === 0 ? (
          <p className="text-center text-slate-500 py-12 text-sm">Sem registos de sincronização.</p>
        ) : (
          <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2">
                  {['Operação', 'Estado', 'Recebidos', 'Inseridos', 'Duração', 'Erro', 'Data'].map(h => (
                    <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-slate-500 uppercase">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.map(r => (
                  <tr key={r.id} className="border-b border-surface-2/50 hover:bg-surface-2 transition-colors">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        {r.status === 'running' ? <Clock className="w-3.5 h-3.5 text-cyan animate-pulse" /> :
                         r.status === 'success' ? <CheckCircle className="w-3.5 h-3.5 text-emerald-400" /> :
                         <XCircle className="w-3.5 h-3.5 text-red-400" />}
                        <span className="font-medium text-slate-300">{r.operation}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3"><StatusBadge status={r.status} size="xs" /></td>
                    <td className="px-5 py-3 text-slate-400">{r.records_received ?? '—'}</td>
                    <td className="px-5 py-3 text-slate-400">{r.records_upserted ?? '—'}</td>
                    <td className="px-5 py-3 text-slate-400">{r.duration_ms ? `${(r.duration_ms / 1000).toFixed(2)}s` : '—'}</td>
                    <td className="px-5 py-3">
                      {r.error_message && <span className="text-xs text-red-400 truncate max-w-xs block" title={r.error_message}>[{r.error_code}] {r.error_message}</span>}
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-500 whitespace-nowrap">{new Date(r.created_date).toLocaleString('pt-BR')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : tab === 'xano' ? (
        xanoLogsData.length === 0 ? (
          <p className="text-center text-slate-500 py-12 text-sm">Sem logs no Xano.</p>
        ) : (
          <div className="space-y-2">
            {xanoLogsData.map((log, i) => (
              <div key={i} className="bg-surface-1 border border-surface-2 rounded-xl p-4 flex items-start gap-4">
                <div className="w-2 h-2 rounded-full bg-emerald-400 mt-2 flex-shrink-0" />
                <div className="flex-1 text-xs">
                  <div className="flex items-center gap-3 mb-1">
                    <span className="font-semibold text-slate-300">{log.operation || log.type || log.event || `Log ${i + 1}`}</span>
                    {log.created_at && <span className="text-slate-600">{new Date(log.created_at).toLocaleString('pt-BR')}</span>}
                    {log.status && <StatusBadge status={log.status} size="xs" />}
                  </div>
                  <p className="text-slate-500">{log.message || log.details || JSON.stringify(log).slice(0, 200)}</p>
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="space-y-2">
          {events.map(ev => (
            <div key={ev.id} className="bg-surface-1 border border-surface-2 rounded-xl p-4 flex items-start gap-4">
              <div className="w-2 h-2 rounded-full bg-cyan mt-2 flex-shrink-0" />
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-1">
                  <span className="text-xs font-semibold text-slate-300">{ev.event_type}</span>
                  <span className="text-xs text-slate-600">{new Date(ev.created_date).toLocaleString('pt-BR')}</span>
                  {ev.outcome && <StatusBadge status={ev.outcome === 'positive' ? 'success' : ev.outcome === 'negative' ? 'error' : 'pending'} size="xs" />}
                </div>
                <p className="text-xs text-slate-400">{ev.observation}</p>
              </div>
            </div>
          ))}
          {events.length === 0 && <p className="text-center text-slate-500 py-12 text-sm">Sem eventos de aprendizagem.</p>}
        </div>
      )}
    </div>
  );
}