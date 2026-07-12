/**
 * DataConsistencyBadge
 *
 * Exibe um indicador que confirma se o Dashboard está mostrando
 * os mesmos dados que o motor de IA usa para suas decisões.
 *
 * Verde  = dados frescos, Dashboard e IA sincronizados
 * Âmbar  = dados levemente defasados, motor pode ter rodado com dados diferentes
 * Vermelho = dados desatualizados, motor bloqueado (>48h sem sync)
 */
import { CheckCircle, AlertTriangle, XCircle, RefreshCw, Database } from 'lucide-react';

const QUALITY_CONFIG = {
  fresh: {
    icon: CheckCircle,
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10 border-emerald-500/20',
    dot: 'bg-emerald-400',
    label: 'Dashboard e IA sincronizados',
    short: 'Sincronizado',
  },
  stale: {
    icon: AlertTriangle,
    color: 'text-amber-400',
    bg: 'bg-amber-500/10 border-amber-500/20',
    dot: 'bg-amber-400',
    label: 'Dados defasados — IA pode usar informação diferente do Dashboard',
    short: 'Defasado',
  },
  no_data: {
    icon: XCircle,
    color: 'text-slate-500',
    bg: 'bg-slate-500/10 border-slate-500/20',
    dot: 'bg-slate-600',
    label: 'Sem dados de contexto canônico',
    short: 'Sem dados',
  },
};

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'America/Sao_Paulo',
  });
}

export default function DataConsistencyBadge({ canonicalContext, loading, compact = false }) {
  if (loading) {
    return (
      <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
        <RefreshCw className="w-3 h-3 animate-spin" />
        <span>Verificando consistência...</span>
      </div>
    );
  }

  if (!canonicalContext) {
    const cfg = QUALITY_CONFIG.no_data;
    return (
      <div className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[10px] ${cfg.bg} ${cfg.color}`}>
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${cfg.dot}`} />
        <Database className="w-3 h-3 flex-shrink-0" />
        <span>{cfg.short}</span>
      </div>
    );
  }

  const dq = canonicalContext.data_quality || {};
  const status = dq.status || 'fresh';
  const cfg = QUALITY_CONFIG[status] || QUALITY_CONFIG.fresh;
  const Icon = cfg.icon;

  const settingsSrc = canonicalContext.settings?.source || '—';
  const syncAgeH = dq.ads_sync_age_hours;
  const ageLabel = syncAgeH !== null && syncAgeH !== undefined
    ? syncAgeH < 1 ? 'há < 1h' : `há ${Math.round(syncAgeH)}h`
    : null;

  const motorLabel = dq.motor_would_run
    ? 'Motor ativo'
    : 'Motor bloqueado (sync necessário)';

  if (compact) {
    return (
      <div
        className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[10px] cursor-default ${cfg.bg} ${cfg.color}`}
        title={cfg.label}
      >
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${cfg.dot} ${status === 'fresh' ? 'animate-pulse' : ''}`} />
        <Icon className="w-3 h-3 flex-shrink-0" />
        <span className="hidden sm:inline">{cfg.short}</span>
      </div>
    );
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 px-3 py-2 rounded-xl border text-[10px] ${cfg.bg}`}>
      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${cfg.dot} ${status === 'fresh' ? 'animate-pulse' : ''}`} />
        <Icon className={`w-3 h-3 flex-shrink-0 ${cfg.color}`} />
        <span className={`font-semibold ${cfg.color}`}>{cfg.label}</span>
      </div>
      <div className="flex items-center gap-2 text-slate-500 flex-wrap">
        <span className="flex items-center gap-1">
          <span className="text-slate-600">Metas:</span>
          <span className="text-slate-400">{settingsSrc}</span>
        </span>
        {ageLabel ? (
          <span className="flex items-center gap-1">
            <span className="text-slate-600">Ads sync:</span>
            <span className="text-slate-400">{ageLabel} ({fmtDate(dq.ads_last_sync_at)})</span>
          </span>
        ) : null}
        {dq.sp_api_latest_date ? (
          <span className="flex items-center gap-1">
            <span className="text-slate-600">SP-API:</span>
            <span className="text-slate-400">até {dq.sp_api_latest_date}</span>
          </span>
        ) : null}
        <span className={`font-medium ${dq.motor_would_run ? 'text-emerald-500/80' : 'text-red-400/80'}`}>
          {motorLabel}
        </span>
      </div>
    </div>
  );
}