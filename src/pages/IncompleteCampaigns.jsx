import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  AlertTriangle, RefreshCw, Loader2, Wrench, CheckCircle,
  XCircle, Play, ShieldAlert, Clock, ChevronDown, ChevronRight,
  Zap, Sparkles, Info, Filter, RotateCcw, ExternalLink,
  Package, CalendarDays, AlertCircle
} from 'lucide-react';
import { Link } from 'react-router-dom';

// ── Utilitários ───────────────────────────────────────────────────────────────

function age(dateStr) {
  if (!dateStr) return null;
  const days = Math.floor((Date.now() - new Date(dateStr)) / 86400000);
  if (days === 0) return 'hoje';
  if (days === 1) return '1d';
  return `${days}d`;
}

function dateLabel(dateStr) {
  if (!dateStr) return 'Data desconhecida';
  const d = new Date(dateStr);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function IssueTag({ label, color }) {
  const colors = {
    red: 'bg-red-500/10 border-red-500/20 text-red-400',
    amber: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
    blue: 'bg-blue-500/10 border-blue-500/20 text-blue-400',
  };
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold rounded border ${colors[color] || colors.amber}`}>
      {label}
    </span>
  );
}

function getIssues(campaign, kwCount) {
  const state = String(campaign.state || campaign.status || '').toLowerCase();
  const isManual = (campaign.targeting_type || '').toUpperCase() === 'MANUAL';
  const issues = [];
  if (state === 'incomplete') issues.push({ label: 'INCOMPLETA', color: 'red', detail: 'Campanha INCOMPLETE na Amazon — faltam AdGroups ou ProductAds.' });
  if (isManual && kwCount === 0) issues.push({ label: 'SEM KEYWORDS', color: 'red', detail: 'Campanha MANUAL sem keywords — não está segmentando tráfego.' });
  if (!campaign.asin) issues.push({ label: 'SEM ASIN', color: 'amber', detail: 'Sem ASIN associado — não é possível vincular ao produto.' });
  if (campaign.api_missing) issues.push({ label: 'AUSENTE NA API', color: 'red', detail: 'Campanha não encontrada na Amazon Ads API.' });
  if (campaign.reconciliation_status === 'review_required') issues.push({ label: 'REVISAR', color: 'amber', detail: campaign.reconciliation_notes || 'Requer revisão de reconciliação.' });
  return issues;
}

// ── Linha de Campanha ──────────────────────────────────────────────────────

function CampaignRow({ campaign, keywords, result, repairing, onRepair, repairLog }) {
  const [expanded, setExpanded] = useState(false);
  const kwCount = keywords.filter(k => k.campaign_id === campaign.campaign_id).length;
  const isAuto = (campaign.targeting_type || '').toUpperCase() === 'AUTO';
  const state = String(campaign.state || campaign.status || '').toLowerCase();
  const issues = getIssues(campaign, kwCount);
  const isRepairing = repairing === campaign.id;
  const isDone = result?.ok === true;
  const hasFailed = result?.ok === false;

  return (
    <div className={`border rounded-xl overflow-hidden transition-colors ${isDone ? 'border-emerald-500/30 bg-emerald-500/3' : hasFailed ? 'border-red-500/30' : 'border-surface-3'}`}>
      <div
        className="flex items-center gap-3 px-4 py-3 bg-surface-2 cursor-pointer hover:bg-surface-3 transition-colors select-none"
        onClick={() => setExpanded(v => !v)}
      >
        <div className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center bg-surface-3">
          {isAuto
            ? <Zap className="w-3.5 h-3.5 text-amber-400" />
            : <Sparkles className="w-3.5 h-3.5 text-cyan" />}
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-white truncate">{campaign.name || campaign.campaign_name || '—'}</p>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span className="text-[10px] text-slate-500">{isAuto ? 'AUTO' : 'MANUAL'}</span>
            {campaign.daily_budget > 0 && <span className="text-[10px] text-slate-500">R${(campaign.daily_budget).toFixed(0)}/dia</span>}
            {campaign.spend > 0 && <span className="text-[10px] text-emerald-400">gasto R${(campaign.spend).toFixed(2)}</span>}
          </div>
        </div>

        <div className="hidden sm:flex items-center gap-1 flex-wrap flex-shrink-0">
          {issues.map((issue, i) => <IssueTag key={i} label={issue.label} color={issue.color} />)}
        </div>

        {isRepairing && <Loader2 className="w-3.5 h-3.5 text-cyan animate-spin flex-shrink-0" />}
        {isDone && !isRepairing && <CheckCircle className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />}
        {hasFailed && !isRepairing && <XCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />}

        <button
          onClick={e => { e.stopPropagation(); onRepair(campaign); }}
          disabled={isRepairing || isDone || !!repairing}
          className={`flex-shrink-0 flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg border transition-colors disabled:opacity-40 ${
            isDone
              ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
              : 'bg-cyan/10 border-cyan/30 text-cyan hover:bg-cyan/20'
          }`}
        >
          {isDone ? <CheckCircle className="w-3 h-3" /> : isRepairing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wrench className="w-3 h-3" />}
          {isDone ? 'OK' : isRepairing ? '...' : 'Reparar'}
        </button>

        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />}
      </div>

      {expanded && (
        <div className="px-4 py-3 bg-surface-1 border-t border-surface-3 space-y-3 text-xs">
          <div className="flex sm:hidden items-center gap-1 flex-wrap">
            {issues.map((issue, i) => <IssueTag key={i} label={issue.label} color={issue.color} />)}
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {[
              { label: 'Spend', value: `R$${(campaign.spend || 0).toFixed(2)}` },
              { label: 'Vendas', value: `R$${(campaign.sales || 0).toFixed(2)}` },
              { label: 'ACoS', value: campaign.acos > 0 ? `${campaign.acos.toFixed(1)}%` : '—' },
              { label: 'Keywords', value: kwCount, highlight: kwCount === 0 ? 'red' : 'green' },
              { label: 'Estado', value: state },
              { label: 'Criado', value: age(campaign.created_date) || '—' },
            ].map(m => (
              <div key={m.label} className="bg-surface-2 rounded-lg p-2">
                <p className="text-[9px] text-slate-500 mb-0.5">{m.label}</p>
                <p className={`font-semibold text-xs ${m.highlight === 'red' ? 'text-red-400' : m.highlight === 'green' ? 'text-emerald-400' : 'text-slate-300'}`}>
                  {m.value}
                </p>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-[10px]">
            <div><span className="text-slate-500">Campaign ID:</span> <span className="font-mono text-slate-400">{campaign.campaign_id || '—'}</span></div>
            <div><span className="text-slate-500">Reconciliação:</span> <span className="text-slate-400">{campaign.reconciliation_status || '—'}</span></div>
            {campaign.reconciliation_notes && (
              <div className="col-span-2 px-2 py-1 bg-amber-500/5 border border-amber-500/15 rounded text-amber-300">
                {campaign.reconciliation_notes}
              </div>
            )}
          </div>
          {issues.length > 0 && (
            <div className="space-y-1">
              <p className="text-[10px] font-semibold text-slate-400">Diagnóstico:</p>
              {issues.map((issue, i) => (
                <div key={i} className="flex items-start gap-1.5 text-[10px] text-slate-400">
                  <XCircle className="w-3 h-3 text-red-400 flex-shrink-0 mt-0.5" />
                  {issue.detail}
                </div>
              ))}
            </div>
          )}
          {result && (
            <div className={`px-3 py-2 rounded-lg border text-[10px] ${result.ok ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-300' : 'bg-red-500/5 border-red-500/20 text-red-400'}`}>
              {result.ok
                ? `✓ Reparada — ${(result.repaired || []).join(', ') || 'configuração aplicada'}`
                : `Erro: ${result.error}`}
            </div>
          )}
          {repairLog?.length > 0 && (
            <details className="text-[10px]">
              <summary className="cursor-pointer text-slate-500 hover:text-slate-400">Ver log ({repairLog.length})</summary>
              <div className="mt-1 space-y-0.5 pl-2 border-l border-surface-3">
                {repairLog.map((entry, i) => (
                  <p key={i} className={entry.ok ? 'text-emerald-400' : 'text-red-400'}>
                    [{entry.time}] {entry.ok ? '✓ OK' : `✗ ${entry.error}`}
                  </p>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// ── Grupo por Data ─────────────────────────────────────────────────────────

function DateGroup({ dateStr, items, renderItem }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border border-surface-2 rounded-xl overflow-hidden">
      <button
        className="w-full flex items-center gap-3 px-4 py-2.5 bg-surface-2 hover:bg-surface-3 transition-colors text-left"
        onClick={() => setOpen(v => !v)}
      >
        <CalendarDays className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
        <span className="text-xs font-semibold text-slate-300">{dateLabel(dateStr)}</span>
        <span className="text-[10px] text-slate-500 ml-1">— {items.length} item{items.length !== 1 ? 's' : ''}</span>
        <span className="ml-auto text-slate-600">
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </span>
      </button>
      {open && (
        <div className="divide-y divide-surface-2 bg-surface-1">
          {items.map(item => renderItem(item))}
        </div>
      )}
    </div>
  );
}

// ── Grupo por ASIN ─────────────────────────────────────────────────────────

function AsinGroup({ asin, items, renderItem }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border border-surface-2 rounded-xl overflow-hidden">
      <button
        className="w-full flex items-center gap-3 px-4 py-2.5 bg-surface-2 hover:bg-surface-3 transition-colors text-left"
        onClick={() => setOpen(v => !v)}
      >
        <Package className="w-3.5 h-3.5 text-cyan flex-shrink-0" />
        <span className="text-xs font-mono font-bold text-cyan">{asin || 'Sem ASIN'}</span>
        <span className="text-[10px] text-slate-500 ml-1">— {items.length} campanha{items.length !== 1 ? 's' : ''}</span>
        <span className="ml-auto text-slate-600">
          {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </span>
      </button>
      {open && (
        <div className="p-2 space-y-2 bg-surface-1">
          {items.map(item => renderItem(item))}
        </div>
      )}
    </div>
  );
}

// ── Card de pendência sem campaign_id ──────────────────────────────────────

function QueuePendingCard({ item, products }) {
  const product = products.find(p => p.asin === item.asin);
  return (
    <div className="flex items-center gap-3 px-4 py-3 text-xs">
      <div className="w-7 h-7 rounded-lg bg-surface-3 flex items-center justify-center flex-shrink-0">
        <Package className="w-3.5 h-3.5 text-slate-500" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-mono font-semibold text-cyan">{item.asin}</p>
        {product && <p className="text-[10px] text-slate-500 truncate mt-0.5">{product.product_name || product.display_name}</p>}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-slate-500">{item.attempt_count || 0} tentativas</span>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400">
          Precisa de Kickoff
        </span>
      </div>
    </div>
  );
}

// ── Página Principal ───────────────────────────────────────────────────────

const GROUP_MODES = [
  { id: 'asin', label: 'Por Produto' },
  { id: 'date', label: 'Por Data' },
  { id: 'list', label: 'Lista' },
];

const FILTERS = [
  { id: 'all', label: 'Todos' },
  { id: 'incomplete', label: 'Incompletas' },
  { id: 'missing_kw', label: 'Sem Keywords' },
  { id: 'auto', label: 'AUTO' },
  { id: 'manual', label: 'MANUAL' },
];

export default function IncompleteCampaigns() {
  const [account, setAccount] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [keywords, setKeywords] = useState([]);
  const [queuePending, setQueuePending] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [groupMode, setGroupMode] = useState('asin');
  const [repairing, setRepairing] = useState(null);
  const [results, setResults] = useState({});
  const [repairLogs, setRepairLogs] = useState({});
  const [bulkResult, setBulkResult] = useState(null);
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0, active: false });
  const [lastLoadAt, setLastLoadAt] = useState(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0] || null;
      setAccount(acc);
      if (!acc) return;

      const [allCamps, allKws, queueItems, prods] = await Promise.all([
        base44.entities.Campaign.filter({ amazon_account_id: acc.id }, '-created_date', 500),
        base44.entities.Keyword.filter({ amazon_account_id: acc.id }, null, 2000),
        base44.entities.AutoCampaignRepairQueue.filter({ amazon_account_id: acc.id, status: 'scheduled' }, '-created_date', 50),
        base44.entities.Product.filter({ amazon_account_id: acc.id }, null, 200),
      ]);

      const kwCampaignIds = new Set(allKws.map(k => k.campaign_id));

      const problem = allCamps.filter(c => {
        const state = String(c.state || c.status || '').toLowerCase();
        if (c.archived) return false;
        const isIncomplete = state === 'incomplete';
        const isManualNoKw = (c.targeting_type || '').toUpperCase() === 'MANUAL'
          && !kwCampaignIds.has(c.campaign_id)
          && !['archived'].includes(state);
        return isIncomplete || isManualNoKw;
      });

      // Fila pendentes sem campaign_id (precisam kickoff)
      const pending = queueItems.filter(q => !q.campaign_id);

      setCampaigns(problem);
      setKeywords(allKws);
      setQueuePending(pending);
      setProducts(prods);
      setLastLoadAt(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const repairOne = async (campaign) => {
    if (!account || repairing) return;
    setRepairing(campaign.id);
    const time = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    try {
      const res = await base44.functions.invoke('repairIncompleteAutoCampaignById', {
        amazon_account_id: account.id,
        campaign_id: campaign.campaign_id,
      });
      const data = res?.data || {};
      setResults(prev => ({ ...prev, [campaign.id]: data }));
      setRepairLogs(prev => ({ ...prev, [campaign.id]: [...(prev[campaign.id] || []), { time, ok: data.ok, error: data.error }] }));
      if (data.ok) await load(true);
    } catch (e) {
      const data = { ok: false, error: e.message };
      setResults(prev => ({ ...prev, [campaign.id]: data }));
      setRepairLogs(prev => ({ ...prev, [campaign.id]: [...(prev[campaign.id] || []), { time, ok: false, error: e.message }] }));
    } finally {
      setRepairing(null);
    }
  };

  const repairAll = async () => {
    if (!account || repairing || campaigns.length === 0) return;
    setBulkResult(null);
    setResults({});
    setRepairLogs({});
    const total = campaigns.length;
    setBulkProgress({ done: 0, total, active: true });
    setRepairing('all');
    let succeeded = 0, failed = 0;
    const newResults = {};
    const newLogs = {};
    for (let i = 0; i < campaigns.length; i++) {
      const c = campaigns[i];
      setBulkProgress({ done: i, total, active: true });
      const time = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      try {
        const res = await base44.functions.invoke('repairIncompleteAutoCampaignById', {
          amazon_account_id: account.id,
          campaign_id: c.campaign_id,
        });
        const data = res?.data || {};
        newResults[c.id] = data;
        newLogs[c.id] = [{ time, ok: data.ok, error: data.error }];
        if (data.ok) succeeded++; else failed++;
      } catch (e) {
        newResults[c.id] = { ok: false, error: e.message };
        newLogs[c.id] = [{ time, ok: false, error: e.message }];
        failed++;
      }
      setResults({ ...newResults });
      setRepairLogs({ ...newLogs });
    }
    setBulkProgress({ done: total, total, active: false });
    setBulkResult({ succeeded, failed, total });
    setRepairing(null);
    await load(true);
  };

  // ── Dados derivados ──────────────────────────────────────────────────────
  const kwMap = new Map();
  keywords.forEach(k => { kwMap.set(k.campaign_id, (kwMap.get(k.campaign_id) || 0) + 1); });

  const incompleteCamps = campaigns.filter(c => String(c.state || c.status || '').toLowerCase() === 'incomplete');
  const missingKwCamps = campaigns.filter(c => String(c.state || c.status || '').toLowerCase() !== 'incomplete');
  const repairedCount = Object.values(results).filter(r => r?.ok).length;
  const failedCount = Object.values(results).filter(r => r?.ok === false).length;
  const isRunningAll = repairing === 'all';

  const filteredCampaigns = campaigns.filter(c => {
    const state = String(c.state || c.status || '').toLowerCase();
    const kwCount = kwMap.get(c.campaign_id) || 0;
    const isManual = (c.targeting_type || '').toUpperCase() === 'MANUAL';
    const isAuto = (c.targeting_type || '').toUpperCase() === 'AUTO';
    if (filter === 'incomplete') return state === 'incomplete';
    if (filter === 'missing_kw') return state !== 'incomplete' && kwCount === 0;
    if (filter === 'auto') return isAuto;
    if (filter === 'manual') return isManual;
    return true;
  });

  // Agrupamento por ASIN
  const groupedByAsin = filteredCampaigns.reduce((acc, c) => {
    const key = c.asin || 'sem-asin';
    if (!acc[key]) acc[key] = [];
    acc[key].push(c);
    return acc;
  }, {});

  // Agrupamento por data (dia de criação)
  const groupedByDate = filteredCampaigns.reduce((acc, c) => {
    const key = c.created_date ? c.created_date.slice(0, 10) : 'sem-data';
    if (!acc[key]) acc[key] = [];
    acc[key].push(c);
    return acc;
  }, {});
  const sortedDates = Object.keys(groupedByDate).sort((a, b) => b.localeCompare(a));

  // Agrupamento de fila pendente por data
  const queueByDate = queuePending.reduce((acc, q) => {
    const key = q.created_date ? q.created_date.slice(0, 10) : 'sem-data';
    if (!acc[key]) acc[key] = [];
    acc[key].push(q);
    return acc;
  }, {});
  const sortedQueueDates = Object.keys(queueByDate).sort((a, b) => b.localeCompare(a));

  function renderCampaignRow(c) {
    return (
      <CampaignRow
        key={c.id}
        campaign={c}
        keywords={keywords}
        result={results[c.id]}
        repairing={repairing}
        onRepair={repairOne}
        repairLog={repairLogs[c.id]}
      />
    );
  }

  return (
    <div className="min-h-full p-6 space-y-5 max-w-4xl mx-auto">

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-red-500/15 border border-red-500/20 flex items-center justify-center">
            <ShieldAlert className="w-5 h-5 text-red-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Monitor de Campanhas Incompletas</h1>
            <p className="text-xs text-slate-400">
              {loading ? 'Carregando...'
                : campaigns.length === 0 && queuePending.length === 0 ? 'Nenhuma pendência detectada'
                : `${campaigns.length} campanha${campaigns.length !== 1 ? 's' : ''} com problemas · ${queuePending.length} aguardando kickoff`}
              {lastLoadAt && !loading && (
                <span className="ml-2 text-slate-600">· {lastLoadAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => load(false)}
            disabled={loading || isRunningAll}
            className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {campaigns.length > 1 && (
            <button
              onClick={repairAll}
              disabled={!!repairing || campaigns.length === 0}
              className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-cyan hover:bg-cyan/90 text-white rounded-xl transition-colors disabled:opacity-50 shadow-lg shadow-cyan/20"
            >
              {isRunningAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              {isRunningAll
                ? `Reparando ${bulkProgress.done}/${bulkProgress.total}...`
                : `Reparar todas (${campaigns.length})`}
            </button>
          )}
        </div>
      </div>

      {/* ── KPI Strip ────────────────────────────────────────────────────── */}
      {!loading && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {[
            { label: 'Com problemas', value: campaigns.length, color: 'text-slate-300', bg: 'bg-surface-1' },
            { label: 'Incompletas', value: incompleteCamps.length, color: 'text-red-400', bg: incompleteCamps.length > 0 ? 'bg-red-500/5 border-red-500/20' : 'bg-surface-1' },
            { label: 'Sem Keywords', value: missingKwCamps.length, color: 'text-amber-400', bg: missingKwCamps.length > 0 ? 'bg-amber-500/5 border-amber-500/20' : 'bg-surface-1' },
            { label: 'Aguardam Kickoff', value: queuePending.length, color: 'text-purple-400', bg: queuePending.length > 0 ? 'bg-purple-500/5 border-purple-500/20' : 'bg-surface-1' },
            { label: 'Reparadas agora', value: repairedCount, color: 'text-emerald-400', bg: repairedCount > 0 ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-surface-1' },
          ].map(({ label, value, color, bg }) => (
            <div key={label} className={`border border-surface-2 rounded-xl p-3 ${bg}`}>
              <p className={`text-xl font-bold ${color}`}>{value}</p>
              <p className="text-[10px] text-slate-500 mt-0.5">{label}</p>
            </div>
          ))}
        </div>
      )}

      {/* ── Progress bar reparo em lote ──────────────────────────────────── */}
      {isRunningAll && bulkProgress.total > 0 && (
        <div className="bg-surface-1 border border-cyan/20 rounded-xl p-4 space-y-2">
          <div className="flex justify-between text-xs text-slate-400">
            <span className="flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin text-cyan" /> Reparando em sequência...</span>
            <span className="text-cyan font-semibold">{bulkProgress.done}/{bulkProgress.total}</span>
          </div>
          <div className="h-2 bg-surface-3 rounded-full overflow-hidden">
            <div className="h-full bg-cyan rounded-full transition-all duration-300"
              style={{ width: `${bulkProgress.total > 0 ? (bulkProgress.done / bulkProgress.total) * 100 : 0}%` }} />
          </div>
        </div>
      )}

      {/* ── Resultado lote ──────────────────────────────────────────────── */}
      {bulkResult && !isRunningAll && (
        <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-sm font-semibold ${bulkResult.failed === 0 ? 'bg-emerald-500/8 border-emerald-500/20 text-emerald-300' : 'bg-amber-500/8 border-amber-500/20 text-amber-300'}`}>
          {bulkResult.failed === 0 ? <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" /> : <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />}
          <span>
            {bulkResult.succeeded} de {bulkResult.total} reparadas
            {bulkResult.failed > 0 && <> · <span className="text-red-400">{bulkResult.failed} falharam</span></>}
          </span>
          <button onClick={() => setBulkResult(null)} className="ml-auto text-slate-500 hover:text-white"><XCircle className="w-4 h-4" /></button>
        </div>
      )}

      {/* ── Controles: Filtros + Agrupamento ────────────────────────────── */}
      {!loading && campaigns.length > 0 && (
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Filter className="w-3.5 h-3.5 text-slate-500" />
            {FILTERS.map(f => (
              <button key={f.id} onClick={() => setFilter(f.id)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${filter === f.id ? 'bg-cyan/15 border-cyan/30 text-cyan' : 'bg-surface-2 border-surface-3 text-slate-500 hover:text-slate-300'}`}>
                {f.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 bg-surface-2 border border-surface-3 rounded-lg p-0.5">
            {GROUP_MODES.map(m => (
              <button key={m.id} onClick={() => setGroupMode(m.id)}
                className={`text-xs px-2.5 py-1 rounded transition-colors ${groupMode === m.id ? 'bg-surface-3 text-white' : 'text-slate-500 hover:text-slate-300'}`}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {Object.keys(results).length > 0 && (
        <button onClick={() => { setResults({}); setRepairLogs({}); setBulkResult(null); }}
          className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300 transition-colors">
          <RotateCcw className="w-3 h-3" /> Limpar resultados
        </button>
      )}

      {/* ── Conteúdo ────────────────────────────────────────────────────── */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <Loader2 className="w-8 h-8 text-cyan animate-spin" />
          <p className="text-sm text-slate-500">Carregando campanhas...</p>
        </div>
      ) : campaigns.length === 0 && queuePending.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
            <CheckCircle className="w-8 h-8 text-emerald-400" />
          </div>
          <p className="text-base font-semibold text-emerald-300">Tudo em ordem!</p>
          <p className="text-sm text-slate-500">Nenhuma campanha incompleta ou sem keywords encontrada.</p>
        </div>
      ) : (
        <div className="space-y-6">

          {/* ── Campanhas com problemas ──────────────────────────────────── */}
          {filteredCampaigns.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-red-400" />
                <h2 className="text-xs font-bold text-red-400 uppercase tracking-wider">
                  Campanhas com Problemas ({filteredCampaigns.length})
                </h2>
              </div>

              {groupMode === 'asin' && (
                <div className="space-y-2">
                  {Object.entries(groupedByAsin)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([asin, items]) => (
                      <AsinGroup key={asin} asin={asin === 'sem-asin' ? null : asin} items={items} renderItem={renderCampaignRow} />
                    ))}
                </div>
              )}

              {groupMode === 'date' && (
                <div className="space-y-2">
                  {sortedDates.map(date => (
                    <DateGroup key={date} dateStr={date === 'sem-data' ? null : date} items={groupedByDate[date]} renderItem={renderCampaignRow} />
                  ))}
                </div>
              )}

              {groupMode === 'list' && (
                <div className="space-y-2">
                  {filteredCampaigns.map(renderCampaignRow)}
                </div>
              )}
            </section>
          )}

          {/* ── Pendências sem campaign_id (precisam kickoff) ───────────── */}
          {queuePending.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-purple-400" />
                <h2 className="text-xs font-bold text-purple-400 uppercase tracking-wider">
                  Aguardando Kickoff ({queuePending.length})
                </h2>
                <span className="text-[10px] text-slate-500">— campanha ainda não criada na Amazon</span>
              </div>

              <div className="border border-surface-2 rounded-xl overflow-hidden">
                <div className="px-4 py-2 bg-surface-2 flex items-start gap-2">
                  <AlertCircle className="w-3.5 h-3.5 text-purple-400 flex-shrink-0 mt-0.5" />
                  <p className="text-[10px] text-slate-400">
                    Estes ASINs estão na fila de reparo mas não possuem campanha criada na Amazon. Acesse a página de{' '}
                    <Link to="/products" className="text-cyan hover:underline">Produtos</Link>{' '}
                    para realizar o Kickoff manualmente em cada um.
                  </p>
                </div>
                <div className="divide-y divide-surface-2 bg-surface-1">
                  {groupMode === 'date'
                    ? sortedQueueDates.map(date => (
                        <div key={date}>
                          <div className="flex items-center gap-2 px-4 py-2 bg-surface-2/50">
                            <CalendarDays className="w-3 h-3 text-slate-500" />
                            <span className="text-[10px] font-semibold text-slate-400">{dateLabel(date === 'sem-data' ? null : date)}</span>
                            <span className="text-[10px] text-slate-600">— {queueByDate[date].length} item{queueByDate[date].length !== 1 ? 's' : ''}</span>
                          </div>
                          {queueByDate[date].map(item => (
                            <QueuePendingCard key={item.id} item={item} products={products} />
                          ))}
                        </div>
                      ))
                    : queuePending.map(item => (
                        <QueuePendingCard key={item.id} item={item} products={products} />
                      ))
                  }
                </div>
              </div>
            </section>
          )}
        </div>
      )}

      {/* ── Nota de token ──────────────────────────────────────────────── */}
      {!loading && campaigns.length > 0 && (
        <div className="flex items-start gap-2.5 px-4 py-3 bg-surface-1 border border-surface-2 rounded-xl">
          <Clock className="w-4 h-4 text-slate-500 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-slate-500">
            O reparo usa a Amazon Ads API. Erros 403 indicam token expirado —{' '}
            <Link to="/amazon-oauth-setup" className="text-cyan hover:underline inline-flex items-center gap-1">
              reautorize aqui <ExternalLink className="w-3 h-3" />
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}