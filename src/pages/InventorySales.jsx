import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Package, Search, TrendingUp, Loader2, AlertTriangle, RefreshCw, Sparkles, BarChart2 } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Legend } from 'recharts';

export default function InventorySales() {
  const [account, setAccount] = useState(null);
  const [products, setProducts] = useState([]);
  const [sales, setSales] = useState([]);
  const [loading, setLoading] = useState(true);
  const [enriching, setEnriching] = useState(false);
  const [enrichMsg, setEnrichMsg] = useState(null);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('products');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0] || null;
      setAccount(acc);
      if (!acc) return;
      const [prods, dailySales] = await Promise.all([
        base44.entities.Product.filter({ amazon_account_id: acc.id }, '-fba_inventory', 500),
        base44.entities.SalesDaily.filter({ amazon_account_id: acc.id }, '-date', 200),
      ]);
      setProducts(prods);
      setSales(dailySales);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const missingTitles = products.filter(p => !p.product_name && !p.display_name).length;

  const enrichTitles = async () => {
    if (!account || enriching) return;
    setEnriching(true);
    setEnrichMsg(null);
    try {
      const res = await base44.functions.invoke('enrichProductNames', { amazon_account_id: account.id });
      const updated = res?.data?.updated || 0;
      setEnrichMsg({ type: 'success', text: `${updated} títulos atualizados via IA.` });
      await load();
    } catch (e) {
      setEnrichMsg({ type: 'error', text: e.message });
    } finally {
      setEnriching(false);
      setTimeout(() => setEnrichMsg(null), 6000);
    }
  };

  const filtered = products.filter(p =>
    (p.asin || '').toLowerCase().includes(search.toLowerCase()) ||
    (p.product_name || p.display_name || '').toLowerCase().includes(search.toLowerCase()) ||
    (p.sku || '').toLowerCase().includes(search.toLowerCase())
  );

  const totalRevenue = products.reduce((s, p) => s + (p.total_revenue_30d || p.total_sales_30d || 0), 0);
  const totalUnits = products.reduce((s, p) => s + (p.units_sold_30d || p.total_units_30d || 0), 0);
  const lowStock = products.filter(p => (p.fba_inventory || 0) < 10 && (p.fba_inventory || 0) > 0).length;
  const outOfStock = products.filter(p => (p.fba_inventory || 0) === 0).length;

  // Agregar vendas por data para o gráfico (últimos 30 dias, de mais antigo para mais recente)
  const salesByDate = (() => {
    const map = new Map();
    for (const s of sales) {
      const prev = map.get(s.date) || { date: s.date, receita: 0, unidades: 0, sessoes: 0 };
      prev.receita += s.ordered_product_sales || 0;
      prev.unidades += s.units_ordered || 0;
      prev.sessoes += s.sessions || 0;
      map.set(s.date, prev);
    }
    return Array.from(map.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-30)
      .map(d => ({ ...d, date: d.date.slice(5), receita: parseFloat(d.receita.toFixed(2)) }));
  })();

  const totalSalesRevenue = sales.reduce((s, r) => s + (r.ordered_product_sales || 0), 0);
  const totalSalesUnits = sales.reduce((s, r) => s + (r.units_ordered || 0), 0);
  const totalSalesSessions = sales.reduce((s, r) => s + (r.sessions || 0), 0);
  const avgConversion = sales.length > 0
    ? sales.reduce((s, r) => s + (r.conversion_rate || 0), 0) / sales.length
    : 0;

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-bold text-white">Estoque & Vendas</h1>
        <div className="flex items-center gap-3">
          <div className="flex border border-surface-2 rounded-lg overflow-hidden">
            {[{ id: 'products', label: 'Produtos' }, { id: 'sales', label: 'Vendas Diárias' }].map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`px-4 py-2 text-sm font-medium transition-colors ${tab === t.id ? 'bg-surface-2 text-white' : 'text-slate-500 hover:text-slate-300'}`}>
                {t.label}
              </button>
            ))}
          </div>

          <button onClick={load} className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Receita 30d', value: `R$${totalRevenue.toFixed(0)}`, color: 'text-emerald-400' },
          { label: 'Unidades 30d', value: totalUnits.toLocaleString(), color: 'text-cyan' },
          { label: 'Stock Baixo', value: lowStock, color: 'text-amber-400', sub: '< 10 unidades' },
          { label: 'Sem Stock', value: outOfStock, color: 'text-red-400' },
        ].map(k => (
          <div key={k.label} className="bg-surface-1 border border-surface-2 rounded-xl p-5">
            <p className="text-xs text-slate-400 mb-2">{k.label}</p>
            <p className={`text-2xl font-bold ${k.color}`}>{loading ? '—' : k.value}</p>
            {k.sub && <p className="text-xs text-slate-500 mt-1">{k.sub}</p>}
          </div>
        ))}
      </div>

      {tab === 'products' && (
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Pesquisar ASIN, nome ou SKU..."
            className="w-full pl-10 pr-4 py-2.5 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-7 h-7 text-cyan animate-spin" /></div>
      ) : tab === 'products' ? (
        filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
            <Package className="w-10 h-10 text-slate-600" />
            <p className="text-sm text-slate-400">Sem produtos. Execute um Sync no Dashboard.</p>
          </div>
        ) : (
          <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2">
                  {['ASIN', 'Título do Produto', 'SKU', 'Disponível desde', 'Preço', 'FBA Stock', 'Receita 30d', 'Unidades 30d', 'Alerta'].map(h => (
                    <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(p => {
                  const stockAlert = (p.fba_inventory || 0) === 0 ? 'out' : (p.fba_inventory || 0) < 10 ? 'low' : 'ok';
                  return (
                    <tr key={p.id} className="border-b border-surface-2/50 hover:bg-surface-2 transition-colors">
                      <td className="px-5 py-3">
                        <p className="font-medium text-cyan font-mono text-xs">{p.asin}</p>
                      </td>
                      <td className="px-5 py-3 max-w-[260px]">
                        {(p.product_name || p.display_name) ? (
                          <p className="text-xs text-slate-200 leading-snug line-clamp-2">{p.product_name || p.display_name}</p>
                        ) : (
                          <span className="text-xs text-slate-600 italic">Sem título</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-xs text-slate-400 font-mono">{p.sku || '—'}</td>
                      <td className="px-5 py-3 text-xs text-slate-400 whitespace-nowrap">
                        {p.first_available_date
                          ? new Date(p.first_available_date).toLocaleDateString('pt-BR')
                          : p.created_date
                            ? new Date(p.created_date).toLocaleDateString('pt-BR')
                            : '—'}
                      </td>
                      <td className="px-5 py-3 text-slate-300">{p.price ? `R$${p.price.toFixed(2)}` : '—'}</td>
                      <td className="px-5 py-3">
                        <span className={`font-bold ${stockAlert === 'out' ? 'text-red-400' : stockAlert === 'low' ? 'text-amber-400' : 'text-white'}`}>
                          {p.fba_inventory || 0}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-emerald-400">R${(p.total_revenue_30d || p.total_sales_30d || 0).toFixed(2)}</td>
                      <td className="px-5 py-3 text-slate-300">{p.units_sold_30d || p.total_units_30d || 0}</td>
                      <td className="px-5 py-3">
                        {stockAlert !== 'ok' && (
                          <div className={`flex items-center gap-1 text-xs ${stockAlert === 'out' ? 'text-red-400' : 'text-amber-400'}`}>
                            <AlertTriangle className="w-3 h-3" />
                            {stockAlert === 'out' ? 'Sem stock' : 'Stock baixo'}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : (
        sales.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
            <TrendingUp className="w-10 h-10 text-slate-600" />
            <p className="text-sm text-slate-400">Sem dados de vendas diárias. Certifique-se que o Sync SP-API está ativo.</p>
          </div>
        ) : (
          <div className="space-y-5">
            {/* KPIs de vendas reais */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {[
                { label: 'Receita Total', value: `R$${totalSalesRevenue.toFixed(2)}`, color: 'text-emerald-400' },
                { label: 'Unidades Vendidas', value: totalSalesUnits.toLocaleString(), color: 'text-cyan' },
                { label: 'Sessões', value: totalSalesSessions.toLocaleString(), color: 'text-slate-200' },
                { label: 'Conversão Média', value: `${avgConversion.toFixed(2)}%`, color: avgConversion > 10 ? 'text-emerald-400' : 'text-amber-400' },
              ].map(k => (
                <div key={k.label} className="bg-surface-1 border border-surface-2 rounded-xl p-4">
                  <p className="text-xs text-slate-500 mb-1">{k.label}</p>
                  <p className={`text-xl font-bold ${k.color}`}>{k.value}</p>
                </div>
              ))}
            </div>

            {/* Gráfico de tendência */}
            {salesByDate.length > 1 && (
              <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
                <div className="flex items-center gap-2 mb-4">
                  <BarChart2 className="w-4 h-4 text-cyan" />
                  <h3 className="text-sm font-semibold text-white">Tendência de Vendas (últimos {salesByDate.length} dias)</h3>
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={salesByDate} margin={{ top: 4, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gradReceita" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#10B981" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#10B981" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="gradUnidades" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1A1D26" />
                    <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 11 }} />
                    <YAxis yAxisId="receita" orientation="left" tick={{ fill: '#64748b', fontSize: 11 }}
                      tickFormatter={v => `R$${v}`} width={60} />
                    <YAxis yAxisId="unidades" orientation="right" tick={{ fill: '#64748b', fontSize: 11 }} width={35} />
                    <Tooltip
                      contentStyle={{ background: '#111318', border: '1px solid #1A1D26', borderRadius: 8 }}
                      labelStyle={{ color: '#94a3b8', fontSize: 11 }}
                      formatter={(value, name) => name === 'receita'
                        ? [`R$${Number(value).toFixed(2)}`, 'Receita']
                        : [value, 'Unidades']}
                    />
                    <Legend wrapperStyle={{ fontSize: 12, color: '#64748b' }} />
                    <Area yAxisId="receita" type="monotone" dataKey="receita" stroke="#10B981"
                      fill="url(#gradReceita)" strokeWidth={2} name="Receita (R$)" />
                    <Area yAxisId="unidades" type="monotone" dataKey="unidades" stroke="#3B82F6"
                      fill="url(#gradUnidades)" strokeWidth={2} name="Unidades" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Tabela detalhada */}
            <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-surface-2">
                      {['Data', 'ASIN', 'Unidades', 'Receita', 'Sessões', 'Page Views', 'Buy Box', 'Conversão'].map(h => (
                        <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sales.map(s => (
                      <tr key={s.id} className="border-b border-surface-2/50 hover:bg-surface-2 transition-colors">
                        <td className="px-5 py-3 text-slate-300 whitespace-nowrap">{s.date}</td>
                        <td className="px-5 py-3 font-mono text-xs text-cyan">{s.asin || '—'}</td>
                        <td className="px-5 py-3 text-slate-300">{s.units_ordered || 0}</td>
                        <td className="px-5 py-3 text-emerald-400">R${(s.ordered_product_sales || 0).toFixed(2)}</td>
                        <td className="px-5 py-3 text-slate-400">{(s.sessions || 0).toLocaleString()}</td>
                        <td className="px-5 py-3 text-slate-400">{(s.page_views || 0).toLocaleString()}</td>
                        <td className="px-5 py-3 text-slate-300">{(s.buy_box_pct || 0).toFixed(1)}%</td>
                        <td className="px-5 py-3">
                          <span className={`font-semibold text-xs ${(s.conversion_rate || 0) > 10 ? 'text-emerald-400' : 'text-amber-400'}`}>
                            {(s.conversion_rate || 0).toFixed(2)}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )
      )}
    </div>
  );
}