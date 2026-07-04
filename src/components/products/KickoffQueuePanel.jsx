import { AlertTriangle, CheckCircle2, Clock, Loader2, RefreshCw, Rocket, XCircle } from 'lucide-react';

const STATUS_CONFIG = {
  scheduled: {
    label: 'Aguardando janela',
    icon: Clock,
    color: 'text-cyan',
    bg: 'bg-cyan/10 border-cyan/20',
    dot: 'bg-cyan',
  },
  processing: {
    label: 'Enviando para Amazon',
    icon: Loader2,
    color: 'text-amber-400',
    bg: 'bg-amber-400/10 border-amber-400/20',
    dot: 'bg-amber-400',
    spin: true,
  },
  completed: {
    label: 'Concluído',
    icon: CheckCircle2,
    color: 'text-emerald-400',
    bg: 'bg-emerald-400/10 border-emerald-400/20',
    dot: 'bg-emerald-400',
  },
  failed: {
    label: 'Falhou',
    icon: XCircle,
    color: 'text-red-400',
    bg: 'bg-red-400/10 border-red-400/20',
    dot: 'bg-red-400',
  },
};

function QueueRow({ item, onRetry }) {
  const status = String(item?.status || '').toLowerCase();
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.scheduled;
  const Icon = cfg.icon;

  return (
    <div className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${cfg.bg}`}>
      {/* Icon */}
      <div className={`flex-shrink-0 ${cfg.color}`}>
        <Icon className={`w-4 h-4 ${cfg.spin ? 'animate-spin' : ''}`} />
      </div>

      {/* Product info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono font-semibold text-cyan">{item.asin}</span>
          {item.product_name && (
            <span className="text-xs text-slate-400 truncate max-w-[200px]">{item.product_name}</span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5 flex-wrap">
          <span className={`text-[11px] font-semibold ${cfg.color}`}>{cfg.label}</span>
          {item.queue_window && (
            <span className="text-[11px] text-slate-500">Janela: {item.queue_window}</span>
          )}
          {status === 'failed' && item.last_error && (
            <span className="text-[11px] text-red-400/80 truncate max-w-[220px]">{item.last_error}</span>
          )}
        </div>
      </div>

      {/* Retry button for failed */}
      {status === 'failed' && onRetry && (
        <button
          type="button"
          onClick={() => onRetry(item)}
          className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg border bg-cyan/10 border-cyan/25 text-cyan hover:bg-cyan/20 transition-colors"
        >
          <RefreshCw className="w-3 h-3" />
          Reagendar
        </button>
      )}
    </div>
  );
}

export default function KickoffQueuePanel({ queueByAsin, onRetry }) {
  const items = Object.values(queueByAsin || {});

  // Só mostrar itens que não estão completed há muito tempo — mostrar todos exceto sem status
  const visible = items.filter((item) => {
    const s = String(item?.status || '').toLowerCase();
    return ['scheduled', 'processing', 'failed', 'completed'].includes(s);
  });

  // Ordenar: failed primeiro, processing, scheduled, completed por último
  const ORDER = { failed: 0, processing: 1, scheduled: 2, completed: 3 };
  visible.sort((a, b) => {
    const sa = String(a?.status || '').toLowerCase();
    const sb = String(b?.status || '').toLowerCase();
    return (ORDER[sa] ?? 9) - (ORDER[sb] ?? 9);
  });

  if (!visible.length) return null;

  const pendingCount = visible.filter((i) =>
    ['scheduled', 'processing'].includes(String(i?.status || '').toLowerCase())
  ).length;

  const failedCount = visible.filter((i) =>
    String(i?.status || '').toLowerCase() === 'failed'
  ).length;

  return (
    <div className="mx-6 rounded-xl border border-violet-500/20 bg-violet-500/5 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-violet-500/15">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-violet-500/20 border border-violet-500/25 flex items-center justify-center">
            <Rocket className="w-3.5 h-3.5 text-violet-400" />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">Fila de Kick-off</p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {pendingCount > 0 && (
                <span className="text-cyan mr-2">{pendingCount} aguardando execução</span>
              )}
              {failedCount > 0 && (
                <span className="text-red-400">{failedCount} com falha</span>
              )}
              {pendingCount === 0 && failedCount === 0 && (
                <span className="text-emerald-400">Todos concluídos</span>
              )}
            </p>
          </div>
        </div>

        {failedCount > 0 && (
          <div className="flex items-center gap-1.5 text-[11px] text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded-lg px-2.5 py-1">
            <AlertTriangle className="w-3 h-3" />
            {failedCount} {failedCount === 1 ? 'falhou' : 'falharam'}
          </div>
        )}
      </div>

      {/* Items */}
      <div className="p-3 space-y-2 max-h-64 overflow-y-auto scrollbar-thin">
        {visible.map((item) => (
          <QueueRow
            key={item.id || item.asin}
            item={item}
            onRetry={onRetry}
          />
        ))}
      </div>
    </div>
  );
}