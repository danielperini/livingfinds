/**
 * AdsReportJobsPanel — Painel de status dos relatórios Amazon Ads v3
 */
import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { FileText, Clock, CheckCircle, XCircle, AlertTriangle, RefreshCw, Loader2, AlertCircle } from 'lucide-react';

const STATUS_CONFIG = {
  requested:      { label: 'Solicitado',   color: 'text-blue-400',    bg: 'bg-blue-500/10 border-blue-500/20' },
  pending:        { label: 'Pendente',     color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/20' },
  pending_unknown:{ label: 'Pendente',     color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/20' },
  processing:     { label: 'Processando',  color: 'text-cyan',        bg: 'bg-cyan/10 border-cyan/20' },
  completed:      { label: 'Concluído',    color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
  downloaded:     { label: 'Baixado',      color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
  processed:      { label: 'Processado',   color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
  failed:         { label: 'Falhou',       color: 'text-red-400',     bg: 'bg-red-500/10 border-red-500/20' },
  expired:        { label: 'Expirado',     color: 'text-red-400',     bg: 'bg-red-500/10 border-red-500/20' },
  cancelled:      { label: 'Cancelado',    color: 'text-slate-400',   bg: 'bg-slate-500/10 border-slate-500/20' },
  stale:          { label: 'Travado >3h',  color: 'text-orange-400',  bg: 'bg-orange-500/10 border-orange-500/20' },
  rate_limited:   { label: 'Rate Limited', color: 'text-purple-400',  bg: 'bg-purple-500/10 border-purple-500/20' },
};

function formatRelative(dateStr) {
  if (!dateStr) return '—';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  if (mins < 2) return 'agora';
  if (mins < 60) return `há ${mins} min`;
  if (hours < 24) return `há ${hours}h`;
  return `há ${Math.floor(diff / 86400000)}d`;
}

function formatFuture(dateStr) {
  if (!dateStr) return '—';
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff <= 0) return 'agora';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `em ${mins} min`;
  return `em ${Math.floor(diff / 3600000)}h`;
}

export default function AdsReportJobsPanel({ amazonAccountId }) {
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);

  const loadJobs = async () => {
    if (!amazonAccountId) return;
    setLoading(true);
    const all = await base44.entities.AmazonAdsReportJob.filter(
      { amazon_account_id: amazonAccountId }, '-created_at', 20
    ).catch(() => []);
    setJobs(all);
    setLoading(false);
  };

  useEffect(() => { loadJobs(); }, [amazonAccountId]);

  const runPoll = async () => {
    setPolling(true);
    await base44.functions.invoke('pollAmazonAdsReportJobs', { max_jobs: 5 }).catch(() => {});
    await loadJobs();
    setPolling(false);
  };

  // Contagens por status
  const counts = jobs.reduce((acc, j) => {
    acc[j.status] = (acc[j.status] || 0) + 1;
    return acc;
  }, {});

  const pendingCount = (counts.requested || 0) + (counts.pending || 0) + (counts.pending_unknown || 0) + (counts.processing || 0);
  const staleCount = counts.stale || 0;
  const errorCount = (counts.failed || 0) + (counts.expired || 0);
  const successCount = (counts.processed || 0) + (counts.downloaded || 0) + (counts.completed || 0);

  // Último 429 e 425
  const last429 = jobs.find(j => j.status === 'rate_limited');
  const last425 = jobs.find(j => j.error_message?.includes('425'));

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-slate-400" />
          <span className="text-sm font-semibold text-white">Relatórios Amazon Ads</span>
        </div>
        <button
          onClick={runPoll}
          disabled={polling || loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors disabled:opacity-50"
        >
          {polling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {polling ? 'Checando...' : 'Checar agora'}
        </button>
      </div>

      {/* Contadores rápidos */}
      <div className="grid grid-cols-4 gap-2">
        {[
          { label: 'Em andamento', value: pendingCount, color: 'text-amber-400' },
          { label: 'Processados', value: successCount, color: 'text-emerald-400' },
          { label: 'Travados', value: staleCount, color: 'text-orange-400' },
          { label: 'Com erro', value: errorCount, color: 'text-red-400' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-surface-2 rounded-lg p-2.5 text-center">
            <p className={`text-lg font-bold ${color}`}>{value}</p>
            <p className="text-[10px] text-slate-500">{label}</p>
          </div>
        ))}
      </div>

      {/* Alertas especiais */}
      {staleCount > 0 && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-orange-500/10 border border-orange-500/20">
          <AlertTriangle className="w-4 h-4 text-orange-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-orange-300">
            Relatório pendente há mais de 3 horas. O app tentará recriar uma vez ou solicitar revisão.
          </p>
        </div>
      )}
      {last429 && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-purple-500/10 border border-purple-500/20">
          <AlertCircle className="w-4 h-4 text-purple-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-purple-300">
            A Amazon limitou temporariamente as consultas. Nova tentativa será feita automaticamente {formatFuture(last429.next_poll_at)}.
          </p>
        </div>
      )}

      {/* Lista de jobs */}
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-5 h-5 text-slate-500 animate-spin" />
        </div>
      ) : jobs.length === 0 ? (
        <p className="text-xs text-slate-500 text-center py-6">Nenhum job de relatório encontrado</p>
      ) : (
        <div className="space-y-2">
          {jobs.map(job => {
            const cfg = STATUS_CONFIG[job.status] || STATUS_CONFIG.pending;
            return (
              <div key={job.id} className={`rounded-lg border p-3 ${cfg.bg}`}>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full border ${cfg.bg} ${cfg.color}`}>
                      {cfg.label}
                    </span>
                    <span className="text-xs text-slate-300 font-mono truncate">
                      {job.report_id?.slice(0, 16) || 'sem ID'}…
                    </span>
                  </div>
                  <span className="text-[10px] text-slate-500 flex-shrink-0">
                    {formatRelative(job.created_at)}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px] text-slate-400">
                  <span>Período: {job.start_date} → {job.end_date}</span>
                  <span>Tentativas: {job.poll_attempts || 0}</span>
                  {job.next_poll_at && ['pending', 'processing', 'requested', 'rate_limited'].includes(job.status) && (
                    <span className="text-cyan">Próxima checagem: {formatFuture(job.next_poll_at)}</span>
                  )}
                  {job.records_processed > 0 && (
                    <span className="text-emerald-400">{job.records_processed} registros</span>
                  )}
                  {job.error_message && (
                    <span className="text-red-400 col-span-2 truncate">{job.error_message.slice(0, 80)}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}