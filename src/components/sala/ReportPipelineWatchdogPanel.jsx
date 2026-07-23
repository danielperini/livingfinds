import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { RefreshCw, CheckCircle, AlertTriangle, Loader2, Clock } from 'lucide-react';

const STALE_HOURS = 26;

export default function ReportPipelineWatchdogPanel({ account }) {
  const [lastJob, setLastJob] = useState(null);
  const [loading, setLoading] = useState(true);
  const [forcing, setForcing] = useState(false);
  const [result, setResult] = useState(null);

  const loadLastJob = async () => {
    if (!account) return;
    setLoading(true);
    try {
      const jobs = await base44.entities.AmazonAdsReportJob.filter(
        { amazon_account_id: account.id },
        '-created_date',
        10
      );
      const processed = jobs.find(j => j.status === 'processed' || j.status === 'completed');
      setLastJob(processed || jobs[0] || null);
    } catch {
      setLastJob(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadLastJob(); }, [account?.id]);

  const forceSync = async () => {
    if (!account || forcing) return;
    setForcing(true);
    setResult(null);
    try {
      const res = await base44.functions.invoke('runDailyFullReportPipeline', {
        amazon_account_id: account.id,
        force: true,
        _service_role: true,
      });
      const d = res?.data || res || {};
      if (d?.ok !== false && !d?.error) {
        const count = d?.reports_requested ?? d?.jobs_created ?? d?.total ?? null;
        setResult({
          type: 'success',
          text: `Pipeline disparada${count != null ? ` · ${count} relatório(s) solicitado(s)` : ''}`,
        });
        await loadLastJob();
      } else {
        setResult({ type: 'error', text: d?.error || 'Falha ao disparar pipeline' });
      }
    } catch (e) {
      setResult({ type: 'error', text: e?.message || 'Erro desconhecido' });
    } finally {
      setForcing(false);
      setTimeout(() => setResult(null), 12000);
    }
  };

  const jobDate = lastJob?.created_date || lastJob?.requested_at || lastJob?.created_at || null;
  const hoursAgo = jobDate ? (Date.now() - new Date(jobDate).getTime()) / 3600000 : null;
  const isStale = hoursAgo === null || hoursAgo > STALE_HOURS;

  return (
    <div className={`flex items-center gap-3 p-3 rounded-xl border transition-colors ${isStale ? 'bg-amber-500/8 border-amber-500/30' : 'bg-surface-1 border-surface-2'}`}>
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${isStale ? 'bg-amber-500/20 border border-amber-500/30' : 'bg-emerald-500/15 border border-emerald-500/25'}`}>
        {isStale
          ? <AlertTriangle className="w-4 h-4 text-amber-400" />
          : <CheckCircle className="w-4 h-4 text-emerald-400" />}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-white">Sync de Relatórios Amazon Ads</p>
        {loading ? (
          <p className="text-[10px] text-slate-500 mt-0.5">Verificando...</p>
        ) : jobDate ? (
          <p className={`text-[10px] mt-0.5 flex items-center gap-1 ${isStale ? 'text-amber-400' : 'text-slate-500'}`}>
            <Clock className="w-3 h-3" />
            Último: {new Date(jobDate).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
            {hoursAgo != null && ` (${hoursAgo < 1 ? '<1h' : `${Math.round(hoursAgo)}h`} atrás)`}
            {isStale && ' — ATRASADO'}
          </p>
        ) : (
          <p className="text-[10px] text-amber-400 mt-0.5">Nenhum job encontrado</p>
        )}
        {result && (
          <p className={`text-[10px] mt-1 font-semibold ${result.type === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>
            {result.text}
          </p>
        )}
      </div>

      <button
        onClick={forceSync}
        disabled={forcing || !account}
        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50 flex-shrink-0 ${isStale ? 'bg-amber-500/20 border border-amber-500/30 text-amber-300 hover:bg-amber-500/30' : 'bg-surface-2 border border-surface-3 text-slate-300 hover:text-white'}`}
      >
        {forcing
          ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
          : <RefreshCw className="w-3.5 h-3.5" />}
        {forcing ? 'Disparando...' : 'Forçar Sync'}
      </button>
    </div>
  );
}