import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { CheckCircle, XCircle, Loader2, TrendingUp, TrendingDown, ChevronDown, ChevronUp, Play } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';

const DECISION_LABELS = {
  bid_change: '💰 Ajuste de Bid',
  budget_change: '📊 Ajuste de Orçamento',
  pause: '⏸️ Pausar',
  enable: '▶️ Ativar',
  negative_keyword: '🚫 Negativar',
  create_keyword: '➕ Criar Keyword',
  harvest_search_term: '🌱 Colher Termo',
  dayparting_rule: '🕐 Horário',
  placement_change: '📍 Placement',
  create_campaign: '📣 Criar Campanha',
};

const ACTION_LABELS = {
  reduce_bid: '↓ Reduzir Bid',
  increase_bid: '↑ Aumentar Bid',
  pause_campaign: '⏸ Pausar Campanha',
  enable_campaign: '▶ Ativar Campanha',
  negative_exact: '🚫 Negativar Exato',
  create_keyword: '➕ Keyword Exact',
  update_bid: '💰 Atualizar Bid',
  update_budget: '📊 Atualizar Budget',
};

const RISK_COLORS = {
  very_low: 'text-emerald-300 bg-emerald-400/10 border-emerald-400/20',
  low: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
  medium: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
  high: 'text-red-400 bg-red-400/10 border-red-400/20',
  very_high: 'text-red-600 bg-red-500/10 border-red-500/20',
};

const RISK_LABELS = { very_low: 'Muito Baixo', low: 'Baixo', medium: 'Médio', high: 'Alto', very_high: 'Muito Alto' };

const OUTCOME_COLORS = {
  EXECUTE_NOW: 'text-emerald-400',
  SCHEDULE: 'text-cyan',
  WAIT_FOR_DATA: 'text-slate-400',
  RECOMMEND_APPROVAL: 'text-amber-400',
  BLOCK: 'text-red-400',
  ROLLBACK: 'text-purple-400',
  NO_ACTION: 'text-slate-500',
};

const MATURITY_LABELS = {
  NEW: '🌱 Nova',
  LEARNING: '📚 Aprendendo',
  MATURE: '✅ Madura',
  STALE: '⚠ Desatualizada',
  INSUFFICIENT_DATA: '⏳ Aguardando dados',
};

function DecisionRow({ d, onUpdate }) {
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const currencySymbol = d.currency_symbol || 'R$';
  const changePct = d.change_pct || 0;
  const isIncrease = changePct > 0;
  const isCritical = ['pause', 'enable', 'negative_keyword', 'create_campaign'].includes(d.decision_type);

  if (!['pending', 'approved'].includes(d.status)) return null;

  const approve = async () => {
    setLoading(true);
    await base44.entities.OptimizationDecision.update(d.id, { status: 'approved' });
    onUpdate(d.id, 'approved');
    setLoading(false);
  };

  const reject = async () => {
    setLoading(true);
    await base44.entities.OptimizationDecision.update(d.id, { status: 'rejected' });
    onUpdate(d.id, 'rejected');
    setLoading(false);
  };

  const execute = async () => {
    if (isCritical && !window.confirm(`Confirma executar "${DECISION_LABELS[d.decision_type]}" — ${d.keyword_text || d.entity_id}?`)) return;
    setLoading(true);
    const res = await base44.functions.invoke('executeAutopilotDecision', { decision_ids: [d.id] });
    const status = res.data?.results?.[0]?.ok ? 'executed' : 'failed';
    onUpdate(d.id, status);
    setLoading(false);
  };

  return (
    <>
      <tr className="border-b border-surface-2/40 hover:bg-surface-2/50 transition-colors">
        <td className="px-4 py-3">
          <div className="text-xs font-semibold text-white truncate max-w-[180px]">{d.keyword_text || d.entity_id || '—'}</div>
          <div className="text-xs text-slate-500 mt-0.5">{DECISION_LABELS[d.decision_type] || d.decision_type} · {ACTION_LABELS[d.action] || d.action}</div>
          {d.asin && <div className="text-[10px] font-mono text-cyan mt-0.5">{d.asin}</div>}
        </td>
        <td className="px-3 py-3">
          <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${RISK_COLORS[d.risk] || RISK_COLORS.medium}`}>
            {RISK_LABELS[d.risk] || d.risk}
          </span>
        </td>
        <td className="px-3 py-3">
          {d.value_before != null && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-mono text-slate-400">{currencySymbol}{Number(d.value_before).toFixed(2)}</span>
              <span className={`text-xs font-bold flex items-center gap-0.5 ${isIncrease ? 'text-emerald-400' : 'text-red-400'}`}>
                {isIncrease ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                {isIncrease ? '+' : ''}{changePct.toFixed(1)}%
              </span>
              <span className="text-xs font-mono text-white">{currencySymbol}{Number(d.value_after || 0).toFixed(2)}</span>
            </div>
          )}
          {d.value_before == null && d.action && (
            <span className="text-xs text-slate-500">{ACTION_LABELS[d.action] || d.action}</span>
          )}
        </td>
        <td className="px-3 py-3">
          <div className="flex items-center gap-2 mb-1">
            {d.confidence != null && (
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${d.confidence >= 75 ? 'bg-emerald-400/15 text-emerald-400' : d.confidence >= 60 ? 'bg-amber-400/15 text-amber-400' : 'bg-red-400/15 text-red-400'}`}>
                {d.confidence}% conf.
              </span>
            )}
            {d.evaluation_due_at && (
              <span className="text-[10px] text-slate-500">
                Rev. {new Date(d.evaluation_due_at).toLocaleDateString('pt-BR')}
              </span>
            )}
          </div>
          <button onClick={() => setExpanded(v => !v)} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300">
            {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            <span className="truncate max-w-[200px]">{(d.rationale || d.reason || '').split('\n')[0]}</span>
          </button>
        </td>
        <td className="px-3 py-3"><StatusBadge status={d.status} size="xs" /></td>
        <td className="px-4 py-3">
          <div className="flex items-center gap-1.5">
            {d.status === 'pending' && (
              <>
                <button onClick={approve} disabled={loading}
                  className="flex items-center gap-1 px-2.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-lg disabled:opacity-50 transition-colors">
                  {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                  Aprovar
                </button>
                <button onClick={reject} disabled={loading}
                  className="p-1.5 bg-surface-2 hover:bg-red-500/20 border border-surface-3 hover:border-red-400/30 text-slate-400 hover:text-red-400 rounded-lg disabled:opacity-50 transition-colors">
                  <XCircle className="w-3.5 h-3.5" />
                </button>
              </>
            )}
            {d.status === 'approved' && (
              <button onClick={execute} disabled={loading}
                className="flex items-center gap-1 px-2.5 py-1.5 bg-cyan hover:bg-cyan/90 text-white text-xs font-bold rounded-lg disabled:opacity-50 transition-colors">
                {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                Executar
              </button>
            )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-surface-2/40 bg-surface-2/20">
          <td colSpan={6} className="px-8 py-2.5 space-y-1">
            {d.rationale && <p className="text-xs text-slate-400">💡 {d.rationale}</p>}
            {d.data_used && <p className="text-xs text-slate-500">📊 {d.data_used}</p>}
            {d.idempotency_key && <p className="text-[10px] font-mono text-slate-600">🔑 {d.idempotency_key}</p>}
            {d.legacy_source && <p className="text-[10px] text-slate-600">📦 Migrado de: {d.legacy_source}</p>}
          </td>
        </tr>
      )}
    </>
  );
}

export default function AutopilotDecisionsTable({ decisions, onRefresh }) {
  const [filter, setFilter] = useState('pending');
  const [bulkLoading, setBulkLoading] = useState(false);
  const [localDecisions, setLocalDecisions] = useState(decisions);

  // Sync com prop externo
  if (decisions !== localDecisions && decisions.length !== localDecisions.length) {
    setLocalDecisions(decisions);
  }

  const updateDecision = (id, status) => {
    setLocalDecisions(prev => prev.map(d => d.id === id ? { ...d, status } : d));
  };

  const filtered = localDecisions.filter(d =>
    filter === 'all' ? true :
    filter === 'pending' ? d.status === 'pending' :
    filter === 'approved' ? d.status === 'approved' :
    filter === 'executed' ? d.status === 'executed' :
    d.status === 'rejected' || d.status === 'failed' || d.status === 'skipped'
  );

  const approveAll = async () => {
    setBulkLoading(true);
    const pendingLow = localDecisions.filter(d => d.status === 'pending' && (d.risk === 'low' || d.risk === 'very_low'));
    for (const d of pendingLow) {
      await base44.entities.OptimizationDecision.update(d.id, { status: 'approved' });
      updateDecision(d.id, 'approved');
    }
    setBulkLoading(false);
  };

  const counts = {
    pending: localDecisions.filter(d => d.status === 'pending').length,
    approved: localDecisions.filter(d => d.status === 'approved').length,
    executed: localDecisions.filter(d => d.status === 'executed').length,
    rejected: localDecisions.filter(d => ['rejected', 'failed', 'skipped'].includes(d.status)).length,
  };

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-surface-2 flex-wrap gap-2">
        <div className="flex gap-1 flex-wrap">
          {[
            { k: 'pending', label: `Pendentes (${counts.pending})` },
            { k: 'approved', label: `Aprovadas (${counts.approved})` },
            { k: 'executed', label: `Executadas (${counts.executed})` },
            { k: 'rejected', label: `Rejeitadas/Falhas (${counts.rejected})` },
            { k: 'all', label: 'Todas' },
          ].map(t => (
            <button key={t.k} onClick={() => setFilter(t.k)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${filter === t.k ? 'bg-cyan/20 text-cyan' : 'text-slate-500 hover:text-slate-300'}`}>
              {t.label}
            </button>
          ))}
        </div>
        {counts.pending > 0 && (
          <button onClick={approveAll} disabled={bulkLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-lg disabled:opacity-50 transition-colors">
            {bulkLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
            Aprovar baixo risco
          </button>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface-2 bg-surface-2/50">
              {['Entidade / Termo', 'Risco', 'Valor Atual → Novo', 'Justificativa', 'Status', 'Ação'].map(h => (
                <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={6} className="px-5 py-10 text-center text-sm text-slate-500">Nenhuma decisão neste filtro</td></tr>
            ) : filtered.map(d => (
              <DecisionRow key={d.id} d={d} onUpdate={updateDecision} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}