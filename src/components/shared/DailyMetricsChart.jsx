/**
 * DailyMetricsChart — componente compartilhado entre Dashboard e Analytics.
 * Recebe `metricsDaily` já filtrado pelo pai; renderiza gráfico de área configurável.
 */
import { useMemo } from 'react';
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

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
            {String(p.name).toLowerCase().includes('acos') || String(p.name).toLowerCase().includes('ctr')
              ? `${Number(p.value).toFixed(1)}%`
              : String(p.name).toLowerCase().includes('impressões') || String(p.name).toLowerCase().includes('cliques') || String(p.name).toLowerCase().includes('pedidos')
              ? Number(p.value).toLocaleString('pt-BR')
              : `R$${Number(p.value).toFixed(2)}`}
          </span>
        </div>
      ))}
    </div>
  );
};

function buildDailyData(metricsDaily, period = 30) {
  const cutoff = new Date(Date.now() - period * 86400000).toISOString().slice(0, 10);
  const filtered = metricsDaily.filter(m => m.date && m.date >= cutoff);

  // Deduplicar por campaign_id + date
  const dedupMap = new Map();
  filtered.forEach(m => {
    const key = `${m.campaign_id || 'global'}-${m.date}`;
    if (!dedupMap.has(key)) dedupMap.set(key, m);
  });

  const daily = {};
  dedupMap.forEach(m => {
    const d = m.date || '';
    if (!daily[d]) daily[d] = { date: d, name: d.slice(5), spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 };
    daily[d].spend += m.spend || 0;
    daily[d].sales += m.sales || 0;
    daily[d].orders += m.orders || 0;
    daily[d].clicks += m.clicks || 0;
    daily[d].impressions += m.impressions || 0;
  });

  return Object.values(daily)
    .map(d => ({
      ...d,
      acos: d.sales > 0 ? d.spend / d.sales * 100 : 0,
      ctr: d.impressions > 0 ? d.clicks / d.impressions * 100 : 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function ImpressionsDailyChart({ metricsDaily = [], period = 30, targetDailyImpressions = 0, height = 200 }) {
  const data = useMemo(() => buildDailyData(metricsDaily, period), [metricsDaily, period]);
  const avgImpr = data.length > 0 ? Math.round(data.reduce((s, d) => s + d.impressions, 0) / data.length) : 0;
  const lastDay = data[data.length - 1];
  const lastImpressions = lastDay?.impressions || 0;

  let statusColor = 'text-slate-400';
  let statusLabel = 'Sem dados';
  if (targetDailyImpressions > 0 && lastImpressions > 0) {
    if (lastImpressions >= targetDailyImpressions) { statusColor = 'text-emerald-400'; statusLabel = 'Acima da meta'; }
    else if (lastImpressions >= targetDailyImpressions * 0.7) { statusColor = 'text-amber-400'; statusLabel = 'Próximo da meta'; }
    else { statusColor = 'text-red-400'; statusLabel = 'Abaixo da meta'; }
  } else if (lastImpressions > 0) {
    statusColor = 'text-cyan'; statusLabel = 'Sem meta definida';
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-xs text-slate-500">Impressões diárias</p>
          <p className="text-lg font-bold text-white">{lastImpressions.toLocaleString('pt-BR')}</p>
        </div>
        <div className="text-right">
          {targetDailyImpressions > 0 && (
            <p className="text-xs text-slate-500">Meta: {targetDailyImpressions.toLocaleString('pt-BR')}</p>
          )}
          <p className={`text-xs font-semibold ${statusColor}`}>{statusLabel}</p>
          <p className="text-[10px] text-slate-600">Média {period}d: {avgImpr.toLocaleString('pt-BR')}</p>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data}>
          <defs>
            <linearGradient id="gImpr" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#8B5CF6" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#8B5CF6" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
          <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
          <Tooltip content={<CustomTooltip />} />
          <Area type="monotone" dataKey="impressions" name="Impressões" stroke="#8B5CF6" fill="url(#gImpr)" strokeWidth={2} />
          {targetDailyImpressions > 0 && (
            <Line type="monotone" dataKey={() => targetDailyImpressions} name="Meta" stroke="#F59E0B" strokeDasharray="6 3" strokeWidth={1.5} dot={false} />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SpendSalesChart({ metricsDaily = [], period = 30, height = 200 }) {
  const data = useMemo(() => buildDailyData(metricsDaily, period), [metricsDaily, period]);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data}>
        <defs>
          <linearGradient id="gSales2" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#10B981" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#10B981" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="gSpend2" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
        <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
        <Tooltip content={<CustomTooltip />} />
        <Legend wrapperStyle={{ fontSize: 11, color: '#94a3b8' }} />
        <Area type="monotone" dataKey="sales" name="Vendas" stroke="#10B981" fill="url(#gSales2)" strokeWidth={2} />
        <Area type="monotone" dataKey="spend" name="Spend" stroke="#3B82F6" fill="url(#gSpend2)" strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function AcosTrendChart({ metricsDaily = [], period = 30, targetAcos = 10, maxAcos = 15, height = 180 }) {
  const data = useMemo(() => buildDailyData(metricsDaily, period), [metricsDaily, period]);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
        <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fontSize: 10, fill: '#64748b' }} axisLine={false} tickLine={false} unit="%" />
        <Tooltip content={<CustomTooltip />} />
        <Line type="monotone" dataKey="acos" name="ACoS" stroke="#F59E0B" strokeWidth={2} dot={false} />
        {targetAcos > 0 && <Line type="monotone" dataKey={() => targetAcos} name="Meta" stroke="#10B981" strokeDasharray="5 3" strokeWidth={1.5} dot={false} />}
        {maxAcos > 0 && <Line type="monotone" dataKey={() => maxAcos} name="Máximo" stroke="#EF4444" strokeDasharray="5 3" strokeWidth={1} dot={false} />}
      </LineChart>
    </ResponsiveContainer>
  );
}

export { buildDailyData };
export default ImpressionsDailyChart;