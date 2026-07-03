import { useMemo } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts';
import { TrendingUp, TrendingDown, Minus, DollarSign, ShoppingCart, MousePointer, Target, Loader2 } from 'lucide-react';

function delta(curr, prev) {
  if (!prev || prev === 0) return null;
  return ((curr - prev) / prev) * 100;
}

function fmt(v, decimals = 2) {
  if (!v || !isFinite(v)) return '0,00';
  return v.toFixed(decimals).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function Trend({ pct }) {
  if (pct === null) return <span className="text-slate-600 text-[10px]">—</span>;
  const up = pct >= 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-semibold ${up ? 'text-emerald-400' : 'text-red-400'}`}>
      <Icon className="w-3 h-3" />
      {up ? '+' : ''}{pct.toFixed(1)}%
    </span>
  );
}

const CustomTooltip = ({ active, payload, label, sym }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#111318] border border-surface-2 rounded-xl p-3 text-xs shadow-xl min-w-[180px]">
      <p className="font-semibold text-slate-300 mb-2">{label}</p>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-slate-400">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
            {p.name}
          </span>
          <span className="font-semibold text-white">
            {p.name === 'ACoS' ? `${fmt(p.value, 1)}%`
              : p.name === 'ROAS' ? `${fmt(p.value, 2)}x`
              : `${sym}${fmt(p.value)}`}
          </span>
        </div>
      ))}
    </div>
  );
};

export default function BudgetReport14d({ metricsDaily, campaigns, loading, sym = 'R$' }) {
  const { chartData, kpis, prev7kpis, avgSpend, targetBudget, budgetUtil } = useMemo(() => {
    const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);

    // Deduplicar por campaign_id+date
    const seen = new Set();
    const deduped = metricsDaily.filter(m => {
      if (!m.date || m.date < cutoff || m.date >= today) return false;
      const key = `${m.campaign_id || ''}-${m.date}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Agrupar por dia
    const byDay = {};
    for (const m of deduped) {
      if (!byDay[m.date]) byDay[m.date] = { date: m.date, spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 };
      byDay[m.date].spend      += m.spend      || 0;
      byDay[m.date].sales      += m.sales      || 0;
      byDay[m.date].orders     += m.orders     || 0;
      byDay[m.date].clicks     += m.clicks     || 0;
      byDay[m.date].impressions += m.impressions || 0;
    }

    const days = Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));

    // Budget ativo total das campanhas ativas
    const activeBudget = campaigns
      .filter(c => c.state === 'enabled' || c.status === 'enabled')
      .reduce((s, c) => s + (c.daily_budget || 0), 0);

    // Métricas derivadas por dia
    const chartData = days.map(d => {
      const acos = d.sales > 0 ? (d.spend / d.sales) * 100 : 0;
      const roas = d.spend > 0 ? d.sales / d.spend : 0;
      const cpc  = d.clicks > 0 ? d.spend / d.clicks : 0;
      const util = activeBudget > 0 ? (d.spend / activeBudget) * 100 : 0;
      return {
        name: d.date.slice(5).replace('-', '/'),
        date: d.date,
        spend: Number(d.spend.toFixed(2)),
        sales: Number(d.sales.toFixed(2)),
        orders: d.orders,
        clicks: d.clicks,
        acos: Number(acos.toFixed(1)),
        roas: Number(roas.toFixed(2)),
        cpc: Number(cpc.toFixed(2)),
        budgetUtil: Number(util.toFixed(1)),
        activeBudget: Number(activeBudget.toFixed(2)),
      };
    });

    // KPIs janela completa 14d
    const total = days.reduce((acc, d) => ({
      spend: acc.spend + d.spend,
      sales: acc.sales + d.sales,
      orders: acc.orders + d.orders,
      clicks: acc.clicks + d.clicks,
    }), { spend: 0, sales: 0, orders: 0, clicks: 0 });

    // KPIs primeiros 7d (para comparação)
    const first7 = days.slice(0, 7).reduce((acc, d) => ({
      spend: acc.spend + d.spend,
      sales: acc.sales + d.sales,
      orders: acc.orders + d.orders,
      clicks: acc.clicks + d.clicks,
    }), { spend: 0, sales: 0, orders: 0, clicks: 0 });

    // KPIs últimos 7d
    const last7 = days.slice(-7).reduce((acc, d) => ({
      spend: acc.spend + d.spend,
      sales: acc.sales + d.sales,
      orders: acc.orders + d.orders,
      clicks: acc.clicks + d.clicks,
    }), { spend: 0, sales: 0, orders: 0, clicks: 0 });

    const avgSpend = days.length > 0 ? total.spend / days.length : 0;
    const targetBudget = avgSpend * 1.25;
    const budgetUtil = activeBudget > 0 ? (avgSpend / activeBudget) * 100 : 0;

    return { chartData, kpis: last7, prev7kpis: first7, avgSpend, targetBudget, budgetUtil, activeBudget };
  }, [metricsDaily, campaigns]);

  const sym_ = sym;

  const kpiCards = [
    {
      label: 'Gasto Total 14d',
      value: `${sym_}${fmt(chartData.reduce((s, d) => s + d.spend, 0))}`,
      sub: `Média: ${sym_}${fmt(avgSpend)}/dia`,
      icon: DollarSign,
      color: 'text-cyan',
      bg: 'bg-cyan/10 border-cyan/20',
      delta: delta(kpis.spend, prev7kpis.spend),
    },
    {
      label: 'Vendas Ads 14d',
      value: `${sym_}${fmt(chartData.reduce((s, d) => s + d.sales, 0))}`,
      sub: `${chartData.reduce((s, d) => s + d.orders, 0)} pedidos`,
      icon: ShoppingCart,
      color: 'text-emerald-400',
      bg: 'bg-emerald-400/10 border-emerald-400/20',
      delta: delta(kpis.sales, prev7kpis.sales),
    },
    {
      label: 'Budget Sugerido',
      value: `${sym_}${fmt(targetBudget)}/dia`,
      sub: `Média 14d × 1.25`,
      icon: Target,
      color: 'text-violet-400',
      bg: 'bg-violet-400/10 border-violet-400/20',
      delta: null,
    },
    {
      label: 'Utiliz. de Budget',
      value: `${fmt(budgetUtil, 1)}%`,
      sub: budgetUtil > 90 ? '⚠ Risco de esgotamento' : budgetUtil > 70 ? 'Utilização alta' : 'Margem disponível',
      icon: MousePointer,
      color: budgetUtil > 90 ? 'text-red-400' : budgetUtil > 70 ? 'text-amber-400' : 'text-emerald-400',
      bg: budgetUtil > 90 ? 'bg-red-400/10 border-red-400/20' : budgetUtil > 70 ? 'bg-amber-400/10 border-amber-400/20' : 'bg-emerald-400/10 border-emerald-400/20',
      delta: null,
    },
  ];

  if (loading) return (
    <div className="flex items-center justify-center py-24">
      <Loader2 className="w-6 h-6 text-cyan animate-spin" />
    </div>
  );

  if (chartData.length === 0) return (
    <div className="flex flex-col items-center justify-center py-20 text-slate-500 gap-2">
      <DollarSign className="w-8 h-8 text-slate-600" />
      <p className="text-sm">Sem dados dos últimos 14 dias. Execute um Sync completo.</p>
    </div>
  );

  return (
    <div className="space-y-5">

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpiCards.map(card => {
          const Icon = card.icon;
          return (
            <div key={card.label} className={`rounded-xl border p-4 ${card.bg}`}>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-slate-400">{card.label}</p>
                <Icon className={`w-4 h-4 ${card.color}`} />
              </div>
              <p className={`text-xl font-bold ${card.color}`}>{card.value}</p>
              <div className="flex items-center justify-between mt-1 gap-1">
                <p className="text-[10px] text-slate-500 truncate">{card.sub}</p>
                {card.delta !== null && <Trend pct={card.delta} />}
              </div>
            </div>
          );
        })}
      </div>

      {/* Gráfico principal: Spend vs Vendas + Budget diário */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div>
            <h3 className="text-sm font-semibold text-white">Gasto Diário vs Vendas</h3>
            <p className="text-xs text-slate-500 mt-0.5">Linha pontilhada = budget ativo total disponível por dia</p>
          </div>
          <div className="flex items-center gap-3 text-[10px] text-slate-500">
            <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-cyan/70 inline-block" /> Gasto</span>
            <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-emerald-400/70 inline-block" /> Vendas</span>
            <span className="flex items-center gap-1"><span className="w-6 h-0 border-t-2 border-dashed border-amber-400/70 inline-block" /> Budget Ativo</span>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
            <YAxis yAxisId="left" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} tickFormatter={v => `${sym_}${v.toFixed(0)}`} />
            <Tooltip content={<CustomTooltip sym={sym_} />} />
            <Bar yAxisId="left" dataKey="spend" name="Gasto" fill="#3B82F6" opacity={0.85} radius={[3, 3, 0, 0]} maxBarSize={28} />
            <Bar yAxisId="left" dataKey="sales" name="Vendas" fill="#10B981" opacity={0.75} radius={[3, 3, 0, 0]} maxBarSize={28} />
            <Line yAxisId="left" type="monotone" dataKey="activeBudget" name="Budget Ativo" stroke="#F59E0B" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Gráfico ACoS + ROAS */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-1">ACoS Diário (%)</h3>
          <p className="text-[10px] text-slate-500 mb-3">Menor = mais eficiente. Linha = alvo 25%</p>
          <ResponsiveContainer width="100%" height={160}>
            <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
              <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} tickFormatter={v => `${v}%`} />
              <Tooltip content={<CustomTooltip sym={sym_} />} />
              <ReferenceLine y={25} stroke="#F59E0B" strokeDasharray="4 3" strokeWidth={1} label={{ value: '25%', position: 'insideTopRight', fontSize: 9, fill: '#F59E0B' }} />
              <Bar dataKey="acos" name="ACoS" fill="#EF4444" opacity={0.8} radius={[3, 3, 0, 0]} maxBarSize={24}
                label={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
          <h3 className="text-sm font-semibold text-white mb-1">ROAS Diário</h3>
          <p className="text-[10px] text-slate-500 mb-3">Maior = melhor retorno. Linha = alvo 4×</p>
          <ResponsiveContainer width="100%" height={160}>
            <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
              <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} tickFormatter={v => `${v}x`} />
              <Tooltip content={<CustomTooltip sym={sym_} />} />
              <ReferenceLine y={4} stroke="#10B981" strokeDasharray="4 3" strokeWidth={1} label={{ value: '4×', position: 'insideTopRight', fontSize: 9, fill: '#10B981' }} />
              <Line type="monotone" dataKey="roas" name="ROAS" stroke="#3B82F6" strokeWidth={2} dot={{ r: 3, fill: '#3B82F6' }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Utilização de Budget por dia */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
        <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
          <h3 className="text-sm font-semibold text-white">Utilização do Budget Diário (%)</h3>
          <div className="flex items-center gap-3 text-[10px] text-slate-500">
            <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-emerald-400/60 inline-block" /> &lt;70%</span>
            <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-amber-400/60 inline-block" /> 70–90%</span>
            <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-red-400/60 inline-block" /> &gt;90%</span>
          </div>
        </div>
        <p className="text-[10px] text-slate-500 mb-3">Gasto real ÷ budget ativo total. Acima de 90% indica risco de campanhas pararem.</p>
        <ResponsiveContainer width="100%" height={140}>
          <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
            <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} domain={[0, 100]} tickFormatter={v => `${v}%`} />
            <Tooltip content={<CustomTooltip sym={sym_} />} />
            <ReferenceLine y={90} stroke="#EF4444" strokeDasharray="4 3" strokeWidth={1} />
            <ReferenceLine y={70} stroke="#F59E0B" strokeDasharray="4 3" strokeWidth={1} />
            <Bar dataKey="budgetUtil" name="Utilização" maxBarSize={24} radius={[3, 3, 0, 0]}
              fill="#10B981"
              // cor condicional via Cell não disponível sem Cell import — usar cor fixa e deixar as linhas de ref falarem
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Tabela resumo por dia */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-surface-2">
          <h3 className="text-sm font-semibold text-white">Detalhamento Diário</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-surface-2 bg-surface-2/50">
                {['Data', 'Gasto', 'Vendas', 'ROAS', 'ACoS', 'Pedidos', 'Cliques', 'Util. Budget'].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {chartData.map((d, i) => {
                const acosColor = d.acos > 40 ? 'text-red-400' : d.acos > 25 ? 'text-amber-400' : d.acos > 0 ? 'text-emerald-400' : 'text-slate-600';
                const utilColor = d.budgetUtil > 90 ? 'text-red-400' : d.budgetUtil > 70 ? 'text-amber-400' : 'text-emerald-400';
                const roasColor = d.roas >= 4 ? 'text-emerald-400' : d.roas >= 2 ? 'text-amber-400' : 'text-slate-400';
                return (
                  <tr key={i} className="border-b border-surface-2/40 hover:bg-surface-2/40 transition-colors">
                    <td className="px-4 py-2.5 font-mono text-slate-300">{d.date}</td>
                    <td className="px-4 py-2.5 font-semibold text-white">{sym_}{fmt(d.spend)}</td>
                    <td className="px-4 py-2.5 text-emerald-400">{sym_}{fmt(d.sales)}</td>
                    <td className={`px-4 py-2.5 font-semibold ${roasColor}`}>{fmt(d.roas, 2)}×</td>
                    <td className={`px-4 py-2.5 font-semibold ${acosColor}`}>{d.acos > 0 ? `${fmt(d.acos, 1)}%` : '—'}</td>
                    <td className="px-4 py-2.5 text-slate-300">{d.orders}</td>
                    <td className="px-4 py-2.5 text-slate-400">{d.clicks.toLocaleString('pt-BR')}</td>
                    <td className={`px-4 py-2.5 font-semibold ${utilColor}`}>
                      {d.budgetUtil > 0 ? `${fmt(d.budgetUtil, 1)}%` : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}