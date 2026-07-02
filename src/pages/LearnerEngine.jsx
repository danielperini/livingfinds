import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Brain, CheckCircle, XCircle, Loader2, TrendingUp, TrendingDown,
  RefreshCw, AlertCircle, Clock, Filter, ChevronDown, ChevronUp, Zap
} from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import BiddingRulesPanel from '@/components/learner/BiddingRulesPanel';

const DECISION_LABELS = {
  bid_adjust: 'Ajuste de Bid',
  budget_change: 'Orçamento',
  pause_campaign: 'Pausar',
  enable_campaign: 'Ativar',
  add_keyword: 'Add Keyword',
  negate_keyword: 'Negativar KW',
  pause_ad_group: 'Pausar AG',
  enable_ad_group: 'Ativar AG',
};

const TYPE_ICONS = {
  bid_adjust: '💰',
  budget_change: '📊',
  pause_campaign: '⏸️',
  enable_campaign: '▶️',
  add_keyword: '🔑',
  negate_keyword: '🚫',
};

const PRIORITY_COLORS = {
  high: 'text-red-400 bg-red-400/10 border-red-400/20',
  medium: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
  low: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
};

/* ─── Row da tabela de sugestões ─── */
function SuggestionRow({ dec, actionState, onApprove, onReject, selected, onSelect }) {
  const [showRationale, setShowRationale] = useState(false);
  const [editBid, setEditBid] = useState(false);
  const [bidValue, setBidValue] = useState(dec.proposed_value ?? '');

  const isLoading = actionState === 'loading';
  const isDone = actionState === 'approved' || actionState === 'rejected';

  const changePct = dec.change_pct ??
    (dec.current_value && dec.proposed_value
      ? ((dec.proposed_value - dec.current_value) / dec.current_value) * 100
      : null);
  const isPositive = (changePct ?? 0) >= 0;

  const handleApprove = () => onApprove(editBid && bidValue ? Number(bidValue) : undefined);

  if (isDone) return null;

  return (
    <>
      <tr className={`border-b border-surface-2/40 transition-colors ${selected ? 'bg-cyan/5' : 'hover:bg-surface-2/60'}`}>
        {/* Checkbox */}
        <td className="pl-4 py-3 w-8">
          <input type="checkbox" checked={selected} onChange={onSelect}
            className="w-3.5 h-3.5 accent-cyan rounded" />
        </td>

        {/* Tipo + entidade */}
        <td className="px-3 py-3 min-w-[180px]">
          <div className="flex items-center gap-2">
            <span className="text-base leading-none">{TYPE_ICONS[dec.decision_type] || '🤖'}</span>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-white truncate max-w-[160px]">{dec.entity_name || dec.entity_id || '—'}</p>
              <p className="text-xs text-slate-500 mt-0.5">{DECISION_LABELS[dec.decision_type] || dec.decision_type}</p>
            </div>
          </div>
        </td>

        {/* Prioridade */}
        <td className="px-3 py-3 w-24">
          {dec.priority && (
            <span className={`text-xs px-2 py-0.5 rounded-full border font-medium capitalize ${PRIORITY_COLORS[dec.priority] || ''}`}>
              {dec.priority === 'high' ? 'Alta' : dec.priority === 'medium' ? 'Média' : 'Baixa'}
            </span>
          )}
        </td>

        {/* Bid atual → proposto */}
        <td className="px-3 py-3 w-52">
          {dec.current_value != null && dec.proposed_value != null ? (
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-slate-400">${Number(dec.current_value).toFixed(2)}</span>
              <span className={`text-xs font-bold flex items-center gap-0.5 ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
                {isPositive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                {changePct != null ? `${isPositive ? '+' : ''}${changePct.toFixed(1)}%` : '→'}
              </span>
              {editBid ? (
                <div className="flex items-center gap-1">
                  <span className="text-xs text-slate-500">$</span>
                  <input
                    type="number"
                    value={bidValue}
                    onChange={e => setBidValue(e.target.value)}
                    step={0.01} min={0.02}
                    className="w-16 px-1.5 py-0.5 bg-surface-3 border border-cyan/40 rounded text-xs font-mono text-white focus:outline-none"
                    autoFocus
                    onBlur={() => !bidValue && setEditBid(false)}
                  />
                  <button onClick={() => setEditBid(false)} className="text-slate-500 hover:text-slate-300">
                    <XCircle className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <button onClick={() => setEditBid(true)}
                  className="text-xs font-mono text-white bg-surface-2 hover:bg-surface-3 border border-surface-3 px-2 py-0.5 rounded transition-colors">
                  ${Number(bidValue || dec.proposed_value).toFixed(2)}
                </button>
              )}
            </div>
          ) : <span className="text-xs text-slate-600">—</span>}
        </td>

        {/* Confiança IA */}
        <td className="px-3 py-3 w-24">
          {dec.confidence != null && (
            <div className="flex items-center gap-1.5">
              <div className="w-14 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                <div className="h-full bg-cyan rounded-full" style={{ width: `${Math.min(dec.confidence * 100, 100)}%` }} />
              </div>
              <span className="text-xs text-slate-500">{(dec.confidence * 100).toFixed(0)}%</span>
            </div>
          )}
        </td>

        {/* Rationale toggle */}
        <td className="px-3 py-3 w-32">
          <button onClick={() => setShowRationale(v => !v)}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 transition-colors">
            {showRationale ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            Análise IA
          </button>
        </td>

        {/* Ações rápidas */}
        <td className="px-3 py-3 pr-5 w-36">
          <div className="flex items-center gap-1.5">
            <button onClick={handleApprove} disabled={isLoading}
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

      {/* Linha expandida com rationale */}
      {showRationale && (
        <tr className="border-b border-surface-2/40 bg-surface-2/30">
          <td colSpan={7} className="px-10 py-3">
            <p className="text-xs text-slate-400 leading-relaxed italic">
              💡 {dec.rationale || 'Sem análise disponível.'}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

/* ─── Histórico row ─── */
function HistoryRow({ d }) {
  const changePct = d.change_pct;
  return (
    <tr className="border-b border-surface-2/40 hover:bg-surface-2/60 transition-colors">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span>{TYPE_ICONS[d.decision_type] || '🤖'}</span>
          <span className="text-xs text-slate-300">{DECISION_LABELS[d.decision_type] || d.decision_type}</span>
        </div>
      </td>
      <td className="px-4 py-3 text-xs text-slate-400 max-w-[180px] truncate">{d.entity_name || d.entity_id || '—'}</td>
      <td className="px-4 py-3 text-xs font-mono text-slate-300 whitespace-nowrap">
        {d.current_value != null ? `$${d.current_value.toFixed(2)} → $${d.proposed_value.toFixed(2)}` : '—'}
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
}

/* ─── Página principal ─── */
export default function LearnerEngine() {
  const [account, setAccount] = useState(null);
  const [decisions, setDecisions] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionStates, setActionStates] = useState({});
  const [tab, setTab] = useState('pending');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [filterType, setFilterType] = useState('all');
  const [error, setError] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0];
      setAccount(acc);
      if (!acc) { setLoading(false); return; }
      const [optPending, legacyPending, done] = await Promise.all([
        base44.entities.OptimizationDecision.filter({ amazon_account_id: acc.id, status: 'pending' }, '-created_at', 200),
        base44.entities.Decision.filter({ amazon_account_id: acc.id, status: 'pending' }, '-created_date', 100),
        base44.entities.OptimizationDecision.filter({ amazon_account_id: acc.id }, '-created_at', 100),
      ]);
      const normalize = d => ({
        ...d,
        entity_name: d.keyword_text || d.entity_id || d.entity_name,
        current_value: d.value_before ?? d.current_value,
        proposed_value: d.value_after ?? d.proposed_value,
        decision_type: d.action || d.decision_type,
        confidence: d.confidence != null ? (d.confidence > 1 ? d.confidence / 100 : d.confidence) : null,
        priority: (d.risk === 'high' || d.risk === 'very_high') ? 'high' : d.risk === 'medium' ? 'medium' : 'low',
      });
      const allPending = [...optPending.map(normalize), ...legacyPending.filter(l => !optPending.find(o => o.legacy_id === l.id))];
      setDecisions(allPending);
      setHistory(done.filter(d => d.status !== 'pending').map(normalize));
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

  const filteredDecisions = filterType === 'all' ? decisions : decisions.filter(d => d.decision_type === filterType);
  const allSelected = selectedIds.size === filteredDecisions.length && filteredDecisions.length > 0;
  const decisionTypes = ['all', ...new Set(decisions.map(d => d.decision_type).filter(Boolean))];

  const stats = {
    pending: decisions.length,
    high: decisions.filter(d => d.priority === 'high').length,
    approved: history.filter(d => d.status === 'approved' || d.status === 'executed').length,
    rejected: history.filter(d => d.status === 'rejected').length,
  };

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* ── Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <Brain className="w-5 h-5 text-cyan" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Learner Engine</h1>
            <p className="text-xs text-slate-400">
              {stats.pending} pendentes · {stats.high} alta prioridade
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && tab === 'pending' && (
            <>
              <span className="text-xs text-slate-500">{selectedIds.size} selecionadas</span>
              <button onClick={() => bulkAction('reject')} disabled={bulkLoading}
                className="flex items-center gap-1.5 px-3 py-2 bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50">
                <XCircle className="w-3.5 h-3.5" /> Rejeitar todas
              </button>
              <button onClick={() => bulkAction('approve')} disabled={bulkLoading}
                className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50">
                {bulkLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                Aprovar todas
              </button>
            </>
          )}
          <button onClick={loadData} disabled={loading} className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* ── KPIs ── */}
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

      {/* ── Tabs ── */}
      <div className="flex border-b border-surface-2">
        {[
          { id: 'pending', label: `Sugestões (${stats.pending})` },
          { id: 'history', label: `Histórico (${history.length})` },
          { id: 'rules', label: 'Regras Automáticas' },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors ${tab === t.id ? 'border-cyan text-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-7 h-7 text-cyan animate-spin" /></div>
      ) : tab === 'rules' ? (
        <BiddingRulesPanel amazonAccountId={account?.id} />
      ) : tab === 'pending' ? (
        <>
          {/* Filtros de tipo */}
          {decisions.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <Filter className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
              {decisionTypes.map(t => (
                <button key={t} onClick={() => setFilterType(t)}
                  className={`text-xs px-3 py-1 rounded-full border transition-colors ${filterType === t ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'}`}>
                  {t === 'all' ? 'Todas' : (DECISION_LABELS[t] || t)}
                </button>
              ))}
            </div>
          )}

          {filteredDecisions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
              <div className="w-16 h-16 rounded-2xl bg-cyan/10 border border-cyan/20 flex items-center justify-center">
                <Brain className="w-8 h-8 text-cyan/40" />
              </div>
              <div>
                <p className="text-base font-semibold text-slate-300">Sem sugestões pendentes</p>
                <p className="text-sm text-slate-500 mt-1">Execute "Sync Amazon Ads 30d" no Dashboard para gerar recomendações.</p>
              </div>
            </div>
          ) : (
            <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
              {/* Legenda das colunas */}
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-surface-2 bg-surface-2/50">
                      <th className="pl-4 py-2.5 w-8">
                        <input type="checkbox" checked={allSelected} onChange={() => {
                          if (allSelected) setSelectedIds(new Set());
                          else setSelectedIds(new Set(filteredDecisions.map(d => d.id)));
                        }} className="w-3.5 h-3.5 accent-cyan" />
                      </th>
                      {['Campanha / Entidade', 'Prioridade', 'Bid Atual → Proposto', 'Confiança IA', 'Análise', 'Ação Rápida'].map(h => (
                        <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredDecisions.map(dec => (
                      <SuggestionRow
                        key={dec.id}
                        dec={dec}
                        actionState={actionStates[dec.id]}
                        selected={selectedIds.has(dec.id)}
                        onSelect={() => toggleSelect(dec.id)}
                        onApprove={(proposedValue) => handleDecision(dec.id, 'approve', proposedValue)}
                        onReject={() => handleDecision(dec.id, 'reject')}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-3 border-t border-surface-2 flex items-center justify-between">
                <p className="text-xs text-slate-500">{filteredDecisions.length} sugestões · clique no bid proposto para editar antes de aprovar</p>
                {filteredDecisions.length > 3 && (
                  <div className="flex gap-2">
                    <button onClick={() => bulkAction('reject')} disabled={bulkLoading}
                      className="text-xs px-3 py-1.5 bg-surface-2 border border-surface-3 text-red-400 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-50">
                      Rejeitar todas
                    </button>
                    <button onClick={() => bulkAction('approve')} disabled={bulkLoading}
                      className="text-xs px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-lg transition-colors disabled:opacity-50">
                      {bulkLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin inline" /> : 'Aprovar todas'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      ) : (
        /* Histórico */
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-2 bg-surface-2/50">
                {['Tipo', 'Entidade', 'Valor', 'Variação', 'Estado', 'Data'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <tr><td colSpan={6} className="px-5 py-10 text-center text-sm text-slate-500">Sem histórico de decisões</td></tr>
              ) : history.map(d => <HistoryRow key={d.id} d={d} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}