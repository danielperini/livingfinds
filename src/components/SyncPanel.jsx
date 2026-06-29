/**
 * SyncPanel — Sync completo Amazon Ads usando apenas runFullSync
 * Fase 1: action=request → importa campanhas + solicita relatórios
 * Fase 2: polling action=download a cada 30s até ready=true
 */
import { useState, useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { RefreshCw, CheckCircle, XCircle, Loader2, Database, BarChart2 } from 'lucide-react';

export default function SyncPanel({ amazonAccountId, onDone }) {
  const [state, setState] = useState('idle'); // idle | requesting | polling | done | error
  const [msg, setMsg] = useState('');
  const [detail, setDetail] = useState(null);
  const [pollCount, setPollCount] = useState(0);
  const pollRef = useRef(null);
  const pendingRef = useRef(null);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  const startSync = async () => {
    if (pollRef.current) clearInterval(pollRef.current);
    setState('requesting');
    setMsg('A importar campanhas e solicitar relatórios 30d...');
    setDetail(null);
    setPollCount(0);

    try {
      const r1 = await base44.functions.invoke('runFullSync', { amazon_account_id: amazonAccountId, action: 'request' });
      const d1 = r1.data;

      if (!d1?.ok) {
        setState('error');
        setMsg(d1?.message || d1?.amazon_error || 'Falhou ao iniciar sync');
        setDetail(d1);
        return;
      }

      pendingRef.current = { reportIds: d1.reportIds, syncRunId: d1.syncRunId };
      setState('polling');
      setMsg(`✓ ${d1.campaigns_imported} campanhas importadas. Aguardando relatórios Amazon (5-15 min)...`);

      pollRef.current = setInterval(async () => {
        try {
          const r2 = await base44.functions.invoke('runFullSync', {
            amazon_account_id: amazonAccountId,
            action: 'download',
            ...pendingRef.current,
          });
          const d2 = r2.data;
          setPollCount(p => p + 1);

          if (!d2?.ok) {
            clearInterval(pollRef.current);
            setState('error');
            setMsg(d2?.message || d2?.amazon_error || 'Erro ao baixar relatórios');
            setDetail(d2);
            return;
          }

          if (d2.ready) {
            clearInterval(pollRef.current);
            setState('done');
            setMsg(`✓ ${d2.products || 0} produtos · ${d2.keywords || 0} keywords · Spend $${(d2.summary?.total_spend || 0).toFixed(2)}`);
            setDetail(d2);
            onDone?.();
          } else {
            const pend = Object.entries(d2.pending || {}).map(([k, v]) => `${k}:${v}`).join(' · ');
            setMsg(`⏳ Aguardando relatórios... ${pend || ''}`);
          }
        } catch (e) {
          clearInterval(pollRef.current);
          setState('error');
          setMsg(e.message);
        }
      }, 30000);

    } catch (e) {
      setState('error');
      setMsg(e.message);
    }
  };

  const isRunning = state === 'requesting' || state === 'polling';

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Database className="w-4 h-4 text-cyan" /> Sync Amazon Ads 30d
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">Importa campanhas, produtos, keywords e métricas</p>
        </div>
        <button
          onClick={startSync}
          disabled={isRunning}
          className="flex items-center gap-2 px-4 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60"
        >
          {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {isRunning ? (state === 'requesting' ? 'Solicitando...' : `Aguardando... (${pollCount * 30}s)`) : 'Sync Completo'}
        </button>
      </div>

      {msg && (
        <div className={`flex items-start gap-2 p-3 rounded-lg border text-xs ${
          state === 'done' ? 'border-emerald-400/20 bg-emerald-400/5 text-emerald-300' :
          state === 'error' ? 'border-red-400/20 bg-red-400/5 text-red-300' :
          'border-cyan/20 bg-cyan/5 text-cyan'
        }`}>
          {state === 'done' ? <CheckCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> :
           state === 'error' ? <XCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" /> :
           <Loader2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 animate-spin" />}
          <div className="space-y-1">
            <p>{msg}</p>
            {detail?.download_errors?.length > 0 && (
              <p className="text-amber-400">Avisos: {detail.download_errors.join('; ')}</p>
            )}
            {detail?.amazon_status && (
              <p className="text-red-300">Amazon HTTP {detail.amazon_status}: {detail.amazon_error}</p>
            )}
          </div>
        </div>
      )}

      {state === 'done' && detail?.summary && (
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'Spend', value: `$${(detail.summary.total_spend || 0).toFixed(2)}` },
            { label: 'Vendas', value: `$${(detail.summary.total_sales || 0).toFixed(2)}` },
            { label: 'Cliques', value: (detail.summary.total_clicks || 0).toLocaleString() },
          ].map(m => (
            <div key={m.label} className="bg-surface-2 rounded-lg p-2 text-center">
              <p className="text-xs text-slate-400">{m.label}</p>
              <p className="text-sm font-bold text-white">{m.value}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}