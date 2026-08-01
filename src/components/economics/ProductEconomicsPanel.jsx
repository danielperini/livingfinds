import { useCallback, useEffect, useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { AlertCircle, CheckSquare, Edit3, Eye, Layers3, Loader2, Play, RefreshCw, Search, Square, X } from 'lucide-react';
import ProductCostEditor from './ProductCostEditor';
import BulkProductEconomicsEditor from './BulkProductEconomicsEditor';

const normSku = value => String(value || '').trim().toUpperCase().replace(/\s+/g, '-').replace(/-{2,}/g, '-');
const money = value => value == null || Number.isNaN(Number(value)) ? '—' : `R$ ${Number(value).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = value => value == null || Number.isNaN(Number(value)) ? '—' : `${Number(value).toFixed(1)}%`;
const dateTime = value => value ? new Date(value).toLocaleString('pt-BR') : '—';

const FILTERS = [
  ['all', 'Todos'], ['enabled', 'Repricing solicitado'], ['recommendation', 'Com recomendação'],
  ['missing_cost', 'Custo não informado'], ['loss', 'Margem < 15%'], ['between', 'Margem 15%–20%'],
  ['above', 'Margem > 20%'], ['no_stock', 'Sem estoque'], ['blocked', 'Bloqueados'],
  ['pending', 'Alteração pendente'], ['conflict', 'Conflito econômico'], ['incomplete', 'Dados incompletos'],
];

function StatusBadge({ economics }) {
  const status = economics?.repricing_status || (economics ? 'disabled' : 'blocked');
  const styles = {
    eligible: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', confirmed: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    recommendation: 'bg-cyan/10 text-cyan border-cyan/20', pending: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
    submitted: 'bg-violet-500/10 text-violet-400 border-violet-500/20', blocked: 'bg-red-500/10 text-red-400 border-red-500/20',
    failed: 'bg-red-500/10 text-red-400 border-red-500/20', disabled: 'bg-surface-2 text-slate-500 border-surface-3',
  };
  const labels = { eligible: 'Elegível', confirmed: 'Confirmado', recommendation: 'Recomendação', pending: 'Na fila', submitted: 'Enviado', blocked: 'Bloqueado', failed: 'Falhou', disabled: 'Desativado' };
  return <span className={`inline-flex px-2 py-1 rounded-full border text-[10px] font-semibold ${styles[status] || styles.disabled}`}>{labels[status] || status}</span>;
}

function DetailModal({ row, onClose }) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    base44.entities.ProductEconomicsHistory.filter({ product_id: row.product.id }, '-changed_at', 100)
      .then(setHistory).catch(() => setHistory([])).finally(() => setLoading(false));
  }, [row.product.id]);
  const economics = row.econ;
  const candidates = economics?.decision_evidence?.candidates || [];
  const offers = economics?.competitor_offers || [];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
      <div className="w-full max-w-4xl max-h-[92vh] overflow-y-auto rounded-2xl border border-surface-2 bg-surface-1">
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 border-b border-surface-2 bg-surface-1"><div><h2 className="text-sm font-bold text-white">Cálculo, concorrência e histórico</h2><p className="text-xs text-slate-500">{row.product.sku} · {row.product.asin}</p></div><button onClick={onClose} className="text-slate-500 hover:text-white"><X className="w-4 h-4" /></button></div>
        <div className="p-5 space-y-5">
          <section><h3 className="text-xs font-semibold text-slate-300 uppercase mb-2">Decisão reproduzível</h3><div className="grid grid-cols-2 md:grid-cols-5 gap-3">{[
            ['Preço atual', money(economics?.current_price)], ['Piso 15%', money(economics?.minimum_profitable_price)], ['Alvo 20%', money(economics?.target_margin_price)],
            ['Ideal calculado', money(economics?.ideal_suggested_price ?? economics?.suggested_price)], ['Permitido agora', money(economics?.suggested_price)],
            ['Confiança', economics?.decision_confidence == null ? '—' : `${Number(economics.decision_confidence).toFixed(0)}%`], ['Limite restante 24h', money(economics?.remaining_price_change_24h)],
            ['Lucro diário esperado', money(economics?.expected_daily_profit)],
          ].map(([label, value]) => <div key={label} className="rounded-lg bg-surface-2 p-3"><p className="text-[10px] text-slate-500">{label}</p><p className="text-xs font-bold text-slate-200 mt-1">{value}</p></div>)}</div><p className="mt-3 text-xs text-slate-400">{economics?.decision_reason || economics?.repricing_block_reason || 'Ainda não avaliado.'}</p>{economics?.confidence_reason && <p className="mt-2 text-[10px] text-amber-300">{economics.confidence_reason}</p>}</section>
          <section><h3 className="text-xs font-semibold text-slate-300 uppercase mb-2">Preços candidatos</h3>{candidates.length ? <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr className="text-slate-500 border-b border-surface-2"><th className="text-left p-2">Preço</th><th className="text-left p-2">Margem</th><th className="text-left p-2">Lucro/un.</th><th className="text-left p-2">Unidades/dia</th><th className="text-left p-2">Lucro/dia</th><th className="text-left p-2">Origem</th></tr></thead><tbody>{candidates.map((item, index) => <tr key={`${item.price}-${index}`} className="border-b border-surface-2/40"><td className="p-2 text-cyan">{money(item.price)}</td><td className="p-2">{pct(item.marginPct)}</td><td className="p-2">{money(item.unitProfit)}</td><td className="p-2">{item.expectedDailyUnits == null ? 'Sem inferência' : Number(item.expectedDailyUnits).toFixed(2)}</td><td className="p-2">{money(item.expectedDailyProfit)}</td><td className="p-2 text-slate-500">{(item.sources || []).join(', ')}</td></tr>)}</tbody></table></div> : <p className="text-xs text-slate-500">Sem candidatos calculados.</p>}</section>
          <section><h3 className="text-xs font-semibold text-slate-300 uppercase mb-2">Ofertas equivalentes do mesmo ASIN</h3><div className="mb-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[10px] text-amber-300">Sinais competitivos de preço, frete, condição e fulfillment. A Amazon não informa vendas, Ads, conversão, lucro ou estoque exato de sellers concorrentes.</div><div className="grid grid-cols-1 md:grid-cols-3 gap-2">{offers.length ? offers.map((offer, index) => <div key={`${offer.sellerId}-${index}`} className="rounded-lg border border-surface-3 p-3 text-xs"><p className="font-bold text-slate-200">{money(offer.totalPrice)}</p><p className="text-slate-500">{offer.condition || 'New'} · {offer.fulfillmentType || 'n/d'} {offer.isFeatured ? '· Featured Offer' : ''}</p></div>) : <p className="text-xs text-slate-500">Nenhuma oferta equivalente recente disponível.</p>}</div><p className="mt-2 text-[10px] text-slate-600">Fonte: {economics?.competition_source || 'pendente'} · consulta {dateTime(economics?.competition_checked_at)}</p></section>
          <section><h3 className="text-xs font-semibold text-slate-300 uppercase mb-2">Histórico completo</h3>{loading ? <Loader2 className="w-4 h-4 animate-spin text-cyan" /> : <div className="space-y-2">{history.length ? history.map(item => <div key={item.id} className="rounded-lg border border-surface-3 p-3"><div className="flex flex-wrap justify-between gap-2"><span className="text-xs font-semibold text-slate-300">{item.history_type || 'registro'} · {item.status || '—'}</span><span className="text-[10px] text-slate-600">{dateTime(item.changed_at)}</span></div><p className="text-xs text-slate-500 mt-1">{money(item.price_before)} → {money(item.price_after)} · margem {pct(item.margin_before)} → {pct(item.margin_after)}</p><p className="text-[10px] text-slate-500 mt-1">{item.decision_reason || item.reason || 'Sem observação.'}</p></div>) : <p className="text-xs text-slate-500">Sem histórico.</p>}</div>}</section>
        </div>
      </div>
    </div>
  );
}

export default function ProductEconomicsPanel({ accountId }) {
  const [economics, setEconomics] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(new Set());
  const [editTarget, setEditTarget] = useState(null);
  const [detailTarget, setDetailTarget] = useState(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const [economicRows, productRows] = await Promise.all([
        base44.entities.ProductEconomics.filter({ amazon_account_id: accountId }, '-updated_at', 5000),
        base44.entities.Product.filter({ amazon_account_id: accountId }, null, 5000),
      ]);
      setEconomics(economicRows || []);
      setProducts(productRows || []);
    } catch (loadError) {
      setMessage({ type: 'error', text: loadError?.message || 'Falha ao carregar dados econômicos.' });
    } finally { setLoading(false); }
  }, [accountId]);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    const bySku = new Map(economics.map(item => [normSku(item.sku), item]));
    return products.filter(product => product.status !== 'archived').map(product => ({ product, econ: bySku.get(normSku(product.sku)) || null }));
  }, [economics, products]);
  const filtered = useMemo(() => rows.filter(row => {
    const term = search.trim().toLowerCase();
    const product = row.product;
    const economicsRow = row.econ;
    const matchesTerm = !term || [product.sku, product.asin, product.display_name, product.product_name].some(value => String(value || '').toLowerCase().includes(term));
    const stock = Number(product.available_quantity ?? product.fba_inventory ?? 0);
    const matchesFilter = filter === 'all' ||
      (filter === 'enabled' && (economicsRow?.repricing_requested || economicsRow?.repricing_enabled)) ||
      (filter === 'recommendation' && economicsRow?.suggested_price && Math.abs(Number(economicsRow.suggested_price) - Number(economicsRow.current_price)) >= 0.01) ||
      (filter === 'missing_cost' && !economicsRow?.costs_confirmed_by_user) ||
      (filter === 'blocked' && economicsRow?.repricing_status === 'blocked') ||
      (filter === 'incomplete' && !economicsRow?.economic_data_complete) ||
      (filter === 'loss' && Number(economicsRow?.current_margin_pct) < 15) ||
      (filter === 'between' && Number(economicsRow?.current_margin_pct) >= 15 && Number(economicsRow?.current_margin_pct) < 20) ||
      (filter === 'above' && Number(economicsRow?.current_margin_pct) >= 20) ||
      (filter === 'pending' && ['pending', 'submitted'].includes(economicsRow?.repricing_status)) ||
      (filter === 'conflict' && economicsRow?.economic_conflict === true) ||
      (filter === 'no_stock' && stock <= 0);
    return matchesTerm && matchesFilter;
  }), [filter, rows, search]);
  const selectedRows = rows.filter(row => selected.has(row.product.id));

  const run = async (operation, row = null) => {
    const key = `${operation}:${row?.product?.id || 'all'}`;
    setActionLoading(key);
    setMessage(null);
    try {
      const response = await base44.functions.invoke('runAutomaticRepricing', {
        operation, amazon_account_id: accountId, product_id: row?.product?.id,
        max_products: row ? 1 : 100,
      });
      const result = response?.data || response;
      if (!result?.ok) throw new Error(result?.error || 'Falha ao executar repricing.');
      setMessage({ type: 'success', text: operation === 'apply_suggested' ? 'Preço sugerido validado e enviado à fila de confirmação.' : 'Dados reais atualizados e recomendação recalculada.' });
      await load();
    } catch (runError) {
      setMessage({ type: 'error', text: runError?.message || 'Falha ao executar ação.' });
    } finally { setActionLoading(null); }
  };

  const toggle = async row => {
    if (!row.econ?.costs_confirmed_by_user) { setEditTarget(row); return; }
    setActionLoading(`toggle:${row.product.id}`);
    try {
      const economic = row.econ;
      const response = await base44.functions.invoke('importProductEconomics', { amazon_account_id: accountId, items: [{
        sku: row.product.sku, product_name: row.product.display_name || row.product.product_name,
        unit_cost: Number(economic.unit_cost), inbound_freight_per_unit: Number(economic.inbound_freight_per_unit || 0),
        tax_per_unit: Number(economic.tax_per_unit || 0), logistics_cost_per_unit: Number(economic.logistics_cost_per_unit || 0),
        packaging_cost_per_unit: Number(economic.packaging_cost_per_unit || 0), other_variable_cost_per_unit: Number(economic.other_variable_cost_per_unit || 0),
        estimated_return_cost: Number(economic.estimated_return_cost || 0), minimum_margin_pct: Number(economic.minimum_margin_pct || 15),
        target_margin_pct: Number(economic.target_margin_pct || 20), manual_min_price: economic.manual_min_price ?? null,
        manual_max_price: economic.manual_max_price ?? null, repricing_enabled: !(economic.repricing_requested || economic.repricing_enabled),
        reason: 'Alteração do repricing pelo controle da tabela de Produtos.',
      }] });
      const result = response?.data || response;
      if (!result?.ok || result?.error_details?.length) throw new Error(result?.error_details?.[0]?.error || result?.error || 'Falha ao alterar repricing.');
      await load();
    } catch (toggleError) {
      setMessage({ type: 'error', text: toggleError?.message || 'Falha ao alterar repricing.' });
    } finally { setActionLoading(null); }
  };

  const stats = {
    total: rows.length,
    enabled: rows.filter(row => row.econ?.repricing_requested || row.econ?.repricing_enabled).length,
    ready: rows.filter(row => row.econ?.economic_data_complete).length,
    blocked: rows.filter(row => row.econ?.repricing_status === 'blocked').length,
    belowFloor: rows.filter(row => row.econ?.current_margin_pct != null && Number(row.econ.current_margin_pct) < 15).length,
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">{[
        ['Produtos', stats.total, 'text-white'], ['Repricing solicitado', stats.enabled, 'text-cyan'], ['Dados completos', stats.ready, 'text-emerald-400'],
        ['Bloqueados', stats.blocked, stats.blocked ? 'text-amber-400' : 'text-slate-300'], ['Abaixo de 15%', stats.belowFloor, stats.belowFloor ? 'text-red-400' : 'text-slate-300'],
      ].map(([label, value, color]) => <div key={label} className="rounded-xl p-4 border bg-surface-1 border-surface-2"><p className="text-xs text-slate-500">{label}</p><p className={`text-xl font-bold ${color}`}>{value}</p></div>)}</div>

      <div className="rounded-xl border border-cyan/20 bg-cyan/5 px-4 py-3 text-xs text-slate-400"><strong className="text-cyan">Modo inicial seguro:</strong> o motor gera recomendações. Publicação automática só ocorre se a configuração global for alterada, o SKU estiver habilitado e todos os guardrails forem satisfeitos.</div>
      <div className="flex items-center gap-3 flex-wrap"><div className="relative flex-1 min-w-[240px]"><Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="SKU, ASIN ou nome..." className="w-full pl-9 pr-4 py-2 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300" /></div><button onClick={() => run('evaluate')} disabled={Boolean(actionLoading)} className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-300 bg-surface-1 border border-surface-2 rounded-lg disabled:opacity-50">{actionLoading === 'evaluate:all' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}Atualizar dados reais</button></div>
      <div className="flex items-center gap-1.5 flex-wrap">{FILTERS.map(([key, label]) => <button key={key} onClick={() => setFilter(key)} className={`text-xs px-3 py-1.5 rounded-full border ${filter === key ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3'}`}>{label}</button>)}</div>
      {message && <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs border ${message.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}><AlertCircle className="w-3.5 h-3.5" />{message.text}</div>}

      <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
        {selected.size > 0 && <div className="flex items-center gap-3 px-4 py-2.5 bg-cyan/10 border-b border-cyan/20"><span className="text-xs font-semibold text-cyan">{selected.size} selecionado(s)</span><button onClick={() => setBulkOpen(true)} className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-cyan/15 border border-cyan/25 text-cyan rounded-lg"><Layers3 className="w-3 h-3" />Editar em lote</button><button onClick={() => setSelected(new Set())} className="text-xs text-slate-500">Limpar</button></div>}
        {loading ? <div className="flex justify-center py-14"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div> : <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr className="border-b border-surface-2 bg-surface-2/40 text-[10px] uppercase text-slate-500"><th className="p-3"><button onClick={() => setSelected(selected.size === filtered.length ? new Set() : new Set(filtered.map(row => row.product.id)))}>{selected.size === filtered.length && filtered.length ? <CheckSquare className="w-4 h-4 text-cyan" /> : <Square className="w-4 h-4" />}</button></th>{['Produto', 'Custo/un.', 'Preço atual', 'Piso 15%', 'Alvo 20%', 'Sugerido', 'Margem atual', 'Margem projetada', 'Lucro/un.', 'Estoque', 'Featured Offer', 'Concorrência', 'Status', 'Última alteração', 'Próxima avaliação', 'Ações'].map(label => <th key={label} className="text-left p-3 whitespace-nowrap">{label}</th>)}</tr></thead><tbody>{filtered.length ? filtered.map(row => {
          const product = row.product; const economic = row.econ; const stock = Number(product.available_quantity ?? product.fba_inventory ?? 0);
          const marginColor = economic?.current_margin_pct == null ? 'text-slate-500' : Number(economic.current_margin_pct) < 15 ? 'text-red-400' : Number(economic.current_margin_pct) < 20 ? 'text-amber-400' : 'text-emerald-400';
          return <tr key={product.id} className="border-b border-surface-2/40 hover:bg-surface-2/30"><td className="p-3"><button onClick={() => setSelected(current => { const next = new Set(current); if (next.has(product.id)) next.delete(product.id); else next.add(product.id); return next; })}>{selected.has(product.id) ? <CheckSquare className="w-4 h-4 text-cyan" /> : <Square className="w-4 h-4 text-slate-600" />}</button></td><td className="p-3 min-w-[180px]"><p className="font-mono text-cyan">{product.sku}</p><p className="font-mono text-[10px] text-slate-500">{product.asin}</p><p className="max-w-[190px] truncate text-[10px] text-slate-500">{product.display_name || product.product_name}</p></td><td className="p-3 font-semibold text-slate-300">{economic?.costs_confirmed_by_user ? money(economic.unit_cost) : <span className="text-amber-400">Pendente</span>}</td><td className="p-3 text-slate-300">{money(economic?.current_price || product.price)}</td><td className="p-3 text-amber-300">{money(economic?.minimum_profitable_price)}</td><td className="p-3 text-slate-300">{money(economic?.target_margin_price)}</td><td className="p-3 text-cyan font-semibold">{money(economic?.suggested_price)}</td><td className={`p-3 font-semibold ${marginColor}`}>{pct(economic?.current_margin_pct)}</td><td className="p-3 text-slate-300">{pct(economic?.projected_margin_pct)}</td><td className="p-3 text-emerald-400">{money(economic?.projected_unit_profit)}</td><td className={`p-3 ${stock <= 0 ? 'text-red-400' : 'text-slate-300'}`}>{stock}</td><td className="p-3"><p className="text-slate-300">{money(economic?.featured_offer_price)}</p><p className="text-[10px] text-slate-600">FOEP {money(economic?.featured_offer_expected_price)}</p></td><td className="p-3"><p className="text-slate-300">Mediana {money(economic?.competitor_median_price)}</p><p className="text-[10px] text-slate-600">{economic?.competitor_offer_count || 0} equivalentes</p></td><td className="p-3"><StatusBadge economics={economic} />{economic?.economic_conflict && <p className="mt-1 text-[9px] font-semibold text-red-400">Conflito econômico</p>}{economic?.repricing_block_reason && <p title={economic.repricing_block_reason} className="mt-1 max-w-[160px] truncate text-[9px] text-red-400">{economic.repricing_block_reason}</p>}<label className="mt-1 flex items-center gap-1 text-[9px] text-slate-500"><input type="checkbox" checked={Boolean(economic?.repricing_requested || economic?.repricing_enabled)} disabled={actionLoading === `toggle:${product.id}`} onChange={() => toggle(row)} className="accent-cyan" />Repricing</label></td><td className="p-3 text-[10px] text-slate-500">{dateTime(economic?.last_price_change_at)}</td><td className="p-3 text-[10px] text-slate-500">{dateTime(economic?.next_evaluation_at)}</td><td className="p-3"><div className="flex flex-col gap-1"><button onClick={() => setEditTarget(row)} className="inline-flex items-center gap-1 text-[10px] text-cyan"><Edit3 className="w-3 h-3" />Editar custos</button><button onClick={() => run('evaluate', row)} disabled={Boolean(actionLoading)} className="inline-flex items-center gap-1 text-[10px] text-slate-400"><RefreshCw className={`w-3 h-3 ${actionLoading === `evaluate:${product.id}` ? 'animate-spin' : ''}`} />Recalcular</button><button onClick={() => setDetailTarget(row)} className="inline-flex items-center gap-1 text-[10px] text-slate-400"><Eye className="w-3 h-3" />Cálculo / concorrentes / histórico</button><button onClick={() => run('apply_suggested', row)} disabled={!economic?.suggested_price || Boolean(actionLoading)} className="inline-flex items-center gap-1 text-[10px] text-emerald-400 disabled:opacity-30"><Play className="w-3 h-3" />Aplicar sugerido</button></div></td></tr>;
        }) : <tr><td colSpan={17} className="p-10 text-center text-slate-500">Nenhum produto encontrado.</td></tr>}</tbody></table></div>}
      </div>

      {editTarget && <ProductCostEditor product={editTarget.product} economics={editTarget.econ} mode={editTarget.econ ? 'edit' : 'new'} onClose={() => setEditTarget(null)} onSave={() => { setEditTarget(null); load(); }} />}
      {detailTarget && <DetailModal row={detailTarget} onClose={() => setDetailTarget(null)} />}
      {bulkOpen && <BulkProductEconomicsEditor accountId={accountId} rows={selectedRows} onClose={() => setBulkOpen(false)} onSave={() => { setBulkOpen(false); setSelected(new Set()); load(); }} />}
    </div>
  );
}
