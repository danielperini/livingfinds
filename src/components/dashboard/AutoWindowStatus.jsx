import { useState, useEffect, useCallback } from 'react';
import { CalendarClock, CheckCircle2, Clock, Database } from 'lucide-react';
import { base44 } from '@/api/base44Client';

const REQUIRED_REPORTS = ['spCampaigns', 'spSearchTerm', 'spAdvertisedProduct'];

function closedDayBrt() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()).split('-').map(Number);
  const date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export default function AutoWindowStatus({
  justUpdated = false,
  compact = false,
  dashboardUpdatedAt = null,
  nextSyncText = null,
}) {
  const [lastSync, setLastSync] = useState(null);
  const [lastReportDate, setLastReportDate] = useState(null);
  const [successRate, setSuccessRate] = useState(null);

  const load = useCallback(async () => {
    try {
      const targetDate = closedDayBrt();
      const [runs, jobs, metrics] = await Promise.all([
        base44.entities.SyncExecutionLog.filter({}, '-started_at', 20).catch(() => []),
        base44.entities.AmazonAdsReportJob.filter({ end_date: targetDate }, '-updated_date', 300).catch(() => []),
        base44.entities.CampaignMetricsDaily.list('-date', 1).catch(() => []),
      ]);
      const lastRun = runs?.find(run => run.started_at || run.created_date);
      setLastSync(lastRun ? new Date(lastRun.started_at || lastRun.created_date) : null);

      const processed = REQUIRED_REPORTS.filter(type =>
        jobs.some(job => job.report_type_id === type && job.status === 'processed')
      ).length;
      setSuccessRate(Math.round(processed / REQUIRED_REPORTS.length * 100));
      setLastReportDate(metrics?.[0]?.date || (processed ? targetDate : null));
    } catch {}
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 60_000);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, justUpdated]);

  const rateColor = successRate === null ? 'text-slate-500'
    : successRate === 100 ? 'text-emerald-400'
    : successRate >= 50 ? 'text-amber-400'
    : 'text-red-400';
  const fmtSync = date => date
    ? date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : null;
  const fmtReportDate = date => {
    const [year, month, day] = String(date || '').split('-');
    return year && month && day ? `${day}/${month}/${year}` : null;
  };

  return (
    <div className={`bg-surface-2 border border-surface-3 rounded-xl px-4 py-3 transition-all ${compact ? 'max-w-full' : 'min-w-[310px]'}`}>
      <div className="flex items-center justify-between gap-3 mb-2.5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Atualização dos dados</p>
        {justUpdated && <span className="text-[10px] text-emerald-400 font-semibold">✓ Atualizado</span>}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-2 text-[11px]">
        {dashboardUpdatedAt && (
          <div className="flex items-start gap-2">
            <Database className="w-3.5 h-3.5 text-cyan mt-0.5 flex-shrink-0" />
            <div><p className="text-slate-600 text-[9px] uppercase">Dados do painel</p><p className="text-slate-300">{dashboardUpdatedAt}</p></div>
          </div>
        )}
        {!compact && (
          <div className="flex items-start gap-2">
            <Clock className="w-3.5 h-3.5 text-slate-500 mt-0.5 flex-shrink-0" />
            <div><p className="text-slate-600 text-[9px] uppercase">Última execução</p><p className="text-slate-300">{fmtSync(lastSync) || 'Aguardando sync'}</p></div>
          </div>
        )}
        <div className="flex items-start gap-2">
          <CheckCircle2 className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${rateColor}`} />
          <div>
            <p className="text-slate-600 text-[9px] uppercase">Relatórios obrigatórios</p>
            <p className={`font-semibold ${rateColor}`}>{successRate !== null ? `${successRate}% processados` : 'Verificando'}</p>
            {lastReportDate && <p className="text-slate-500">Métricas até {fmtReportDate(lastReportDate)}</p>}
          </div>
        </div>
        {nextSyncText && (
          <div className="flex items-start gap-2">
            <CalendarClock className="w-3.5 h-3.5 text-amber-400 mt-0.5 flex-shrink-0" />
            <div><p className="text-slate-600 text-[9px] uppercase">Próxima sincronização</p><p className="text-amber-300">{nextSyncText}</p></div>
          </div>
        )}
      </div>
    </div>
  );
}
