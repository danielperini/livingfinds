import { useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import {
  ChevronRight, Bot, Download, Trash2, Loader2,
} from 'lucide-react';
import DataFreshnessBadge from '@/components/ui/DataFreshnessBadge';
import DecisionColloquy from '@/components/dashboard/DecisionColloquy';
import {
  getMotorActionBadge, getMotorReasonLabel, getAmazonConfirmationStatus,
} from '@/lib/motorLabels';


function isVisibleOperationalDecision(item) {
  const visibility =
    String(
      item?.operational_visibility || ''
    ).toLowerCase();

  const reason =
    String(
      item?.cancelled_reason ||
      item?.reason_code ||
      ''
    ).toUpperCase();

  if (
    visibility === 'internal'
  ) {
    return false;
  }

  if (
    reason === 'V3_PREFLIGHT_WINNER_PROTECTION' ||
    reason === 'V3_PREFLIGHT_ZERO_DELIVERY_DELEGATED'
  ) {
    return false;
  }

  return true;
}

const PAGE_SIZE = 10;
const CURRENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_CLEANUP_ROUNDS = 6;
const CLEANUP_BATCH_SIZE = 1000;

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
  if (raw?.keyword_id) return `Keyword ${raw.keyword_id}`;
  if (raw?.campaign_id) return `Campanha ${raw.campaign_id}`;
  if (raw?.entity_id) return `${raw?.entity_type === 'campaign' ? 'Campanha' : 'Entidade'} ${raw.entity_id}`;
  return 'Decisão do motor';
}

function formatBidChange(raw) {
  const before = Number(raw?.value_before ?? raw?.old_bid);
  const after = Number(raw?.value_after ?? raw?.new_bid);
  if (!Number.isFinite(before) || !Number.isFinite(after) || before === after) return null;
  const pct = before > 0 ? ((after / before) - 1) * 100 : null;
  const pctLabel = Number.isFinite(pct) ? ` (${pct > 0 ? '+' : ''}${pct.toFixed(0)}%)` : '';
  return `R$ ${before.toFixed(2)} → R$ ${after.toFixed(2)}${pctLabel}`;
}


/*
 * =========================================================
 * CANONICAL PROFIT ENGINE V4 — CURRENT FEED VISIBILITY
 * =========================================================
 *
 * O histórico completo continua disponível.
 *
 * A seção "O que o Motor está fazendo agora" mostra somente
 * ações operacionais atuais.
 *
 * Propostas barradas no pre-flight, superseded e registros
 * explicitamente internos pertencem à auditoria histórica,
 * não ao feed corrente.
 */
function isCurrentOperationalDecision(item) {
  const raw = item?.raw || {};

  const visibility =
    String(
      raw.operational_visibility || ''
    )
      .trim()
      .toLowerCase();

  if (visibility === 'internal') {
    return false;
  }

  const status =
    String(
      raw.status ||
      raw.queue_status ||
      ''
    )
      .trim()
      .toLowerCase();

  /*
   * SUPERSEDED significa que outra avaliação V4 venceu.
   * Não é ação operacional atual.
   */
  if (
    [
      'superseded',
      'rejected',
      'expired',
      'cancelled',
      'canceled',
      'skipped'
    ].includes(status)
  ) {
    return false;
  }

  const reason =
    String(
      raw.cancelled_reason ||
      raw.reason_code ||
      raw.blocked_reason ||
      ''
    )
      .trim()
      .toUpperCase();

  if (reason.startsWith('NO_DECISION') || reason === 'HOLD' || reason.includes('SOFT_BID_BLOCK')) {
    return false;
  }

  /*
   * Decisões que o V3 deliberadamente converteu em
   * auditoria interna.
   */
  if (
    [
      'V3_PREFLIGHT_WINNER_PROTECTION',
      'V3_PREFLIGHT_ZERO_DELIVERY_DELEGATED',
      'V3_PREFLIGHT_SUPERSEDED_BLOCKED_PAUSE',
      'AMAZON_ENABLED_SUPERSEDES_STALE_PAUSE',
      'SUPERSEDED_BY_WEEKLY_V3',
      'SUPERSEDED_BY_WEEKLY_V3_REFRESH'
    ].includes(reason)
  ) {
    return false;
  }

  /*
   * Uma PAUSE que foi bloqueada/cancelada não é algo que
   * o motor esteja "fazendo agora".
   *
   * Continua visível quando o usuário abre o Histórico.
   */
  const action =
    String(
      raw.action ||
      raw.action_type ||
      raw.canonical_action_type ||
      ''
    )
      .trim()
      .toLowerCase();

  const blockedPause =
    action.includes('pause') &&
    (
      raw.hard_block === true ||
      [
        'blocked',
        'cancelled',
        'canceled',
        'skipped'
      ].includes(status)
    );

  if (blockedPause) {
    return false;
  }

  return true;
}

function historicalDedupeKey(item) {
  const raw = item?.raw || {};
  const status = String(raw.status || '').toLowerCase();
  if (status !== 'cancelled' || raw.rule_key !== 'winner_protection_dedup') return null;
  return [item.source, raw.rule_key, raw.amazon_account_id, raw.entity_id || raw.campaign_id, raw.asin, raw.action].join('|');
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

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${text.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

function buildHistoryCsv(items) {
  const columns = [
    ['data_hora', item => item.timestamp],
    ['fonte', item => item.source],
    ['titulo', item => deriveTitle(item.raw)],
    ['asin', item => item.raw?.asin],
    ['sku', item => item.raw?.sku],
    ['campaign_id', item => item.raw?.campaign_id || item.raw?.amazon_campaign_id],
    ['campaign_name', item => item.raw?.campaign_name],
    ['keyword_id', item => item.raw?.keyword_id],
    ['keyword_text', item => item.raw?.keyword_text],
    ['decision_type', item => item.raw?.decision_type],
    ['action', item => item.raw?.action],
    ['status', item => item.raw?.status],
    ['queue_status', item => item.raw?.queue_status],
    ['confirmation_status', item => item.raw?.amazon_confirmation_status || item.raw?.confirmation_status],
    ['risk', item => item.raw?.risk],
    ['confidence', item => item.raw?.confidence],
    ['value_before', item => item.raw?.value_before],
    ['value_after', item => item.raw?.value_after],
    ['change_pct', item => item.raw?.change_pct ?? item.raw?.bid_change_pct],
    ['reason_code', item => item.raw?.reason_code],
    ['rule_key', item => item.raw?.rule_key],
    ['rationale', item => item.raw?.rationale || item.raw?.reason],
    ['id', item => item.raw?.id || item.id],
  ];
  const header = columns.map(([name]) => csvCell(name)).join(';');
  const rows = items.filter(isVisibleOperationalDecision).map(item => columns.map(([, getter]) => csvCell(getter(item))).join(';'));
  return `\uFEFF${[header, ...rows].join('\n')}`;
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
  const bidChange = useMemo(() => formatBidChange(raw), [raw]);
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
          {bidChange && <span className="text-[11px] font-bold text-emerald-700 whitespace-nowrap">{bidChange}</span>}
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
 * O histórico pode ser exportado para CSV e podado manualmente. A poda usa a
 * política canônica do backend: preserva decisões abertas e execuções efetivas
 * de produtos ativos; remove ruído terminal e vínculos inativos/não resolvidos.
 */
export default function MotorDecisionFeed({ decisions, bidChanges, accountId }) {
  const [page, setPage] = useState(1);
  const [openSet, setOpenSet] = useState(() => new Set());
  const [showHistory, setShowHistory] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [historyMessage, setHistoryMessage] = useState('');

  const merged = useMemo(() => {
    const out = [];
    if (Array.isArray(decisions)) for (const d of decisions) out.push(normalizeDecision(d, 'decision'));
    if (Array.isArray(bidChanges)) for (const b of bidChanges) out.push(normalizeDecision(b, 'bidChange'));
    const sorted = out.sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta;
    });
    const seenHistoricalBlocks = new Set();
    return sorted.filter(item => {
      const key = historicalDedupeKey(item);
      if (!key) return true;
      if (seenHistoricalBlocks.has(key)) return false;
      seenHistoricalBlocks.add(key);
      return true;
    });
  }, [decisions, bidChanges]);

  const recent = useMemo(
    () =>
      merged.filter((item) => {
        if (!isCurrentOperationalDecision(item)) {
          return false;
        }

        const timestamp =
          new Date(
            item.timestamp || 0
          ).getTime();

        return (
          Number.isFinite(timestamp) &&
          timestamp >=
            Date.now() -
            CURRENT_WINDOW_MS
        );
      }),
    [merged]
  );
  const visibleItems = showHistory ? merged : recent;
  const totalItems = visibleItems.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  const pageItems = useMemo(() => {
    const slice = visibleItems.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
    const m = new Map();
    for (const it of slice) {
      const k = fmtDateKey(it.timestamp) || 'Sem data';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(it);
    }
    return Array.from(m.entries());
  }, [visibleItems, safePage]);

  const toggle = (id) => {
    setOpenSet(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handlePageChange = (next) => {
    setOpenSet(new Set());
    setPage(next);
  };

  const toggleHistory = () => {
    setShowHistory((current) => !current);
    setPage(1);
    setOpenSet(new Set());
  };

  const exportHistoryCsv = () => {
    if (!merged.length) return;
    const csv = buildHistoryCsv(merged);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `livingfinds-historico-motor-${date}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setHistoryMessage(`${merged.length} registro(s) exportados para CSV.`);
  };

  const cleanupHistory = async () => {
    if (cleaning) return;
    const confirmed = window.confirm(
      'Limpar o histórico do motor?\n\nSerão preservadas decisões abertas e execuções efetivas/confirmadas de produtos ativos. Registros cancelados, bloqueados, falhos, rejeitados e vínculos com produtos inativos ou não resolvidos serão removidos.\n\nSe quiser guardar uma cópia completa, use “Exportar CSV” antes.'
    );
    if (!confirmed) return;

    setCleaning(true);
    setHistoryMessage('Limpando histórico com a política canônica…');
    let removed = 0;
    let rounds = 0;
    let lastRemoved = CLEANUP_BATCH_SIZE;

    try {
      while (rounds < MAX_CLEANUP_ROUNDS && lastRemoved >= CLEANUP_BATCH_SIZE) {
        rounds += 1;
        const response = await base44.functions.invoke('pruneMotorDecisionHistory', {
          amazon_account_id: accountId || null,
          dry_run: false,
          max_delete: CLEANUP_BATCH_SIZE,
          trigger_type: 'dashboard_manual_history_cleanup',
        });
        const data = response?.data || response || {};
        if (data?.ok === false) throw new Error(data.error || 'Falha ao limpar o histórico.');
        const totals = data?.totals || {};
        lastRemoved = Number(totals.removed_non_effective || 0)
          + Number(totals.removed_inactive_product || 0)
          + Number(totals.removed_unresolved_product || 0);
        removed += lastRemoved;
        setHistoryMessage(`Limpeza em andamento: ${removed} registro(s) removido(s)…`);
        if (lastRemoved < CLEANUP_BATCH_SIZE) break;
      }

      setHistoryMessage(`Limpeza concluída: ${removed} registro(s) descartáveis removido(s). Atualizando a tela…`);
      setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      setHistoryMessage(error?.message || 'Não foi possível limpar o histórico.');
      setCleaning(false);
    }
  };

  const HistoryActions = () => (
    <div className="flex items-center gap-2 flex-wrap justify-end">
      <button
        type="button"
        onClick={exportHistoryCsv}
        disabled={!merged.length || cleaning}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--border-color)] bg-theme-card text-[11px] font-semibold text-theme-secondary hover:bg-theme-card-2 disabled:opacity-40"
      >
        <Download className="w-3.5 h-3.5" />
        Exportar CSV
      </button>
      <button
        type="button"
        onClick={cleanupHistory}
        disabled={!merged.length || cleaning}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-red-200 bg-red-50 text-[11px] font-semibold text-red-700 hover:bg-red-100 disabled:opacity-40"
      >
        {cleaning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
        {cleaning ? 'Limpando…' : 'Limpar histórico'}
      </button>
    </div>
  );

  if (totalItems === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <Bot className="w-7 h-7 text-theme-muted mb-2" />
        <p className="text-sm text-theme-secondary font-medium">Motor em repouso nas últimas 24h</p>
        <p className="text-xs text-theme-muted mt-1">Nenhuma decisão nova exige execução agora. Bloqueios antigos ficam no histórico.</p>
        {merged.length > 0 && (
          <>
            <button type="button" onClick={toggleHistory} className="mt-3 text-xs font-semibold text-blue-600 hover:text-blue-700">
              Ver histórico ({merged.length})
            </button>
            <div className="mt-3"><HistoryActions /></div>
            {historyMessage && <p className="text-[11px] text-theme-muted mt-2">{historyMessage}</p>}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 px-1 flex-wrap">
        <div>
          <p className="text-[11px] text-theme-muted">
            {showHistory ? `Histórico completo: ${merged.length} registros.` : `Atividade operacional das últimas 24h: ${recent.length} registro(s).`}
          </p>
          {historyMessage && <p className="text-[10px] text-theme-muted mt-1">{historyMessage}</p>}
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {merged.length > recent.length && (
            <button type="button" onClick={toggleHistory} disabled={cleaning} className="text-[11px] font-semibold text-blue-600 hover:text-blue-700 whitespace-nowrap disabled:opacity-40">
              {showHistory ? 'Voltar ao agora' : `Ver histórico (${merged.length})`}
            </button>
          )}
          <HistoryActions />
        </div>
      </div>
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
            disabled={safePage === 1 || cleaning}
            className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border-color)] bg-theme-card text-theme-secondary hover:bg-theme-card-2 disabled:opacity-40 transition-colors"
          >
            ← Anterior
          </button>
          <span className="text-xs text-theme-muted">{safePage} / {totalPages}</span>
          <button
            type="button"
            onClick={() => handlePageChange(Math.min(totalPages, safePage + 1))}
            disabled={safePage === totalPages || cleaning}
            className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border-color)] bg-theme-card text-theme-secondary hover:bg-theme-card-2 disabled:opacity-40 transition-colors"
          >
            Próxima →
          </button>
        </div>
      )}
    </div>
  );
}
