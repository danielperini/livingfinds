import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { xanoDecisions, xanoAdsAgent, isXanoAuthenticated } from '@/lib/xanoClient';
import { Brain, CheckCircle, XCircle, Play, Loader2, TrendingUp, TrendingDown, Zap, ChevronDown, ChevronUp } from 'lucide-react';
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
  const [xanoMemory, setXanoMemory] = useState([]);
  const [xanoRules, setXanoRules] = useState([]);
  const [history, setHistory] = useState([]);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [actionStates, setActionStates] = useState({});
  const [expanded, setExpanded] = useState({});
  const [tab, setTab] = useState('pending');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkApproving, setBulkApproving] = useState(false);
  const xanoConnected = isXanoAuthenticated();

  const loadData = async () => {
    setLoading(true);
    try {
      if (xanoConnected) {
        // Xano é a fonte primária de decisões
        const [xDecs, xMem, xRules] = await Promise.allSettled([
          xanoDecisions.list(),
          xanoAdsAgent.getMemory(),
          xanoAdsAgent.getRules(),
        ]);

        if (xDecs.status === 'fulfilled') {
          const list = Array.isArray(xDecs.value) ? xDecs.value : (xDecs.value?.decisions || []);
          setDecisions(list);
        }
        if (xMem.status === 'fulfilled') {
          setXanoMemory(Array.isArray(xMem.value) ? xMem.value : (xMem.value?.memory || []));
        }
        if (xRules.status === 'fulfilled') {
          setXanoRules(Array.isArray(xRules.value) ? xRules.value : (xRules.value?.rules || []));
        }
      }

      // Base44: histórico local e eventos de aprendizagem
      const [done, evts] = await Promise.all([
        base44.entities.Decision.list('-created_date', 30),
        base44.entities.LearningEvent.list('-created_date', 20),
      ]);
      setHistory(done.filter(d => d.status !== 'pending'));
      setEvents(evts);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, [xanoConnected]);

  const runLearner = async () => {
    const accounts = await base44.entities.AmazonAccount.list();
    if (accounts.length === 0) return alert('Nenhuma conta Amazon configurada.');
    setRunning(true);
    try {
      await base44.functions.invoke('runLearnerCycle', { amazon_account_id: accounts[0].id });
      await loadData();
    } catch (err) {
      alert(`Erro: ${err.message}`);
    } finally {
      setRunning(false);
    }
  };

  const handleDecision = async (decisionId, action) => {
    setActionStates(prev => ({ ...prev, [decisionId]: 'loading' }));
    try {
      if (xanoConnected) {
        // Chamar Xano diretamente
        if (action === 'approve') {
          await xanoDecisions.approve(decisionId);
        } else {
          await xanoDecisions.reject(decisionId);
        }
        // Também actualizar entidade local via backend
        await base44.functions.invoke('approveDecision', { decision_id: decisionId, action }).catch(() => {});
      } else {
        if (action === 'approve') {
          const res = await base44.functions.invoke('approveDecision', { decision_id: decisionId });
          if (!res.data?.ok) throw new Error(res.data?.message || 'Erro ao aprovar');
        } else {
          await base44.entities.Decision.update(decisionId, { status: 'rejected', reviewed_at: new Date().toISOString() });
        }
      }

      setActionStates(prev => ({ ...prev, [decisionId]: action === 'approve' ? 'approved' : 'rejected' }));
      setTimeout(async () => {
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
    try {
      for (const id of selectedIds) {
        await handleDecision(id, 'approve');
      }
      setSelectedIds(new Set());
    } catch (err) {
      alert(`Erro: ${err.message}`);
    } finally {
      setBulkApproving(false);
    }
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const tabs = [
    { id: 'pending', label: `Pendentes (${decisions.length})` },
    { id: 'history', label: `Histórico (${history.length})` },
    ...(xanoConnected ? [
      { id: 'memory', label: `Memória (${xanoMemory.length})` },
      { id: 'rules', label: `Regras (${xanoRules.length})` },
    ] : []),
    { id: 'events', label: `Eventos (${events.length})` },
  ];

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <Brain className="w-5 h-5 text-cyan" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Learner Engine</h1>
            <p className="text-xs text-slate-400">{decisions.length} recomendações pendentes{xanoConnected ? ' · via Xano' : ''}</p>
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
          <button onClick={runLearner} disabled={running}
            className="flex items-center gap-2 px-4 py-2 bg-surface-2 hover:bg-surface-3 border border-surface-3 text-white text-sm font-semibold rounded-lg transition-colors">
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 text-cyan" />}
            {running ? 'Analisando...' : 'Executar Ciclo'}
          </button>
        </div>
      </div>

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
          <EmptyState icon={Brain} title="Sem recomendações pendentes" description="Executa um ciclo ou aguarda o Xano gerar novas recomendações." action={{ label: 'Executar Ciclo', onClick: runLearner }} />
        ) : (
          <div className="space-y-3">
            {decisions.map(dec => {
              const decId = dec.id || dec.decision_id;
              const state = actionStates[decId];
              const currentVal = dec.current_value ?? dec.current_bid ?? dec.current_budget;
              const proposedVal = dec.recommended_value ?? dec.proposed_value ?? dec.recommended_bid;
              const changePct = dec.change_percent ?? dec.change_pct ?? (currentVal && proposedVal ? ((proposedVal - currentVal) / currentVal) * 100 : 0);
              return (
                <div key={decId} className={`bg-surface-1 border rounded-xl overflow-hidden transition-all duration-300 ${state === 'approved' || state === 'rejected' ? 'opacity-50 scale-98' : 'border-surface-2'}`}>
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
                          {dec.confidence && <span className="text-xs text-slate-500">{(dec.confidence * 100).toFixed(0)}% confiança</span>}
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
      ) : tab === 'memory' ? (
        xanoMemory.length === 0 ? <EmptyState icon={Brain} title="Memória vazia" description="O agente não tem dados de memória registados." /> : (
          <div className="space-y-2">
            {xanoMemory.map((m, i) => (
              <div key={i} className="bg-surface-1 border border-surface-2 rounded-xl p-4">
                <p className="text-xs font-semibold text-slate-300 mb-1">{m.fact || m.key || `Registo ${i + 1}`}</p>
                <p className="text-xs text-slate-500">{m.value || m.content || JSON.stringify(m).slice(0, 200)}</p>
              </div>
            ))}
          </div>
        )
      ) : tab === 'rules' ? (
        xanoRules.length === 0 ? <EmptyState icon={Brain} title="Sem regras" description="Nenhuma regra configurada no Xano." /> : (
          <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-surface-2">{['Regra', 'Condição', 'Ação', 'Estado'].map(h => <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-slate-500 uppercase">{h}</th>)}</tr></thead>
              <tbody>
                {xanoRules.map((r, i) => (
                  <tr key={i} className="border-b border-surface-2/50 hover:bg-surface-2">
                    <td className="px-5 py-3 text-slate-300">{r.name || r.rule_name || `Regra ${i + 1}`}</td>
                    <td className="px-5 py-3 text-slate-400 text-xs">{r.condition || r.trigger || '—'}</td>
                    <td className="px-5 py-3 text-slate-400 text-xs">{r.action || '—'}</td>
                    <td className="px-5 py-3">{r.status ? <StatusBadge status={r.status} size="xs" /> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : tab === 'history' ? (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-surface-2">{['Tipo', 'Entidade', 'Valor', 'Alteração', 'Estado', 'Data'].map(h => <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-slate-500 uppercase">{h}</th>)}</tr></thead>
            <tbody>
              {history.length === 0 ? (
                <tr><td colSpan={6} className="px-5 py-8 text-center text-sm text-slate-500">Sem histórico</td></tr>
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
      ) : (
        <div className="space-y-2">
          {events.length === 0
            ? <EmptyState icon={Brain} title="Sem eventos" description="Sem eventos de aprendizagem registados." />
            : events.map(ev => (
              <div key={ev.id} className="bg-surface-1 border border-surface-2 rounded-xl p-4 flex items-start gap-3">
                <div className="w-7 h-7 rounded-lg bg-cyan/10 flex items-center justify-center flex-shrink-0"><Brain className="w-3.5 h-3.5 text-cyan" /></div>
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-semibold text-slate-300">{ev.event_type}</span>
                    <span className="text-xs text-slate-600">{new Date(ev.created_date).toLocaleString('pt-BR')}</span>
                  </div>
                  <p className="text-xs text-slate-400">{ev.observation}</p>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}