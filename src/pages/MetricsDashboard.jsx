import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, BarChart, Bar, Legend
} from 'recharts';
import { BarChart2, Loader2, TrendingUp, TrendingDown, RefreshCw, Target, Zap, AlertTriangle, Clock } from 'lucide-react';

function safe(num, decimals = 2) {
  if (!num || !isFinite(num) || isNaN(num)) return null;
  return Number(num.toFixed(decimals));
}
function fmt(val, prefix = '', suffix = '') {
  if (val == null) return 'Sem dados';
  return `${prefix}${val}${suffix}`;
}
function acosColor(v) {
  if (!v) return 'text-slate-500';
  return v > 50 ? 'text-red-400' : v > 30 ? 'text-amber-400' : 'text-emerald-400';
}

function KPICard({ label, value, sub, valueColor = 'text-white', loading, trend }) {
  if (loading) return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 animate-pulse">
      <div className="h-3 w-24 bg-surface-3 rounded mb-3" />
      <div className="h-7 w-32 bg-surface-3 rounded mb-2" />
    </div>
  );
  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
      <p className="text-xs font-medium text-slate-400 mb-2">{label}</p>
      <p className={`text-2xl font-bold mb-1 ${valueColor}`}>{value ?? 'Sem dados'}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
      {trend != null && (
        <div className={`flex items-center gap-1 mt-1 text-xs font-medium ${trend >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          {trend >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
          {trend >= 0 ? '+' : ''}{trend.toFixed(1)}%
        </div>
      )}
    </div>
  );
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface-1 border border-surface-2 rounded-lg p-3 text-xs shadow-xl">
      <p className="text-slate-400 mb-1.5 font-medium">{label}</p>
      {payload.map(p => (
        <p key={p.name} style={{ color: p.color }}>{p.name}: {typeof p.value === 'number' ? p.value.toFixed(2) : p.value}</p>
      ))}
    </div>
  );
};

export default function MetricsDashboard() {
  const [account, setAccount] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [metricsDaily, setMetricsDaily] = useState([]);
  const [keywords, setKeywords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState(30);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0] || (await base44.entities.AmazonAccount.list())[0];
      setAccount(acc);
      if (!acc) return;
      const [cams, metrics, kws] = await Promise.all([
        base44.entities.Campaign.filter({ amazon_account_id: acc.id }, '-spend', 2000),
        base44.entities.CampaignMetricsDaily.filter({ amazon_account_id: acc.id }, '-date', 300),
        base44.entities.Keyword.filter({ amazon_account_id: acc.id }, '-spend', 500),
      ]);
      setCampaigns(cams);
      setMetricsDaily(metrics);
      setKeywords(kws.filter(k => k.source !== 'search_term'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const cutoff = new Date(Date.now() - period * 86400000).toISOString().slice(0, 10);
  const periodMetrics = metricsDaily.filter(m => m.date >= cutoff);

  // Agregação por data
  const byDate = Object.values(
    periodMetrics.reduce((acc, m) => {
      if (!acc[m.date]) acc[m.date] = { name: m.date.slice(5), date: m.date, spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 };
      acc[m.date].spend += m.spend || 0;
      acc[m.date].sales += m.sales || 0;
      acc[m.date].orders += m.orders || 0;
      acc[m.date].clicks += m.clicks || 0;
      acc[m.date].impressions += m.impressions || 0;
      return acc;
    }, {})
  ).sort((a, b) => a.date.localeCompare(b.date)).map(d => ({
    ...d,
    acos: d.sales > 0 ? safe(d.spend / d.sales * 100) : null,
    roas: d.spend > 0 ? safe(d.sales / d.spend) : null,
    cpc: d.clicks > 0 ? safe(d.spend / d.clicks) : null,
    ctr: d.impressions > 0 ? safe(d.clicks / d.impressions * 100) : null,
  }));

  // KPIs totais do período
  const totals = periodMetrics.reduce((acc, m) => {
    acc.spend += m.spend || 0;
    acc.sales += m.sales || 0;
    acc.orders += m.orders || 0;
    acc.clicks += m.clicks || 0;
    acc.impressions += m.impressions || 0;
    return acc;
  }, { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 });

  const kpis = {
    acos: totals.sales > 0 ? safe(totals.spend / totals.sales * 100) : null,
    roas: totals.spend > 0 ? safe(totals.sales / totals.spend) : null,
    cpc: totals.clicks > 0 ? safe(totals.spend / totals.clicks) : null,
    ctr: totals.impressions > 0 ? safe(totals.clicks / totals.impressions * 100, 3) : null,
    cvr: totals.clicks > 0 ? safe(totals.orders / totals.clicks * 100) : null,
    cpa: totals.orders > 0 ? safe(totals.spend / totals.orders) : null,
    rpc: totals.clicks > 0 ? safe(totals.sales / totals.clicks) : null,
    avgTicket: totals.orders > 0 ? safe(totals.sales / totals.orders) : null,
  };

  // Top campanhas por ACoS
  const campByPerf = [...campaigns]
    .filter(c => (c.spend || 0) > 0)
    .sort((a, b) => (a.acos || 999) - (b.acos || 999))
    .slice(0, 10);

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <BarChart2 className="w-5 h-5 text-cyan" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Analytics</h1>
            <p className="text-xs text-slate-400">Métricas completas por período</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg overflow-hidden border border-surface-3">
            {[7, 14, 30, 60].map(d => (
              <button key={d} onClick={() => setPeriod(d)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${period === d ? 'bg-cyan text-white' : 'bg-surface-2 text-slate-400 hover:text-white'}`}>
                {d}d
              </button>
            ))}
          </div>
          <button onClick={load} disabled={loading} className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* KPIs principais */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard label={`Spend ${period}d`} value={fmt(safe(totals.spend), '$')} sub={`${totals.clicks.toLocaleString()} cliques`} loading={loading} />
        <KPICard label={`Vendas Ads ${period}d`} value={fmt(safe(totals.sales), '$')} sub={`${totals.orders} pedidos`} loading={loading} valueColor="text-emerald-400" />
        <KPICard label="ACoS" value={fmt(kpis.acos, '', '%')} loading={loading} valueColor={acosColor(kpis.acos)} sub={`ROAS: ${fmt(kpis.roas, '', 'x')}`} />
        <KPICard label="CPC Médio" value={fmt(kpis.cpc, '$')} loading={loading} sub={`CTR: ${fmt(kpis.ctr, '', '%')}`} />
      </div>

      {/* KPIs secundários */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard label="CVR (Conversão)" value={fmt(kpis.cvr, '', '%')} loading={loading} />
        <KPICard label="CPA" value={fmt(kpis.cpa, '$')} loading={loading} sub="Custo por pedido" />
        <KPICard label="RPC (Receita/Clique)" value={fmt(kpis.rpc, '$')} loading={loading} />
        <KPICard label="Ticket Médio" value={fmt(kpis.avgTicket, '$')} loading={loading} />
      </div>

      {/* Gráfico Spend vs Vendas */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-slate-300 mb-4">Spend vs Vendas ({period}d)</h2>
        {loading ? (
          <div className="h-52 flex items-center justify-center"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
        ) : byDate.length === 0 ? (
          <div className="h-52 flex items-center justify-center text-sm text-slate-500">Sem dados. Execute um Sync no Dashboard.</div>
        ) : (
          <ResponsiveContainer width="100%" height={210}>
            <AreaChart data={byDate}>
              <defs>
                <linearGradient id="gSpend" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.25} /><stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gSales" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10B981" stopOpacity={0.25} /><stop offset="95%" stopColor="#10B981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
              <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="spend" stroke="#3B82F6" fill="url(#gSpend)" strokeWidth={2} name="Spend ($)" />
              <Area type="monotone" dataKey="sales" stroke="#10B981" fill="url(#gSales)" strokeWidth={2} name="Vendas ($)" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Gráfico ACoS */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-slate-300 mb-4">ACoS Diário</h2>
          {byDate.length === 0 ? (
            <div className="h-40 flex items-center justify-center text-sm text-slate-500">Sem dados</div>
          ) : (
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={byDate}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} unit="%" />
                <Tooltip content={<CustomTooltip />} />
                <Line type="monotone" dataKey="acos" stroke="#F59E0B" strokeWidth={2} dot={false} name="ACoS (%)" connectNulls />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
          <h2 className="text-sm font-semibold text-slate-300 mb-4">ROAS Diário</h2>
          {byDate.length === 0 ? (
            <div className="h-40 flex items-center justify-center text-sm text-slate-500">Sem dados</div>
          ) : (
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={byDate}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
                <Tooltip content={<CustomTooltip />} />
                <Line type="monotone" dataKey="roas" stroke="#10B981" strokeWidth={2} dot={false} name="ROAS" connectNulls />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Keywords com desempenho horário */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-surface-2 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-300">Palavras-Chave com Desempenho Horário</h2>
            <p className="text-xs text-slate-500 mt-0.5">Otimização de lances baseada na conversão por horário</p>
          </div>
        </div>
        {loading ? (
          <div className="p-8 flex items-center justify-center"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
        ) : keywords.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">Sem keywords. Execute um Sync completo.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/40">
                  {['Keyword', 'Match', 'Melhor horário', 'Ação sugerida', 'Bid', 'ACoS', 'Cliques', 'Spend', 'Vendas', 'ROAS'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {keywords.slice(0, 50).map(kw => {
                  const hasHourlyData = kw.hourly_data_mature && kw.best_hour_start != null;
                  const start = kw.best_hour_start != null ? String(kw.best_hour_start).padStart(2, '0') : null;
                  const end = kw.best_hour_end != null ? String(kw.best_hour_end).padStart(2, '0') : null;
                  const actionColors = {
                    increase_peak: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
                    reduce_off_peak: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
                    maintain: 'text-cyan bg-cyan/10 border-cyan/20',
                    insufficient_data: 'text-slate-500 bg-slate-500/10 border-slate-500/20',
                  };
                  const actionLabels = {
                    increase_peak: '↑ Aumentar no pico',
                    reduce_off_peak: '↓ Reduzir fora do pico',
                    maintain: '→ Manter',
                    insufficient_data: 'Em aprendizado',
                  };
                  const acosCls = (kw.acos || 0) > 50 ? 'text-red-400' : (kw.acos || 0) > 30 ? 'text-amber-400' : 'text-emerald-400';
                  
                  return (
                    <tr key={kw.id} className="border-b border-surface-2/50 hover:bg-surface-2/50 transition-colors">
                      <td className="px-4 py-2.5 font-medium text-white max-w-[180px] truncate" title={kw.keyword_text}>{kw.keyword_text || '—'}</td>
                      <td className="px-4 py-2.5"><span className="text-xs px-2 py-0.5 bg-surface-3 text-slate-400 rounded">{kw.match_type || '—'}</span></td>
                      <td className="px-4 py-2.5">
                        {hasHourlyData ? (
                          <div className="flex items-center gap-1.5">
                            <Clock className="w-3.5 h-3.5 text-cyan" />
                            <span className="text-xs font-semibold text-white">{start}h–{end}h</span>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-500 italic">Dados insuficientes</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {hasHourlyData && kw.hourly_action_suggestion ? (
                          <span className={`text-xs px-2 py-1 rounded border font-medium ${actionColors[kw.hourly_action_suggestion] || actionColors.insufficient_data}`}>
                            {actionLabels[kw.hourly_action_suggestion] || actionLabels.insufficient_data}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-500">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-slate-300">${(kw.bid || 0).toFixed(2)}</td>
                      <td className={`px-4 py-2.5 font-semibold text-xs ${acosCls}`}>{(kw.acos || 0).toFixed(1)}%</td>
                      <td className="px-4 py-2.5 text-slate-400">{(kw.clicks || 0).toLocaleString()}</td>
                      <td className="px-4 py-2.5 text-slate-400">${(kw.spend || 0).toFixed(2)}</td>
                      <td className="px-4 py-2.5 text-emerald-400">${(kw.sales || 0).toFixed(2)}</td>
                      <td className="px-4 py-2.5 text-slate-300">{(kw.roas || 0).toFixed(2)}x</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Top campanhas */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-surface-2">
          <h2 className="text-sm font-semibold text-slate-300">Top Campanhas por ACoS ({period}d)</h2>
        </div>
        {loading ? (
          <div className="p-8 flex items-center justify-center"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/40">
                  {['Nome', 'Tipo', 'Estado', 'Spend', 'Vendas', 'ACoS', 'ROAS', 'CVR', 'CPC'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {campByPerf.length === 0 ? (
                  <tr><td colSpan={9} className="px-4 py-8 text-center text-sm text-slate-500">Sem dados. Execute um Sync.</td></tr>
                ) : campByPerf.map(c => {
                  const cvr = c.clicks > 0 ? safe(c.orders / c.clicks * 100) : null;
                  return (
                    <tr key={c.id} className="border-b border-surface-2/50 hover:bg-surface-2 transition-colors">
                      <td className="px-4 py-3 text-white font-medium truncate max-w-[200px]" title={c.name}>{c.name || '—'}</td>
                      <td className="px-4 py-3"><span className="text-xs px-1.5 py-0.5 rounded bg-surface-3 text-slate-400">{c.targeting_type || 'AUTO'}</span></td>
                      <td className="px-4 py-3">
                        <span className={`text-xs font-medium ${c.state === 'enabled' ? 'text-emerald-400' : c.state === 'paused' ? 'text-amber-400' : 'text-slate-400'}`}>
                          {c.state === 'enabled' ? 'Ativo' : c.state === 'paused' ? 'Pausado' : 'Arquivado'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-300">${(c.spend || 0).toFixed(2)}</td>
                      <td className="px-4 py-3 text-emerald-400">${(c.sales || 0).toFixed(2)}</td>
                      <td className={`px-4 py-3 font-semibold text-xs ${acosColor(c.acos)}`}>{(c.acos || 0).toFixed(1)}%</td>
                      <td className="px-4 py-3 text-slate-300">{(c.roas || 0).toFixed(2)}x</td>
                      <td className="px-4 py-3 text-slate-400">{fmt(cvr, '', '%')}</td>
                      <td className="px-4 py-3 text-slate-400">${(c.cpc || 0).toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}