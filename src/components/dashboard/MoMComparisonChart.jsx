import React, { useState, useMemo } from 'react';
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

function fmtBRL(v) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2 }).format(v || 0);
}
function fmtPct(v) { return `${(v || 0).toFixed(1)}%`; }
function fmtNum(v) { return (v || 0).toLocaleString('pt-BR'); }

const METRICS = [
  { key: 'revenue',  label: 'Fat. Real',    color: '#FB923C', colorPrev: '#FB923C55', unit: 'brl' },
  { key: 'spend',    label: 'Gasto Ads',    color: '#3B82F6', colorPrev: '#3B82F655', unit: 'brl' },
  { key: 'sales',    label: 'Vendas Ads',   color: '#10B981', colorPrev: '#10B98155', unit: 'brl' },
  { key: 'orders',   label: 'Pedidos',      color: '#8B5CF6', colorPrev: '#8B5CF655', unit: 'num' },
  { key: 'acos',     label: 'ACoS',         color: '#EF4444', colorPrev: '#EF444455', unit: 'pct' },
];

const CustomTooltip = ({ active, payload, label, activeMetric }) => {
  if (!active || !payload?.length) return null;
  const unit = METRICS.find(m => m.key === activeMetric)?.unit || 'brl';
  const fmt = v => v == null ? '—' : unit === 'brl' ? fmtBRL(v) : unit === 'pct' ? fmtPct(v) : fmtNum(v);
  return (
    <div className="bg-[#111318] border border-surface-2 rounded-lg p-3 text-xs shadow-xl">
      <p className="text-slate-400 mb-1.5 font-medium">Dia {label}</p>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2 mb-1">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
          <span className="text-slate-300">{p.name}:</span>
          <span className="text-white font-semibold">{fmt(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

function ComparisonTooltip({ active, payload, label, unit = 'brl' }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#10182B] border border-surface-2 rounded-lg p-3 text-xs shadow-xl">
      <p className="text-slate-400 mb-1.5 font-medium">Dia {label}</p>
      {payload.map((point) => (
        <div key={point.dataKey} className="flex items-center justify-between gap-4 mb-1 last:mb-0">
          <span className="flex items-center gap-2 text-slate-300"><span className="w-2 h-2 rounded-full" style={{ background: point.color }} />{point.name}</span>
          <strong className="text-white">{point.value == null ? '—' : unit === 'units' ? `${Number(point.value).toLocaleString('pt-BR')} unid.` : unit === 'impressions' ? Number(point.value).toLocaleString('pt-BR') : fmtBRL(point.value)}</strong>
        </div>
      ))}
    </div>
  );
}

function DeltaBadge({ current, prev, lowerIsBetter = false }) {
  if (!prev || prev === 0 || !current) return null;
  const delta = ((current - prev) / Math.abs(prev)) * 100;
  const isGood = lowerIsBetter ? delta < -1 : delta > 1;
  const isBad = lowerIsBetter ? delta > 1 : delta < -1;
  const Icon = Math.abs(delta) < 1 ? Minus : delta > 0 ? TrendingUp : TrendingDown;
  const color = isGood ? 'text-emerald-400' : isBad ? 'text-red-400' : 'text-slate-400';
  return (
    <span className={`flex items-center gap-0.5 text-[10px] font-semibold ${color}`}>
      <Icon className="w-3 h-3" />
      {Math.abs(delta).toFixed(1)}%
    </span>
  );
}

/**
 * Compara métricas do mês atual vs mês anterior.
 * Usa todos os dados já baixados (CampaignMetricsDaily + SalesDaily).
 */
export default function MoMComparisonChart({ allMetrics, salesDailyByDate }) {
  const [activeMetric, setActiveMetric] = useState('spend');
  const [rollingPeriod, setRollingPeriod] = useState(30);
  const [rollingMetric, setRollingMetric] = useState('revenue');

  const metric = METRICS.find(m => m.key === activeMetric);

  // BRT "today" e "yesterday"
  const nowBRT = new Date(Date.now() - 3 * 3600000);
  const todayStr = nowBRT.toISOString().slice(0, 10);
  const yesterdayBRT = new Date(nowBRT.getTime() - 86400000);
  const yesterdayStr = yesterdayBRT.toISOString().slice(0, 10);

  const curYear = nowBRT.getUTCFullYear();
  const curMonth = nowBRT.getUTCMonth(); // 0-indexed
  const prevMonthDate = new Date(Date.UTC(curYear, curMonth - 1, 1));

  const firstCurrent = `${curYear}-${String(curMonth + 1).padStart(2, '0')}-01`;
  const firstPrev = prevMonthDate.toISOString().slice(0, 10);
  const lastDayPrevMonth = new Date(Date.UTC(curYear, curMonth, 0)).getUTCDate();

  // Dias do mês anterior completo (para exibir o mês completo no gráfico)
  const daysInPrevMonth = lastDayPrevMonth;
  // Dias do mês atual até ontem
  const daysInCurMonth = yesterdayBRT.getUTCDate();
  // Total de dias a plotar = max dos dois
  const totalDays = Math.max(daysInPrevMonth, daysInCurMonth);

  // Agregar ads metrics por data
  const adsByDate = useMemo(() => {
    const map = {};
    for (const m of allMetrics) {
      if (!m.date) continue;
      if (!map[m.date]) map[m.date] = { spend: 0, sales: 0, orders: 0, impressions: 0, clicks: 0 };
      map[m.date].spend += m.spend || 0;
      map[m.date].sales += m.sales || 0;
      map[m.date].orders += m.orders || 0;
      map[m.date].impressions += m.impressions || 0;
      map[m.date].clicks += m.clicks || 0;
    }
    return map;
  }, [allMetrics]);

  // Montar pontos dia a dia para o gráfico
  const chartData = useMemo(() => {
    const points = [];
    for (let day = 1; day <= totalDays; day++) {
      const dd = String(day).padStart(2, '0');
      const curDate = `${curYear}-${String(curMonth + 1).padStart(2, '0')}-${dd}`;
      const prevDate = `${prevMonthDate.getUTCFullYear()}-${String(prevMonthDate.getUTCMonth() + 1).padStart(2, '0')}-${dd}`;

      const curAds = adsByDate[curDate];
      const prevAds = adsByDate[prevDate];
      const curRevenue = salesDailyByDate[curDate]?.revenue ?? null;
      const prevRevenue = salesDailyByDate[prevDate]?.revenue ?? null;
      const curAcos = curAds && curAds.sales > 0 ? (curAds.spend / curAds.sales) * 100 : null;
      const prevAcos = prevAds && prevAds.sales > 0 ? (prevAds.spend / prevAds.sales) * 100 : null;

      // Só inclui dia atual se <= ontem (dados fechados)
      const inCurRange = curDate <= yesterdayStr;
      // Inclui dia anterior se o mês anterior tem esse dia
      const inPrevRange = day <= daysInPrevMonth;

      points.push({
        day,
        curRevenue:  inCurRange  ? curRevenue  : null,
        prevRevenue: inPrevRange ? prevRevenue  : null,
        curSpend:    inCurRange  ? (curAds?.spend ?? null)   : null,
        prevSpend:   inPrevRange ? (prevAds?.spend ?? null)  : null,
        curSales:    inCurRange  ? (curAds?.sales ?? null)   : null,
        prevSales:   inPrevRange ? (prevAds?.sales ?? null)  : null,
        curOrders:   inCurRange  ? (curAds?.orders ?? null)  : null,
        prevOrders:  inPrevRange ? (prevAds?.orders ?? null) : null,
        curAcos:     inCurRange  ? curAcos   : null,
        prevAcos:    inPrevRange ? prevAcos  : null,
        curImpressions: inCurRange ? (curAds?.impressions ?? null) : null,
        prevImpressions: inPrevRange ? (prevAds?.impressions ?? null) : null,
      });
    }
    return points;
  }, [totalDays, adsByDate, salesDailyByDate, curYear, curMonth, prevMonthDate, yesterdayStr, daysInPrevMonth]);

  const cumulativeRevenueData = useMemo(() => {
    let currentTotal = 0;
    let previousTotal = 0;
    return [{ day: 0, curCumulative: 0, prevCumulative: 0 }, ...chartData.map((point) => {
      const hasCurrent = point.curRevenue != null;
      const hasPrevious = point.prevRevenue != null;
      if (hasCurrent) currentTotal += Number(point.curRevenue);
      if (hasPrevious) previousTotal += Number(point.prevRevenue);
      return {
        day: point.day,
        curCumulative: hasCurrent ? currentTotal : null,
        prevCumulative: hasPrevious ? previousTotal : null,
      };
    })];
  }, [chartData]);

  const rollingComparison = useMemo(() => {
    const shiftIsoDate = (isoDate, offset) => {
      const date = new Date(`${isoDate}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() + offset);
      return date.toISOString().slice(0, 10);
    };
    const metricValue = (entry) => rollingMetric === 'units' ? Number(entry?.units || 0) : Number(entry?.revenue || 0);
    const points = [];
    for (let offset = rollingPeriod - 1; offset >= 0; offset -= 1) {
      const currentDate = shiftIsoDate(yesterdayStr, -offset);
      const previousDate = shiftIsoDate(currentDate, -rollingPeriod);
      points.push({
        label: currentDate.slice(8, 10) + '/' + currentDate.slice(5, 7),
        current: salesDailyByDate[currentDate] ? metricValue(salesDailyByDate[currentDate]) : null,
        previous: salesDailyByDate[previousDate] ? metricValue(salesDailyByDate[previousDate]) : null,
      });
    }
    return points;
  }, [rollingMetric, rollingPeriod, salesDailyByDate, yesterdayStr]);

  const rollingTotals = useMemo(() => rollingComparison.reduce((totals, point) => ({
    current: totals.current + (point.current || 0),
    previous: totals.previous + (point.previous || 0),
    currentDays: totals.currentDays + (point.current != null ? 1 : 0),
    previousDays: totals.previousDays + (point.previous != null ? 1 : 0),
  }), { current: 0, previous: 0, currentDays: 0, previousDays: 0 }), [rollingComparison]);

  // KPIs totais acumulados
  const totals = useMemo(() => {
    let cur = { revenue: 0, spend: 0, sales: 0, orders: 0 };
    let prev = { revenue: 0, spend: 0, sales: 0, orders: 0 };

    for (const [date, v] of Object.entries(salesDailyByDate)) {
      if (date >= firstCurrent && date <= yesterdayStr) cur.revenue += v.revenue;
      if (date >= firstPrev && date < firstCurrent) prev.revenue += v.revenue;
    }
    for (const [date, v] of Object.entries(adsByDate)) {
      if (date >= firstCurrent && date <= yesterdayStr) {
        cur.spend += v.spend; cur.sales += v.sales; cur.orders += v.orders;
      }
      if (date >= firstPrev && date < firstCurrent) {
        prev.spend += v.spend; prev.sales += v.sales; prev.orders += v.orders;
      }
    }

    return {
      cur: {
        ...cur,
        acos: cur.sales > 0 ? (cur.spend / cur.sales) * 100 : 0,
      },
      prev: {
        ...prev,
        acos: prev.sales > 0 ? (prev.spend / prev.sales) * 100 : 0,
      },
    };
  }, [salesDailyByDate, adsByDate, firstCurrent, firstPrev, yesterdayStr]);

  const dataKeyMap = {
    revenue: { cur: 'curRevenue', prev: 'prevRevenue' },
    spend:   { cur: 'curSpend',   prev: 'prevSpend' },
    sales:   { cur: 'curSales',   prev: 'prevSales' },
    orders:  { cur: 'curOrders',  prev: 'prevOrders' },
    acos:    { cur: 'curAcos',    prev: 'prevAcos' },
  };
  const keys = dataKeyMap[activeMetric];

  const hasData = chartData.some(p => p[keys.cur] !== null || p[keys.prev] !== null);

  const prevMonthLabel = prevMonthDate.toLocaleString('pt-BR', { month: 'long', timeZone: 'UTC' });
  const curMonthLabel = nowBRT.toLocaleString('pt-BR', { month: 'long', timeZone: 'UTC' });

  const fmtTotals = (v) => {
    if (activeMetric === 'acos') return fmtPct(v);
    if (activeMetric === 'orders') return fmtNum(v);
    return fmtBRL(v);
  };

  const curVal = totals.cur[activeMetric];
  const prevVal = totals.prev[activeMetric];

  const tickFormatter = (v) => {
    if (v == null) return '';
    if (activeMetric === 'acos') return `${v.toFixed(0)}%`;
    if (activeMetric === 'orders') return v >= 1000 ? `${(v/1000).toFixed(1)}k` : v.toFixed(0);
    return v >= 1000 ? `${(v/1000).toFixed(0)}k` : v.toFixed(0);
  };

  // Número de dias que o mês atual tem dados no banco
  const daysWithCurData = chartData.filter(p => p[keys.cur] !== null).length;
  const daysWithPrevData = chartData.filter(p => p[keys.prev] !== null).length;

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-300">Comparação mês atual vs mês anterior</h2>
          <p className="text-[10px] text-slate-500 mt-0.5">
            <span>{curMonthLabel} (dias 1–{daysInCurMonth}, {daysWithCurData} c/ dados) vs {prevMonthLabel} completo ({daysWithPrevData} c/ dados) · Fonte: relatórios já baixados</span>
          </p>
        </div>
        <div className="flex bg-surface-2 border border-surface-3 rounded-lg p-0.5 gap-0.5 flex-wrap">
          {METRICS.map(m => (
            <button key={m.key} onClick={() => setActiveMetric(m.key)}
              className={`px-2.5 py-1.5 rounded text-xs font-semibold transition-all whitespace-nowrap ${activeMetric === m.key ? 'bg-cyan text-white' : 'text-slate-400 hover:text-slate-200'}`}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* KPI summary */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="bg-surface-2 rounded-lg p-3">
          <p className="text-[10px] text-slate-500 mb-1 capitalize">{curMonthLabel} (até dia {daysInCurMonth})</p>
          <p className="text-base font-bold text-white">{fmtTotals(curVal)}</p>
          <div className="mt-1">
            <DeltaBadge current={curVal} prev={prevVal} lowerIsBetter={activeMetric === 'acos'} />
          </div>
        </div>
        <div className="bg-surface-2/50 rounded-lg p-3">
          <p className="text-[10px] text-slate-500 mb-1 capitalize">{prevMonthLabel} (mês completo)</p>
          <p className="text-base font-bold text-slate-400">{fmtTotals(prevVal)}</p>
          <p className="text-[10px] text-slate-600 mt-1">referência</p>
        </div>
      </div>

      {!hasData ? (
        <div className="h-44 flex items-center justify-center text-xs text-slate-600">
          Sem dados suficientes para comparação. Execute o sync para obter dados históricos.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={180}>
          <ComposedChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
            <XAxis dataKey="day" tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false}
              label={{ value: 'Dia do mês', position: 'insideBottomRight', offset: -4, fontSize: 8, fill: '#64748b' }} />
            <YAxis tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} width={44}
              tickFormatter={tickFormatter} />
            <Tooltip content={<CustomTooltip activeMetric={activeMetric} />} />
            <Legend wrapperStyle={{ fontSize: 10, paddingTop: 4 }} />
            {/* Mês anterior: linha tracejada */}
            <Line
              type="monotone"
              dataKey={keys.prev}
              name={`${prevMonthLabel}`}
              stroke={metric.colorPrev}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={false}
              connectNulls
            />
            {/* Mês atual: linha sólida destacada */}
            <Line
              type="monotone"
              dataKey={keys.cur}
              name={`${curMonthLabel} (atual)`}
              stroke={metric.color}
              strokeWidth={2.5}
              dot={false}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {/* Volume de tráfego separado das curvas financeiras do dashboard. */}
      <section className="mt-6 border-t border-surface-2 pt-5" aria-labelledby="daily-impressions-comparison">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h3 id="daily-impressions-comparison" className="text-sm font-semibold text-slate-200">Impressões por dia</h3>
            <p className="text-[10px] text-slate-500 mt-0.5">Comparação direta do alcance Ads por dia do mês, sem misturar volume com valores em R$.</p>
          </div>
          <span className="text-[10px] text-violet-200 bg-violet-400/10 border border-violet-400/20 rounded-full px-2 py-1 whitespace-nowrap">Alcance Ads</span>
        </div>
        {chartData.some((point) => point.curImpressions != null || point.prevImpressions != null) ? (
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={3}>
              <CartesianGrid strokeDasharray="3 3" stroke="#24324F" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 9, fill: '#94A3B8' }} axisLine={false} tickLine={false}
                label={{ value: 'Dia do mês', position: 'insideBottomRight', offset: -4, fontSize: 9, fill: '#94A3B8' }} />
              <YAxis tick={{ fontSize: 9, fill: '#94A3B8' }} axisLine={false} tickLine={false} width={50}
                tickFormatter={(value) => value >= 1000 ? `${(value / 1000).toFixed(0)}k` : value.toFixed(0)} />
              <Tooltip content={<ComparisonTooltip unit="impressions" />} cursor={{ fill: 'rgba(91,108,255,.08)' }} />
              <Legend wrapperStyle={{ fontSize: 10, paddingTop: 6 }} />
              <Bar dataKey="prevImpressions" name={prevMonthLabel} fill="#8B5CF655" radius={[4, 4, 0, 0]} maxBarSize={20} />
              <Bar dataKey="curImpressions" name={`${curMonthLabel} (atual)`} fill="#8B5CF6" radius={[4, 4, 0, 0]} maxBarSize={20} />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-36 flex items-center justify-center rounded-lg border border-dashed border-surface-2 text-xs text-slate-500">
            Sem impressões diárias suficientes para a comparação.
          </div>
        )}
      </section>

      <section className="mt-6 border-t border-surface-2 pt-5" aria-labelledby="cumulative-revenue-title">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h3 id="cumulative-revenue-title" className="text-sm font-semibold text-slate-200">Faturamento acumulado no mês</h3>
            <p className="text-[10px] text-slate-500 mt-0.5">A curva começa em R$ 0 no dia 0 e soma cada dia confirmado até o mesmo ponto do mês.</p>
          </div>
          <span className="text-[10px] text-indigo-200 bg-indigo-400/10 border border-indigo-400/20 rounded-full px-2 py-1 whitespace-nowrap">Acumulado</span>
        </div>
        {cumulativeRevenueData.some((point) => point.curCumulative != null && point.day > 0) || cumulativeRevenueData.some((point) => point.prevCumulative != null && point.day > 0) ? (
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={cumulativeRevenueData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#24324F" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 9, fill: '#94A3B8' }} axisLine={false} tickLine={false}
                label={{ value: 'Dia do mês', position: 'insideBottomRight', offset: -4, fontSize: 9, fill: '#94A3B8' }} />
              <YAxis tick={{ fontSize: 9, fill: '#94A3B8' }} axisLine={false} tickLine={false} width={54}
                tickFormatter={(value) => value >= 1000 ? `R$${(value / 1000).toFixed(0)}k` : `R$${value.toFixed(0)}`} />
              <Tooltip content={<ComparisonTooltip />} cursor={{ stroke: 'rgba(91,108,255,.45)', strokeDasharray: '3 3' }} />
              <Legend wrapperStyle={{ fontSize: 10, paddingTop: 6 }} />
              <Line type="monotone" dataKey="prevCumulative" name={`${prevMonthLabel} acumulado`} stroke="#FB923C88" strokeWidth={2} strokeDasharray="5 3" dot={false} connectNulls={false} />
              <Line type="monotone" dataKey="curCumulative" name={`${curMonthLabel} acumulado`} stroke="#FB923C" strokeWidth={2.8} dot={false} connectNulls={false} />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-36 flex items-center justify-center rounded-lg border border-dashed border-surface-2 text-xs text-slate-500">Sem faturamento diário confirmado para formar a curva acumulada.</div>
        )}
        <p className="mt-2 text-[9px] text-slate-600">Dias sem confirmação permanecem como lacuna visual, para não confundir dado ausente com faturamento zero.</p>
      </section>

      <section className="mt-6 border-t border-surface-2 pt-5" aria-labelledby="rolling-comparison-title">
        <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-3 mb-4">
          <div>
            <h3 id="rolling-comparison-title" className="text-sm font-semibold text-slate-200">Comparação por período móvel</h3>
            <p className="text-[10px] text-slate-500 mt-0.5">
              Janela selecionada versus a janela imediatamente anterior de mesmo tamanho. Usa apenas dias confirmados na SP-API.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg border border-surface-3 bg-surface-2 p-0.5">
              {[7, 15, 30, 60, 90].map((days) => (
                <button key={days} type="button" onClick={() => setRollingPeriod(days)}
                  className={`px-2.5 py-1.5 rounded text-[11px] font-semibold transition-colors ${rollingPeriod === days ? 'bg-cyan text-white' : 'text-slate-400 hover:text-slate-200'}`}>
                  {days}d
                </button>
              ))}
            </div>
            <div className="flex rounded-lg border border-surface-3 bg-surface-2 p-0.5">
              <button type="button" onClick={() => setRollingMetric('revenue')}
                className={`px-2.5 py-1.5 rounded text-[11px] font-semibold transition-colors ${rollingMetric === 'revenue' ? 'bg-orange-400 text-slate-950' : 'text-slate-400 hover:text-slate-200'}`}>Faturamento</button>
              <button type="button" onClick={() => setRollingMetric('units')}
                className={`px-2.5 py-1.5 rounded text-[11px] font-semibold transition-colors ${rollingMetric === 'units' ? 'bg-cyan text-white' : 'text-slate-400 hover:text-slate-200'}`}>Unidades vendidas</button>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div className="rounded-lg border border-surface-2 bg-surface-2/60 p-3">
            <p className="text-[10px] text-slate-500">Últimos {rollingPeriod} dias · {rollingTotals.currentDays} com dados</p>
            <p className="mt-1 text-base font-bold text-white">{rollingMetric === 'units' ? `${rollingTotals.current.toLocaleString('pt-BR')} unid.` : fmtBRL(rollingTotals.current)}</p>
          </div>
          <div className="rounded-lg border border-surface-2 bg-surface-2/60 p-3">
            <p className="text-[10px] text-slate-500">Período anterior · {rollingTotals.previousDays} com dados</p>
            <p className="mt-1 text-base font-bold text-slate-300">{rollingMetric === 'units' ? `${rollingTotals.previous.toLocaleString('pt-BR')} unid.` : fmtBRL(rollingTotals.previous)}</p>
          </div>
        </div>

        {rollingComparison.some((point) => point.current != null || point.previous != null) ? (
          <ResponsiveContainer width="100%" height={240}>
            <ComposedChart data={rollingComparison} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={3}>
              <CartesianGrid strokeDasharray="3 3" stroke="#24324F" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: rollingPeriod > 30 ? 8 : 9, fill: '#94A3B8' }} axisLine={false} tickLine={false} interval={rollingPeriod > 30 ? Math.ceil(rollingPeriod / 12) : 0} />
              <YAxis tick={{ fontSize: 9, fill: '#94A3B8' }} axisLine={false} tickLine={false} width={56}
                tickFormatter={(value) => rollingMetric === 'units' ? value.toFixed(0) : (value >= 1000 ? `R$${(value / 1000).toFixed(0)}k` : `R$${value.toFixed(0)}`)} />
              <Tooltip content={<ComparisonTooltip unit={rollingMetric === 'units' ? 'units' : 'brl'} />} cursor={{ fill: 'rgba(91,108,255,.08)' }} />
              <Legend wrapperStyle={{ fontSize: 10, paddingTop: 6 }} />
              <Bar dataKey="previous" name="Período anterior" fill={rollingMetric === 'units' ? '#4DA3FF66' : '#FB923C55'} radius={[4, 4, 0, 0]} maxBarSize={rollingPeriod > 30 ? 10 : 18} />
              <Bar dataKey="current" name={`Últimos ${rollingPeriod} dias`} fill={rollingMetric === 'units' ? '#4DA3FF' : '#FB923C'} radius={[4, 4, 0, 0]} maxBarSize={rollingPeriod > 30 ? 10 : 18} />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-36 flex items-center justify-center rounded-lg border border-dashed border-surface-2 text-xs text-slate-500">
            Não há dados confirmados para este período. O gráfico será preenchido conforme os relatórios forem sincronizados.
          </div>
        )}
      </section>

      <p className="text-[9px] text-slate-600 mt-2">
        Dados do banco atualizados automaticamente pelos relatórios baixados diariamente.
        {daysWithPrevData < daysInPrevMonth ? (
          <span> · <span className="text-amber-500/70">{prevMonthLabel}: apenas {daysWithPrevData}/{daysInPrevMonth} dias com dados</span></span>
        ) : null}
      </p>
    </div>
  );
}
