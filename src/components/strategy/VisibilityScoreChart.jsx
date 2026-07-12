/**
 * VisibilityScoreChart
 * Scatter plot: visibility_score × vendas/pedidos por produto/ASIN
 * Usa dados das top_opportunities do motor v6 + métricas de campanha.
 */
import { useMemo } from 'react';
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ZAxis, Cell
} from 'recharts';
import { Eye, TrendingUp, AlertTriangle } from 'lucide-react';

const VIS_THRESHOLDS = { low: 0.3, medium: 0.6 };

function visColor(score) {
  if (score == null) return '#64748b';
  if (score < VIS_THRESHOLDS.low) return '#EF4444';
  if (score < VIS_THRESHOLDS.medium) return '#F59E0B';
  return '#10B981';
}

function visLabel(score) {
  if (score == null) return 'N/A';
  if (score < VIS_THRESHOLDS.low) return 'Baixa';
  if (score < VIS_THRESHOLDS.medium) return 'Média';
  return 'Alta';
}

const CustomTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div className="bg-[#111827] border border-surface-3 rounded-xl p-3 shadow-xl text-[11px] min-w-[180px]">
      <p className="font-mono text-cyan mb-1.5">{d.asin || d.keyword_text || '—'}</p>
      {d.keyword_text && d.asin && (
        <p className="text-slate-400 mb-1.5 truncate max-w-[180px]" title={d.keyword_text}>{d.keyword_text}</p>
      )}
      <div className="space-y-1">
        <div className="flex justify-between gap-4">
          <span className="text-slate-500">Visibilidade</span>
          <span style={{ color: visColor(d.visibility_score) }} className="font-bold">
            {d.visibility_score != null ? d.visibility_score.toFixed(3) : '—'} ({visLabel(d.visibility_score)})
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-slate-500">Vendas (14d)</span>
          <span className="text-emerald-400 font-bold">
            R${(d.sales_14d || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-slate-500">Pedidos (14d)</span>
          <span className="text-white font-bold">{d.orders_14d ?? '—'}</span>
        </div>
        {d.impressions_14d > 0 && (
          <div className="flex justify-between gap-4">
            <span className="text-slate-500">Impressões</span>
            <span className="text-slate-300">{(d.impressions_14d || 0).toLocaleString('pt-BR')}</span>
          </div>
        )}
        {d.opportunity_state && (
          <div className="flex justify-between gap-4">
            <span className="text-slate-500">Estado</span>
            <span className="text-violet-400">{d.opportunity_state.replace(/_/g, ' ')}</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default function VisibilityScoreChart({ opportunities = [], metrics = [], products = [] }) {
  // Construir pontos cruzando opportunities (do motor v6) com métricas reais
  const points = useMemo(() => {
    // Mapa asin → métricas 14d
    const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const metByAsin = new Map();
    for (const m of metrics) {
      if (!m.asin && !m.campaign_id) continue;
      if (m.date && m.date < cutoff) continue;
      const key = m.asin || m.campaign_id;
      const prev = metByAsin.get(key) || { sales: 0, orders: 0, spend: 0 };
      prev.sales += m.sales || 0;
      prev.orders += m.orders || 0;
      prev.spend += m.spend || 0;
      metByAsin.set(key, prev);
    }

    // Mapa asin → produto
    const prodByAsin = new Map(products.map(p => [p.asin, p]));

    if (opportunities.length > 0) {
      return opportunities
        .filter(opp => opp.visibility_score != null)
        .map(opp => {
          const met = metByAsin.get(opp.asin) || {};
          const prod = prodByAsin.get(opp.asin) || {};
          return {
            asin: opp.asin,
            keyword_text: opp.keyword_text,
            visibility_score: opp.visibility_score,
            sales_14d: opp.sales_14d ?? met.sales ?? 0,
            orders_14d: opp.orders_14d ?? met.orders ?? 0,
            impressions_14d: opp.impressions_14d ?? 0,
            opportunity_state: opp.opportunity_state,
            // z = impressions para tamanho do ponto
            z: Math.max(10, Math.min(400, (opp.impressions_14d || 50))),
          };
        });
    }

    // Fallback: sem resultado do motor, usar produtos + métricas
    return products
      .filter(p => p.asin && p.sessions_30d > 0)
      .map(p => {
        const met = metByAsin.get(p.asin) || {};
        // visibility_score estimado: sessions / max_sessions
        const maxSessions = Math.max(...products.map(x => x.sessions_30d || 0), 1);
        const visEst = Math.min(1, (p.sessions_30d || 0) / maxSessions);
        return {
          asin: p.asin,
          keyword_text: p.product_name || p.display_name,
          visibility_score: visEst,
          sales_14d: met.sales || p.total_sales_30d / 2,
          orders_14d: met.orders || Math.round((p.total_units_30d || 0) / 2),
          impressions_14d: 0,
          opportunity_state: null,
          z: 50,
        };
      });
  }, [opportunities, metrics, products]);

  if (points.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-2">
        <Eye className="w-8 h-8 text-slate-700" />
        <p className="text-xs text-slate-500">Execute o motor para gerar os dados de visibilidade.</p>
      </div>
    );
  }

  // Estatísticas rápidas
  const avgVis = points.reduce((s, p) => s + (p.visibility_score || 0), 0) / points.length;
  const lowVis = points.filter(p => p.visibility_score < VIS_THRESHOLDS.low).length;
  const highVis = points.filter(p => p.visibility_score >= VIS_THRESHOLDS.medium).length;
  const totalSales = points.reduce((s, p) => s + (p.sales_14d || 0), 0);
  const highVisSales = points.filter(p => p.visibility_score >= VIS_THRESHOLDS.medium).reduce((s, p) => s + (p.sales_14d || 0), 0);
  const highVisSalesPct = totalSales > 0 ? Math.round(highVisSales / totalSales * 100) : 0;

  return (
    <div className="space-y-4">
      {/* KPIs rápidos */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Score Médio', value: avgVis.toFixed(3), color: avgVis < 0.3 ? 'text-red-400' : avgVis < 0.6 ? 'text-amber-400' : 'text-emerald-400', icon: Eye },
          { label: 'Baixa Visib.', value: lowVis, color: 'text-red-400', sub: 'score < 0.3', icon: AlertTriangle },
          { label: 'Alta Visib.', value: highVis, color: 'text-emerald-400', sub: 'score ≥ 0.6', icon: TrendingUp },
          { label: 'Vendas c/ Alta Visib.', value: `${highVisSalesPct}%`, color: 'text-cyan', sub: `R$${highVisSales.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} / 14d`, icon: TrendingUp },
        ].map(k => (
          <div key={k.label} className="bg-surface-2 rounded-xl p-3 border border-surface-3">
            <div className="flex items-center gap-1.5 mb-1">
              <k.icon className="w-3 h-3 text-slate-500" />
              <p className="text-[10px] text-slate-500">{k.label}</p>
            </div>
            <p className={`text-lg font-bold ${k.color}`}>{k.value}</p>
            {k.sub && <p className="text-[10px] text-slate-600 mt-0.5">{k.sub}</p>}
          </div>
        ))}
      </div>

      {/* Scatter plot */}
      <div>
        <p className="text-[10px] text-slate-500 mb-2">
          Eixo X = Visibility Score · Eixo Y = Vendas 14d (R$) · Tamanho = volume de impressões
        </p>
        <ResponsiveContainer width="100%" height={280}>
          <ScatterChart margin={{ top: 10, right: 20, bottom: 10, left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1E2A40" />
            <XAxis
              type="number" dataKey="visibility_score" name="Visibilidade"
              domain={[0, 1]} tickCount={6}
              tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false}
              label={{ value: 'Visibility Score →', position: 'insideBottom', offset: -5, fill: '#475569', fontSize: 9 }}
            />
            <YAxis
              type="number" dataKey="sales_14d" name="Vendas"
              tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false}
              tickFormatter={v => `R$${v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)}`}
            />
            <ZAxis type="number" dataKey="z" range={[20, 200]} />
            <Tooltip content={<CustomTooltip />} cursor={{ strokeDasharray: '3 3', stroke: '#334155' }} />
            {/* Linhas de referência de visibilidade */}
            <ReferenceLine x={VIS_THRESHOLDS.low} stroke="#EF4444" strokeDasharray="4 4" strokeOpacity={0.5}
              label={{ value: 'Baixa', position: 'top', fill: '#EF4444', fontSize: 8 }} />
            <ReferenceLine x={VIS_THRESHOLDS.medium} stroke="#10B981" strokeDasharray="4 4" strokeOpacity={0.5}
              label={{ value: 'Alta', position: 'top', fill: '#10B981', fontSize: 8 }} />
            <Scatter name="Produtos/Keywords" data={points}>
              {points.map((p, i) => (
                <Cell key={i} fill={visColor(p.visibility_score)} fillOpacity={0.75} stroke={visColor(p.visibility_score)} strokeWidth={1} />
              ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>

      {/* Legenda */}
      <div className="flex flex-wrap items-center gap-4 text-[10px]">
        {[
          { color: '#EF4444', label: 'Baixa visibilidade (< 0.3) — bid pode estar muito baixo' },
          { color: '#F59E0B', label: 'Média (0.3–0.6) — oportunidade de crescimento' },
          { color: '#10B981', label: 'Alta (≥ 0.6) — boa cobertura de impressões' },
        ].map(l => (
          <div key={l.label} className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: l.color }} />
            <span className="text-slate-500">{l.label}</span>
          </div>
        ))}
      </div>

      {/* Tabela top 10 mais relevantes */}
      {points.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[10px]">
            <thead>
              <tr className="border-b border-surface-2 bg-surface-2/30">
                {['ASIN / Keyword', 'Visib. Score', 'Status', 'Vendas 14d', 'Pedidos 14d', 'Impressões'].map(h => (
                  <th key={h} className="px-3 py-2 text-left font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...points]
                .sort((a, b) => (b.sales_14d || 0) - (a.sales_14d || 0))
                .slice(0, 10)
                .map((p, i) => (
                  <tr key={i} className="border-b border-surface-2/40 hover:bg-surface-2/20">
                    <td className="px-3 py-2">
                      <p className="font-mono text-cyan">{p.asin}</p>
                      {p.keyword_text && p.keyword_text !== p.asin && (
                        <p className="text-slate-500 truncate max-w-[160px]">{p.keyword_text}</p>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="w-16 h-1.5 bg-surface-3 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${(p.visibility_score || 0) * 100}%`, background: visColor(p.visibility_score) }} />
                        </div>
                        <span style={{ color: visColor(p.visibility_score) }} className="font-bold">
                          {(p.visibility_score || 0).toFixed(3)}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <span className="text-[9px] font-semibold" style={{ color: visColor(p.visibility_score) }}>
                        {visLabel(p.visibility_score)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-emerald-400 font-semibold">
                      R${(p.sales_14d || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td className="px-3 py-2 text-slate-300">{p.orders_14d ?? '—'}</td>
                    <td className="px-3 py-2 text-slate-500">{p.impressions_14d > 0 ? (p.impressions_14d).toLocaleString('pt-BR') : '—'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}