import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { DollarSign, Search, Filter, RefreshCw, Edit3, Loader2, AlertCircle, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import EconomicStatusBadge, { ECON_CLASS_LABELS } from './EconomicStatusBadge';
import ProductCostEditor from './ProductCostEditor';

function fmt(v, decimals = 2) {
  if (v === null || v === undefined || isNaN(Number(v))) return '—';
  return `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}
function fmtPct(v) {
  if (v === null || v === undefined || isNaN(Number(v))) return '—';
  return `${Number(v).toFixed(1)}%`;
}

const FILTERS = [
  { key: 'all', label: 'Todos' },
  { key: 'complete', label: '✅ Completos' },
  { key: 'missing_cost', label: '❌ Sem Custo' },
  { key: 'missing_price', label: '⚠ Sem Preço' },
  { key: 'missing_fees', label: 'Sem Tarifas' },
  { key: 'highly_profitable', label: '💚 Alta Margem' },
  { key: 'profitable', label: '✅ Lucrativos' },
  { key: 'low_margin', label: '🟡 Baixa Margem' },
  { key: 'unprofitable', label: '🔴 Prejuízo' },
  { key: 'unknown', label: '⬜ Sem Dados' },
];

export default function ProductEconomicsPanel({ accountId }) {
  const [economics, setEconomics] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [editTarget, setEditTarget] = useState(null); // { product, economics }
  const [recalcLoading, setRecalcLoading] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const [eList, pList] = await Promise.all([
        base44.entities.ProductEconomics?.filter
          ? base44.entities.ProductEconomics.filter({ amazon_account_id: accountId }, null, 500)
          : [],
        base44.entities.Product.filter({ amazon_account_id: accountId }, null, 500),
      ]);
      setEconomics(eList || []);
      setProducts(pList || []);
    } catch { }
    finally { setLoading(false); }
  }, [accountId]);

  useEffect(() => { load(); }, [load]);

  const econByNsku = new Map((economics || []).map(e => [normSku(e.sku), e]));
  function normSku(s) { return (s || '').trim().toUpperCase().replace(/\s+/g, '-').replace(/-{2,}/g, '-'); }

  // Enriquecer: cada product + seu economics
  const rows = products
    .filter(p => p.status !== 'archived')
    .map(p => ({
      product: p,
      econ: econByNsku.get(normSku(p.sku)) || null,
    }));

  const filtered = rows.filter(({ product: p, econ }) => {
    const term = search.trim().toLowerCase();
    const matchSearch = !term ||
      (p.sku || '').toLowerCase().includes(term) ||
      (p.asin || '').toLowerCase().includes(term) ||
      (p.product_name || '').toLowerCase().includes(term) ||
      (p.display_name || '').toLowerCase().includes(term);
    const st = econ?.economics_status || 'missing_cost';
    const cl = econ?.economic_classification || 'unknown';
    const matchFilter = filter === 'all' ||
      filter === st ||
      filter === cl ||
      (filter === 'missing_cost' && !econ);
    return matchSearch && matchFilter;
  });

  const stats = {
    total: rows.length,
    complete: rows.filter(r => r.econ?.economics_status === 'complete').length,
    missing: rows.filter(r => !r.econ || r.econ.economics_status === 'missing_cost').length,
    unprofitable: rows.filter(r => r.econ?.economic_classification === 'unprofitable').length,
    profitable: rows.filter(r => ['highly_profitable', 'profitable'].includes(r.econ?.economic_classification)).length,
  };

  const handleRecalculate = async () => {
    setRecalcLoading(true);
    try {
      const res = await base44.functions.invoke('importProductEconomics', {
        amazon_account_id: accountId, recalculate_only: true,
      });
      if (res?.data?.ok) {
        setMsg({ type: 'success', text: `${res.data.updated} registros recalculados.` });
        await load();
      }
    } catch (e) { setMsg({ type: 'error', text: e.message }); }
    finally { setRecalcLoading(false); setTimeout(() => setMsg(null), 5000); }
  };

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {[
          { label: 'Total produtos', value: stats.total, tone: 'default' },
          { label: 'Dados completos', value: stats.complete, tone: 'success' },
          { label: 'Sem custo/dados', value: stats.missing, tone: stats.missing > 0 ? 'warning' : 'default' },
          { label: 'Lucrativos', value: stats.profitable, tone: 'success' },
          { label: 'Com prejuízo', value: stats.unprofitable, tone: stats.unprofitable > 0 ? 'danger' : 'default' },
        ].map(kpi => (
          <div key={kpi.label} className={`rounded-xl p-4 border ${kpi.tone === 'success' ? 'bg-emerald-500/5 border-emerald-500/20' : kpi.tone === 'warning' ? 'bg-amber-500/5 border-amber-500/20' : kpi.tone === 'danger' ? 'bg-red-500/5 border-red-500/20' : 'bg-surface-1 border-surface-2'}`}>
            <p className="text-xs text-slate-500">{kpi.label}</p>
            <p className={`text-xl font-bold ${kpi.tone === 'success' ? 'text-emerald-400' : kpi.tone === 'warning' ? 'text-amber-400' : kpi.tone === 'danger' ? 'text-red-400' : 'text-white'}`}>{kpi.value}</p>
          </div>
        ))}
      </div>

      {/* Ações + Busca */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="SKU, ASIN, nome..."
            className="w-full pl-9 pr-4 py-2 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
        </div>
        <button onClick={handleRecalculate} disabled={recalcLoading}
          className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-400 bg-surface-1 border border-surface-2 hover:text-white rounded-lg transition-colors disabled:opacity-50">
          {recalcLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Recalcular
        </button>
      </div>

      {/* Filtros */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {FILTERS.map(f => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            className={`text-xs px-3 py-1.5 rounded-full border transition-colors whitespace-nowrap ${filter === f.key ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'}`}>
            {f.label}
          </button>
        ))}
      </div>

      {msg && (
        <div className={`px-3 py-2 rounded-lg text-xs border ${msg.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
          {msg.text}
        </div>
      )}

      {/* Tabela */}
      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
      ) : (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/40">
                  {['SKU / ASIN', 'Custo Total', 'Preço', 'Margem', 'Break-even', 'Target ACoS', 'Safe CPC', 'Classificação', 'Status', ''].map(h => (
                    <th key={h} className="px-3 py-2.5 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={10} className="px-4 py-10 text-center text-slate-500 text-xs">Nenhum produto encontrado</td></tr>
                ) : filtered.map(({ product: p, econ: e }) => {
                  const name = p.display_name || p.product_name || p.sku;
                  const marginPct = e?.contribution_margin_percent;
                  const marginColor = marginPct === null || marginPct === undefined ? 'text-slate-500'
                    : marginPct < 0 ? 'text-red-400' : marginPct < 10 ? 'text-amber-400' : 'text-emerald-400';
                  return (
                    <tr key={p.id} className="border-b border-surface-2/40 hover:bg-surface-2/30 transition-colors">
                      <td className="px-3 py-2.5 min-w-[160px]">
                        <p className="font-mono text-cyan text-[11px]">{p.sku}</p>
                        {p.asin && <p className="font-mono text-slate-500 text-[10px]">{p.asin}</p>}
                        <p className="text-slate-400 text-[10px] truncate max-w-[180px]" title={name}>{name}</p>
                      </td>
                      <td className="px-3 py-2.5 text-slate-300 font-medium">
                        {e?.total_variable_cost_per_unit > 0 ? fmt(e.total_variable_cost_per_unit) : '—'}
                        {e?.unit_cost > 0 && <p className="text-[10px] text-slate-500">CMV: {fmt(e.unit_cost)}</p>}
                      </td>
                      <td className="px-3 py-2.5 text-slate-300">
                        {e?.current_price > 0 ? fmt(e.current_price) : (p.price > 0 ? fmt(p.price) : <span className="text-amber-400">Ausente</span>)}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`font-semibold ${marginColor}`}>{fmtPct(marginPct)}</span>
                        {e?.contribution_margin_amount != null && (
                          <p className={`text-[10px] ${marginColor}`}>{fmt(e.contribution_margin_amount)}</p>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-slate-300">{e?.break_even_acos > 0 ? fmtPct(e.break_even_acos) : '—'}</td>
                      <td className="px-3 py-2.5 text-cyan font-medium">{e?.target_acos > 0 ? fmtPct(e.target_acos) : '—'}</td>
                      <td className="px-3 py-2.5 text-slate-400">{e?.safe_max_cpc > 0 ? fmt(e.safe_max_cpc) : '—'}</td>
                      <td className="px-3 py-2.5">
                        {e ? (
                          <span className={`text-[10px] font-medium ${(ECON_CLASS_LABELS[e.economic_classification] || ECON_CLASS_LABELS.unknown).color}`}>
                            {(ECON_CLASS_LABELS[e.economic_classification] || ECON_CLASS_LABELS.unknown).label}
                          </span>
                        ) : <span className="text-[10px] text-slate-500">⬜ Sem dados</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        <EconomicStatusBadge
                          status={e?.economics_status || 'missing_cost'}
                          classification={e?.economic_classification}
                          compact
                        />
                        {e?.final_economic_confidence > 0 && (
                          <p className="text-[10px] text-slate-600 mt-0.5">Conf: {(e.final_economic_confidence * 100).toFixed(0)}%</p>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <button onClick={() => setEditTarget({ product: p, economics: e })}
                          className="flex items-center gap-1 px-2.5 py-1.5 text-[10px] font-semibold rounded-lg border bg-cyan/10 border-cyan/20 text-cyan hover:bg-cyan/20 transition-colors whitespace-nowrap">
                          <Edit3 className="w-3 h-3" />
                          {e ? 'Editar' : 'Cadastrar'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editTarget && (
        <ProductCostEditor
          product={editTarget.product}
          economics={editTarget.economics}
          mode={editTarget.economics ? 'edit' : 'new'}
          onClose={() => setEditTarget(null)}
          onSave={() => { setEditTarget(null); load(); }}
        />
      )}
    </div>
  );
}