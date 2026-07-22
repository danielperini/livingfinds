import { useState, useEffect } from 'react';
import { Clock } from 'lucide-react';
import { base44 } from '@/api/base44Client';

export default function AutoWindowStatus() {
  const [lastSync, setLastSync] = useState(null);
  const [lastReport, setLastReport] = useState(null);
  const [successRate, setSuccessRate] = useState(null);

  useEffect(() => {
    async function load() {
      try {
        const [runs, jobs] = await Promise.all([
          base44.entities.SyncExecutionLog.filter({}, '-started_at', 20).catch(() => []),
          base44.entities.AmazonAdsReportJob.filter({ status: 'processed' }, '-downloaded_at', 1).catch(() => []),
        ]);

        if (runs?.length) {
          const recent = runs.slice(0, 10);
          const successes = recent.filter(r => r.status === 'success' || r.status === 'skipped_limit').length;
          setSuccessRate(Math.round(successes / recent.length * 100));
          const lastRun = runs.find(r => r.started_at || r.created_date);
          if (lastRun) setLastSync(new Date(lastRun.started_at || lastRun.created_date));
        }

        if (jobs?.length && jobs[0].downloaded_at) {
          setLastReport(new Date(jobs[0].downloaded_at));
        }
      } catch {}
    }
    load();
  }, []);

  const rateColor = successRate === null ? 'text-slate-500'
    : successRate >= 80 ? 'text-emerald-400'
    : successRate >= 50 ? 'text-amber-400'
    : 'text-red-400';

  const fmt = (d) => d
    ? d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-2 border border-surface-3 rounded-lg">
      <Clock className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
      <div className="text-[11px] flex items-center gap-1.5 flex-wrap">
        <span className="text-slate-400">
          {fmt(lastSync) ? `Sync: ${fmt(lastSync)}` : 'Aguardando sync'}
        </span>
        <span className={`font-semibold ${rateColor}`}>
          {successRate !== null ? `· ${successRate}% OK` : ''}
        </span>
        {lastReport && (
          <span className="text-slate-500">
            · Relatório recebido: <span className="text-emerald-400/80">{fmt(lastReport)}</span>
          </span>
        )}
      </div>
    </div>
  );
}