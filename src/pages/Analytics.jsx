import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import { TrendingUp, TrendingDown, Minus, Loader2, RefreshCw, BarChart2 } from 'lucide-react';
import WeeklyReportView from '@/components/analytics/WeeklyReportView';
import AcosEvolutionPanel from '@/components/analytics/AcosEvolutionPanel';

const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16'];

function Trend({ value, inverse = false }) {
  if (!value || value === 0) return <Minus className="w-3 h-3 text-slate-500" />;
  const positive = inverse ? value < 0 : value > 0;
  return positive
    ? <TrendingUp className="w-3 h-3 text-emerald-400" />
    : <TrendingDown className="w-3 h-3 text-red-400" />;
}

function KPI({ label, value, trend, inverse, loading }) {
  if (loading) return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-4 animate-pulse">
      <div className="h-3 w-20 bg-surface-3 rounded mb-2" />
      <div className="h-6 w-28 bg-surface-3 rounded" />
    </div>
  );
  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
      <p className="text-xs text-slate-400 mb-1">{label}</p>
      <div className="flex items-center gap-2">
        <p className="text-xl font-bold text-white">{value}</p>
        <Trend value={trend} inverse={inverse} />
      </div>
    </div>
  );
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#111318] border border-surface-2 rounded-lg p-3 text-xs shadow-xl">
      <p className="text-slate-400 mb-2 font-medium">{label}</p>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2 mb-1">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-slate-300">{p.name}:</span>
          <span className="text-white font-semibold">
            {p.name?.toLowerCase().includes('acos') ? `${Number(p.value).toFixed(1)}%`
              : p.name?.toLowerCase().includes('spend') || p.name?.toLowerCase().includes('venda') || p.name?.toLowerCase().includes('receita')
              ? `R$${Number(p.value).toFixed(2)}`
              : p.value}
          </span>
        </div>
      ))}
    </div>
  );
};

export default function Analytics() {
  const [account, setAccount] = useState(null);
  const [products, setProducts] = useState([]);
  const [metrics, setMetrics] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [unifiedMetrics, setUnifiedMetrics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedAsin, setSelectedAsin] = useState('all');
  const [period, setPeriod] = useState(30);
  const [activeMainTab, setActiveMainTab] = useState('metricas');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      if (!accounts.length) accounts = await base44.entities.AmazonAccount.list();
      const acc = accounts[0] || null;
      setAccount(acc);
      if (!acc) return;

      const aid = acc.id;
      const [prods, mets, camps, unified] = await Promise.all([
        base44.entities.Product.filter({ amazon_account_id: aid }, '-total_sales_30d', 100),
        base44.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 2000),
        base44.entities.Campaign.filter({ amazon_account_id: aid }, '-spend', 500),
        base44.entities.UnifiedAdsMetricsDaily.filter({ amazon_account_id: aid }, '-date', 1000).catch(() => []),
      ]);
      setProducts(prods);
      setMetrics(mets);
      setCampaigns(camps);
      setUnifiedMetrics(unified);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Dados para gráficos ──

  const nowBRT = new Date(Date.now() - 3 * 3600000);
  const todayBRT = nowBRT.toISOString().slice(0, 10);
  const yesterdayBRT = new Date(new Date(todayBRT + 'T12:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  const cutoffDate = new Date(todayBRT + 'T00:00:00Z');
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - period);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  const filteredMetrics = metrics.filter(m => m.date && m.date >= cutoff && m.date <= yesterdayBRT);

  const dedupMap = new Map();
  filteredMetrics.forEach(m => {
    if (!m.campaign_id) return;
    const key = `${m.campaign_id}-${m.date}`;
    if (!dedupMap.has(key)) dedupMap.set(key, m);
  });
  const dedupedMetrics = Array.from(dedupMap.values());

  const dailyData = Object.values(
    dedupedMetrics.reduce((acc, m) => {
      const d = m.date || '';
      const [yy, mm, dd_] = d.split('-');
      const label = d ? `${dd_}/${mm}` : d;
      if (!acc[d]) acc[d] = { name: label, date: d, spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 };
      acc[d].spend += m.spend || 0;
      acc[d].sales += m.sales || 0;
      acc[d].orders += m.orders || 0;
      acc[d].clicks += m.clicks || 0;
      acc[d].impressions += m.impressions || 0;
      return acc;
    }, {})
  )
    .map(d => ({
      ...d,
      acos: d.sales > 0 ? d.spend / d.sales * 100 : 0,
      roas: d.spend > 0 ? d.sales / d.spend : 0,
      ctr: d.impressions > 0 ? d.clicks / d.impressions * 100 : 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const metricsByCampaign = dedupedMetrics.reduce((acc, m) => {
    const cid = m.campaign_id || '';
    if (!cid) return acc;
    if (!acc[cid]) acc[cid] = { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 };
    acc[cid].spend += m.spend || 0;
    acc[cid].sales += m.sales || 0;
    acc[cid].orders += m.orders || 0;
    acc[cid].clicks += m.clicks || 0;
    acc[cid].impressions += m.impressions || 0;
    return acc;
  }, {});

  const campaignAsinMap = new Map();
  campaigns.forEach(c => {
    if (c.asin && c.campaign_id) campaignAsinMap.set(c.campaign_id, c.asin);
    if (c.asin && c.amazon_campaign_id) campaignAsinMap.set(c.amazon_campaign_id, c.asin);
  });

  const metricsByAsin = {};
  Object.entries(metricsByCampaign).forEach(([cid, m]) => {
    const asin = campaignAsinMap.get(cid);
    if (!asin) return;
    if (!metricsByAsin[asin]) metricsByAsin[asin] = { spend: 0, sales: 0, orders: 0, clicks: 0 };
    metricsByAsin[asin].spend += m.spend;
    metricsByAsin[asin].sales += m.sales;
    metricsByAsin[asin].orders += m.orders;
    metricsByAsin[asin].clicks += m.clicks;
  });

  const productMap = new Map(products.map(p => [p.asin, p]));
  const enrichedProducts = Object.entries(metricsByAsin)
    .map(([asin, m]) => {
      const p = productMap.get(asin) || { asin };
      const acos = m.sales > 0 ? m.spend / m.sales * 100 : 0;
      const roas = m.spend > 0 ? m.sales / m.spend : 0;
      return { ...p, _sales: m.sales, _spend: m.spend, _orders: m.orders, _acos: acos, _roas: roas };
    })
    .sort((a, b) => b._sales - a._sales);

  const asinsWithMetrics = new Set(enrichedProducts.map(p => p.asin));
  const productsNoMetrics = products
    .filter(p => p.asin && !asinsWithMetrics.has(p.asin))
    .map(p => ({ ...p, _sales: 0, _spend: 0, _orders: 0, _acos: 0, _roas: 0 }));

  const topProducts = [...enrichedProducts, ...productsNoMetrics].slice(0, 10);

  const productBarData = topProducts
    .filter(p => p._sales > 0 || p._spend > 0)
    .slice(0, 10)
    .map(p => ({
      name: p.asin,
      Receita: p._sales,
      Spend: p._spend,
    }));

  const campAcosData = Object.entries(metricsByCampaign)
    .map(([cid, m]) => {
      const camp = campaigns.find(c => c.campaign_id === cid || c.amazon_campaign_id === cid);
      const name = (camp?.name || camp?.campaign_name || cid).slice(0, 22);
      const acos = m.sales > 0 ? m.spend / m.sales * 100 : 0;
      return { name, ACoS: acos, Spend: m.spend, Vendas: m.sales };
    })
    .filter(c => c.Spend > 0)
    .sort((a, b) => b.Spend - a.Spend)
    .slice(0, 10);

  const totSpend = dailyData.reduce((s, d) => s + d.spend, 0);
  const totSales = dailyData.reduce((s, d) => s + d.sales, 0);
  const totOrders = dailyData.reduce((s, d) => s + d.orders, 0);
  const totClicks = dailyData.reduce((s, d) => s + d.clicks, 0);
  const totImpressions = dailyData.reduce((s, d) => s + d.impressions, 0);
  const avgAcos = totSales > 0 ? totSpend / totSales * 100 : 0;
  const avgRoas = totSpend > 0 ? totSales / totSpend : 0;
  const avgCpc = totClicks > 0 ? totSpend / totClicks : 0;
  const avgCtr = totImpressions > 0 ? totClicks / totImpressions * 100 : 0;
  const cvr = totClicks > 0 ? totOrders / totClicks * 100 : 0;
  const cpa = totOrders > 0 ? totSpend / totOrders : 0;
  const rpc = totClicks > 0 ? totSales / totClicks : 0;
  const ticketMedio = totOrders > 0 ? totSales / totOrders : 0;

  const unifiedByDate = {};
  unifiedMetrics
    .filter(m => m.date && m.date >= cutoff && m.date <= yesterdayBRT)
    .forEach(m => {
      const key = `${m.campaign_id || ''}-${m.date}`;
      if (!unifiedByDate[key]) { unifiedByDate[key] = m; }
    });
  const unifiedDeduped = Object.values(unifiedByDate);

  const unifiedDailyMap = {};
  unifiedDeduped.forEach(m => {
    const d = m.date;
    const [yy, mm, dd_] = d.split('-');
    if (!unifiedDailyMap[d]) unifiedDailyMap[d] = {
      name: `${dd_}/${mm}`, date: d,
      invalid_impressions: 0, invalid_clicks: 0, impressions: 0, clicks: 0,
      promoted_purchases: 0, halo_purchases: 0, halo_sales: 0, promoted_sales: 0,
      impression_share_sum: 0, top_of_search_sum: 0, rows: 0,
    };
    const e = unifiedDailyMap[d];
    e.invalid_impressions += m.invalid_impressions || 0;
    e.invalid_clicks += m.invalid_clicks || 0;
    e.impressions += m.impressions || 0;
    e.clicks += m.clicks || 0;
    e.promoted_purchases += m.promoted_purchases || 0;
    e.halo_purchases += m.halo_purchases || 0;
    e.halo_sales += m.halo_sales || 0;
    e.promoted_sales += m.promoted_sales || 0;
    if (m.impression_share > 0) e.impression_share_sum += m.impression_share;
    if (m.top_of_search_impression_share > 0) e.top_of_search_sum += m.top_of_search_impression_share;
    e.rows++;
  });
  const unifiedDailyData = Object.values(unifiedDailyMap)
    .map(e => ({
      ...e,
      invalid_impression_rate: e.impressions > 0 ? e.invalid_impressions / e.impressions * 100 : 0,
      invalid_click_rate: e.clicks > 0 ? e.invalid_clicks / e.clicks * 100 : 0,
      avg_impression_share: e.rows > 0 ? e.impression_share_sum / e.rows * 100 : 0,
      avg_top_of_search: e.rows > 0 ? e.top_of_search_sum / e.rows * 100 : 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const hasUnified = unifiedDailyData.length > 0;

  const totPromotedSales = unifiedDeduped.reduce((s, m) => s + (m.promoted_sales || 0), 0);
  const totHaloSales = unifiedDeduped.reduce((s, m) => s + (m.halo_sales || 0), 0);
  const totHaloPurchases = unifiedDeduped.reduce((s, m) => s + (m.halo_purchases || 0), 0);
  const totInvalidImpressions = unifiedDeduped.reduce((s, m) => s + (m.invalid_impressions || 0), 0);
  const totInvalidClicks = unifiedDeduped.reduce((s, m) => s + (m.invalid_clicks || 0), 0);
  const avgImpressionShare = unifiedDailyData.length > 0 ? unifiedDailyData.reduce((s, d) => s + d.avg_impression_share, 0) / unifiedDailyData.length : 0;
  const avgTopOfSearch = unifiedDailyData.length > 0 ? unifiedDailyData.reduce((s, d) => s + d.avg_top_of_search, 0) / unifiedDailyData.length : 0;
  const promotedRoas = totSpend > 0 ? totPromotedSales / totSpend : 0;

  const half = Math.floor(dailyData.length / 2);
  const firstHalf = dailyData.slice(0, half);
  const secondHalf = dailyData.slice(half);
  const salesTrend = firstHalf.length
    ? ((secondHalf.reduce((s, d) => s + d.sales, 0) / secondHalf.length) -
       (firstHalf.reduce((s, d) => s + d.sales, 0) / firstHalf.length))
    : 0;
  const acosTrend = firstHalf.length
    ? ((secondHalf.reduce((s, d) => s + d.acos, 0) / secondHalf.length) -
       (firstHalf.reduce((s, d) => s + d.acos, 0) / firstHalf.length))
    : 0;

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <BarChart2 className="w-5 h-5 text-cyan" /> Analytics
          </h1>
          <p className="text-sm text-slate-400 mt-0.5">Métricas de Ads, aferição econômica e relatório semanal</p>
        </div>
        <div className="flex items-center gap-2">
          {activeMainTab === 'metricas' && (
            <div className="flex bg-surface-2 border border-surface-3 rounded-lg p-0.5 gap-0.5">
              {[7, 14, 30, 60].map(d => (
                <button key={d} onClick={() => setPeriod(d)}
                  className={`px-3 py-1.5 rounded text-xs font-semibold transition-all ${period === d ? 'bg-cyan text-white' : 'text-slate-400 hover:text-slate-200'}`}>
                  {d}d
                </button>
              ))}
            </div>
          )}
          <button onClick={loadData} disabled={loading}
            className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Tabs principais */}
      <div className="flex border-b border-surface-2">
        {[
          { id: 'metricas', label: 'Métricas & Gráficos' },
          { id: 'semanal', label: 'Aferição Econômica & Relatório Semanal' },
        ].map(t => (
          <button key={t.id} onClick={() => setActiveMainTab(t.id)}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${activeMainTab === t.id ? 'border-cyan text-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab Aferição Econômica */}
      {activeMainTab === 'semanal' && (
        account
          ? <WeeklyReportView account={account} />
          : !loading && <div className="flex items-center justify-center py-16"><p className="text-sm text-slate-500">Conta Amazon não encontrada.</p></div>
      )}

      {/* Tab Métricas */}
      {activeMainTab === 'metricas' && (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <KPI label={`Spend ${period}d`} value={`R$${totSpend.toFixed(2)}`} loading={loading} />
            <KPI label={`Vendas Ads ${period}d`} value={`R$${totSales.toFixed(2)}`} trend={salesTrend} loading={loading} />
            <KPI label="ACoS" value={`${avgAcos.toFixed(2)}%`} trend={acosTrend} inverse loading={loading} />
            <KPI label="CPC Médio" value={`R$${avgCpc.toFixed(2)}`} loading={loading} />
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <KPI label="CVR (Conversão)" value={`${cvr.toFixed(1)}%`} loading={loading} />
            <KPI label="CPA" value={`R$${cpa.toFixed(2)}`} loading={loading} />
            <KPI label="RPC (Receita/Clique)" value={`R$${rpc.toFixed(2)}`} loading={loading} />
            <KPI label="Ticket Médio" value={`R$${ticketMedio.toFixed(2)}`} loading={loading} />
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <KPI label="Cliques" value={totClicks.toLocaleString('pt-BR')} loading={loading} />
            <KPI label="Impressões" value={totImpressions.toLocaleString('pt-BR')} loading={loading} />
            <KPI label="CTR" value={`${avgCtr.toFixed(3)}%`} loading={loading} />
            <KPI label="Pedidos" value={totOrders.toLocaleString('pt-BR')} loading={loading} />
          </div>

          {/* KPIs dos Unified Reports */}
          {hasUnified && (
            <div className="space-y-2">
              <p className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Métricas Unificadas Amazon</p>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <KPI label="ROAS Promovido" value={`${promotedRoas.toFixed(2)}x`} loading={loading} />
                <KPI label="Vendas Promovidas" value={`R$${totPromotedSales.toFixed(2)}`} loading={loading} />
                <KPI label="Vendas Halo (Aura)" value={`R$${totHaloSales.toFixed(2)}`} loading={loading} />
                <KPI label="Pedidos Halo" value={totHaloPurchases.toLocaleString('pt-BR')} loading={loading} />
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <KPI label="Parcela de Impressões" value={`${avgImpressionShare.toFixed(1)}%`} loading={loading} />
                <KPI label="Topo de Pesquisa" value={`${avgTopOfSearch.toFixed(1)}%`} loading={loading} />
                <KPI label="Impressões Inválidas" value={totInvalidImpressions.toLocaleString('pt-BR')} loading={loading} />
                <KPI label="Cliques Inválidos" value={totInvalidClicks.toLocaleString('pt-BR')} loading={loading} />
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="w-8 h-8 text-cyan animate-spin" />
            </div>
          ) : dailyData.length === 0 ? (
            <div className="bg-surface-1 border border-surface-2 rounded-xl p-12 text-center">
              <BarChart2 className="w-10 h-10 text-slate-600 mx-auto mb-3" />
              <p className="text-slate-400">Sem dados de métricas. Execute um Sync para popular os gráficos.</p>
            </div>
          ) : (
            <>
              <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
                <h2 className="text-sm font-semibold text-slate-300 mb-4">Vendas vs Spend Diário ({period}d)</h2>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={dailyData}>
                    <defs>
                      <linearGradient id="gSales" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10B981" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#10B981" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="gSpend" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                    <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
                    <Area type="monotone" dataKey="sales" name="Vendas" stroke="#10B981" fill="url(#gSales)" strokeWidth={2} />
                    <Area type="monotone" dataKey="spend" name="Spend" stroke="#3B82F6" fill="url(#gSpend)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
                <h2 className="text-sm font-semibold text-slate-300 mb-1">Tendência de ACoS ({period}d)</h2>
                <p className="text-xs text-slate-500 mb-4">
                  Meta ideal: abaixo de 25% · Atual: <span className={avgAcos > 40 ? 'text-red-400' : avgAcos > 25 ? 'text-amber-400' : 'text-emerald-400'}>{avgAcos.toFixed(1)}%</span>
                </p>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={dailyData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                    <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} unit="%" />
                    <Tooltip content={<CustomTooltip />} />
                    <Line type="monotone" dataKey="acos" name="ACoS" stroke="#F59E0B" strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="roas" name="ROAS" stroke="#8B5CF6" strokeWidth={1.5} dot={false} strokeDasharray="4 4" />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
                  <h2 className="text-sm font-semibold text-slate-300 mb-4">Cliques & Pedidos Diários</h2>
                  <ResponsiveContainer width="100%" height={190}>
                    <BarChart data={dailyData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                      <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
                      <Tooltip content={<CustomTooltip />} />
                      <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
                      <Bar dataKey="clicks" name="Cliques" fill="#3B82F6" radius={[2, 2, 0, 0]} />
                      <Bar dataKey="orders" name="Pedidos" fill="#10B981" radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
                  <h2 className="text-sm font-semibold text-slate-300 mb-4">ACoS por Campanha (Top 10)</h2>
                  {campAcosData.length === 0 ? (
                    <p className="text-xs text-slate-500 text-center py-10">Sem campanhas com dados</p>
                  ) : (
                    <ResponsiveContainer width="100%" height={190}>
                      <BarChart data={campAcosData} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" horizontal={false} />
                        <XAxis type="number" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} unit="%" />
                        <YAxis dataKey="name" type="category" tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={80} />
                        <Tooltip content={<CustomTooltip />} />
                        <Bar dataKey="ACoS" fill="#F59E0B" radius={[0, 2, 2, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </div>

              {hasUnified && (
                <>
                  <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
                    <h2 className="text-sm font-semibold text-slate-300 mb-1">Vendas Promovidas vs Halo (Aura) — {period}d</h2>
                    <p className="text-xs text-slate-500 mb-4">Promovidas = compras diretas do anúncio · Halo = vendas de outros produtos da marca atribuídas ao anúncio</p>
                    <ResponsiveContainer width="100%" height={200}>
                      <AreaChart data={unifiedDailyData}>
                        <defs>
                          <linearGradient id="gPromoted" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#10B981" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#10B981" stopOpacity={0} />
                          </linearGradient>
                          <linearGradient id="gHalo" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#8B5CF6" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#8B5CF6" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                        <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                        <Tooltip content={<CustomTooltip />} />
                        <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
                        <Area type="monotone" dataKey="promoted_sales" name="Vendas Promovidas" stroke="#10B981" fill="url(#gPromoted)" strokeWidth={2} />
                        <Area type="monotone" dataKey="halo_sales" name="Vendas Halo" stroke="#8B5CF6" fill="url(#gHalo)" strokeWidth={2} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
                      <h2 className="text-sm font-semibold text-slate-300 mb-1">Parcela de Impressões & Topo de Pesquisa</h2>
                      <p className="text-xs text-slate-500 mb-4">% do total disponível de impressões conquistadas no período</p>
                      <ResponsiveContainer width="100%" height={190}>
                        <LineChart data={unifiedDailyData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                          <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
                          <YAxis tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} unit="%" />
                          <Tooltip content={<CustomTooltip />} />
                          <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
                          <Line type="monotone" dataKey="avg_impression_share" name="Parcela Impressões %" stroke="#3B82F6" strokeWidth={2} dot={false} />
                          <Line type="monotone" dataKey="avg_top_of_search" name="Topo de Pesquisa %" stroke="#F59E0B" strokeWidth={2} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>

                    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
                      <h2 className="text-sm font-semibold text-slate-300 mb-1">Taxa de Tráfego Inválido</h2>
                      <p className="text-xs text-slate-500 mb-4">% de impressões e cliques identificados como inválidos (MRC)</p>
                      <ResponsiveContainer width="100%" height={190}>
                        <LineChart data={unifiedDailyData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                          <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
                          <YAxis tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} unit="%" />
                          <Tooltip content={<CustomTooltip />} />
                          <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
                          <Line type="monotone" dataKey="invalid_impression_rate" name="Impr. Inválidas %" stroke="#EF4444" strokeWidth={2} dot={false} />
                          <Line type="monotone" dataKey="invalid_click_rate" name="Cliques Inválidos %" stroke="#F59E0B" strokeWidth={2} dot={false} strokeDasharray="4 4" />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </>
              )}

              <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
                <h2 className="text-sm font-semibold text-slate-300 mb-1">Impressões por Dia ({period}d)</h2>
                <p className="text-xs text-slate-500 mb-4">
                  Total: <span className="text-white font-semibold">{totImpressions.toLocaleString('pt-BR')}</span> impressões
                  · Média/dia: <span className="text-white font-semibold">{dailyData.length > 0 ? Math.round(totImpressions / dailyData.length).toLocaleString('pt-BR') : 0}</span>
                </p>
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={dailyData}>
                    <defs>
                      <linearGradient id="gImpressions" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#8B5CF6" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#8B5CF6" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="gClicks2" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                    <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
                    <Area type="monotone" dataKey="impressions" name="Impressões" stroke="#8B5CF6" fill="url(#gImpressions)" strokeWidth={2} />
                    <Area type="monotone" dataKey="clicks" name="Cliques" stroke="#3B82F6" fill="url(#gClicks2)" strokeWidth={1.5} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
                <h2 className="text-sm font-semibold text-slate-300 mb-4">Receita & Spend por Produto (Top 10, {period}d)</h2>
                {productBarData.length === 0 ? (
                  <p className="text-xs text-slate-500 text-center py-10">Sem dados de produtos</p>
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={productBarData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                      <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
                      <Tooltip content={<CustomTooltip />} />
                      <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
                      <Bar dataKey="Receita" fill="#10B981" radius={[2, 2, 0, 0]} />
                      <Bar dataKey="Spend" fill="#3B82F6" radius={[2, 2, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>

              <AcosEvolutionPanel
                metrics={metrics}
                campaigns={campaigns}
                products={products}
                period={period}
              />

              <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
                <div className="px-5 py-4 border-b border-surface-2">
                  <h2 className="text-sm font-semibold text-slate-300">Resumo de Performance por Produto <span className="text-slate-500 font-normal">({period}d)</span></h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-surface-2">
                        {['ASIN', 'SKU', `Receita ${period}d`, `Spend ${period}d`, 'ACoS', 'ROAS', 'Pedidos', 'Stock FBA', 'Campanha'].map(h => (
                          <th key={h} className="px-4 py-3 text-left font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {topProducts.map((p, i) => {
                        const acos = p._acos || 0;
                        const acosColor = acos === 0 ? 'text-slate-500' : acos > 50 ? 'text-red-400' : acos > 25 ? 'text-amber-400' : 'text-emerald-400';
                        const campColor = p.campaign_status === 'active' ? 'text-emerald-400' : p.campaign_status === 'paused' ? 'text-amber-400' : 'text-slate-500';
                        return (
                          <tr key={p.id || i} className="border-b border-surface-2/50 hover:bg-surface-2 transition-colors">
                            <td className="px-4 py-3 font-mono text-cyan">{p.asin}</td>
                            <td className="px-4 py-3 text-slate-400 font-mono">{p.sku || '—'}</td>
                            <td className="px-4 py-3 text-emerald-400">R${(p._sales || 0).toFixed(2)}</td>
                            <td className="px-4 py-3 text-slate-300">R${(p._spend || 0).toFixed(2)}</td>
                            <td className={`px-4 py-3 font-semibold ${acosColor}`}>{acos > 0 ? `${acos.toFixed(1)}%` : '—'}</td>
                            <td className="px-4 py-3 text-slate-300">{p._roas > 0 ? `${p._roas.toFixed(2)}x` : '—'}</td>
                            <td className="px-4 py-3 text-slate-300">{p._orders || 0}</td>
                            <td className="px-4 py-3">
                              <span className={`font-semibold ${(p.fba_inventory || 0) === 0 ? 'text-red-400' : (p.fba_inventory || 0) < 10 ? 'text-amber-400' : 'text-white'}`}>
                                {p.fba_inventory ?? '—'}
                              </span>
                            </td>
                            <td className={`px-4 py-3 capitalize font-medium ${campColor}`}>{p.campaign_status || 'none'}</td>
                          </tr>
                        );
                      })}
                      {topProducts.length === 0 && (
                        <tr><td colSpan={9} className="px-4 py-8 text-center text-slate-500">Sem dados de produtos</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}