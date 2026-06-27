import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { xanoAdsAgent, isXanoAuthenticated } from '@/lib/xanoClient';
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
  pause_ad_group: 'Pausar Ad Group',
  enable_ad_group: 'Ativar Ad Group',
};

export default function LearnerEngine() {
  const [decisions, setDecisions] = useState([]);
  const [xanoDecisions, setXanoDecisions] = useState([]);
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
      const [pending, done, evts] = await Promise.all([
        base44.entities.Decision.filter({ status: 'pending' }),
        base44.entities.Decision.list('-created_date', 30),
        base44.entities.LearningEvent.list('-created_date', 20),
      ]);
      setDecisions(pending);
      setHistory(done.filter(d => d.status !== 'pending'));
      setEvents(evts);

      // Load Xano agent data if connected
      if (xanoConnected) {
        const [xDecs, xMem, xRules] = await Promise.allSettled([
          xanoAdsAgent.getDecisions(),
          xanoAdsAgent.getMemory(),
          xanoAdsAgent.getRules(),
        ]);
        if (xDecs.status === 'fulfilled') {
          const list = Array.isArray(xDecs.value) ? xDecs.value : (xDecs.value?.decisions || []);
          setXanoDecisions(list);
        }
        if (xMem.status === 'fulfilled') {
          const list = Array.isArray(xMem.value) ? xMem.value : (xMem.value?.memory || []);
          setXanoMemory(list);
        }
        if (xRules.status === 'fulfilled') {
          const list = Array.isArray(xRules.value) ? xRules.value : (xRules.value?.rules || []);
          setXanoRules(list);
        }
      }
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
      if (action === 'approve') {
        const res = await base44.functions.invoke('approveDecision', { decision_id: decisionId });
        if (!res.data?.ok) throw new Error(res.data?.message || 'Erro ao aprovar');
      } else {
        await base44.entities.Decision.update(decisionId, { status: 'rejected', reviewed_at: new Date().toISOString() });
      }
      setActionStates(prev => ({ ...prev, [decisionId]: action === 'approve' ? 'approved' : 'rejected' }));
      setTimeout(async () => {
        setDecisions(prev => prev.filter(d => d.id !== decisionId));
        await loadData();
      }, 600);
    } catch (err) {
      setActionStates(prev => ({ ...prev, [decisionId]: 'error' }));
      setTimeout(() => setActionStates(prev => ({ ...prev, [decisionId]: null })), 3000);
    }
  };

  const bulkApprove = async () => {
    if (selectedIds.size === 0) return;
    setBulkApproving(true);
    try {
      for (const id of selectedIds) {
        await base44.functions.invoke('approveDecision', { decision_id: id });
      }
      setSelectedIds(new Set());
      await loadData();
    } catch (err) {
      alert(`Erro: ${err.message}`);
    } finally {
      setBulkApproving(false);
    }
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const allDecisions = [...decisions];
  const tabs = [
    { id: 'pending', label: `Pendentes (${allDecisions.length})` },
    { id: 'history', label: `Histórico (${history.length})` },
    ...(xanoConnected ? [
      { id: 'xano_decisions', label: `Agente Xano (${xanoDecisions.length})` },
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
            <p className="text-xs text-slate-400">{allDecisions.length} recomendações pendentes{xanoConnected ? ` · ${xanoDecisions.length} do agente Xano` : ''}</p>
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
        allDecisions.length === 0 ? (
          <EmptyState icon={Brain} title="Sem recomendações pendentes" description="Executa um ciclo para gerar novas recomendações." action={{ label: 'Executar Ciclo', onClick: runLearner }} />
        ) : (
          <div className="space-y-3">
            {allDecisions.map(dec => {
              const state = actionStates[dec.id];
              return (
                <div key={dec.id} className={`bg-surface-1 border rounded-xl overflow-hidden transition-all duration-300 ${state === 'approved' ? 'animate-slide-vanish' : 'border-surface-2'}`}>
                  <div className="p-5">
                    <div className="flex items-start gap-4">
                      <input type="checkbox" checked={selectedIds.has(dec.id)} onChange={() => toggleSelect(dec.id)} className="mt-1 w-4 h-4 accent-cyan" />
                      <div className="w-9 h-9 rounded-lg bg-cyan/15 flex items-center justify-center flex-shrink-0">
                        <Zap className="w-4 h-4 text-cyan" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <span className="text-sm font-semibold text-white">{DECISION_LABELS[dec.decision_type] || dec.decision_type}</span>
                          <StatusBadge status={dec.priority} size="xs" />
                          {dec.confidence && <span className="text-xs text-slate-500">{(dec.confidence * 100).toFixed(0)}% confiança</span>}
                        </div>
                        <p className="text-xs text-slate-400 mb-2">{dec.entity_name}</p>
                        {dec.current_value != null && dec.proposed_value != null && (
                          <div className="flex items-center gap-3 mb-2">
                            <span className="text-sm font-mono text-slate-400">${dec.current_value?.toFixed(2)}</span>
                            <span className="text-slate-600">→</span>
                            <span className="text-sm font-mono font-bold text-white">${dec.proposed_value?.toFixed(2)}</span>
                            <span className={`text-xs font-semibold flex items-center gap-1 ${(dec.change_pct || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {(dec.change_pct || 0) >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                              {(dec.change_pct || 0) >= 0 ? '+' : ''}{(dec.change_pct || 0).toFixed(1)}%
                            </span>
                          </div>
                        )}
                        <button onClick={() => setExpanded(p => ({ ...p, [dec.id]: !p[dec.id] }))} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300">
                          {expanded[dec.id] ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                          {expanded[dec.id] ? 'Ocultar' : 'Ver'} justificativa
                        </button>
                        {expanded[dec.id] && <p className="mt-2 text-xs text-slate-400 bg-surface-2 rounded-lg p-3 leading-relaxed">{dec.rationale}</p>}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button onClick={() => handleDecision(dec.id, 'reject')} disabled={!!state}
                          className="flex items-center gap-1.5 px-3 py-2 bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 text-xs font-semibold rounded-lg disabled:opacity-50">
                          <XCircle className="w-3.5 h-3.5" /> Rejeitar
                        </button>
                        <button onClick={() => handleDecision(dec.id, 'approve')} disabled={!!state}
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
      ) : tab === 'xano_decisions' ? (
        xanoDecisions.length === 0 ? <EmptyState icon={Brain} title="Sem decisões do agente Xano" description="O agente Xano não tem decisões registadas." /> : (
          <div className="space-y-2">
            {xanoDecisions.map((d, i) => (
              <div key={i} className="bg-surface-1 border border-surface-2 rounded-xl p-4">
                <div className="flex items-center gap-3 mb-2">
                  <Zap className="w-4 h-4 text-cyan" />
                  <span className="text-sm font-semibold text-white">{d.type || d.decision_type || 'Decisão'}</span>
                  {d.status && <StatusBadge status={d.status} size="xs" />}
                </div>
                <p className="text-xs text-slate-400">{d.rationale || d.reason || JSON.stringify(d).slice(0, 200)}</p>
              </div>
            ))}
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
        xanoRules.length === 0 ? <EmptyState icon={Brain} title="Sem regras de bid" description="Nenhuma regra configurada no Xano." /> : (
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
              {history.map(d => (
                <tr key={d.id} className="border-b border-surface-2/50 hover:bg-surface-2">
                  <td className="px-5 py-3 text-xs text-slate-300">{DECISION_LABELS[d.decision_type] || d.decision_type}</td>
                  <td className="px-5 py-3 text-xs text-slate-400 truncate max-w-xs">{d.entity_name}</td>
                  <td className="px-5 py-3 text-xs text-slate-300">{d.current_value != null ? `$${d.current_value?.toFixed(2)} → $${d.proposed_value?.toFixed(2)}` : '—'}</td>
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
          {events.map(ev => (
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
          {events.length === 0 && <EmptyState icon={Brain} title="Sem eventos" description="Sem eventos de aprendizagem registados." />}
        </div>
      )}
    </div>
  );
}