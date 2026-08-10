import { Clock } from 'lucide-react';
import { getFreshnessLevel, formatRelativeTime, formatExactTimestamp } from '@/lib/freshnessUtils';

/**
 * DataFreshnessBadge
 * Exibe a idade de um dado (timestamp) com cor semântica:
 *   verde  < 6h   (fresh)
 *   amarelo 6-24h (stale)
 *   vermelho >24h ou nulo (critical)
 *
 * Props:
 *   timestamp — ISO string | number | Date | null
 *   label     — texto opcional antes do relativo (ex: "Ads")
 *   variant   — 'full' (default) | 'compact' (só ponto + relativo)
 */
export default function DataFreshnessBadge({ timestamp, label, variant = 'full' }) {
  const { level } = getFreshnessLevel(timestamp);
  const relative = formatRelativeTime(timestamp);
  const exact = formatExactTimestamp(timestamp);

  const dotColor = {
    fresh: 'bg-emerald-500',
    stale: 'bg-amber-500',
    critical: 'bg-red-500',
    unknown: 'bg-slate-400',
  }[level];

  const textColor = {
    fresh: 'text-emerald-600',
    stale: 'text-amber-600',
    critical: 'text-red-600',
    unknown: 'text-slate-400',
  }[level];

  if (variant === 'compact') {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-[10px] font-medium"
        title={`${label ? `${label}: ` : ''}${exact}`}
      >
        <span className={`relative flex w-1.5 h-1.5 ${dotColor} rounded-full${level === 'fresh' ? ' animate-pulse-badge' : ''}`} />
        <span className={textColor}>{relative}</span>
      </span>
    );
  }

  return (
    <span
      className="inline-flex items-center gap-1.5 text-[10px] font-medium"
      title={`${label ? `${label}: ` : ''}${exact}`}
    >
      <Clock className={`w-3 h-3 ${textColor} flex-shrink-0`} />
      {label && <span className="text-slate-400">{label}:</span>}
      <span className={`relative flex w-1.5 h-1.5 ${dotColor} rounded-full flex-shrink-0${level === 'fresh' ? ' animate-pulse-badge' : ''}`} />
      <span className={textColor}>{relative}</span>
    </span>
  );
}