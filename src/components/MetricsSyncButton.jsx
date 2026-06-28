/**
 * MetricsSyncButton — Fluxo 2 etapas para sync de métricas Amazon Ads
 * 1. Solicita relatório → obtém reportId
 * 2. Polling a cada 30s até COMPLETED → actualiza campanhas
 */
import { useState, useEffect, useRef } from 'react';
import { RefreshCw, BarChart2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';

const AMAZON_ACCOUNT_ID = '6a40448b9af1241f356e9fcc';

export default function MetricsSyncButton({ onDone }) {
  const [state, setState] = useState('idle'); // idle | requesting | polling | importing | success | error
  const [message, setMessage] = useState('');
  const [reportId, setReportId] = useState(null);
  const pollRef = useRef(null);

  // Limpar intervalo ao desmontar
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const startSync = async () => {
    setState('requesting');
    setMessage('');
    try {
      const res = await base44.functions.invoke('requestAdsReport', { amazon_account_id: AMAZON_ACCOUNT_ID, days: 30 });
      const data = res.data;
      if (!data?.ok) throw new Error(data?.error || 'Erro ao solicitar relatório');
      setReportId(data.reportId);
      setState('polling');
      setMessage('Relatório solicitado. A aguardar processamento...');
      pollForReport(data.reportId);
    } catch (err) {
      setState('error');
      setMessage(err.message);
      setTimeout(() => setState('idle'), 6000);
    }
  };

  const pollForReport = (id) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await base44.functions.invoke('downloadAdsReport', {
          amazon_account_id: AMAZON_ACCOUNT_ID,
          report_id: id,
        });
        const data = res.data;
        if (!data?.ok) throw new Error(data?.error || 'Erro no download');
        if (data.ready) {
          clearInterval(pollRef.current);
          setState('success');
          setMessage(`✓ ${data.records_upserted} campanhas actualizadas`);
          onDone?.();
          setTimeout(() => { setState('idle'); setMessage(''); }, 5000);
        } else {
          setMessage(`A processar (${data.status})...`);
        }
      } catch (err) {
        clearInterval(pollRef.current);
        setState('error');
        setMessage(err.message);
        setTimeout(() => { setState('idle'); setMessage(''); }, 6000);
      }
    }, 30000);
  };

  const isLoading = state === 'requesting' || state === 'polling' || state === 'importing';

  const colorClass = state === 'success'
    ? 'bg-emerald-600/20 border-emerald-600/30 text-emerald-400'
    : state === 'error'
    ? 'bg-red-600/20 border-red-600/30 text-red-400'
    : 'bg-surface-2 border-surface-3 text-slate-300 hover:text-white';

  const label = state === 'requesting' ? 'Solicitando...'
    : state === 'polling' ? 'A aguardar relatório...'
    : state === 'importing' ? 'Importando...'
    : state === 'success' ? 'Métricas actualizadas!'
    : state === 'error' ? 'Erro'
    : 'Sync Métricas 30d';

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={startSync}
        disabled={isLoading}
        className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold border transition-all disabled:opacity-60 ${colorClass}`}
      >
        <BarChart2 className={`w-3.5 h-3.5 ${isLoading ? 'animate-pulse' : ''}`} />
        {label}
      </button>
      {message && state !== 'idle' && (
        <p className={`text-xs px-2 ${state === 'error' ? 'text-red-400' : 'text-slate-400'}`}>{message}</p>
      )}
    </div>
  );
}