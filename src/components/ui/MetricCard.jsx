import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import DataFreshnessBadge from '@/components/ui/DataFreshnessBadge';

/**
 * MetricCard — Clean Light Pro.
 * Card branco, border-radius 16px, sombra 0 4px 16px rgba(0,0,0,0.06), padding 20px.
 *
 * Props (novo spec):
 *   label     — rótulo curto (uppercase 11px)
 *   value     — valor principal (string formatada ou número)
 *   trend     — 'up' | 'down' | 'flat' (auto a partir de trendPc se omitido)
 *   trendPct  — número (ex: 12.4) — sinaliza variação vs período anterior
 *   freshness — timestamp ISO para DataFreshnessBadge no rodapé
 *   tone      — 'default' | 'success' | 'warning' | 'danger'
 *   loading   — boolean
 *
 * Compatibilidade reversa: changePct, subvalue, prefix, suffix, glowColor ainda
 * funcionam para não quebrar usos existentes em outras páginas.
 */
export default function MetricCard({
  label,
  value,
  trend,
  trendPct,
  freshness,
  tone = 'default',
  loading = false,
  // legado
  subvalue,
  changePct,
  prefix = '',
  suffix = '',
  glowColor,
}) {
  const pct = trendPct !== undefined ? trendPct : changePct;
  const direction = trend
    || (pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat');

  const isUp = direction === 'up';
  const isDown = direction === 'down';
  const isFlat = direction === 'flat';

  const accentBar = {
    default: 'bg-slate-200',
    success: 'bg-emerald-400',
    warning: 'bg-amber-400',
    danger: 'bg-red-400',
  }[tone] || 'bg-slate-200';

  const trendColor = isUp ? 'text-emerald-600 bg-emerald-50 border-emerald-200'
    : isDown ? 'text-red-600 bg-red-50 border-red-200'
    : 'text-slate-500 bg-slate-50 border-slate-200';

  const formatted = formatValue(value, suffix);

  return (
    <div className="relative bg-theme-card border border-[var(--border-color)] rounded-2xl p-5 shadow-[0_4px_16px_rgba(0,0,0,0.06)] transition-shadow hover:shadow-[0_6px_20px_rgba(0,0,0,0.08)] overflow-hidden">
      <span className={`absolute top-0 left-0 h-full w-0.5 ${accentBar}`} />
      {loading ? (
        <div className="space-y-2.5">
          <div className="h-3 w-24 bg-slate-100 rounded animate-pulse" />
          <div className="h-7 w-32 bg-slate-100 rounded animate-pulse" />
          <div className="h-3 w-16 bg-slate-100 rounded animate-pulse" />
        </div>
      ) : (
        <>
          <p className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">{label}</p>
          <div className="flex items-end gap-2 mt-2">
            <span className="text-[28px] leading-none font-bold text-theme-primary font-display tracking-tight">
              {prefix}{formatted}{suffix}
            </span>
          </div>

          <div className="flex items-center justify-between gap-2 mt-3">
            {pct !== undefined && pct !== null ? (
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold border ${trendColor}`}>
                {isUp ? <TrendingUp className="w-3 h-3" /> : isDown ? <TrendingDown className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
                {isUp ? '+' : ''}{Number(pct).toFixed(1)}%
              </span>
            ) : subvalue ? (
              <span className="text-[11px] text-slate-400">{subvalue}</span>
            ) : (
              <span />
            )}
            {freshness ? <DataFreshnessBadge timestamp={freshness} variant="compact" /> : null}
          </div>
        </>
      )}
    </div>
  );
}

function formatValue(value, suffix) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') {
    return value.toLocaleString('pt-BR', {
      minimumFractionDigits: suffix === '%' ? 1 : 0,
      maximumFractionDigits: 2,
    });
  }
  return value;
}