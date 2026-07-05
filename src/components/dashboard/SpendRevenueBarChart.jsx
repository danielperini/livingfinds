import React, { useState } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend
} from 'recharts';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

const TOOLTIP_STYLE = {
  contentStyle: { background: '#111318', border: '1px solid #1A1D26', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: '#94a3b8', marginBottom: 4 },
};

function Stat({ label, value, color = 'text-white' }) {
  return (
    <div className="bg-surface-2 rounded-lg px-3 py-2 min-w-[90px]">
      <p className="text-[10px] text-slate-500 mb-0.5">{label}</p>
      <p className={`text-sm font-bold ${color}`}>{value}</p>
    </div>
  );
}

function Trend({ pct }) {
  if (pct === null) return null;
  const abs = Math.abs(pct).toFixed(1);
  if (pct > 2) return <span className="flex items-center gap-0.5 text-emerald-400 text-xs font-semibold"><TrendingUp className="w-3 h-3" />+{abs}%</span>;
  if (pct < -2) return <span className="flex items-center gap-0.5 text-red-400 text-xs font-semibold"><TrendingDown className="w-3 h-3" />-{abs}%</span>;
  return <span className="flex items-center gap-0.5 text-slate-400 text-xs font-semibold"><Minus className="w-3 h-3" />{abs}%</span>;
}

export default function SpendRevenueBarChart({ chartData = [], loading = false, sym = 'R$' }) {
  const [range, setRange] = useState(14);

  const sliced = chartData.slice(-range);

  // Totais do período
  const totSpend = sliced.reduce((s, d) => s + (d.spend || 0), 0);
  const totSales = sliced.reduce((s, d) => s + (d.sales || 0), 0);
  const avgAcos = totSales > 0 ? (totSpend / totSales * 100) : 0;
  const roas = totSpend > 0 ? (totSales / totSpend) : 0;

  // Tendência: comparar primeira metade vs segunda metade
  const mid = Math.floor(sliced.length / 2);
  const firstHalf = sliced.slice(0, mid);
  const secondHalf = sliced.slice(mid);
  const avgSpend1 = firstHalf.length ? firstHalf.reduce((s, d) => s + (d.spend || 0), 0) / firstHalf.length : 0;
  const avgSpend2 = secondHalf.length ? secondHalf.reduce((s, d) => s + (d.spend || 0), 0) / secondHalf.length : 0;
  const spendTrend = avgSpend1 > 0 ? ((avgSpend2 - avgSpend1) / avgSpend1 * 100) : null;
  const avgSales1 = firstHalf.length ? firstHalf.reduce((s, d) => s + (d.sales || 0), 0) / firstHalf.length : 0;
  const avgSales2 = secondHalf.length ? secondHalf.reduce((s, d) => s + (d.sales || 0), 0) / secondHalf.length : 0;
  const salesTrend = avgSales1 > 0 ? ((avgSales2 - avgSales1) / avgSales1 * 100) : null;

  // Enriquecer com ACoS por dia
  const data = sliced.map(d => ({
    ...d,
    acos: d.sales > 0 ? parseFloat((d.spend / d.sales * 100).toFixed(1)) : 0,
  }));

  const fmt = (v) => `${sym}${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="text-sm font-semibold text-slate-300">Gasto vs Receita por Dia</h2>
          <p className="text-[11px] text-slate-500 mt-0.5">Barras agrupadas · ACoS diário como linha</p>
        </div>
        <div className="flex items-center gap-1">
          {[7, 14, 30].map(r => (
            <button key={r} onClick={() => setRange(r)}
              className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${range === r ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'}`}>
              {r}d
            </button>
          ))}
        </div>
      </div>

      {/* Mini KPIs */}
      <div className="flex flex-wrap gap-2 mb-4">
        <Stat label={`Gasto ${range}d`} value={fmt(totSpend)} color="text-blue-400" />
        <Stat label={`Receita ${range}d`} value={fmt(totSales)} color="text-emerald-400" />
        <Stat label="ACoS médio" value={`${avgAcos.toFixed(1)}%`} color={avgAcos > 40 ? 'text-red-400' : avgAcos > 25 ? 'text-amber-400' : 'text-emerald-400'} />
        <Stat label="ROAS" value={`${roas.toFixed(2)}x`} color="text-purple-400" />
        <div className="bg-surface-2 rounded-lg px-3 py-2 flex flex-col gap-0.5 min-w-[90px]">
          <p className="text-[10px] text-slate-500">Tend. Gasto</p>
          <Trend pct={spendTrend} />
        </div>
        <div className="bg-surface-2 rounded-lg px-3 py-2 flex flex-col gap-0.5 min-w-[90px]">
          <p className="text-[10px] text-slate-500">Tend. Receita</p>
          <Trend pct={salesTrend} />
        </div>
      </div>

      {/* Gráfico */}
      {loading ? (
        <div className="h-56 flex items-center justify-center">
          <div className="w-5 h-5 border-2 border-cyan/40 border-t-cyan rounded-full animate-spin" />
        </div>
      ) : data.length > 0 ? (
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={data} barGap={2} barCategoryGap="30%">
            <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
            <YAxis
              yAxisId="money"
              tick={{ fontSize: 10, fill: '#64748b' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `${sym}${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}`}
            />
            <YAxis
              yAxisId="acos"
              orientation="right"
              tick={{ fontSize: 10, fill: '#64748b' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `${v}%`}
              domain={[0, 'auto']}
            />
            <Tooltip
              {...TOOLTIP_STYLE}
              formatter={(value, name) => {
                if (name === 'ACoS') return [`${value}%`, 'ACoS'];
                return [fmt(value), name];
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
              formatter={(value) => <span style={{ color: '#94a3b8' }}>{value}</span>}
            />
            <Bar yAxisId="money" dataKey="spend" name="Gasto" fill="#3B82F6" radius={[3, 3, 0, 0]} fillOpacity={0.85} />
            <Bar yAxisId="money" dataKey="sales" name="Receita" fill="#10B981" radius={[3, 3, 0, 0]} fillOpacity={0.85} />
            <Line
              yAxisId="acos"
              type="monotone"
              dataKey="acos"
              name="ACoS"
              stroke="#F59E0B"
              strokeWidth={1.5}
              dot={{ r: 2, fill: '#F59E0B' }}
              activeDot={{ r: 4 }}
              strokeDasharray="4 2"
            />
          </ComposedChart>
        </ResponsiveContainer>
      ) : (
        <div className="h-56 flex items-center justify-center text-sm text-slate-500">
          Sem dados de métricas. Execute um Sync.
        </div>
      )}
    </div>
  );
}