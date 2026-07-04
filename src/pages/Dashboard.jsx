import React, { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { loadAllCampaigns, classifyCampaigns } from '@/lib/campaignUtils';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Legend, LineChart, Line } from 'recharts';
import { BarChart2, Loader2, TrendingUp, TrendingDown, Minus, RefreshCw, AlertCircle, Brain, Zap, Clock, Activity, XCircle, Send, DollarSign, Eye, MousePointer } from 'lucide-react';
import BudgetSuggestionCard from '@/components/dashboard/BudgetSuggestionCard';
import BudgetReport14d from '@/components/dashboard/BudgetReport14d';
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
  const [autopilotConfig, setAutopilotConfig] = useState(null);
  const [forcingSyncAds, setForcingSyncAds] = useState(false);
  const [forceSyncMsg, setForceSyncMsg] = useState(null);
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
        base44.entities.AdsBidChangeLog.filter({ amazon_account_id: aid }, '-created_at', 5000),
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

  const triggerSync = async () => {
    if (!account || forcingSyncAds) return;
    setForcingSyncAds(true);
    setForceSyncMsg(null);
    try {
      const res = await base44.functions.invoke('runDailyMasterSync', { amazon_account_id: account.id });
      if (res?.data?.ok) {
        const s = res.data.summary || {};
        setForceSyncMsg({ type: 'success', text: `✓ ${s.campaigns_updated || 0} camp. · ${s.keywords_updated || 0} kws · ${s.products_updated || 0} prod.` });
        setLastSyncInfo({ at: new Date().toISOString(), trigger: 'manual' });
        await loadData();
      } else {
        setForceSyncMsg({ type: 'error', text: res?.data?.error || res?.data?.message || 'Falha no sync' });
      }
    } catch (e) {
      setForceSyncMsg({ type: 'error', text: e.message });
    } finally {
      setForcingSyncAds(false);
      setTimeout(() => setForceSyncMsg(null), 10000);
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

  // Alterações enviadas à Amazon — últimos 90 dias, com acumulado diário.
  // Todos os dias são exibidos no eixo X, inclusive os que não tiveram alterações.
  const changesChartData = (() => {
    const DAY_MS = 86400000;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const firstDay = new Date(today.getTime() - 89 * DAY_MS);
    const dailyCounts = new Map();

    bidChanges.forEach((change) => {
      if (!change.created_at) return;
      const createdAt = new Date(change.created_at);
      if (Number.isNaN(createdAt.getTime())) return;
      createdAt.setHours(0, 0, 0, 0);
      if (createdAt < firstDay || createdAt > today) return;
      const key = createdAt.toISOString().slice(0, 10);
      dailyCounts.set(key, (dailyCounts.get(key) || 0) + 1);
    });

    let cumulative = 0;
    return Array.from({ length: 90 }, (_, index) => {
      const day = new Date(firstDay.getTime() + index * DAY_MS);
      const key = day.toISOString().slice(0, 10);
      const changes = dailyCounts.get(key) || 0;
      cumulative += changes;
      return {
        dateKey: key,
        date: day.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
        fullDate: day.toLocaleDateString('pt-BR'),
        changes,
        cumulative,
      };
    });
  })();
  const totalChanges = changesChartData.at(-1)?.cumulative || 0;

  const [mainTab, setMainTab] = useState('dashboard');

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const firstName = user?.full_name?.split(' ')[0] || 'gestor';

  if (mainTab === 'analytics') {
    return (
      <div className="p-6 space-y-5">
        <div className="flex items-center gap-2">
          <button onClick={() => setMainTab('dashboard')} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-surface-2 text-slate-400 hover:text-white">← Dashboard</button>
        </div>
        <Analytics embedded />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-heading font-bold text-white">{greeting}, {firstName}</h1>
          <div className="flex items-center gap-2 mt-1">
            <span className={`w-1.5 h-1.5 rounded-full ${error ? 'bg-red-400' : 'bg-emerald-400'}`} />
            <span className="text-xs text-slate-500">{error ? 'Erro ao carregar dados' : 'Amazon Ads conectado'}</span>
            {lastSyncInfo && <><span className="text-slate-700">·</span><span className="text-xs text-slate-500">Último sync: {new Date(lastSyncInfo.at).toLocaleString('pt-BR')}</span></>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setMainTab('analytics')} variant="outline" size="sm"><BarChart2 className="w-4 h-4 mr-2" />Análises</Button>
          <Button onClick={runAudit} variant="outline" size="sm"><Activity className="w-4 h-4 mr-2" />Auditar</Button>
          <Button onClick={triggerSync} disabled={forcingSyncAds} size="sm"><RefreshCw className={`w-4 h-4 mr-2 ${forcingSyncAds ? 'animate-spin' : ''}`} />Sincronizar</Button>
        </div>
      </div>

      {forceSyncMsg && <div className={`px-4 py-3 rounded-xl border text-sm ${forceSyncMsg.type === 'success' ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' : 'bg-red-400/10 border-red-400/20 text-red-300'}`}>{forceSyncMsg.text}</div>}

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KPICard label="Ad Spend 30d" value={`R$ ${kpis.spend.toFixed(2)}`} sub={`${active_count} ativas · ${paused_count} pausadas`} loading={loading} />
        <KPICard label="Vendas Ads 30d" value={`R$ ${kpis.sales.toFixed(2)}`} sub={`${kpis.orders} pedidos`} loading={loading} />
        <KPICard label="ACoS" value={`${acos.toFixed(1)}%`} sub={`ROAS: ${roas.toFixed(2)}x`} loading={loading} />
        <KPICard label="CPC Médio" value={`R$ ${cpc.toFixed(2)}`} sub={`CTR: ${ctr.toFixed(2)}%`} loading={loading} />
        <KPICard label="Produtos" value={totalProducts} sub={`${products.filter(p => p.inventory_status !== 'out_of_stock').length} com estoque`} loading={loading} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2"><Clock className="w-4 h-4 text-cyan" /><h2 className="text-sm font-semibold text-slate-300">Desempenho por Hora</h2></div>
            <span className="text-xs text-slate-500">Últimos 30 dias</span>
          </div>
          {loading ? <div className="h-64 flex items-center justify-center"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div> : hourlyData.length > 0 ? (
            <div className="space-y-4">
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={hourlyData}><CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" /><XAxis dataKey="hour" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} /><YAxis tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ background: '#111318', border: '1px solid #1A1D26', borderRadius: 8, fontSize: 12 }} /><Bar dataKey="sales" fill="#10B981" name="Vendas" radius={[3,3,0,0]} /><Bar dataKey="spend" fill="#3B82F6" name="Spend" radius={[3,3,0,0]} /></BarChart>
              </ResponsiveContainer>
              <div className="overflow-x-auto">
                <div className="grid gap-1 min-w-[800px]" style={{ gridTemplateColumns: '36px repeat(24, 1fr)' }}>
                  <div className="text-[9px] text-slate-500 font-semibold">Dia</div>
                  {Array.from({ length: 24 }, (_, h) => (
                    <div key={h} className="text-[9px] text-slate-500 text-center font-semibold">{h}</div>
                  ))}
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
                  <div className="flex items-center gap-1"><div className="w-3 h-3 rounded-sm bg-surface-2" /> Sem veiculação</div>
                  <div className="flex items-center gap-1"><div className="w-3 h-3 rounded-sm bg-cyan/20" /> Baixo spend</div>
                  <div className="flex items-center gap-1"><div className="w-3 h-3 rounded-sm bg-cyan/40" /> Médio spend</div>
                  <div className="flex items-center gap-1"><div className="w-3 h-3 rounded-sm bg-cyan/60" /> Alto spend</div>
                  <div className="flex items-center gap-1"><div className="w-3 h-3 rounded-sm ring-1 ring-amber-400/50" /> Budget excedido</div>
                </div>
              </div>
            </div>
          ) : (
            <div className="h-64 flex flex-col items-center justify-center text-sm text-slate-500"><Clock className="w-8 h-8 text-slate-600 mb-2" />Sem dados horários. Execute um Sync completo.</div>
          )}
        </div>

        <BudgetSuggestionCard metricsDaily={metricsDaily} campaigns={campaigns} products={products} loading={loading} autopilotConfig={autopilotConfig} />

        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 lg:col-span-3">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2"><Send className="w-4 h-4 text-amber-400" /><h2 className="text-sm font-semibold text-slate-300">Alterações Enviadas para Amazon</h2></div>
            <div className="flex items-center gap-2"><span className="text-xs text-slate-500">Total: </span><span className="text-sm font-bold text-amber-400">{totalChanges}</span></div>
          </div>
          {loading ? (
            <div className="h-40 flex items-center justify-center"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
          ) : changesChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={changesChartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="gAmazonChanges" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#F59E0B" stopOpacity={0.30} />
                    <stop offset="95%" stopColor="#F59E0B" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                <XAxis dataKey="date" interval={14} minTickGap={18} tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis dataKey="cumulative" domain={[0, 'dataMax']} tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: '#111318', border: '1px solid #1A1D26', borderRadius: 8, fontSize: 12 }}
                  labelFormatter={(_, payload) => payload?.[0]?.payload?.fullDate || ''}
                  formatter={(value, name, item) => name === 'Acumulado'
                    ? [`${value} alterações`, 'Acumulado em 90 dias']
                    : [`${item?.payload?.changes || 0} alterações`, 'Alterações no dia']}
                />
                <Area type="monotone" dataKey="cumulative" name="Acumulado" stroke="#F59E0B" fill="url(#gAmazonChanges)" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-40 flex flex-col items-center justify-center text-sm text-slate-500"><Send className="w-8 h-8 text-slate-600 mb-2" />Nenhuma alteração enviada ainda.</div>
          )}
        </div>
      </div>

      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-slate-300 mb-4">Spend vs Vendas — 30 dias</h2>
        {loading ? <div className="h-52 flex items-center justify-center"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div> : chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height={210}><AreaChart data={chartData}><defs><linearGradient id="gSpend" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3B82F6" stopOpacity={0.25} /><stop offset="95%" stopColor="#3B82F6" stopOpacity={0} /></linearGradient><linearGradient id="gSales" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#10B981" stopOpacity={0.25} /><stop offset="95%" stopColor="#10B981" stopOpacity={0} /></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" /><XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} /><YAxis tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} /><Tooltip contentStyle={{ background: '#111318', border: '1px solid #1A1D26', borderRadius: 8, fontSize: 12 }} formatter={(v) => `R$${Number(v).toFixed(2)}`} /><Area type="monotone" dataKey="spend" stroke="#3B82F6" fill="url(#gSpend)" strokeWidth={2} name="Spend" /><Area type="monotone" dataKey="sales" stroke="#10B981" fill="url(#gSales)" strokeWidth={2} name="Vendas" /></AreaChart></ResponsiveContainer>
        ) : <div className="h-52 flex items-center justify-center text-sm text-slate-500">Sem dados. Execute um Sync.</div>}
      </div>

      {(() => {
        const activeCamps = activeCampaignsList;
        const pausedCamps = pausedCampaignsList;
        const archivedCamps = archivedCampaignsList;
        const filtered = campFilter === 'active' ? activeCamps : campFilter === 'paused' ? pausedCamps : campFilter === 'archived' ? archivedCamps : campaigns;
        return <div className="bg-surface-1 border border-surface-2 rounded-xl p-5"><div className="flex items-center justify-between mb-4"><h2 className="text-sm font-semibold text-slate-300">Campanhas</h2><div className="flex gap-1">{[['all','Todas'],['active','Ativas'],['paused','Pausadas'],['archived','Arquivadas']].map(([k,l]) => <button key={k} onClick={() => setCampFilter(k)} className={`px-2.5 py-1 rounded text-xs ${campFilter === k ? 'bg-cyan/20 text-cyan' : 'text-slate-500 hover:text-white'}`}>{l}</button>)}</div></div><div className="space-y-2">{filtered.slice(0,10).map(c => <div key={c.id} className="flex items-center justify-between py-2 border-b border-surface-2"><div><p className="text-sm text-white">{c.name || c.campaign_name}</p><p className="text-xs text-slate-500">{c.asin || c.sku}</p></div><StatusBadge status={c.state || c.status} /></div>)}</div></div>;
      })()}

      {showAudit && auditData && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"><div className="w-full max-w-xl rounded-2xl border border-surface-2 bg-surface-1 p-6"><div className="flex justify-between mb-4"><h2 className="font-bold text-white">Auditoria de dados</h2><button onClick={() => setShowAudit(false)}><XCircle className="w-5 h-5 text-slate-500" /></button></div><div className="space-y-2 text-sm"><div className="flex items-center justify-between py-1.5 border-b border-surface-3/50"><span className="text-slate-500">Total:</span><span className="text-white font-semibold">{auditData.metrics?.total_records}</span></div><div className="flex items-center justify-between py-1.5 border-b border-surface-3/50"><span className="text-slate-500">Únicos:</span><span className="text-white font-semibold">{auditData.metrics?.unique_records}</span></div><div className="flex items-center justify-between py-1.5 border-b border-surface-3/50"><span className="text-slate-500">Duplicados:</span><span className="text-white font-semibold">{auditData.metrics?.duplicates}</span></div></div></div></div>}
    </div>
  );
}
