import { useMemo } from 'react';
import { Target, TrendingUp, TrendingDown, AlertTriangle, CheckCircle } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer, Cell } from 'recharts';

function fmtPct(v) { return v == null ? '—' : `${Number(v).toFixed(1)}%`; }
function fmtBRL(v) { return v == null ? '—' : `R$${Number(v).toFixed(2)}`; }

const STATUS_CFG = {
  below_target:  { label: 'Abaixo da Meta ✓', color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20', bar: '#10B981' },
  on_target:     { label: 'Na Meta',           color: 'text-cyan',        bg: 'bg-cyan/10 border-cyan/20',               bar: '#3B82F6' },
  above_target:  { label: 'Acima da Meta',     color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/20',     bar: '#F59E0B' },
  critical:      { label: 'Crítico',           color: 'text-red-400',     bg: 'bg-red-500/10 border-red-500/20',         bar: '#EF4444' },
  no_data:       { label: 'Sem Dados',         color: 'text-slate-500',   bg: 'bg-slate-500/10 border-slate-500/20',     bar: '#475569' },
};

export default function AcosComparisonPanel({ campaigns, metrics, perfSettings }) {
  const targetAcos = perfSettings?.target_acos || 10;
  const maxAcos = perfSettings?.max_acos || 15;

  // Calcular ACoS real vs alvo por campanha (14 dias)
  const cutoff14d = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);

  const comparison = useMemo(() => {
    // Agregar métricas 14d por campanha
    const metByCamp = {};
    for (const m of metrics) {
      if (!m.campaign_id || !m.date || m.date < cutoff14d) continue;
      if (!metByCamp[m.campaign_id]) metByCamp[m.campaign_id] = { spend: 0, sales: 0, orders: 0, clicks: 0 };
      metByCamp[m.campaign_id].spend  += m.spend  || 0;
      metByCamp[m.campaign_id].sales  += m.sales  || 0;
      metByCamp[m.campaign_id].orders += m.orders || 0;
      metByCamp[m.campaign_id].clicks += m.clicks || 0;
    }

    const rows = [];
    for (const c of campaigns) {
      const st = String(c.state || c.status || '').toLowerCase();
      if (st === 'archived') continue;
      const cid = c.campaign_id || c.amazon_campaign_id || c.id;
      const agg = metByCamp[cid];
      if (!agg || agg.spend < 1) continue;

      const realAcos = agg.sales > 0 ? (agg.spend / agg.sales) * 100 : null;
      const gap = realAcos != null ? realAcos - targetAcos : null;

      let status = 'no_data';
      if (realAcos != null) {
        if (realAcos <= targetAcos * 0.75) status = 'below_target';
        else if (realAcos <= targetAcos * 1.05) status = 'on_target';
        else if (realAcos <= maxAcos * 1.2) status = 'above_target';
        else status = 'critical';
      }

      rows.push({
        id: cid,
        name: (c.campaign_name || c.name || cid).replace(/^AUTO \| /, '').slice(0, 40),
        realAcos, gap, status,
        spend: agg.spend, sales: agg.sales, orders: agg.orders,
      });
    }
    return rows.sort((a, b) => (b.gap ?? -999) - (a.gap ?? -999)); // piores primeiro
  }, [campaigns, metrics, targetAcos, maxAcos]);

  const summary = useMemo(() => ({
    below: comparison.filter(r => r.status === 'below_target').length,
    on: comparison.filter(r => r.status === 'on_target').length,
    above: comparison.filter(r => r.status === 'above_target').length,
    critical: comparison.filter(r => r.status === 'critical').length,
  }), [comparison]);

  // Dados para o gráfico (top 12 por gasto)
  const chartData = useMemo(() =>
    [...comparison]
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 12)
      .map(r => ({
        name: r.name.slice(0, 20),
        'ACoS Real': r.realAcos != null ? +r.realAcos.toFixed(1) : null,
        status: r.status,
      }))
  , [comparison]);

  if (comparison.length === 0) return null;

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Target className="w-4 h-4 text-cyan" />
          <h3 className="text-sm font-semibold text-slate-300">ACoS Real vs ACoS Alvo</h3>
          <span className="text-[10px] text-cyan/70 bg-cyan/10 border border-cyan/20 px-1.5 py-0.5 rounded-full">Meta: {targetAcos}%</span>
        </div>
        <p className="text-[10px] text-slate-500">Últimos 14 dias · {comparison.length} campanhas com dados</p>
      </div>

      {/* Cards de resumo */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { label: 'Abaixo da Meta', count: summary.below, icon: TrendingDown, cfg: STATUS_CFG.below_target },
          { label: 'Na Meta',        count: summary.on,    icon: CheckCircle,   cfg: STATUS_CFG.on_target },
          { label: 'Acima da Meta',  count: summary.above, icon: AlertTriangle, cfg: STATUS_CFG.above_target },
          { label: 'Crítico',        count: summary.critical, icon: TrendingUp, cfg: STATUS_CFG.critical },
        ].map(({ label, count, icon: Icon, cfg }) => (
          <div key={label} className={`rounded-xl p-3 border text-center ${cfg.bg}`}>
            <p className={`text-2xl font-bold ${cfg.color}`}>{count}</p>
            <p className={`text-[10px] mt-0.5 ${cfg.color}`}>{label}</p>
          </div>
        ))}
      </div>

      {/* Gráfico de barras: ACoS real por campanha com linha de meta */}
      {chartData.length >= 2 && (
        <div>
          <p className="text-[10px] text-slate-500 mb-2">ACoS real por campanha (top 12 por gasto) — linha verde = meta {targetAcos}%, vermelha = máximo {maxAcos}%</p>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
              <XAxis dataKey="name" tick={{ fontSize: 8, fill: '#64748b' }} axisLine={false} tickLine={false} interval={0} angle={-25} textAnchor="end" height={36} />
              <YAxis tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} width={32} tickFormatter={v => `${v}%`} />
              <Tooltip
                contentStyle={{ backgroundColor: '#111827', border: '1px solid #263244', borderRadius: 8, fontSize: 11 }}
                formatter={(v, n) => [`${v}%`, 'ACoS Real']}
              />
              <ReferenceLine y={targetAcos} stroke="#10B981" strokeDasharray="5 3" strokeWidth={1.5}
                label={{ value: `Alvo ${targetAcos}%`, position: 'insideTopRight', fill: '#10B981', fontSize: 9 }} />
              <ReferenceLine y={maxAcos} stroke="#EF4444" strokeDasharray="5 3" strokeWidth={1}
                label={{ value: `Máx ${maxAcos}%`, position: 'insideBottomRight', fill: '#EF4444', fontSize: 9 }} />
              <Bar dataKey="ACoS Real" radius={[3, 3, 0, 0]} maxBarSize={28}>
                {chartData.map((entry, idx) => (
                  <Cell key={idx} fill={STATUS_CFG[entry.status]?.bar || '#475569'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Tabela ranking — campanhas críticas primeiro */}
      <div>
        <p className="text-[10px] text-slate-500 mb-2">Ordenado por gap (pior → melhor)</p>
        <div className="space-y-1.5 max-h-64 overflow-y-auto scrollbar-thin">
          {comparison.map(row => {
            const cfg = STATUS_CFG[row.status];
            return (
              <div key={row.id} className={`flex items-center gap-3 px-3 py-2 rounded-lg border ${cfg.bg}`}>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-slate-200 truncate">{row.name}</p>
                  <p className="text-[10px] text-slate-500">
                    {row.orders} pedidos · {fmtBRL(row.spend)} gasto · {fmtBRL(row.sales)} vendas
                  </p>
                </div>
                <div className="flex-shrink-0 text-right">
                  <p className={`text-sm font-bold ${cfg.color}`}>{fmtPct(row.realAcos)}</p>
                  {row.gap != null && (
                    <p className={`text-[10px] ${row.gap > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                      {row.gap > 0 ? '+' : ''}{row.gap.toFixed(1)}pp
                    </p>
                  )}
                </div>
                <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold flex-shrink-0 ${cfg.bg} ${cfg.color}`}>
                  {cfg.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}