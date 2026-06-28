import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { xanoRequest, toArray } from '@/lib/useXano';
import { Brain, CheckCircle, XCircle, Play, Square, Loader2, TrendingUp, TrendingDown, Zap, ChevronDown, ChevronUp, RefreshCw, AlertCircle } from 'lucide-react';
import StatusBadge from '@/components/ui/StatusBadge';
import EmptyState from '@/components/ui/EmptyState';

const DECISION_LABELS = {
  bid_adjust: 'Ajuste de Bid',
  budget_change: 'Alteração de Orçamento',
  pause_campaign: 'Pausar Campanha',
  enable_campaign: 'Ativar Campanha',
  add_keyword: 'Adicionar Keyword',
  negate_keyword: 'Negativar Keyword',
};

export default function LearnerEngine() {
  const [decisions, setDecisions] = useState([]);
  const [history, setHistory] = useState([]);
  const [learningStatus, setLearningStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [learningAction, setLearningAction] = useState(null);
  const [actionStates, setActionStates] = useState({});
  const [expanded, setExpanded] = useState({});
  const [tab, setTab] = useState('pending');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkApproving, setBulkApproving] = useState(false);
  const [error, setError] = useState(null);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [xDecs, xStatus, localHistory] = await Promise.allSettled([
        xanoRequest('GET', '/ads-agent/decisions'),
        xanoRequest('GET', '/learning/status'),
        base44.entities.Decision.list('-created_date', 30),
      ]);
      if (xDecs.status === 'fulfilled') setDecisions(toArray(xDecs.value, 'decisions'));
      if (xStatus.status === 'fulfilled') setLearningStatus(xStatus.value);
      if (localHistory.status === 'fulfilled') setHistory(localHistory.value.filter(d => d.status !== 'pending'));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const generateRecommendations = async () => {
    setGenerating(true);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    try {
      await xanoRequest('POST', '/recommendations/generate', { since_date: since });
      await loadData();
    } catch (err) {
      alert(`Erro: ${err.message}`);
    } finally {
      setGenerating(false);
    }
  };

  const toggleLearning = async () => {
    const isActive = learningStatus?.active || learningStatus?.status === 'active';
    setLearningAction('loading');
    try {
      await xanoRequest('POST', isActive ? '/learning/stop' : '/learning/start');
      const updated = await xanoRequest('GET', '/learning/status');
      setLearningStatus(updated);
    } catch (err) {
      alert(`Erro: ${err.message}`);
    } finally {
      setLearningAction(null);
    }
  };

  const handleDecision = async (decisionId, action) => {
    setActionStates(prev => ({ ...prev, [decisionId]: 'loading' }));
    try {
      if (action === 'approve') {
        await xanoRequest('POST', '/decisions/approve', { decision_id: decisionId });
      } else {
        await xanoRequest('POST', '/decisions/reject', { decision_id: decisionId });
      }
      setActionStates(prev => ({ ...prev, [decisionId]: action === 'approve' ? 'approved' : 'rejected' }));
      setTimeout(() => {
        setDecisions(prev => prev.filter(d => (d.id || d.decision_id) !== decisionId));
        setActionStates(prev => { const n = { ...prev }; delete n[decisionId]; return n; });
      }, 600);
    } catch (err) {
      setActionStates(prev => ({ ...prev, [decisionId]: 'error' }));
      setTimeout(() => setActionStates(prev => { const n = { ...prev }; delete n[decisionId]; return n; }), 3000);
    }
  };

  const bulkApprove = async () => {
    if (selectedIds.size === 0) return;
    setBulkApproving(true);
    for (const id of selectedIds) await handleDecision(id, 'approve');
    setSelectedIds(new Set());
    setBulkApproving(false);
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const isLearningActive = learningStatus?.active || learningStatus?.status === 'active';

  const tabs = [
    { id: 'pending', label: `Pendentes (${decisions.length})` },
    { id: 'history', label: `Histórico (${history.length})` },
    { id: 'learning', label: 'Learning' },
  ];

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <Brain className="w-5 h-5 text-cyan" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Learner Engine</h1>
            <p className="text-xs text-slate-400">{decisions.length} recomendações pendentes · via Xano</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {selectedIds.size > 0 && (
            <button onClick={bulkApprove} disabled={bulkApproving}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded-lg transition-colors">
              {bulkApproving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
              Aprovar {selectedIds.size}
            </button>
          )}
          <button onClick={generateRecommendations} disabled={generating}
            className="flex items-center gap-2 px-4 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60">
            {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            {generating ? 'Gerando...' : 'Gerar Recomendações'}
          </button>
          <button onClick={loadData} className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      <div className="flex border-b border-surface-2 overflow-x-auto">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${tab === t.id ? 'border-cyan text-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-7 h-7 text-cyan animate-spin" /></div>
      ) : tab === 'pending' ? (
        decisions.length === 0 ? (
          <EmptyState icon={Brain} title="Sem recomendações pendentes"
            description="Clique em 'Gerar Recomendações' para que o Xano analise e gere sugestões."
            action={{ label: 'Gerar Recomendações', onClick: generateRecommendations }} />
        ) : (
          <div className="space-y-3">
            {decisions.map(dec => {
              const decId = dec.id || dec.decision_id;
              const state = actionStates[decId];
              const currentVal = dec.current_value ?? dec.current_bid ?? dec.current_budget;
              const proposedVal = dec.recommended_value ?? dec.proposed_value ?? dec.recommended_bid;
              const changePct = dec.change_percent ?? dec.change_pct ?? (currentVal && proposedVal ? ((proposedVal - currentVal) / currentVal) * 100 : 0);
              return (
                <div key={decId} className={`bg-surface-1 border rounded-xl overflow-hidden transition-all duration-300 ${state === 'approved' || state === 'rejected' ? 'opacity-50' : 'border-surface-2'}`}>
                  <div className="p-5">
                    <div className="flex items-start gap-4">
                      <input type="checkbox" checked={selectedIds.has(decId)} onChange={() => toggleSelect(decId)} className="mt-1 w-4 h-4 accent-cyan" />
                      <div className="w-9 h-9 rounded-lg bg-cyan/15 flex items-center justify-center flex-shrink-0">
                        <Zap className="w-4 h-4 text-cyan" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="text-sm font-semibold text-white">
                            {DECISION_LABELS[dec.decision_type || dec.type] || dec.decision_type || dec.type || 'Recomendação'}
                          </span>
                          {dec.priority && <StatusBadge status={dec.priority} size="xs" />}
                          {dec.confidence != null && <span className="text-xs text-slate-500">{(Number(dec.confidence) * 100).toFixed(0)}% confiança</span>}
                          {dec.risk && <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${dec.risk === 'high' ? 'bg-red-400/10 text-red-400' : dec.risk === 'medium' ? 'bg-amber-400/10 text-amber-400' : 'bg-emerald-400/10 text-emerald-400'}`}>Risco: {dec.risk}</span>}
                        </div>
                        <p className="text-xs text-slate-400 mb-2">{dec.entity_name || dec.keyword || dec.campaign_name || dec.context}</p>
                        {currentVal != null && proposedVal != null && (
                          <div className="flex items-center gap-3 mb-2">
                            <span className="text-sm font-mono text-slate-400">R${Number(currentVal).toFixed(2)}</span>
                            <span className="text-slate-600">→</span>
                            <span className="text-sm font-mono font-bold text-white">R${Number(proposedVal).toFixed(2)}</span>
                            <span className={`text-xs font-semibold flex items-center gap-1 ${changePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {changePct >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                              {changePct >= 0 ? '+' : ''}{Number(changePct).toFixed(1)}%
                            </span>
                          </div>
                        )}
                        <button onClick={() => setExpanded(p => ({ ...p, [decId]: !p[decId] }))} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300">
                          {expanded[decId] ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                          {expanded[decId] ? 'Ocultar' : 'Ver'} motivo
                        </button>
                        {expanded[decId] && (
                          <p className="mt-2 text-xs text-slate-400 bg-surface-2 rounded-lg p-3 leading-relaxed">
                            {dec.rationale || dec.reason || dec.explanation || '—'}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button onClick={() => handleDecision(decId, 'reject')} disabled={!!state}
                          className="flex items-center gap-1.5 px-3 py-2 bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 text-xs font-semibold rounded-lg disabled:opacity-50">
                          <XCircle className="w-3.5 h-3.5" /> Rejeitar
                        </button>
                        <button onClick={() => handleDecision(decId, 'approve')} disabled={!!state}
                          className="flex items-center gap-1.5 px-3 py-2 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 text-xs font-semibold rounded-lg disabled:opacity-50">
                          {state === 'loading' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle className="w-3.5 h-3.5" />}
                          {state === 'loading' ? 'Aprovando...' : 'Aprovar'}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : tab === 'learning' ? (
        <div className="space-y-4">
          <div className="bg-surface-1 border border-surface-2 rounded-xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-semibold text-white">Status do Learning Engine</h2>
              <button onClick={toggleLearning} disabled={learningAction === 'loading'}
                className={`flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg transition-colors ${isLearningActive ? 'bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20' : 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20'}`}>
                {learningAction === 'loading' ? <Loader2 className="w-4 h-4 animate-spin" /> : isLearningActive ? <Square className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                {learningAction === 'loading' ? 'Aguarde...' : isLearningActive ? 'Parar' : 'Iniciar'}
              </button>
            </div>
            {learningStatus ? (
              <div className="grid grid-cols-2 gap-4">
                {[
                  { label: 'Estado', value: isLearningActive ? 'Ativo' : 'Inativo', color: isLearningActive ? 'text-emerald-400' : 'text-slate-400' },
                  { label: 'Observações', value: learningStatus.observations_count ?? learningStatus.total_observations ?? '—' },
                  { label: 'Último snapshot', value: learningStatus.last_snapshot ? new Date(learningStatus.last_snapshot).toLocaleString('pt-BR') : '—' },
                  { label: 'Última análise', value: learningStatus.last_analysis ? new Date(learningStatus.last_analysis).toLocaleString('pt-BR') : '—' },
                ].map(({ label, value, color }) => (
                  <div key={label} className="bg-surface-2 rounded-lg p-3">
                    <p className="text-xs text-slate-500 mb-1">{label}</p>
                    <p className={`text-sm font-semibold ${color || 'text-white'}`}>{String(value)}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-slate-500">Sem dados de status do learning.</p>
            )}
          </div>
        </div>
      ) : (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-2">
                {['Tipo', 'Entidade', 'Valor', 'Alteração', 'Estado', 'Data'].map(h => (
                  <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-slate-500 uppercase">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-sm text-slate-500">Sem histórico local</td></tr>
              ) : history.map(d => (
                <tr key={d.id} className="border-b border-surface-2/50 hover:bg-surface-2">
                  <td className="px-5 py-3 text-xs text-slate-300">{DECISION_LABELS[d.decision_type] || d.decision_type}</td>
                  <td className="px-5 py-3 text-xs text-slate-400 truncate max-w-xs">{d.entity_name}</td>
                  <td className="px-5 py-3 text-xs text-slate-300">{d.current_value != null ? `R$${d.current_value?.toFixed(2)} → R$${d.proposed_value?.toFixed(2)}` : '—'}</td>
                  <td className="px-5 py-3">{d.change_pct != null && <span className={`text-xs font-semibold ${d.change_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{d.change_pct >= 0 ? '+' : ''}{d.change_pct?.toFixed(1)}%</span>}</td>
                  <td className="px-5 py-3"><StatusBadge status={d.status} size="xs" /></td>
                  <td className="px-5 py-3 text-xs text-slate-500">{new Date(d.created_date).toLocaleDateString('pt-BR')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}