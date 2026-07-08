import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { loadAllCampaigns, classifyCampaigns } from '@/lib/campaignUtils';
import { Link } from 'react-router-dom';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import {
  RefreshCw, AlertCircle, Clock, Rocket, Loader2, X,
  Target, TrendingUp, TrendingDown, Minus, CheckCircle, AlertTriangle,
  BarChart2, Megaphone, BookOpen, Terminal, DollarSign
} from 'lucide-react';
import SyncStatusBanner from '@/components/dashboard/SyncStatusBanner';

// ─── Utilitários de período fechado ─────────────────────────────────────────

function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function getClosedReportingPeriod(period) {
  const yesterday = getYesterday();
  if (period === 'yesterday') return { startDate: yesterday, endDate: yesterday, label: 'Ontem' };
  const days = Number(period);
  const start = new Date();
  start.setDate(start.getDate() - days);
  start.setHours(0, 0, 0, 0);
  return { startDate: start.toISOString().slice(0, 10), endDate: yesterday, label: `${days} dias` };
}

function safe(v, d = 2) {
  if (!v || !isFinite(v) || isNaN(v)) return 0;
  return Number(v.toFixed(d));
}

function fmt(v) { return v !== null && v !== undefined && isFinite(v) && !isNaN(v) ? v : 0; }
function fmtBRL(v) { return `R$${fmt(v).toFixed(2)}`; }
function fmtPct(v) { return `${fmt(v).toFixed(1)}%`; }

// ─── Deduplicar métricas ────────────────────────────────────────────────────

function dedupeMetrics(metrics) {
  const map = new Map();
  for (const m of metrics) {
    const key = `${m.amazon_account_id || ''}-${m.campaign_id || ''}-${m.date}`;
    if (!map.has(key)) map.set(key, m);
  }
  return Array.from(map.values());
}

function calcKpis(metrics) {
  return metrics.reduce((acc, m) => ({
    spend: acc.spend + (m.spend || 0),
    sales: acc.sales + (m.sales || 0),
    clicks: acc.clicks + (m.clicks || 0),
    impressions: acc.impressions + (m.impressions || 0),
    orders: acc.orders + (m.orders || 0),
  }), { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0 });
}

function deriveRates(k) {
  return {
    ...k,
    acos: k.sales > 0 ? safe(k.spend / k.sales * 100) : 0,
    roas: k.spend > 0 ? safe(k.sales / k.spend) : 0,
    cpc: k.clicks > 0 ? safe(k.spend / k.clicks) : 0,
    ctr: k.impressions > 0 ? safe(k.clicks / k.impressions * 100, 3) : 0,
  };
}

// ─── Componentes internos ───────────────────────────────────────────────────

function KpiCard({ label, value, sub, tone = 'default' }) {
  const tones = {
    default: 'border-surface-2',
    good: 'border-emerald-500/25 bg-emerald-500/5',
    warn: 'border-amber-500/25 bg-amber-500/5',
    bad: 'border-red-500/25 bg-red-500/5',
    cyan: 'border-cyan/20 bg-cyan/5',
  };
  return (
    <div className={`bg-surface-1 border rounded-xl p-4 ${tones[tone]}`}>
      <p className="text-[10px] font-medium text-slate-500 mb-1 uppercase tracking-wide">{label}</p>
      <p className="text-xl font-bold text-white">{value}</p>
      {sub && <p className="text-[10px] text-slate-500 mt-1">{sub}</p>}
    </div>
  );
}

const ChartTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#111318] border border-surface-2 rounded-lg p-3 text-xs shadow-xl">
      <p className="text-slate-400 mb-1.5 font-medium">{label}</p>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2 mb-1">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
          <span className="text-slate-300">{p.name}:</span>
          <span className="text-white font-semibold">
            {String(p.name).toLowerCase().includes('impressões') || String(p.name).toLowerCase().includes('cliques') || String(p.name).toLowerCase().includes('alterações')
              ? Number(p.value).toLocaleString('pt-BR')
              : `R$${Number(p.value).toFixed(2)}`}
          </span>
        </div>
      ))}
    </div>
  );
};

function PeriodSelector({ value, onChange, available }) {
  const ALL = [
    { key: 'yesterday', label: 'Ontem' },
    { key: '7', label: '7 dias' },
    { key: '14', label: '14 dias' },
    { key: '30', label: '30 dias' },
  ];
  const opts = ALL.filter(o => available.includes(o.key));
  return (
    <div className="flex bg-surface-2 border border-surface-3 rounded-lg p-0.5 gap-0.5">
      {opts.map(o => (
        <button key={o.key} onClick={() => onChange(o.key)}
          className={`px-3 py-1.5 rounded text-xs font-semibold transition-all ${value === o.key ? 'bg-cyan text-white' : 'text-slate-400 hover:text-slate-200'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function GoalRow({ label, real, target, unit = '%', lowerIsBetter = true, realLabel }) {
  if (!target) return null;
  const good = lowerIsBetter ? real <= target : real >= target;
  const warn = lowerIsBetter ? real > target && real <= target * 1.3 : real >= target * 0.75 && real < target;
  const tone = real === 0 ? 'text-slate-500' : good ? 'text-emerald-400' : warn ? 'text-amber-400' : 'text-red-400';
  const pct = target > 0 ? Math.round(Math.abs(real - target) / target * 100) : 0;
  const dir = lowerIsBetter ? (real <= target ? `${pct}% abaixo ✓` : `${pct}% acima`) : (real >= target ? `${pct}% acima ✓` : `${pct}% abaixo`);
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-surface-2/50 last:border-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${good ? 'bg-emerald-400' : warn ? 'bg-amber-400' : real === 0 ? 'bg-slate-600' : 'bg-red-400'}`} />
        <span className="text-xs text-slate-400">{label}</span>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        <span className={`text-sm font-bold ${tone}`}>{realLabel || (real === 0 ? '—' : `${real.toFixed(1)}${unit}`)}</span>
        <span className="text-[10px] text-slate-600">Meta: {target}{unit}</span>
        {real > 0 && <span className={`text-[10px] ${tone}`}>{dir}</span>}
      </div>
    </div>
  );
}

// ─── Dashboard principal ─────────────────────────────────────────────────────

export default function Dashboard() {
  const [user, setUser] = useState(null);
  const [account, setAccount] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [products, setProducts] = useState([]);
  const [metricsDaily, setMetricsDaily] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [syncRuns, setSyncRuns] = useState([]);
  const [bidChanges, setBidChanges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [autopilotConfig, setAutopilotConfig] = useState(null);
  const [lastSyncInfo, setLastSyncInfo] = useState(null);
  const [syncingDashboard, setSyncingDashboard] = useState(false);
  const [syncDashMsg, setSyncDashMsg] = useState(null);
  const [kickoffStatus, setKickoffStatus] = useState(null);
  const [kickoffRunning, setKickoffRunning] = useState(false);
  const [period, setPeriod] = useState('7');
  const [budgetCfg, setBudgetCfg] = useState(null);
  const kickoffAbortRef = useRef(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await base44.auth.me();
      setUser(me);
      const allAccounts = await base44.entities.AmazonAccount.filter({ user_id: me.id }, '-updated_date', 5);
      const acc = allAccounts.find(a => a.status === 'connected') || allAccounts[0] || null;
      setAccount(acc);
      if (!acc) { setLoading(false); return; }
      const aid = acc.id;
      const delay = ms => new Promise(r => setTimeout(r, ms));
      const safe_ = async (fn, fb = []) => { try { return await fn(); } catch (e) { if (String(e?.message).includes('429')) return fb; throw e; } };

      const cams = await safe_(() => loadAllCampaigns(aid));
      await delay(300);
      const prods = await safe_(() => base44.entities.Product.filter({ amazon_account_id: aid }, '-fba_inventory', 20));
      await delay(300);
      const metrics = await safe_(() => base44.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 200));
      await delay(300);
      const decs = await safe_(() => base44.entities.OptimizationDecision.filter({ amazon_account_id: aid, status: 'pending' }, '-created_at', 10));
      await delay(300);
      const runs = await safe_(() => base44.entities.SyncExecutionLog.filter({ amazon_account_id: aid }, '-started_at', 5));
      await delay(300);
      const changes = await safe_(() => base44.entities.AdsBidChangeLog.filter({ amazon_account_id: aid }, '-created_at', 500));
      await delay(300);
      const apConfigs = await safe_(() => base44.entities.AutopilotConfig.filter({ amazon_account_id: aid }));
      await delay(150);
      const budgCfgs = await safe_(() => base44.entities.BudgetConfiguration.filter({ amazon_account_id: aid }), []);

      setCampaigns(cams);
      setProducts(prods);
      setMetricsDaily(metrics);
      setDecisions(decs);
      setSyncRuns(runs);
      setBidChanges(changes);
      setAutopilotConfig(apConfigs[0] || null);
      setBudgetCfg(budgCfgs[0] || null);

      const noAds = prods.filter(p => p.status === 'active' && !p.has_campaign && p.inventory_status !== 'out_of_stock');
      setKickoffStatus({ productsWithoutAds: noAds.length });

      if (acc?.last_sync_at) setLastSyncInfo({ at: acc.last_sync_at });
      else {
        const last = runs.find(r => r.status === 'success' || r.status === 'skipped_limit');
        if (last) setLastSyncInfo({ at: last.completed_at || last.started_at });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const runSync = async () => {
    if (!account || syncingDashboard) return;
    if (account.last_sync_at) {
      const ageHours = (Date.now() - new Date(account.last_sync_at).getTime()) / 3600000;
      if (ageHours < 23) {
        setSyncDashMsg({ type: 'info', text: `Sync realizado há ${ageHours.toFixed(1)}h. Próximo em ${(23 - ageHours).toFixed(1)}h.` });
        setTimeout(() => setSyncDashMsg(null), 7000);
        return;
      }
    }
    setSyncingDashboard(true);
    try {
      const res = await base44.functions.invoke('syncAdsQuick', { amazon_account_id: account.id });
      if (res?.data?.ok) {
        setSyncDashMsg({ type: 'success', text: `${res.data.campaigns_updated || 0} campanhas sincronizadas.` });
        await loadData();
      } else {
        setSyncDashMsg({ type: 'error', text: res?.data?.error || 'Falha.' });
      }
    } catch (e) {
      setSyncDashMsg({ type: 'error', text: e.message });
    } finally {
      setSyncingDashboard(false);
      setTimeout(() => setSyncDashMsg(null), 7000);
    }
  };

  // ─── Cálculos com período fechado ─────────────────────────────────────────

  const allMetrics = useMemo(() => dedupeMetrics(metricsDaily), [metricsDaily]);

  // Determinar períodos disponíveis
  const availablePeriods = useMemo(() => {
    const yesterday = getYesterday();
    const dates = new Set(allMetrics.filter(m => m.date <= yesterday).map(m => m.date));
    const periods = ['yesterday'];
    if (dates.size >= 7) periods.push('7');
    if (dates.size >= 14) periods.push('14');
    if (dates.size >= 28) periods.push('30');
    return periods;
  }, [allMetrics]);

  // Garantir que period seja válido
  const activePeriod = availablePeriods.includes(period) ? period : availablePeriods[availablePeriods.length - 1] || 'yesterday';

  const { startDate, endDate, label: periodLabel } = useMemo(() => getClosedReportingPeriod(activePeriod), [activePeriod]);

  const periodMetrics = useMemo(() =>
    allMetrics.filter(m => m.date >= startDate && m.date <= endDate),
    [allMetrics, startDate, endDate]
  );

  const kpis = useMemo(() => deriveRates(calcKpis(periodMetrics)), [periodMetrics]);

  // Ontem para subtexto
  const yesterday = getYesterday();
  const yesterdayKpis = useMemo(() =>
    deriveRates(calcKpis(allMetrics.filter(m => m.date === yesterday))),
    [allMetrics, yesterday]
  );

  // ─── Gráfico: Alterações da IA por dia ────────────────────────────────────

  const aiChangesChart = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const firstDay = new Date(today); firstDay.setDate(today.getDate() - 29);
    const dateKey = d => d.toISOString().slice(0, 10);
    const counts = new Map();
    for (const c of bidChanges) {
      if (!c.created_at) continue;
      const d = new Date(c.created_at); d.setHours(0, 0, 0, 0);
      if (d < firstDay || d.toISOString().slice(0, 10) >= today.toISOString().slice(0, 10)) continue;
      const k = dateKey(d);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    return Array.from({ length: 30 }, (_, i) => {
      const day = new Date(firstDay); day.setDate(firstDay.getDate() + i);
      const key = dateKey(day);
      if (key >= today.toISOString().slice(0, 10)) return null;
      return { date: key.slice(5), alterações: counts.get(key) || 0 };
    }).filter(Boolean);
  }, [bidChanges]);

  const totalChanges = useMemo(() => aiChangesChart.reduce((s, d) => s + d.alterações, 0), [aiChangesChart]);

  // ─── Gráfico: Impressões diárias ──────────────────────────────────────────

  const impressionsChart = useMemo(() => {
    const byDate = {};
    for (const m of periodMetrics) {
      if (!m.date) continue;
      if (!byDate[m.date]) byDate[m.date] = { date: m.date.slice(5), impressões: 0, cliques: 0 };
      byDate[m.date].impressões += m.impressions || 0;
      byDate[m.date].cliques += m.clicks || 0;
    }
    return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
  }, [periodMetrics]);

  // ─── Orçamento e pacing ────────────────────────────────────────────────────

  const { active: activeCampsList, active_count, paused_count } = useMemo(() => classifyCampaigns(campaigns), [campaigns]);
  const officialDailyLimit = budgetCfg?.calculated_daily_budget || autopilotConfig?.daily_budget_limit || autopilotConfig?.total_daily_budget || 0;
  const spendYesterday = useMemo(() => {
    const seen = new Set();
    let s = 0;
    for (const m of allMetrics) {
      if (m.date !== yesterday) continue;
      const k = `${m.campaign_id}-${m.date}`;
      if (seen.has(k)) continue;
      seen.add(k);
      s += m.spend || 0;
    }
    return s;
  }, [allMetrics, yesterday]);

  // Média diária do período selecionado
  const uniqueDates = useMemo(() => new Set(periodMetrics.map(m => m.date)), [periodMetrics]);
  const avgDailySpend = uniqueDates.size > 0 ? safe(kpis.spend / uniqueDates.size) : 0;

  // ─── Metas ────────────────────────────────────────────────────────────────

  const cfg = autopilotConfig || {};
  const targetAcos = cfg.target_acos || 0;
  const maxAcos = cfg.maximum_acos || 0;
  const targetRoas = cfg.target_roas || 0;
  const targetTacos = cfg.target_tacos || 0;
  const targetCpc = cfg.target_cpc || 0;
  const maxCpc = cfg.maximum_cpc || 0;

  // ─── Header ───────────────────────────────────────────────────────────────

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const firstName = user?.full_name?.split(' ')[0] || 'gestor';

  return (
    <div className="p-5 space-y-5 animate-fade-in">

      {/* ── 1. HEADER ───────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-white">{greeting}, {firstName}.</h1>
          <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1.5">
            {loading ? 'Carregando...' : account
              ? <><span className="text-emerald-400/80">{campaigns.length} campanhas</span> · {active_count} ativas · {products.length} produtos</>
              : <Link to="/settings" className="text-cyan hover:underline">Configure sua conta Amazon →</Link>}
            {lastSyncInfo && (
              <span className="flex items-center gap-1 text-slate-600">
                · <Clock className="w-3 h-3" />
                {new Date(lastSyncInfo.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {syncDashMsg && (
            <span className={`text-xs ${syncDashMsg.type === 'success' ? 'text-emerald-400' : syncDashMsg.type === 'info' ? 'text-amber-400' : 'text-red-400'}`}>
              {syncDashMsg.text}
            </span>
          )}
          <button onClick={runSync} disabled={loading || syncingDashboard}
            className="flex items-center gap-1.5 px-3 py-2 bg-cyan/10 border border-cyan/20 text-cyan hover:bg-cyan/20 text-sm rounded-lg transition-colors disabled:opacity-50">
            <RefreshCw className={`w-3.5 h-3.5 ${syncingDashboard ? 'animate-spin' : ''}`} />
            {syncingDashboard ? 'Sincronizando...' : 'Sync'}
          </button>
          <button onClick={loadData} disabled={loading}
            className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* ── 2. ALERTAS ESSENCIAIS ────────────────────────────────────────────── */}
      {account && <SyncStatusBanner accountId={account.id} />}

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}

      {/* Kick-off pendente — compacto */}
      {!loading && account && kickoffStatus?.productsWithoutAds > 0 && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl border bg-amber-500/5 border-amber-500/20 text-xs">
          <div className="flex items-center gap-2">
            <Rocket className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
            <span className="text-amber-300">
              <span className="font-bold">{kickoffStatus.productsWithoutAds}</span> produto(s) sem campanha — kick-off agendado automaticamente.
            </span>
          </div>
          <button onClick={async () => {
            if (kickoffRunning) return;
            const ctrl = new AbortController();
            kickoffAbortRef.current = ctrl;
            setKickoffRunning(true);
            try {
              const res = await base44.functions.invoke('runFullProductAutomation', { amazon_account_id: account.id });
              if (!ctrl.signal.aborted && res?.data?.ok) {
                const s = res.data.summary || {};
                setKickoffStatus(p => ({ ...p, productsWithoutAds: 0, lastMsg: `✓ ${s.auto_campaigns_created || 0} campanhas criadas` }));
              }
            } catch {}
            finally { kickoffAbortRef.current = null; setKickoffRunning(false); }
          }} disabled={kickoffRunning}
            className="flex items-center gap-1 px-2.5 py-1.5 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap">
            {kickoffRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Rocket className="w-3 h-3" />}
            {kickoffRunning ? 'Executando...' : 'Executar agora'}
          </button>
        </div>
      )}
      {kickoffStatus?.lastMsg && (
        <p className="text-xs text-slate-400 px-1">{kickoffStatus.lastMsg}</p>
      )}

      {/* Decisões pendentes — compacto */}
      {decisions.length > 0 && (
        <div className="flex items-center justify-between px-4 py-2.5 rounded-xl border bg-violet-500/5 border-violet-500/20 text-xs">
          <span className="text-violet-300"><span className="font-bold">{decisions.length}</span> decisões de IA pendentes de revisão.</span>
          <Link to="/sala-de-comando" className="text-violet-400 hover:underline whitespace-nowrap">Ver na Sala de Controle →</Link>
        </div>
      )}

      {/* ── 3. EVOLUÇÃO OPERACIONAL ──────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Alterações da IA por dia */}
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold text-slate-300">Alterações da IA por dia</h2>
            <span className="text-xs font-bold text-amber-400">{totalChanges} total</span>
          </div>
          <p className="text-[10px] text-slate-500 mb-4">Ações enviadas à Amazon — últimos 30 dias fechados</p>
          {loading ? (
            <div className="h-36 flex items-center justify-center"><Loader2 className="w-5 h-5 text-cyan animate-spin" /></div>
          ) : aiChangesChart.length === 0 || totalChanges === 0 ? (
            <div className="h-36 flex items-center justify-center text-xs text-slate-600">Nenhuma alteração registrada ainda.</div>
          ) : (
            <ResponsiveContainer width="100%" height={150}>
              <BarChart data={aiChangesChart}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="alterações" fill="#F59E0B" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Impressões diárias */}
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold text-slate-300">Impressões diárias</h2>
            <span className="text-xs font-bold text-violet-400">{kpis.impressions.toLocaleString('pt-BR')}</span>
          </div>
          <p className="text-[10px] text-slate-500 mb-4">Alcance dos anúncios — {periodLabel}</p>
          {loading ? (
            <div className="h-36 flex items-center justify-center"><Loader2 className="w-5 h-5 text-cyan animate-spin" /></div>
          ) : impressionsChart.length === 0 ? (
            <div className="h-36 flex items-center justify-center text-xs text-slate-600">Sem dados de impressões. Execute sync quando o relatório estiver vencido.</div>
          ) : (
            <ResponsiveContainer width="100%" height={150}>
              <BarChart data={impressionsChart}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="impressões" fill="#8B5CF6" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* ── 4. RESUMO DE PERFORMANCE ────────────────────────────────────────── */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-300">Resumo de performance</h2>
            <p className="text-[10px] text-slate-500 mt-0.5">Período: {periodLabel} · dados fechados sem o dia atual</p>
          </div>
          <PeriodSelector value={activePeriod} onChange={setPeriod} available={availablePeriods} />
        </div>

        {loading ? (
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
            {Array.from({length: 9}).map((_, i) => (
              <div key={i} className="h-20 bg-surface-2 rounded-xl animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
            <KpiCard label="Gasto em Ads" value={fmtBRL(kpis.spend)}
              sub={activePeriod !== 'yesterday' ? `Ontem: ${fmtBRL(yesterdayKpis.spend)}` : undefined} />
            <KpiCard label="Vendas Ads" value={fmtBRL(kpis.sales)}
              sub={`${kpis.orders} pedidos`}
              tone={kpis.sales > 0 ? 'good' : 'default'} />
            <KpiCard label="ACoS"
              value={kpis.spend > 0 ? fmtPct(kpis.acos) : '—'}
              sub={targetAcos > 0 ? `Meta: ${targetAcos}%` : activePeriod !== 'yesterday' ? `Ontem: ${fmtPct(yesterdayKpis.acos)}` : undefined}
              tone={kpis.acos === 0 ? 'default' : kpis.acos <= targetAcos && targetAcos > 0 ? 'good' : kpis.acos <= (maxAcos || 999) ? 'warn' : 'bad'} />
            <KpiCard label="ROAS"
              value={kpis.spend > 0 ? `${kpis.roas.toFixed(2)}x` : '—'}
              sub={targetRoas > 0 ? `Meta: ${targetRoas}x` : undefined}
              tone={kpis.roas === 0 ? 'default' : targetRoas > 0 && kpis.roas >= targetRoas ? 'good' : 'default'} />
            <KpiCard label="CPC médio"
              value={kpis.clicks > 0 ? fmtBRL(kpis.cpc) : '—'}
              sub={maxCpc > 0 ? `Máx: ${fmtBRL(maxCpc)}` : undefined}
              tone={maxCpc > 0 && kpis.cpc > maxCpc ? 'bad' : 'default'} />
            <KpiCard label="CTR" value={kpis.impressions > 0 ? `${kpis.ctr.toFixed(3)}%` : '—'} />
            <KpiCard label="Cliques" value={kpis.clicks.toLocaleString('pt-BR')}
              sub={activePeriod !== 'yesterday' ? `Ontem: ${yesterdayKpis.clicks.toLocaleString('pt-BR')}` : undefined} />
            <KpiCard label="Impressões" value={kpis.impressions.toLocaleString('pt-BR')}
              sub={activePeriod !== 'yesterday' ? `Ontem: ${yesterdayKpis.impressions.toLocaleString('pt-BR')}` : undefined}
              tone="cyan" />
            <KpiCard label="Pedidos" value={kpis.orders.toLocaleString('pt-BR')}
              sub={activePeriod !== 'yesterday' ? `Ontem: ${yesterdayKpis.orders.toLocaleString('pt-BR')}` : undefined}
              tone={kpis.orders > 0 ? 'good' : 'default'} />
          </div>
        )}
      </div>

      {/* ── 5. GRÁFICO GASTO VS VENDAS ───────────────────────────────────────── */}
      {!loading && periodMetrics.length > 0 && (() => {
        const byDate = {};
        for (const m of periodMetrics) {
          if (!m.date) continue;
          if (!byDate[m.date]) byDate[m.date] = { date: m.date.slice(5), gasto: 0, vendas: 0 };
          byDate[m.date].gasto += m.spend || 0;
          byDate[m.date].vendas += m.sales || 0;
        }
        const chartData = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
        return (
          <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-slate-300 mb-4">Gasto vs Vendas — {periodLabel}</h2>
            <ResponsiveContainer width="100%" height={190}>
              <AreaChart data={chartData}>
                <defs>
                  <linearGradient id="gV" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#10B981" stopOpacity={0.25} /><stop offset="95%" stopColor="#10B981" stopOpacity={0} /></linearGradient>
                  <linearGradient id="gG" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3B82F6" stopOpacity={0.25} /><stop offset="95%" stopColor="#3B82F6" stopOpacity={0} /></linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Area type="monotone" dataKey="vendas" name="Vendas" stroke="#10B981" fill="url(#gV)" strokeWidth={2} />
                <Area type="monotone" dataKey="gasto" name="Gasto" stroke="#3B82F6" fill="url(#gG)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        );
      })()}

      {/* ── 6. ORÇAMENTO E PACING ────────────────────────────────────────────── */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-slate-300">Orçamento e pacing</h2>
          {officialDailyLimit === 0 && (
            <Link to="/settings" className="text-xs text-amber-400 hover:underline">Configurar limite →</Link>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <KpiCard label="Limite diário geral" value={officialDailyLimit > 0 ? fmtBRL(officialDailyLimit) : '—'} tone="cyan" />
          <KpiCard label="Gasto D-1 (ontem)" value={fmtBRL(spendYesterday)}
            sub={officialDailyLimit > 0 ? `${Math.round(spendYesterday / officialDailyLimit * 100)}% do limite` : undefined}
            tone={officialDailyLimit > 0 && spendYesterday > officialDailyLimit ? 'bad' : 'default'} />
          <KpiCard label="Média diária" value={fmtBRL(avgDailySpend)} sub={`Período: ${periodLabel}`} />
          <KpiCard label="Campanhas ativas" value={active_count} sub={`${paused_count} pausadas`} />
        </div>
        {officialDailyLimit > 0 && spendYesterday > 0 && (
          <div>
            <div className="flex justify-between text-[10px] text-slate-500 mb-1">
              <span>Pacing D-1: {fmtBRL(spendYesterday)} / {fmtBRL(officialDailyLimit)}</span>
              <span className={`font-semibold ${spendYesterday > officialDailyLimit ? 'text-red-400' : 'text-emerald-400'}`}>
                {Math.round(spendYesterday / officialDailyLimit * 100)}%
              </span>
            </div>
            <div className="h-1.5 bg-surface-3 rounded-full overflow-hidden">
              <div className={`h-full rounded-full transition-all ${spendYesterday > officialDailyLimit ? 'bg-red-500' : 'bg-emerald-500'}`}
                style={{ width: `${Math.min(100, spendYesterday / officialDailyLimit * 100)}%` }} />
            </div>
          </div>
        )}
        {budgetCfg?.next_weekly_recalculation && (
          <p className="text-[10px] text-slate-600 mt-2">
            Próximo recálculo: {new Date(budgetCfg.next_weekly_recalculation).toLocaleDateString('pt-BR')}
          </p>
        )}
      </div>

      {/* ── 7. METAS VS REALIDADE ────────────────────────────────────────────── */}
      {(targetAcos > 0 || targetRoas > 0 || targetTacos > 0) && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-300">Metas vs realidade</h2>
            <span className="text-[10px] text-slate-500">Período: {periodLabel}</span>
          </div>
          <div className="space-y-0">
            <GoalRow label="ACoS" real={kpis.acos} target={targetAcos} unit="%" lowerIsBetter />
            {maxAcos > 0 && <GoalRow label="ACoS máximo" real={kpis.acos} target={maxAcos} unit="%" lowerIsBetter />}
            <GoalRow label="ROAS" real={kpis.roas} target={targetRoas} unit="x" lowerIsBetter={false} realLabel={kpis.roas > 0 ? `${kpis.roas.toFixed(2)}x` : '—'} />
            <GoalRow label="TACoS alvo" real={0} target={targetTacos} unit="%" lowerIsBetter />
            {targetCpc > 0 && <GoalRow label="CPC alvo" real={kpis.cpc} target={targetCpc} unit="" lowerIsBetter realLabel={kpis.cpc > 0 ? fmtBRL(kpis.cpc) : '—'} />}
            {maxCpc > 0 && <GoalRow label="CPC máximo" real={kpis.cpc} target={maxCpc} unit="" lowerIsBetter realLabel={kpis.cpc > 0 ? fmtBRL(kpis.cpc) : '—'} />}
            {officialDailyLimit > 0 && <GoalRow label="Budget D-1" real={spendYesterday} target={officialDailyLimit} unit="" lowerIsBetter realLabel={fmtBRL(spendYesterday)} />}
          </div>
          {!targetAcos && !targetRoas && !targetTacos && (
            <p className="text-xs text-slate-500">
              Nenhuma meta configurada. <Link to="/settings" className="text-cyan hover:underline">Configurar →</Link>
            </p>
          )}
        </div>
      )}

      {/* ── 8. RESUMO DE DECISÕES ────────────────────────────────────────────── */}
      {(decisions.length > 0 || bidChanges.length > 0) && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-300">Decisões e automação</h2>
            <Link to="/sala-de-comando" className="text-xs text-cyan hover:underline">Sala de Controle →</Link>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="bg-surface-2 rounded-lg p-3">
              <p className="text-[10px] text-slate-500 mb-1">Decisões pendentes</p>
              <p className={`text-xl font-bold ${decisions.length > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>{decisions.length}</p>
            </div>
            <div className="bg-surface-2 rounded-lg p-3">
              <p className="text-[10px] text-slate-500 mb-1">Alterações 30d (IA)</p>
              <p className="text-xl font-bold text-white">{totalChanges}</p>
            </div>
            <div className="bg-surface-2 rounded-lg p-3">
              <p className="text-[10px] text-slate-500 mb-1">Último sync</p>
              <p className="text-sm font-semibold text-slate-300">
                {lastSyncInfo ? new Date(lastSyncInfo.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── 9. LINKS PARA ANÁLISES PROFUNDAS ────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { to: '/analytics', icon: BarChart2, label: 'Analytics', sub: 'Análise detalhada', color: 'text-cyan' },
          { to: '/ads', icon: Megaphone, label: 'Campanhas', sub: 'Gerenciar anúncios', color: 'text-emerald-400' },
          { to: '/term-bank', icon: BookOpen, label: 'Term Bank', sub: 'Palavras-chave', color: 'text-amber-400' },
          { to: '/sala-de-comando', icon: Terminal, label: 'Sala de Controle', sub: 'Operações e filas', color: 'text-violet-400' },
        ].map(({ to, icon: Icon, label, sub, color }) => (
          <Link key={to} to={to}
            className="bg-surface-1 border border-surface-2 hover:border-surface-3 rounded-xl p-4 flex items-center gap-3 transition-colors group">
            <div className="w-8 h-8 rounded-lg bg-surface-2 flex items-center justify-center flex-shrink-0">
              <Icon className={`w-4 h-4 ${color}`} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-300 group-hover:text-white transition-colors">{label}</p>
              <p className="text-[10px] text-slate-600">{sub}</p>
            </div>
          </Link>
        ))}
      </div>

    </div>
  );
}