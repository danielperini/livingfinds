import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import { TrendingUp, TrendingDown, Minus, Loader2, RefreshCw, BarChart2 } from 'lucide-react';

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
  const [loading, setLoading] = useState(true);
  const [selectedAsin, setSelectedAsin] = useState('all');
  const [period, setPeriod] = useState(30);

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
      const [prods, mets, camps] = await Promise.all([
        base44.entities.Product.filter({ amazon_account_id: aid }, '-total_sales_30d', 100),
        base44.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 2000),
        base44.entities.Campaign.filter({ amazon_account_id: aid }, '-spend', 500),
      ]);
      setProducts(prods);
      setMetrics(mets);
      setCampaigns(camps);
      // KPI de decisões pendentes do Autopilot
      const pendingDecs = await base44.entities.OptimizationDecision.filter({ amazon_account_id: aid, status: 'pending' }, '-created_at', 5);
      if (pendingDecs.length > 0) {
        console.info(`📋 ${pendingDecs.length} decisões Autopilot pendentes de revisão.`);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Dados para gráficos ──

  // Agregar métricas diárias por data (filtrado por período)
  const cutoffDate = new Date(Date.now() - period * 86400000);
  cutoffDate.setHours(0, 0, 0, 0);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  const filteredMetrics = metrics.filter(m => m.date && m.date >= cutoff);

  // Deduplicar por (campaign_id, date) antes de agregar
  const dedupMap = new Map();
  filteredMetrics.forEach(m => {
    const key = `${m.campaign_id || 'global'}-${m.date}`;
    if (!dedupMap.has(key)) {
      dedupMap.set(key, m);
    }
  });
  const dedupedMetrics = Array.from(dedupMap.values());

  const dailyData = Object.values(
    dedupedMetrics.reduce((acc, m) => {
      const d = m.date || '';
      const [yy, mm, dd_] = d.split('-');
      const label = d ? `${dd_}/${mm}` : d; // DD/MM
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

  // Top produtos por receita
  const topProducts = [...products]
    .sort((a, b) => (b.total_sales_30d || b.total_revenue_30d || 0) - (a.total_sales_30d || a.total_revenue_30d || 0))
    .slice(0, 10);

  const productBarData = topProducts.map(p => ({
    name: p.asin,
    Receita: p.total_sales_30d || p.total_revenue_30d || 0,
    Spend: p.total_spend_30d || 0,
    ACoS: p.acos || 0,
  }));

  // ACoS por campanha (top 10)
  const campAcosData = [...campaigns]
    .filter(c => (c.spend || 0) > 0)
    .sort((a, b) => (b.spend || 0) - (a.spend || 0))
    .slice(0, 10)
    .map(c => ({
      name: (c.name || c.campaign_name || c.campaign_id || '').slice(0, 20),
      ACoS: c.acos || 0,
      Spend: c.spend || 0,
      Vendas: c.sales || 0,
    }));

  // KPIs globais
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

  // Tendência: comparar primeira e segunda metade do período
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
          <p className="text-sm text-slate-400 mt-0.5">Vendas diárias e tendências de ACoS por produto</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Seletor de período */}
          <div className="flex bg-surface-2 border border-surface-3 rounded-lg p-0.5 gap-0.5">
            {[7, 14, 30, 60].map(d => (
              <button key={d} onClick={() => setPeriod(d)}
                className={`px-3 py-1.5 rounded text-xs font-semibold transition-all ${period === d ? 'bg-cyan text-white' : 'text-slate-400 hover:text-slate-200'}`}>
                {d}d
              </button>
            ))}
          </div>
          <button onClick={loadData} disabled={loading}
            className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

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
          {/* Gráfico 1: Vendas & Spend diários */}
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

          {/* Gráfico 2: Tendência de ACoS diário */}
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
                {/* Linha de referência manual */}
                <Line type="monotone" dataKey="acos" name="ACoS" stroke="#F59E0B" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="roas" name="ROAS" stroke="#8B5CF6" strokeWidth={1.5} dot={false} strokeDasharray="4 4" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Grid: Cliques & Pedidos + ACoS por campanha */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Cliques e Pedidos diários */}
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

            {/* ACoS por campanha */}
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

          {/* Gráfico Impressões por Dia */}
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

          {/* Receita por produto */}
          <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-slate-300 mb-4">Receita & Spend por Produto (Top 10, 30d)</h2>
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

          {/* Tabela resumo de produtos */}
          <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-surface-2">
              <h2 className="text-sm font-semibold text-slate-300">Resumo de Performance por Produto</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-surface-2">
                    {['ASIN', 'SKU', 'Receita 30d', 'Spend 30d', 'ACoS', 'ROAS', 'Units', 'Stock FBA', 'Campanha'].map(h => (
                      <th key={h} className="px-4 py-3 text-left font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {topProducts.map((p, i) => {
                    const acos = p.acos || 0;
                    const acosColor = acos > 50 ? 'text-red-400' : acos > 25 ? 'text-amber-400' : 'text-emerald-400';
                    const campColor = p.campaign_status === 'active' ? 'text-emerald-400' : p.campaign_status === 'paused' ? 'text-amber-400' : 'text-slate-500';
                    return (
                      <tr key={p.id || i} className="border-b border-surface-2/50 hover:bg-surface-2 transition-colors">
                        <td className="px-4 py-3 font-mono text-cyan">{p.asin}</td>
                        <td className="px-4 py-3 text-slate-400 font-mono">{p.sku || '—'}</td>
                        <td className="px-4 py-3 text-emerald-400">R${(p.total_sales_30d || p.total_revenue_30d || 0).toFixed(2)}</td>
                        <td className="px-4 py-3 text-slate-300">R${(p.total_spend_30d || 0).toFixed(2)}</td>
                        <td className={`px-4 py-3 font-semibold ${acosColor}`}>{acos.toFixed(1)}%</td>
                        <td className="px-4 py-3 text-slate-300">{(p.roas || 0).toFixed(2)}x</td>
                        <td className="px-4 py-3 text-slate-300">{p.total_units_30d || p.units_sold_30d || 0}</td>
                        <td className="px-4 py-3">
                          <span className={`font-semibold ${(p.fba_inventory || 0) === 0 ? 'text-red-400' : (p.fba_inventory || 0) < 10 ? 'text-amber-400' : 'text-white'}`}>
                            {p.fba_inventory || 0}
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
    </div>
  );
}