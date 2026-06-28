import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { xanoRequest, toArray } from '@/lib/useXano';
import { Package, Search, TrendingUp, Loader2, AlertTriangle } from 'lucide-react';
import MetricCard from '@/components/ui/MetricCard';
import EmptyState from '@/components/ui/EmptyState';

export default function InventorySales() {
  const [products, setProducts] = useState([]);
  const [sales, setSales] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('products');
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [xProds, xPerf] = await Promise.allSettled([
          xanoRequest('GET', '/amazon/products'),
          xanoRequest('GET', '/amazon/products/performance/list'),
        ]);
        if (xProds.status === 'fulfilled') setProducts(toArray(xProds.value, 'products'));
        if (xPerf.status === 'fulfilled') setSales(toArray(xPerf.value, 'products'));
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const filtered = products.filter(p =>
    p.asin?.toLowerCase().includes(search.toLowerCase()) ||
    p.name?.toLowerCase().includes(search.toLowerCase()) ||
    p.sku?.toLowerCase().includes(search.toLowerCase())
  );

  const totalRevenue = products.reduce((s, p) => s + (p.total_revenue_30d || 0), 0);
  const totalUnits = products.reduce((s, p) => s + (p.units_sold_30d || 0), 0);
  const lowStock = products.filter(p => (p.fba_inventory || 0) < 10).length;
  const outOfStock = products.filter(p => (p.fba_inventory || 0) === 0).length;

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-white">Estoque & Vendas</h1>
          <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border text-emerald-400 bg-emerald-400/10 border-emerald-400/20">
            Xano Live
          </span>
        </div>
        <div className="flex border-b border-surface-2">
          {['products', 'sales'].map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab === t ? 'border-cyan text-cyan' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
              {t === 'products' ? 'Produtos' : 'Vendas Diárias'}
            </button>
          ))}
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard label="Receita 30d" value={totalRevenue} prefix="$" loading={loading} glowColor="green" />
        <MetricCard label="Unidades 30d" value={totalUnits} loading={loading} glowColor="cyan" />
        <MetricCard label="Stock Baixo" value={lowStock} loading={loading} glowColor="amber" subvalue="< 10 unidades" />
        <MetricCard label="Sem Stock" value={outOfStock} loading={loading} glowColor="red" />
      </div>

      {/* Search */}
      {tab === 'products' && (
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Pesquisar ASIN, nome ou SKU..."
            className="w-full pl-10 pr-4 py-2.5 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50"
          />
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-7 h-7 text-cyan animate-spin" />
        </div>
      ) : tab === 'products' ? (
        filtered.length === 0 ? (
          <EmptyState icon={Package} title="Sem produtos" description="Executa uma sincronização para carregar o catálogo de produtos." />
        ) : (
          <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2">
                  {['ASIN / Nome', 'SKU', 'Preço', 'FBA Stock', 'Reservado', 'Receita 30d', 'Unidades 30d', 'Alerta'].map(h => (
                    <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-slate-500 uppercase">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(p => {
                  const stockAlert = (p.fba_inventory || 0) === 0 ? 'out' : (p.fba_inventory || 0) < 10 ? 'low' : 'ok';
                  return (
                    <tr key={p.id} className="border-b border-surface-2/50 hover:bg-surface-2 transition-colors">
                      <td className="px-5 py-3">
                        <p className="font-medium text-white font-mono text-xs">{p.asin}</p>
                        <p className="text-xs text-slate-500 truncate max-w-xs mt-0.5">{p.name || '—'}</p>
                      </td>
                      <td className="px-5 py-3 text-xs text-slate-400 font-mono">{p.sku || '—'}</td>
                      <td className="px-5 py-3 text-slate-300">${(p.price || 0).toFixed(2)}</td>
                      <td className="px-5 py-3">
                        <span className={`font-semibold ${stockAlert === 'out' ? 'text-red-400' : stockAlert === 'low' ? 'text-amber-400' : 'text-white'}`}>
                          {p.fba_inventory || 0}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-slate-400">{p.reserved_inventory || 0}</td>
                      <td className="px-5 py-3 text-emerald-400">${(p.total_revenue_30d || 0).toFixed(2)}</td>
                      <td className="px-5 py-3 text-slate-300">{p.units_sold_30d || 0}</td>
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
          <EmptyState icon={TrendingUp} title="Sem dados de vendas" description="Executa uma sincronização SP-API para carregar o histórico de vendas." />
        ) : (
          <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2">
                  {['Data', 'ASIN', 'Unidades', 'Receita', 'Sessões', 'Page Views', 'Buy Box', 'Conversão'].map(h => (
                    <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-slate-500 uppercase">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sales.map(s => (
                  <tr key={s.id} className="border-b border-surface-2/50 hover:bg-surface-2 transition-colors">
                    <td className="px-5 py-3 text-slate-300">{s.date}</td>
                    <td className="px-5 py-3 font-mono text-xs text-slate-400">{s.asin || '—'}</td>
                    <td className="px-5 py-3 text-slate-300">{s.units_ordered || 0}</td>
                    <td className="px-5 py-3 text-emerald-400">${(s.ordered_product_sales || 0).toFixed(2)}</td>
                    <td className="px-5 py-3 text-slate-400">{(s.sessions || 0).toLocaleString()}</td>
                    <td className="px-5 py-3 text-slate-400">{(s.page_views || 0).toLocaleString()}</td>
                    <td className="px-5 py-3 text-slate-300">{(s.buy_box_pct || 0).toFixed(1)}%</td>
                    <td className="px-5 py-3">
                      <span className={`font-semibold ${(s.conversion_rate || 0) > 10 ? 'text-emerald-400' : 'text-amber-400'}`}>
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