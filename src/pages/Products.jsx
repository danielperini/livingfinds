import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Filter, Loader2, Package, Pause, Rocket, Search, X, Zap, Check, CheckSquare, Square } from 'lucide-react';
import KickoffModal from '@/components/products/KickoffModal';
import AcceleratorModal from '@/components/products/AcceleratorModal';
import RestockedAlert from '@/components/products/RestockedAlert';
import ProductRow, {
  offerStatus, productHasCampaign, isCampaignActiveFn, campaignIdOf,
  isConfirmedOutOfStock, stockFreshness, formatBRL,
} from '@/components/products/ProductRow';

const PAGE_SIZE = 20;

// Ordenação padrão: mais recente primeiro
const DATE_FIELDS = ['created_date', 'created_at', 'first_seen_at', 'imported_at', 'updated_date', 'last_sync_at'];

function sortDateValue(product) {
  for (const f of DATE_FIELDS) {
    const v = product?.[f];
    if (v) return new Date(v).getTime();
  }
  return 0;
}

function applySort(items, sortBy) {
  const arr = [...items];
  switch (sortBy) {
    case 'newest': return arr.sort((a, b) => sortDateValue(b) - sortDateValue(a));
    case 'oldest': return arr.sort((a, b) => sortDateValue(a) - sortDateValue(b));
    case 'stock_high': return arr.sort((a, b) => Number(b.fba_inventory || 0) - Number(a.fba_inventory || 0));
    case 'stock_low': return arr.sort((a, b) => Number(a.fba_inventory || 0) - Number(b.fba_inventory || 0));
    case 'ads_active': return arr.sort((a, b) => (isCampaignActiveFn(b) ? 1 : 0) - (isCampaignActiveFn(a) ? 1 : 0));
    case 'no_campaign': return arr.sort((a, b) => (productHasCampaign(a) ? 1 : 0) - (productHasCampaign(b) ? 1 : 0));
    case 'out_of_stock': return arr.sort((a, b) => (offerStatus(b) === 'out_of_stock' ? 1 : 0) - (offerStatus(a) === 'out_of_stock' ? 1 : 0));
    case 'last_update': return arr.sort((a, b) => {
      const getSync = p => new Date(p.last_sync_at || p.last_catalog_sync_at || p.synced_at || 0).getTime();
      return getSync(b) - getSync(a);
    });
    case 'total_sales_30d': return arr.sort((a, b) => Number(b.total_sales_30d || 0) - Number(a.total_sales_30d || 0));
    case 'total_spend_30d': return arr.sort((a, b) => Number(b.total_spend_30d || 0) - Number(a.total_spend_30d || 0));
    default: return arr.sort((a, b) => sortDateValue(b) - sortDateValue(a));
  }
}

function KpiCard({ label, value, detail, tone = 'default' }) {
  const tones = {
    default: 'bg-surface-1 border-surface-2 text-slate-300',
    success: 'bg-emerald-500/5 border-emerald-500/20 text-emerald-400',
    warning: 'bg-amber-500/5 border-amber-500/20 text-amber-400',
    danger: 'bg-red-500/5 border-red-500/20 text-red-400',
    cyan: 'bg-cyan/5 border-cyan/20 text-cyan',
    violet: 'bg-violet-500/5 border-violet-500/20 text-violet-400',
  };
  return (
    <div className={`rounded-xl p-4 border ${tones[tone]}`}>
      <p className="text-xs text-slate-500 mb-1">{label}</p>
      <p className="text-xl font-bold">{value}</p>
      {detail && <p className="text-xs text-slate-500 mt-0.5">{detail}</p>}
    </div>
  );
}

export default function Products({ externalRefreshTrigger }) {
  const [account, setAccount] = useState(null);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [sortBy, setSortBy] = useState('newest');
  const [page, setPage] = useState(1);
  const [actionLoading, setActionLoading] = useState(null);
  const [actionMsg, setActionMsg] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkActionLoading, setBulkActionLoading] = useState(null);
  const [bulkActivating, setBulkActivating] = useState(false);

  const [kickoffProduct, setKickoffProduct] = useState(null);
  const [acceleratorProduct, setAcceleratorProduct] = useState(null);
  const [focusedProductId, setFocusedProductId] = useState(null);
  const [productMessages, setProductMessages] = useState({}); // {[productId]: {type, text}}

  // Restaura foco no produto após qualquer ação e rola até ele
  const restoreProductContext = useCallback((productId) => {
    setFocusedProductId(productId);
    setTimeout(() => {
      document.querySelector(`[data-product-id="${productId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 200);
  }, []);

  const setProductMsg = useCallback((productId, msg) => {
    setProductMessages(prev => ({ ...prev, [productId]: msg }));
    setTimeout(() => setProductMessages(prev => { const next = { ...prev }; delete next[productId]; return next; }), 8000);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      if (!accounts.length) accounts = await base44.entities.AmazonAccount.list();
      const currentAccount = accounts[0] || null;
      setAccount(currentAccount);
      if (!currentAccount) { setProducts([]); return; }
      const records = await base44.entities.Product.filter({ amazon_account_id: currentAccount.id }, '-created_date', 500);
      setProducts(records || []);
      return { records, currentAccount };
    } catch (error) {
      setActionMsg({ type: 'error', text: error?.message || 'Erro ao carregar produtos.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh externo (ex: kickoff concluído no ProductsScheduled) sem desmontar o componente
  const prevExternalTrigger = useRef(externalRefreshTrigger);
  useEffect(() => {
    if (externalRefreshTrigger !== prevExternalTrigger.current) {
      prevExternalTrigger.current = externalRefreshTrigger;
      reloadProducts();
    }
  }, [externalRefreshTrigger, reloadProducts]);

  // ── Produtos que voltaram ao estoque (reabastecidos) ────────────────────────
  // Detecta via previous_inventory_status = 'out_of_stock' e fba_inventory > 0
  const restockedProducts = useMemo(() =>
    products.filter(p =>
      p.status === 'active' &&
      Number(p.fba_inventory || 0) > 0 &&
      (p.previous_inventory_status === 'out_of_stock' ||
        (p.campaign_status === 'paused' && p.pause_reason?.includes('stock')))
    ),
    [products]
  );

  // ── Filtro permanente: apenas produtos ativos com estoque ────────────────────
  const visibleProducts = useMemo(() =>
    products.filter(p =>
      p.status !== 'inactive' && p.status !== 'archived' &&
      offerStatus(p) !== 'out_of_stock'
    ),
    [products]
  );

  // ── Contadores ──────────────────────────────────────────────────────────────
  const counters = useMemo(() => {
    // "Em Estoque" = com dado fresco E status ativo (excluir desatualizados do contador principal)
    const activeOffers = visibleProducts.filter(p => offerStatus(p) === 'active' && stockFreshness(p) === 'fresh').length;
    const lowStock = visibleProducts.filter(p => offerStatus(p) === 'low_stock' && stockFreshness(p) === 'fresh').length;
    const staleStock = visibleProducts.filter(p => stockFreshness(p) === 'stale').length;
    const unknownStock = visibleProducts.filter(p => stockFreshness(p) === 'unknown').length;
    const activeAds = visibleProducts.filter(p => productHasCampaign(p) && isCampaignActiveFn(p)).length;
    const pausedAds = visibleProducts.filter(p => productHasCampaign(p) && !isCampaignActiveFn(p)).length;
    const withoutCampaign = visibleProducts.filter(p => !productHasCampaign(p)).length;
    const pausedByStock = visibleProducts.filter(p => p.pause_reason === 'out_of_stock_confirmed' || String(p.pause_reason || '').includes('estoque zerado')).length;
    const restocked = products.filter(p => p.status === 'active' && Number(p.fba_inventory || 0) > 0 && (p.previous_inventory_status === 'out_of_stock' || (p.campaign_status === 'paused' && p.pause_reason?.includes('stock')))).length;
    return { activeOffers, lowStock, staleStock, unknownStock, activeAds, pausedAds, withoutCampaign, pausedByStock, restocked };
  }, [products]);

  // ── Filtro + Ordenação ──────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const base = visibleProducts.filter(product => {
      const matchesSearch = !term ||
        String(product?.asin || '').toLowerCase().includes(term) ||
        String(product?.sku || '').toLowerCase().includes(term) ||
        String(product?.product_name || '').toLowerCase().includes(term) ||
        String(product?.display_name || '').toLowerCase().includes(term);
      const hasCampaign = productHasCampaign(product);
      const active = isCampaignActiveFn(product);
      const matchesFilter =
        filter === 'all' ||
        (filter === 'offer_active' && offerStatus(product) === 'active') ||
        (filter === 'low_stock' && offerStatus(product) === 'low_stock') ||
        (filter === 'stale_stock' && stockFreshness(product) === 'stale') ||
        (filter === 'ads_active' && hasCampaign && active) ||
        (filter === 'ads_paused' && hasCampaign && !active) ||
        (filter === 'no_campaign' && !hasCampaign) ||
        (filter === 'paused_by_stock' && (product.pause_reason === 'out_of_stock_confirmed')) ||
        (filter === 'restocked' && Number(product.fba_inventory || 0) > 0 && (product.previous_inventory_status === 'out_of_stock' || (product.campaign_status === 'paused' && product.pause_reason?.includes('stock'))));
      return matchesSearch && matchesFilter;
    });
    return applySort(base, sortBy);
  }, [products, search, filter, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // ── Ações ───────────────────────────────────────────────────────────────────
  const reloadProducts = useCallback(async () => {
    // Usa account do closure; se ainda não carregou, faz load completo
    if (!account) { await load(); return; }
    const records = await base44.entities.Product.filter({ amazon_account_id: account.id }, '-created_date', 500).catch(() => null);
    if (records) setProducts(records);
  }, [account, load]);

  const toggleCampaign = async (product) => {
    const campaignId = campaignIdOf(product);
    if (!account) return;
    const active = isCampaignActiveFn(product);
    setActionLoading(product.id);

    // Atualização otimista imediata — reflete pausa antes da API responder
    if (active) {
      setProducts(cur => cur.map(p =>
        p.id === product.id ? { ...p, campaign_status: 'paused', has_campaign: true } : p
      ));
    }

    try {
      if (active) {
        const payload = { amazon_account_id: account.id };
        if (campaignId) payload.campaign_id = campaignId;
        if (product.asin) payload.asin = product.asin;
        if (product.sku) payload.sku = product.sku;
        const response = await base44.functions.invoke('pauseCampaign', payload);
        if (!response?.data?.ok) throw new Error(response?.data?.error || 'Falha ao pausar campanha');
      } else {
        const agentAction = await base44.entities.AgentAction.create({
          amazon_account_id: account.id, action: 'enable_campaign', asin: product.asin,
          campaign_id: campaignId, reason: 'Ativação manual', evidence: `Produto: ${product.asin}`,
          risk_level: 'medium', requires_approval: false,
        });
        await base44.functions.invoke('executeAgentAction', { action_id: agentAction.id, approve: true });
      }
      setProductMsg(product.id, { type: 'success', text: active ? 'Campanha pausada.' : 'Campanha ativada.' });
      await reloadProducts();
      restoreProductContext(product.id);
    } catch (error) {
      setProductMsg(product.id, { type: 'error', text: error?.message || 'Erro ao alterar campanha.' });
      restoreProductContext(product.id);
    } finally {
      setActionLoading(null);
    }
  };

  const archiveCampaign = async (product) => {
    const campaignId = campaignIdOf(product);
    if (!campaignId || !account) return;
    if (!window.confirm(`Tem certeza que deseja arquivar a campanha de ${product.asin}?`)) return;
    setActionLoading(product.id);
    try {
      const response = await base44.functions.invoke('archiveCampaign', {
        amazon_account_id: account.id, campaign_id: campaignId,
        archive_reason: `Arquivamento manual via interface - ${new Date().toLocaleDateString('pt-BR')}`,
      });
      if (!response?.data?.ok) throw new Error(response?.data?.error || 'Falha ao arquivar campanha.');
      setProductMsg(product.id, { type: 'success', text: 'Campanha arquivada.' });
      await reloadProducts();
      restoreProductContext(product.id);
    } catch (error) {
      setProductMsg(product.id, { type: 'error', text: error?.message || 'Erro ao arquivar campanha.' });
      restoreProductContext(product.id);
    } finally {
      setActionLoading(null);
    }
  };



  // ── Seleção em massa ────────────────────────────────────────────────────────
  const toggleSelect = (id) => setSelectedIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const toggleSelectAll = () => selectedIds.size === paginated.length ? setSelectedIds(new Set()) : setSelectedIds(new Set(paginated.map(p => p.id)));
  const clearSelection = () => setSelectedIds(new Set());
  const selectedProducts = paginated.filter(p => selectedIds.has(p.id));

  const bulkKickoffSelected = async () => {
    if (!account || !selectedProducts.length) return;
    const targets = selectedProducts.filter(p => !productHasCampaign(p) && !isConfirmedOutOfStock(p));
    if (!targets.length) { setActionMsg({ type: 'error', text: 'Nenhum produto elegível (sem estoque bloqueado).' }); setTimeout(() => setActionMsg(null), 5000); return; }
    setBulkActionLoading('kickoff');
    setActionMsg({ type: 'info', text: `Agendando Kick-off para ${targets.length} produtos...` });
    let success = 0, failed = 0;
    for (const product of targets) {
      try {
        const r = await base44.functions.invoke('scheduleProductKickoff', { amazon_account_id: account.id, asin: product.asin, sku: product.sku, product_name: product.product_name, mode: 'auto_plus_four' });
        r?.data?.ok ? success++ : failed++;
      } catch { failed++; }
    }
    setBulkActionLoading(null);
    setActionMsg({ type: success > 0 ? 'success' : 'error', text: `${success} kick-offs agendados${failed > 0 ? ` · ${failed} falharam` : ''}` });
    clearSelection();
    await load();
    setTimeout(() => setActionMsg(null), 10000);
  };

  const bulkPause = async () => {
    if (!account || !selectedProducts.length) return;
    const targets = selectedProducts.filter(p => productHasCampaign(p) && isCampaignActiveFn(p));
    if (!targets.length) { setActionMsg({ type: 'error', text: 'Nenhum produto selecionado com campanha ativa.' }); setTimeout(() => setActionMsg(null), 5000); return; }
    setBulkActionLoading('pause');
    setActionMsg({ type: 'info', text: `Pausando ${targets.length} campanhas...` });
    let success = 0, failed = 0;
    for (const product of targets) {
      try {
        const pausePayload = { amazon_account_id: account.id };
        const cid = campaignIdOf(product);
        if (cid) pausePayload.campaign_id = cid;
        if (product.asin) pausePayload.asin = product.asin;
        if (product.sku) pausePayload.sku = product.sku;
        const r = await base44.functions.invoke('pauseCampaign', pausePayload);
        r?.data?.ok ? success++ : failed++;
      } catch { failed++; }
    }
    setBulkActionLoading(null);
    setActionMsg({ type: success > 0 ? 'success' : 'error', text: `${success} campanhas pausadas${failed > 0 ? ` · ${failed} falharam` : ''}` });
    clearSelection();
    await load();
    setTimeout(() => setActionMsg(null), 10000);
  };

  const bulkKickoff = async () => {
    if (!account) return;
    const targets = filtered.filter(p => !productHasCampaign(p) && !isConfirmedOutOfStock(p));
    if (!targets.length) return;
    setBulkActivating(true);
    setActionMsg({ type: 'info', text: `Criando campanhas para ${targets.length} produtos...` });
    let success = 0, failed = 0;
    for (const product of targets) {
      try {
        const r = await base44.functions.invoke('createAutoCampaignForAsin', { amazon_account_id: account.id, asin: product.asin, sku: product.sku, product_name: product.product_name });
        r?.data?.ok ? success++ : failed++;
      } catch { failed++; }
    }
    setBulkActivating(false);
    setActionMsg({ type: success > 0 ? 'success' : 'error', text: `${success} campanhas criadas${failed > 0 ? ` · ${failed} falharam` : ''}` });
    await load();
    setTimeout(() => setActionMsg(null), 10000);
  };

  const { activeOffers, lowStock, outOfStock, staleStock, unknownStock, activeAds, pausedAds, withoutCampaign, pausedByStock, restocked } = counters;
  const eligibleForKickoff = visibleProducts.filter(p => !productHasCampaign(p) && !isConfirmedOutOfStock(p)).length;

  return (
    <div className="p-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <Package className="w-5 h-5 text-cyan" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Produtos & Ads</h1>
            <p className="text-xs text-slate-400">
              {visibleProducts.length} ASINs ativos · {activeAds} ads ativos · {withoutCampaign} sem campanha · {products.length - visibleProducts.length} ocultos (sem estoque/inativos)
            </p>
          </div>
        </div>

      </div>

      {actionMsg && (
        <div className={`px-4 py-3 rounded-xl border text-sm font-medium ${actionMsg.type === 'success' ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' : actionMsg.type === 'error' ? 'bg-red-400/10 border-red-400/20 text-red-400' : 'bg-cyan/10 border-cyan/20 text-cyan'}`}>
          {actionMsg.text}
        </div>
      )}

      {/* Banner de reabastecimento */}
      {!loading && restockedProducts.length > 0 && (
        <RestockedAlert
          products={restockedProducts}
          account={account}
          onDone={load}
        />
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KpiCard label="Em Estoque" value={loading ? '—' : activeOffers} detail={`${lowStock} baixo estoque`} tone="success" />
        <KpiCard label="Desatualizado" value={loading ? '—' : staleStock} detail="sincronização necessária" tone={staleStock > 0 ? 'warning' : 'default'} />
        <KpiCard label="Ads Ativos" value={loading ? '—' : activeAds} detail={`${pausedAds} pausados`} tone="cyan" />
        <KpiCard label="Sem Campanha" value={loading ? '—' : withoutCampaign} detail={`${eligibleForKickoff} elegíveis p/ Kick-off`} tone={withoutCampaign > 0 ? 'warning' : 'default'} />
        <KpiCard label="Pausados p/ Estoque" value={loading ? '—' : pausedByStock} detail="pausa automática aplicada" tone={pausedByStock > 0 ? 'violet' : 'default'} />
      </div>

      {/* Busca + Filtros */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-shrink-0 sm:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="ASIN, SKU, nome..." className="w-full pl-10 pr-4 py-2.5 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Filter className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
          {[
            { key: 'all', label: `Todos (${visibleProducts.length})` },
            { key: 'offer_active', label: `Estoque OK (${activeOffers})` },
            { key: 'low_stock', label: `Baixo Estoque (${lowStock})` },
            { key: 'stale_stock', label: `Desatualizado (${staleStock})` },
            { key: 'ads_active', label: `Ads Ativos (${activeAds})` },
            { key: 'ads_paused', label: `Ads Pausados (${pausedAds})` },
            { key: 'no_campaign', label: `Sem Campanha (${withoutCampaign})` },
            ...(restocked > 0 ? [{ key: 'restocked', label: `🔄 Reabastecidos (${restocked})` }] : []),
          ].map(item => (
            <button type="button" key={item.key} onClick={() => { setFilter(item.key); setPage(1); }}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors whitespace-nowrap ${filter === item.key ? 'bg-cyan/20 text-cyan border-cyan/30' : 'bg-surface-2 text-slate-500 border-surface-3 hover:text-slate-300'}`}>
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-7 h-7 text-cyan animate-spin" /></div>
      ) : !account ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
          <Package className="w-12 h-12 text-slate-600" />
          <p className="text-sm text-slate-400">Nenhuma conta Amazon configurada.</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-center">
          <Package className="w-12 h-12 text-slate-600" />
          <p className="text-sm text-slate-400">{products.length === 0 ? 'Sem produtos. Execute um Sync no Dashboard.' : 'Nenhum produto encontrado com estes filtros.'}</p>
        </div>
      ) : (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-surface-2 flex items-center justify-between">
            <p className="text-xs text-slate-500">
              {filtered.length} produtos · página {safePage} de {totalPages}
              {selectedIds.size > 0 && <span className="ml-2 text-cyan font-semibold">{selectedIds.size} selecionado{selectedIds.size > 1 ? 's' : ''}</span>}
            </p>
            <select value={sortBy} onChange={e => { setSortBy(e.target.value); setPage(1); }}
              className="text-xs bg-surface-2 border border-surface-3 text-slate-300 rounded-lg px-2 py-1 focus:outline-none">
              <option value="newest">Mais recentes</option>
              <option value="oldest">Mais antigas</option>
              <option value="stock_high">Maior estoque</option>
              <option value="stock_low">Menor estoque</option>
              <option value="ads_active">Ads ativos primeiro</option>
              <option value="no_campaign">Sem campanha primeiro</option>
              <option value="out_of_stock">Sem estoque primeiro</option>
              <option value="last_update">Última atualização</option>
              <option value="total_sales_30d">Vendas 30d</option>
              <option value="total_spend_30d">Spend 30d</option>
            </select>
          </div>

          {selectedIds.size > 0 && (
            <div className="px-4 py-2.5 bg-cyan/10 border-b border-cyan/20 flex items-center gap-3 flex-wrap">
              <span className="text-xs font-semibold text-cyan">{selectedIds.size} produto{selectedIds.size > 1 ? 's' : ''} selecionado{selectedIds.size > 1 ? 's' : ''}</span>
              <div className="flex items-center gap-2 flex-wrap">

                <button type="button" onClick={bulkPause} disabled={!!bulkActionLoading}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border bg-amber-500/15 border-amber-500/30 text-amber-400 hover:bg-amber-500/25 disabled:opacity-50 transition-colors">
                  {bulkActionLoading === 'pause' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Pause className="w-3 h-3" />}
                  Pausar campanhas
                </button>
                <button type="button" onClick={clearSelection}
                  className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-slate-400 hover:text-white transition-colors">
                  <X className="w-3 h-3" />Limpar seleção
                </button>
              </div>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/40">
                  <th className="px-3 py-3 w-10">
                    <button type="button" onClick={toggleSelectAll}
                      className={`p-0.5 rounded transition-colors ${selectedIds.size === paginated.length && paginated.length > 0 ? 'text-cyan' : 'text-slate-600 hover:text-slate-400'}`}>
                      {selectedIds.size === paginated.length && paginated.length > 0 ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                    </button>
                  </th>
                  {['Produto', 'Estoque', 'Status Ads', 'Vendas 30d', 'Spend 30d', 'ACoS', 'Units 30d', 'Ações'].map(heading => (
                    <th key={heading} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paginated.map(product => (
                  <ProductRow
                    key={product.id}
                    product={product}
                    onToggleCampaign={toggleCampaign}
                    onArchiveCampaign={archiveCampaign}
                    onKickoff={setKickoffProduct}
                    onAccelerator={setAcceleratorProduct}
                    actionLoading={actionLoading}
                    selected={selectedIds.has(product.id)}
                    onToggleSelect={toggleSelect}
                    isFocused={focusedProductId === product.id}
                    productMessage={productMessages[product.id]}
                    onNameUpdate={(id, name) => setProducts(cur => cur.map(item => item.id === id ? { ...item, display_name: name } : item))}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 px-4 py-3 border-t border-surface-2">
              <button type="button" onClick={() => setPage(c => Math.max(1, c - 1))} disabled={safePage === 1}
                className="px-3 py-1.5 text-xs rounded-lg bg-surface-2 border border-surface-3 text-slate-400 hover:text-white disabled:opacity-40 transition-colors">← Anterior</button>
              <span className="text-xs text-slate-500">{safePage} / {totalPages}</span>
              <button type="button" onClick={() => setPage(c => Math.min(totalPages, c + 1))} disabled={safePage === totalPages}
                className="px-3 py-1.5 text-xs rounded-lg bg-surface-2 border border-surface-3 text-slate-400 hover:text-white disabled:opacity-40 transition-colors">Próxima →</button>
            </div>
          )}
        </div>
      )}

      {kickoffProduct && (
        <KickoffModal
          product={kickoffProduct}
          account={account}
          onClose={() => setKickoffProduct(null)}
          onDone={() => {
            const pid = kickoffProduct?.id;
            setKickoffProduct(null);
            if (pid) {
              setProductMsg(pid, { type: 'success', text: 'Campanha enviada para fila da Amazon. Este produto continuará aberto para acompanhamento.' });
              reloadProducts().then(() => restoreProductContext(pid));
            }
          }}
        />
      )}
      {acceleratorProduct && (
        <AcceleratorModal
          product={acceleratorProduct}
          account={account}
          onClose={() => setAcceleratorProduct(null)}
          onDone={() => {
            const pid = acceleratorProduct?.id;
            setAcceleratorProduct(null);
            if (pid) {
              setProductMsg(pid, { type: 'success', text: 'Campanha criada e vinculada a este produto.' });
              reloadProducts().then(() => restoreProductContext(pid));
            }
          }}
        />
      )}
    </div>
  );
}