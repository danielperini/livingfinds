import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Activity, Loader2, RefreshCw, CheckCircle, XCircle, Clock } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';

export default function Logs() {
  const [runs, setRuns] = useState([]);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('syncs');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0];
      const queries = acc
        ? [
            base44.entities.SyncRun.filter({ amazon_account_id: acc.id }, '-started_at', 100),
            base44.entities.LearningEvent.filter({ amazon_account_id: acc.id }, '-created_date', 100),
          ]
        : [
            base44.entities.SyncRun.list('-started_at', 100),
            base44.entities.LearningEvent.list('-created_date', 100),
          ];
      const [r, e] = await Promise.all(queries);
      setRuns(r);
      setEvents(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const tabs = [
    { id: 'syncs', label: `Sincronizações (${runs.length})` },
    { id: 'events', label: `Eventos IA (${events.length})` },
  ];

  const formatOp = (op) => {
    if (!op) return '—';
    if (op.startsWith('adsReports:')) return `Sync Ads 30d — ${op.split(':')[1] || ''}`;
    return op;
  };

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

      <div className="flex border-b border-surface-2">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${tab === t.id ? 'border-cyan text-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-7 h-7 text-cyan animate-spin" /></div>
      ) : tab === 'syncs' ? (
        runs.length === 0 ? (
          <p className="text-center text-slate-500 py-12 text-sm">Sem registos de sincronização.</p>
        ) : (
          <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2">
                  {['Operação', 'Estado', 'Recebidos', 'Inseridos', 'Duração', 'Erro', 'Início'].map(h => (
                    <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
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
                        <span className="font-medium text-slate-300 text-xs">{formatOp(r.operation)}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3"><StatusBadge status={r.status} size="xs" /></td>
                    <td className="px-5 py-3 text-slate-400 text-xs">{r.records_received ?? '—'}</td>
                    <td className="px-5 py-3 text-slate-400 text-xs">{r.records_upserted ?? '—'}</td>
                    <td className="px-5 py-3 text-slate-400 text-xs">{r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
                    <td className="px-5 py-3 max-w-[200px]">
                      {r.error_message && <span className="text-xs text-red-400 truncate block" title={r.error_message}>{r.error_message}</span>}
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-500 whitespace-nowrap">
                      {r.started_at ? new Date(r.started_at).toLocaleString('pt-BR') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        events.length === 0 ? (
          <p className="text-center text-slate-500 py-12 text-sm">Sem eventos de aprendizagem.</p>
        ) : (
          <div className="space-y-2">
            {events.map(ev => (
              <div key={ev.id} className="bg-surface-1 border border-surface-2 rounded-xl p-4 flex items-start gap-4">
                <div className="w-2 h-2 rounded-full bg-cyan mt-2 flex-shrink-0" />
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-1 flex-wrap">
                    <span className="text-xs font-semibold text-slate-300">{ev.event_type}</span>
                    <span className="text-xs text-slate-600">{new Date(ev.created_date).toLocaleString('pt-BR')}</span>
                    {ev.outcome && (
                      <StatusBadge status={ev.outcome === 'positive' ? 'success' : ev.outcome === 'negative' ? 'error' : 'pending'} size="xs" />
                    )}
                  </div>
                  <p className="text-xs text-slate-400">{ev.observation}</p>
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}