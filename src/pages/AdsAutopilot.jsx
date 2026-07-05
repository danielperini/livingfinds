import React, { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { loadAllCampaigns, getAutopilotEligible } from '@/lib/campaignUtils';
import Recommendations from '@/pages/Recommendations';
import DaypartingDashboard from '@/pages/DaypartingDashboard';
import AutopilotKPIBar from '@/components/autopilot/AutopilotKPIBar';
import AutopilotConfigPanel from '@/components/autopilot/AutopilotConfigPanel';
import AutopilotDecisionsTable from '@/components/autopilot/AutopilotDecisionsTable';
import AutopilotAlertsPanel from '@/components/autopilot/AutopilotAlertsPanel';
import BiddingRulesPanel from '@/components/learner/BiddingRulesPanel';
import MLLearningPanel from '@/components/learner/MLLearningPanel';
import StatusBadge from '@/components/ui/StatusBadge';
import {
  Bot, Play, RefreshCw, Loader2, Settings, AlertTriangle, History,
  Zap, TrendingDown, Search, Unlock, Brain, CheckCircle, XCircle,
  Filter, ChevronDown, ChevronUp, TrendingUp, Clock, Rocket, Shield,
  Square, PauseCircle, Package,
} from 'lucide-react';

const TABS = [
  { id: 'decisions', label: 'Decisões IA', icon: Brain },
  { id: 'converted', label: 'Termos Convertidos', icon: Search },
  { id: 'alerts', label: 'Alertas', icon: AlertTriangle },
  { id: 'negatives', label: 'Negativas', icon: TrendingDown },
  { id: 'history', label: 'Histórico de Bids', icon: History },
  { id: 'recommendations', label: '🎯 Recomendações', icon: null },
  { id: 'dayparting', label: '🕐 Dayparting', icon: null },
  { id: 'ml_learning', label: '🧠 Motor ML', icon: null },
  { id: 'rules', label: 'Regras Automáticas', icon: Settings },
  { id: 'config', label: 'Configuração', icon: Settings },
];

const CLASSIFICATION_COLORS = {
  FIRST_SALE: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
  WINNER: 'text-cyan bg-cyan/10 border-cyan/20',
  HIGH_ACOS: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
  WASTING: 'text-red-400 bg-red-400/10 border-red-400/20',
  PROMOTED_EXACT: 'text-purple-400 bg-purple-400/10 border-purple-400/20',
  NEGATED: 'text-slate-400 bg-slate-400/10 border-slate-400/20',
  LEARNING: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
  INSUFFICIENT_DATA: 'text-slate-500 bg-slate-500/10 border-slate-500/20',
};

const DECISION_LABELS = {
  bid_adjust: 'Ajuste de Bid', budget_change: 'Orçamento',
  pause_campaign: 'Pausar', enable_campaign: 'Ativar',
  add_keyword: 'Add Keyword', negate_keyword: 'Negativar KW',
  pause_ad_group: 'Pausar AG', enable_ad_group: 'Ativar AG',
  bid_change: 'Ajuste de Bid', harvest_search_term: 'Colheita de Termo',
  negative_keyword: 'Negativar KW', create_campaign: 'Criar Campanha',
  pause: 'Pausar', enable: 'Ativar',
};

const TYPE_ICONS = {
  bid_adjust: '💰', budget_change: '📊', pause_campaign: '⏸️',
  enable_campaign: '▶️', add_keyword: '🔑', negate_keyword: '🚫',
  bid_change: '💰', harvest_search_term: '🌾', negative_keyword: '🚫',
  create_campaign: '🚀', pause: '⏸️', enable: '▶️',
};

const PRIORITY_COLORS = {
  high: 'text-red-400 bg-red-400/10 border-red-400/20',
  medium: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
  low: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
};

function DecisionRow({ dec, actionState, onApprove, onReject, selected, onSelect, currencySymbol, productMap }) {
  const [showRationale, setShowRationale] = useState(false);
  const [editBid, setEditBid] = useState(false);
  const [bidValue, setBidValue] = useState(dec.proposed_value ?? '');

  const isLoading = actionState === 'loading';
  const isDone = actionState === 'approved' || actionState === 'rejected';
  if (isDone) return null;

  const changePct = dec.change_pct ??
    (dec.current_value && dec.proposed_value
      ? ((dec.proposed_value - dec.current_value) / dec.current_value) * 100
      : null);
  const isPositive = (changePct ?? 0) >= 0;

  return (
    <>
      <tr className={`border-b border-surface-2/40 transition-colors ${selected ? 'bg-cyan/5' : 'hover:bg-surface-2/60'}`}>
        <td className="pl-4 py-3 w-8"><input type="checkbox" checked={selected} onChange={onSelect} className="w-3.5 h-3.5 accent-cyan rounded" /></td>
        <td className="px-3 py-3 min-w-[180px]"><div className="flex items-center gap-2"><span className="text-base leading-none">{TYPE_ICONS[dec.decision_type] || '🤖'}</span><div className="min-w-0"><p className="text-xs font-semibold text-white truncate max-w-[160px]">{dec.entity_name || dec.entity_id || '—'}</p><p className="text-xs text-slate-500 mt-0.5">{DECISION_LABELS[dec.decision_type] || dec.decision_type}</p></div></div></td>
        <td className="px-3 py-3 min-w-[160px] max-w-[200px]">{(() => { const asin = dec.asin; const prod = asin && productMap ? productMap.get(asin) : null; if (!prod && !asin) return <span className="text-xs text-slate-600">—</span>; return (<div className="flex items-center gap-2"><div className="flex-shrink-0">{prod?.product_image_url ? <img src={prod.product_image_url} alt="" className="w-7 h-7 rounded object-cover bg-surface-3" /> : <div className="w-7 h-7 rounded bg-surface-3 flex items-center justify-center"><Package className="w-3 h-3 text-slate-600" /></div>}</div><div className="min-w-0"><p className="text-[10px] font-mono text-cyan">{asin}</p><p className="text-[10px] text-slate-400 truncate max-w-[130px] leading-tight">{prod?.product_name || prod?.display_name || ''}</p></div></div>); })()}</td>
        <td className="px-3 py-3 w-24">{dec.priority && <span className={`text-xs px-2 py-0.5 rounded-full border font-medium capitalize ${PRIORITY_COLORS[dec.priority] || ''}`}>{dec.priority === 'high' ? 'Alta' : dec.priority === 'medium' ? 'Média' : 'Baixa'}</span>}</td>
        <td className="px-3 py-3 w-52">{dec.current_value != null && dec.proposed_value != null ? <div className="flex items-center gap-2"><span className="text-xs font-mono text-slate-400">{currencySymbol}{Number(dec.current_value).toFixed(2)}</span><span className={`text-xs font-bold flex items-center gap-0.5 ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>{isPositive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}{changePct != null ? `${isPositive ? '+' : ''}${changePct.toFixed(1)}%` : '→'}</span>{editBid ? <div className="flex items-center gap-1"><input type="number" value={bidValue} onChange={e => setBidValue(e.target.value)} step={0.01} min={0.02} className="w-16 px-1.5 py-0.5 bg-surface-3 border border-cyan/40 rounded text-xs font-mono text-white focus:outline-none" autoFocus onBlur={() => !bidValue && setEditBid(false)} /><button onClick={() => setEditBid(false)} className="text-slate-500 hover:text-slate-300"><XCircle className="w-3 h-3" /></button></div> : <button onClick={() => setEditBid(true)} className="text-xs font-mono text-white bg-surface-2 hover:bg-surface-3 border border-surface-3 px-2 py-0.5 rounded transition-colors">{currencySymbol}{Number(bidValue || dec.proposed_value).toFixed(2)}</button>}</div> : <span className="text-xs text-slate-600">—</span>}</td>
        <td className="px-3 py-3 w-24">{dec.confidence != null && <div className="flex items-center gap-1.5"><div className="w-14 h-1.5 bg-surface-3 rounded-full overflow-hidden"><div className="h-full bg-cyan rounded-full" style={{ width: `${Math.min(dec.confidence * 100, 100)}%` }} /></div><span className="text-xs text-slate-500">{(dec.confidence * 100).toFixed(0)}%</span></div>}</td>
        <td className="px-3 py-3 w-32"><button onClick={() => setShowRationale(v => !v)} className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 transition-colors">{showRationale ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}Análise IA</button></td>
        <td className="px-3 py-3 pr-5 w-36"><div className="flex items-center gap-1.5"><button onClick={() => onApprove(editBid && bidValue ? Number(bidValue) : undefined)} disabled={isLoading} className="flex items-center gap-1 px-3 py-1.5 bg-emerald-500 hover:bg-emerald-400 text-white text-xs font-bold rounded-lg disabled:opacity-50 transition-colors whitespace-nowrap">{isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}Aprovar</button><button onClick={onReject} disabled={isLoading} className="flex items-center gap-1 px-2.5 py-1.5 bg-surface-2 hover:bg-red-500/20 border border-surface-3 hover:border-red-500/30 text-slate-400 hover:text-red-400 text-xs font-bold rounded-lg disabled:opacity-50 transition-colors"><XCircle className="w-3 h-3" /></button></div></td>
      </tr>
      {showRationale && <tr className="border-b border-surface-2/40 bg-surface-2/30"><td colSpan={7} className="px-10 py-3"><p className="text-xs text-slate-400 leading-relaxed italic">💡 {dec.rationale || 'Sem análise disponível.'}</p></td></tr>}
    </>
  );
}

function HistoryRow({ d, currencySymbol }) {
  const changePct = d.change_pct;
  return (
    <tr className="border-b border-surface-2/40 hover:bg-surface-2/60 transition-colors">
      <td className="px-4 py-3"><div className="flex items-center gap-2"><span>{TYPE_ICONS[d.decision_type] || '🤖'}</span><span className="text-xs text-slate-300">{DECISION_LABELS[d.decision_type] || d.decision_type}</span></div></td>
      <td className="px-4 py-3 text-xs text-slate-400 max-w-[180px] truncate">{d.entity_name || d.entity_id || '—'}</td>
      <td className="px-4 py-3 text-xs font-mono text-slate-300 whitespace-nowrap">{d.current_value != null ? `${currencySymbol}${d.current_value.toFixed(2)} → ${currencySymbol}${d.proposed_value.toFixed(2)}` : '—'}</td>
      <td className="px-4 py-3">{changePct != null && <span className={`text-xs font-semibold flex items-center gap-1 ${changePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{changePct >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}{changePct >= 0 ? '+' : ''}{changePct.toFixed(1)}%</span>}</td>
      <td className="px-4 py-3"><StatusBadge status={d.status} size="xs" /></td>
      <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">{d.created_date ? new Date(d.created_date).toLocaleDateString('pt-BR') : '—'}</td>
    </tr>
  );
}

export default function AdsAutopilot() {
  const [account, setAccount] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [decHistory, setDecHistory] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [negatives, setNegatives] = useState([]);
  const [bidHistory, setBidHistory] = useState([]);
  const [runs, setRuns] = useState([]);
  const [config, setConfig] = useState(null);
  const [searchTerms, setSearchTerms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState('');
  const [tab, setTab] = useState('decisions');
  const [error, setError] = useState(null);
  const [showExecuteConfirm, setShowExecuteConfirm] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [showFullAuto, setShowFullAuto] = useState(false);
  const [fullAutoRunning, setFullAutoRunning] = useState(false);
  const [fullAutoSteps, setFullAutoSteps] = useState([]);
  const [stTermFilter, setStTermFilter] = useState('all');
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [stoppingAuto, setStoppingAuto] = useState(false);
  const [actionStates, setActionStates] = useState({});
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [filterType, setFilterType] = useState('all');
  const [products, setProducts] = useState([]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await base44.auth.me();
      let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      if (!accounts.length) accounts = await base44.entities.AmazonAccount.filter({ status: 'connected' });
      if (!accounts.length) accounts = await base44.entities.AmazonAccount.list();
      const acc = accounts[0] || null;
      setAccount(acc);
      if (!acc) { setLoading(false); return; }
      const aid = acc.id;

      const [cams, allDecs, als, negs, hist, rs, cfgs, sts, prods] = await Promise.all([
        loadAllCampaigns(aid),
        base44.entities.OptimizationDecision.filter({ amazon_account_id: aid }, '-created_at', 300),
        base44.entities.AutopilotAlert.filter({ amazon_account_id: aid, is_read: false }, '-created_date', 50),
        base44.entities.NegativeKeywordSuggestion.filter({ amazon_account_id: aid, status: 'pending' }, '-spend', 100),
        base44.entities.BidHistory.filter({ amazon_account_id: aid }, '-created_date', 50),
        base44.entities.AutopilotRun.filter({ amazon_account_id: aid }, '-started_at', 10),
        base44.entities.AutopilotConfig.filter({ amazon_account_id: aid }),
        base44.entities.SearchTerm.filter({ amazon_account_id: aid }, '-orders_14d', 500),
        base44.entities.Product.filter({ amazon_account_id: aid }, null, 500),
      ]);

      setCampaigns(getAutopilotEligible(cams));
      setProducts(prods);
      setAlerts(als);
      setNegatives(negs);
      setBidHistory(hist);
      setRuns(rs);
      setConfig(cfgs[0] || null);
      setSearchTerms(sts);

      const campNameMap = new Map(cams.map(c => [c.campaign_id, c.name || c.campaign_name]));
      const normalize = d => ({
        ...d,
        entity_name: d.keyword_text || (d.campaign_id && campNameMap.get(d.campaign_id)) || d.campaign_name || d.entity_name || (d.entity_id && String(d.entity_id).length > 10 ? `ID …${String(d.entity_id).slice(-6)}` : d.entity_id) || '—',
        current_value: d.value_before ?? d.current_value,
        proposed_value: d.value_after ?? d.proposed_value,
        decision_type: d.action || d.decision_type,
        confidence: d.confidence != null ? (d.confidence > 1 ? d.confidence / 100 : d.confidence) : null,
        priority: (d.risk === 'high' || d.risk === 'very_high') ? 'high' : d.risk === 'medium' ? 'medium' : 'low',
      });

      setDecisions(allDecs.filter(d => d.status === 'pending').map(normalize));
      setDecHistory(allDecs.filter(d => d.status !== 'pending').map(normalize));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const runAnalysis = async (autoExecute = false) => {
    if (!account) return;
    setRunning(true);
    setRunMsg(autoExecute ? '⚡ Analisando e executando decisões automáticas...' : 'Analisando campanhas, keywords e search terms...');
    try {
      const res = await base44.functions.invoke('runDailyAdsOptimization', { amazon_account_id: account.id, trigger: 'manual' });
      const d = res.data;
      if (d?.rate_limited) {
        setRunMsg('Programado para a próxima janela Amazon. As decisões geradas foram preservadas.');
        await loadData();
      } else if (d?.ok) {
        const b = d.breakdown || {};
        setRunMsg(`✓ ${d.decisions_created || 0} decisões geradas · ${d.decisions_executed || 0} executadas automaticamente${(d.decisions_exec_failed || 0) > 0 ? ` · ${d.decisions_exec_failed} falhas` : ''} · ${b.harvest || 0} termos colhidos · ${b.bid_decrease || 0} bids ↓ · ${b.bid_increase || 0} bids ↑`);
        await loadData();
      } else if (d?.skipped) setRunMsg(`⚠ ${d.reason}`);
      else setRunMsg(`❌ ${d?.error || 'Erro desconhecido'}`);
    } catch (e) {
      setRunMsg(`❌ ${e.message}`);
    } finally {
      setRunning(false);
      setTimeout(() => setRunMsg(''), 15000);
    }
  };

  const executeApproved = async () => {
    const approvedIds = decisions.filter(d => d.status === 'approved').map(d => d.id);
    if (!approvedIds.length) return;
    setExecuting(true);
    await base44.functions.invoke('executeAutopilotDecision', { decision_ids: approvedIds });
    setShowExecuteConfirm(false);
    await loadData();
    setExecuting(false);
  };

  const handleDecision = async (decisionId, action, proposedValue) => {
    setActionStates(prev => ({ ...prev, [decisionId]: 'loading' }));
    try {
      try { await base44.entities.OptimizationDecision.update(decisionId, { status: action === 'approve' ? 'approved' : 'rejected' }); }
      catch { await base44.functions.invoke('approveDecision', { decision_id: decisionId, action, proposed_value: proposedValue }); }
      setActionStates(prev => ({ ...prev, [decisionId]: action }));
      setTimeout(() => { setDecisions(prev => prev.filter(d => d.id !== decisionId)); setActionStates(prev => { const n = { ...prev }; delete n[decisionId]; return n; }); }, 350);
    } catch {
      setActionStates(prev => { const n = { ...prev }; delete n[decisionId]; return n; });
    }
  };

  const bulkAction = async (action, ids = null) => {
    const targetIds = ids || selectedIds;
    if (!targetIds.size) return;
    setBulkLoading(true);
    for (const id of targetIds) await handleDecision(id, action);
    setSelectedIds(new Set());
    setBulkLoading(false);
  };

  const bulkAll = async (action) => {
    const allIds = new Set(filteredDecisions.map(d => d.id));
    setSelectedIds(allIds);
    await bulkAction(action, allIds);
  };

  const toggleSelect = (id) => setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const dismissAlert = async (id) => { await base44.entities.AutopilotAlert.update(id, { is_read: true }); setAlerts(prev => prev.filter(a => a.id !== id)); };
  const approveNegative = async (id) => { await base44.entities.NegativeKeywordSuggestion.update(id, { status: 'approved' }); setNegatives(prev => prev.filter(n => n.id !== id)); };
  const rejectNegative = async (id) => { await base44.entities.NegativeKeywordSuggestion.update(id, { status: 'rejected' }); setNegatives(prev => prev.filter(n => n.id !== id)); };

  const runFullAutomation = async () => {};
  const filteredDecisions = decisions.filter(d => filterType === 'all' || d.decision_type === filterType);
  const currencySymbol = 'R$ ';

  if (loading) return <div className="p-6 text-slate-400">Carregando Autopilot...</div>;
  if (!account) return <div className="p-6"><h2 className="text-lg font-bold text-white">Nenhuma conta Amazon conectada.</h2><p className="text-sm text-slate-400 mt-2">Configure sua conta Amazon nas Configurações antes de usar o Autopilot.</p></div>;

  return <div className="p-6 space-y-6">
    <div className="flex items-center justify-between"><div><h1 className="text-xl font-bold text-white">Ads Autopilot & IA</h1><p className="text-sm text-slate-400">{runs[0]?.started_at ? `Última análise: ${new Date(runs[0].started_at).toLocaleString('pt-BR')}` : 'Nenhuma análise executada'}</p></div></div>
    {runMsg && <div className="rounded-lg border border-cyan/20 bg-cyan/5 p-3 text-sm text-cyan">{runMsg}</div>}
    <AutopilotKPIBar campaigns={campaigns} decisions={decisions} alerts={alerts} bidHistory={bidHistory} />
    <div className="flex flex-wrap gap-2">{TABS.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => setTab(id)} className={`px-3 py-2 rounded-lg text-xs font-semibold border ${tab === id ? 'bg-cyan/10 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-400 border-surface-3'}`}>{Icon && <Icon className="inline w-3 h-3 mr-1" />}{label}</button>)}</div>
    {tab === 'decisions' && (() => { const productMap = new Map(products.map(p => [p.asin, p])); return (<div className="rounded-xl border border-surface-2 overflow-hidden"><table className="w-full"><thead><tr className="border-b border-surface-2 bg-surface-1"><th className="pl-4 py-2 w-8"></th><th className="px-3 py-2 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Decisão</th><th className="px-3 py-2 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider min-w-[160px]">Produto</th><th className="px-3 py-2 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider w-24">Prioridade</th><th className="px-3 py-2 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider w-52">Valor</th><th className="px-3 py-2 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider w-24">Confiança</th><th className="px-3 py-2 w-32"></th><th className="px-3 py-2 w-36"></th></tr></thead><tbody>{filteredDecisions.map(dec => <DecisionRow key={dec.id} dec={dec} actionState={actionStates[dec.id]} onApprove={(v) => handleDecision(dec.id, 'approve', v)} onReject={() => handleDecision(dec.id, 'reject')} selected={selectedIds.has(dec.id)} onSelect={() => toggleSelect(dec.id)} currencySymbol={currencySymbol} productMap={productMap} />)}</tbody></table>{!filteredDecisions.length && <div className="p-6 text-sm text-slate-500">Nenhuma decisão pendente.</div>}</div>); })()}
    {tab === 'history' && <div className="rounded-xl border border-surface-2 overflow-hidden"><table className="w-full"><tbody>{decHistory.map(d => <HistoryRow key={d.id} d={d} currencySymbol={currencySymbol} />)}</tbody></table>{!decHistory.length && <div className="p-6 text-sm text-slate-500">Nenhum histórico disponível.</div>}</div>}
    {tab === 'recommendations' && <Recommendations />}
    {tab === 'dayparting' && <DaypartingDashboard />}
    {tab === 'ml_learning' && <MLLearningPanel amazonAccountId={account.id} />}
    {tab === 'rules' && <BiddingRulesPanel amazonAccountId={account.id} />}
    {tab === 'config' && <AutopilotConfigPanel account={account} config={config} onSaved={loadData} />}
    {tab === 'alerts' && <AutopilotAlertsPanel alerts={alerts} onDismiss={dismissAlert} />}
    {tab === 'negatives' && <div className="text-sm text-slate-400">{negatives.length} sugestão(ões) negativa(s).</div>}
    {tab === 'converted' && <div className="text-sm text-slate-400">{searchTerms.length} termo(s) de pesquisa carregado(s).</div>}
  </div>;
}