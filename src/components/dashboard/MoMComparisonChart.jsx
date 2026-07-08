import React, { useState, useMemo } from 'react';
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

function fmtBRL(v) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 }).format(v || 0);
}

const METRICS = [
  { key: 'revenue', label: 'Faturamento Real', color: '#FB923C', colorPrev: '#FB923C66', unit: 'brl' },
  { key: 'acos', label: 'ACoS (%)', color: '#3B82F6', colorPrev: '#3B82F666', unit: 'pct' },
];

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#111318] border border-surface-2 rounded-lg p-3 text-xs shadow-xl">
      <p className="text-slate-400 mb-1.5 font-medium">Dia {label}</p>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2 mb-1">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
          <span className="text-slate-300">{p.name}:</span>
          <span className="text-white font-semibold">
            {p.name.includes('%') ? `${Number(p.value).toFixed(1)}%` : fmtBRL(p.value)}
          </span>
        </div>
      ))}
    </div>
  );
};

function DeltaBadge({ current, prev, unit, lowerIsBetter = false }) {
  if (!prev || prev === 0) return null;
  const delta = ((current - prev) / prev) * 100;
  const isGood = lowerIsBetter ? delta < 0 : delta > 0;
  const isNeutral = Math.abs(delta) < 1;
  const Icon = isNeutral ? Minus : isGood ? TrendingUp : TrendingDown;
  const color = isNeutral ? 'text-slate-400' : isGood ? 'text-emerald-400' : 'text-red-400';
  return (
    <span className={`flex items-center gap-0.5 text-[10px] font-semibold ${color}`}>
      <Icon className="w-3 h-3" />
      {Math.abs(delta).toFixed(1)}%
    </span>
  );
}

/**
 * Compara faturamento real e ACoS do período atual (últimos N dias do mês corrente)
 * com o mesmo intervalo de dias do mês anterior, usando dados já carregados.
 *
 * Props:
 *   allMetrics: CampaignMetricsDaily[]
 *   salesDailyByDate: { [date]: { revenue, units } }
 */
export default function MoMComparisonChart({ allMetrics, salesDailyByDate }) {
  const [activeMetric, setActiveMetric] = useState('revenue');

  const metric = METRICS.find(m => m.key === activeMetric);

  // Determinar range: dia 1 até ontem do mês atual
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const firstCurrent = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
  const lastCurrent = yesterday.toISOString().slice(0, 10);
  const daysCurrent = Math.max(1, Math.round((yesterday - new Date(firstCurrent)) / 86400000) + 1);

  // Mesmo intervalo no mês anterior
  const prevMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const firstPrev = prevMonth.toISOString().slice(0, 10);
  const lastPrev = new Date(prevMonth.getFullYear(), prevMonth.getMonth(), yesterday.getDate()).toISOString().slice(0, 10);

  // Agregar ads metrics por data: spend e sales para calcular ACoS
  const adsByDate = useMemo(() => {
    const map = {};
    for (const m of allMetrics) {
      if (!m.date) continue;
      if (!map[m.date]) map[m.date] = { spend: 0, sales: 0 };
      map[m.date].spend += m.spend || 0;
      map[m.date].sales += m.sales || 0;
    }
    return map;
  }, [allMetrics]);

  // Montar pontos dia a dia (por dia-do-mês, 1-indexed)
  const chartData = useMemo(() => {
    const points = [];
    for (let day = 1; day <= daysCurrent; day++) {
      const curDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const prevDate = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

      const curRevenue = salesDailyByDate[curDate]?.revenue ?? null;
      const prevRevenue = salesDailyByDate[prevDate]?.revenue ?? null;
      const curAds = adsByDate[curDate];
      const prevAds = adsByDate[prevDate];
      const curAcos = curAds && curAds.sales > 0 ? (curAds.spend / curAds.sales) * 100 : null;
      const prevAcos = prevAds && prevAds.sales > 0 ? (prevAds.spend / prevAds.sales) * 100 : null;

      points.push({
        day,
        curRevenue,
        prevRevenue,
        curAcos,
        prevAcos,
      });
    }
    return points;
  }, [daysCurrent, adsByDate, salesDailyByDate, today, prevMonth]);

  // KPIs totais para comparação
  const totals = useMemo(() => {
    let curRev = 0, prevRev = 0, curSpend = 0, curSales = 0, prevSpend = 0, prevSales = 0;
    for (const [date, v] of Object.entries(salesDailyByDate)) {
      if (date >= firstCurrent && date <= lastCurrent) curRev += v.revenue;
      if (date >= firstPrev && date <= lastPrev) prevRev += v.revenue;
    }
    for (const [date, v] of Object.entries(adsByDate)) {
      if (date >= firstCurrent && date <= lastCurrent) { curSpend += v.spend; curSales += v.sales; }
      if (date >= firstPrev && date <= lastPrev) { prevSpend += v.spend; prevSales += v.sales; }
    }
    return {
      curRevenue: curRev, prevRevenue: prevRev,
      curAcos: curSales > 0 ? (curSpend / curSales) * 100 : 0,
      prevAcos: prevSales > 0 ? (prevSpend / prevSales) * 100 : 0,
    };
  }, [salesDailyByDate, adsByDate, firstCurrent, lastCurrent, firstPrev, lastPrev]);

  const hasData = chartData.some(p => p.curRevenue !== null || p.prevRevenue !== null);
  const prevMonthLabel = prevMonth.toLocaleString('pt-BR', { month: 'long' });
  const curMonthLabel = today.toLocaleString('pt-BR', { month: 'long' });

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-300">Comparação mês atual vs mês anterior</h2>
          <p className="text-[10px] text-slate-500 mt-0.5">
            {curMonthLabel} (dias 1–{yesterday.getDate()}) vs {prevMonthLabel} (mesmo intervalo)
          </p>
        </div>
        {/* Seletor de métrica */}
        <div className="flex bg-surface-2 border border-surface-3 rounded-lg p-0.5 gap-0.5">
          {METRICS.map(m => (
            <button key={m.key} onClick={() => setActiveMetric(m.key)}
              className={`px-3 py-1.5 rounded text-xs font-semibold transition-all ${activeMetric === m.key ? 'bg-cyan text-white' : 'text-slate-400 hover:text-slate-200'}`}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* KPI summary */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="bg-surface-2 rounded-lg p-3">
          <p className="text-[10px] text-slate-500 mb-1 capitalize">{curMonthLabel} (atual)</p>
          <p className="text-base font-bold text-white">
            {activeMetric === 'revenue' ? fmtBRL(totals.curRevenue) : `${totals.curAcos.toFixed(1)}%`}
          </p>
          <div className="mt-1">
            <DeltaBadge
              current={activeMetric === 'revenue' ? totals.curRevenue : totals.curAcos}
              prev={activeMetric === 'revenue' ? totals.prevRevenue : totals.prevAcos}
              lowerIsBetter={activeMetric === 'acos'}
            />
          </div>
        </div>
        <div className="bg-surface-2/50 rounded-lg p-3">
          <p className="text-[10px] text-slate-500 mb-1 capitalize">{prevMonthLabel} (anterior)</p>
          <p className="text-base font-bold text-slate-400">
            {activeMetric === 'revenue' ? fmtBRL(totals.prevRevenue) : `${totals.prevAcos.toFixed(1)}%`}
          </p>
          <p className="text-[10px] text-slate-600 mt-1">referência</p>
        </div>
      </div>

      {!hasData ? (
        <div className="h-44 flex items-center justify-center text-xs text-slate-600">
          Sem dados suficientes para comparação. Sincronize os dados de vendas (SP-API).
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={180}>
          <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
            <XAxis dataKey="day" tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false}
              label={{ value: 'Dia do mês', position: 'insideBottomRight', offset: -4, fontSize: 8, fill: '#64748b' }} />
            <YAxis tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} width={44}
              tickFormatter={v => activeMetric === 'revenue'
                ? (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0))
                : `${v.toFixed(0)}%`} />
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ fontSize: 10, paddingTop: 4 }} />
            {/* Mês anterior: linha tracejada mais apagada */}
            <Line
              type="monotone"
              dataKey={activeMetric === 'revenue' ? 'prevRevenue' : 'prevAcos'}
              name={`${prevMonthLabel} (%)`}
              stroke={metric.colorPrev}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              connectNulls
            />
            {/* Mês atual: linha sólida destacada */}
            <Line
              type="monotone"
              dataKey={activeMetric === 'revenue' ? 'curRevenue' : 'curAcos'}
              name={`${curMonthLabel} (atual)`}
              stroke={metric.color}
              strokeWidth={2.5}
              dot={false}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}