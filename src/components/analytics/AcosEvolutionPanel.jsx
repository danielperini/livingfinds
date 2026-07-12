import { useState, useMemo } from 'react';
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine
} from 'recharts';
import { TrendingUp, TrendingDown, Minus, ChevronDown } from 'lucide-react';

const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16', '#F97316', '#A855F7'];

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[#111318] border border-surface-2 rounded-lg p-3 text-xs shadow-xl max-w-xs">
      <p className="text-slate-400 mb-2 font-medium">{label}</p>
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-2 mb-1">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
          <span className="text-slate-300 truncate">{p.name}:</span>
          <span className="text-white font-semibold ml-auto pl-2">
            {p.name?.toLowerCase().includes('acos') ? `${Number(p.value).toFixed(1)}%`
              : p.name?.toLowerCase().includes('vendas') || p.name?.toLowerCase().includes('spend') ? `R$${Number(p.value).toFixed(2)}`
              : p.value}
          </span>
        </div>
      ))}
    </div>
  );
};

function AcosBadge({ acos }) {
  if (!acos || acos === 0) return <span className="text-slate-500">—</span>;
  const color = acos > 50 ? 'text-red-400 bg-red-400/10' : acos > 25 ? 'text-amber-400 bg-amber-400/10' : 'text-emerald-400 bg-emerald-400/10';
  return <span className={`px-1.5 py-0.5 rounded text-xs font-semibold ${color}`}>{acos.toFixed(1)}%</span>;
}

function TrendBadge({ current, previous }) {
  if (!previous || previous === 0) return <Minus className="w-3 h-3 text-slate-500" />;
  const delta = ((current - previous) / previous) * 100;
  if (Math.abs(delta) < 1) return <Minus className="w-3 h-3 text-slate-500" />;
  // para ACoS, queda é positivo
  return delta < 0
    ? <span className="flex items-center gap-0.5 text-emerald-400 text-xs"><TrendingDown className="w-3 h-3" />{Math.abs(delta).toFixed(0)}%</span>
    : <span className="flex items-center gap-0.5 text-red-400 text-xs"><TrendingUp className="w-3 h-3" />{delta.toFixed(0)}%</span>;
}

export default function AcosEvolutionPanel({ metrics, campaigns, products, period }) {
  const [viewMode, setViewMode] = useState('produto'); // 'produto' | 'campanha'
  const [selectedId, setSelectedId] = useState('all');
  const [topN, setTopN] = useState(5);

  const nowBRT = new Date(Date.now() - 3 * 3600000);
  const todayBRT = nowBRT.toISOString().slice(0, 10);
  const yesterdayBRT = new Date(new Date(todayBRT + 'T12:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  const cutoffDate = new Date(todayBRT + 'T00:00:00Z');
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - period);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  // Mapa campanha → asin
  const campAsinMap = useMemo(() => {
    const m = new Map();
    campaigns.forEach(c => {
      if (c.asin && c.campaign_id) m.set(c.campaign_id, c.asin);
      if (c.asin && c.amazon_campaign_id) m.set(c.amazon_campaign_id, c.asin);
    });
    return m;
  }, [campaigns]);

  const productMap = useMemo(() => new Map(products.map(p => [p.asin, p])), [products]);

  // Filtrar métricas no período
  const filtered = useMemo(() =>
    metrics.filter(m => m.date && m.date >= cutoff && m.date <= yesterdayBRT && m.campaign_id),
    [metrics, cutoff, yesterdayBRT]
  );

  // ── Dados por produto: ACoS/vendas por dia ─────────────────────────────
  const productDailyMap = useMemo(() => {
    const map = {};
    filtered.forEach(m => {
      const asin = campAsinMap.get(m.campaign_id);
      if (!asin) return;
      const key = `${asin}|${m.date}`;
      if (!map[key]) map[key] = { asin, date: m.date, spend: 0, sales: 0, orders: 0 };
      map[key].spend += m.spend || 0;
      map[key].sales += m.sales || 0;
      map[key].orders += m.orders || 0;
    });
    return Object.values(map);
  }, [filtered, campAsinMap]);

  // Totais por produto
  const productTotals = useMemo(() => {
    const map = {};
    productDailyMap.forEach(r => {
      if (!map[r.asin]) map[r.asin] = { asin: r.asin, spend: 0, sales: 0, orders: 0 };
      map[r.asin].spend += r.spend;
      map[r.asin].sales += r.sales;
      map[r.asin].orders += r.orders;
    });
    return Object.values(map)
      .map(p => ({ ...p, acos: p.sales > 0 ? p.spend / p.sales * 100 : 0 }))
      .sort((a, b) => b.sales - a.sales);
  }, [productDailyMap]);

  // Totais por campanha
  const campaignTotals = useMemo(() => {
    const map = {};
    filtered.forEach(m => {
      const cid = m.campaign_id;
      if (!map[cid]) map[cid] = { cid, spend: 0, sales: 0, orders: 0, impressions: 0, clicks: 0 };
      map[cid].spend += m.spend || 0;
      map[cid].sales += m.sales || 0;
      map[cid].orders += m.orders || 0;
      map[cid].impressions += m.impressions || 0;
      map[cid].clicks += m.clicks || 0;
    });
    return Object.values(map)
      .map(c => {
        const camp = campaigns.find(x => x.campaign_id === c.cid || x.amazon_campaign_id === c.cid);
        return {
          ...c,
          name: camp?.campaign_name || camp?.name || c.cid,
          asin: campAsinMap.get(c.cid),
          acos: c.sales > 0 ? c.spend / c.sales * 100 : 0,
          cpc: c.clicks > 0 ? c.spend / c.clicks : 0,
          cvr: c.clicks > 0 ? c.orders / c.clicks * 100 : 0,
        };
      })
      .sort((a, b) => b.sales - a.sales);
  }, [filtered, campaigns, campAsinMap]);

  const topProducts = productTotals.slice(0, topN);
  const topCampaigns = campaignTotals.slice(0, topN);

  // ── Gráfico de evolução diária: linhas por produto ou campanha ─────────
  const evolutionData = useMemo(() => {
    const dateMap = {};
    if (viewMode === 'produto') {
      const ids = selectedId === 'all' ? topProducts.map(p => p.asin) : [selectedId];
      productDailyMap
        .filter(r => ids.includes(r.asin))
        .forEach(r => {
          const [yy, mm, dd] = r.date.split('-');
          const label = `${dd}/${mm}`;
          if (!dateMap[r.date]) dateMap[r.date] = { name: label, date: r.date };
          const key = r.asin;
          if (!dateMap[r.date][key + '_spend']) dateMap[r.date][key + '_spend'] = 0;
          if (!dateMap[r.date][key + '_sales']) dateMap[r.date][key + '_sales'] = 0;
          dateMap[r.date][key + '_spend'] += r.spend;
          dateMap[r.date][key + '_sales'] += r.sales;
          dateMap[r.date][key + '_acos'] = dateMap[r.date][key + '_sales'] > 0
            ? dateMap[r.date][key + '_spend'] / dateMap[r.date][key + '_sales'] * 100 : 0;
        });
    } else {
      const ids = selectedId === 'all' ? topCampaigns.map(c => c.cid) : [selectedId];
      filtered
        .filter(m => ids.includes(m.campaign_id))
        .forEach(m => {
          const [yy, mm, dd] = m.date.split('-');
          const label = `${dd}/${mm}`;
          if (!dateMap[m.date]) dateMap[m.date] = { name: label, date: m.date };
          const key = m.campaign_id;
          if (!dateMap[m.date][key + '_spend']) dateMap[m.date][key + '_spend'] = 0;
          if (!dateMap[m.date][key + '_sales']) dateMap[m.date][key + '_sales'] = 0;
          dateMap[m.date][key + '_spend'] += m.spend || 0;
          dateMap[m.date][key + '_sales'] += m.sales || 0;
          dateMap[m.date][key + '_acos'] = dateMap[m.date][key + '_sales'] > 0
            ? dateMap[m.date][key + '_spend'] / dateMap[m.date][key + '_sales'] * 100 : 0;
        });
    }
    return Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date));
  }, [viewMode, selectedId, topProducts, topCampaigns, productDailyMap, filtered]);

  const lineKeys = useMemo(() => {
    if (selectedId !== 'all') return [{ key: selectedId + '_acos', label: 'ACoS %', color: '#F59E0B' }];
    if (viewMode === 'produto') return topProducts.map((p, i) => ({ key: p.asin + '_acos', label: p.asin, color: COLORS[i % COLORS.length] }));
    return topCampaigns.map((c, i) => ({ key: c.cid + '_acos', label: (c.name || c.cid).slice(0, 18), color: COLORS[i % COLORS.length] }));
  }, [viewMode, selectedId, topProducts, topCampaigns]);

  const salesKeys = useMemo(() => {
    if (selectedId !== 'all') return [{ key: selectedId + '_sales', label: 'Vendas R$', color: '#10B981' }];
    if (viewMode === 'produto') return topProducts.map((p, i) => ({ key: p.asin + '_sales', label: p.asin, color: COLORS[i % COLORS.length] }));
    return topCampaigns.map((c, i) => ({ key: c.cid + '_sales', label: (c.name || c.cid).slice(0, 18), color: COLORS[i % COLORS.length] }));
  }, [viewMode, selectedId, topProducts, topCampaigns]);

  const items = viewMode === 'produto' ? topProducts : topCampaigns;
  const itemLabel = (item) => {
    if (viewMode === 'produto') {
      const p = productMap.get(item.asin);
      const name = p?.display_name || p?.product_name;
      return name ? name.slice(0, 40) : item.asin;
    }
    return (item.name || item.cid).slice(0, 40);
  };
  const itemId = (item) => viewMode === 'produto' ? item.asin : item.cid;

  // half-period trend
  const half = Math.floor(evolutionData.length / 2);
  const firstHalf = evolutionData.slice(0, half);
  const secondHalf = evolutionData.slice(half);

  const avgAcosFirst = firstHalf.length && lineKeys[0]
    ? firstHalf.reduce((s, d) => s + (d[lineKeys[0].key] || 0), 0) / firstHalf.length : 0;
  const avgAcosSecond = secondHalf.length && lineKeys[0]
    ? secondHalf.reduce((s, d) => s + (d[lineKeys[0].key] || 0), 0) / secondHalf.length : 0;

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-surface-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-200">Evolução ACoS & Vendas por {viewMode === 'produto' ? 'Produto' : 'Campanha'}</h2>
          <p className="text-xs text-slate-500 mt-0.5">Comparação diária no período selecionado — {period}d</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Toggle produto/campanha */}
          <div className="flex bg-surface-2 border border-surface-3 rounded-lg p-0.5 gap-0.5">
            {['produto', 'campanha'].map(v => (
              <button key={v} onClick={() => { setViewMode(v); setSelectedId('all'); }}
                className={`px-3 py-1 rounded text-xs font-medium transition-all capitalize ${viewMode === v ? 'bg-cyan text-white' : 'text-slate-400 hover:text-white'}`}>
                {v === 'produto' ? 'Produto' : 'Campanha'}
              </button>
            ))}
          </div>
          {/* Top N */}
          <select value={topN} onChange={e => setTopN(Number(e.target.value))}
            className="bg-surface-2 border border-surface-3 text-xs text-slate-300 rounded-lg px-2 py-1.5">
            {[3, 5, 10].map(n => <option key={n} value={n}>Top {n}</option>)}
          </select>
        </div>
      </div>

      <div className="p-5 space-y-5">
        {/* Selector individual */}
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => setSelectedId('all')}
            className={`px-3 py-1 rounded-full text-xs font-medium border transition-all ${selectedId === 'all' ? 'border-cyan bg-cyan/10 text-cyan' : 'border-surface-3 text-slate-400 hover:text-white'}`}>
            Todos (Top {topN})
          </button>
          {items.map((item, i) => (
            <button key={itemId(item)} onClick={() => setSelectedId(itemId(item))}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-all truncate max-w-[160px] ${selectedId === itemId(item) ? 'border-cyan bg-cyan/10 text-cyan' : 'border-surface-3 text-slate-400 hover:text-white'}`}
              style={selectedId === itemId(item) ? {} : { borderColor: COLORS[i % COLORS.length] + '44', color: COLORS[i % COLORS.length] }}>
              {itemLabel(item)}
            </button>
          ))}
        </div>

        {evolutionData.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-slate-500 text-sm">Sem dados no período selecionado</div>
        ) : (
          <>
            {/* Gráfico ACoS */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">ACoS Diário (%)</p>
                {selectedId !== 'all' && avgAcosFirst > 0 && (
                  <div className="flex items-center gap-1 text-xs text-slate-400">
                    <span>Tendência:</span>
                    <TrendBadge current={avgAcosSecond} previous={avgAcosFirst} />
                  </div>
                )}
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={evolutionData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                  <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} unit="%" />
                  <Tooltip content={<CustomTooltip />} />
                  {lineKeys.length > 1 && <Legend wrapperStyle={{ fontSize: 10, color: '#94a3b8' }} />}
                  <ReferenceLine y={25} stroke="#F59E0B" strokeDasharray="4 4" strokeOpacity={0.4} label={{ value: '25%', position: 'right', fontSize: 9, fill: '#F59E0B' }} />
                  {lineKeys.map(lk => (
                    <Line key={lk.key} type="monotone" dataKey={lk.key} name={lk.label}
                      stroke={lk.color} strokeWidth={selectedId !== 'all' ? 2.5 : 1.5}
                      dot={false} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Gráfico Vendas */}
            <div>
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">Vendas Diárias (R$)</p>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={evolutionData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                  <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <Tooltip content={<CustomTooltip />} />
                  {salesKeys.length > 1 && <Legend wrapperStyle={{ fontSize: 10, color: '#94a3b8' }} />}
                  {salesKeys.map(sk => (
                    <Line key={sk.key} type="monotone" dataKey={sk.key} name={sk.label}
                      stroke={sk.color} strokeWidth={selectedId !== 'all' ? 2.5 : 1.5}
                      dot={false} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )}

        {/* Tabela comparativa */}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-surface-2">
                <th className="px-3 py-2 text-left text-slate-500 font-semibold uppercase tracking-wide">{viewMode === 'produto' ? 'ASIN' : 'Campanha'}</th>
                <th className="px-3 py-2 text-right text-slate-500 font-semibold uppercase tracking-wide">Vendas</th>
                <th className="px-3 py-2 text-right text-slate-500 font-semibold uppercase tracking-wide">Spend</th>
                <th className="px-3 py-2 text-right text-slate-500 font-semibold uppercase tracking-wide">ACoS</th>
                <th className="px-3 py-2 text-right text-slate-500 font-semibold uppercase tracking-wide">Pedidos</th>
                {viewMode === 'campanha' && <th className="px-3 py-2 text-right text-slate-500 font-semibold uppercase tracking-wide">CVR</th>}
                {viewMode === 'campanha' && <th className="px-3 py-2 text-right text-slate-500 font-semibold uppercase tracking-wide">CPC</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={itemId(item)}
                  onClick={() => setSelectedId(selectedId === itemId(item) ? 'all' : itemId(item))}
                  className={`border-b border-surface-2/40 cursor-pointer transition-colors ${selectedId === itemId(item) ? 'bg-cyan/5' : 'hover:bg-surface-2'}`}>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: COLORS[i % COLORS.length] }} />
                      <span className="font-mono text-slate-200 truncate max-w-[180px]">{itemLabel(item)}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right text-emerald-400 font-medium">R${(item.sales || 0).toFixed(2)}</td>
                  <td className="px-3 py-2.5 text-right text-slate-300">R${(item.spend || 0).toFixed(2)}</td>
                  <td className="px-3 py-2.5 text-right"><AcosBadge acos={item.acos} /></td>
                  <td className="px-3 py-2.5 text-right text-slate-300">{item.orders || 0}</td>
                  {viewMode === 'campanha' && <td className="px-3 py-2.5 text-right text-slate-300">{(item.cvr || 0).toFixed(1)}%</td>}
                  {viewMode === 'campanha' && <td className="px-3 py-2.5 text-right text-slate-300">R${(item.cpc || 0).toFixed(2)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}