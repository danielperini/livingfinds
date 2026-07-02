import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Brain, CheckCircle, XCircle, Loader2, TrendingUp, TrendingDown,
  RefreshCw, AlertCircle, Filter, ChevronDown, ChevronUp, Zap,
  Eye, BarChart2, Target, AlertTriangle, Play
} from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';

// Taxa de conversão USD → BRL (fixa para consistência)
const USD_TO_BRL = 5.50;

function formatBRL(value) {
  if (value == null) return '—';
  return `R$${Number(value).toFixed(2)}`;
}

const ACTION_CONFIG = {
  bid_adjust: { label: 'Ajuste de Bid', icon: '💰', color: 'text-cyan' },
  budget_change: { label: 'Orçamento', icon: '📊', color: 'text-amber-400' },
  pause_campaign: { label: 'Pausar Campanha', icon: '⏸️', color: 'text-amber-400' },
  enable_campaign: { label: 'Ativar Campanha', icon: '▶️', color: 'text-emerald-400' },
  add_keyword: { label: 'Add Keyword', icon: '🔑', color: 'text-cyan' },
  negate_keyword: { label: 'Negativar KW', icon: '🚫', color: 'text-red-400' },
  create_campaign_auto: { label: 'Criar Camp. AUTO', icon: '🚀', color: 'text-emerald-400' },
  create_campaign_manual: { label: 'Criar Camp. MANUAL', icon: '🎯', color: 'text-cyan' },
  migrate_to_exact: { label: 'Migrar → EXACT', icon: '⬆️', color: 'text-emerald-400' },
  reduce_bid: { label: 'Reduzir Bid', icon: '📉', color: 'text-red-400' },
  increase_bid: { label: 'Aumentar Bid', icon: '📈', color: 'text-emerald-400' },
};

const CONFIDENCE_CONFIG = {
  high: { label: 'Alta', color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  medium: { label: 'Média', color: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
  low: { label: 'Baixa', color: 'text-slate-400 bg-slate-400/10 border-slate-400/20' },
};

const MATURITY_CONFIG = {
  mature: { label: 'Maduro', color: 'text-emerald-400' },
  attribution: { label: 'Em Atribuição', color: 'text-amber-400' },
  provisional: { label: 'Provisório', color: 'text-slate-400' },
  closed: { label: 'Fechado', color: 'text-cyan' },
};

function ConfidenceBadge({ value }) {
  const level = value >= 0.75 ? 'high' : value >= 0.45 ? 'medium' : 'low';
  const cfg = CONFIDENCE_CONFIG[level];
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${cfg.color}`}>
      {cfg.label} ({(value * 100).toFixed(0)}%)
    </span>
  );
}

function MetricPill({ label, value, highlight }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded bg-surface-3 ${highlight ? 'text-cyan' : 'text-slate-400'}`}>
      {label}: {value}
    </span>
  );
}

function DecisionRow({ dec, actionState, onApprove, onReject, selected, onSelect }) {
  const [expanded, setExpanded] = useState(false);
  const [editBid, setEditBid] = useState(false);
  const [bidValue, setBidValue] = useState(dec.proposed_value ?? '');

  const isLoading = actionState === 'loading';
  const isDone = actionState === 'approved' || actionState === 'rejected';
  const cfg = ACTION_CONFIG[dec.decision_type] || { label: dec.decision_type, icon: '🤖', color: 'text-slate-400' };
  const changePct = dec.change_pct ?? (dec.current_value && dec.proposed_value
    ? ((dec.proposed_value - dec.current_value) / dec.current_value) * 100 : null);
  const isUp = (changePct ?? 0) >= 0;
  const maturity = dec.data_maturity || 'mature';
  const matCfg = MATURITY_CONFIG[maturity] || MATURITY_CONFIG.mature;

  const metricsUsed = (() => {
    try { return typeof dec.metrics_used === 'string' ? JSON.parse(dec.metrics_used) : dec.metrics_used; }
    catch { return null; }
  })();

  if (isDone) return null;

  return (
    <>
      <tr className={`border-b border-surface-2/40 transition-colors ${selected ? 'bg-cyan/5' : 'hover:bg-surface-2/60'}`}>
        <td className="pl-4 py-3 w-8">
          <input type="checkbox" checked={selected} onChange={onSelect} className="w-3.5 h-3.5 accent-cyan rounded" />
        </td>
        <td className="px-3 py-3 min-w-[200px]">
          <div className="flex items-start gap-2">
            <span className="text-base mt-0.5 leading-none flex-shrink-0">{cfg.icon}</span>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-white truncate max-w-[180px]" title={dec.entity_name || dec.entity_id}>
                {dec.entity_name || dec.entity_id || '—'}
              </p>
              <p className={`text-xs mt-0.5 font-medium ${cfg.color}`}>{cfg.label}</p>
              {dec.asin && <p className="text-xs text-slate-600 font-mono mt-0.5">ASIN: {dec.asin}</p>}
            </div>
          </div>
        </td>
        <td className="px-3 py-3 w-28">
          {dec.priority && (
            <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${
              dec.priority === 'high' ? 'text-red-400 bg-red-400/10 border-red-400/20' :
              dec.priority === 'medium' ? 'text-amber-400 bg-amber-400/10 border-amber-400/20' :
              'text-emerald-400 bg-emerald-400/10 border-emerald-400/20'
            }`}>
              {dec.priority === 'high' ? 'Alta' : dec.priority === 'medium' ? 'Média' : 'Baixa'}
            </span>
          )}
        </td>
        <td className="px-3 py-3 w-56">
          {dec.current_value != null && dec.proposed_value != null ? (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-mono text-slate-400">{formatBRL(dec.current_value)}</span>
              <span className={`text-xs font-bold flex items-center gap-0.5 ${isUp ? 'text-emerald-400' : 'text-red-400'}`}>
                {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                {changePct != null ? `${isUp ? '+' : ''}${changePct.toFixed(1)}%` : '→'}
              </span>
              {editBid ? (
                <div className="flex items-center gap-1">
                  <span className="text-xs text-slate-500">R$</span>
                  <input type="number" value={bidValue} onChange={e => setBidValue(e.target.value)}
                    step={0.01} min={0.02}
                    className="w-16 px-1.5 py-0.5 bg-surface-3 border border-cyan/40 rounded text-xs font-mono text-white focus:outline-none"
                    autoFocus onBlur={() => !bidValue && setEditBid(false)} />
                  <button onClick={() => setEditBid(false)} className="text-slate-500 hover:text-slate-300">
                    <XCircle className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <button onClick={() => setEditBid(true)}
                  className="text-xs font-mono text-white bg-surface-2 hover:bg-surface-3 border border-surface-3 px-2 py-0.5 rounded transition-colors">
                  {formatBRL(bidValue || dec.proposed_value)}
                </button>
              )}
            </div>
          ) : <span className="text-xs text-slate-600">—</span>}
        </td>
        <td className="px-3 py-3 w-28">
          {dec.confidence != null && <ConfidenceBadge value={dec.confidence} />}
        </td>
        <td className="px-3 py-3 w-28">
          <span className={`text-xs font-medium ${matCfg.color}`}>{matCfg.label}</span>
        </td>
        <td className="px-3 py-3 w-24">
          <button onClick={() => setExpanded(v => !v)}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 transition-colors">
            {expanded ? <ChevronUp className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
            {expanded ? 'Fechar' : 'Ver'}
          </button>
        </td>
        <td className="px-3 py-3 pr-5 w-40">
          <div className="flex items-center gap-1.5">
            <button onClick={() => onApprove(editBid && bidValue ? Number(bidValue) : undefined)}
              disabled={isLoading}
              className="flex items-center gap-1 px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-white text-xs font-bold rounded-lg disabled:opacity-50 transition-colors whitespace-nowrap">
              {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
              Aprovar
            </button>
            <button onClick={onReject} disabled={isLoading}
              className="flex items-center gap-1 px-2.5 py-1.5 bg-surface-2 hover:bg-red-500/20 border border-surface-3 hover:border-red-500/30 text-slate-400 hover:text-red-400 text-xs font-bold rounded-lg disabled:opacity-50 transition-colors">
              <XCircle className="w-3 h-3" />
            </button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-surface-2/40 bg-surface-2/20">
          <td colSpan={8} className="px-8 py-4 space-y-3">
            {dec.rationale && (
              <div className="p-3 bg-surface-1 rounded-lg border border-surface-2">
                <p className="text-xs font-semibold text-cyan mb-1.5 flex items-center gap-1.5">
                  <Brain className="w-3 h-3" /> Análise da IA
                </p>
                <p className="text-xs text-slate-300 leading-relaxed">{dec.rationale}</p>
              </div>
            )}
            {dec.formula && (
              <div className="p-3 bg-surface-1 rounded-lg border border-surface-2">
                <p className="text-xs font-semibold text-amber-400 mb-1.5">Fórmula aplicada</p>
                <code className="text-xs text-slate-300 font-mono">{dec.formula}</code>
              </div>
            )}
            {metricsUsed && (
              <div>
                <p className="text-xs font-semibold text-slate-400 mb-2">Métricas usadas</p>
                <div className="flex flex-wrap gap-1.5">
                  {metricsUsed.clicks != null && <MetricPill label="Cliques" value={metricsUsed.clicks} />}
                  {metricsUsed.spend != null && <MetricPill label="Spend" value={formatBRL(metricsUsed.spend)} />}
                  {metricsUsed.sales != null && <MetricPill label="Vendas" value={formatBRL(metricsUsed.sales)} />}
                  {metricsUsed.orders != null && <MetricPill label="Pedidos" value={metricsUsed.orders} />}
                  {metricsUsed.acos != null && <MetricPill label="ACoS" value={`${Number(metricsUsed.acos).toFixed(1)}%`} highlight />}
                  {metricsUsed.roas != null && <MetricPill label="ROAS" value={`${Number(metricsUsed.roas).toFixed(2)}x`} highlight />}
                  {metricsUsed.cpc != null && <MetricPill label="CPC" value={formatBRL(metricsUsed.cpc)} />}
                  {metricsUsed.period && <MetricPill label="Período" value={metricsUsed.period} />}
                </div>
              </div>
            )}
            {dec.expected_impact && (
              <div className="flex items-center gap-2">
                <Target className="w-3.5 h-3.5 text-cyan flex-shrink-0" />
                <p className="text-xs text-slate-400"><span className="text-cyan font-medium">Impacto esperado:</span> {dec.expected_impact}</p>
              </div>
            )}
            {dec.next_review_at && (
              <p className="text-xs text-slate-500">
                Próxima revisão: {new Date(dec.next_review_at).toLocaleDateString('pt-BR')}
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function RunEnginePanel({ accountId, onDone }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);

  const run = async () => {
    setRunning(true);
    setResult(null);
    try {
      const res = await base44.functions.invoke('runDailyAdsOptimization', { amazon_account_id: accountId, trigger: 'manual' });
      const d = res.data;
      setResult({ ok: d?.ok !== false, msg: d?.message || `${d?.decisions_created || 0} recomendações geradas · ${d?.breakdown?.harvest || 0} termos colhidos` });
      if (d?.ok !== false) onDone?.();
    } catch (e) {
      setResult({ ok: false, msg: e.message });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <button onClick={run} disabled={running || !accountId}
        className="flex items-center gap-2 px-4 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60">
        {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Brain className="w-4 h-4" />}
        {running ? 'Analisando...' : 'Executar Motor IA'}
      </button>
      {result && (
        <span className={`text-xs px-3 py-1.5 rounded-lg border ${result.ok ? 'text-emerald-400 border-emerald-400/20 bg-emerald-400/5' : 'text-red-400 border-red-400/20 bg-red-400/5'}`}>
          {result.ok ? '✓' : '✗'} {result.msg}
        </span>
      )}
    </div>
  );
}

export default function Recommendations() {
  const [account, setAccount] = useState(null);
  const [decisions, setDecisions] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionStates, setActionStates] = useState({});
  const [tab, setTab] = useState('pending');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [filterType, setFilterType] = useState('all');
  const [filterConfidence, setFilterConfidence] = useState('all');
  const [error, setError] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0] || (await base44.entities.AmazonAccount.list())[0];
      setAccount(acc);
      if (!acc) { setLoading(false); return; }
      // Ler de OptimizationDecision (fonte canônica) + Decision (legado)
      const [optPending, optDone, legacyPending] = await Promise.all([
        base44.entities.OptimizationDecision.filter({ amazon_account_id: acc.id, status: 'pending' }, '-created_at', 200),
        base44.entities.OptimizationDecision.filter({ amazon_account_id: acc.id }, '-created_at', 100),
        base44.entities.Decision.filter({ amazon_account_id: acc.id, status: 'pending' }, '-created_date', 100),
      ]);
      // Normalizar campos para compatibilidade com DecisionRow
      const normalize = d => ({
        ...d,
        entity_name: d.keyword_text || d.entity_id || d.entity_name,
        current_value: d.value_before ?? d.current_value,
        proposed_value: d.value_after ?? d.proposed_value,
        decision_type: d.action || d.decision_type,
        confidence: d.confidence != null ? d.confidence / 100 : null,
        asin: d.asin,
      });
      const allPending = [...optPending.map(normalize), ...legacyPending.filter(l => !optPending.find(o => o.legacy_id === l.id))];
      const allDone    = optDone.filter(d => d.status !== 'pending').map(normalize);
      setDecisions(allPending);
      setHistory(allDone);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleDecision = async (decisionId, action, proposedValue) => {
    setActionStates(prev => ({ ...prev, [decisionId]: 'loading' }));
    try {
      // Tentar OptimizationDecision primeiro, fallback para Decision
      try {
        await base44.entities.OptimizationDecision.update(decisionId, { status: action === 'approve' ? 'approved' : 'rejected' });
      } catch {
        await base44.functions.invoke('approveDecision', { decision_id: decisionId, action, proposed_value: proposedValue });
      }
      setActionStates(prev => ({ ...prev, [decisionId]: action }));
      setTimeout(() => {
        setDecisions(prev => prev.filter(d => d.id !== decisionId));
        setActionStates(prev => { const n = { ...prev }; delete n[decisionId]; return n; });
      }, 350);
    } catch {
      setActionStates(prev => { const n = { ...prev }; delete n[decisionId]; return n; });
    }
  };

  const bulkAction = async (action) => {
    setBulkLoading(true);
    for (const id of selectedIds) await handleDecision(id, action);
    setSelectedIds(new Set());
    setBulkLoading(false);
  };

  const toggleSelect = (id) => setSelectedIds(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  const filtered = decisions.filter(d => {
    if (filterType !== 'all' && d.decision_type !== filterType) return false;
    if (filterConfidence !== 'all') {
      const conf = d.confidence ?? 0;
      if (filterConfidence === 'high' && conf < 0.75) return false;
      if (filterConfidence === 'medium' && (conf < 0.45 || conf >= 0.75)) return false;
      if (filterConfidence === 'low' && conf >= 0.45) return false;
    }
    return true;
  });

  const allSelected = selectedIds.size === filtered.length && filtered.length > 0;
  const decisionTypes = ['all', ...new Set(decisions.map(d => d.decision_type).filter(Boolean))];
  const stats = {
    pending: decisions.length,
    high: decisions.filter(d => d.priority === 'high').length,
    highConf: decisions.filter(d => (d.confidence ?? 0) >= 0.75).length,
    approved: history.filter(d => d.status === 'approved' || d.status === 'executed').length,
    rejected: history.filter(d => d.status === 'rejected').length,
  };

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <Brain className="w-5 h-5 text-cyan" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Recomendações IA</h1>
            <p className="text-xs text-slate-400">{stats.pending} pendentes · {stats.high} alta prioridade · {stats.highConf} alta confiança</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <RunEnginePanel accountId={account?.id} onDone={loadData} />
          {selectedIds.size > 0 && tab === 'pending' && (
            <>
              <span className="text-xs text-slate-500">{selectedIds.size} selecionadas</span>
              <button onClick={() => bulkAction('reject')} disabled={bulkLoading}
                className="flex items-center gap-1.5 px-3 py-2 bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50">
                <XCircle className="w-3.5 h-3.5" /> Rejeitar
              </button>
              <button onClick={() => bulkAction('approve')} disabled={bulkLoading}
                className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50">
                {bulkLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                Aprovar
              </button>
            </>
          )}
          <button onClick={loadData} disabled={loading} className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {[
          { label: 'Pendentes', value: stats.pending, color: 'text-amber-400', bg: 'bg-amber-400/10 border-amber-400/20' },
          { label: 'Alta Prioridade', value: stats.high, color: 'text-red-400', bg: 'bg-red-400/10 border-red-400/20' },
          { label: 'Alta Confiança', value: stats.highConf, color: 'text-cyan', bg: 'bg-cyan/10 border-cyan/20' },
          { label: 'Aprovadas', value: stats.approved, color: 'text-emerald-400', bg: 'bg-emerald-400/10 border-emerald-400/20' },
          { label: 'Rejeitadas', value: stats.rejected, color: 'text-slate-400', bg: 'bg-slate-400/10 border-slate-400/20' },
        ].map(s => (
          <div key={s.label} className={`rounded-xl border p-4 ${s.bg}`}>
            <p className="text-xs text-slate-500 mb-1">{s.label}</p>
            <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      <div className="flex border-b border-surface-2">
        {[
          { id: 'pending', label: `Fila de Aprovação (${stats.pending})` },
          { id: 'history', label: `Histórico (${history.length})` },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors ${tab === t.id ? 'border-cyan text-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-7 h-7 text-cyan animate-spin" /></div>
      ) : tab === 'pending' ? (
        <>
          {filtered.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <Filter className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
              <span className="text-xs text-slate-500">Tipo:</span>
              {decisionTypes.map(t => (
                <button key={t} onClick={() => setFilterType(t)}
                  className={`text-xs px-3 py-1 rounded-full border transition-colors ${filterType === t ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'}`}>
                  {t === 'all' ? 'Todas' : (ACTION_CONFIG[t]?.label || t)}
                </button>
              ))}
              <span className="text-xs text-slate-500 ml-2">Confiança:</span>
              {[
                { key: 'all', label: 'Todas' },
                { key: 'high', label: 'Alta' },
                { key: 'medium', label: 'Média' },
                { key: 'low', label: 'Baixa' },
              ].map(f => (
                <button key={f.key} onClick={() => setFilterConfidence(f.key)}
                  className={`text-xs px-3 py-1 rounded-full border transition-colors ${filterConfidence === f.key ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'}`}>
                  {f.label}
                </button>
              ))}
            </div>
          )}

          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
              <div className="w-16 h-16 rounded-2xl bg-cyan/10 border border-cyan/20 flex items-center justify-center">
                <Brain className="w-8 h-8 text-cyan/40" />
              </div>
              <div>
                <p className="text-base font-semibold text-slate-300">Sem recomendações pendentes</p>
                <p className="text-sm text-slate-500 mt-1">Clique em "Executar Motor IA" ou faça um Sync no Dashboard.</p>
              </div>
            </div>
          ) : (
            <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-surface-2 bg-surface-2/50">
                      <th className="pl-4 py-2.5 w-8">
                        <input type="checkbox" checked={allSelected} onChange={() => {
                          if (allSelected) setSelectedIds(new Set());
                          else setSelectedIds(new Set(filtered.map(d => d.id)));
                        }} className="w-3.5 h-3.5 accent-cyan" />
                      </th>
                      {['Entidade / Ação', 'Prioridade', 'Atual → Proposto', 'Confiança', 'Maturidade', 'Detalhes', 'Ação'].map(h => (
                        <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(dec => (
                      <DecisionRow
                        key={dec.id}
                        dec={dec}
                        actionState={actionStates[dec.id]}
                        selected={selectedIds.has(dec.id)}
                        onSelect={() => toggleSelect(dec.id)}
                        onApprove={(v) => handleDecision(dec.id, 'approve', v)}
                        onReject={() => handleDecision(dec.id, 'reject')}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-3 border-t border-surface-2">
                <p className="text-xs text-slate-500">{filtered.length} recomendações · clique no bid proposto para editar · expanda para ver fórmula e métricas</p>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-2 bg-surface-2/50">
                {['Tipo', 'Entidade', 'Bid Atual → Proposto', 'Variação', 'Estado', 'Data'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <tr><td colSpan={6} className="px-5 py-10 text-center text-sm text-slate-500">Sem histórico</td></tr>
              ) : history.map(d => {
                const changePct = d.change_pct;
                const cfg = ACTION_CONFIG[d.decision_type] || { label: d.decision_type, icon: '🤖' };
                return (
                  <tr key={d.id} className="border-b border-surface-2/40 hover:bg-surface-2/60 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <span>{cfg.icon}</span>
                        <span className="text-xs text-slate-300">{cfg.label}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400 max-w-[180px] truncate">{d.entity_name || d.entity_id || '—'}</td>
                    <td className="px-4 py-3 text-xs font-mono text-slate-300 whitespace-nowrap">
                      {d.current_value != null ? `${formatBRL(d.current_value)} → ${formatBRL(d.proposed_value)}` : '—'}
                    </td>
                    <td className="px-4 py-3">
                      {changePct != null && (
                        <span className={`text-xs font-semibold flex items-center gap-1 ${changePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {changePct >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                          {changePct >= 0 ? '+' : ''}{changePct.toFixed(1)}%
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={d.status} size="xs" /></td>
                    <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                      {new Date(d.created_date).toLocaleDateString('pt-BR')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}