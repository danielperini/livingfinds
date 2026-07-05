import React, { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { loadAllCampaigns, classifyCampaigns } from '@/lib/campaignUtils';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Legend, LineChart, Line } from 'recharts';
import { Loader2, RefreshCw, AlertCircle, Clock, Send, DollarSign, Eye, MousePointer, FileDown } from 'lucide-react';
import BudgetSuggestionCard from '@/components/dashboard/BudgetSuggestionCard';
import BudgetReport14d from '@/components/dashboard/BudgetReport14d';
import BudgetOverrunPanel from '@/components/dashboard/BudgetOverrunPanel';
import SpendRevenueBarChart from '@/components/dashboard/SpendRevenueBarChart';

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



async function loadAllBidChanges(amazonAccountId) {
  const rows = [];
  const pageSize = 200;
  let offset = 0;

  while (true) {
    const page = await base44.entities.AdsBidChangeLog.filter(
      { amazon_account_id: amazonAccountId },
      '-created_at',
      pageSize,
      offset
    );
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return rows;
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
  const [campFilter, setCampFilter] = useState('all');
  const [autopilotConfig, setAutopilotConfig] = useState(null);
  const [forcingSyncAds, setForcingSyncAds] = useState(false);
  const [forceSyncMsg, setForceSyncMsg] = useState(null);
  const [loadingReports, setLoadingReports] = useState(false);
  const [loadReportsMsg, setLoadReportsMsg] = useState(null);
  const [lastSyncInfo, setLastSyncInfo] = useState(null);

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
      const [cams, prods, metrics, hourly, decs, runs, changes, apConfigs] = await Promise.all([
        loadAllCampaigns(aid),
        base44.entities.Product.filter({ amazon_account_id: aid }, '-fba_inventory', 30),
        base44.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 120),
        base44.entities.HourlyMetric.filter({ amazon_account_id: aid }, '-date', 720),
        base44.entities.OptimizationDecision.filter({ amazon_account_id: aid, status: 'pending' }, '-created_at', 10),
        base44.entities.SyncExecutionLog.filter({ amazon_account_id: aid }, '-started_at', 8),
        loadAllBidChanges(aid),
        base44.entities.AutopilotConfig.filter({ amazon_account_id: aid }),
      ]);

      setCampaigns(cams);
      setProducts(prods);
      setMetricsDaily(metrics);
      setHourlyMetrics(hourly);
      setDecisions(decs);
      setSyncRuns(runs);
      setBidChanges(changes);
      setAutopilotConfig(apConfigs[0] || null);

      // Última sincronização (manual ou automática)
      const lastSuccessRun = runs.find(r => r.status === 'success' || r.status === 'skipped_limit');
      if (lastSuccessRun) {
        setLastSyncInfo({
          at: lastSuccessRun.completed_at || lastSuccessRun.started_at,
          trigger: lastSuccessRun.trigger_type,
        });
      } else if (acc?.last_sync_at) {
        setLastSyncInfo({ at: acc.last_sync_at, trigger: 'automatic' });
      } else {
        setLastSyncInfo(null);
      }
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

  const loadFromReports = async () => {
    if (!account || loadingReports) return;
    setLoadingReports(true);
    setLoadReportsMsg(null);
    try {
      const res = await base44.functions.invoke('loadDashboardFromReports', { amazon_account_id: account.id });
      const data = res?.data || {};
      if (data?.ok) {
        setLoadReportsMsg({ type: 'success', text: `✓ ${data.created} criados · ${data.updated} atualizados (${data.duration_s}s)` });
        await loadData();
      } else {
        setLoadReportsMsg({ type: 'error', text: data?.error || 'Sem dados de relatório disponíveis' });
      }
    } catch (e) {
      setLoadReportsMsg({ type: 'error', text: e.message });
    } finally {
      setLoadingReports(false);
      setTimeout(() => setLoadReportsMsg(null), 15000);
    }
  };

  const triggerSync = async () => {
    if (!account || forcingSyncAds) return;
    setForcingSyncAds(true);
    setForceSyncMsg(null);
    try {
      // Sync leve: apenas estados das campanhas + métricas de performance
      const [statesRes, metricsRes] = await Promise.allSettled([
        base44.functions.invoke('syncAds', { amazon_account_id: account.id, trigger_type: 'manual' }),
        base44.functions.invoke('syncAdsPerformanceMetricsV2', { amazon_account_id: account.id, trigger_type: 'manual' }),
      ]);

      const statesData = statesRes.status === 'fulfilled' ? statesRes.value?.data : null;
      const metricsData = metricsRes.status === 'fulfilled' ? metricsRes.value?.data : null;

      const rateLimited =
        String(statesData?.error || '').toLowerCase().includes('rate limit') ||
        String(metricsData?.error || '').toLowerCase().includes('rate limit') ||
        String(statesRes.reason?.message || '').toLowerCase().includes('rate limit') ||
        String(metricsRes.reason?.message || '').toLowerCase().includes('rate limit');

      if (rateLimited) {
        setForceSyncMsg({ type: 'warn', text: '⚠️ Amazon em rate limit — aguarde alguns minutos e tente novamente.' });
      } else if (statesData?.ok || metricsData?.ok) {
        const camps = statesData?.campaigns_synced ?? statesData?.updated ?? 0;
        const metrics = metricsData?.records_processed ?? metricsData?.updated ?? 0;
        setForceSyncMsg({ type: 'success', text: `✓ ${camps} camp. · ${metrics} registros de métricas` });
        setLastSyncInfo({ at: new Date().toISOString(), trigger: 'manual' });
        await loadData();
      } else {
        const errMsg = statesData?.error || metricsData?.error || 'Falha no sync';
        setForceSyncMsg({ type: 'error', text: errMsg });
      }
    } catch (e) {
      setForceSyncMsg({ type: 'error', text: e.message });
    } finally {
      setForcingSyncAds(false);
      setTimeout(() => setForceSyncMsg(null), 12000);
    }
  };



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

  // Alterações enviadas à Amazon — 30 dias consecutivos, uma barra independente por dia.
const changesChartData = (() => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const firstDay = new Date(today);
  firstDay.setDate(today.getDate() - 29);

  const dateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const dailyCounts = new Map();

  bidChanges.forEach((change) => {
    if (!change.created_at) return;
    const createdAt = new Date(change.created_at);
    if (Number.isNaN(createdAt.getTime())) return;
    createdAt.setHours(0, 0, 0, 0);
    if (createdAt < firstDay || createdAt > today) return;
    const key = dateKey(createdAt);
    dailyCounts.set(key, (dailyCounts.get(key) || 0) + 1);
  });

  return Array.from({ length: 30 }, (_, index) => {
    const day = new Date(firstDay);
    day.setDate(firstDay.getDate() + index);
    const key = dateKey(day);
    return {
      dateKey: key,
      date: day.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
      fullDate: day.toLocaleDateString('pt-BR'),
      changes: dailyCounts.get(key) || 0,
    };
  });
})();
const totalChanges = changesChartData.reduce((sum, day) => sum + day.changes, 0);

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
              ? <><span className="text-amber-400 font-semibold">{decisions.length}</span> decisões IA pendentes · </>
              : 'Sem decisões pendentes · '}
            {lastSync ? `Último sync: ${lastSync}` : 'Nenhum sync realizado'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {/* Sync unificado */}
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              <div className="flex flex-col items-end gap-1">
                <button onClick={loadFromReports} disabled={loadingReports || !account}
                  className="flex items-center gap-2 px-4 py-2 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 text-sm font-semibold rounded-lg transition-colors disabled:opacity-50">
                  {loadingReports ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileDown className="w-4 h-4" />}
                  {loadingReports ? 'Carregando...' : 'Carregar Relatórios'}
                </button>
                {loadReportsMsg && (
                  <p className={`text-xs ${loadReportsMsg.type === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>{loadReportsMsg.text}</p>
                )}
              </div>
              <button onClick={triggerSync} disabled={forcingSyncAds || !account}
                className="flex items-center gap-2 px-4 py-2 bg-cyan/10 border border-cyan/20 text-cyan hover:bg-cyan/20 text-sm font-semibold rounded-lg transition-colors disabled:opacity-50">
                <RefreshCw className={`w-4 h-4 ${forcingSyncAds ? 'animate-spin' : ''}`} />
                {forcingSyncAds ? 'Sincronizando...' : 'Sincronizar Ads'}
              </button>
            </div>
            {/* Última atualização */}
            {lastSyncInfo && !forceSyncMsg && (
              <p className="text-[10px] text-slate-500 flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {new Date(lastSyncInfo.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                <span className={`px-1 py-0.5 rounded text-[9px] font-semibold border ${lastSyncInfo.trigger === 'manual' ? 'bg-cyan/10 text-cyan border-cyan/20' : 'bg-slate-500/10 text-slate-400 border-slate-500/20'}`}>
                  {lastSyncInfo.trigger === 'manual' ? 'Manual' : 'Auto'}
                </span>
              </p>
            )}
            {forceSyncMsg && (
              <p className={`text-xs ${forceSyncMsg.type === 'success' ? 'text-emerald-400' : forceSyncMsg.type === 'warn' ? 'text-amber-400' : 'text-red-400'}`}>{forceSyncMsg.text}</p>
            )}
          </div>
          <button onClick={loadData} disabled={loading}
            className="flex items-center gap-2 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm rounded-lg transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
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
          { id: 'budget14d', label: '💰 Budget 14d' },
          { id: 'analytics', label: '📊 Analytics' },
        ].map(t => (
          <button key={t.id} onClick={() => setMainTab(t.id)}
            className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors ${mainTab === t.id ? 'border-cyan text-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {mainTab === 'analytics' && <Analytics />}
      {mainTab === 'budget14d' && (
        <BudgetReport14d
          metricsDaily={metricsDaily}
          campaigns={campaigns}
          loading={loading}
          sym={account?.currency_symbol || 'R$'}
        />
      )}
      {mainTab !== 'analytics' && mainTab !== 'budget14d' && <>

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
        <KPICard label="Ad Spend 30d" value={`R$${kpis.spend.toFixed(2)}`} sub={`${active_count} ativas · ${paused_count} pausadas`} loading={loading} />
        <KPICard label="Vendas Ads 30d" value={`R$${kpis.sales.toFixed(2)}`} sub={`${kpis.orders} pedidos`} loading={loading} />
        <KPICard label="ACoS" value={`${acos.toFixed(1)}%`} sub={`ROAS: ${roas.toFixed(2)}x`} loading={loading} />
        <KPICard label="CPC Médio" value={`R$${cpc.toFixed(2)}`} sub={`CTR: ${ctr.toFixed(2)}%`} loading={loading} />
      </div>

      {/* Painel Orçamento em Risco */}
      <BudgetOverrunPanel
        campaigns={campaigns}
        metricsDaily={metricsDaily}
        loading={loading}
        sym={account?.currency_symbol || 'R$'}
      />

      {/* Painel 48h */}
      {(() => {
        const cutoff48h = new Date(Date.now() - 48 * 3600000).toISOString().slice(0, 10);
        const metrics48h = uniqueMetrics.filter(m => m.date >= cutoff48h);
        const kpi48 = metrics48h.reduce((acc, m) => ({
          spend: acc.spend + (m.spend || 0),
          impressions: acc.impressions + (m.impressions || 0),
          clicks: acc.clicks + (m.clicks || 0),
        }), { spend: 0, impressions: 0, clicks: 0 });
        const ctr48 = kpi48.impressions > 0 ? (kpi48.clicks / kpi48.impressions * 100) : 0;
        const cpc48 = kpi48.clicks > 0 ? (kpi48.spend / kpi48.clicks) : 0;
        const sym = account?.currency_symbol || 'R$';
        return (
          <div className="bg-surface-1 border border-cyan/20 rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-cyan animate-pulse" />
                <h3 className="text-xs font-semibold text-cyan">Últimas 48 horas</h3>
              </div>
              <span className="text-[10px] text-slate-500">{metrics48h.length} registros</span>
            </div>
            {loading ? (
              <div className="flex items-center gap-2"><Loader2 className="w-4 h-4 text-cyan animate-spin" /><span className="text-xs text-slate-500">Carregando...</span></div>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
                <div className="bg-surface-2 rounded-lg p-3">
                  <div className="flex items-center gap-1.5 mb-1"><DollarSign className="w-3 h-3 text-cyan" /><p className="text-[10px] text-slate-400">Gasto</p></div>
                  <p className="text-lg font-bold text-white">{sym}{kpi48.spend.toFixed(2)}</p>
                </div>
                <div className="bg-surface-2 rounded-lg p-3">
                  <div className="flex items-center gap-1.5 mb-1"><Eye className="w-3 h-3 text-purple-400" /><p className="text-[10px] text-slate-400">Impressões</p></div>
                  <p className="text-lg font-bold text-white">{kpi48.impressions.toLocaleString('pt-BR')}</p>
                </div>
                <div className="bg-surface-2 rounded-lg p-3">
                  <div className="flex items-center gap-1.5 mb-1"><MousePointer className="w-3 h-3 text-emerald-400" /><p className="text-[10px] text-slate-400">Cliques</p></div>
                  <p className="text-lg font-bold text-white">{kpi48.clicks.toLocaleString('pt-BR')}</p>
                </div>
                <div className="bg-surface-2 rounded-lg p-3">
                  <p className="text-[10px] text-slate-400 mb-1">CTR</p>
                  <p className="text-lg font-bold text-amber-400">{ctr48.toFixed(2)}%</p>
                </div>
                <div className="bg-surface-2 rounded-lg p-3">
                  <p className="text-[10px] text-slate-400 mb-1">CPC Médio</p>
                  <p className="text-lg font-bold text-slate-300">{sym}{cpc48.toFixed(2)}</p>
                </div>
              </div>
            )}
          </div>
        );
      })()}

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

        {/* Sugestão de Budget — IA */}
        <BudgetSuggestionCard
          metricsDaily={metricsDaily}
          campaigns={campaigns}
          products={products}
          loading={loading}
          autopilotConfig={autopilotConfig}
        />

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

      {/* Barras Gasto vs Receita */}
      <SpendRevenueBarChart chartData={chartData} loading={loading} sym={account?.currency_symbol || 'R$'} />

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
              <Tooltip contentStyle={{ background: '#111318', border: '1px solid #1A1D26', borderRadius: 8, fontSize: 12 }} formatter={(v) => `R$${Number(v).toFixed(2)}`} />
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
                          <td className="px-4 py-3 text-slate-300">R${(c.spend || 0).toFixed(2)}</td>
                          <td className="px-4 py-3 text-emerald-400">R${(c.sales || 0).toFixed(2)}</td>
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


    </div>
  );
}