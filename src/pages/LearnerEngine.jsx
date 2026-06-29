import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Brain, CheckCircle, XCircle, Loader2, TrendingUp, TrendingDown,
  Zap, ChevronDown, ChevronUp, RefreshCw, AlertCircle, Clock, Filter
} from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';

const DECISION_LABELS = {
  bid_adjust: 'Ajuste de Bid',
  budget_change: 'Alteração de Orçamento',
  pause_campaign: 'Pausar Campanha',
  enable_campaign: 'Ativar Campanha',
  add_keyword: 'Adicionar Keyword',
  negate_keyword: 'Negativar Keyword',
  pause_ad_group: 'Pausar Ad Group',
  enable_ad_group: 'Ativar Ad Group',
};

const TYPE_ICONS = {
  bid_adjust: '💰',
  budget_change: '📊',
  pause_campaign: '⏸️',
  enable_campaign: '▶️',
  add_keyword: '🔑',
  negate_keyword: '🚫',
};

function DecisionCard({ dec, onApprove, onReject, actionState }) {
  const [expanded, setExpanded] = useState(false);
  const isLoading = actionState === 'loading';
  const isDone = actionState === 'approved' || actionState === 'rejected';
  const changePct = dec.change_pct ?? (dec.current_value && dec.proposed_value ? ((dec.proposed_value - dec.current_value) / dec.current_value) * 100 : null);
  const isPositive = (changePct ?? 0) >= 0;

  return (
    <div className={`bg-surface-1 border border-surface-2 rounded-xl overflow-hidden transition-all duration-300 ${isDone ? 'opacity-0 scale-95 pointer-events-none' : ''}`}>
      <div className="p-5">
        <div className="flex items-start gap-4">
          {/* Ícone */}
          <div className="w-10 h-10 rounded-xl bg-surface-2 border border-surface-3 flex items-center justify-center flex-shrink-0 text-lg">
            {TYPE_ICONS[dec.decision_type] || '🤖'}
          </div>

          {/* Conteúdo */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="text-sm font-semibold text-white">
                {DECISION_LABELS[dec.decision_type] || dec.decision_type}
              </span>
              {dec.priority && <StatusBadge status={dec.priority} size="xs" />}
              {dec.confidence != null && (
                <span className="text-xs text-slate-500 bg-surface-2 px-2 py-0.5 rounded-full">
                  {(Number(dec.confidence) * 100).toFixed(0)}% conf.
                </span>
              )}
            </div>

            <p className="text-xs text-slate-400 mb-3 truncate">{dec.entity_name || dec.entity_id || '—'}</p>

            {/* Valor atual → proposto */}
            {dec.current_value != null && dec.proposed_value != null && (
              <div className="flex items-center gap-3 mb-3 p-3 bg-surface-2 rounded-lg">
                <div className="text-center">
                  <p className="text-xs text-slate-500 mb-0.5">Atual</p>
                  <p className="text-sm font-mono font-semibold text-slate-300">${Number(dec.current_value).toFixed(2)}</p>
                </div>
                <div className="flex-1 flex items-center justify-center">
                  <div className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-bold ${isPositive ? 'bg-emerald-400/10 text-emerald-400' : 'bg-red-400/10 text-red-400'}`}>
                    {isPositive ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
                    {changePct != null ? `${isPositive ? '+' : ''}${Number(changePct).toFixed(1)}%` : '→'}
                  </div>
                </div>
                <div className="text-center">
                  <p className="text-xs text-slate-500 mb-0.5">Proposto</p>
                  <p className="text-sm font-mono font-bold text-white">${Number(dec.proposed_value).toFixed(2)}</p>
                </div>
              </div>
            )}

            {/* Rationale toggle */}
            <button onClick={() => setExpanded(v => !v)}
              className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 transition-colors">
              {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {expanded ? 'Ocultar' : 'Ver'} análise da IA
            </button>
            {expanded && (
              <p className="mt-2 text-xs text-slate-400 bg-surface-2 rounded-lg p-3 leading-relaxed border border-surface-3">
                {dec.rationale || '—'}
              </p>
            )}
          </div>

          {/* Acções */}
          <div className="flex flex-col gap-2 flex-shrink-0">
            <button onClick={onApprove} disabled={isLoading || isDone}
              className="flex items-center gap-1.5 px-4 py-2 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 text-xs font-semibold rounded-lg disabled:opacity-50 transition-colors whitespace-nowrap">
              {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
              Aprovar
            </button>
            <button onClick={onReject} disabled={isLoading || isDone}
              className="flex items-center gap-1.5 px-4 py-2 bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 text-xs font-semibold rounded-lg disabled:opacity-50 transition-colors whitespace-nowrap">
              <XCircle className="w-3.5 h-3.5" /> Rejeitar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LearnerEngine() {
  const [decisions, setDecisions] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionStates, setActionStates] = useState({});
  const [tab, setTab] = useState('pending');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkApproving, setBulkApproving] = useState(false);
  const [filterType, setFilterType] = useState('all');
  const [error, setError] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0];
      if (!acc) { setLoading(false); return; }

      const [pending, done] = await Promise.all([
        base44.entities.Decision.filter({ amazon_account_id: acc.id, status: 'pending' }, '-created_date', 200),
        base44.entities.Decision.filter({ amazon_account_id: acc.id }, '-created_date', 100),
      ]);
      setDecisions(pending);
      setHistory(done.filter(d => d.status !== 'pending'));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleDecision = async (decisionId, action) => {
    setActionStates(prev => ({ ...prev, [decisionId]: 'loading' }));
    try {
      await base44.functions.invoke('approveDecision', { decision_id: decisionId, action });
      setActionStates(prev => ({ ...prev, [decisionId]: action === 'approve' ? 'approved' : 'rejected' }));
      setTimeout(() => {
        setDecisions(prev => prev.filter(d => d.id !== decisionId));
        setActionStates(prev => { const n = { ...prev }; delete n[decisionId]; return n; });
      }, 400);
    } catch (err) {
      setActionStates(prev => ({ ...prev, [decisionId]: 'error' }));
      setTimeout(() => setActionStates(prev => { const n = { ...prev }; delete n[decisionId]; return n; }), 3000);
    }
  };

  const bulkApprove = async () => {
    setBulkApproving(true);
    for (const id of selectedIds) await handleDecision(id, 'approve');
    setSelectedIds(new Set());
    setBulkApproving(false);
  };

  const bulkReject = async () => {
    setBulkApproving(true);
    for (const id of selectedIds) await handleDecision(id, 'reject');
    setSelectedIds(new Set());
    setBulkApproving(false);
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const selectAll = () => {
    if (selectedIds.size === filteredDecisions.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(filteredDecisions.map(d => d.id)));
  };

  const decisionTypes = ['all', ...new Set(decisions.map(d => d.decision_type).filter(Boolean))];
  const filteredDecisions = filterType === 'all' ? decisions : decisions.filter(d => d.decision_type === filterType);

  // Estatísticas
  const stats = {
    pending: decisions.length,
    high: decisions.filter(d => d.priority === 'high').length,
    approved: history.filter(d => d.status === 'approved' || d.status === 'executed').length,
    rejected: history.filter(d => d.status === 'rejected').length,
  };

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <Brain className="w-5 h-5 text-cyan" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Learner Engine</h1>
            <p className="text-xs text-slate-400">{stats.pending} recomendações pendentes · {stats.high} alta prioridade</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <>
              <button onClick={bulkReject} disabled={bulkApproving}
                className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 text-sm font-semibold rounded-lg transition-colors">
                <XCircle className="w-4 h-4" /> Rejeitar {selectedIds.size}
              </button>
              <button onClick={bulkApprove} disabled={bulkApproving}
                className="flex items-center gap-2 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded-lg transition-colors">
                {bulkApproving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                Aprovar {selectedIds.size}
              </button>
            </>
          )}
          <button onClick={loadData} className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Pendentes', value: stats.pending, color: 'text-amber-400', bg: 'bg-amber-400/10 border-amber-400/20' },
          { label: 'Alta Prioridade', value: stats.high, color: 'text-red-400', bg: 'bg-red-400/10 border-red-400/20' },
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

      {/* Tabs */}
      <div className="flex border-b border-surface-2">
        {[
          { id: 'pending', label: `Pendentes (${stats.pending})` },
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
          {/* Filtros + Select All */}
          {decisions.length > 0 && (
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1.5">
                <Filter className="w-3.5 h-3.5 text-slate-500" />
                <span className="text-xs text-slate-500">Tipo:</span>
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {decisionTypes.map(t => (
                  <button key={t} onClick={() => setFilterType(t)}
                    className={`text-xs px-3 py-1 rounded-full border transition-colors ${filterType === t ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'}`}>
                    {t === 'all' ? 'Todas' : (DECISION_LABELS[t] || t)}
                  </button>
                ))}
              </div>
              <button onClick={selectAll} className="ml-auto text-xs text-slate-500 hover:text-slate-300 flex items-center gap-1">
                <input type="checkbox" readOnly checked={selectedIds.size === filteredDecisions.length && filteredDecisions.length > 0} className="w-3.5 h-3.5 accent-cyan" />
                Selecionar todas ({filteredDecisions.length})
              </button>
            </div>
          )}

          {filteredDecisions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
              <div className="w-16 h-16 rounded-2xl bg-cyan/10 border border-cyan/20 flex items-center justify-center">
                <Brain className="w-8 h-8 text-cyan/50" />
              </div>
              <div>
                <p className="text-base font-semibold text-slate-300">Sem recomendações pendentes</p>
                <p className="text-sm text-slate-500 mt-1">Execute "Sync Amazon Ads 30d" no Dashboard para gerar novas recomendações IA.</p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredDecisions.map(dec => (
                <div key={dec.id} className="flex items-start gap-3">
                  <input type="checkbox" checked={selectedIds.has(dec.id)} onChange={() => toggleSelect(dec.id)}
                    className="mt-6 w-4 h-4 accent-cyan flex-shrink-0" />
                  <div className="flex-1">
                    <DecisionCard
                      dec={dec}
                      actionState={actionStates[dec.id]}
                      onApprove={() => handleDecision(dec.id, 'approve')}
                      onReject={() => handleDecision(dec.id, 'reject')}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        /* Histórico */
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-2">
                {['Tipo', 'Entidade', 'Valor', 'Alteração', 'Estado', 'Data'].map(h => (
                  <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <tr><td colSpan={6} className="px-5 py-10 text-center text-sm text-slate-500">Sem histórico de decisões</td></tr>
              ) : history.map(d => (
                <tr key={d.id} className="border-b border-surface-2/50 hover:bg-surface-2 transition-colors">
                  <td className="px-5 py-3 text-xs text-slate-300 whitespace-nowrap">
                    <span className="mr-1">{TYPE_ICONS[d.decision_type] || '🤖'}</span>
                    {DECISION_LABELS[d.decision_type] || d.decision_type}
                  </td>
                  <td className="px-5 py-3 text-xs text-slate-400 truncate max-w-[200px]">{d.entity_name || d.entity_id || '—'}</td>
                  <td className="px-5 py-3 text-xs font-mono text-slate-300 whitespace-nowrap">
                    {d.current_value != null ? `$${d.current_value?.toFixed(2)} → $${d.proposed_value?.toFixed(2)}` : '—'}
                  </td>
                  <td className="px-5 py-3">
                    {d.change_pct != null && (
                      <span className={`text-xs font-semibold flex items-center gap-1 ${d.change_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {d.change_pct >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                        {d.change_pct >= 0 ? '+' : ''}{d.change_pct?.toFixed(1)}%
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-3"><StatusBadge status={d.status} size="xs" /></td>
                  <td className="px-5 py-3 text-xs text-slate-500 whitespace-nowrap flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {new Date(d.created_date).toLocaleDateString('pt-BR')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}