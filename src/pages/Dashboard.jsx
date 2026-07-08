import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { loadAllCampaigns, classifyCampaigns } from '@/lib/campaignUtils';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Legend, LineChart, Line } from 'recharts';
import { Loader2, RefreshCw, AlertCircle, Clock, Send, DollarSign, Eye, MousePointer, Rocket, CheckCircle2, X } from 'lucide-react';
import BudgetSuggestionCard from '@/components/dashboard/BudgetSuggestionCard';
import BudgetReport14d from '@/components/dashboard/BudgetReport14d';
import BudgetOverrunPanel from '@/components/dashboard/BudgetOverrunPanel';
import SpendRevenueBarChart from '@/components/dashboard/SpendRevenueBarChart';
import GoalsComparisonPanel from '@/components/dashboard/GoalsComparisonPanel';
import BudgetAllocationPanel from '@/components/dashboard/BudgetAllocationPanel';
import CampaignPerformancePanel from '@/components/dashboard/CampaignPerformancePanel';
import WeeklyOptimizationSummary from '@/components/dashboard/WeeklyOptimizationSummary';
import SyncStatusBanner from '@/components/dashboard/SyncStatusBanner';
import DataSourcePriorityBanner from '@/components/dashboard/DataSourcePriorityBanner';

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
  // Limite fixo de 500 para evitar rate limit — suficiente para o gráfico de 30 dias
  return base44.entities.AdsBidChangeLog.filter(
    { amazon_account_id: amazonAccountId },
    '-created_at',
    500
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
  const [campFilter, setCampFilter] = useState('active');
  const [autopilotConfig, setAutopilotConfig] = useState(null);
  const [lastSyncInfo, setLastSyncInfo] = useState(null);
  const [syncingDashboard, setSyncingDashboard] = useState(false);
  const [syncDashMsg, setSyncDashMsg] = useState(null);
  const [kickoffStatus, setKickoffStatus] = useState(null);
  const [kickoffRunning, setKickoffRunning] = useState(false);
  const kickoffAbortRef = useRef(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await base44.auth.me();
      setUser(me);
      // Uma única query — filtra por user_id direto no servidor
      const allAccounts = await base44.entities.AmazonAccount.filter({ user_id: me.id }, '-updated_date', 5);
      const acc = allAccounts.find(a => a.status === 'connected') || allAccounts[0] || null;
      setAccount(acc);
      if (!acc) { setLoading(false); return; }

      const aid = acc.id;
      const delay = (ms) => new Promise(r => setTimeout(r, ms));
      const safeQuery = async (fn, fallback = []) => {
        try { return await fn(); } catch (e) {
          if (e?.response?.status === 429 || String(e?.message).includes('429')) return fallback;
          throw e;
        }
      };

      // Fila sequencial com intervalo para evitar rate limit (429)
      const cams = await safeQuery(() => loadAllCampaigns(aid));
      await delay(300);
      const prods = await safeQuery(() => base44.entities.Product.filter({ amazon_account_id: aid }, '-fba_inventory', 30));
      await delay(300);
      const metrics = await safeQuery(() => base44.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 120));
      await delay(300);
      const hourly = await safeQuery(() => base44.entities.HourlyMetric.filter({ amazon_account_id: aid }, '-date', 720));
      await delay(300);
      const decs = await safeQuery(() => base44.entities.OptimizationDecision.filter({ amazon_account_id: aid, status: 'pending' }, '-created_at', 10));
      await delay(300);
      const runs = await safeQuery(() => base44.entities.SyncExecutionLog.filter({ amazon_account_id: aid }, '-started_at', 8));
      await delay(300);
      const changes = await safeQuery(() => loadAllBidChanges(aid));
      await delay(300);
      const apConfigs = await safeQuery(() => base44.entities.AutopilotConfig.filter({ amazon_account_id: aid }));

      setCampaigns(cams);
      setProducts(prods);
      setMetricsDaily(metrics);
      setHourlyMetrics(hourly);
      setDecisions(decs);
      setSyncRuns(runs);
      setBidChanges(changes);
      setAutopilotConfig(apConfigs[0] || null);

      // Status do kickoff automático: produtos sem campanha
      const noAds = prods.filter(p => p.status === 'active' && !p.has_campaign && p.inventory_status !== 'out_of_stock');
      setKickoffStatus({ productsWithoutAds: noAds.length, lastRun: apConfigs[0]?.updated_at || null });

      // Última sincronização: priorizar last_sync_at da conta (sempre atualizado), depois SyncExecutionLog
      if (acc?.last_sync_at) {
        setLastSyncInfo({ at: acc.last_sync_at, trigger: 'automatic' });
      } else {
        const lastSuccessRun = runs.find(r => r.status === 'success' || r.status === 'skipped_limit');
        setLastSyncInfo(lastSuccessRun ? {
          at: lastSuccessRun.completed_at || lastSuccessRun.started_at,
          trigger: lastSuccessRun.trigger_type,
        } : null);
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
    setSyncingDashboard(true);
    setSyncDashMsg(null);
    try {
      const res = await base44.functions.invoke('syncAdsQuick', { amazon_account_id: account.id });
      if (res?.data?.ok) {
        setSyncDashMsg({ type: 'success', text: `${res.data.campaigns_updated || 0} campanhas sincronizadas.` });
        await loadData();
      } else {
        setSyncDashMsg({ type: 'error', text: res?.data?.error || 'Falha ao sincronizar.' });
      }
    } catch (e) {
      setSyncDashMsg({ type: 'error', text: e.message });
    } finally {
      setSyncingDashboard(false);
      setTimeout(() => setSyncDashMsg(null), 8000);
    }
  };

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

  // Ad Spend Ontem — dia anterior completo (D-1), sem dados parciais do dia atual
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);
  const seenYesterday = new Set();
  const yesterdayKpis = metricsDaily
    .filter(m => m.date === yesterdayStr)
    .reduce((acc, m) => {
      const key = `${m.campaign_id || ''}-${m.date}`;
      if (seenYesterday.has(key)) return acc;
      seenYesterday.add(key);
      return {
        spend: acc.spend + (m.spend || 0),
        sales: acc.sales + (m.sales || 0),
        clicks: acc.clicks + (m.clicks || 0),
        orders: acc.orders + (m.orders || 0),
        impressions: acc.impressions + (m.impressions || 0),
      };
    }, { spend: 0, sales: 0, clicks: 0, orders: 0, impressions: 0 });

  const yesterdayAcos = yesterdayKpis.sales > 0 ? (yesterdayKpis.spend / yesterdayKpis.sales * 100) : 0;
  const yesterdayRoas = yesterdayKpis.spend > 0 ? (yesterdayKpis.sales / yesterdayKpis.spend) : 0;

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
  return (
    <div className="p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-white">{greeting}, {firstName}.</h1>
          <p className="text-sm text-slate-400 mt-0.5">
            {loading
              ? <span className="text-slate-500">Carregando...</span>
              : decisions.length > 0
                ? <><span className="text-amber-400 font-semibold">{decisions.length}</span> decisões IA pendentes</>
                : account
                  ? <span className="text-emerald-400/80">{campaigns.length} campanhas · {metricsDaily.length} registros</span>
                  : <span className="text-slate-500">Configure sua conta Amazon nas <Link to="/settings" className="underline">Configurações</Link></span>
            }
            {lastSyncInfo && (
              <span className="ml-2 text-slate-500 text-xs flex items-center gap-1 inline-flex">
                · <Clock className="w-3 h-3 inline" /> {new Date(lastSyncInfo.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {syncingDashboard && <span className="text-xs text-cyan animate-pulse">Sincronizando...</span>}
          {syncDashMsg && <span className={`text-xs ${syncDashMsg.type === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>{syncDashMsg.text}</span>}
          <button onClick={runSync} disabled={loading || syncingDashboard}
            className="flex items-center gap-2 px-3 py-2 bg-cyan/10 border border-cyan/20 text-cyan hover:bg-cyan/20 text-sm rounded-lg transition-colors disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${syncingDashboard ? 'animate-spin' : ''}`} />
            Sync
          </button>
          <button onClick={loadData} disabled={loading}
            className="flex items-center gap-2 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm rounded-lg transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Banner de status de sincronização */}
      {account && <SyncStatusBanner accountId={account.id} />}

      {/* Hierarquia de fontes de dados */}
      <DataSourcePriorityBanner />

      {/* Status Automação de Produtos */}
      {account && kickoffStatus !== null && (
        <div className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl border text-xs ${kickoffStatus.productsWithoutAds > 0 ? 'bg-amber-500/5 border-amber-500/20' : 'bg-emerald-500/5 border-emerald-500/20'}`}>
          <div className="flex items-center gap-2">
            <Rocket className={`w-4 h-4 flex-shrink-0 ${kickoffStatus.productsWithoutAds > 0 ? 'text-amber-400' : 'text-emerald-400'}`} />
            <span className={kickoffStatus.productsWithoutAds > 0 ? 'text-amber-300' : 'text-emerald-300'}>
              {kickoffStatus.productsWithoutAds > 0
                ? <><span className="font-bold">{kickoffStatus.productsWithoutAds}</span> produto(s) sem campanha — kick-off automático agendado (diário 06h + segunda 07h BRT)</>
                : <>✓ Todos os produtos ativos têm campanhas. Automação operando normalmente.</>
              }
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={async () => {
                if (kickoffRunning) return;
                const abortController = new AbortController();
                kickoffAbortRef.current = abortController;
                setKickoffRunning(true);
                try {
                  const res = await base44.functions.invoke('runFullProductAutomation', { amazon_account_id: account.id });
                  if (abortController.signal.aborted) return;
                  const d = res.data;
                  if (d?.ok) {
                    const s = d.summary || {};
                    setKickoffStatus(prev => ({ ...prev, lastMsg: `✓ ${s.auto_campaigns_created || 0} AUTO + ${s.manual_campaigns_created || 0} MANUAL criadas · ${s.keywords_created || 0} keywords`, productsWithoutAds: 0 }));
                  } else {
                    setKickoffStatus(prev => ({ ...prev, lastMsg: `⚠ ${d?.error || 'Erro'}` }));
                  }
                } catch (e) {
                  if (!abortController.signal.aborted) {
                    setKickoffStatus(prev => ({ ...prev, lastMsg: `⚠ ${e.message}` }));
                  }
                } finally {
                  kickoffAbortRef.current = null;
                  setKickoffRunning(false);
                }
              }}
              disabled={kickoffRunning}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap"
            >
              {kickoffRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Rocket className="w-3 h-3" />}
              {kickoffRunning ? 'Executando...' : 'Executar agora'}
            </button>
            {kickoffRunning && (
              <button
                onClick={() => {
                  kickoffAbortRef.current?.abort();
                  setKickoffRunning(false);
                  setKickoffStatus(prev => ({ ...prev, lastMsg: '⚠ Kick-off cancelado pelo usuário.' }));
                }}
                className="flex items-center gap-1 px-2.5 py-1.5 bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 rounded-lg transition-colors text-xs whitespace-nowrap"
              >
                <X className="w-3 h-3" /> Cancelar
              </button>
            )}
          </div>
        </div>
      )}
      {kickoffStatus?.lastMsg && (
        <div className="px-4 py-2 rounded-lg bg-surface-2 border border-surface-3 text-xs text-slate-300">{kickoffStatus.lastMsg}</div>
      )}

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

      {/* Painel de Orçamento Diário Centralizado */}
      <BudgetAllocationPanel
        account={account}
        campaigns={campaigns}
        products={products}
        metricsDaily={metricsDaily}
        autopilotConfig={autopilotConfig}
      />

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

      {/* Card Ad Spend Ontem (D-1) */}
      {loading ? (
        <div className="bg-surface-1 border border-amber-500/20 rounded-xl p-4 animate-pulse h-28" />
      ) : (
        <div className="bg-surface-1 border border-amber-500/25 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              <h3 className="text-xs font-semibold text-amber-400">Ad Spend Ontem ({yesterdayStr})</h3>
              <span className="text-[10px] text-slate-500 bg-surface-2 px-1.5 py-0.5 rounded">D-1 · dados completos</span>
            </div>
            <span className="text-[10px] text-slate-500">{Object.keys(metricsDaily.filter(m => m.date === yesterdayStr).reduce((a, m) => { a[m.campaign_id] = 1; return a; }, {})).length} campanhas</span>
          </div>
          {yesterdayKpis.spend === 0 ? (
            <p className="text-xs text-slate-500">Sem dados para {yesterdayStr}. Aguarde o sync da próxima janela.</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div className="bg-surface-2 rounded-lg p-3">
                <p className="text-[10px] text-slate-400 mb-1">Gasto</p>
                <p className="text-xl font-bold text-amber-400">R${yesterdayKpis.spend.toFixed(2)}</p>
              </div>
              <div className="bg-surface-2 rounded-lg p-3">
                <p className="text-[10px] text-slate-400 mb-1">Vendas</p>
                <p className="text-xl font-bold text-emerald-400">R${yesterdayKpis.sales.toFixed(2)}</p>
              </div>
              <div className="bg-surface-2 rounded-lg p-3">
                <p className="text-[10px] text-slate-400 mb-1">Pedidos</p>
                <p className="text-xl font-bold text-white">{yesterdayKpis.orders}</p>
              </div>
              <div className="bg-surface-2 rounded-lg p-3">
                <p className="text-[10px] text-slate-400 mb-1">ACoS</p>
                <p className={`text-xl font-bold ${yesterdayAcos === 0 ? 'text-slate-500' : yesterdayAcos > (autopilotConfig?.maximum_acos || 40) ? 'text-red-400' : yesterdayAcos > (autopilotConfig?.target_acos || 25) ? 'text-amber-400' : 'text-emerald-400'}`}>
                  {yesterdayAcos > 0 ? `${yesterdayAcos.toFixed(1)}%` : '—'}
                </p>
              </div>
              <div className="bg-surface-2 rounded-lg p-3">
                <p className="text-[10px] text-slate-400 mb-1">ROAS</p>
                <p className="text-xl font-bold text-slate-300">{yesterdayRoas > 0 ? `${yesterdayRoas.toFixed(2)}x` : '—'}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard label="Ad Spend 30d" value={`R$${kpis.spend.toFixed(2)}`} sub={`${active_count} ativas · ${paused_count} pausadas`} loading={loading} />
        <KPICard label="Vendas Ads 30d" value={`R$${kpis.sales.toFixed(2)}`} sub={`${kpis.orders} pedidos`} loading={loading} />
        <KPICard label="ACoS" value={`${acos.toFixed(1)}%`} sub={`ROAS: ${roas.toFixed(2)}x`} loading={loading} />
        <KPICard label="CPC Médio" value={`R$${cpc.toFixed(2)}`} sub={`CTR: ${ctr.toFixed(2)}%`} loading={loading} />
      </div>

      {/* Metas vs Realidade */}
      <GoalsComparisonPanel
        acos={acos}
        roas={roas}
        autopilotConfig={autopilotConfig}
        loading={loading}
      />

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

      {/* Painel de Otimizações Semanais Claude */}
      <WeeklyOptimizationSummary account={account} />

      {/* Painel de Performance por Campanha */}
      <CampaignPerformancePanel
        campaigns={campaigns.filter(c => c.state !== 'archived' && c.status !== 'archived' && !c.archived)}
        autopilotConfig={autopilotConfig}
        loading={loading}
      />

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

        // Arquivadas nunca aparecem — filtro 'all' mostra apenas ativas + pausadas
        const nonArchivedCamps = [...activeCamps, ...pausedCamps];
        const filtered = campFilter === 'active' ? activeCamps
          : campFilter === 'paused' ? pausedCamps
          : nonArchivedCamps;

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
                    { key: 'all', label: `Ativas + Pausadas (${activeCamps.length + pausedCamps.length})` },
                    { key: 'active', label: `Ativas (${activeCamps.length})` },
                    { key: 'paused', label: `Pausadas (${pausedCamps.length})` },
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