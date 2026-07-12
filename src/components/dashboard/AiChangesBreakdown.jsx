import { useMemo, useState } from 'react';
import { Zap, ChevronDown, ChevronUp, ArrowUp, ArrowDown, CalendarDays } from 'lucide-react';

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

function brDateKey(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function bidValues(change) {
  const before = Number(change.bid_before ?? change.value_before ?? change.old_bid ?? 0);
  const after = Number(change.bid_after ?? change.value_after ?? change.new_bid ?? 0);
  return { before, after };
}

export default function AiChangesBreakdown({ bidChanges }) {
  const [expanded, setExpanded] = useState(false);

  const breakdown = useMemo(() => {
    const stats = { total: 0, executed: 0, pending: 0, failed: 0, skipped: 0 };
    const byType = {};
    const now = new Date();
    const today = brDateKey(now);
    const monthPrefix = today?.slice(0, 7) || '';
    const bids = { today: 0, increasedToday: 0, reducedToday: 0, month: 0 };

    for (const c of bidChanges) {
      stats.total++;
      const status = c.status || 'executed';
      if (stats[status] !== undefined) stats[status]++;

      const type = c.change_type || 'bid';
      if (!byType[type]) byType[type] = { total: 0, executed: 0, pending: 0, failed: 0, skipped: 0 };
      byType[type].total++;
      if (byType[type][status] !== undefined) byType[type][status]++;

      const isBid = type === 'bid' || c.bid_before != null || c.bid_after != null || String(c.action || '').includes('bid');
      const executed = status === 'executed' || status === 'completed' || (!c.status && c.bid_after != null);
      if (!isBid || !executed) continue;

      const timestamp = c.executed_at || c.created_at || c.created_date;
      const dateKey = brDateKey(timestamp);
      if (!dateKey) continue;
      const { before, after } = bidValues(c);

      if (dateKey.startsWith(monthPrefix)) bids.month++;
      if (dateKey === today) {
        bids.today++;
        if (after > before) bids.increasedToday++;
        if (after < before) bids.reducedToday++;
      }
    }

    return { stats, byType, bids };
  }, [bidChanges]);

  const { stats, byType, bids } = breakdown;

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Zap className="w-3.5 h-3.5 text-amber-400" />
          <span className="text-xs font-semibold text-slate-300">Alterações de bids</span>
          <span className="text-[10px] text-slate-500">dados confirmados e persistidos</span>
        </div>
        {stats.total > 0 ? (
          <button onClick={() => setExpanded(v => !v)} className="p-1 rounded hover:bg-surface-2" aria-label="Detalhar alterações">
            {expanded ? <ChevronUp className="w-3.5 h-3.5 text-slate-500" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-500" />}
          </button>
        ) : null}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div className="rounded-lg px-3 py-2 bg-cyan/10 border border-cyan/15">
          <p className="text-lg font-bold text-cyan">{bids.today.toLocaleString('pt-BR')}</p>
          <p className="text-[9px] text-slate-500 mt-0.5">Alterações de bids hoje</p>
        </div>
        <div className="rounded-lg px-3 py-2 bg-amber-400/10 border border-amber-400/15">
          <div className="flex items-center gap-1"><ArrowUp className="w-3 h-3 text-amber-400" /><p className="text-lg font-bold text-amber-400">{bids.increasedToday.toLocaleString('pt-BR')}</p></div>
          <p className="text-[9px] text-slate-500 mt-0.5">Bids aumentados hoje</p>
        </div>
        <div className="rounded-lg px-3 py-2 bg-emerald-400/10 border border-emerald-400/15">
          <div className="flex items-center gap-1"><ArrowDown className="w-3 h-3 text-emerald-400" /><p className="text-lg font-bold text-emerald-400">{bids.reducedToday.toLocaleString('pt-BR')}</p></div>
          <p className="text-[9px] text-slate-500 mt-0.5">Bids reduzidos hoje</p>
        </div>
        <div className="rounded-lg px-3 py-2 bg-violet-400/10 border border-violet-400/15">
          <div className="flex items-center gap-1"><CalendarDays className="w-3 h-3 text-violet-400" /><p className="text-lg font-bold text-violet-400">{bids.month.toLocaleString('pt-BR')}</p></div>
          <p className="text-[9px] text-slate-500 mt-0.5">Acumulado de alterações no mês</p>
        </div>
      </div>

      {stats.total > 0 && expanded ? (
        <>
          <div className="grid grid-cols-4 gap-2 mt-3">
            {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
              <div key={key} className={`rounded-lg px-2 py-1.5 ${cfg.bg} text-center`}>
                <p className={`text-sm font-bold ${cfg.color}`}>{(stats[key] || 0).toLocaleString('pt-BR')}</p>
                <p className="text-[9px] text-slate-500 mt-0.5">{cfg.label}</p>
              </div>
            ))}
          </div>

          {Object.keys(byType).length > 0 ? (
            <div className="mt-3 space-y-1.5 border-t border-surface-2 pt-3">
              <p className="text-[10px] text-slate-500 mb-2">Por tipo de alteração:</p>
              {Object.entries(byType).map(([type, counts]) => (
                <div key={type} className="flex items-center justify-between">
                  <span className="text-[10px] text-slate-400">{CHANGE_TYPE_LABELS[type] || type}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-emerald-400">{counts.executed} exec.</span>
                    {counts.failed > 0 ? <span className="text-[10px] text-red-400">{counts.failed} falha</span> : null}
                    <span className="text-[10px] text-slate-500">{counts.total} total</span>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}