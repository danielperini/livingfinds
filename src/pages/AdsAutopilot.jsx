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
import StatusBadge from '@/components/ui/StatusBadge';
import {
  Bot, Play, RefreshCw, Loader2, Settings, AlertTriangle, History,
  Zap, TrendingDown, Search, Unlock, Brain, CheckCircle, XCircle,
  Filter, ChevronDown, ChevronUp, TrendingUp, Clock, Rocket, Shield,
} from 'lucide-react';

// ── Tabs consolidadas ──────────────────────────────────────────────────────────
const TABS = [
  { id: 'decisions',   label: 'Decisões IA',        icon: Brain },
  { id: 'converted',  label: 'Termos Convertidos',  icon: Search },
  { id: 'alerts',     label: 'Alertas',             icon: AlertTriangle },
  { id: 'negatives',  label: 'Negativas',           icon: TrendingDown },
  { id: 'history',    label: 'Histórico de Bids',   icon: History },
  { id: 'recommendations', label: '🎯 Recomendações', icon: null },
  { id: 'dayparting', label: '🕐 Dayparting',        icon: null },
  { id: 'rules',      label: 'Regras Automáticas',  icon: Settings },
  { id: 'config',     label: 'Configuração',        icon: Settings },
];

const CLASSIFICATION_COLORS = {
  FIRST_SALE:        'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
  WINNER:            'text-cyan bg-cyan/10 border-cyan/20',
  HIGH_ACOS:         'text-amber-400 bg-amber-400/10 border-amber-400/20',
  WASTING:           'text-red-400 bg-red-400/10 border-red-400/20',
  PROMOTED_EXACT:    'text-purple-400 bg-purple-400/10 border-purple-400/20',
  NEGATED:           'text-slate-400 bg-slate-400/10 border-slate-400/20',
  LEARNING:          'text-blue-400 bg-blue-400/10 border-blue-400/20',
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

// ── Linha da tabela de decisões (aprovação individual com edição de bid) ────────
function DecisionRow({ dec, actionState, onApprove, onReject, selected, onSelect, currencySymbol }) {
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
        <td className="pl-4 py-3 w-8">
          <input type="checkbox" checked={selected} onChange={onSelect} className="w-3.5 h-3.5 accent-cyan rounded" />
        </td>
        <td className="px-3 py-3 min-w-[180px]">
          <div className="flex items-center gap-2">
            <span className="text-base leading-none">{TYPE_ICONS[dec.decision_type] || '🤖'}</span>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-white truncate max-w-[160px]">{dec.entity_name || dec.entity_id || '—'}</p>
              <p className="text-xs text-slate-500 mt-0.5">{DECISION_LABELS[dec.decision_type] || dec.decision_type}</p>
            </div>
          </div>
        </td>
        <td className="px-3 py-3 w-24">
          {dec.priority && (
            <span className={`text-xs px-2 py-0.5 rounded-full border font-medium capitalize ${PRIORITY_COLORS[dec.priority] || ''}`}>
              {dec.priority === 'high' ? 'Alta' : dec.priority === 'medium' ? 'Média' : 'Baixa'}
            </span>
          )}
        </td>
        <td className="px-3 py-3 w-52">
          {dec.current_value != null && dec.proposed_value != null ? (
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-slate-400">{currencySymbol}{Number(dec.current_value).toFixed(2)}</span>
              <span className={`text-xs font-bold flex items-center gap-0.5 ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
                {isPositive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                {changePct != null ? `${isPositive ? '+' : ''}${changePct.toFixed(1)}%` : '→'}
              </span>
              {editBid ? (
                <div className="flex items-center gap-1">
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
                  {currencySymbol}{Number(bidValue || dec.proposed_value).toFixed(2)}
                </button>
              )}
            </div>
          ) : <span className="text-xs text-slate-600">—</span>}
        </td>
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
        <td className="px-3 py-3 w-32">
          <button onClick={() => setShowRationale(v => !v)}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 transition-colors">
            {showRationale ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            Análise IA
          </button>
        </td>
        <td className="px-3 py-3 pr-5 w-36">
          <div className="flex items-center gap-1.5">
            <button onClick={() => onApprove(editBid && bidValue ? Number(bidValue) : undefined)} disabled={isLoading}
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

// ── Linha do histórico ──────────────────────────────────────────────────────────
function HistoryRow({ d, currencySymbol }) {
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
        {d.current_value != null ? `${currencySymbol}${d.current_value.toFixed(2)} → ${currencySymbol}${d.proposed_value.toFixed(2)}` : '—'}
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
        {d.created_date ? new Date(d.created_date).toLocaleDateString('pt-BR') : '—'}
      </td>
    </tr>
  );
}

// ── Página principal ────────────────────────────────────────────────────────────
export default function AdsAutopilot() {
  const [account, setAccount] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [decisions, setDecisions] = useState([]);       // pending (OptimizationDecision)
  const [decHistory, setDecHistory] = useState([]);      // done (OptimizationDecision)
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

  // Aprovação individual (DecisionRow)
  const [actionStates, setActionStates] = useState({});
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [filterType, setFilterType] = useState('all');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0];
      setAccount(acc);
      if (!acc) { setLoading(false); return; }
      const aid = acc.id;

      const [cams, allDecs, als, negs, hist, rs, cfgs, sts] = await Promise.all([
        loadAllCampaigns(aid),
        base44.entities.OptimizationDecision.filter({ amazon_account_id: aid }, '-created_at', 300),
        base44.entities.AutopilotAlert.filter({ amazon_account_id: aid, is_read: false }, '-created_date', 50),
        base44.entities.NegativeKeywordSuggestion.filter({ amazon_account_id: aid, status: 'pending' }, '-spend', 100),
        base44.entities.BidHistory.filter({ amazon_account_id: aid }, '-created_date', 50),
        base44.entities.AutopilotRun.filter({ amazon_account_id: aid }, '-started_at', 10),
        base44.entities.AutopilotConfig.filter({ amazon_account_id: aid }),
        base44.entities.SearchTerm.filter({ amazon_account_id: aid }, '-orders_14d', 500),
      ]);

      setCampaigns(getAutopilotEligible(cams));
      setAlerts(als);
      setNegatives(negs);
      setBidHistory(hist);
      setRuns(rs);
      setConfig(cfgs[0] || null);
      setSearchTerms(sts);

      // Mapa de campaign_id → nome da campanha para resolver IDs numéricos
      const campNameMap = new Map(cams.map(c => [c.campaign_id, c.name || c.campaign_name]));

      // Normalizar decisões para formato unificado
      const normalize = d => {
        // Tentar resolver nome legível: keyword > campaign_name > entity_name > ID truncado
        const resolvedName =
          d.keyword_text ||
          (d.campaign_id && campNameMap.get(d.campaign_id)) ||
          d.campaign_name ||
          d.entity_name ||
          (d.entity_id && String(d.entity_id).length > 10 ? `ID …${String(d.entity_id).slice(-6)}` : d.entity_id) ||
          '—';
        return {
          ...d,
          entity_name: resolvedName,
          current_value: d.value_before ?? d.current_value,
          proposed_value: d.value_after ?? d.proposed_value,
          decision_type: d.action || d.decision_type,
          confidence: d.confidence != null ? (d.confidence > 1 ? d.confidence / 100 : d.confidence) : null,
          priority: (d.risk === 'high' || d.risk === 'very_high') ? 'high' : d.risk === 'medium' ? 'medium' : 'low',
        };
      };

      const pending = allDecs.filter(d => d.status === 'pending').map(normalize);
      const done    = allDecs.filter(d => d.status !== 'pending').map(normalize);
      setDecisions(pending);
      setDecHistory(done);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Executar análise ──────────────────────────────────────────────────────────
  const runAnalysis = async (autoExecute = false) => {
    if (!account) return;
    setRunning(true);
    setRunMsg(autoExecute ? '⚡ Analisando e executando decisões automáticas...' : 'Analisando campanhas, keywords e search terms...');
    try {
      const res = await base44.functions.invoke('runDailyAdsOptimization', {
        amazon_account_id: account.id,
        trigger: 'manual',
      });
      const d = res.data;
      if (d?.ok) {
        const b = d.breakdown || {};
        const created = d.decisions_created || 0;
        const executed = d.decisions_executed || 0;
        const execFailed = d.decisions_exec_failed || 0;
        setRunMsg(
          `✓ ${created} decisões geradas · ${executed} executadas automaticamente${execFailed > 0 ? ` · ${execFailed} falhas` : ''} · ${b.harvest || 0} termos colhidos · ${b.bid_decrease || 0} bids ↓ · ${b.bid_increase || 0} bids ↑`
        );
        await loadData();
      } else if (d?.skipped) {
        setRunMsg(`⚠ ${d.reason}`);
      } else {
        setRunMsg(`❌ ${d?.error || 'Erro desconhecido'}`);
      }
    } catch (e) {
      setRunMsg(`❌ ${e.message}`);
    } finally {
      setRunning(false);
      setTimeout(() => setRunMsg(''), 15000);
    }
  };

  // ── Executar aprovadas em bulk (botão "Executar Aprovadas") ──────────────────
  const executeApproved = async () => {
    const approvedIds = decisions.filter(d => d.status === 'approved').map(d => d.id);
    if (!approvedIds.length) return;
    setExecuting(true);
    await base44.functions.invoke('executeAutopilotDecision', { decision_ids: approvedIds });
    setShowExecuteConfirm(false);
    await loadData();
    setExecuting(false);
  };

  // ── Aprovação individual / bulk (DecisionRow) ─────────────────────────────────
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

  // ── Demais ações ─────────────────────────────────────────────────────────────
  const dismissAlert = async (id) => {
    await base44.entities.AutopilotAlert.update(id, { is_read: true });
    setAlerts(prev => prev.filter(a => a.id !== id));
  };

  const approveNegative = async (id) => {
    await base44.entities.NegativeKeywordSuggestion.update(id, { status: 'approved' });
    setNegatives(prev => prev.filter(n => n.id !== id));
  };

  const rejectNegative = async (id) => {
    await base44.entities.NegativeKeywordSuggestion.update(id, { status: 'rejected' });
    setNegatives(prev => prev.filter(n => n.id !== id));
  };

  // ── Automação Total ───────────────────────────────────────────────────────────
  const runFullAutomation = async () => {
    if (!account) return;
    setFullAutoRunning(true);
    const aid = account.id;
    const steps = [
      { id: 'unlock',    label: 'Liberar locks e verificar pré-condições',       status: 'pending' },
      { id: 'sync',      label: 'Sincronizar dados da Amazon (sync completo)',    status: 'pending' },
      { id: 'optimize',  label: 'Analisar campanhas e gerar decisões IA',         status: 'pending' },
      { id: 'execute',   label: 'Executar decisões aprovadas automaticamente',    status: 'pending' },
      { id: 'dayparting',label: 'Calcular e aplicar regras de dayparting',        status: 'pending' },
      { id: 'guardrails',label: 'Executar guardrails e proteções horárias',       status: 'pending' },
    ];
    setFullAutoSteps(steps.map(s => ({ ...s })));

    const updateStep = (id, status, detail) =>
      setFullAutoSteps(prev => prev.map(s => s.id === id ? { ...s, status, detail } : s));

    const safeInvoke = async (fn, payload, retries = 1) => {
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const r = await base44.functions.invoke(fn, payload);
          const data = r?.data || {};
          // Rate limit → esperar e tentar novamente
          if (data?.error === 'Rate limit exceeded' && attempt < retries) {
            await new Promise(res => setTimeout(res, 3000 + attempt * 2000));
            continue;
          }
          return { ok: true, data };
        } catch (e) {
          const msg = e?.response?.data?.error || e?.response?.data?.message || e?.message || 'Erro desconhecido';
          if (msg === 'Rate limit exceeded' && attempt < retries) {
            await new Promise(res => setTimeout(res, 3000 + attempt * 2000));
            continue;
          }
          return { ok: false, error: msg };
        }
      }
      return { ok: false, error: 'Rate limit — tente novamente em alguns minutos' };
    };

    // PASSO 0: Liberar TODOS os locks (syncs e runs em andamento) — ação manual, sem threshold
    updateStep('unlock', 'running');
    try {
      const now = new Date().toISOString();
      // Liberar syncs em status 'started'
      const stuckSyncs = await base44.entities.SyncExecutionLog.filter({ amazon_account_id: aid, status: 'started' }, null, 20);
      for (const s of stuckSyncs) {
        await base44.entities.SyncExecutionLog.update(s.id, { status: 'error', completed_at: now, error_message: 'Liberado pela Automação Total (ação manual)' });
      }
      // Liberar runs em status 'running'
      const stuckRuns = await base44.entities.AutopilotRun.filter({ amazon_account_id: aid, status: 'running' }, null, 10);
      for (const r of stuckRuns) {
        await base44.entities.AutopilotRun.update(r.id, { status: 'failed', completed_at: now, error_message: 'Liberado pela Automação Total (ação manual)' });
      }
      updateStep('unlock', 'done', stuckSyncs.length + stuckRuns.length > 0
        ? `${stuckSyncs.length} syncs e ${stuckRuns.length} runs liberados`
        : 'Sistema pronto para execução');
    } catch (e) {
      updateStep('unlock', 'done', 'Verificação concluída');
    }
    await new Promise(r => setTimeout(r, 500));

    // PASSO 1: Sync (usa syncFullDaily que tem controle de rate limit e SyncExecutionLog correto)
    updateStep('sync', 'running');
    {
      const { ok, data, error } = await safeInvoke('syncFullDaily', { amazon_account_id: aid }, 2);
      if (ok && (data?.ok !== false)) {
        const r = data?.results?.[aid] || {};
        const skipped = data?.results?.[aid]?.skipped;
        updateStep('sync', 'done',
          skipped ? `Ignorado: ${skipped}` :
          `${data.accounts_processed || 1} conta(s) · ${data.syncs_executed || 0} syncs executados`);
      } else {
        // Sync com erro por rate limit não bloqueia os próximos passos — apenas avisa
        const errMsg = ok ? (data?.error || data?.message || 'Falhou') : error;
        const isRateLimit = errMsg?.includes('Rate limit') || errMsg?.includes('rate limit');
        updateStep('sync', isRateLimit ? 'done' : 'error',
          isRateLimit ? '⚠ Rate limit Amazon — usando dados existentes' : errMsg);
      }
    }

    // PASSO 2: Otimização
    updateStep('optimize', 'running');
    {
      const { ok, data, error } = await safeInvoke('runDailyAdsOptimization', { amazon_account_id: aid, trigger: 'full_auto' }, 2);
      if (ok && (data?.ok || data?.skipped)) {
        const b = data?.breakdown || {};
        updateStep('optimize', 'done',
          data?.skipped ? (data.reason || 'Ignorado') :
          `${data.decisions_created || 0} decisões · ${b.harvest || 0} termos · ${b.bid_decrease || 0} bids↓ · ${b.bid_increase || 0} bids↑`);
      } else {
        updateStep('optimize', 'error', ok ? (data?.error || data?.message || 'Falhou') : error);
      }
    }

    // PASSO 3: Executar aprovadas
    updateStep('execute', 'running');
    {
      const { ok, data, error } = await safeInvoke('runNightlyAutoExecution', { amazon_account_id: aid, trigger: 'full_auto' }, 2);
      if (ok && (data?.ok || data?.skipped)) {
        updateStep('execute', 'done',
          data?.skipped ? (data.reason || 'Sem decisões pendentes') :
          `${data.executed || 0} executadas · ${data.failed || 0} falhas`);
      } else {
        updateStep('execute', 'error', ok ? (data?.error || data?.message || 'Falhou') : error);
      }
    }

    // PASSO 4: Dayparting
    updateStep('dayparting', 'running');
    {
      const { ok, data, error } = await safeInvoke('runDailyDayparting', { amazon_account_id: aid });
      if (ok && (data?.ok || data?.skipped)) {
        const s = data?.stats || {};
        updateStep('dayparting', 'done',
          data?.skipped ? (data.reason || 'Sem dados suficientes') :
          `${s.auto_applied || 0} regras aplicadas · ${s.pending_review || 0} aguardam revisão`);
      } else {
        updateStep('dayparting', 'error', ok ? (data?.error || data?.message || 'Falhou') : error);
      }
    }

    // PASSO 5: Guardrails
    updateStep('guardrails', 'running');
    {
      const { ok, data, error } = await safeInvoke('runHourlyAdsGuardrails', { amazon_account_id: aid });
      if (ok && (data?.ok || data?.skipped)) {
        updateStep('guardrails', 'done',
          data?.skipped ? 'Sem alterações necessárias' :
          `${data.actions || 0} proteções aplicadas`);
      } else {
        updateStep('guardrails', 'error', ok ? (data?.error || data?.message || 'Falhou') : error);
      }
    }

    setFullAutoRunning(false);
    await loadData();
  };

  const unlockStuck = async () => {
    if (!account) return;
    setUnlocking(true);
    try {
      const res = await base44.functions.invoke('unlockStuckSyncs', { amazon_account_id: account.id });
      if (res.data?.ok) await loadData();
    } catch {}
    setUnlocking(false);
  };

  // ── Derivados ─────────────────────────────────────────────────────────────────
  const approvedCount = decisions.filter(d => d.status === 'approved').length;
  const lastRun = runs[0];
  const isRunning = lastRun?.status === 'running';
  const currencySymbol = config?.currency_symbol || account?.currency_symbol || 'R$';
  const stuckRunAge = isRunning && lastRun?.started_at
    ? Math.round((Date.now() - new Date(lastRun.started_at).getTime()) / 60000) : 0;
  const isStuck = isRunning && stuckRunAge > 60;

  // Termos convertidos
  const stMap = new Map();
  for (const st of searchTerms) {
    const key = `${st.search_term || st.keyword_text}|${st.advertised_asin}`;
    const ex = stMap.get(key);
    if (!ex || (st.orders_14d || 0) > (ex.orders_14d || 0)) stMap.set(key, st);
  }
  const allSearchTerms = Array.from(stMap.values());
  const convertedTerms = allSearchTerms.filter(st =>
    stTermFilter === 'all'      ? true :
    stTermFilter === 'promoted' ? st.promoted_to_manual :
    stTermFilter === 'first_sale' ? st.classification === 'FIRST_SALE' :
    stTermFilter === 'winner'   ? st.classification === 'WINNER' :
    stTermFilter === 'wasting'  ? st.classification === 'WASTING' : true
  );

  // Filtro de tipo nas decisões pendentes
  const filteredDecisions = filterType === 'all' ? decisions : decisions.filter(d => d.decision_type === filterType);
  const allSelected = selectedIds.size === filteredDecisions.length && filteredDecisions.length > 0;
  const decisionTypes = ['all', ...new Set(decisions.map(d => d.decision_type).filter(Boolean))];

  const stats = {
    pending: decisions.length,
    high: decisions.filter(d => d.priority === 'high').length,
    approved: decHistory.filter(d => d.status === 'approved' || d.status === 'executed').length,
    rejected: decHistory.filter(d => d.status === 'rejected').length,
  };

  // ── Verificar se dados do dia anterior estão analisados ──────────────────────
  const now = new Date();
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);
  const todayStr = now.toISOString().slice(0, 10);

  const lastSuccessRun = runs.find(r => r.status === 'completed');
  const lastRunDate = lastSuccessRun?.started_at ? new Date(lastSuccessRun.started_at).toISOString().slice(0, 10) : null;
  const lastSyncDate = account?.last_sync_at ? new Date(account.last_sync_at).toISOString().slice(0, 10) : null;

  // Dados frescos = sync do dia anterior ou hoje; análise = run do dia anterior ou hoje
  const syncFresh = lastSyncDate && (lastSyncDate >= yesterdayStr);
  const analysisFresh = lastRunDate && (lastRunDate >= yesterdayStr);

  let dataWarning = null;
  if (!syncFresh && !analysisFresh) {
    dataWarning = { level: 'critical', msg: `⚠️ Dados não sincronizados e nenhuma análise do dia anterior. Último sync: ${lastSyncDate || 'nunca'}. Execute o sync antes de usar o Autopilot.` };
  } else if (!syncFresh) {
    dataWarning = { level: 'warn', msg: `🔄 Sincronização pendente — último sync: ${lastSyncDate || 'nunca'}. Os dados podem estar desatualizados.` };
  } else if (!analysisFresh) {
    dataWarning = { level: 'warn', msg: `🤖 Análise do dia anterior ainda não executada (último ciclo: ${lastRunDate || 'nunca'}). Clique em "Analisar & Executar" para consolidar as decisões.` };
  }

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <Bot className="w-6 h-6 text-cyan" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Ads Autopilot <span className="text-sm font-normal text-cyan">& IA</span></h1>
            <p className="text-xs text-slate-400">
              {isRunning && !isStuck ? <span className="text-amber-400 animate-pulse">⚡ Análise em andamento...</span> :
               isStuck ? <span className="text-red-400">⚠ Run travado há {stuckRunAge} min</span> :
               lastRun ? `Último ciclo: ${new Date(lastRun.started_at).toLocaleString('pt-BR')}` : 'Nenhuma análise executada'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {isStuck && (
            <button onClick={unlockStuck} disabled={unlocking}
              className="flex items-center gap-2 px-3 py-2 bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/25 text-sm font-semibold rounded-lg disabled:opacity-50 transition-colors">
              {unlocking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unlock className="w-4 h-4" />}
              Liberar run travado
            </button>
          )}
          {approvedCount > 0 && (
            <button onClick={() => setShowExecuteConfirm(true)}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded-lg transition-colors">
              <Play className="w-4 h-4" /> Executar Aprovadas ({approvedCount})
            </button>
          )}
          {selectedIds.size > 0 && tab === 'decisions' && (
            <>
              <span className="text-xs text-slate-500">{selectedIds.size} sel.</span>
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
          <button onClick={() => { setShowFullAuto(true); runFullAutomation(); }}
            disabled={fullAutoRunning || running || (isRunning && !isStuck)}
            className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-violet-600 to-cyan-600 hover:from-violet-500 hover:to-cyan-500 text-white text-sm font-bold rounded-lg disabled:opacity-60 transition-all shadow-lg shadow-violet-500/20">
            {fullAutoRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
            {fullAutoRunning ? 'Automação...' : 'Automação Total'}
          </button>
          <button onClick={() => runAnalysis(true)} disabled={running || fullAutoRunning || (isRunning && !isStuck)}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded-lg disabled:opacity-60 transition-colors">
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            {running ? 'Executando...' : 'Analisar & Executar'}
          </button>
          <button onClick={() => runAnalysis(false)} disabled={running || fullAutoRunning || (isRunning && !isStuck)}
            className="flex items-center gap-2 px-4 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm font-semibold rounded-lg disabled:opacity-60 transition-colors">
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Só Analisar
          </button>
          <button onClick={loadData} disabled={loading || running}
            className="p-2.5 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {runMsg && (
        <div className={`p-3 rounded-xl border text-sm font-medium ${runMsg.startsWith('✓') ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' : runMsg.startsWith('⚠') ? 'bg-amber-400/10 border-amber-400/20 text-amber-300' : 'bg-red-400/10 border-red-400/20 text-red-400'}`}>
          {runMsg}
        </div>
      )}

      {/* Banner de aviso de dados desatualizados */}
      {!loading && account && dataWarning && (
        <div className={`flex items-start gap-3 p-4 rounded-xl border text-sm ${dataWarning.level === 'critical' ? 'bg-red-500/10 border-red-500/25 text-red-300' : 'bg-amber-500/10 border-amber-500/25 text-amber-300'}`}>
          <AlertTriangle className={`w-4 h-4 mt-0.5 flex-shrink-0 ${dataWarning.level === 'critical' ? 'text-red-400' : 'text-amber-400'}`} />
          <div className="flex-1 min-w-0">
            <p className="font-medium">{dataWarning.msg}</p>
            {!analysisFresh && syncFresh && (
              <button onClick={() => runAnalysis(true)} disabled={running}
                className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/30 text-amber-200 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50">
                {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                Executar análise agora
              </button>
            )}
          </div>
          <div className="text-xs text-slate-500 whitespace-nowrap flex-shrink-0">
            <p>Sync: {lastSyncDate || '—'}</p>
            <p>Análise: {lastRunDate || '—'}</p>
          </div>
        </div>
      )}

      {error && <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-sm text-red-400">{error}</div>}

      {!loading && !account && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-6 text-center">
          <p className="text-amber-400 font-semibold">Nenhuma conta Amazon conectada.</p>
          <p className="text-sm text-slate-400 mt-1">Configure sua conta Amazon nas Configurações antes de usar o Autopilot.</p>
        </div>
      )}

      {account && (
        <>
          <AutopilotKPIBar runs={runs} decisions={decisions} alerts={alerts} campaigns={campaigns} config={config} loading={loading} searchTerms={searchTerms} />

          {/* KPIs de decisões (estilo LearnerEngine) */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: 'Pendentes',      value: stats.pending,  color: 'text-amber-400',   bg: 'bg-amber-400/10 border-amber-400/20' },
              { label: 'Alta Prioridade',value: stats.high,     color: 'text-red-400',     bg: 'bg-red-400/10 border-red-400/20' },
              { label: 'Aprovadas',      value: stats.approved, color: 'text-emerald-400', bg: 'bg-emerald-400/10 border-emerald-400/20' },
              { label: 'Rejeitadas',     value: stats.rejected, color: 'text-slate-400',   bg: 'bg-slate-400/10 border-slate-400/20' },
            ].map(s => (
              <div key={s.label} className={`rounded-xl border p-4 ${s.bg}`}>
                <p className="text-xs text-slate-500 mb-1">{s.label}</p>
                <p className={`text-2xl font-bold ${s.color}`}>{s.value}</p>
              </div>
            ))}
          </div>

          {/* Tabs */}
          <div className="flex border-b border-surface-2 overflow-x-auto">
            {TABS.map(t => {
              const Icon = t.icon;
              return (
                <button key={t.id} onClick={() => setTab(t.id)}
                  className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${tab === t.id ? 'border-cyan text-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
                  {Icon && <Icon className="w-3.5 h-3.5" />}{t.label}
                </button>
              );
            })}
          </div>

          {/* Conteúdo das abas sem loading para dayparting/recommendations/rules */}
          {tab === 'recommendations' ? <Recommendations /> :
           tab === 'dayparting'      ? <DaypartingDashboard /> :
           loading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
           ) : tab === 'rules' ? (
            <BiddingRulesPanel amazonAccountId={account?.id} />
           ) : tab === 'config' ? (
            <AutopilotConfigPanel amazonAccountId={account?.id} onConfigSaved={loadData} />
           ) : tab === 'decisions' ? (
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
                    <p className="text-base font-semibold text-slate-300">Sem decisões pendentes</p>
                    <p className="text-sm text-slate-500 mt-1">Use "Analisar & Executar" para gerar novas decisões.</p>
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
                          <DecisionRow key={dec.id} dec={dec}
                            actionState={actionStates[dec.id]}
                            selected={selectedIds.has(dec.id)}
                            onSelect={() => toggleSelect(dec.id)}
                            onApprove={(v) => handleDecision(dec.id, 'approve', v)}
                            onReject={() => handleDecision(dec.id, 'reject')}
                            currencySymbol={currencySymbol}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {filteredDecisions.length > 3 && (
                    <div className="px-4 py-3 border-t border-surface-2 flex items-center justify-between">
                      <p className="text-xs text-slate-500">{filteredDecisions.length} decisões · clique no bid proposto para editar antes de aprovar</p>
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
                    </div>
                  )}
                </div>
              )}

              {/* Histórico de decisões abaixo das pendentes */}
              {decHistory.length > 0 && (
                <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden mt-4">
                  <div className="px-5 py-3 border-b border-surface-2">
                    <h3 className="text-sm font-semibold text-white">Histórico de Decisões</h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-surface-2 bg-surface-2/50">
                          {['Tipo', 'Entidade', 'Valor', 'Variação', 'Estado', 'Data'].map(h => (
                            <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {decHistory.slice(0, 50).map(d => <HistoryRow key={d.id} d={d} currencySymbol={currencySymbol} />)}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
           ) : tab === 'converted' ? (
            <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-surface-2 flex items-center justify-between flex-wrap gap-2">
                <div>
                  <h3 className="text-sm font-semibold text-white">Search Terms com Performance</h3>
                  <p className="text-xs text-slate-500 mt-0.5">{allSearchTerms.length} termos únicos analisados</p>
                </div>
                <div className="flex gap-1 flex-wrap">
                  {[
                    { k: 'all',        label: `Todos (${allSearchTerms.length})` },
                    { k: 'first_sale', label: `1ª Venda (${allSearchTerms.filter(s => s.classification === 'FIRST_SALE').length})` },
                    { k: 'winner',     label: `Vencedores (${allSearchTerms.filter(s => s.classification === 'WINNER').length})` },
                    { k: 'wasting',    label: `Desperdiçando (${allSearchTerms.filter(s => s.classification === 'WASTING').length})` },
                    { k: 'promoted',   label: `Promovidos (${allSearchTerms.filter(s => s.promoted_to_manual).length})` },
                  ].map(f => (
                    <button key={f.k} onClick={() => setStTermFilter(f.k)}
                      className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${stTermFilter === f.k ? 'bg-cyan/20 text-cyan' : 'bg-surface-2 text-slate-500 hover:text-slate-300'}`}>
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-surface-2 bg-surface-2/50">
                      {['Search Term', 'ASIN', 'Classificação', 'Pedidos 14d', 'Vendas 14d', 'Spend', 'ACoS 14d', 'Promovido', 'Última Ação'].map(h => (
                        <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {convertedTerms.length === 0 ? (
                      <tr><td colSpan={9} className="px-5 py-10 text-center text-sm text-slate-500">Nenhum termo neste filtro</td></tr>
                    ) : convertedTerms.slice(0, 200).map(st => {
                      const acos = st.acos_14d || 0;
                      const acosColor = acos > (config?.target_acos || 25) ? 'text-red-400' : acos > 0 ? 'text-emerald-400' : 'text-slate-500';
                      return (
                        <tr key={st.id} className="border-b border-surface-2/40 hover:bg-surface-2/50">
                          <td className="px-4 py-2.5 font-mono text-xs text-white max-w-[200px] truncate">{st.search_term || st.keyword_text || '—'}</td>
                          <td className="px-3 py-2.5 text-xs font-mono text-cyan">{st.advertised_asin || '—'}</td>
                          <td className="px-3 py-2.5">
                            {st.classification ? (
                              <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${CLASSIFICATION_COLORS[st.classification] || 'text-slate-400 bg-slate-400/10 border-slate-400/20'}`}>
                                {st.classification}
                              </span>
                            ) : <span className="text-xs text-slate-600">—</span>}
                          </td>
                          <td className="px-3 py-2.5 text-xs text-white font-semibold">{st.orders_14d || 0}</td>
                          <td className="px-3 py-2.5 text-xs text-emerald-400">{currencySymbol}{(st.sales_14d || 0).toFixed(2)}</td>
                          <td className="px-3 py-2.5 text-xs text-slate-400">{currencySymbol}{(st.spend || 0).toFixed(2)}</td>
                          <td className={`px-3 py-2.5 text-xs font-semibold ${acosColor}`}>{acos > 0 ? `${acos.toFixed(1)}%` : '—'}</td>
                          <td className="px-3 py-2.5">
                            {st.promoted_to_manual
                              ? <span className="text-xs text-purple-400">✓ {st.promoted_at ? new Date(st.promoted_at).toLocaleDateString('pt-BR') : 'Sim'}</span>
                              : <span className="text-xs text-slate-600">—</span>}
                          </td>
                          <td className="px-3 py-2.5 text-xs text-slate-500 max-w-[140px] truncate">
                            {st.last_action || '—'}
                            {st.last_action_at && <span className="text-slate-600 ml-1">{new Date(st.last_action_at).toLocaleDateString('pt-BR')}</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
           ) : tab === 'alerts' ? (
            <AutopilotAlertsPanel alerts={alerts} onDismiss={dismissAlert} />
           ) : tab === 'negatives' ? (
            <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-surface-2">
                <h3 className="text-sm font-semibold text-white">Sugestões de Palavras Negativas</h3>
                <p className="text-xs text-slate-500 mt-0.5">Keywords com gasto e sem conversão</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-surface-2 bg-surface-2/50">
                      {['Keyword', 'Tipo', 'Cliques', 'Spend', 'Vendas', 'Motivo', 'Ação'].map(h => (
                        <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {negatives.length === 0 ? (
                      <tr><td colSpan={7} className="px-5 py-8 text-center text-sm text-slate-500">Nenhuma sugestão de negativa pendente</td></tr>
                    ) : negatives.map(n => (
                      <tr key={n.id} className="border-b border-surface-2/40 hover:bg-surface-2/50">
                        <td className="px-4 py-3 font-mono text-xs text-white">{n.keyword_text}</td>
                        <td className="px-3 py-3 text-xs text-slate-400">{n.match_type}</td>
                        <td className="px-3 py-3 text-xs text-slate-300">{n.clicks}</td>
                        <td className="px-3 py-3 text-xs text-red-400">{currencySymbol}{(n.spend || 0).toFixed(2)}</td>
                        <td className="px-3 py-3 text-xs text-slate-400">{currencySymbol}{(n.sales || 0).toFixed(2)}</td>
                        <td className="px-3 py-3 text-xs text-slate-500 max-w-[180px] truncate">{n.reason}</td>
                        <td className="px-4 py-3">
                          <div className="flex gap-1.5">
                            <button onClick={() => approveNegative(n.id)}
                              className="px-2.5 py-1.5 bg-red-600 hover:bg-red-500 text-white text-xs font-bold rounded-lg transition-colors">
                              Negativar
                            </button>
                            <button onClick={() => rejectNegative(n.id)}
                              className="px-2.5 py-1.5 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white text-xs rounded-lg transition-colors">
                              Ignorar
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
           ) : tab === 'history' ? (
            <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-surface-2">
                <h3 className="text-sm font-semibold text-white">Histórico de Alterações de Bid</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-surface-2 bg-surface-2/50">
                      {['Entidade', 'Tipo', 'Antes', 'Depois', 'Variação', 'Motivo', 'Por', 'Data'].map(h => (
                        <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {bidHistory.length === 0 ? (
                      <tr><td colSpan={8} className="px-5 py-8 text-center text-sm text-slate-500">Nenhuma alteração de bid registrada</td></tr>
                    ) : bidHistory.map(h => {
                      const before = h.bid_before ?? h.budget_before;
                      const after  = h.bid_after  ?? h.budget_after;
                      const pct    = h.change_pct || 0;
                      return (
                        <tr key={h.id} className="border-b border-surface-2/40 hover:bg-surface-2/50">
                          <td className="px-4 py-3 text-xs text-white font-medium truncate max-w-[160px]">{h.entity_name}</td>
                          <td className="px-3 py-3 text-xs text-slate-400">{h.entity_type}</td>
                          <td className="px-3 py-3 font-mono text-xs text-slate-400">{currencySymbol}{(before || 0).toFixed(2)}</td>
                          <td className="px-3 py-3 font-mono text-xs text-white">{currencySymbol}{(after || 0).toFixed(2)}</td>
                          <td className="px-3 py-3">
                            <span className={`text-xs font-semibold ${pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {pct >= 0 ? '+' : ''}{pct.toFixed(1)}%
                            </span>
                          </td>
                          <td className="px-3 py-3 text-xs text-slate-500 max-w-[180px] truncate">{h.reason}</td>
                          <td className="px-3 py-3 text-xs text-slate-500">{h.applied_by}</td>
                          <td className="px-3 py-3 text-xs text-slate-600 whitespace-nowrap">
                            {h.created_date ? new Date(h.created_date).toLocaleDateString('pt-BR') : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
           ) : null}
        </>
      )}

      {/* Modal Automação Total */}
      {showFullAuto && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-surface-1 border border-surface-2 rounded-2xl p-6 max-w-lg w-full space-y-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500/30 to-cyan-500/30 border border-violet-500/30 flex items-center justify-center">
                <Rocket className="w-5 h-5 text-violet-300" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Automação Total em Andamento</h3>
                <p className="text-xs text-slate-400 mt-0.5">Sync · Otimização · Execução · Dayparting · Guardrails</p>
              </div>
            </div>

            <div className="space-y-2">
              {fullAutoSteps.map((step, i) => (
                <div key={step.id} className={`flex items-start gap-3 p-3 rounded-xl border transition-all ${
                  step.status === 'running' ? 'bg-cyan/5 border-cyan/20' :
                  step.status === 'done'    ? 'bg-emerald-500/5 border-emerald-500/20' :
                  step.status === 'error'   ? 'bg-red-500/5 border-red-500/20' :
                  'bg-surface-2/30 border-surface-2'
                }`}>
                  <div className="flex-shrink-0 mt-0.5">
                    {step.status === 'running' ? <Loader2 className="w-4 h-4 text-cyan animate-spin" /> :
                     step.status === 'done'    ? <CheckCircle className="w-4 h-4 text-emerald-400" /> :
                     step.status === 'error'   ? <XCircle className="w-4 h-4 text-red-400" /> :
                     <div className="w-4 h-4 rounded-full border-2 border-slate-600" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={`text-xs font-semibold ${
                      step.status === 'running' ? 'text-cyan' :
                      step.status === 'done'    ? 'text-emerald-300' :
                      step.status === 'error'   ? 'text-red-400' : 'text-slate-500'
                    }`}>{step.label}</p>
                    {step.detail && (
                      <p className={`text-[10px] mt-0.5 ${step.status === 'error' ? 'text-red-400/70' : 'text-slate-500'}`}>{step.detail}</p>
                    )}
                  </div>
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border flex-shrink-0 ${
                    step.status === 'running' ? 'text-cyan bg-cyan/10 border-cyan/20' :
                    step.status === 'done'    ? 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' :
                    step.status === 'error'   ? 'text-red-400 bg-red-400/10 border-red-400/20' :
                    'text-slate-600 bg-surface-3 border-surface-3'
                  }`}>
                    {step.status === 'pending' ? `${i+1}` : step.status === 'running' ? '...' : step.status === 'done' ? '✓' : '✗'}
                  </span>
                </div>
              ))}
            </div>

            {!fullAutoRunning && (
              <div className="flex items-center justify-between pt-1">
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <Shield className="w-3.5 h-3.5" />
                  {fullAutoSteps.filter(s => s.status === 'error').length === 0
                    ? 'Todos os passos concluídos com sucesso.'
                    : `${fullAutoSteps.filter(s => s.status === 'error').length} passo(s) com erro — verifique os logs.`}
                </div>
                <button onClick={() => setShowFullAuto(false)}
                  className="px-4 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm font-semibold rounded-lg transition-colors">
                  Fechar
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal confirmar execução */}
      {showExecuteConfirm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-surface-1 border border-surface-2 rounded-2xl p-6 max-w-md w-full space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center">
                <Play className="w-5 h-5 text-emerald-400" />
              </div>
              <h3 className="text-base font-bold text-white">Executar {approvedCount} decisões aprovadas?</h3>
            </div>
            <p className="text-sm text-slate-400">
              As decisões aprovadas serão enviadas à Amazon Ads API. Ações críticas (pausar campanha, negativar) precisam ser confirmadas individualmente.
            </p>
            <div className="flex gap-3">
              <button onClick={executeApproved} disabled={executing}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold rounded-lg disabled:opacity-50 transition-colors">
                {executing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                Confirmar Execução
              </button>
              <button onClick={() => setShowExecuteConfirm(false)}
                className="flex-1 py-2.5 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}