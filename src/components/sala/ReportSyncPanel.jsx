import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { RefreshCw, CheckCircle, AlertTriangle, Clock, Loader2, FileText } from 'lucide-react';

const STALE_HOURS = 26;

export default function ReportSyncPanel({ account }) {
  const [lastJob, setLastJob] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  const loadLastJob = async () => {
    if (!account) return;
    setLoading(true);
    try {
      const jobs = await base44.entities.AmazonAdsReportJob.filter(
        { amazon_account_id: account.id },
        '-created_date',
        20
      ).catch(() => []);
      const processed = jobs.find(j =>
        ['processed', 'completed', 'downloaded'].includes(j.status)
      );
      const latest = processed || jobs[0] || null;
      setLastJob(latest);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLastJob();
  }, [account]);

  const forceSync = async () => {
    if (!account || running) return;
    setRunning(true);
    setResult(null);
    try {
      const res = await base44.functions.invoke('runDailyFullReportPipeline', {
        amazon_account_id: account.id,
        force: true,
        _service_role: true,
      });
      const d = res?.data || res;
      if (d?.ok !== false) {
        setResult({
          type: 'success',
          text: `Pipeline iniciada${d?.reports_requested ? ` · ${d.reports_requested} relatório(s) solicitado(s)` : ''}`,
        });
      } else {
        setResult({ type: 'error', text: d?.error || 'Falha ao iniciar pipeline' });
      }
      await loadLastJob();
    } catch (e) {
      setResult({ type: 'error', text: e.message });
    } finally {
      setRunning(false);
      setTimeout(() => setResult(null), 15000);
    }
  };

  const isStale = (() => {
    if (!lastJob) return true;
    const date = lastJob.created_date || lastJob.created_at;
    if (!date) return true;
    return Date.now() - new Date(date).getTime() > STALE_HOURS * 3600 * 1000;
  })();

  const lastJobLabel = (() => {
    if (loading) return 'Verificando...';
    if (!lastJob) return 'Nenhum relatório encontrado';
    const date = lastJob.created_date || lastJob.created_at;
    if (!date) return 'Data desconhecida';
    return new Date(date).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  })();

  return (
    <div className={`flex items-center justify-between gap-4 px-4 py-3 rounded-xl border transition-colors ${
      isStale
        ? 'bg-amber-500/8 border-amber-500/25'
        : 'bg-surface-1 border-surface-2'
    }`}>
      <div className="flex items-center gap-3 min-w-0">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
          isStale ? 'bg-amber-500/15 border border-amber-500/25' : 'bg-emerald-500/15 border border-emerald-500/25'
        }`}>
          {loading ? (
            <Loader2 className="w-4 h-4 text-slate-400 animate-spin" />
          ) : isStale ? (
            <AlertTriangle className="w-4 h-4 text-amber-400" />
          ) : (
            <CheckCircle className="w-4 h-4 text-emerald-400" />
          )}
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold text-white">Pipeline de Relatórios Amazon Ads</p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <Clock className="w-3 h-3 text-slate-500 flex-shrink-0" />
            <span className={`text-[10px] ${isStale ? 'text-amber-400' : 'text-slate-400'}`}>
              Último: {lastJobLabel}
              {isStale && !loading ? ' · ATRASADO' : ''}
            </span>
            {lastJob?.status && (
              <span className={`text-[9px] px-1.5 py-0.5 rounded border font-medium ml-1 ${
                ['processed', 'completed'].includes(lastJob.status)
                  ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
                  : ['pending', 'processing'].includes(lastJob.status)
                  ? 'text-cyan bg-cyan/10 border-cyan/20'
                  : 'text-amber-400 bg-amber-500/10 border-amber-500/20'
              }`}>
                {lastJob.status}
              </span>
            )}
          </div>
          {result && (
            <p className={`text-[10px] mt-0.5 font-medium ${result.type === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>
              {result.text}
            </p>
          )}
        </div>
      </div>

      <button
        onClick={forceSync}
        disabled={running || !account}
        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors disabled:opacity-50 whitespace-nowrap flex-shrink-0 ${
          isStale
            ? 'bg-amber-500/20 border-amber-500/35 text-amber-300 hover:bg-amber-500/30'
            : 'bg-surface-2 border-surface-3 text-slate-300 hover:text-white'
        }`}
      >
        {running ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <RefreshCw className="w-3.5 h-3.5" />
        )}
        {running ? 'Iniciando...' : 'Forçar Sync'}
      </button>
    </div>
  );
}