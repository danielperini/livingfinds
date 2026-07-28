import { useState, useEffect } from 'react';
import { Clock } from 'lucide-react';
import { base44 } from '@/api/base44Client';

const REQUIRED_REPORTS = ['spCampaigns', 'spSearchTerm', 'spAdvertisedProduct'];

export default function AutoWindowStatus({ justUpdated = false }) {
  const [lastSync, setLastSync] = useState(null);
  const [lastReportDate, setLastReportDate] = useState(null);
  const [successRate, setSuccessRate] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        const [runs, jobs] = await Promise.all([
          base44.entities.SyncExecutionLog.filter({}, '-started_at', 20).catch(() => []),
          base44.entities.AmazonAdsReportJob.filter({}, '-processed_at', 50).catch(() => []),
        ]);
        const lastRun = runs?.find(run => run.started_at || run.created_date);
        if (lastRun) setLastSync(new Date(lastRun.started_at || lastRun.created_date));

        const latestDate = jobs?.map(job => job.end_date).filter(Boolean).sort().pop();
        if (latestDate) {
          const latestJobs = jobs.filter(job => job.end_date === latestDate);
          const processed = REQUIRED_REPORTS.filter(type =>
            latestJobs.some(job => job.report_type_id === type && job.status === 'processed')
          ).length;
          setSuccessRate(Math.round(processed / REQUIRED_REPORTS.length * 100));
          setLastReportDate(latestDate);
        }
      } catch {}
    }
    load();
  }, [justUpdated]);

  const rateColor = successRate === null ? 'text-slate-500'
    : successRate >= 100 ? 'text-emerald-400'
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
    <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-2 border border-surface-3 rounded-lg transition-all">
      <Clock className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
      <div className="text-[11px] flex items-center gap-1.5 flex-wrap">
        {justUpdated ? (
          <span className="text-emerald-400 font-semibold animate-fade-in">✓ Atualizado</span>
        ) : (
          <>
            <span className="text-slate-400">
              {fmtSync(lastSync) ? `Sync: ${fmtSync(lastSync)}` : 'Aguardando sync'}
            </span>
            <span className={`font-semibold ${rateColor}`}>
              {successRate !== null ? `· ${successRate}% dos relatórios processados` : ''}
            </span>
            {lastReportDate && (
              <span className="text-slate-500">
                · Métricas até: <span className="text-emerald-400/80">{fmtReportDate(lastReportDate)}</span>
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
