import { useMemo, useState } from 'react';
import {
  ChevronDown, ChevronRight, Loader2, Bot,
} from 'lucide-react';
import DataFreshnessBadge from '@/components/ui/DataFreshnessBadge';
import DecisionColloquy from '@/components/dashboard/DecisionColloquy';
import {
  getMotorActionType, getMotorActionBadge, getMotorReasonLabel, getAmazonConfirmationStatus,
} from '@/lib/motorLabels';

const PAGE_SIZE = 10;

function fmtDateKey(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function normalizeDecision(item, source) {
  const ts = item?.created_at || item?.created_date || item?.evaluated_at || item?.executed_at || item?.updated_at || null;
  return {
    id: item?.id || `${source}-${ts}-${Math.random().toString(36).slice(2, 8)}`,
    source,
    timestamp: ts,
    asin: item?.asin || item?.sku || item?.entity_name,
    campaign: item?.campaign_name || item?.entity_name,
    raw: item,
  };
}

function toneBadge(tone) {
  const tones = {
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    violet: 'bg-violet-50 text-violet-700 border-violet-200',
    sky: 'bg-sky-50 text-sky-700 border-sky-200',
    slate: 'bg-slate-100 text-slate-600 border-slate-200',
  };
  return tones[tone] || tones.slate;
}

function ConfirmationPill({ status }) {
  const tones = {
    green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    slate: 'bg-slate-50 text-slate-500 border-slate-200',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${tones[status.tone]}`}>
      <span className="font-mono leading-none">{status.symbol}</span>
      {status.label}
    </span>
  );
}

function DecisionCard({ item }) {
  const [expanded, setExpanded] = useState(false);
  const { source, timestamp, asin, campaign, raw } = item;
  const action = getMotorActionBadge(raw);
  const reason = useMemo(() => getMotorReasonLabel(raw), [raw]);
  const confirm = useMemo(() => getAmazonConfirmationStatus(raw), [raw]);
  const metricWindow = raw?.metric_window || raw?.decision_window || raw?.baseline_window || raw?.data_window_days
    ? `${raw.metric_window || raw.decision_window || raw.baseline_window}${raw.data_window_days ? ` · ${raw.data_window_days}d` : ''}`
    : null;
  const dataUsed = raw?.data_used ? safeJson(raw.data_used) : null;

  return (
    <div className="border border-[var(--border-color)] rounded-2xl bg-theme-card p-4 shadow-[0_4px_16px_rgba(0,0,0,0.04)] transition-shadow hover:shadow-[0_6px_20px_rgba(0,0,0,0.06)]">
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between gap-3 text-left"
      >
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${toneBadge(action.tone)}`}>
            {action.label}
          </span>
          {source === 'bidChange' && (
            <span className="text-[9px] text-slate-400 uppercase tracking-wide font-medium">Bid log</span>
          )}
          {asin && <span className="font-mono text-[11px] text-[#0066CC]">{asin}</span>}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <DataFreshnessBadge timestamp={timestamp} variant="compact" />
          {expanded
            ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
        </div>
      </button>

      {campaign && (
        <p className="text-[12px] text-slate-700 mt-2 truncate" title={campaign}>{campaign}</p>
      )}

      <p className="text-[12px] text-slate-500 leading-relaxed mt-1.5">{reason}</p>

      <div className="flex items-center justify-between gap-2 mt-3 flex-wrap">
        <div className="flex items-center gap-3 text-[10px] text-slate-400">
          {metricWindow && <span>Dados: <span className="text-slate-600 font-medium">{metricWindow}</span></span>}
          {raw?.confidence != null && (
            <span>Confiança: <span className="text-slate-600 font-medium">{Math.round(raw.confidence)}%</span></span>
          )}
        </div>
        <ConfirmationPill status={confirm} />
      </div>

      {expanded && (
        <>
          <DecisionColloquy raw={raw} />
          {dataUsed && (
            <details className="mt-3 group">
              <summary className="text-[10px] text-slate-400 cursor-pointer hover:text-slate-600 select-none list-none flex items-center gap-1">
                <ChevronRight className="w-3 h-3 group-open:rotate-90 transition-transform" />
                Dados técnicos
              </summary>
              <pre className="mt-2 p-3 rounded-lg bg-slate-50 border border-slate-200 text-[10px] text-slate-600 overflow-x-auto whitespace-pre-wrap break-words max-h-40">
{JSON.stringify(dataUsed, null, 2)}
              </pre>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function safeJson(str) {
  try { return typeof str === 'string' ? JSON.parse(str) : str; }
  catch { return null; }
}

/**
 * MotorDecisionFeed — painel "O que o Motor está fazendo agora".
 * Lê OptimizationDecision + AdsBidChangeLog. Aceita dados por props (quando já
 * carregados pela página) ou faz uma leitura única via base44.entities quando
 * receber apenas `accountId`.
 *
 * Props:
 *   decisions   — OptimizationDecision[] (opcional)
 *   bidChanges  — AdsBidChangeLog[] (opcional)
 *   accountId   — string (usado só se decisions/bidChanges ausentes)
 */
export default function MotorDecisionFeed({ decisions, bidChanges, accountId }) {
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const merged = useMemo(() => {
    const out = [];
    if (Array.isArray(decisions)) for (const d of decisions) out.push(normalizeDecision(d, 'decision'));
    if (Array.isArray(bidChanges)) for (const b of bidChanges) out.push(normalizeDecision(b, 'bidChange'));
    return out.sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta;
    });
  }, [decisions, bidChanges]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const item of merged) {
      const key = fmtDateKey(item.timestamp) || 'Sem data';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    }
    return Array.from(map.entries());
  }, [merged]);

  const totalItems = merged.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  const pageItems = useMemo(() => {
    const flat = grouped.slice((safePage - 1) * 1, safePage * 1); // grupos por página? não — itens
    // Paginação por itens, mas exibição agrupada. Para simplicidade, fatiar merged e reagrupar nesta página.
    const slice = merged.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
    const m = new Map();
    for (const it of slice) {
      const k = fmtDateKey(it.timestamp) || 'Sem data';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(it);
    }
    return Array.from(m.entries());
  }, [merged, safePage]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-4 h-4 text-[#1A8A44] animate-spin" />
      </div>
    );
  }

  if (totalItems === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <Bot className="w-7 h-7 text-slate-300 mb-2" />
        <p className="text-sm text-slate-500 font-medium">Motor em repouso</p>
        <p className="text-xs text-slate-400 mt-1">Nenhuma ação automática registrada recentemente.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {pageItems.map(([dateKey, items]) => (
        <div key={dateKey} className="space-y-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">{dateKey}</p>
          <div className="space-y-2.5">
            {items.map(it => <DecisionCard key={it.id} item={it} />)}
          </div>
        </div>
      ))}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 pt-2">
          <button
            type="button"
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={safePage === 1}
            className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40 transition-colors"
          >
            ← Anterior
          </button>
          <span className="text-xs text-slate-500">{safePage} / {totalPages}</span>
          <button
            type="button"
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={safePage === totalPages}
            className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-40 transition-colors"
          >
            Próxima →
          </button>
        </div>
      )}
    </div>
  );
}