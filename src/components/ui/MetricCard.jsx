import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

export default function MetricCard({ label, value, subvalue, change, changePct, prefix = '', suffix = '', loading = false, glowColor = 'cyan' }) {
  const isPositive = changePct > 0;
  const isNegative = changePct < 0;

  const glowClass = {
    cyan: 'border-cyan/20 hover:border-cyan/40',
    green: 'border-emerald-500/20 hover:border-emerald-500/40',
    amber: 'border-amber-500/20 hover:border-amber-500/40',
    red: 'border-red-500/20 hover:border-red-500/40',
  }[glowColor] || 'border-cyan/20';

  return (
    <div className={`bg-surface-1 border ${glowClass} rounded-xl p-5 transition-all duration-200 group`}>
      <p className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-3">{label}</p>
      {loading ? (
        <div className="space-y-2">
          <div className="h-8 w-32 bg-surface-2 rounded animate-pulse" />
          <div className="h-4 w-20 bg-surface-2 rounded animate-pulse" />
        </div>
      ) : (
        <>
          <div className="flex items-end gap-2 mb-2">
            <span className="text-3xl font-bold text-white font-display">
              {prefix}{typeof value === 'number' ? value.toLocaleString('pt-BR', { minimumFractionDigits: suffix === '%' ? 1 : 0, maximumFractionDigits: 2 }) : value ?? '—'}
              {suffix}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {changePct !== undefined && changePct !== null && (
              <span className={`flex items-center gap-1 text-xs font-semibold ${isPositive ? 'text-emerald-400' : isNegative ? 'text-red-400' : 'text-slate-500'}`}>
                {isPositive ? <TrendingUp className="w-3 h-3" /> : isNegative ? <TrendingDown className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
                {isPositive ? '+' : ''}{changePct?.toFixed(1)}%
              </span>
            )}
            {subvalue && <span className="text-xs text-slate-500">{subvalue}</span>}
          </div>
        </>
      )}
    </div>
  );
}