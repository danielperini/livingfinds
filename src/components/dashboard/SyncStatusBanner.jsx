import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { AlertTriangle, WifiOff, Clock, CheckCircle, RefreshCw, X, ChevronDown, ChevronUp } from 'lucide-react';

const STATUS_CONFIG = {
  ok: {
    icon: CheckCircle,
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10 border-emerald-500/20',
    label: 'Sincronização OK',
  },
  stale: {
    icon: Clock,
    color: 'text-amber-400',
    bg: 'bg-amber-500/10 border-amber-500/25',
    label: 'Dados desatualizados',
  },
  error: {
    icon: AlertTriangle,
    color: 'text-red-400',
    bg: 'bg-red-500/10 border-red-500/25',
    label: 'Falha na sincronização',
  },
  rate_limit: {
    icon: WifiOff,
    color: 'text-orange-400',
    bg: 'bg-orange-500/10 border-orange-500/25',
    label: 'Limite de chamadas atingido',
  },
};

function timeAgo(dateStr) {
  if (!dateStr) return null;
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60) return `${diff}s atrás`;
  if (diff < 3600) return `${Math.floor(diff / 60)}min atrás`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h atrás`;
  return `${Math.floor(diff / 86400)}d atrás`;
}

export default function SyncStatusBanner({ accountId }) {
  const [status, setStatus] = useState(null); // null = loading
  const [logs, setLogs] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    loadStatus();
    const interval = setInterval(loadStatus, 5 * 60 * 1000); // refresh a cada 5 min
    return () => clearInterval(interval);
  }, [accountId]);

  async function loadStatus() {
    try {
      const recentLogs = await base44.entities.SyncExecutionLog.filter(
        { amazon_account_id: accountId },
        '-started_at',
        10
      );
      setLogs(recentLogs);

      if (recentLogs.length === 0) {
        setStatus('stale');
        return;
      }

      const latest = recentLogs[0];
      const ageHours = (Date.now() - new Date(latest.started_at || latest.created_date).getTime()) / 3600000;

      // Rate limit: qualquer log recente com erro contendo "rate" ou "429"
      const hasRateLimit = recentLogs.slice(0, 3).some(
        l => l.status === 'error' && /rate.?limit|429|too many/i.test(l.error_message || '')
      );
      if (hasRateLimit) { setStatus('rate_limit'); return; }

      // Erro recente
      if (latest.status === 'error') { setStatus('error'); return; }

      // Dados velhos (sem sync bem-sucedido nas últimas 3 horas)
      const lastSuccess = recentLogs.find(l => l.status === 'success' || l.status === 'skipped_limit');
      if (!lastSuccess) { setStatus('error'); return; }

      const lastSuccessAge = (Date.now() - new Date(lastSuccess.started_at || lastSuccess.created_date).getTime()) / 3600000;
      if (lastSuccessAge > 3) { setStatus('stale'); return; }

      setStatus('ok');
    } catch {
      // silencioso — não bloquear o dashboard por falha do próprio banner
      setStatus(null);
    }
  }

  // Não mostrar nada enquanto carrega, se OK ou foi dispensado
  if (status === null || dismissed) return null;
  if (status === 'ok') return null;

  const cfg = STATUS_CONFIG[status];
  const Icon = cfg.icon;
  const lastLog = logs[0];
  const lastSuccess = logs.find(l => l.status === 'success' || l.status === 'skipped_limit');
  const errorLogs = logs.filter(l => l.status === 'error');

  return (
    <div className={`rounded-xl border px-4 py-3 ${cfg.bg}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <Icon className={`w-4 h-4 flex-shrink-0 ${cfg.color}`} />
          <div className="min-w-0">
            <span className={`text-sm font-semibold ${cfg.color}`}>{cfg.label}</span>
            {lastSuccess ? (
              <span className="ml-2 text-xs text-slate-500">
                Último sync OK: {timeAgo(lastSuccess.started_at || lastSuccess.created_date)}
              </span>
            ) : (
              <span className="ml-2 text-xs text-slate-500">Nenhum sync bem-sucedido encontrado</span>
            )}
            {lastLog?.error_message && !expanded && (
              <span className="ml-2 text-xs text-slate-400 truncate hidden sm:inline">
                · {lastLog.error_message.slice(0, 80)}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {errorLogs.length > 0 && (
            <button
              onClick={() => setExpanded(v => !v)}
              className="flex items-center gap-1 px-2 py-1 text-xs text-slate-400 hover:text-slate-200 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
            >
              {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {errorLogs.length} erro{errorLogs.length > 1 ? 's' : ''}
            </button>
          )}
          <button
            onClick={loadStatus}
            title="Verificar novamente"
            className="p-1.5 text-slate-400 hover:text-slate-200 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setDismissed(true)}
            title="Dispensar"
            className="p-1.5 text-slate-400 hover:text-slate-200 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Logs expandidos */}
      {expanded && errorLogs.length > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-white/10 pt-3">
          {errorLogs.slice(0, 5).map((log, i) => (
            <div key={i} className="flex items-start gap-2 text-xs">
              <span className="text-slate-500 font-mono flex-shrink-0 w-24 truncate">
                {timeAgo(log.started_at || log.created_date)}
              </span>
              <span className="text-slate-400 font-medium flex-shrink-0">{log.operation}</span>
              <span className="text-red-400 truncate">{log.error_message || 'Erro desconhecido'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}