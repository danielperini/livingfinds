import { useState, useEffect, useCallback, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import {
  TrendingUp, TrendingDown, Minus, Loader2, RefreshCw, Filter, Search,
  ChevronDown, ChevronRight, CheckCircle, XCircle, Clock, AlertTriangle,
  Play, X, RotateCcw, Eye, Zap, Info
} from 'lucide-react';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const fmtBRL = (v) =>
  v != null && isFinite(v)
    ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 }).format(v)
    : '—';

const fmtPct = (v) =>
  v != null && isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}%` : '—';

const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

const fmtDateOnly = (iso) =>
  iso ? new Date(iso).toLocaleDateString('pt-BR') : '—';

// ─── Mapeamento de status ────────────────────────────────────────────────────

function resolveStatus(d) {
  if (d.amazon_response) {
    try {
      const r = typeof d.amazon_response === 'string' ? JSON.parse(d.amazon_response) : d.amazon_response;
      if (r?.keywordResponses?.[0]?.code === 'THROTTLED') return 'rate_limited';
    } catch {}
  }
  if (d.status === 'pending' && d.requires_approval) return 'awaiting_approval';
  if (d.status === 'pending') return 'recommended';
  if (d.status === 'approved') return 'approved';
  if (d.status === 'scheduled' || d.queue_status === 'scheduled') return 'scheduled';
  if (d.status === 'executing') return 'executing';
  if (d.status === 'executed') return 'executed';
  if (d.status === 'failed') {
    if (d.error_message?.includes('429') || d.error_message?.includes('rate limit') || d.error_message?.includes('THROTTLED')) return 'rate_limited';
    if (d.error_message?.includes('504') || d.error_message?.includes('524')) return 'async_pending';
    return 'failed';
  }
  if (d.status === 'skipped') return 'skipped';
  if (d.status === 'rolled_back') return 'cancelled';
  return d.status || 'recommended';
}

const STATUS_CFG = {
  recommended:      { label: 'Recomendado',               color: 'text-slate-300',   bg: 'bg-slate-500/10 border-slate-500/20' },
  awaiting_approval:{ label: 'Aguardando aprovação',      color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/20' },
  approved:         { label: 'Aprovado',                  color: 'text-cyan',        bg: 'bg-cyan/10 border-cyan/20' },
  scheduled:        { label: 'Agendado',                  color: 'text-violet-400',  bg: 'bg-violet-500/10 border-violet-500/20' },
  executing:        { label: 'Executando',                color: 'text-cyan',        bg: 'bg-cyan/10 border-cyan/20' },
  executed:         { label: 'Executado',                 color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
  failed:           { label: 'Falhou',                    color: 'text-red-400',     bg: 'bg-red-500/10 border-red-500/20' },
  rate_limited:     { label: 'Postergado por rate limit', color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/20' },
  async_pending:    { label: 'Processamento assíncrono',  color: 'text-blue-400',    bg: 'bg-blue-500/10 border-blue-500/20' },
  skipped:          { label: 'Ignorado',                  color: 'text-slate-500',   bg: 'bg-slate-500/5 border-slate-500/10' },
  cancelled:        { label: 'Cancelado',                 color: 'text-slate-500',   bg: 'bg-slate-500/5 border-slate-500/10' },
};

function StatusBadge({ decision }) {
  const key = resolveStatus(decision);
  const cfg = STATUS_CFG[key] || STATUS_CFG.recommended;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold whitespace-nowrap ${cfg.bg} ${cfg.color}`}>
      {key === 'executing' && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
      {key === 'executed' && <CheckCircle className="w-2.5 h-2.5" />}
      {key === 'failed' && <XCircle className="w-2.5 h-2.5" />}
      {key === 'rate_limited' && <Clock className="w-2.5 h-2.5" />}
      {cfg.label}
    </span>
  );
}

// ─── Quando será alterado ────────────────────────────────────────────────────

function WhenLabel({ decision }) {
  const key = resolveStatus(decision);
  if (key === 'executed') return null;
  if (key === 'awaiting_approval' || key === 'recommended') {
    return <span className="text-[10px] text-slate-500 italic">Após aprovação</span>;
  }
  if (key === 'executing') {
    return <span className="text-[10px] text-cyan italic">Em processamento</span>;
  }
  if (key === 'rate_limited') {
    const retry = decision.last_attempt_at
      ? new Date(new Date(decision.last_attempt_at).getTime() + 65 * 60000)
      : null;
    return <span className="text-[10px] text-amber-400">Retry após {retry ? fmtDate(retry.toISOString()) : '~1h'}</span>;
  }
  if (key === 'scheduled' || decision.queue_status === 'scheduled') {
    const window = decision.queue_window;
    const hour = decision.queue_hour;
    const scheduled = decision.scheduled_for;
    if (window) {
      const isNight = hour != null && (hour < 13);
      return (
        <span className="text-[10px] text-violet-400">
          {isNight ? `Próxima janela noturna: ${window}` : `Próxima janela Amazon: ${window}`}
        </span>
      );
    }
    if (scheduled) return <span className="text-[10px] text-violet-400">{fmtDate(scheduled)}</span>;
  }
  return <span className="text-[10px] text-slate-600">—</span>;
}

// ─── Bid efetivamente aplicado ───────────────────────────────────────────────

function resolveAppliedBid(decision, bidHistoryMap) {
  const key = resolveStatus(decision);
  if (key !== 'executed') return null;
  const bh = bidHistoryMap[decision.id];
  if (bh?.new_bid != null) return bh.new_bid;
  return decision.value_after ?? null;
}

// ─── Variação ────────────────────────────────────────────────────────────────

function BidDelta({ before, after }) {
  if (before == null || after == null) return <span className="text-slate-600">—</span>;
  const diff = after - before;
  const pct = before > 0 ? (diff / before) * 100 : 0;
  const isUp = diff > 0;
  const isDown = diff < 0;
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className={`text-xs font-bold ${isUp ? 'text-red-400' : isDown ? 'text-emerald-400' : 'text-slate-500'}`}>
        {isUp ? '+' : ''}{fmtBRL(diff)}
      </span>
      <span className={`text-[10px] ${isUp ? 'text-red-400/70' : isDown ? 'text-emerald-400/70' : 'text-slate-600'}`}>
        {fmtPct(pct)}
      </span>
    </div>
  );
}

// ─── Modal de detalhe ────────────────────────────────────────────────────────

function DetailModal({ decision, bidHistory, ruleExecution, onClose, products }) {
  if (!decision) return null;
  const key = resolveStatus(decision);
  const bh = bidHistory;
  const re = ruleExecution;
  const appliedBid = key === 'executed' ? (bh?.new_bid ?? decision.value_after) : null;
  const product = products?.find(p => p.asin === decision.asin);

  let metricsUsed = null;
  try {
    metricsUsed = decision.data_used ? JSON.parse(decision.data_used) : null;
  } catch {}

  let amazonResp = null;
  try {
    amazonResp = decision.amazon_response ? JSON.parse(decision.amazon_response) : null;
  } catch { amazonResp = decision.amazon_response; }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative bg-[#111827] border border-surface-3 rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto shadow-2xl scrollbar-thin"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 border-b border-surface-2 bg-[#111827]">
          <div>
            <p className="text-sm font-bold text-white">Detalhe da Alteração de Bid</p>
            <p className="text-xs text-slate-500 mt-0.5">{decision.keyword_text || decision.entity_id || '—'}</p>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge decision={decision} />
            <button onClick={onClose} className="p-1.5 text-slate-500 hover:text-white rounded-lg transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="p-6 space-y-5">
          {/* Produto / Campanha */}
          <div className="grid grid-cols-2 gap-4">
            <Section title="Produto">
              <Row label="Nome" value={product?.product_name || product?.display_name || '—'} />
              <Row label="ASIN" value={<span className="font-mono text-cyan">{decision.asin || '—'}</span>} />
              <Row label="SKU" value={product?.sku || '—'} />
            </Section>
            <Section title="Campanha">
              <Row label="Campanha" value={decision.campaign_id || '—'} mono />
              <Row label="Ad Group" value={decision.ad_group_id || '—'} mono />
              <Row label="Keyword ID" value={decision.keyword_id || '—'} mono />
            </Section>
          </div>

          {/* Bids */}
          <Section title="Bids">
            <div className="grid grid-cols-3 gap-3">
              <BidBox label="Bid anterior" value={decision.value_before} color="text-slate-300" />
              <BidBox label="Bid sugerido" value={decision.value_after} color="text-amber-300" />
              <BidBox
                label="Bid aplicado"
                value={appliedBid}
                color="text-emerald-400"
                placeholder={key === 'executed' ? '—' : 'Aguardando execução'}
              />
            </div>
            {decision.value_before != null && decision.value_after != null && (
              <div className="mt-2 text-xs text-slate-500">
                Variação sugerida: <BidDeltaInline before={decision.value_before} after={decision.value_after} />
              </div>
            )}
          </Section>

          {/* Métricas usadas */}
          {metricsUsed && (
            <Section title="Métricas utilizadas">
              <div className="grid grid-cols-3 gap-3 text-xs">
                {Object.entries(metricsUsed).slice(0, 12).map(([k, v]) => (
                  <div key={k} className="bg-surface-2 rounded-lg p-2">
                    <p className="text-slate-500 text-[10px] mb-0.5">{k}</p>
                    <p className="text-white font-semibold">{typeof v === 'number' ? v.toFixed(3) : String(v ?? '—')}</p>
                  </div>
                ))}
              </div>
              {decision.period_analyzed && (
                <p className="text-[10px] text-slate-500 mt-1">Período: {decision.period_analyzed} · Amostra: {decision.sample_size || '—'}</p>
              )}
            </Section>
          )}

          {/* Decisão */}
          <Section title="Decisão">
            <Row label="Motivo" value={decision.rationale || decision.action || '—'} />
            <Row label="Fonte" value={decision.source_function || decision.trigger || '—'} />
            <Row label="Objetivo" value={decision.objective || '—'} />
            <Row label="Nível de risco" value={decision.risk || '—'} />
            <Row label="Confiança" value={decision.confidence != null ? `${decision.confidence}%` : '—'} />
            <Row label="Idempotency key" value={<span className="font-mono text-[10px]">{decision.idempotency_key || '—'}</span>} />
            <Row label="Amazon Request ID" value={<span className="font-mono text-[10px]">{decision.amazon_request_id || '—'}</span>} />
          </Section>

          {/* Datas */}
          <Section title="Datas">
            <Row label="Data analisada" value={fmtDateOnly(decision.period_analyzed?.split(' ')?.[0] || decision.created_at)} />
            <Row label="Recomendado em" value={fmtDate(decision.created_at)} />
            <Row label="Agendado para" value={fmtDate(decision.scheduled_for)} />
            <Row label="Executado em" value={fmtDate(decision.executed_at || bh?.executed_at || bh?.created_at)} />
            <Row label="Avaliação devida em" value={fmtDate(decision.evaluation_due_at)} />
          </Section>

          {/* Amazon Response */}
          {amazonResp && (
            <Section title="Resposta Amazon">
              <pre className="bg-surface-2 rounded-lg p-3 text-[10px] text-slate-300 overflow-x-auto max-h-40 scrollbar-thin">
                {typeof amazonResp === 'string' ? amazonResp : JSON.stringify(amazonResp, null, 2)}
              </pre>
            </Section>
          )}

          {/* Erros */}
          {decision.error_message && (
            <Section title="Último erro">
              <div className="bg-red-500/8 border border-red-500/20 rounded-lg p-3">
                <p className="text-xs text-red-300">{decision.error_message}</p>
              </div>
            </Section>
          )}

          {/* Tentativas */}
          <Section title="Tentativas">
            <Row label="Contagem" value={decision.attempt_count ?? 0} />
            <Row label="Última tentativa" value={fmtDate(decision.last_attempt_at)} />
          </Section>

          {/* BidHistory vinculada */}
          {bh && (
            <Section title="BidHistory vinculada">
              <Row label="ID" value={<span className="font-mono text-[10px]">{bh.id}</span>} />
              <Row label="Bid anterior" value={fmtBRL(bh.old_bid)} />
              <Row label="Bid novo" value={fmtBRL(bh.new_bid)} />
              <Row label="Variação %" value={fmtPct(bh.change_pct)} />
              <Row label="ACoS no momento" value={bh.acos_at_change != null ? `${bh.acos_at_change.toFixed(1)}%` : '—'} />
              <Row label="Executado em" value={fmtDate(bh.executed_at)} />
              <Row label="Aplicado por" value={bh.applied_by || '—'} />
            </Section>
          )}

          {/* RuleExecution vinculada */}
          {re && (
            <Section title="RuleExecution vinculada">
              <Row label="Rule key" value={re.rule_key || '—'} />
              <Row label="Versão" value={re.rule_version ?? '—'} />
              <Row label="Status" value={re.status || '—'} />
              <Row label="Executado em" value={fmtDate(re.executed_at)} />
              <Row label="Outcome" value={re.outcome || '—'} />
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">{title}</p>
      <div className="bg-surface-2/40 border border-surface-2 rounded-xl p-3 space-y-1.5">
        {children}
      </div>
    </div>
  );
}

function Row({ label, value, mono }) {
  return (
    <div className="flex items-start justify-between gap-4 text-xs">
      <span className="text-slate-500 flex-shrink-0 w-36">{label}</span>
      <span className={`text-slate-200 text-right min-w-0 break-all ${mono ? 'font-mono text-[10px]' : ''}`}>
        {value ?? '—'}
      </span>
    </div>
  );
}

function BidBox({ label, value, color, placeholder }) {
  return (
    <div className="bg-surface-2 border border-surface-3 rounded-xl p-3 text-center">
      <p className="text-[10px] text-slate-500 mb-1">{label}</p>
      <p className={`text-lg font-bold ${color}`}>
        {value != null ? fmtBRL(value) : <span className="text-xs text-slate-600 italic">{placeholder || '—'}</span>}
      </p>
    </div>
  );
}

function BidDeltaInline({ before, after }) {
  const diff = after - before;
  const pct = before > 0 ? (diff / before) * 100 : 0;
  const isUp = diff > 0;
  return (
    <span className={`font-semibold ${isUp ? 'text-red-400' : 'text-emerald-400'}`}>
      {isUp ? '+' : ''}{fmtBRL(diff)} ({fmtPct(pct)})
    </span>
  );
}

// ─── Painel principal ─────────────────────────────────────────────────────────

const FILTER_STATUS_OPTIONS = [
  { key: 'all', label: 'Todos' },
  { key: 'recommended', label: 'Recomendado' },
  { key: 'awaiting_approval', label: 'Aguardando aprov.' },
  { key: 'approved', label: 'Aprovado' },
  { key: 'scheduled', label: 'Agendado' },
  { key: 'executed', label: 'Executado' },
  { key: 'failed', label: 'Falhou' },
  { key: 'rate_limited', label: 'Rate limit' },
];

const FILTER_DIRECTION_OPTIONS = [
  { key: 'all', label: 'Todos' },
  { key: 'increase', label: '↑ Aumento' },
  { key: 'decrease', label: '↓ Redução' },
  { key: 'pending_only', label: 'Pendentes' },
  { key: 'failed_only', label: 'Falhas' },
];

export default function KeywordBidChangesPanel({ account }) {
  const [decisions, setDecisions] = useState([]);
  const [bidHistoryList, setBidHistoryList] = useState([]);
  const [ruleExecutions, setRuleExecutions] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedDecision, setSelectedDecision] = useState(null);
  const [working, setWorking] = useState(null); // id da decisão em ação
  const [actionMsg, setActionMsg] = useState(null);

  // Filtros
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterDirection, setFilterDirection] = useState('all');
  const [filterWindow, setFilterWindow] = useState('all'); // all | night | day | today

  const loadData = useCallback(async () => {
    if (!account?.id) return;
    setLoading(true);
    try {
      const [decs, bh, re, prods] = await Promise.all([
        base44.entities.OptimizationDecision.filter(
          { amazon_account_id: account.id, decision_type: 'bid_change' },
          '-created_at', 300
        ),
        base44.entities.BidHistory.filter(
          { amazon_account_id: account.id },
          '-created_at', 300
        ),
        base44.entities.RuleExecution.filter(
          { amazon_account_id: account.id },
          '-executed_at', 200
        ),
        base44.entities.Product.filter(
          { amazon_account_id: account.id },
          null, 200
        ),
      ]);
      setDecisions(decs);
      setBidHistoryList(bh);
      setRuleExecutions(re);
      setProducts(prods);
    } finally {
      setLoading(false);
    }
  }, [account?.id]);

  useEffect(() => { loadData(); }, [loadData]);

  // Maps de lookup
  const bidHistoryMap = useMemo(() => {
    const m = {};
    for (const b of bidHistoryList) {
      if (b.decision_id) m[b.decision_id] = b;
    }
    return m;
  }, [bidHistoryList]);

  const ruleExecMap = useMemo(() => {
    const m = {};
    for (const r of ruleExecutions) {
      if (r.keyword_id) m[r.keyword_id] = r;
    }
    return m;
  }, [ruleExecutions]);

  const productMap = useMemo(() => {
    const m = {};
    for (const p of products) m[p.asin] = p;
    return m;
  }, [products]);

  // Cards resumo
  const summary = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return {
      recommended: decisions.filter(d => ['pending', 'recommended'].includes(d.status)).length,
      awaiting: decisions.filter(d => d.status === 'pending' && d.requires_approval).length,
      scheduled: decisions.filter(d => d.status === 'scheduled' || d.queue_status === 'scheduled').length,
      executedToday: decisions.filter(d => d.status === 'executed' && d.executed_at?.slice(0, 10) === today).length,
      failed: decisions.filter(d => d.status === 'failed').length,
      increases: decisions.filter(d => (d.value_after ?? 0) > (d.value_before ?? 0)).length,
      decreases: decisions.filter(d => (d.value_after ?? 0) < (d.value_before ?? 0)).length,
      lastConfirmed: decisions
        .filter(d => d.status === 'executed' && d.executed_at)
        .sort((a, b) => new Date(b.executed_at) - new Date(a.executed_at))[0],
    };
  }, [decisions]);

  // Filtro aplicado
  const filtered = useMemo(() => {
    return decisions.filter(d => {
      const statusKey = resolveStatus(d);
      const q = search.toLowerCase();
      if (q && !(
        (d.keyword_text || '').toLowerCase().includes(q) ||
        (d.asin || '').toLowerCase().includes(q) ||
        (d.campaign_id || '').toLowerCase().includes(q) ||
        (d.keyword_id || '').toLowerCase().includes(q)
      )) return false;

      if (filterStatus !== 'all' && statusKey !== filterStatus) return false;

      if (filterDirection === 'increase' && !((d.value_after ?? 0) > (d.value_before ?? 0))) return false;
      if (filterDirection === 'decrease' && !((d.value_after ?? 0) < (d.value_before ?? 0))) return false;
      if (filterDirection === 'pending_only' && !['pending', 'recommended', 'awaiting_approval', 'approved', 'scheduled'].includes(statusKey)) return false;
      if (filterDirection === 'failed_only' && !['failed', 'rate_limited'].includes(statusKey)) return false;

      if (filterWindow === 'night' && d.queue_hour != null && d.queue_hour >= 13) return false;
      if (filterWindow === 'day' && d.queue_hour != null && d.queue_hour < 13) return false;
      if (filterWindow === 'today') {
        const today = new Date().toISOString().slice(0, 10);
        return (d.created_at?.slice(0, 10) === today || d.executed_at?.slice(0, 10) === today);
      }

      return true;
    });
  }, [decisions, search, filterStatus, filterDirection, filterWindow]);

  // ─── Ações ───────────────────────────────────────────────────────────────

  const doAction = async (actionFn, decisionId) => {
    if (working) return;
    setWorking(decisionId);
    setActionMsg(null);
    try {
      await actionFn();
      await loadData();
    } catch (e) {
      setActionMsg({ type: 'error', text: e.message });
    } finally {
      setWorking(null);
      setTimeout(() => setActionMsg(null), 8000);
    }
  };

  const approveDecision = (d) => doAction(async () => {
    await base44.entities.OptimizationDecision.update(d.id, {
      status: 'approved',
      updated_at: new Date().toISOString(),
    });
  }, d.id);

  const rejectDecision = (d) => doAction(async () => {
    await base44.entities.OptimizationDecision.update(d.id, {
      status: 'rejected',
      updated_at: new Date().toISOString(),
    });
  }, d.id);

  const scheduleDecision = (d) => doAction(async () => {
    await base44.entities.OptimizationDecision.update(d.id, {
      status: 'scheduled',
      queue_status: 'scheduled',
      queued_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }, d.id);

  const executeNow = (d) => doAction(async () => {
    const res = await base44.functions.invoke('executeAutopilotDecisionV2', {
      decision_id: d.id,
      amazon_account_id: account.id,
      force: true,
    });
    const rd = res?.data;
    if (!rd?.ok && !rd?.executed) {
      throw new Error(rd?.error || rd?.message || 'Falha ao executar decisão');
    }
    setActionMsg({ type: 'success', text: `✓ Executado · ${rd.message || ''}` });
  }, d.id);

  const retryDecision = (d) => doAction(async () => {
    await base44.entities.OptimizationDecision.update(d.id, {
      status: 'approved',
      queue_status: 'pending',
      error_message: null,
      attempt_count: (d.attempt_count || 0) + 0, // manter
      updated_at: new Date().toISOString(),
    });
    const res = await base44.functions.invoke('executeAutopilotDecisionV2', {
      decision_id: d.id,
      amazon_account_id: account.id,
      force: true,
    });
    const rd = res?.data;
    if (!rd?.ok && !rd?.executed) throw new Error(rd?.error || 'Falha na retentativa');
    setActionMsg({ type: 'success', text: `✓ Retentativa iniciada · ${rd.message || ''}` });
  }, d.id);

  const cancelSchedule = (d) => doAction(async () => {
    await base44.entities.OptimizationDecision.update(d.id, {
      status: 'skipped',
      queue_status: 'cancelled',
      updated_at: new Date().toISOString(),
    });
  }, d.id);

  // ─── Render ───────────────────────────────────────────────────────────────

  if (!account) return (
    <div className="py-12 text-center text-sm text-slate-500">Conta Amazon não configurada.</div>
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white">Alterações de Keywords e Bids</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Auditoria completa de todas as recomendações, execuções e confirmações Amazon · {decisions.length} registros
          </p>
        </div>
        <button onClick={loadData} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-xs rounded-lg transition-colors disabled:opacity-50">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Atualizar
        </button>
      </div>

      {/* Cards resumo */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {[
          { label: 'Recomendadas', value: summary.recommended, color: 'text-slate-300', filter: 'recommended' },
          { label: 'Agendadas', value: summary.scheduled, color: 'text-violet-400', filter: 'scheduled' },
          { label: 'Executadas hoje', value: summary.executedToday, color: 'text-emerald-400', filter: 'executed' },
          { label: 'Falhas', value: summary.failed, color: 'text-red-400', filter: 'failed' },
          { label: '↑ Aumentos', value: summary.increases, color: 'text-red-400', dirFilter: 'increase' },
          { label: '↓ Reduções', value: summary.decreases, color: 'text-emerald-400', dirFilter: 'decrease' },
          { label: 'Aguardando aprov.', value: summary.awaiting, color: 'text-amber-400', filter: 'awaiting_approval' },
        ].slice(0, 7).map(k => (
          <button key={k.label}
            onClick={() => {
              if (k.filter) setFilterStatus(k.filter);
              if (k.dirFilter) setFilterDirection(k.dirFilter);
            }}
            className="bg-surface-1 border border-surface-2 hover:border-surface-3 rounded-xl p-3 text-left transition-colors">
            <p className="text-[10px] text-slate-500 mb-1">{k.label}</p>
            <p className={`text-xl font-bold ${k.color}`}>{k.value}</p>
          </button>
        ))}
        {/* Última confirmada Amazon */}
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-3 col-span-2 sm:col-span-1">
          <p className="text-[10px] text-slate-500 mb-1">Última confirmada</p>
          {summary.lastConfirmed ? (
            <>
              <p className="text-xs font-bold text-emerald-400 truncate">{summary.lastConfirmed.keyword_text || summary.lastConfirmed.entity_id || '—'}</p>
              <p className="text-[10px] text-slate-500">{fmtDate(summary.lastConfirmed.executed_at)}</p>
            </>
          ) : (
            <p className="text-xl font-bold text-slate-600">—</p>
          )}
        </div>
      </div>

      {/* Variação média */}
      {(() => {
        const execs = decisions.filter(d => d.status === 'executed' && d.value_before && d.value_after);
        if (execs.length === 0) return null;
        const avgPct = execs.reduce((s, d) => s + ((d.value_after - d.value_before) / d.value_before * 100), 0) / execs.length;
        return (
          <div className="flex items-center gap-2 px-4 py-2.5 bg-surface-1 border border-surface-2 rounded-xl text-xs text-slate-400">
            <Info className="w-3.5 h-3.5 text-cyan flex-shrink-0" />
            Variação média aplicada: <span className={`font-bold ${avgPct > 0 ? 'text-red-400' : 'text-emerald-400'}`}>{fmtPct(avgPct)}</span>
            &nbsp;sobre {execs.length} execuções confirmadas.
          </div>
        );
      })()}

      {/* Mensagem de ação */}
      {actionMsg && (
        <div className={`px-4 py-2.5 rounded-xl border text-xs font-medium ${actionMsg.type === 'success' ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' : 'bg-red-400/10 border-red-400/20 text-red-400'}`}>
          {actionMsg.text}
        </div>
      )}

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Busca */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Keyword, ASIN, Campanha, Keyword ID..."
            className="pl-9 pr-4 py-2 bg-surface-1 border border-surface-2 rounded-lg text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/40 w-52" />
        </div>
        {/* Status */}
        <div className="flex items-center gap-1 flex-wrap">
          {FILTER_STATUS_OPTIONS.slice(0, 5).map(f => (
            <button key={f.key} onClick={() => setFilterStatus(f.key)}
              className={`text-xs px-2.5 py-1.5 rounded-full border transition-colors whitespace-nowrap ${filterStatus === f.key ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'}`}>
              {f.label}
            </button>
          ))}
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
            className="text-xs py-1.5 px-2 bg-surface-2 border border-surface-3 text-slate-400 rounded-full focus:outline-none">
            {FILTER_STATUS_OPTIONS.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </div>
        {/* Direção / tipo */}
        <div className="flex items-center gap-1 flex-wrap">
          {FILTER_DIRECTION_OPTIONS.map(f => (
            <button key={f.key} onClick={() => setFilterDirection(f.key)}
              className={`text-xs px-2.5 py-1.5 rounded-full border transition-colors whitespace-nowrap ${filterDirection === f.key ? 'bg-violet-500/20 text-violet-300 border-violet-500/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'}`}>
              {f.label}
            </button>
          ))}
        </div>
        {/* Janela */}
        <div className="flex items-center gap-1">
          {[
            { key: 'all', label: 'Qualquer janela' },
            { key: 'night', label: 'Noturna' },
            { key: 'day', label: 'Diurna (13h)' },
            { key: 'today', label: 'Hoje' },
          ].map(f => (
            <button key={f.key} onClick={() => setFilterWindow(f.key)}
              className={`text-xs px-2.5 py-1.5 rounded-full border transition-colors whitespace-nowrap ${filterWindow === f.key ? 'bg-amber-500/20 text-amber-300 border-amber-500/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'}`}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tabela */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 text-cyan animate-spin" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-2">
          <Zap className="w-8 h-8 text-slate-700" />
          <p className="text-sm text-slate-500">Nenhuma alteração encontrada com estes filtros</p>
        </div>
      ) : (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/40">
                  {[
                    'Produto', 'ASIN', 'Campanha', 'Keyword', 'Match', 'Keyword ID',
                    'Bid anterior', 'Bid sugerido', 'Bid aplicado', 'Variação',
                    'Motivo', 'Fonte', 'Data recom.', 'Status', 'Quando alterar',
                    'Quando foi', 'Req. ID Amazon', 'Erro', 'Tentativas', 'Ações'
                  ].map(h => (
                    <th key={h} className="px-3 py-2.5 text-left text-[9px] font-semibold text-slate-500 uppercase whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 200).map(d => {
                  const statusKey = resolveStatus(d);
                  const bh = bidHistoryMap[d.id];
                  const re = ruleExecMap[d.keyword_id];
                  const appliedBid = resolveAppliedBid(d, bidHistoryMap);
                  const product = productMap[d.asin];
                  const isWorking = working === d.id;
                  const isFailed = ['failed', 'rate_limited'].includes(statusKey);
                  const isPending = ['recommended', 'awaiting_approval'].includes(statusKey);
                  const isApproved = statusKey === 'approved';
                  const isScheduled = statusKey === 'scheduled';
                  const isExecuted = statusKey === 'executed';
                  const executedAt = d.executed_at || bh?.executed_at || bh?.created_at;
                  const deltaVal = d.value_before != null && d.value_after != null
                    ? d.value_after - d.value_before : null;
                  const deltaPct = deltaVal != null && d.value_before > 0
                    ? (deltaVal / d.value_before) * 100 : null;
                  const isUp = deltaVal != null && deltaVal > 0;
                  const isDown = deltaVal != null && deltaVal < 0;

                  return (
                    <tr key={d.id}
                      onClick={() => setSelectedDecision({ decision: d, bidHistory: bh, ruleExecution: re })}
                      className={`border-b border-surface-2/40 cursor-pointer transition-colors ${isFailed ? 'bg-red-500/3 hover:bg-red-500/6' : isExecuted ? 'hover:bg-emerald-500/3' : 'hover:bg-surface-2/30'}`}
                    >
                      {/* Produto */}
                      <td className="px-3 py-2.5 max-w-[120px]">
                        <p className="text-white truncate">{product?.product_name?.slice(0, 20) || '—'}</p>
                      </td>
                      {/* ASIN */}
                      <td className="px-3 py-2.5 font-mono text-cyan whitespace-nowrap">{d.asin || '—'}</td>
                      {/* Campanha */}
                      <td className="px-3 py-2.5 max-w-[130px]">
                        <span className="text-slate-400 truncate block font-mono text-[10px]">{d.campaign_id?.slice(-12) || '—'}</span>
                      </td>
                      {/* Keyword */}
                      <td className="px-3 py-2.5 max-w-[140px]">
                        <p className="text-white truncate font-semibold" title={d.keyword_text}>{d.keyword_text || '—'}</p>
                      </td>
                      {/* Match */}
                      <td className="px-3 py-2.5">
                        {d.keyword_text ? (
                          <span className="px-1.5 py-0.5 bg-surface-3 text-slate-300 rounded text-[10px] font-mono uppercase">
                            {/* OptimizationDecision não tem match_type direto — tentar entity_type ou fallback */}
                            {d.match_type || (d.entity_type === 'keyword' ? 'kw' : '—')}
                          </span>
                        ) : '—'}
                      </td>
                      {/* Keyword ID */}
                      <td className="px-3 py-2.5 font-mono text-[10px] text-slate-500 whitespace-nowrap">{d.keyword_id?.slice(-10) || '—'}</td>
                      {/* Bid anterior */}
                      <td className="px-3 py-2.5 font-mono whitespace-nowrap">
                        <span className="text-slate-400">{d.value_before != null ? fmtBRL(d.value_before) : (bh?.old_bid != null ? fmtBRL(bh.old_bid) : '—')}</span>
                      </td>
                      {/* Bid sugerido */}
                      <td className="px-3 py-2.5 font-mono whitespace-nowrap">
                        <span className="text-amber-300 font-semibold">{d.value_after != null ? fmtBRL(d.value_after) : '—'}</span>
                      </td>
                      {/* Bid aplicado */}
                      <td className="px-3 py-2.5 font-mono whitespace-nowrap">
                        {appliedBid != null
                          ? <span className="text-emerald-400 font-bold">{fmtBRL(appliedBid)}</span>
                          : <span className="text-slate-600 italic text-[10px]">{isExecuted ? '—' : 'Aguardando'}</span>
                        }
                      </td>
                      {/* Variação */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {deltaVal != null ? (
                          <div className="flex items-center gap-1">
                            {isUp ? <TrendingUp className="w-3 h-3 text-red-400" /> : isDown ? <TrendingDown className="w-3 h-3 text-emerald-400" /> : <Minus className="w-3 h-3 text-slate-500" />}
                            <BidDelta before={d.value_before} after={d.value_after} />
                          </div>
                        ) : '—'}
                      </td>
                      {/* Motivo */}
                      <td className="px-3 py-2.5 max-w-[160px]">
                        <span className="text-slate-500 truncate block" title={d.rationale}>{(d.rationale || d.action || '—').slice(0, 40)}</span>
                      </td>
                      {/* Fonte */}
                      <td className="px-3 py-2.5">
                        <span className="text-[10px] px-1.5 py-0.5 rounded border text-slate-400 border-slate-500/20 bg-slate-500/5">
                          {d.source_function?.split('run').pop()?.split('V')[0] || d.trigger || 'motor'}
                        </span>
                      </td>
                      {/* Data recom. */}
                      <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">{fmtDateOnly(d.created_at)}</td>
                      {/* Status */}
                      <td className="px-3 py-2.5"><StatusBadge decision={d} /></td>
                      {/* Quando alterar */}
                      <td className="px-3 py-2.5 whitespace-nowrap"><WhenLabel decision={d} /></td>
                      {/* Quando foi */}
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {isExecuted && executedAt
                          ? <span className="text-emerald-400">{fmtDate(executedAt)}</span>
                          : <span className="text-slate-600">—</span>}
                      </td>
                      {/* Amazon Request ID */}
                      <td className="px-3 py-2.5 font-mono text-[10px] text-slate-600 whitespace-nowrap">
                        {d.amazon_request_id ? d.amazon_request_id.slice(-10) : '—'}
                      </td>
                      {/* Erro */}
                      <td className="px-3 py-2.5 max-w-[140px]">
                        {d.error_message
                          ? <span className="text-red-400 truncate block text-[10px]" title={d.error_message}>{d.error_message.slice(0, 35)}</span>
                          : '—'}
                      </td>
                      {/* Tentativas */}
                      <td className="px-3 py-2.5 text-center text-slate-400">{d.attempt_count ?? 0}</td>
                      {/* Ações */}
                      <td className="px-3 py-2.5" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-1 flex-nowrap">
                          {/* Ver detalhes */}
                          <button
                            onClick={() => setSelectedDecision({ decision: d, bidHistory: bh, ruleExecution: re })}
                            className="p-1.5 rounded-lg text-slate-500 hover:text-cyan hover:bg-cyan/10 transition-colors"
                            title="Ver detalhes">
                            <Eye className="w-3.5 h-3.5" />
                          </button>

                          {/* Aprovar — pendente */}
                          {isPending && (
                            <button onClick={() => approveDecision(d)} disabled={isWorking}
                              className="p-1.5 rounded-lg text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-40"
                              title="Aprovar">
                              {isWorking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                            </button>
                          )}
                          {/* Rejeitar — pendente */}
                          {isPending && (
                            <button onClick={() => rejectDecision(d)} disabled={isWorking}
                              className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40"
                              title="Rejeitar">
                              <XCircle className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {/* Agendar — aprovado */}
                          {isApproved && (
                            <button onClick={() => scheduleDecision(d)} disabled={isWorking}
                              className="p-1.5 rounded-lg text-violet-400 hover:bg-violet-500/10 transition-colors disabled:opacity-40"
                              title="Agendar">
                              {isWorking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Clock className="w-3.5 h-3.5" />}
                            </button>
                          )}
                          {/* Executar agora — aprovado */}
                          {isApproved && (
                            <button onClick={() => executeNow(d)} disabled={isWorking}
                              className="p-1.5 rounded-lg text-cyan hover:bg-cyan/10 transition-colors disabled:opacity-40"
                              title="Executar agora">
                              {isWorking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                            </button>
                          )}
                          {/* Tentar novamente — falha */}
                          {isFailed && (
                            <button onClick={() => retryDecision(d)} disabled={isWorking}
                              className="p-1.5 rounded-lg text-amber-400 hover:bg-amber-500/10 transition-colors disabled:opacity-40"
                              title="Tentar novamente">
                              {isWorking ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                            </button>
                          )}
                          {/* Cancelar — agendado */}
                          {isScheduled && (
                            <button onClick={() => cancelSchedule(d)} disabled={isWorking}
                              className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-500/10 transition-colors disabled:opacity-40"
                              title="Cancelar agendamento">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {filtered.length > 200 && (
            <div className="px-4 py-2.5 border-t border-surface-2 text-center text-[10px] text-slate-500">
              Exibindo 200 de {filtered.length} registros. Use os filtros para refinar.
            </div>
          )}
        </div>
      )}

      {/* Modal de detalhe */}
      {selectedDecision && (
        <DetailModal
          decision={selectedDecision.decision}
          bidHistory={selectedDecision.bidHistory}
          ruleExecution={selectedDecision.ruleExecution}
          products={products}
          onClose={() => setSelectedDecision(null)}
        />
      )}
    </div>
  );
}