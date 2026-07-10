import { useMemo, useState } from 'react';
import { Zap, ChevronDown, ChevronUp } from 'lucide-react';

const CHANGE_TYPE_LABELS = {
  bid: 'Lance',
  budget: 'Orçamento',
  status: 'Status campanha',
  targeting: 'Segmentação',
  negative_keyword: 'Palavra-chave negativa',
  placement: 'Posicionamento',
};

const STATUS_CONFIG = {
  executed: { label: 'Executadas', color: 'text-emerald-400', bg: 'bg-emerald-400/10' },
  pending: { label: 'Recomendadas', color: 'text-cyan', bg: 'bg-cyan/10' },
  failed: { label: 'Falhas', color: 'text-red-400', bg: 'bg-red-400/10' },
  skipped: { label: 'Rejeitadas', color: 'text-slate-400', bg: 'bg-slate-400/10' },
};

export default function AiChangesBreakdown({ bidChanges }) {
  const [expanded, setExpanded] = useState(false);

  const breakdown = useMemo(() => {
    const stats = { total: 0, executed: 0, pending: 0, failed: 0, skipped: 0 };
    const byType = {};

    for (const c of bidChanges) {
      stats.total++;
      const status = c.status || 'executed';
      if (stats[status] !== undefined) stats[status]++;

      // Inferir tipo: bid é o padrão do AdsBidChangeLog
      const type = c.change_type || 'bid';
      if (!byType[type]) byType[type] = { total: 0, executed: 0, pending: 0, failed: 0, skipped: 0 };
      byType[type].total++;
      if (byType[type][status] !== undefined) byType[type][status]++;
    }

    return { stats, byType };
  }, [bidChanges]);

  const { stats, byType } = breakdown;

  if (stats.total === 0) return null;

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between"
      >
        <div className="flex items-center gap-2">
          <Zap className="w-3.5 h-3.5 text-amber-400" />
          <span className="text-xs font-semibold text-slate-300">Alterações da IA</span>
          <span className="text-xs font-bold text-white bg-amber-500/15 border border-amber-500/20 px-1.5 py-0.5 rounded-full">{stats.total.toLocaleString('pt-BR')}</span>
        </div>
        {expanded ? <ChevronUp className="w-3.5 h-3.5 text-slate-500" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-500" />}
      </button>

      <div className="grid grid-cols-4 gap-2 mt-3">
        {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
          <div key={key} className={`rounded-lg px-2 py-1.5 ${cfg.bg} text-center`}>
            <p className={`text-sm font-bold ${cfg.color}`}>{(stats[key] || 0).toLocaleString('pt-BR')}</p>
            <p className="text-[9px] text-slate-500 mt-0.5">{cfg.label}</p>
          </div>
        ))}
      </div>

      {expanded && Object.keys(byType).length > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-surface-2 pt-3">
          <p className="text-[10px] text-slate-500 mb-2">Por tipo de alteração:</p>
          {Object.entries(byType).map(([type, counts]) => (
            <div key={type} className="flex items-center justify-between">
              <span className="text-[10px] text-slate-400">{CHANGE_TYPE_LABELS[type] || type}</span>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-emerald-400">{counts.executed} exec.</span>
                {counts.failed > 0 && <span className="text-[10px] text-red-400">{counts.failed} falha</span>}
                <span className="text-[10px] text-slate-500">{counts.total} total</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}