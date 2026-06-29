import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { BarChart as ChartIcon, TrendingUp, TrendingDown, Loader2, RefreshCw } from 'lucide-react';
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import StatusBadge from '@/components/ui/StatusBadge';

export default function Report() {
  const [account, setAccount] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [metricsDaily, setMetricsDaily] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('day');

  // Shared load across all
  const loadData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0] || null;
      setAccount(acc);
      if (!acc) return;
      const [c, md] = await Promise.all([
        base44.entities.Campaign.filter({ amazon_account_id: acc.id }, '-spend', 500),
        base44.entities.CampaignMetricsDaily.filter({ amazon_account_id: acc.id }, '-date', 90),
      ]);
      setCampaigns(c); setMetricsDaily(md);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Aggregate metrics per day across all campaigns
  const daysAgg = metricsDaily.reduce((a, m) => {
    const d = m.date;
    if (!d) return a;
    if (!a[d]) a[d] = { name: d.slice(5), spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0, acos: 0, roas: 0 };
    a[d].spend += m.spend || 0;
    a[d].sales += m.sales || 0;
    a[d].orders += m.orders || 0;
    a[d].clicks += m.clicks || 0;
    a[d].impressions += m.impressions || 0;
    return a;
  }, {});

  const daysData = Object.values(daysAgg).sort((a, b) => a.name.localeCompare(b.name)).slice(-31);

  // Compute ACoS+ROAS per day
  const enrichedDays = daysData.map(d => ({
    ...d,
    spend: +d.spend.toFixed(2),
    sales: +d.sales.toFixed(2),
    acos: d.sales > 0 ? +((d.spend / d.sales * 100).toFixed(1)) : 0,
    roas: d.spend > 0 ? +((d.sales / d.spend).toFixed(2)) : 0,
    adjustedSpend: +d.spend.toFixed(2),
    adjustedsales: +d.sales.toFixed(2),
  }));

  const totalSpend = enrichedDays.reduce((s, d) => s + d.spend, 0);
  const totalSales = enrichedDays.reduce((s, d) => s + d.sales, 0);
  const totalOrders = enrichedDays.reduce((s, d) => s + d.orders, 0);
  const weekSpend = enrichedDays.slice(-7).reduce((s, d) => s + d.spend, 0);
  const weekSales = enrichedDays.slice(-7).reduce((s, d) => s + d.sales, 0);

  // Placeholder for the kpis static variable
  const kpis = [
    { label: 'Total 30d Spend', value: `$${totalSpend.toFixed(0)}`, color: 'text-white' },
    { label: 'Total 30d Sales', value: `$${totalSales.toFixed(0)}`, color: 'text-emerald-400', sub: `${totalOrders} Orders` },
    { label: 'Avg Daily Spend', value: `$${enrichedDays.length > 0 ? (totalSpend / enrichedDays.length).toFixed(2) : '0.00'}`, color: 'text-white' },
    { label: 'ACoS semanal', value: weekSales > 0 ? `${((weekSpend / weekSales) * 100).toFixed(1)}%` : '—', color: 'text-amber-400' },
  ];

  // Renders
  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-10 h-10 border border-cyan/20 rounded-xl bg-cyan/15">

<p className="text-xs font-semibold text-state-500" style={{ whiteSpace: 'nowrap', paddingLeft: '8px', backgroundColor: 'inherit' }}>Relatório Consolidado</p>

<span className="justify-content-end fixed-top-20"><button onClick={loadData} disabled={loading}>
  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''} text-slate-400 hover:text-white transition-colors`} />
</button></span>
        </div>
      </div>

      {error && <div className="rounded-xl p-4 text-sm bg-red-500/10 border border-red-500/20 text-red-400">{error}</div>}

      {loading ? (
        <div className="py-24 flex justify-center"><Loader2 className="w-8 h-8 text-cyan animate-spin" /></div>
      ) : !account ? (
        <div className="text-center py-24 text-slate-500">Nenhuma conta Amazon configurada.<br/>Configure na página de Configurações.</div>
      ) : enrichedDays.length === 0 ? (
        <div className="text-center py-24 text-sm text-slate-500">Execute o sync diário para popular métricas por dia.</div>
      ) : (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {kpis.map((k, i) => (
              <div key={i} className="bg-surface-1 border border-surface-2 rounded-xl p-5">
                <p className="text-xs text-slate-500 mb-1">{k.label}</p>
                <p className={`text-xl font-bold ${k.color}`}>{k.value}</p>
                {k.sub && <p className="text-xs text-slate-600 mt-1">{k.sub}</p>}
              </div>
            ))}
            <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
              <p className="text-xs text-slate-500 mb-1">ACoS global</p>
              <p className="text-xl font-bold text-amber-400">{totalSales > 0 ? `${((totalSpend / totalSales) * 100).toFixed(1)}%` : '—'}</p>
            </div>
            <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
              <p className="text-xs text-slate-500 mb-1">ROAS global</p>
              <p className="text-xl font-bold text-cyan">{totalSpend > 0 ? `${(totalSales / totalSpend).toFixed(2)}x` : '—'}</p>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-surface-2">
            {['day', 'campaign'].map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors uppercase ${tab === t ? 'border-cyan text-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
                {t === 'day' ? 'VISÃO DIÁRIA' : 'CAMPANHAS'}
              </button>
            ))}
          </div>

          {tab === 'day' && (
            <>
              {/* Composed chart: area + line */}
              <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
                <h2 className="text-sm font-semibold text-slate-300 mb-4">Spend vs Sales vs ACoS (30 dias)</h2>
                <div className="h-56">
                  <ResponsiveContainer>
                    <ComposedChart data={enrichedDays} margin={{ top:5, right:5, bottom:0, left:0 }}>
                      <defs>
                        <linearGradient id="gtSpend" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3B82F6" stopOpacity={0.25}/><stop offset="95%" stopColor="#3B82F6" stopOpacity={0}/></linearGradient>
                        <linearGradient id="gtSales" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#10B981" stopOpacity={0.2}/><stop offset="95%" stopColor="#10B981" stopOpacity={0}/></linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                      <XAxis dataKey="name" tick={{ fontSize:10, fill:'#64748b' }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize:10, fill:'#64748b' }} axisLine={false} tickLine={false} domain={[0, 'auto']} />
                      <YAxis yAxisId="acos" orientation="right" tick={{ fontSize:10, fill:'#64748b' }} axisLine={false} tickLine={false}
                        domain={[0, 100]} label={{ value:'ACoS %', angle:-90, position:'insideRight', fill:'#64748b', fontSize:10 }} />
                      <Tooltip contentStyle={{ background:'#111318', border:'1px solid #1A1D26', borderRadius:8, fontSize:12 }}
                        formatter={(v,name) => [name==='ACoS %' ? `${v}%` : `$${Number(v).toFixed(2)}`, name]} />
                      <Legend />
                      <Bar dataKey="spend" fill="#3B82F6" radius={[4,4,4,4]} name="Spend" maxBarSize={18} />
                      <Bar dataKey="sales" fill="#10B981" radius={[4,4,4,4]} name="Sales" maxBarSize={18} />
                      <Line type="monotone" yAxisId="acos" dataKey="acos" stroke="#F59E0B" strokeWidth={1.5} name="ACoS %" dot={false} strokeDasharray="5 5" />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Row table: day performance */}
              <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
                <div className="px-5 py-3 border-b border-surface-2 text-sm font-semibold text-white">Detalhamento Diário</div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-surface-2 bg-surface-2/50">
                        {['Dia', 'Gasto', 'Vendas', 'Variação Vendas', 'ACoS', 'Pedidos', 'Cliques'].map(h => (
                          <th key={h} className="text-xs font-semibold uppercase tracking-wider text-left px-4 py-3 text-slate-500 whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[...enrichedDays].reverse().map((d, i) => {
                        const prev = i+1 < enrichedDays.length ? enrichedDays[enrichedDays.length - 1 - i] || { sales: d.sales } : null;
                        const pct = prev && prev.sales > 0 ? ((d.sales - prev.sales) / prev.sales * 100) : 0;
                        const sign = pct >= 0;
                        return (
                          <tr key={i} className="hover:bg-surface-2/30 border-b border-surface-2/40">
                            <td className="px-4 py-3 text-xs font-medium text-white whitespace-nowrap">{d.name}</td>
                            <td className="px-4 py-3 text-xs text-slate-300">${d.spend.toFixed(2)}</td>
                            <td className="px-4 py-3 text-xs text-emerald-400">${d.sales.toFixed(2)}</td>
                            <td className="px-4 py-3">
                              <span className={`flex items-center gap-1 text-xs font-semibold ${sign ? 'text-emerald-400' : 'text-red-400'}`}>
                                {sign ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                                {sign ? '+' : ''}{pct.toFixed(1)}%
                              </span>
                            </td>
                            <td className="px-4 py-3 text-xs font-semibold">
                              <span className={d.acos > 50 ? 'text-red-400' : d.acos > 25 ? 'text-amber-400' : 'text-emerald-400'}>
                                {d.acos}%
                              </span>
                            </td>
                            <td className="px-4 py-3 text-xs text-slate-400">{d.orders}</td>
                            <td className="px-4 py-3 text-xs text-slate-400">{d.clicks.toLocaleString()}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {tab === 'campaign' && (
            <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
              <div className="px-5 py-3 border-b border-surface-2 text-sm font-semibold text-white">Campanhas</div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-surface-2 bg-surface-2/50">
                      {['Nome', 'Tipo', 'Estado', 'Budget', 'Spend', 'Sales', 'ACoS', 'ROAS', 'Cliques', 'Impressões'].map(h => (
                        <th key={h} className="text-xs font-semibold uppercase tracking-wider text-left px-4 py-3 text-slate-500 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.map((c, i) => {
                      const acosVal = c.acos || 0;
                      const highlight = (campaignType) => {
                        if (c.spend > 5 && c.sales === 0 && acosVal === 0) return 'bg-red-500/5 border-red-500/20';
                        return acosVal > 50 && c.spend > 5 ? 'bg-amber-500/5 border-amber-500/20' : '';
                      };
                      return (
                        <tr key={c.id || i} className={`hover:bg-surface-2/30 border-b border-surface-2/40 ${highlight(c.spend)}`}>
                          <td className="px-4 py-3 text-xs text-white font-medium truncate max-w-[180px]">{c.name || '—'}</td>
                          <td className="px-4 py-3">
                            <span className="text-xs font-mono px-1.5 py-0.5 bg-surface-3 text-slate-400 rounded">{c.campaign_type || 'SP'}</span>
                          </td>
                          <td className="px-4 py-3"><StatusBadge status={c.state || 'enabled'} size="xs" /></td>
                          <td className="px-4 py-3 font-mono text-xs text-slate-300">${(c.daily_budget || 0).toFixed(2)}</td>
                          <td className="px-4 py-3 font-mono text-xs text-slate-300">${(c.spend || 0).toFixed(2)}</td>
                          <td className="px-4 py-3 font-mono text-xs text-emerald-400">${(c.sales || 0).toFixed(2)}</td>
                          <td className="px-4 py-3 text-xs font-semibold">
                            <span className={
                              acosVal > 50 ? 'text-red-400' : acosVal > 30 ? 'text-amber-400' : acosVal > 0 ? 'text-emerald-400' : 'text-slate-500'
                            }>
                              {acosVal > 0 ? `${acosVal.toFixed(1)}%` : '—'}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs text-cyan">{(c.roas || 0).toFixed(2)}x</td>
                          <td className="px-4 py-3 text-xs text-slate-400">{(c.clicks || 0).toLocaleString()}</td>
                          <td className="px-4 py-3 text-xs text-slate-400">{(c.impressions || 0).toLocaleString()}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}