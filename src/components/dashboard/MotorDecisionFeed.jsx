import { useMemo, useState } from 'react';
import {
  ChevronRight, Bot,
} from 'lucide-react';
import DataFreshnessBadge from '@/components/ui/DataFreshnessBadge';
import DecisionColloquy from '@/components/dashboard/DecisionColloquy';
import {
  getMotorActionBadge, getMotorReasonLabel, getAmazonConfirmationStatus,
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
    raw: item,
  };
}

function safeJson(str) {
  try { return typeof str === 'string' ? JSON.parse(str) : str; }
  catch { return null; }
}

function deriveTitle(raw) {
  if (raw?.keyword_text) return raw.keyword_text;
  if (raw?.asin) return raw.asin;
  if (raw?.entity_name) return raw.entity_name;
  if (raw?.campaign_name) return raw.campaign_name;
  return 'Decisão do motor';
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
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border whitespace-nowrap ${tones[status.tone] || tones.slate}`}>
      <span className="font-mono leading-none">{status.symbol}</span>
      {status.label}
    </span>
  );
}

function AccordionItem({ item, isOpen, onToggle }) {
  const { id, source, timestamp, raw } = item;
  const action = useMemo(() => getMotorActionBadge(raw), [raw]);
  const reason = useMemo(() => getMotorReasonLabel(raw), [raw]);
  const confirm = useMemo(() => getAmazonConfirmationStatus(raw), [raw]);
  const title = useMemo(() => deriveTitle(raw), [raw]);
  const metricWindow = raw?.metric_window || raw?.decision_window || raw?.baseline_window || raw?.data_window_days
    ? `${raw.metric_window || raw.decision_window || raw.baseline_window}${raw.data_window_days ? ` · ${raw.data_window_days}d` : ''}`
    : null;
  const dataUsed = useMemo(() => (raw?.data_used ? safeJson(raw.data_used) : null), [raw]);

  const sourceLabel = source === 'bidChange' ? 'Bid log' : 'Decisão';

  return (
    <div className="border-b border-[var(--border-color)] last:border-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="w-full flex items-center gap-3 py-3 px-4 bg-theme-card hover:bg-theme-card-2 transition-colors text-left"
      >
        <ChevronRight
          className={`w-4 h-4 text-theme-muted flex-shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}
          strokeWidth={2.2}
        />
        <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap sm:flex-nowrap">
          <span className="text-sm font-semibold text-theme-primary truncate" title={title}>{title}</span>
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border whitespace-nowrap ${toneBadge(action.tone)}`}>
            {action.label}
          </span>
          <span className="text-[10px] text-theme-muted uppercase tracking-wide hidden md:inline">{sourceLabel}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <ConfirmationPill status={confirm} />
          <DataFreshnessBadge timestamp={timestamp} variant="compact" />
        </div>
      </button>

      {isOpen && (
        <div className="px-4 pb-4 pt-1 bg-theme-card-2 animate-fade-in">
          {raw?.campaign_name && (
            <p className="text-[12px] text-theme-secondary mt-1 truncate" title={raw.campaign_name}>{raw.campaign_name}</p>
          )}
          {reason && <p className="text-[12px] text-theme-muted leading-relaxed mt-1.5">{reason}</p>}

          <div className="flex items-center justify-between gap-2 mt-2 flex-wrap">
            <div className="flex items-center gap-3 text-[10px] text-theme-muted">
              {metricWindow && <span>Dados: <span className="text-theme-secondary font-medium">{metricWindow}</span></span>}
              {raw?.confidence != null && (
                <span>Confiança: <span className="text-theme-secondary font-medium">{Math.round(raw.confidence)}%</span></span>
              )}
            </div>
          </div>

          <div className="mt-3">
            <DecisionColloquy raw={raw} />
          </div>

          {dataUsed && (
            <details className="mt-3 group">
              <summary className="text-[10px] text-theme-muted cursor-pointer hover:text-theme-secondary select-none list-none flex items-center gap-1">
                <ChevronRight className="w-3 h-3 group-open:rotate-90 transition-transform" />
                Dados técnicos
              </summary>
              <pre className="mt-2 p-3 rounded-lg bg-theme-card border border-[var(--border-color)] text-[10px] text-theme-secondary overflow-x-auto whitespace-pre-wrap break-words max-h-40">
{JSON.stringify(dataUsed, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * MotorDecisionFeed — "O que o Motor está fazendo agora".
 * Lista de accordions (um por decisão / alteração de bid). Cada accordion mostra
 * título + badge de ação + tempo relativo + badge de status; ao abrir, revela o
 * DecisionColloquy completo (lazy render). Vários accordions podem ficar abertos
 * simultaneamente; paginação e agrupamento por data permanecem.
 *
 * Props:
 *   decisions   — OptimizationDecision[] (opcional)
 *   bidChanges  — AdsBidChangeLog[] (opcional)
 *   accountId   — string (legacy, não usado mais para fetch interno)
 */
export default function MotorDecisionFeed({ decisions, bidChanges, accountId }) {
  const [page, setPage] = useState(1);
  const [openSet, setOpenSet] = useState(() => new Set());

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

  const totalItems = merged.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  const pageItems = useMemo(() => {
    const slice = merged.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
    const m = new Map();
    for (const it of slice) {
      const k = fmtDateKey(it.timestamp) || 'Sem data';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(it);
    }
    return Array.from(m.entries());
  }, [merged, safePage]);

  const toggle = (id) => {
    setOpenSet(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Quando a página muda, recolhe tudo para o novo conjunto de itens
  const handlePageChange = (next) => {
    setOpenSet(new Set());
    setPage(next);
  };

  if (totalItems === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <Bot className="w-7 h-7 text-theme-muted mb-2" />
        <p className="text-sm text-theme-secondary font-medium">Motor em repouso</p>
        <p className="text-xs text-theme-muted mt-1">Nenhuma ação automática registrada recentemente.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {pageItems.map(([dateKey, items]) => (
        <div key={dateKey}>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-theme-muted px-1 mb-1.5">{dateKey}</p>
          <div className="rounded-xl border border-[var(--border-color)] overflow-hidden">
            {items.map(it => (
              <AccordionItem
                key={it.id}
                item={it}
                isOpen={openSet.has(it.id)}
                onToggle={() => toggle(it.id)}
              />
            ))}
          </div>
        </div>
      ))}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 pt-2">
          <button
            type="button"
            onClick={() => handlePageChange(Math.max(1, safePage - 1))}
            disabled={safePage === 1}
            className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border-color)] bg-theme-card text-theme-secondary hover:bg-theme-card-2 disabled:opacity-40 transition-colors"
          >
            ← Anterior
          </button>
          <span className="text-xs text-theme-muted">{safePage} / {totalPages}</span>
          <button
            type="button"
            onClick={() => handlePageChange(Math.min(totalPages, safePage + 1))}
            disabled={safePage === totalPages}
            className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border-color)] bg-theme-card text-theme-secondary hover:bg-theme-card-2 disabled:opacity-40 transition-colors"
          >
            Próxima →
          </button>
        </div>
      )}
    </div>
  );
}