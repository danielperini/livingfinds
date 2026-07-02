import React, { useState, useEffect, useCallback, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { loadAllCampaigns, classifyCampaigns } from '@/lib/campaignUtils';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Legend, LineChart, Line } from 'recharts';
import { BarChart2, Loader2, TrendingUp, TrendingDown, Minus, RefreshCw, AlertCircle, Brain, Zap, Clock, Activity, XCircle, Send, DollarSign } from 'lucide-react';
import { Button } from '@/components/ui/button';
import StatusBadge from '@/components/ui/StatusBadge';
import { Link } from 'react-router-dom';
import Analytics from '@/pages/Analytics';

function KPICard({ label, value, unit, sub, inverse, loading }) {
  if (loading) return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 animate-pulse">
      <div className="h-3 w-24 bg-surface-3 rounded mb-3" />
      <div className="h-7 w-32 bg-surface-3 rounded mb-2" />
      <div className="h-3 w-16 bg-surface-3 rounded" />
    </div>
  );
  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
      <p className="text-xs font-medium text-slate-400 mb-2">{label}</p>
      <p className="text-2xl font-bold text-white mb-1">{value}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

const SYNC_KEY = 'lf_sync_state';

function saveSyncState(data) {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(data)); } catch {}
}
function loadSyncState() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY) || 'null'); } catch { return null; }
}
function clearSyncState() {
  try { localStorage.removeItem(SYNC_KEY); } catch {}
}

function ReportSyncWidget({ amazonAccountId, onDone }) {
  const [state, setState] = useState('idle');
  const [msg, setMsg] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const pollRef = useRef(null);
  const timerRef = useRef(null);
  const pendingRef = useRef(null);
  const startTimeRef = useRef(null);

  const stopAll = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
  };

  const startElapsedTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setElapsed(startTimeRef.current ? Math.round((Date.now() - startTimeRef.current) / 1000) : 0);
    }, 1000);
  };

  const startPolling = (pending, campaigns_imported, report_errors) => {
    pendingRef.current = pending;
    setState('polling');
    setMsg(`✓ ${campaigns_imported} campanhas importadas. A aguardar relatórios Amazon...`);
    if (report_errors?.length > 0) setMsg(prev => prev + ` ⚠ ${report_errors.join(', ')}`);

    pollRef.current = setInterval(async () => {
      try {
        const r2 = await base44.functions.invoke('runFullSync', {
          amazon_account_id: amazonAccountId,
          action: 'download',
          ...pendingRef.current,
        });
        const d2 = r2.data;
        if (!d2?.ok && !d2?.ready) {
          stopAll(); clearSyncState();
          setState('error');
          setMsg(d2?.message || JSON.stringify(d2).slice(0, 200));
          setTimeout(() => { setState('idle'); setMsg(''); }, 15000);
          return;
        }
        if (d2.ready) {
          stopAll(); clearSyncState();
          setState('done');
          const sum = d2.summary || {};
          setMsg(`✓ Concluído — ${d2.campaigns_metrics || 0} camp. · ${d2.products || 0} prod. · ${d2.keywords || 0} kws · $${(sum.total_spend || 0).toFixed(2)} spend · $${(sum.total_sales || 0).toFixed(2)} vendas`);
          onDone?.();
        } else {
          const pend = Object.entries(d2.pending || {}).map(([k, v]) => `${k}:${v}`).join(', ');
          const fail = Object.keys(d2.failed || {}).length > 0 ? ` ⚠ falhou: ${Object.keys(d2.failed).join(',')}` : '';
          setMsg(`A aguardar Amazon... ${pend}${fail}`);
          saveSyncState({ reportIds: pendingRef.current.reportIds, syncRunId: pendingRef.current.syncRunId, startedAt: startTimeRef.current, campaigns_imported });
        }
      } catch (e) {
        stopAll(); clearSyncState();
        setState('error');
        setMsg(e.message);
        setTimeout(() => { setState('idle'); setMsg(''); }, 15000);
      }
    }, 30000);
  };

  useEffect(() => {
    const saved = loadSyncState();
    if (saved?.reportIds && amazonAccountId) {
      startTimeRef.current = saved.startedAt || Date.now();
      setElapsed(Math.round((Date.now() - startTimeRef.current) / 1000));
      startElapsedTimer();
      startPolling({ reportIds: saved.reportIds, syncRunId: saved.syncRunId }, saved.campaigns_imported || '?', []);
    }
    return stopAll;
  }, [amazonAccountId]);

  const request = async () => {
    stopAll();
    setState('requesting');
    startTimeRef.current = Date.now();
    setElapsed(0);
    setMsg('A importar campanhas e solicitar relatórios 30d...');
    try {
      const r1 = await base44.functions.invoke('runFullSync', { amazon_account_id: amazonAccountId, action: 'request' });
      const d1 = r1.data;
      if (!d1?.ok) {
        setState('error');
        setMsg(d1?.message || d1?.amazon_error || JSON.stringify(d1).slice(0, 200));
        setTimeout(() => { setState('idle'); setMsg(''); }, 15000);
        return;
      }
      startElapsedTimer();
      saveSyncState({ reportIds: d1.reportIds, syncRunId: d1.syncRunId, startedAt: startTimeRef.current, campaigns_imported: d1.campaigns_imported });
      startPolling({ reportIds: d1.reportIds, syncRunId: d1.syncRunId }, d1.campaigns_imported, d1.report_errors);
    } catch (e) {
      stopAll(); clearSyncState();
      setState('error');
      setMsg(e.message);
      setTimeout(() => { setState('idle'); setMsg(''); }, 15000);
    }
  };

  const isLoading = state === 'requesting' || state === 'polling';
  const color = state === 'done' ? 'border-emerald-400/30 text-emerald-400 bg-emerald-400/5'
    : state === 'error' ? 'border-red-400/30 text-red-400 bg-red-400/5'
    : 'border-cyan/20 text-cyan bg-cyan/5 hover:bg-cyan/10';

  const label = state === 'requesting' ? 'A solicitar...'
    : state === 'polling' ? `A aguardar Amazon... (${elapsed}s)`
    : state === 'done' ? 'Sync Concluído!'
    : 'Sync Amazon Ads 30d';

  return (
    <div className="flex flex-col gap-2">
      <button onClick={request} disabled={isLoading}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold border transition-all disabled:opacity-60 ${color}`}>
        {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
        {label}
      </button>
      {msg && <p className={`text-xs max-w-xs ${state === 'error' ? 'text-red-400' : 'text-slate-400'}`}>{msg}</p>}
    </div>
  );
}

export default function Dashboard() {
  const [user, setUser] = useState(null);
  const [account, setAccount] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [products, setProducts] = useState([]);
  const [metricsDaily, setMetricsDaily] = useState([]);
  const [hourlyMetrics, setHourlyMetrics] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [syncRuns, setSyncRuns] = useState([]);
  const [bidChanges, setBidChanges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [auditData, setAuditData] = useState(null);
  const [showAudit, setShowAudit] = useState(false);
  const [campFilter, setCampFilter] = useState('all');
  const [forcingSyncAds, setForcingSyncAds] = useState(false);
  const [forceSyncMsg, setForceSyncMsg] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await base44.auth.me();
      setUser(me);
      let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      if (!accounts.length) accounts = await base44.entities.AmazonAccount.list();
      const acc = accounts[0] || null;
      setAccount(acc);
      if (!acc) { setLoading(false); return; }

      const aid = acc.id;
      const [cams, prods, metrics, hourly, decs, runs, changes] = await Promise.all([
        loadAllCampaigns(aid),
        base44.entities.Product.filter({ amazon_account_id: aid }, '-total_sales_30d', 30),
        base44.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 120),
        base44.entities.HourlyMetric.filter({ amazon_account_id: aid }, '-date', 720),
        base44.entities.Decision.filter({ amazon_account_id: aid, status: 'pending' }, '-created_date', 10),
        base44.entities.SyncRun.filter({ amazon_account_id: aid }, '-started_at', 8),
        base44.entities.AdsBidChangeLog.filter({ amazon_account_id: aid }, '-created_at', 500),
      ]);

      setCampaigns(cams);
      setProducts(prods);
      setMetricsDaily(metrics);
      setHourlyMetrics(hourly);
      setDecisions(decs);
      setSyncRuns(runs);
      setBidChanges(changes);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const cutoffDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const metricsLast30Days = metricsDaily.filter(m => m.date >= cutoffDate);
  
  const uniqueMetricsMap = new Map();
  metricsLast30Days.forEach(m => {
    const key = `${m.campaign_id || ''}-${m.date}`;
    uniqueMetricsMap.set(key, m);
  });
  const uniqueMetrics = Array.from(uniqueMetricsMap.values());
  
  const kpis = uniqueMetrics.reduce((acc, m) => ({
    spend: acc.spend + (m.spend || 0),
    sales: acc.sales + (m.sales || 0),
    clicks: acc.clicks + (m.clicks || 0),
    impressions: acc.impressions + (m.impressions || 0),
    orders: acc.orders + (m.orders || 0),
  }), { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0 });

  const acos = kpis.sales > 0 ? (kpis.spend / kpis.sales * 100) : 0;
  const roas = kpis.spend > 0 ? (kpis.sales / kpis.spend) : 0;
  const ctr = kpis.impressions > 0 ? (kpis.clicks / kpis.impressions * 100) : 0;
  const cpc = kpis.clicks > 0 ? (kpis.spend / kpis.clicks) : 0;

  const chartData = Object.values(
    uniqueMetrics.reduce((acc, m) => {
      if (!acc[m.date]) acc[m.date] = { name: m.date?.slice(5) || '', date: m.date, spend: 0, sales: 0, orders: 0, clicks: 0 };
      acc[m.date].spend += m.spend || 0;
      acc[m.date].sales += m.sales || 0;
      acc[m.date].orders += m.orders || 0;
      acc[m.date].clicks += m.clicks || 0;
      return acc;
    }, {})
  ).sort((a, b) => a.date.localeCompare(b.date));

  const hourlyData = Object.values(
    hourlyMetrics.reduce((acc, h) => {
      const hour = h.hour ?? 0;
      if (!acc[hour]) acc[hour] = { hour: `${String(hour).padStart(2, '0')}:00`, clicks: 0, orders: 0, spend: 0, sales: 0, impressions: 0 };
      acc[hour].clicks += h.clicks || 0;
      acc[hour].orders += h.orders || 0;
      acc[hour].spend += h.spend || 0;
      acc[hour].sales += h.sales || 0;
      acc[hour].impressions += h.impressions || 0;
      return acc;
    }, {})
  ).sort((a, b) => parseInt(a.hour) - parseInt(b.hour)).map(h => ({
    ...h,
    cvr: h.clicks > 0 ? safe(h.orders / h.clicks * 100) : 0,
    cpc: h.clicks > 0 ? safe(h.spend / h.clicks) : 0,
    roas: h.spend > 0 ? safe(h.sales / h.spend) : 0,
  }));

  function safe(num, decimals = 2) {
    if (!num || !isFinite(num) || isNaN(num)) return 0;
    return Number(num.toFixed(decimals));
  }

  const forceAdsSync = async () => {
    if (!account || forcingSyncAds) return;
    setForcingSyncAds(true);
    setForceSyncMsg(null);
    try {
      const res = await base44.functions.invoke('syncAdsQuick', { amazon_account_id: account.id });
      if (res?.data?.ok) {
        setForceSyncMsg({ type: 'success', text: `✓ ${res.data.campaigns_updated || 0} campanhas atualizadas` });
        await loadData();
      } else {
        setForceSyncMsg({ type: 'error', text: res?.data?.error || 'Falha ao sincronizar' });
      }
    } catch (e) {
      setForceSyncMsg({ type: 'error', text: e.message });
    } finally {
      setForcingSyncAds(false);
      setTimeout(() => setForceSyncMsg(null), 8000);
    }
  };

  const [forcingMasterSync, setForcingMasterSync] = useState(false);
  const [masterSyncMsg, setMasterSyncMsg] = useState(null);

  const forceMasterSync = async () => {
    if (!account || forcingMasterSync) return;
    setForcingMasterSync(true);
    setMasterSyncMsg({ type: 'info', text: 'Buscando dados da Amazon... pode levar alguns minutos.' });
    try {
      const res = await base44.functions.invoke('runDailyMasterSync', { amazon_account_id: account.id });
      if (res?.data?.ok) {
        const s = res.data.summary || {};
        setMasterSyncMsg({ type: 'success', text: `✓ Sync completo — ${s.campaigns_updated || 0} camp. · ${s.keywords_updated || 0} kws · ${s.products_updated || 0} prod.` });
        await loadData();
      } else {
        setMasterSyncMsg({ type: 'error', text: res?.data?.error || res?.data?.message || 'Falha no sync' });
      }
    } catch (e) {
      setMasterSyncMsg({ type: 'error', text: e.message });
    } finally {
      setForcingMasterSync(false);
      setTimeout(() => setMasterSyncMsg(null), 12000);
    }
  };

  const runAudit = async () => {
    if (!account) return;
    try {
      const res = await base44.functions.invoke('auditSyncData', { amazon_account_id: account.id });
      if (res.data?.ok) {
        setAuditData(res.data);
        setShowAudit(true);
      } else {
        alert('Erro na auditoria: ' + (res.data?.error || 'Falha desconhecida'));
      }
    } catch (error) {
      alert('Erro: ' + error.message);
    }
  };

  useEffect(() => {
    if (!loading && kpis.spend > 0) {
      console.log('📊 AUDITORIA DASHBOARD:', {
        'Ad Spend': `$${kpis.spend.toFixed(2)}`,
        'Vendas': `$${kpis.sales.toFixed(2)}`,
        'Pedidos': kpis.orders,
        'Cliques': kpis.clicks,
        'ACoS': `${acos.toFixed(2)}%`,
        'ROAS': `${roas.toFixed(2)}x`,
        'Registros diários': metricsDaily.length,
        'Registros únicos': uniqueMetrics.length,
        'Duplicatas': metricsDaily.length - uniqueMetrics.length,
      });
    }
  }, [loading, kpis, metricsDaily.length, uniqueMetrics.length]);

  // Heat map data - dias do mês vs horas
  const heatMapData = hourlyMetrics.reduce((acc, h) => {
    const day = h.date ? new Date(h.date).getDate() : 1;
    const hour = h.hour ?? 0;
    const key = `${day}-${hour}`;
    if (!acc[key]) {
      acc[key] = { day, hour, spend: 0, sales: 0, impressions: 0, clicks: 0, active: false };
    }
    acc[key].spend += h.spend || 0;
    acc[key].sales += h.sales || 0;
    acc[key].impressions += h.impressions || 0;
    acc[key].clicks += h.clicks || 0;
    acc[key].active = acc[key].spend > 0;
    return acc;
  }, {});
  const heatMapArray = Object.values(heatMapData);

  // Budget: agrupar spend por dia (deduplicando campanhas) para obter spend diário real
  const twentyDaysAgo = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
  const spendByDay = metricsDaily
    .filter(m => m.date >= twentyDaysAgo)
    .reduce((acc, m) => {
      // Deduplicar: somar apenas registros únicos por campanha+dia
      const key = `${m.campaign_id || 'no-camp'}-${m.date}`;
      if (!acc._seen) acc._seen = new Set();
      if (acc._seen.has(key)) return acc;
      acc._seen.add(key);
      acc[m.date] = (acc[m.date] || 0) + (m.spend || 0);
      return acc;
    }, {});
  delete spendByDay._seen;
  const spendDays = Object.values(spendByDay);
  const avgDailySpend = spendDays.length > 0
    ? spendDays.reduce((s, v) => s + v, 0) / spendDays.length
    : 0;

  // Dias únicos com dados reais — base para o modo aprendizado
  const uniqueDaysWithDataAll = new Set(metricsDaily.map(m => m.date)).size;
  // Threshold: 20 dias para garantir dados maduros
  const isLearningMode = uniqueDaysWithDataAll < 20;

  const totalProducts = products.length;
  // Budget sugerido = média real dos últimos 20 dias + 20%, sem exceder 2× o total de budgets ativos
  const { active: activeCampaignsList, paused: pausedCampaignsList, archived: archivedCampaignsList, active_count, paused_count, archived_count, total_current } = classifyCampaigns(campaigns);
  const activeCampaignsBudget = activeCampaignsList.reduce((s, c) => s + (c.daily_budget || 0), 0);
  const suggestedBudget = isLearningMode
    ? 0
    : avgDailySpend > 0
      ? Math.min(avgDailySpend * 1.2, Math.max(activeCampaignsBudget, avgDailySpend * 1.5))
      : activeCampaignsBudget || 0;

  // Alterações diárias
  const changesByDay = bidChanges.reduce((acc, change) => {
    const date = change.created_at ? new Date(change.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : 'N/A';
    if (!acc[date]) acc[date] = { date, changes: 0 };
    acc[date].changes++;
    return acc;
  }, {});
  const changesChartData = Object.values(changesByDay).sort((a, b) => {
    const [d1, m1] = a.date.split('/');
    const [d2, m2] = b.date.split('/');
    return new Date(2026, m1-1, d1) - new Date(2026, m2-1, d2);
  });
  const totalChanges = bidChanges.length;

  const [mainTab, setMainTab] = useState('dashboard');

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const firstName = user?.full_name?.split(' ')[0] || 'gestor';
  const lastSync = account?.last_sync_at ? new Date(account.last_sync_at).toLocaleString('pt-BR') : null;

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-white">{greeting}, {firstName}.</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            {decisions.length > 0
              ? <><span className="text-amber-400 font-semibold">{decisions.length}</span> recomendações IA pendentes · </>
              : 'Sem recomendações pendentes · '}
            {lastSync ? `Último sync: ${lastSync}` : 'Nenhum sync realizado'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {account && <ReportSyncWidget amazonAccountId={account.id} onDone={loadData} />}
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              <button onClick={forceAdsSync} disabled={forcingSyncAds || forcingMasterSync || !account}
                className="flex items-center gap-2 px-3 py-2 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 text-sm font-semibold rounded-lg transition-colors disabled:opacity-50">
                <RefreshCw className={`w-4 h-4 ${forcingSyncAds ? 'animate-spin' : ''}`} />
                {forcingSyncAds ? 'Atualizando...' : 'Atualizar Ads'}
              </button>
              <button onClick={forceMasterSync} disabled={forcingMasterSync || forcingSyncAds || !account}
                className="flex items-center gap-2 px-3 py-2 bg-purple-500/10 border border-purple-500/20 text-purple-400 hover:bg-purple-500/20 text-sm font-semibold rounded-lg transition-colors disabled:opacity-50"
                title="Busca dados completos de vendas e gastos diretamente da Amazon (demora ~2 min)">
                <Zap className={`w-4 h-4 ${forcingMasterSync ? 'animate-spin' : ''}`} />
                {forcingMasterSync ? 'Sincronizando...' : 'Sync Completo'}
              </button>
            </div>
            {forceSyncMsg && (
              <p className={`text-xs ${forceSyncMsg.type === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>{forceSyncMsg.text}</p>
            )}
            {masterSyncMsg && (
              <p className={`text-xs ${masterSyncMsg.type === 'success' ? 'text-emerald-400' : masterSyncMsg.type === 'error' ? 'text-red-400' : 'text-purple-400'}`}>{masterSyncMsg.text}</p>
            )}
          </div>
          <button onClick={loadData} disabled={loading}
            className="flex items-center gap-2 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm rounded-lg transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={runAudit} disabled={loading}
            className="flex items-center gap-2 px-3 py-2 bg-cyan/10 border border-cyan/20 text-cyan hover:bg-cyan/20 text-sm rounded-lg transition-colors">
            <Activity className="w-4 h-4" />
            Auditoria
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Tabs Dashboard / Analytics */}
      <div className="flex border-b border-surface-2">
        {[
          { id: 'dashboard', label: 'Dashboard' },
          { id: 'analytics', label: '📊 Analytics' },
        ].map(t => (
          <button key={t.id} onClick={() => setMainTab(t.id)}
            className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors ${mainTab === t.id ? 'border-cyan text-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {mainTab === 'analytics' && <Analytics />}
      {mainTab !== 'analytics' && <>

      {/* Painel de Auditoria de Dados */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold text-slate-400">📊 Auditoria de Dados (30 dias)</h3>
          <span className="text-[10px] text-slate-500">Fontes: CampaignMetricsDaily</span>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 text-xs">
          <div className="bg-surface-2 rounded-lg p-2">
            <p className="text-slate-500 mb-0.5">Registros diários</p>
            <p className="text-white font-semibold">{metricsDaily.length}</p>
          </div>
          <div className="bg-surface-2 rounded-lg p-2">
            <p className="text-slate-500 mb-0.5">Registros únicos</p>
            <p className="text-white font-semibold">{uniqueMetrics.length}</p>
          </div>
          <div className="bg-surface-2 rounded-lg p-2">
            <p className="text-slate-500 mb-0.5">Duplicatas removidas</p>
            <p className="text-amber-400 font-semibold">{metricsDaily.length - uniqueMetrics.length}</p>
          </div>
          <div className="bg-surface-2 rounded-lg p-2">
            <p className="text-slate-500 mb-0.5">Campanhas ativas</p>
            <p className="text-emerald-400 font-semibold">{active_count}</p>
          </div>
          <div className="bg-surface-2 rounded-lg p-2">
            <p className="text-slate-500 mb-0.5">Operacionais / Total</p>
            <p className="text-white font-semibold">{total_current} / {campaigns.length}</p>
          </div>
          <div className="bg-surface-2 rounded-lg p-2">
            <p className="text-slate-500 mb-0.5">Data corte</p>
            <p className="text-cyan font-mono text-[10px]">{cutoffDate}</p>
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard label="✓ Ad Spend 30d" value={`$${kpis.spend.toFixed(2)}`} sub={`${active_count} ativas · ${paused_count} pausadas`} loading={loading} />
        <KPICard label="Vendas Ads 30d" value={`$${kpis.sales.toFixed(2)}`} sub={`${kpis.orders} pedidos`} loading={loading} />
        <KPICard label="ACoS" value={`${acos.toFixed(1)}%`} sub={`ROAS: ${roas.toFixed(2)}x`} loading={loading} />
        <KPICard label="CPC Médio" value={`$${cpc.toFixed(2)}`} sub={`CTR: ${ctr.toFixed(2)}%`} loading={loading} />
      </div>

      {/* Cards de Análise Avançada */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Heat Map - Horário de Veiculação */}
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
              <Clock className="w-4 h-4 text-cyan" />
              Horário de Veiculação dos Ads
            </h2>
            <span className="text-xs text-slate-500">Últimos 30 dias</span>
          </div>
          {loading ? (
            <div className="h-64 flex items-center justify-center"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
          ) : heatMapArray.length > 0 ? (
            <div className="overflow-x-auto">
              <div className="min-w-[600px]">
                <div className="grid gap-1" style={{ gridTemplateColumns: '40px repeat(24, 1fr)' }}>
                  {/* Header - Horas */}
                  <div className="text-[9px] text-slate-500 font-semibold">Dia</div>
                  {Array.from({ length: 24 }, (_, h) => (
                    <div key={h} className="text-[9px] text-slate-500 text-center font-semibold">{h}</div>
                  ))}
                  
                  {/* Dias */}
                  {Array.from({ length: 30 }, (_, d) => (
                    <React.Fragment key={d}>
                      <div className="text-[9px] text-slate-400 text-right pr-2">{d + 1}</div>
                      {Array.from({ length: 24 }, (_, h) => {
                        const cell = heatMapArray.find(c => c.day === d + 1 && c.hour === h);
                        const intensity = cell 
                          ? cell.spend > 5 ? 'bg-cyan/60' 
                            : cell.spend > 2 ? 'bg-cyan/40'
                            : cell.spend > 0 ? 'bg-cyan/20'
                            : 'bg-surface-2'
                          : 'bg-surface-2';
                        const isBudgetExceeded = cell && cell.spend > 10;
                        return (
                          <div
                            key={h}
                            className={`h-3 rounded-sm ${intensity} ${isBudgetExceeded ? 'ring-1 ring-amber-400/50' : ''}`}
                            title={`Dia ${d + 1} · ${h}:00 · Spend: $${(cell?.spend || 0).toFixed(2)}`}
                          />
                        );
                      })}
                    </React.Fragment>
                  ))}
                </div>
                <div className="flex items-center gap-4 mt-3 text-[10px] text-slate-500">
                  <div className="flex items-center gap-1">
                    <div className="w-3 h-3 rounded-sm bg-surface-2" /> Sem veiculação
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="w-3 h-3 rounded-sm bg-cyan/20" /> Baixo spend
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="w-3 h-3 rounded-sm bg-cyan/40" /> Médio spend
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="w-3 h-3 rounded-sm bg-cyan/60" /> Alto spend
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="w-3 h-3 rounded-sm ring-1 ring-amber-400/50" /> Budget excedido
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="h-64 flex flex-col items-center justify-center text-sm text-slate-500">
              <Clock className="w-8 h-8 text-slate-600 mb-2" />
              Sem dados horários. Execute um Sync completo.
            </div>
          )}
        </div>

        {/* Sugestão de Budget */}
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <DollarSign className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-slate-300">Sugestão de Budget Diário</h2>
          </div>
          {loading ? (
            <div className="h-40 flex items-center justify-center"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
          ) : isLearningMode ? (
            <div className="space-y-4">
              <div className="text-center py-6 bg-cyan/5 rounded-lg border border-cyan/20">
                <Brain className="w-8 h-8 text-cyan mx-auto mb-2" />
                <p className="text-lg font-bold text-cyan mb-1">Em aprendizado</p>
                <p className="text-xs text-slate-400">
                  {Math.max(0, 20 - uniqueDaysWithDataAll)} dias restantes para calcular
                </p>
                <p className="text-[10px] text-slate-500 mt-2">
                  Coletando dados de {uniqueDaysWithDataAll}/20 dias
                </p>
              </div>
              
              <div className="bg-cyan/5 border border-cyan/20 rounded-lg p-3 text-[10px] text-cyan">
                <p className="font-semibold mb-1">📊 Fase de aprendizado</p>
                <p>O sistema precisa de 20 dias de dados históricos para calcular o budget ideal com base no spend médio real deduplificado.</p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="text-center py-3 bg-surface-2 rounded-lg border border-surface-3">
                <p className="text-xs text-slate-500 mb-1">Budget Sugerido</p>
                <p className="text-2xl font-bold text-emerald-400">${suggestedBudget.toFixed(2)}</p>
                <p className="text-[10px] text-slate-500 mt-1">por dia</p>
              </div>
              
              <div className="space-y-2 text-xs">
                <div className="flex justify-between py-1.5 border-b border-surface-2">
                 <span className="text-slate-500">Spend médio real (20d)</span>
                 <span className="text-white font-semibold">R${avgDailySpend.toFixed(2)}/dia</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-surface-2">
                 <span className="text-slate-500">Dias com dados</span>
                 <span className="text-white font-semibold">{uniqueDaysWithDataAll} dias</span>
                </div>
                <div className="flex justify-between py-1.5 border-b border-surface-2">
                 <span className="text-slate-500">Budget total ativo</span>
                 <span className="text-white font-semibold">R${activeCampaignsBudget.toFixed(2)}/dia</span>
                </div>
                <div className="flex justify-between py-1.5">
                  <span className="text-slate-500">Campanhas ativas</span>
                  <span className="text-emerald-400 font-semibold">{active_count}</span>
                </div>
              </div>

              <div className="bg-cyan/5 border border-cyan/20 rounded-lg p-3 text-[10px] text-cyan">
                <p className="font-semibold mb-1">Como calculamos:</p>
                <p>Spend médio real dos últimos 20 dias (deduplicado por campanha/dia) + 20% de margem de crescimento, limitado ao budget total ativo atual.</p>
              </div>
            </div>
          )}
        </div>

        {/* Gráfico de Alterações Enviadas */}
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 lg:col-span-3">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Send className="w-4 h-4 text-amber-400" />
              <h2 className="text-sm font-semibold text-slate-300">Alterações Enviadas para Amazon</h2>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">Total: </span>
              <span className="text-sm font-bold text-amber-400">{totalChanges}</span>
            </div>
          </div>
          {loading ? (
            <div className="h-40 flex items-center justify-center"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
          ) : changesChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={changesChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip 
                  contentStyle={{ background: '#111318', border: '1px solid #1A1D26', borderRadius: 8, fontSize: 12 }}
                  formatter={(v) => [`${v} alterações`, 'Envios']}
                />
                <Bar dataKey="changes" fill="#F59E0B" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-40 flex flex-col items-center justify-center text-sm text-slate-500">
              <Send className="w-8 h-8 text-slate-600 mb-2" />
              Nenhuma alteração enviada ainda.
            </div>
          )}
        </div>
      </div>

      {/* Gráfico Spend vs Vendas */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-slate-300 mb-4">Spend vs Vendas — 30 dias</h2>
        {loading ? <div className="h-52 flex items-center justify-center"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div> : chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={210}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="gSpend" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3B82F6" stopOpacity={0.25} /><stop offset="95%" stopColor="#3B82F6" stopOpacity={0} /></linearGradient>
                <linearGradient id="gSales" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#10B981" stopOpacity={0.25} /><stop offset="95%" stopColor="#10B981" stopOpacity={0} /></linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ background: '#111318', border: '1px solid #1A1D26', borderRadius: 8, fontSize: 12 }} formatter={(v) => `$${Number(v).toFixed(2)}`} />
              <Area type="monotone" dataKey="spend" stroke="#3B82F6" fill="url(#gSpend)" strokeWidth={2} name="Spend" />
              <Area type="monotone" dataKey="sales" stroke="#10B981" fill="url(#gSales)" strokeWidth={2} name="Vendas" />
            </AreaChart>
          </ResponsiveContainer>
        ) : <div className="h-52 flex items-center justify-center text-sm text-slate-500">Sem dados. Execute um Sync.</div>}
      </div>

      {/* Campanhas */}
      {(() => {
        const activeCamps = activeCampaignsList;
        const pausedCamps = pausedCampaignsList;
        const archivedCamps = archivedCampaignsList;

        const filtered = campFilter === 'active' ? activeCamps
          : campFilter === 'paused' ? pausedCamps
          : campFilter === 'archived' ? archivedCamps
          : campaigns;

        const sorted = [...filtered].sort((a, b) => (b.spend || 0) - (a.spend || 0) || new Date(b.created_date || 0) - new Date(a.created_date || 0)).slice(0, 25);

        function CampStatusBadge({ c }) {
          if (c.archived || c.state === 'archived' || c.status === 'archived') {
            return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-500/15 text-slate-400 border border-slate-500/20">Encerrada</span>;
          }
          if (c.state === 'paused' || c.status === 'paused') {
            return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-400 border border-amber-500/20">Pausada</span>;
          }
          if (c.state === 'enabled' || c.status === 'enabled') {
            return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"><span className="w-1 h-1 rounded-full bg-emerald-400" />Ativa</span>;
          }
          return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-500/10 text-slate-500 border border-slate-500/15">Indisponível</span>;
        }

        return (
          <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-surface-2 flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <h2 className="text-sm font-semibold text-slate-300">Campanhas</h2>
                <div className="flex items-center gap-1">
                  {[
                    { key: 'all', label: `Todas (${campaigns.length})` },
                    { key: 'active', label: `Ativas (${activeCamps.length})` },
                    { key: 'paused', label: `Pausadas (${pausedCamps.length})` },
                    { key: 'archived', label: `Encerradas (${archivedCamps.length})` },
                  ].map(f => (
                    <button key={f.key} onClick={() => setCampFilter(f.key)}
                      className={`text-xs px-2.5 py-1 rounded-full border transition-colors whitespace-nowrap ${campFilter === f.key ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'}`}>
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
              <Link to="/ads" className="text-xs text-cyan hover:underline">Ver todas →</Link>
            </div>
            {loading ? (
              <div className="p-8 flex items-center justify-center"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
            ) : sorted.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">Nenhuma campanha encontrada</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-surface-2">
                      {['Status', 'Nome', 'Spend', 'Vendas', 'ACoS', 'ROAS'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map(c => {
                      const isInactive = c.archived || c.state === 'archived' || c.state === 'paused' || c.status === 'paused' || c.status === 'archived';
                      return (
                        <tr key={c.id} className={`border-b border-surface-2/50 hover:bg-surface-2 transition-colors ${isInactive ? 'opacity-60' : ''}`}>
                          <td className="px-4 py-3"><CampStatusBadge c={c} /></td>
                          <td className="px-4 py-3 text-white font-medium truncate max-w-[200px]">{c.name || c.campaign_name || '—'}</td>
                          <td className="px-4 py-3 text-slate-300">${(c.spend || 0).toFixed(2)}</td>
                          <td className="px-4 py-3 text-emerald-400">${(c.sales || 0).toFixed(2)}</td>
                          <td className={`px-4 py-3 font-semibold ${(c.acos || 0) > 50 ? 'text-red-400' : (c.acos || 0) > 30 ? 'text-amber-400' : (c.acos || 0) > 0 ? 'text-emerald-400' : 'text-slate-500'}`}>{(c.acos || 0).toFixed(1)}%</td>
                          <td className="px-4 py-3 text-slate-300">{(c.roas || 0).toFixed(2)}x</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })()}

      </>}

      {/* Modal de Auditoria */}
      {showAudit && auditData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={e => e.target === e.currentTarget && setShowAudit(false)}>
          <div className="bg-surface-1 border border-surface-2 rounded-2xl w-full max-w-4xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-surface-2">
              <div>
                <h2 className="text-sm font-bold text-white">📊 Auditoria de Dados Amazon</h2>
                <p className="text-xs text-slate-400 font-mono">{auditData.account?.seller_name || auditData.account?.id}</p>
              </div>
              <button onClick={() => setShowAudit(false)} className="text-slate-500 hover:text-white">
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Totais */}
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                <div className="bg-surface-2 rounded-xl p-4 border border-surface-3">
                  <p className="text-xs text-slate-500 mb-1">Spend</p>
                  <p className="text-lg font-bold text-white">{auditData.formatted?.spend}</p>
                </div>
                <div className="bg-surface-2 rounded-xl p-4 border border-surface-3">
                  <p className="text-xs text-slate-500 mb-1">Vendas</p>
                  <p className="text-lg font-bold text-emerald-400">{auditData.formatted?.sales}</p>
                </div>
                <div className="bg-surface-2 rounded-xl p-4 border border-surface-3">
                  <p className="text-xs text-slate-500 mb-1">ACoS</p>
                  <p className="text-lg font-bold text-amber-400">{auditData.formatted?.acos}</p>
                </div>
                <div className="bg-surface-2 rounded-xl p-4 border border-surface-3">
                  <p className="text-xs text-slate-500 mb-1">ROAS</p>
                  <p className="text-lg font-bold text-cyan">{auditData.formatted?.roas}</p>
                </div>
                <div className="bg-surface-2 rounded-xl p-4 border border-surface-3">
                  <p className="text-xs text-slate-500 mb-1">CPC</p>
                  <p className="text-lg font-bold text-slate-300">{auditData.formatted?.cpc}</p>
                </div>
              </div>

              {/* Qualidade */}
              <div className="bg-surface-2 rounded-xl p-4 border border-surface-3">
                <h3 className="text-xs font-semibold text-slate-400 mb-3">Qualidade dos Dados</h3>
                <div className="space-y-2 text-xs">
                  <div className="flex items-center justify-between py-1.5 border-b border-surface-3/50"><span className="text-slate-500">Total:</span><span className="text-white font-semibold">{auditData.metrics?.total_records}</span></div>
                  <div className="flex items-center justify-between py-1.5 border-b border-surface-3/50"><span className="text-slate-500">Únicos:</span><span className="text-emerald-400 font-semibold">{auditData.metrics?.unique_records}</span></div>
                  <div className="flex items-center justify-between py-1.5"><span className="text-slate-500">Duplicatas:</span><span className={`font-semibold ${auditData.metrics?.duplicates_removed > 0 ? 'text-amber-400' : 'text-emerald-400'}`}>{auditData.metrics?.duplicates_removed}</span></div>
                </div>
              </div>

              {/* Campanhas */}
              <div className="bg-surface-2 rounded-xl p-4 border border-surface-3">
                <h3 className="text-xs font-semibold text-slate-400 mb-3">Campanhas</h3>
                <div className="grid grid-cols-4 gap-3 text-center">
                  <div><p className="text-xs text-slate-500">Total</p><p className="text-lg font-bold text-white">{auditData.campaigns?.total}</p></div>
                  <div><p className="text-xs text-slate-500">Ativas</p><p className="text-lg font-bold text-emerald-400">{auditData.campaigns?.active}</p></div>
                  <div><p className="text-xs text-slate-500">Pausadas</p><p className="text-lg font-bold text-amber-400">{auditData.campaigns?.paused}</p></div>
                  <div><p className="text-xs text-slate-500">Arquivadas</p><p className="text-lg font-bold text-slate-400">{auditData.campaigns?.archived}</p></div>
                </div>
              </div>

              {/* Nota */}
              <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4">
                <p className="text-xs text-amber-300"><strong>⚠️ Nota:</strong> Divergências podem indicar necessidade de novo sync. Dados Amazon levam 48h para atribuição completa.</p>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-surface-2 flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => setShowAudit(false)}>Fechar</Button>
              <Button onClick={() => { setShowAudit(false); loadData(); }}>Atualizar</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}