/**
 * MetricsSyncButton — Botão de sync usando apenas runFullSync
 * Fase 1: action=request → importa campanhas + solicita relatórios
 * Fase 2: polling action=download a cada 30s até ready=true
 */
import { useState, useEffect, useRef } from 'react';
import { Loader2, BarChart2, CheckCircle } from 'lucide-react';
import { base44 } from '@/api/base44Client';

export default function MetricsSyncButton({ amazonAccountId, onDone }) {
  const [state, setState] = useState('idle'); // idle | requesting | polling | done | error
  const [message, setMessage] = useState('');
  const [pollCount, setPollCount] = useState(0);
  const pollRef = useRef(null);
  const pendingRef = useRef(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const startSync = async () => {
    if (pollRef.current) clearInterval(pollRef.current);
    setState('requesting');
    setMessage('');
    setPollCount(0);

    try {
      const r1 = await base44.functions.invoke('runFullSync', { amazon_account_id: amazonAccountId, action: 'request' });
      const d1 = r1.data;

      if (!d1?.ok) {
        setState('error');
        setMessage(d1?.message || d1?.amazon_error || 'Erro ao solicitar relatórios');
        setTimeout(() => { setState('idle'); setMessage(''); }, 8000);
        return;
      }

      pendingRef.current = { reportIds: d1.reportIds, syncRunId: d1.syncRunId };
      setState('polling');
      setMessage(`✓ ${d1.campaigns_imported} campanhas. Aguardando relatórios...`);

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
            setMessage(d2?.message || 'Erro ao baixar relatórios');
            setTimeout(() => { setState('idle'); setMessage(''); }, 8000);
            return;
          }

          if (d2.ready) {
            clearInterval(pollRef.current);
            setState('done');
            setMessage(`✓ ${d2.products || 0} produtos · $${(d2.summary?.total_spend || 0).toFixed(2)} spend`);
            onDone?.();
            setTimeout(() => { setState('idle'); setMessage(''); }, 6000);
          } else {
            const pend = Object.entries(d2.pending || {}).map(([k, v]) => `${k}:${v}`).join(' ');
            setMessage(`⏳ Aguardando Amazon (${pollCount * 30}s)... ${pend}`);
          }
        } catch (e) {
          clearInterval(pollRef.current);
          setState('error');
          setMessage(e.message);
          setTimeout(() => { setState('idle'); setMessage(''); }, 8000);
        }
      }, 30000);

    } catch (e) {
      setState('error');
      setMessage(e.message);
      setTimeout(() => { setState('idle'); setMessage(''); }, 8000);
    }
  };

  const isLoading = state === 'requesting' || state === 'polling';

  const colorClass = state === 'done'
    ? 'bg-emerald-600/20 border-emerald-600/30 text-emerald-400'
    : state === 'error'
    ? 'bg-red-600/20 border-red-600/30 text-red-400'
    : 'bg-surface-2 border-surface-3 text-slate-300 hover:text-white';

  const label = state === 'requesting' ? 'Solicitando...'
    : state === 'polling' ? `Aguardando... (${pollCount * 30}s)`
    : state === 'done' ? 'Concluído!'
    : state === 'error' ? 'Erro'
    : 'Sync Amazon Ads 30d';

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={startSync}
        disabled={isLoading}
        className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold border transition-all disabled:opacity-60 ${colorClass}`}
      >
        {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> :
         state === 'done' ? <CheckCircle className="w-3.5 h-3.5" /> :
         <BarChart2 className="w-3.5 h-3.5" />}
        {label}
      </button>
      {message && (
        <p className={`text-xs px-2 ${state === 'error' ? 'text-red-400' : 'text-slate-400'}`}>{message}</p>
      )}
    </div>
  );
}