import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import {
  Terminal, RefreshCw, Loader2, AlertTriangle, Bell, FileText,
  Activity, Zap, CheckCircle, XCircle, TrendingUp, TrendingDown,
  Play, Wrench, RotateCcw, ChevronDown, ChevronRight, Trash2,
  Clock, Filter, Search, Download, Package, Key, Rocket,
  AlertCircle, Check, Eye, DollarSign, Minus, Bot, Settings,
  Pause, PlayCircle
} from 'lucide-react';
import PrelecaoTab from '@/components/sala/PrelecaoTab';
import EstrategiasTab from '@/components/sala/EstrategiasTab';
import BudgetSpendControlPanel from '@/components/sala/BudgetSpendControlPanel';
import KickoffControlPanel from '@/components/products/KickoffControlPanel';
import PauseQueuePanel from '@/components/sala/PauseQueuePanel';
import KeywordBidChangesPanel from '@/components/sala/KeywordBidChangesPanel';
import ManualBidLifecyclePanel from '@/components/sala/ManualBidLifecyclePanel';
import SyncFailureMonitor from '@/components/dashboard/SyncFailureMonitor';
import ReactivationLogPanel from '@/components/sala/ReactivationLogPanel';
import GuardrailStatusPanel from '@/components/sala/GuardrailStatusPanel';
import MotorExecutionPanel from '@/components/sala/MotorExecutionPanel';
import BackupPanel from '@/components/backup/BackupPanel';
import { Link } from 'react-router-dom';
import TokenExpiredBanner from '@/components/amazon/TokenExpiredBanner';
import {
  BarChart as ReBarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  AreaChart, Area
} from 'recharts';
import StatusBadge from '@/components/ui/StatusBadge';

// ── Helpers ──────────────────────────────────────────────────────────────────

const ALERT_CONFIG = {
  high_acos:        { color: 'text-red-400',    bg: 'bg-red-500/10 border-red-500/20',       label: 'ACoS Alto' },
  low_roas:         { color: 'text-amber-400',  bg: 'bg-amber-500/10 border-amber-500/20',   label: 'ROAS Baixo' },
  budget_exhausted: { color: 'text-red-400',    bg: 'bg-red-500/10 border-red-500/20',       label: 'Budget Esgotado' },
  no_impressions:   { color: 'text-amber-400',  bg: 'bg-amber-500/10 border-amber-500/20',   label: 'Sem Impressões' },
  out_of_stock:     { color: 'text-red-400',    bg: 'bg-red-500/10 border-red-500/20',       label: 'Sem Estoque' },
  token_expired:    { color: 'text-red-400',    bg: 'bg-red-500/10 border-red-500/20',       label: 'Token Expirado' },
  high_cpc:         { color: 'text-amber-400',  bg: 'bg-amber-500/10 border-amber-500/20',   label: 'CPC Alto' },
  campaign_paused:  { color: 'text-slate-400',  bg: 'bg-slate-500/10 border-slate-500/20',   label: 'Campanha Pausada' },
  rate_limit:       { color: 'text-amber-400',  bg: 'bg-amber-500/10 border-amber-500/20',   label: 'Rate Limit' },
  sync_error:       { color: 'text-red-400',    bg: 'bg-red-500/10 border-red-500/20',       label: 'Erro de Sync' },
};

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

const STATUS_QUEUE = {
  scheduled:  { label: 'Agendado',    color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/20' },
  processing: { label: 'Processando', color: 'text-cyan',        bg: 'bg-cyan/10 border-cyan/20' },
  completed:  { label: 'Concluído',   color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20' },
  failed:     { label: 'Erro',        color: 'text-red-400',     bg: 'bg-red-500/10 border-red-500/20' },
  cancelled:  { label: 'Cancelado',   color: 'text-slate-500',   bg: 'bg-slate-500/5 border-slate-500/15' },
};

function parseError(err) {
  if (!err) return null;
  if (err.includes('campaignId=') || err.includes('Dados insuficientes'))
    return { type: 'no_campaign', short: 'Sem campaign_id', hint: 'Campanha não criada na Amazon. Use o Kickoff na página de Produtos.' };
  if (err.includes('403') || err.includes('token'))
    return { type: 'auth', short: 'Token expirado', hint: 'Reautorize em Integrações → Amazon.' };
  if (err.includes('429') || err.includes('Rate limit'))
    return { type: 'rate_limit', short: 'Rate limit', hint: 'Aguarde e tente novamente.' };
  return { type: 'generic', short: 'Erro', hint: err };
}

const TAB_GROUPS = [
  {
    id: 'overview',
    label: 'Visão Geral',
    tabs: [
      { id: 'visao_geral', label: 'Resumo' },
      { id: 'acoes_janela', label: 'Ações da Janela' },
    ],
  },
  {
    id: 'operations',
    label: 'Operações Ads',
    tabs: [
      { id: 'fila', label: 'Fila e Execuções' },
      { id: 'pausas', label: 'Pausas Pendentes' },
      { id: 'reparo', label: 'Reparo de Campanhas' },
      { id: 'reativacoes', label: 'Reativações Auto.' },
      { id: 'bids_keywords', label: 'Alterações de Keywords e Bids' },
      { id: 'bid_lifecycle', label: 'Ciclo de Bids Manuais' },
    ],
  },
  {
    id: 'budget_group',
    label: 'Orçamento',
    tabs: [
      { id: 'orcamento', label: 'Controle de Gasto Diário' },
    ],
  },
  {
    id: 'strategy',
    label: 'Estratégia & IA',
    tabs: [
      { id: 'estrategias', label: 'Motor de Estratégias' },
      { id: 'prelecao', label: 'Revisão Semanal' },
      { id: 'historico', label: 'Histórico e Decisões' },
      { id: 'autopilot', label: 'Automação IA' },
    ],
  },
  {
    id: 'kickoff_group',
    label: 'Kick-off',
    tabs: [{ id: 'kickoff', label: 'Produtos e Ciclos' }],
  },
  {
    id: 'monitoring',
    label: 'Monitoramento',
    tabs: [
      { id: 'motor_v8', label: 'Motor v8' },
      { id: 'alertas', label: 'Alertas' },
      { id: 'sync_monitor', label: 'Sincronizações' },
    ],
  },
  {
    id: 'system',
    label: 'Sistema',
    tabs: [{ id: 'backup', label: 'Backup' }],
  },
];

const TABS = TAB_GROUPS.flatMap(group => group.tabs);

function findTabGroup(tabId) {
  return TAB_GROUPS.find(group => group.tabs.some(tab => tab.id === tabId)) || TAB_GROUPS[0];
}



// ── Subcomponentes ────────────────────────────────────────────────────────────

function QueueStatusBadge({ status }) {
  const cfg = STATUS_QUEUE[status] || STATUS_QUEUE.scheduled;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded-lg border ${cfg.bg} ${cfg.color} whitespace-nowrap`}>
      {cfg.label}
    </span>
  );
}

function QueueRowItem({ item, onDelete, onRetry, retrying }) {
  const [expanded, setExpanded] = useState(item.status === 'failed');
  const isFailed = item.status === 'failed';
  const parsed = isFailed ? parseError(item.last_error) : null;
  return (
    <div className={`border-b border-surface-2/50 ${isFailed ? 'bg-red-500/3' : ''}`}>
      <div className="flex items-start gap-3 px-4 py-3">
        <button onClick={() => setExpanded(v => !v)} className="mt-0.5 text-slate-600 hover:text-slate-400">
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-mono font-bold text-cyan">{item.asin || '—'}</span>
            {item.campaign_name && <span className="text-xs text-slate-400 truncate max-w-[200px]">{item.campaign_name}</span>}
          </div>
          <div className="flex items-center gap-3 mt-1 text-[10px] text-slate-500 flex-wrap">
            {(item.attempt_count || 0) > 0 ? <span className="text-amber-400">{item.attempt_count}/{item.max_attempts || 5} tentativas</span> : null}
            {item.scheduled_at && <span>Agendado: {new Date(item.scheduled_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>}
          </div>
          {expanded && isFailed && parsed && (
            <div className="mt-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2">
              <p className="text-[10px] font-bold text-red-400 mb-0.5">{parsed.short}</p>
              <p className="text-[10px] text-red-300/80">{parsed.hint}</p>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <QueueStatusBadge status={item.status} />
          {isFailed && parsed?.type !== 'no_campaign' && (
            <button onClick={() => onRetry(item)} disabled={retrying === item.id}
              className="p-1.5 rounded-lg text-amber-400 hover:bg-amber-500/15 transition-colors disabled:opacity-30">
              {retrying === item.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wrench className="w-3.5 h-3.5" />}
            </button>
          )}
          {['failed', 'completed', 'cancelled'].includes(item.status) && (
            <button onClick={() => onDelete(item.id)} className="p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10 transition-colors">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Página Principal ──────────────────────────────────────────────────────────

export default function SalaDeComando() {
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get('tab');
  const [tab, setTab] = useState(initialTab && TABS.find(t => t.id === initialTab) ? initialTab : 'visao_geral');
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(true);

  // Alertas
  const [alerts, setAlerts] = useState([]);
  const [alertFilter, setAlertFilter] = useState('active');
  const [generating, setGenerating] = useState(false);

  // Fila
  const [kickoffQueue, setKickoffQueue] = useState([]);
  const [repairQueue, setRepairQueue] = useState([]);
  const [keywordQueue, setKeywordQueue] = useState([]);
  const [running, setRunning] = useState({ kickoff: false, repair: false, keyword: false });
  const [retrying, setRetrying] = useState(null);
  const [queueFilter, setQueueFilter] = useState('all');

  // Histórico de Lances
  const [bidLogs, setBidLogs] = useState([]);
  const [bidSearch, setBidSearch] = useState('');
  const [bidFilter, setBidFilter] = useState({ direction: 'all', status: 'all' });
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const [runningBidEngine, setRunningBidEngine] = useState(false);

  // Decisões IA
  const [decisions, setDecisions] = useState([]);
  const [syncRuns, setSyncRuns] = useState([]);

  // Reparo incompleto
  const [repairRunning, setRepairRunning] = useState(false);
  const [repairMsg, setRepairMsg] = useState(null);

  // Ações da Janela
  const [windowActions, setWindowActions] = useState([]);
  const [windowActionsLoading, setWindowActionsLoading] = useState(false);
  const [actionWorking, setActionWorking] = useState(null); // id da ação em processamento

  const intervalRef = useRef(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0] || (await base44.entities.AmazonAccount.list())[0];
      setAccount(acc);
      if (!acc) return;
      const aid = acc.id;

      const [
        alertsData, kickoff, repair, keyword, logs, decs, runs,
      ] = await Promise.all([
        base44.entities.Alert.filter({ amazon_account_id: aid }, '-created_at', 100),
        base44.entities.ProductKickoffQueue.filter({ amazon_account_id: aid }, '-scheduled_at', 80),
        base44.entities.AutoCampaignRepairQueue.filter({ amazon_account_id: aid }, '-scheduled_at', 80),
        base44.entities.KeywordRepairQueue.filter({ amazon_account_id: aid }, '-scheduled_at', 80),
        base44.entities.AdsBidChangeLog.filter({ amazon_account_id: aid }, '-created_at', 200),
        base44.entities.OptimizationDecision.filter({ amazon_account_id: aid }, '-created_at', 100),
        base44.entities.SyncExecutionLog.filter({ amazon_account_id: aid }, '-started_at', 100),
      ]);

      setAlerts(alertsData.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4)));
      setKickoffQueue(kickoff);
      setRepairQueue(repair);
      setKeywordQueue(keyword);
      setBidLogs(logs);
      setDecisions(decs);
      setSyncRuns(runs);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
    intervalRef.current = setInterval(() => loadAll(), 60000);
    return () => clearInterval(intervalRef.current);
  }, [loadAll]);

  // ── Ações de Alerta ──
  const resolveAlert = async (id) => {
    await base44.entities.Alert.update(id, { status: 'resolved', resolved_at: new Date().toISOString() });
    setAlerts(prev => prev.map(a => a.id === id ? { ...a, status: 'resolved' } : a));
  };
  const acknowledgeAlert = async (id) => {
    await base44.entities.Alert.update(id, { status: 'acknowledged' });
    setAlerts(prev => prev.map(a => a.id === id ? { ...a, status: 'acknowledged' } : a));
  };
  const generateAlerts = async () => {
    if (!account) return;
    setGenerating(true);
    try {
      const res = await base44.functions.invoke('checkAndCreateAlerts', { amazon_account_id: account.id });
      await loadAll();
    } finally { setGenerating(false); }
  };

  // ── Ações de Fila ──
  const deleteQueueItem = async (entityName, id) => {
    await base44.entities[entityName].delete(id);
    loadAll();
  };
  const retryQueueItem = async (item, entityName, runnerFn) => {
    if (retrying) return;
    setRetrying(item.id);
    try {
      await base44.entities[entityName].update(item.id, { status: 'scheduled', last_error: null, attempt_count: 0, scheduled_at: new Date().toISOString() });
      await base44.functions.invoke(runnerFn, { amazon_account_id: item.amazon_account_id, force: true });
      loadAll();
    } finally { setRetrying(null); }
  };
  const runQueueNow = async (key, fnName) => {
    if (!account || running[key]) return;
    setRunning(r => ({ ...r, [key]: true }));
    try {
      await base44.functions.invoke(fnName, { amazon_account_id: account.id, force: true });
      loadAll();
    } finally { setRunning(r => ({ ...r, [key]: false })); }
  };
  const clearDone = async (entityName, items) => {
    const done = items.filter(i => ['completed', 'cancelled', 'failed'].includes(i.status));
    await Promise.all(done.map(i => base44.entities[entityName].delete(i.id)));
    loadAll();
  };

  // ── Ações de Bid Log ──
  const syncBids = async () => {
    if (!account || syncing) return;
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await base44.functions.invoke('syncBidChangesFromApi', { amazon_account_id: account.id });
      const d = res.data;
      setSyncMsg(d?.ok ? { type: 'success', text: `✓ ${d.keywords_synced} keywords · ${d.changes} alterações` } : { type: 'error', text: d?.error || 'Falha' });
      loadAll();
    } catch (e) { setSyncMsg({ type: 'error', text: e.message }); }
    finally { setSyncing(false); setTimeout(() => setSyncMsg(null), 10000); }
  };
  const runBidEngines = async () => {
    if (!account || runningBidEngine) return;
    setRunningBidEngine(true);
    try {
      await Promise.all([
        base44.functions.invoke('smartBidFromCpc', { amazon_account_id: account.id }),
        base44.functions.invoke('calibrateBidsNoImpressions', { amazon_account_id: account.id }),
      ]);
      loadAll();
    } finally { setRunningBidEngine(false); }
  };

  // ── Ações da Janela ──
  const loadWindowActions = async () => {
    if (!account) return;
    setWindowActionsLoading(true);
    try {
      // Busca SyncExecutionLog + AdsBidChangeLog + OptimizationDecision das últimas 24h
      const since24h = new Date(Date.now() - 24 * 3600000).toISOString();
      const [syncLogs, bidLogs24h, decisions24h, kickoffItems] = await Promise.all([
        base44.entities.SyncExecutionLog.filter({ amazon_account_id: account.id }, '-started_at', 50),
        base44.entities.AdsBidChangeLog.filter({ amazon_account_id: account.id }, '-created_at', 50),
        base44.entities.OptimizationDecision.filter({ amazon_account_id: account.id }, '-created_at', 30),
        base44.entities.ProductKickoffQueue.filter({ amazon_account_id: account.id }, '-scheduled_at', 30),
      ]);

      const actions = [];

      // Sync logs
      syncLogs.slice(0, 20).forEach(r => {
        actions.push({
          id: `sync-${r.id}`,
          type: 'sync',
          label: r.operation || 'Sincronização',
          status: r.status === 'success' ? 'success' : r.status === 'running' ? 'running' : 'failed',
          detail: r.records_upserted != null ? `${r.records_upserted} registros` : r.error_message || '',
          at: r.started_at || r.created_date,
          raw: r,
          canRepair: r.status === 'error' || r.status === 'failed',
          repairFn: 'syncAdsQuick',
        });
      });

      // Kickoff items
      kickoffItems.slice(0, 15).forEach(r => {
        actions.push({
          id: `kickoff-${r.id}`,
          type: 'kickoff',
          label: `Kick-off ASIN ${r.asin || r.product_name || '—'}`,
          status: r.status === 'completed' ? 'success' : r.status === 'failed' ? 'failed' : r.status === 'processing' ? 'running' : 'pending',
          detail: r.last_error || (r.mode ? `Modo: ${r.mode}` : ''),
          at: r.scheduled_at,
          raw: r,
          canRepair: r.status === 'failed',
          repairEntityId: r.id,
          repairEntity: 'ProductKickoffQueue',
          repairFn: 'processProductKickoffQueueV2',
          asin: r.asin,
          campaignId: r.campaign_id,
        });
      });

      // Bid changes
      bidLogs24h.slice(0, 15).forEach(r => {
        actions.push({
          id: `bid-${r.id}`,
          type: 'bid',
          label: `Ajuste bid · ${r.keyword || r.asin || '—'}`,
          status: r.status === 'executed' ? 'success' : r.status === 'failed' ? 'failed' : 'pending',
          detail: r.status === 'executed'
            ? `R$${(r.old_bid||0).toFixed(2)} → R$${(r.new_bid||0).toFixed(2)} (${r.direction})`
            : r.amazon_response || r.reason || '',
          at: r.created_at || r.created_date,
          raw: r,
          canRepair: r.status === 'failed',
          repairFn: 'runBidDecisionEngineV2',
        });
      });

      // Decisions
      decisions24h.slice(0, 10).forEach(r => {
        actions.push({
          id: `dec-${r.id}`,
          type: 'decision',
          label: `Decisão IA · ${r.decision_type || r.action || r.keyword_text || '—'}`,
          status: r.status === 'executed' ? 'success' : r.status === 'failed' ? 'failed' : r.status === 'pending' ? 'pending' : 'pending',
          detail: r.rationale?.slice(0, 80) || r.action || '',
          at: r.created_at,
          raw: r,
          canRepair: false,
        });
      });

      // Ordenar por data desc
      actions.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
      setWindowActions(actions);
    } catch {}
    finally { setWindowActionsLoading(false); }
  };

  const repairAction = async (action) => {
    if (!account || actionWorking) return;
    setActionWorking(action.id);
    try {
      if (action.repairEntityId && action.repairEntity) {
        await base44.entities[action.repairEntity].update(action.repairEntityId, {
          status: 'scheduled', last_error: null, attempt_count: 0, scheduled_at: new Date().toISOString(),
        });
      }
      if (action.repairFn) {
        await base44.functions.invoke(action.repairFn, { amazon_account_id: account.id, force: true });
      }
      await loadWindowActions();
    } catch {}
    finally { setActionWorking(null); }
  };

  const pauseAction = async (action, pause) => {
    if (!account || actionWorking) return;
    setActionWorking(action.id);
    try {
      if (action.type === 'kickoff' && action.repairEntityId) {
        await base44.entities.ProductKickoffQueue.update(action.repairEntityId, {
          status: pause ? 'cancelled' : 'scheduled',
          scheduled_at: new Date().toISOString(),
        });
        await loadWindowActions();
      } else if (action.type === 'sync' || action.type === 'bid') {
        // Para bids, pausar/retomar via campanha
        if (action.raw?.campaign_id) {
          await base44.functions.invoke(pause ? 'pauseCampaign' : 'checkAndEnableCampaigns', {
            amazon_account_id: account.id,
            campaign_id: action.raw.campaign_id,
          });
          await loadWindowActions();
        }
      }
    } catch {}
    finally { setActionWorking(null); }
  };

  useEffect(() => {
    if (account) loadWindowActions();
  }, [account]);

  // ── Reparo ──
  const runRepair = async () => {
    if (!account || repairRunning) return;
    setRepairRunning(true);
    setRepairMsg(null);
    try {
      const res = await base44.functions.invoke('forceRepairIncompleteCampaigns', { amazon_account_id: account.id });
      setRepairMsg(res.data?.ok ? { type: 'success', text: `✓ ${res.data.repaired || 0} campanhas reparadas` } : { type: 'error', text: res.data?.error || 'Erro' });
    } catch (e) { setRepairMsg({ type: 'error', text: e.message }); }
    finally { setRepairRunning(false); }
  };



  // ── KPIs rápidos ──
  const allQueue = [...kickoffQueue, ...repairQueue, ...keywordQueue];
  const activeAlerts = alerts.filter(a => a.status === 'active').length;
  const criticalAlerts = alerts.filter(a => a.severity === 'critical' && a.status === 'active').length;
  const queueFailed = allQueue.filter(i => i.status === 'failed').length;
  const queueProcessing = allQueue.filter(i => i.status === 'processing').length;
  const pendingDecisions = decisions.filter(d => d.status === 'pending').length;

  // ── Bid log filtrado ──
  const filteredBids = bidLogs.filter(l => {
    const matchSearch = !bidSearch || (l.keyword || '').toLowerCase().includes(bidSearch.toLowerCase()) || (l.asin || '').includes(bidSearch);
    const matchDir = bidFilter.direction === 'all' || l.direction === bidFilter.direction;
    const matchSt = bidFilter.status === 'all' || l.status === bidFilter.status;
    return matchSearch && matchDir && matchSt;
  });

  // ── Filtro alertas ──
  const filteredAlerts = alerts.filter(a => {
    if (alertFilter === 'active') return a.status === 'active';
    if (alertFilter === 'critical') return a.severity === 'critical';
    if (alertFilter === 'resolved') return a.status === 'resolved';
    return true;
  });

  // ── Fila filtrada ──
  const filteredQueue = allQueue.filter(i => {
    if (queueFilter === 'failed') return i.status === 'failed';
    if (queueFilter === 'scheduled') return i.status === 'scheduled';
    if (queueFilter === 'completed') return i.status === 'completed';
    return true;
  });

  // ── Gráfico de alterações de bid ──
  const bidTrendData = (() => {
    const map = new Map();
    for (const l of bidLogs) {
      const date = l.date || l.created_at?.slice(0, 10);
      if (!date) continue;
      const prev = map.get(date) || { date: date.slice(5), aumentos: 0, reducoes: 0 };
      if (l.direction === 'increase') prev.aumentos++;
      else if (l.direction === 'decrease') prev.reducoes++;
      map.set(date, prev);
    }
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date)).slice(-14);
  })();

  // Última sync status
  const lastSync = syncRuns[0];

  return (
    <div className="p-6 space-y-5 animate-fade-in">

      {/* Token Expired Banner */}
      {account ? <TokenExpiredBanner accountId={account.id} /> : null}

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <Terminal className="w-5 h-5 text-cyan" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Sala de Controle</h1>
            <p className="text-xs text-slate-400">
              {criticalAlerts > 0 ? <span className="text-red-400 font-semibold">{criticalAlerts} crítico{criticalAlerts > 1 ? 's' : ''} · </span> : null}
              {activeAlerts} alerta{activeAlerts !== 1 ? 's' : ''} ativos · {queueFailed} erros na fila · {pendingDecisions} decisões pendentes
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {lastSync && (
            <span className="text-[10px] text-slate-500">
              Sync: {lastSync.status === 'success' ? '✓' : '⚠'} {new Date(lastSync.started_at || lastSync.created_date).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <button onClick={loadAll} disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-xs rounded-lg transition-colors disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Atualizar
          </button>
        </div>
      </div>

      {/* Navegação consolidada: áreas principais + funções internas */}
      {(() => {
        const activeGroup = findTabGroup(tab);
        const renderBadge = (tabId) => {
          const windowFailed = windowActions.filter(a => a.status === 'failed').length;
          const kickoffFailed = kickoffQueue.filter(i => i.status === 'failed').length;
          const kickoffActive = kickoffQueue.filter(i => i.status === 'scheduled' || i.status === 'processing').length;
          const hasSyncError = syncRuns.some(r => r.status === 'error');
          return (
            <>
              {tabId === 'acoes_janela' && windowFailed > 0 ? <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded-full">{windowFailed}</span> : null}
              {tabId === 'kickoff' && kickoffFailed > 0 ? <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded-full">{kickoffFailed}</span> : null}
              {tabId === 'kickoff' && kickoffActive > 0 && kickoffFailed === 0 ? <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-violet-500/20 text-violet-400 rounded-full">{kickoffActive}</span> : null}
              {tabId === 'alertas' && activeAlerts > 0 ? <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded-full">{activeAlerts}</span> : null}
              {tabId === 'fila' && queueFailed > 0 ? <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded-full">{queueFailed}</span> : null}
              {tabId === 'pausas' ? <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-amber-500/20 text-amber-400 rounded-full"><Clock className="w-2.5 h-2.5 inline" /></span> : null}
              {tabId === 'autopilot' && pendingDecisions > 0 ? <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-amber-500/20 text-amber-400 rounded-full">{pendingDecisions}</span> : null}
              {tabId === 'sync_monitor' && hasSyncError ? <span className="ml-1.5 text-[10px] px-1.5 py-0.5 bg-red-500/20 text-red-400 rounded-full">!</span> : null}
            </>
          );
        };

        return (
          <div className="space-y-2">
            <div className="flex gap-2 overflow-x-auto scrollbar-thin pb-1" role="tablist" aria-label="Áreas da Sala de Controle">
              {TAB_GROUPS.map(group => {
                const isActive = activeGroup.id === group.id;
                const groupHasError = group.tabs.some(item => (
                  (item.id === 'alertas' && activeAlerts > 0) ||
                  (item.id === 'fila' && queueFailed > 0) ||
                  (item.id === 'sync_monitor' && syncRuns.some(r => r.status === 'error')) ||
                  (item.id === 'kickoff' && kickoffQueue.some(i => i.status === 'failed'))
                ));
                return (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => setTab(group.tabs[0].id)}
                    className={`inline-flex items-center rounded-xl border px-4 py-2 text-sm font-semibold whitespace-nowrap transition-colors ${isActive ? 'border-cyan/40 bg-cyan/15 text-cyan' : 'border-surface-3 bg-surface-1 text-slate-400 hover:text-white hover:bg-surface-2'}`}
                    aria-selected={isActive}
                  >
                    {group.label}
                    {groupHasError && <span className="ml-2 h-2 w-2 rounded-full bg-red-400" aria-label="Há itens pendentes" />}
                  </button>
                );
              })}
            </div>

            {activeGroup.tabs.length > 1 && (
              <div className="flex border-b border-surface-2 overflow-x-auto scrollbar-thin" role="tablist" aria-label={`Funções de ${activeGroup.label}`}>
                {activeGroup.tabs.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setTab(item.id)}
                    className={`px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${tab === item.id ? 'border-cyan text-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
                    aria-selected={tab === item.id}
                  >
                    {item.label}
                    {renderBadge(item.id)}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 text-cyan animate-spin" />
        </div>
      ) : (
        <>
          {/* ── VISÃO GERAL ─────────────────────────────────────────────────── */}
          {tab === 'visao_geral' && (
            <div className="space-y-5">
              {/* KPIs */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {[
                  { label: 'Alertas Ativos', value: activeAlerts, color: activeAlerts > 0 ? 'text-amber-400' : 'text-emerald-400', action: () => setTab('alertas') },
                  { label: 'Alertas Críticos', value: criticalAlerts, color: criticalAlerts > 0 ? 'text-red-400' : 'text-slate-400', action: () => setTab('alertas') },
                  { label: 'Erros na Fila', value: queueFailed, color: queueFailed > 0 ? 'text-red-400' : 'text-emerald-400', action: () => setTab('fila') },
                  { label: 'Decisões IA Pendentes', value: pendingDecisions, color: pendingDecisions > 0 ? 'text-amber-400' : 'text-emerald-400', action: () => setTab('autopilot') },
                ].map(k => (
                  <button key={k.label} onClick={k.action} className="bg-surface-1 border border-surface-2 rounded-xl p-4 text-left hover:border-surface-3 transition-colors">
                    <p className="text-xs text-slate-500 mb-1">{k.label}</p>
                    <p className={`text-2xl font-bold ${k.color}`}>{k.value}</p>
                  </button>
                ))}
              </div>

              {/* Rotinas status — exibe apenas rotinas principais, filtrando chamadas de API individuais */}
              <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
                <h3 className="text-sm font-semibold text-slate-300 mb-3">Status das Rotinas</h3>
                <div className="space-y-2">
                  {(() => {
                    const SKIP_PREFIXES = ['amazon_api:', 'amazon_ads:offline_auth', 'amazon_ads:token_manager'];
                    const filtered = syncRuns.filter(r => {
                      const op = r.operation || '';
                      return !SKIP_PREFIXES.some(p => op.startsWith(p));
                    }).slice(0, 8);
                    if (filtered.length === 0) return <p className="text-xs text-slate-500">Sem logs de rotinas</p>;
                    return filtered.map((r, i) => (
                      <div key={i} className="flex items-center justify-between text-xs py-1.5 border-b border-surface-2/50 last:border-0">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          {r.status === 'success' || r.status === 'completed' ? <CheckCircle className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" /> : r.status === 'running' || r.status === 'processing' ? <Loader2 className="w-3.5 h-3.5 text-cyan animate-spin flex-shrink-0" /> : r.status === 'warning' ? <AlertCircle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" /> : <XCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />}
                          <span className="text-slate-300 truncate">{r.operation || 'sync'}</span>
                        </div>
                        <div className="flex items-center gap-3 text-slate-500 flex-shrink-0 ml-2">
                          {(r.records_processed != null && r.records_processed > 0) ? <span>{r.records_processed} reg.</span> : null}
                          <span>{new Date(r.started_at || r.created_date).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                      </div>
                    ));
                  })()}
                </div>
              </div>

              {/* Alertas críticos no resumo */}
              {criticalAlerts > 0 && (
                <div className="rounded-xl border border-red-500/25 bg-red-500/5 p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <AlertTriangle className="w-4 h-4 text-red-400" />
                    <p className="text-sm font-semibold text-red-300">{criticalAlerts} alerta(s) crítico(s)</p>
                  </div>
                  {alerts.filter(a => a.severity === 'critical' && a.status === 'active').slice(0, 3).map(a => (
                    <div key={a.id} className="flex items-start justify-between gap-3 py-2 border-b border-red-500/10 last:border-0">
                      <div>
                        <p className="text-xs font-semibold text-white">{a.title}</p>
                        <p className="text-xs text-slate-400">{a.message}</p>
                      </div>
                      <button onClick={() => resolveAlert(a.id)} className="p-1.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-lg">
                        <Check className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  <button onClick={() => setTab('alertas')} className="mt-2 text-xs text-red-400 hover:text-red-300">Ver todos →</button>
                </div>
              )}

              {/* Gráfico bid trends */}
              {bidTrendData.length > 2 && (
                <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
                  <h3 className="text-sm font-semibold text-slate-300 mb-3">Ajustes de Bid — 14 dias</h3>
                  <ResponsiveContainer width="100%" height={150}>
                    <ReBarChart data={bidTrendData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                      <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
                      <Tooltip contentStyle={{ background: '#111318', border: '1px solid #1A1D26', borderRadius: 8, fontSize: 11 }} />
                      <Bar dataKey="aumentos" name="Aumentos" fill="#10B981" radius={[2, 2, 0, 0]} stackId="a" />
                      <Bar dataKey="reducoes" name="Reduções" fill="#EF4444" radius={[2, 2, 0, 0]} stackId="a" />
                    </ReBarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {/* Atalhos rápidos */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <button onClick={() => setTab('kickoff')} className="bg-surface-1 border border-violet-500/25 hover:border-violet-500/40 rounded-xl p-4 block text-left w-full transition-colors">
                  <p className="text-sm font-semibold text-violet-300">Kick-off de Produtos</p>
                  <p className="text-xs text-slate-500 mt-0.5">Fila e status de lançamentos</p>
                </button>
                {[
                  { label: 'Gestão de Anúncios', path: '/ads', desc: 'Campanhas, keywords, bids' },
                  { label: 'Integração Amazon', path: '/integracoes/amazon', desc: 'Token, SP-API, OAuth' },
                  { label: 'Configurações', path: '/settings', desc: 'Metas, budget, perfil' },
                ].map(s => (
                  <Link key={s.path} to={s.path} className="bg-surface-1 border border-surface-2 hover:border-surface-3 rounded-xl p-4 block transition-colors">
                    <p className="text-sm font-semibold text-white">{s.label}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{s.desc}</p>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* ── AÇÕES DA JANELA ──────────────────────────────────────────────── */}
          {tab === 'acoes_janela' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-white">Ações da Última Janela Operacional</h2>
                  <p className="text-xs text-slate-500 mt-0.5">Atividades executadas nas últimas 24h — sucesso, falha ou pendente.</p>
                </div>
                <button onClick={loadWindowActions} disabled={windowActionsLoading}
                  className="flex items-center gap-1.5 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-xs rounded-lg transition-colors disabled:opacity-50">
                  <RefreshCw className={`w-3.5 h-3.5 ${windowActionsLoading ? 'animate-spin' : ''}`} />
                  Atualizar
                </button>
              </div>

              {/* Resumo */}
              {windowActions.length > 0 ? (() => {
                const total = windowActions.length;
                const ok = windowActions.filter(a => a.status === 'success').length;
                const failed = windowActions.filter(a => a.status === 'failed').length;
                const pending = windowActions.filter(a => a.status === 'pending' || a.status === 'running').length;
                const pct = total > 0 ? Math.round(ok / total * 100) : 0;
                return (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {[
                      { label: 'Total de ações', value: total, color: 'text-white' },
                      { label: '✓ Implementadas', value: `${ok} (${pct}%)`, color: 'text-emerald-400' },
                      { label: '✗ Com falha', value: failed, color: failed > 0 ? 'text-red-400' : 'text-slate-500' },
                      { label: '⏳ Pendentes', value: pending, color: pending > 0 ? 'text-amber-400' : 'text-slate-500' },
                    ].map(k => (
                      <div key={k.label} className="bg-surface-1 border border-surface-2 rounded-xl px-4 py-3 text-center">
                        <p className="text-[10px] text-slate-500 mb-1">{k.label}</p>
                        <p className={`text-xl font-bold ${k.color}`}>{k.value}</p>
                      </div>
                    ))}
                  </div>
                );
              })() : null}

              {windowActionsLoading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="w-5 h-5 text-cyan animate-spin" />
                </div>
              ) : windowActions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-2">
                  <Activity className="w-8 h-8 text-slate-700" />
                  <p className="text-sm text-slate-500">Nenhuma ação registrada nas últimas 24h</p>
                </div>
              ) : (
                <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-surface-2 bg-surface-2/40">
                          {['Tipo', 'Ação', 'Status', 'Detalhe', 'Data/Hora', 'Ações'].map(h => (
                            <th key={h} className="px-4 py-2.5 text-left text-[10px] font-semibold text-slate-500 uppercase whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {windowActions.map(action => {
                          const isOk = action.status === 'success';
                          const isFailed = action.status === 'failed';
                          const isPending = action.status === 'pending';
                          const isRunning = action.status === 'running';
                          const isPaused = action.raw?.status === 'cancelled';
                          const isWorking = actionWorking === action.id;

                          const typeColors = {
                            sync: 'text-cyan bg-cyan/10 border-cyan/20',
                            kickoff: 'text-violet-400 bg-violet-500/10 border-violet-500/20',
                            bid: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
                            decision: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
                          };
                          const typeLabels = { sync: 'Sync', kickoff: 'Kick-off', bid: 'Bid', decision: 'Decisão IA' };

                          return (
                            <tr key={action.id} className={`border-b border-surface-2/40 transition-colors ${isFailed ? 'bg-red-500/3 hover:bg-red-500/6' : 'hover:bg-surface-2/30'}`}>
                              <td className="px-4 py-3">
                                <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${typeColors[action.type] || 'text-slate-400 bg-slate-500/10 border-slate-500/20'}`}>
                                  {typeLabels[action.type] || action.type}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-xs text-white font-medium max-w-[200px] truncate">{action.label}</td>
                              <td className="px-4 py-3">
                                {isRunning ? (
                                  <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border bg-cyan/10 border-cyan/20 text-cyan font-bold">
                                    <Loader2 className="w-2.5 h-2.5 animate-spin" /> Rodando
                                  </span>
                                ) : isOk ? (
                                  <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border bg-emerald-500/10 border-emerald-500/20 text-emerald-400 font-bold">
                                    <CheckCircle className="w-2.5 h-2.5" /> Sucesso
                                  </span>
                                ) : isFailed ? (
                                  <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border bg-red-500/10 border-red-500/20 text-red-400 font-bold">
                                    <XCircle className="w-2.5 h-2.5" /> Falhou
                                  </span>
                                ) : isPaused ? (
                                  <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border bg-slate-500/10 border-slate-500/20 text-slate-400 font-bold">
                                    <Pause className="w-2.5 h-2.5" /> Pausado
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border bg-amber-500/10 border-amber-500/20 text-amber-400 font-bold">
                                    <Clock className="w-2.5 h-2.5" /> Pendente
                                  </span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-[10px] text-slate-500 max-w-[200px] truncate">{action.detail || '—'}</td>
                              <td className="px-4 py-3 text-[10px] text-slate-500 whitespace-nowrap">
                                {action.at ? new Date(action.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-1.5">
                                  {/* Reparar — só para falhas */}
                                  {isFailed && action.canRepair && (
                                    <button
                                      onClick={() => repairAction(action)}
                                      disabled={!!isWorking}
                                      title="Reparar"
                                      className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25 rounded-lg transition-colors disabled:opacity-50"
                                    >
                                      {isWorking ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wrench className="w-3 h-3" />}
                                      Reparar
                                    </button>
                                  )}
                                  {/* Pausar/Despausar — para kickoffs agendados/pausados */}
                                  {action.type === 'kickoff' && (isPending || isPaused) && (
                                    isPaused ? (
                                      <button
                                        onClick={() => pauseAction(action, false)}
                                        disabled={!!isWorking}
                                        title="Despausar"
                                        className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25 rounded-lg transition-colors disabled:opacity-50"
                                      >
                                        {isWorking ? <Loader2 className="w-3 h-3 animate-spin" /> : <PlayCircle className="w-3 h-3" />}
                                        Despausar
                                      </button>
                                    ) : (
                                      <button
                                        onClick={() => pauseAction(action, true)}
                                        disabled={!!isWorking}
                                        title="Pausar"
                                        className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold bg-slate-500/15 border border-slate-500/30 text-slate-400 hover:bg-slate-500/25 rounded-lg transition-colors disabled:opacity-50"
                                      >
                                        {isWorking ? <Loader2 className="w-3 h-3 animate-spin" /> : <Pause className="w-3 h-3" />}
                                        Pausar
                                      </button>
                                    )
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── ORÇAMENTO DIÁRIO ────────────────────────────────────────────── */}
          {tab === 'orcamento' && (
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-bold text-white">Controle de Gasto Diário</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Teto definido pelo usuário · Budgets das campanhas · Pacing · Pausa e retomada operacional
                </p>
              </div>
              <BudgetSpendControlPanel account={account} />
            </div>
          )}

          {/* ── PRELEÇÃO SEMANAL ─────────────────────────────────────────────── */}
          {tab === 'prelecao' && <PrelecaoTab account={account} />}

          {/* ── MOTOR DE ESTRATÉGIAS ─────────────────────────────────────────── */}
          {tab === 'estrategias' && <EstrategiasTab account={account} />}

          {/* ── KICK-OFF ─────────────────────────────────────────────────────── */}
          {tab === 'kickoff' && (
            <div className="space-y-4">
              {/* KPIs */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: 'Agendados',   value: kickoffQueue.filter(i => i.status === 'scheduled').length,  color: 'text-cyan' },
                  { label: 'Processando', value: kickoffQueue.filter(i => i.status === 'processing').length, color: 'text-amber-400' },
                  { label: 'Concluídos',  value: kickoffQueue.filter(i => i.status === 'completed').length,  color: 'text-emerald-400' },
                  { label: 'Com Erro',    value: kickoffQueue.filter(i => i.status === 'failed').length,     color: 'text-red-400' },
                ].map(k => (
                  <div key={k.label} className="bg-surface-1 border border-surface-2 rounded-xl px-4 py-3 text-center">
                    <p className="text-xs text-slate-500 mb-1">{k.label}</p>
                    <p className={`text-2xl font-bold ${k.color}`}>{k.value}</p>
                  </div>
                ))}
              </div>

              {/* Automações ativas */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {/* Executar Fila — coberta pelo pipeline horário */}
                <div className="flex items-start gap-3 p-3 bg-surface-1 border border-violet-500/20 rounded-xl">
                  <div className="w-7 h-7 rounded-lg bg-violet-500/15 border border-violet-500/25 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Zap className="w-3.5 h-3.5 text-violet-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-violet-300">Fila de Kick-off</p>
                    <p className="text-[10px] text-slate-500 mt-0.5">Automação: Pipeline agressivo — executa a cada hora automaticamente</p>
                  </div>
                  <button
                    onClick={() => runQueueNow('kickoff', 'processProductKickoffQueueV2')}
                    disabled={running.kickoff || !account || kickoffQueue.filter(i => i.status === 'scheduled').length === 0}
                    title="Forçar execução agora"
                    className="flex items-center gap-1 px-2 py-1 bg-violet-500/15 border border-violet-500/30 text-violet-300 hover:bg-violet-500/25 text-[10px] font-semibold rounded-lg disabled:opacity-40 transition-colors flex-shrink-0"
                  >
                    {running.kickoff ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                    Forçar
                  </button>
                </div>

                {/* Limpar Concluídos — ação local sem automação */}
                <div className="flex items-start gap-3 p-3 bg-surface-1 border border-surface-2 rounded-xl">
                  <div className="w-7 h-7 rounded-lg bg-slate-500/15 border border-slate-500/25 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Trash2 className="w-3.5 h-3.5 text-slate-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-slate-300">Limpar Registros</p>
                    <p className="text-[10px] text-slate-500 mt-0.5">Remove itens concluídos, cancelados e com erro da fila local</p>
                  </div>
                  <button
                    onClick={() => clearDone('ProductKickoffQueue', kickoffQueue)}
                    disabled={kickoffQueue.filter(i => ['completed', 'failed', 'cancelled'].includes(i.status)).length === 0}
                    className="flex items-center gap-1 px-2 py-1 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white text-[10px] rounded-lg disabled:opacity-40 transition-colors flex-shrink-0"
                  >
                    <Trash2 className="w-3 h-3" />
                    Limpar
                  </button>
                </div>

                {/* Reparar Campanhas AUTO — execução manual */}
                <div className="flex items-start gap-3 p-3 bg-surface-1 border border-amber-500/20 rounded-xl">
                  <div className="w-7 h-7 rounded-lg bg-amber-500/15 border border-amber-500/25 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Wrench className="w-3.5 h-3.5 text-amber-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-amber-300">Reparar Campanhas AUTO</p>
                    <p className="text-[10px] text-slate-500 mt-0.5">Repara campanhas incompletas (sem ad group ou product ads)</p>
                  </div>
                  <button
                    onClick={() => runRepair()}
                    disabled={repairRunning || !account}
                    className="flex items-center gap-1 px-2 py-1 bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25 text-[10px] font-semibold rounded-lg disabled:opacity-40 transition-colors flex-shrink-0"
                  >
                    {repairRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wrench className="w-3 h-3" />}
                    {repairRunning ? '...' : 'Reparar'}
                  </button>
                </div>
              </div>

              {repairMsg && (
                <div className={`px-4 py-3 rounded-xl border text-sm font-medium ${repairMsg.type === 'success' ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' : 'bg-red-400/10 border-red-400/20 text-red-400'}`}>
                  {repairMsg.text}
                </div>
              )}

              {/* Painel de Kick-off integrado */}
              {account && (
                <div className="rounded-xl border border-violet-500/20 bg-[#0f0d1a] overflow-hidden">
                  <KickoffControlPanel
                    accountId={account.id}
                    onRetry={async (item) => {
                      await base44.entities.ProductKickoffQueue.update(item.id, {
                        status: 'scheduled',
                        last_error: null,
                        attempt_count: 0,
                        scheduled_at: new Date().toISOString(),
                      });
                      loadAll();
                    }}
                  />
                </div>
              )}

              {/* Link para produtos */}
              <div className="flex items-center gap-3 p-4 bg-surface-1 border border-surface-2 rounded-xl">
                <Rocket className="w-4 h-4 text-violet-400 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-white">Iniciar novo Kick-off</p>
                  <p className="text-xs text-slate-400 mt-0.5">Selecione um produto sem campanha e inicie o processo de lançamento.</p>
                </div>
                <a href="/products" onClick={e => { e.preventDefault(); window.location.href = '/products'; }}
                  className="flex items-center gap-1.5 px-4 py-2 bg-violet-500/15 border border-violet-500/30 text-violet-300 text-xs font-semibold rounded-lg hover:bg-violet-500/25 whitespace-nowrap transition-colors">
                  Ir para Produtos
                </a>
              </div>
            </div>
          )}

          {/* ── ALERTAS ─────────────────────────────────────────────────────── */}
          {tab === 'alertas' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="grid grid-cols-3 gap-3 flex-1 max-w-sm">
                  {[
                    { label: 'Ativos', value: alerts.filter(a => a.status === 'active').length, color: 'text-amber-400' },
                    { label: 'Críticos', value: criticalAlerts, color: 'text-red-400' },
                    { label: 'Total', value: alerts.length, color: 'text-slate-300' },
                  ].map(k => (
                    <div key={k.label} className="bg-surface-1 border border-surface-2 rounded-xl p-3 text-center">
                      <p className="text-[10px] text-slate-500">{k.label}</p>
                      <p className={`text-xl font-bold ${k.color}`}>{k.value}</p>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={generateAlerts} disabled={generating || !account}
                    className="flex items-center gap-2 px-3 py-2 bg-cyan/10 border border-cyan/20 text-cyan hover:bg-cyan/20 text-xs font-semibold rounded-lg disabled:opacity-50">
                    {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                    {generating ? 'Gerando...' : 'Gerar Alertas'}
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-1.5">
                <Filter className="w-3.5 h-3.5 text-slate-500" />
                {[
                  { key: 'active', label: 'Ativos' },
                  { key: 'critical', label: 'Críticos' },
                  { key: 'all', label: 'Todos' },
                  { key: 'resolved', label: 'Resolvidos' },
                ].map(f => (
                  <button key={f.key} onClick={() => setAlertFilter(f.key)}
                    className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${alertFilter === f.key ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'}`}>
                    {f.label}
                  </button>
                ))}
              </div>

              {filteredAlerts.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-2">
                  <Bell className="w-10 h-10 text-slate-700" />
                  <p className="text-sm text-slate-500">Sem alertas com este filtro</p>
                </div>
              ) : (
                <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-surface-2 bg-surface-2/40">
                          {['Tipo', 'Severidade', 'Título', 'Mensagem', 'Status', 'Data', 'Ações'].map(h => (
                            <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {filteredAlerts.map(a => {
                          const cfg = ALERT_CONFIG[a.alert_type] || { color: 'text-slate-400', bg: 'bg-slate-500/10 border-slate-500/20', label: a.alert_type };
                          const isResolved = a.status === 'resolved';
                          return (
                            <tr key={a.id} className={`border-b border-surface-2/40 hover:bg-surface-2/30 transition-colors ${isResolved ? 'opacity-50' : ''}`}>
                              <td className="px-4 py-3">
                                <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${cfg.bg} ${cfg.color}`}>{cfg.label}</span>
                              </td>
                              <td className="px-4 py-3">
                                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${a.severity === 'critical' ? 'bg-red-500/20 text-red-400' : a.severity === 'high' ? 'bg-amber-500/20 text-amber-400' : 'bg-slate-500/20 text-slate-400'}`}>
                                  {a.severity || 'medium'}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-xs font-semibold text-white max-w-[180px] truncate">{a.title}</td>
                              <td className="px-4 py-3 text-xs text-slate-400 max-w-[200px] truncate">{a.message || '—'}</td>
                              <td className="px-4 py-3">
                                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${a.status === 'active' ? 'bg-amber-500/20 text-amber-400' : a.status === 'acknowledged' ? 'bg-blue-500/20 text-blue-400' : 'bg-emerald-500/20 text-emerald-400'}`}>
                                  {a.status || 'active'}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                                {a.created_at ? new Date(a.created_at).toLocaleDateString('pt-BR') : '—'}
                              </td>
                              <td className="px-4 py-3">
                                {!isResolved && (
                                  <div className="flex items-center gap-1.5">
                                    {a.status === 'active' && (
                                      <button onClick={() => acknowledgeAlert(a.id)} className="p-1.5 bg-blue-500/10 border border-blue-500/20 text-blue-400 rounded-lg" title="Reconhecer">
                                        <Eye className="w-3.5 h-3.5" />
                                      </button>
                                    )}
                                    <button onClick={() => resolveAlert(a.id)} className="p-1.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-lg" title="Resolver">
                                      <Check className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── FILA E EXECUÇÕES ─────────────────────────────────────────────── */}
          {tab === 'fila' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: 'Processando', value: queueProcessing, color: 'text-cyan' },
                  { label: 'Agendados',   value: allQueue.filter(i => i.status === 'scheduled').length, color: 'text-slate-300' },
                  { label: 'Concluídos',  value: allQueue.filter(i => i.status === 'completed').length, color: 'text-emerald-400' },
                  { label: 'Com Erro',    value: queueFailed, color: 'text-red-400' },
                ].map(k => (
                  <div key={k.label} className="bg-surface-1 border border-surface-2 rounded-xl px-4 py-3 text-center">
                    <p className="text-xs text-slate-500 mb-1">{k.label}</p>
                    <p className={`text-2xl font-bold ${k.color}`}>{k.value}</p>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <Filter className="w-3.5 h-3.5 text-slate-500" />
                {[{ key: 'all', l: 'Todos' }, { key: 'failed', l: 'Erros' }, { key: 'scheduled', l: 'Agendados' }, { key: 'completed', l: 'Concluídos' }].map(f => (
                  <button key={f.key} onClick={() => setQueueFilter(f.key)}
                    className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${queueFilter === f.key ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'}`}>
                    {f.l}
                  </button>
                ))}
              </div>

              {[
                { key: 'kickoff', title: 'Kickoff de Produtos', items: kickoffQueue, entity: 'ProductKickoffQueue', fn: 'processProductKickoffQueueV2' },
                { key: 'repair',  title: 'Reparo AUTO',         items: repairQueue,  entity: 'AutoCampaignRepairQueue', fn: 'processAutoCampaignRepairQueueV2' },
                { key: 'keyword', title: 'Reparo Keywords',     items: keywordQueue, entity: 'KeywordRepairQueue', fn: 'processKeywordRepairQueue' },
              ].map(q => {
                const qFiltered = q.items.filter(i => queueFilter === 'all' || i.status === queueFilter);
                const qFailed = q.items.filter(i => i.status === 'failed').length;
                const qScheduled = q.items.filter(i => i.status === 'scheduled').length;
                return (
                  <div key={q.key} className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
                    <div className="px-5 py-3 border-b border-surface-2 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-white">{q.title}</p>
                        <p className="text-[10px] text-slate-500 mt-0.5">
                          {qScheduled > 0 ? <span className="text-amber-400">{qScheduled} ag. </span> : null}
                          {qFailed > 0 ? <span className="text-red-400">{qFailed} erro{qFailed !== 1 ? 's' : ''} </span> : null}
                          {q.items.filter(i => i.status === 'completed').length} ok
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {q.items.filter(i => ['completed', 'failed'].includes(i.status)).length > 0 && (
                          <button onClick={() => clearDone(q.entity, q.items)} className="text-[10px] text-slate-500 hover:text-slate-300 px-2 py-1 border border-surface-3 rounded-lg">
                            Limpar
                          </button>
                        )}
                        <button onClick={() => runQueueNow(q.key, q.fn)} disabled={running[q.key] || qScheduled === 0}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-cyan/15 border border-cyan/30 text-cyan hover:bg-cyan/25 rounded-lg disabled:opacity-40 font-semibold">
                          {running[q.key] ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                          {running[q.key] ? 'Executando...' : 'Executar Agora'}
                        </button>
                      </div>
                    </div>
                    {qFiltered.length === 0 ? (
                      <div className="py-8 text-center text-sm text-slate-500">Fila vazia</div>
                    ) : (
                      <div className="max-h-72 overflow-y-auto scrollbar-thin">
                        {qFiltered.filter(i => i.status === 'failed').map(i => (
                          <QueueRowItem key={i.id} item={i} onDelete={id => deleteQueueItem(q.entity, id)} onRetry={item => retryQueueItem(item, q.entity, q.fn)} retrying={retrying} />
                        ))}
                        {qFiltered.filter(i => i.status !== 'failed').map(i => (
                          <QueueRowItem key={i.id} item={i} onDelete={id => deleteQueueItem(q.entity, id)} onRetry={item => retryQueueItem(item, q.entity, q.fn)} retrying={retrying} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ── PAUSAS PENDENTES ────────────────────────────────────────────── */}
          {tab === 'pausas' && account && (
            <PauseQueuePanel accountId={account.id} />
          )}

          {/* ── HISTÓRICO E DECISÕES ─────────────────────────────────────────── */}
          {tab === 'historico' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: 'Alterações', value: bidLogs.length, color: 'text-white' },
                    { label: 'Aumentos', value: bidLogs.filter(l => l.direction === 'increase').length, color: 'text-emerald-400' },
                    { label: 'Reduções', value: bidLogs.filter(l => l.direction === 'decrease').length, color: 'text-red-400' },
                  ].map(k => (
                    <div key={k.label} className="bg-surface-1 border border-surface-2 rounded-xl p-3 text-center">
                      <p className="text-[10px] text-slate-500">{k.label}</p>
                      <p className={`text-xl font-bold ${k.color}`}>{k.value}</p>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={syncBids} disabled={syncing || !account}
                    className="flex items-center gap-2 px-3 py-2 bg-cyan/10 border border-cyan/20 text-cyan text-xs font-semibold rounded-lg disabled:opacity-50">
                    <Download className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
                    {syncing ? 'Sincronizando...' : 'Sync Bids'}
                  </button>
                  <button onClick={runBidEngines} disabled={runningBidEngine || !account}
                    className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-semibold rounded-lg disabled:opacity-50">
                    {runningBidEngine ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                    {runningBidEngine ? 'Executando...' : 'Executar Bid Engines'}
                  </button>
                </div>
              </div>

              {syncMsg && (
                <div className={`px-4 py-2 rounded-xl border text-xs ${syncMsg.type === 'success' ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' : 'bg-red-400/10 border-red-400/20 text-red-400'}`}>
                  {syncMsg.text}
                </div>
              )}

              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
                  <input value={bidSearch} onChange={e => setBidSearch(e.target.value)}
                    placeholder="Keyword, ASIN..."
                    className="pl-9 pr-4 py-2 bg-surface-1 border border-surface-2 rounded-lg text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50 w-48" />
                </div>
                {[{ key: 'all', l: 'Todos' }, { key: 'increase', l: '↑ Aumentos' }, { key: 'decrease', l: '↓ Reduções' }].map(f => (
                  <button key={f.key} onClick={() => setBidFilter(p => ({ ...p, direction: f.key }))}
                    className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${bidFilter.direction === f.key ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'}`}>
                    {f.l}
                  </button>
                ))}
                {[{ key: 'all', l: 'Todos status' }, { key: 'executed', l: '✓ Executadas' }, { key: 'failed', l: '⚠ Falhas' }].map(f => (
                  <button key={f.key} onClick={() => setBidFilter(p => ({ ...p, status: f.key }))}
                    className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${bidFilter.status === f.key ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'}`}>
                    {f.l}
                  </button>
                ))}
              </div>

              {/* Decisões IA pendentes */}
              {decisions.filter(d => d.status === 'pending').length > 0 ? (
                <div className="bg-surface-1 border border-amber-500/20 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-sm font-semibold text-amber-300">{decisions.filter(d => d.status === 'pending').length} Decisões IA Pendentes</p>
                    <Link to="/autopilot" className="text-xs text-cyan hover:underline">Ver no Autopilot →</Link>
                  </div>
                  {decisions.filter(d => d.status === 'pending').slice(0, 3).map(d => (
                    <div key={d.id} className="flex items-center justify-between py-1.5 border-b border-surface-2/50 last:border-0 text-xs">
                      <span className="text-slate-300">{d.keyword_text || d.action || d.decision_type}</span>
                      <span className="text-amber-400">{d.risk || 'medium'} risk</span>
                    </div>
                  ))}
                </div>
              ) : null}

              {/* Tabela bid logs */}
              <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-surface-2 bg-surface-2/40">
                        {['Data', 'Keyword', 'ASIN', 'Antes', 'Depois', 'Direção', 'Motivo', 'Fonte', 'Status'].map(h => (
                          <th key={h} className="px-4 py-2.5 text-left font-semibold text-slate-500 uppercase whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredBids.slice(0, 100).map((l, i) => {
                        const isAu = l.direction === 'increase';
                        const isDown = l.direction === 'decrease';
                        return (
                          <tr key={l.id || i} className="border-b border-surface-2/40 hover:bg-surface-2/30 transition-colors">
                            <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap">{l.date || l.created_at?.slice(0, 10) || '—'}</td>
                            <td className="px-4 py-2.5 text-white max-w-[160px] truncate">{l.keyword || '—'}</td>
                            <td className="px-4 py-2.5 font-mono text-cyan">{l.asin || '—'}</td>
                            <td className="px-4 py-2.5 font-mono text-slate-400">R${(l.old_bid || 0).toFixed(2)}</td>
                            <td className="px-4 py-2.5 font-mono text-white">R${(l.new_bid || 0).toFixed(2)}</td>
                            <td className="px-4 py-2.5">
                              {isAu ? <TrendingUp className="w-3.5 h-3.5 text-emerald-400" /> : isDown ? <TrendingDown className="w-3.5 h-3.5 text-red-400" /> : <Minus className="w-3.5 h-3.5 text-slate-500" />}
                            </td>
                            <td className="px-4 py-2.5 text-slate-500 max-w-[160px] truncate">{l.reason || '—'}</td>
                            <td className="px-4 py-2.5">
                              <span className={`text-[9px] px-1.5 py-0.5 rounded border font-medium ${l._source === 'autopilot' ? 'text-purple-400 bg-purple-400/10 border-purple-400/20' : 'text-cyan bg-cyan/10 border-cyan/20'}`}>
                                {l._source === 'autopilot' ? 'IA' : 'API'}
                              </span>
                            </td>
                            <td className="px-4 py-2.5"><StatusBadge status={l.status || 'pending'} size="xs" /></td>
                          </tr>
                        );
                      })}
                      {filteredBids.length === 0 && (
                        <tr><td colSpan={9} className="px-4 py-10 text-center text-slate-500">Sem alterações com este filtro</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ── AUTOMAÇÃO IA ──────────────────────────────────────────────────── */}
          {tab === 'autopilot' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-4 bg-surface-1 border border-cyan/20 rounded-xl">
                <Bot className="w-5 h-5 text-cyan flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-white">Motor de Automação IA</p>
                  <p className="text-xs text-slate-400 mt-0.5">O Autopilot completo com decisões, jornada AUTO, harvest e regras está na página dedicada.</p>
                </div>
                <Link to="/autopilot" className="flex items-center gap-1.5 px-4 py-2 bg-cyan/15 border border-cyan/30 text-cyan text-xs font-semibold rounded-lg hover:bg-cyan/25 whitespace-nowrap">
                  Abrir Autopilot
                </Link>
              </div>

              {/* Decisões pendentes */}
              <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
                <div className="px-5 py-3 border-b border-surface-2 flex items-center justify-between">
                  <p className="text-sm font-semibold text-white">Decisões Pendentes ({decisions.filter(d => d.status === 'pending').length})</p>
                  <Link to="/autopilot" className="text-xs text-cyan hover:underline">Gerenciar no Autopilot →</Link>
                </div>
                {decisions.filter(d => d.status === 'pending').length === 0 ? (
                  <div className="py-10 text-center text-sm text-slate-500">Nenhuma decisão pendente</div>
                ) : (
                  <div className="divide-y divide-surface-2/50 max-h-80 overflow-y-auto scrollbar-thin">
                    {decisions.filter(d => d.status === 'pending').map(d => (
                      <div key={d.id} className="px-5 py-3 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-white truncate">{d.keyword_text || d.entity_name || d.decision_type || '—'}</p>
                          <p className="text-[10px] text-slate-500 mt-0.5 truncate">{d.rationale?.slice(0, 80) || d.action}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {d.risk && <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${d.risk === 'high' ? 'text-red-400 border-red-400/20 bg-red-400/10' : d.risk === 'medium' ? 'text-amber-400 border-amber-400/20 bg-amber-400/10' : 'text-emerald-400 border-emerald-400/20 bg-emerald-400/10'}`}>{d.risk}</span>}
                          <span className="text-[10px] text-slate-500">{d.created_at ? new Date(d.created_at).toLocaleDateString('pt-BR') : ''}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Palavras-chave alta conversão */}
              <div className="flex items-center gap-3 p-4 bg-surface-1 border border-surface-2 rounded-xl">
                <div className="flex-1">
                  <p className="text-sm font-semibold text-white">Palavras-chave de Alta Conversão</p>
                  <p className="text-xs text-slate-400 mt-0.5">ML pipeline + Term Bank integrados no Banco de Termos.</p>
                </div>
                <Link to="/term-bank" className="flex items-center gap-1.5 px-4 py-2 bg-surface-2 border border-surface-3 text-slate-300 text-xs font-semibold rounded-lg hover:text-white whitespace-nowrap">
                  Abrir Term Bank
                </Link>
              </div>

              {/* Metas de performance */}
              <div className="flex items-center gap-3 p-4 bg-surface-1 border border-surface-2 rounded-xl">
                <Settings className="w-4 h-4 text-slate-400 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-white">Metas de Performance</p>
                  <p className="text-xs text-slate-400 mt-0.5">ACoS, ROAS, CPC, budget — fonte única em Configurações.</p>
                </div>
                <Link to="/settings" className="flex items-center gap-1.5 px-4 py-2 bg-surface-2 border border-surface-3 text-slate-300 text-xs font-semibold rounded-lg hover:text-white whitespace-nowrap">
                  Configurações
                </Link>
              </div>
            </div>
          )}

          {/* ── MOTOR V8 ─────────────────────────────────────────────────────── */}
          {tab === 'motor_v8' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center">
                  <Zap className="w-5 h-5 text-emerald-400" />
                </div>
                <div>
                  <h2 className="text-base font-bold text-white">Motor v8 — Execução Imediata</h2>
                  <p className="text-xs text-slate-400 mt-0.5">Pipeline completo: sync → motor determinístico → análise IA → execução Amazon Ads</p>
                </div>
              </div>
              <MotorExecutionPanel account={account} />
            </div>
          )}

          {/* ── MONITOR DE SYNC ──────────────────────────────────────────────── */}
          {tab === 'sync_monitor' && account && (
            <SyncFailureMonitor amazonAccountId={account.id} />
          )}

          {/* ── BIDS & KEYWORDS ──────────────────────────────────────────────── */}
          {tab === 'bids_keywords' && (
            <KeywordBidChangesPanel account={account} />
          )}

          {/* ── CICLO DE BIDS MANUAIS ─────────────────────────────────────────── */}
          {tab === 'bid_lifecycle' && account && (
            <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
              <ManualBidLifecyclePanel amazonAccountId={account.id} />
            </div>
          )}

          {/* ── BACKUP ───────────────────────────────────────────────────────── */}
          {tab === 'backup' && <BackupPanel />}

          {/* ── REATIVAÇÕES AUTOMÁTICAS ─────────────────────────────────────── */}
          {tab === 'reativacoes' && account && (
            <ReactivationLogPanel accountId={account.id} />
          )}

          {/* ── REPARO ───────────────────────────────────────────────────────── */}
          {tab === 'reparo' && (
            <div className="space-y-4">
              {/* Guardrails e Auditoria de Causa Raiz */}
              <GuardrailStatusPanel account={account} />

              <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 space-y-4">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-white">Reparo de Campanhas Incompletas</h3>
                    <p className="text-xs text-slate-400 mt-0.5">Verifica e repara campanhas AUTO sem ad groups ou product ads.</p>
                  </div>
                  <button onClick={runRepair} disabled={repairRunning || !account}
                    className="flex items-center gap-2 px-4 py-2 bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25 text-sm font-semibold rounded-lg disabled:opacity-50">
                    {repairRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wrench className="w-4 h-4" />}
                    {repairRunning ? 'Reparando...' : 'Executar Reparo'}
                  </button>
                </div>
                {repairMsg && (
                  <div className={`px-4 py-3 rounded-xl border text-sm font-medium ${repairMsg.type === 'success' ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' : 'bg-red-400/10 border-red-400/20 text-red-400'}`}>
                    {repairMsg.text}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-3 p-4 bg-surface-1 border border-surface-2 rounded-xl">
                <div className="flex-1">
                  <p className="text-sm font-semibold text-white">Campanhas Incompletas — Visão detalhada</p>
                  <p className="text-xs text-slate-400 mt-0.5">Lista completa com ações individuais de reparo.</p>
                </div>
                <Link to="/incomplete-campaigns" className="flex items-center gap-1.5 px-4 py-2 bg-surface-2 border border-surface-3 text-slate-300 text-xs font-semibold rounded-lg hover:text-white whitespace-nowrap">
                  Ver detalhes
                </Link>
              </div>

              <div className="flex items-center gap-3 p-4 bg-surface-1 border border-surface-2 rounded-xl">
                <div className="flex-1">
                  <p className="text-sm font-semibold text-white">Diagnóstico de Sistema</p>
                  <p className="text-xs text-slate-400 mt-0.5">Verificação de token, SP-API, campanhas e health geral.</p>
                </div>
                <Link to="/diagnostico" className="flex items-center gap-1.5 px-4 py-2 bg-surface-2 border border-surface-3 text-slate-300 text-xs font-semibold rounded-lg hover:text-white whitespace-nowrap">
                  Diagnóstico
                </Link>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}