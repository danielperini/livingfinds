import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { Package, Search, TrendingUp, Loader2, AlertTriangle, RefreshCw } from 'lucide-react';

export default function InventorySales() {
  const [account, setAccount] = useState(null);
  const [products, setProducts] = useState([]);
  const [sales, setSales] = useState([]);
  const [loading, setLoading] = useState(true);
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
        base44.entities.Product.filter({ amazon_account_id: acc.id }, '-total_revenue_30d', 500),
        base44.entities.SalesDaily.filter({ amazon_account_id: acc.id }, '-date', 200),
      ]);
      setProducts(prods);
      setSales(dailySales);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = products.filter(p =>
    (p.asin || '').toLowerCase().includes(search.toLowerCase()) ||
    (p.name || '').toLowerCase().includes(search.toLowerCase()) ||
    (p.sku || '').toLowerCase().includes(search.toLowerCase())
  );

  const totalRevenue = products.reduce((s, p) => s + (p.total_revenue_30d || p.total_sales_30d || 0), 0);
  const totalUnits = products.reduce((s, p) => s + (p.units_sold_30d || p.total_units_30d || 0), 0);
  const lowStock = products.filter(p => (p.fba_inventory || 0) < 10 && (p.fba_inventory || 0) > 0).length;
  const outOfStock = products.filter(p => (p.fba_inventory || 0) === 0).length;

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
          { label: 'Receita 30d', value: `$${totalRevenue.toFixed(0)}`, color: 'text-emerald-400' },
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
                  {['ASIN / Nome', 'SKU', 'Preço', 'FBA Stock', 'Receita 30d', 'Unidades 30d', 'Alerta'].map(h => (
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
                        <p className="text-xs text-slate-500 truncate max-w-xs mt-0.5">{p.name || '—'}</p>
                      </td>
                      <td className="px-5 py-3 text-xs text-slate-400 font-mono">{p.sku || '—'}</td>
                      <td className="px-5 py-3 text-slate-300">{p.price ? `$${p.price.toFixed(2)}` : '—'}</td>
                      <td className="px-5 py-3">
                        <span className={`font-bold ${stockAlert === 'out' ? 'text-red-400' : stockAlert === 'low' ? 'text-amber-400' : 'text-white'}`}>
                          {p.fba_inventory || 0}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-emerald-400">${(p.total_revenue_30d || p.total_sales_30d || 0).toFixed(2)}</td>
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
            <p className="text-sm text-slate-400">Sem dados de vendas diárias.</p>
          </div>
        ) : (
          <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
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
                    <td className="px-5 py-3 text-emerald-400">${(s.ordered_product_sales || 0).toFixed(2)}</td>
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
        )
      )}
    </div>
  );
}