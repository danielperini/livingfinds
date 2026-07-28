import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { ChevronDown, ChevronUp, Filter, Loader2, Package, Pause, Search, X, TrendingUp, CheckSquare, Square } from 'lucide-react';
import { useAmazonPropagation } from '@/hooks/useAmazonPropagation';
import KickoffModal from '@/components/products/KickoffModal';
import KickoffWithQueueCleanModal from '@/components/products/KickoffWithQueueCleanModal';
import AcceleratorModal from '@/components/products/AcceleratorModal';
import RestockedAlert from '@/components/products/RestockedAlert';
import HighAdherenceAlert from '@/components/products/HighAdherenceAlert';
import CampaignDivergenceBadge from '@/components/products/CampaignDivergenceBadge';
import ProductRow, {
  offerStatus, productHasCampaign, isCampaignActiveFn, campaignIdOf,
  isConfirmedOutOfStock, stockFreshness, formatBRL,
} from '@/components/products/ProductRow';

const PAGE_SIZE = 20;

const DATE_FIELDS = ['created_date', 'created_at', 'first_seen_at', 'imported_at', 'updated_date', 'last_sync_at'];

function sortDateValue(product) {
  for (const f of DATE_FIELDS) {
    const v = product?.[f];
    if (v) return new Date(v).getTime();
  }
  return 0;
}

// campaign status order: active > paused > incomplete > no campaign
function campaignSortScore(product) {
  const s = String(product?.campaign_status || '').toLowerCase();
  if (s === 'active' || s === 'enabled') return 0;
  if (s === 'paused') return 1;
  if (s === 'incomplete') return 2;
  return 3;
}

function applySort(items, sortBy, colSort) {
  const arr = [...items];

  // Column click sort takes precedence
  if (colSort?.column) {
    const dir = colSort.direction === 'asc' ? 1 : -1;
    return arr.sort((a, b) => {
      switch (colSort.column) {
        case 'stock':
          return dir * (Number(a.fba_inventory || 0) - Number(b.fba_inventory || 0));
        case 'ads_status':
          return dir * (campaignSortScore(a) - campaignSortScore(b));
        case 'sales':
          return dir * (Number(a.total_sales_30d || 0) - Number(b.total_sales_30d || 0));
        case 'spend':
          return dir * (Number(a.total_spend_30d || 0) - Number(b.total_spend_30d || 0));
        case 'acos':
          return dir * (Number(a.acos || 0) - Number(b.acos || 0));
        default:
          return 0;
      }
    });
  }

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
    case 'price_avg_high': return arr.sort((a, b) => Number(b.market_price_average || 0) - Number(a.market_price_average || 0));
    case 'price_avg_low': return arr.sort((a, b) => {
      const pa = a.market_price_average; const pb = b.market_price_average;
      if (pa == null && pb == null) return 0;
      if (pa == null) return 1; if (pb == null) return -1;
      return pa - pb;
    });
    case 'price_not_checked': return arr.sort((a, b) => {
      const nc = (p) => !p.market_price_status || p.market_price_status === 'not_checked' ? 0 : 1;
      return nc(a) - nc(b);
    });
    case 'champions': return arr.sort((a, b) => {
      const salesA = Number(a.total_sales_30d || 0);
      const salesB = Number(b.total_sales_30d || 0);
      const acosA = Number(a.acos || 0);
      const acosB = Number(b.acos || 0);
      const effA = acosA > 0 ? Math.max(0, 1 - acosA / 100) : 1;
      const effB = acosB > 0 ? Math.max(0, 1 - acosB / 100) : 1;
      return (salesB * effB) - (salesA * effA);
    });
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

// Sortable column header
function SortTh({ label, colKey, colSort, onSort, className = '' }) {
  const active = colSort?.column === colKey;
  const asc = active && colSort?.direction === 'asc';
  const desc = active && colSort?.direction === 'desc';
  return (
    <th
      className={`px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap cursor-pointer select-none hover:text-slate-300 transition-colors ${className}`}
      onClick={() => onSort(colKey)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={active ? 'text-cyan' : 'text-slate-600'}>
          {desc ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}
        </span>
      </span>
    </th>
  );
}

export default function Products({ externalRefreshTrigger }) {
  const [accounts, setAccounts] = useState([]); // all accounts
  const [account, setAccount] = useState(null);  // primary (for actions)
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [sortBy, setSortBy] = useState('champions');
  const [colSort, setColSort] = useState(null); // { column, direction }
  const [page, setPage] = useState(1);
  const [actionLoading, setActionLoading] = useState(null);
  const [actionMsg, setActionMsg] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkActionLoading, setBulkActionLoading] = useState(null);

  const { propagating: amazonPropagating, propagationResult: amazonResult, propagate: amazonPropagate } = useAmazonPropagation();

  const [priceQueryLoading, setPriceQueryLoading] = useState(false);
  const [kickoffProduct, setKickoffProduct] = useState(null);
  const [kickoffStuckItems, setKickoffStuckItems] = useState(null);
  const [stuckQueueByAsin, setStuckQueueByAsin] = useState({});
  const [acceleratorProduct, setAcceleratorProduct] = useState(null);
  const [focusedProductId, setFocusedProductId] = useState(null);
  const [productMessages, setProductMessages] = useState({});

  // Column sort: cycle asc → desc → null (reset to dropdown)
  const handleColSort = useCallback((col) => {
    setColSort(prev => {
      if (!prev || prev.column !== col) return { column: col, direction: 'asc' };
      if (prev.direction === 'asc') return { column: col, direction: 'desc' };
      return null; // reset
    });
    setPage(1);
  }, []);

  const openKickoff = useCallback(async (product) => {
    if (!account || !product?.asin) { setKickoffProduct(product); return; }
    try {
      const stuck = await base44.entities.ProductKickoffQueue.filter({
        amazon_account_id: account.id,
        asin: product.asin,
      }, '-created_date', 50).catch(() => []);
      const stuckActive = stuck.filter(i => ['scheduled', 'processing'].includes(String(i.status || '').toLowerCase()));
      setKickoffProduct(product);
      setKickoffStuckItems(stuckActive.length > 0 ? stuckActive : null);
    } catch {
      setKickoffProduct(product);
      setKickoffStuckItems(null);
    }
  }, [account]);

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

  // ── MULTI-ACCOUNT LOAD ────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      let accs = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      if (!accs.length) accs = await base44.entities.AmazonAccount.list();
      if (!accs.length) { setProducts([]); return; }

      setAccounts(accs);
      const primaryAccount = accs[0];
      setAccount(primaryAccount);

      // Fetch products from ALL accounts in parallel
      const allResults = await Promise.all(
        accs.map(acc => base44.entities.Product.filter({ amazon_account_id: acc.id }, '-created_date', 500).catch(() => []))
      );
      const allProducts = allResults.flat();

      // Detectar divergências: campanhas paused no DB mas amazon_status=enabled
      const allCampaigns = await Promise.all(
        accs.map(acc => base44.entities.Campaign.filter({ amazon_account_id: acc.id }, null, 500).catch(() => []))
      ).then(r => r.flat());

      // Contar divergentes por ASIN
      const divergentByAsin = {};
      for (const c of allCampaigns) {
        const localPaused = String(c.state || c.status || '').toLowerCase() === 'paused';
        const amazonEnabled = String(c.amazon_status || '').toLowerCase() === 'enabled';
        const notArchived = String(c.state || '').toLowerCase() !== 'archived' && !c.archived;
        if (localPaused && amazonEnabled && notArchived && c.asin) {
          divergentByAsin[c.asin] = (divergentByAsin[c.asin] || 0) + 1;
        }
      }

      // Enriquecer produtos com contagem de divergências
      const enriched = allProducts.map(p => ({
        ...p,
        _divergent_count: divergentByAsin[p.asin] || 0,
      }));

      setProducts(enriched);

      // Enrich names in background for products without names
      const needsEnrich = allProducts.filter(p => !p.product_name?.trim() && !p.display_name?.trim());
      if (needsEnrich.length > 0) {
        base44.functions.invoke('enrichProductNames', {
          amazon_account_id: primaryAccount.id,
          limit: 20,
        }).catch(() => {});
      }

      return { currentAccount: primaryAccount };
    } catch (error) {
      setActionMsg({ type: 'error', text: error?.message || 'Erro ao carregar produtos.' });
    } finally {
      setLoading(false);
    }
  }, []);

  const reloadProducts = useCallback(async () => {
    if (!accounts.length) { await load(); return; }
    const allResults = await Promise.all(
      accounts.map(acc => base44.entities.Product.filter({ amazon_account_id: acc.id }, '-created_date', 500).catch(() => []))
    );
    setProducts(allResults.flat());
  }, [accounts, load]);

  const loadStuckQueue = useCallback(async (accountId) => {
    if (!accountId) return;
    const all = await base44.entities.ProductKickoffQueue.filter(
      { amazon_account_id: accountId }, '-created_date', 200
    ).catch(() => []);
    const counts = {};
    for (const item of all) {
      if (!item.asin) continue;
      const s = String(item.status || '').toLowerCase();
      if (s === 'scheduled' || s === 'processing') {
        const asin = String(item.asin).toUpperCase();
        counts[asin] = (counts[asin] || 0) + 1;
      }
    }
    setStuckQueueByAsin(counts);
  }, []);

  useEffect(() => {
    load().then(res => { if (res?.currentAccount?.id) loadStuckQueue(res.currentAccount.id); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const prevExternalTrigger = useRef(externalRefreshTrigger);
  useEffect(() => {
    if (externalRefreshTrigger !== prevExternalTrigger.current) {
      prevExternalTrigger.current = externalRefreshTrigger;
      reloadProducts();
    }
  }, [externalRefreshTrigger, reloadProducts]);

  const restockedProducts = useMemo(() =>
    products.filter(p =>
      p.status === 'active' &&
      Number(p.fba_inventory || 0) > 0 &&
      (p.previous_inventory_status === 'out_of_stock' ||
        (p.campaign_status === 'paused' && p.pause_reason?.includes('stock')))
    ),
    [products]
  );

  // ── VISIBILITY + DEDUP (multi-account aware) ─────────────────────────────
  // First pass: collect max fba_inventory per ASIN across all accounts
  const maxFbaByAsin = useMemo(() => {
    const map = {};
    for (const p of products) {
      const key = p.asin;
      if (!key) continue;
      const fba = Number(p.fba_inventory || 0);
      if (fba > (map[key] || 0)) map[key] = fba;
    }
    return map;
  }, [products]);

  const visibleProducts = useMemo(() => {
    // Include product if ANY record for that ASIN has fba > 0, OR status is not explicitly out_of_stock with fresh data
    const active = products.filter(p => {
      if (p.status === 'inactive' || p.status === 'archived') return false;
      const asinMaxFba = maxFbaByAsin[p.asin] || 0;
      if (asinMaxFba > 0) return true; // at least one account has stock
      return offerStatus(p) !== 'out_of_stock';
    });

    // Dedup by ASIN: priority 1 = highest fba_inventory, priority 2 = most recent last_sync_at
    const byAsin = new Map();
    for (const p of active) {
      const key = p.asin || p.id;
      const existing = byAsin.get(key);
      if (!existing) { byAsin.set(key, p); continue; }
      const newStock = Number(p.fba_inventory || 0);
      const existStock = Number(existing.fba_inventory || 0);
      const newSync = new Date(p.last_sync_at || p.synced_at || 0).getTime();
      const existSync = new Date(existing.last_sync_at || existing.synced_at || 0).getTime();
      if (newStock > existStock || (newStock === existStock && newSync > existSync)) {
        byAsin.set(key, p);
      }
    }
    return Array.from(byAsin.values());
  }, [products, maxFbaByAsin]);

  const counters = useMemo(() => {
    const activeOffers = visibleProducts.filter(p => offerStatus(p) === 'active' && stockFreshness(p) === 'fresh').length;
    const lowStock = visibleProducts.filter(p => offerStatus(p) === 'low_stock' && stockFreshness(p) === 'fresh').length;
    const staleStock = visibleProducts.filter(p => stockFreshness(p) === 'stale').length;
    const activeAds = visibleProducts.filter(p => productHasCampaign(p) && isCampaignActiveFn(p)).length;
    const pausedAds = visibleProducts.filter(p => productHasCampaign(p) && !isCampaignActiveFn(p)).length;
    const withoutCampaign = visibleProducts.filter(p => !productHasCampaign(p)).length;
    const pausedByStock = visibleProducts.filter(p => p.pause_reason === 'out_of_stock_confirmed' || String(p.pause_reason || '').includes('estoque zerado')).length;
    const restocked = products.filter(p => p.status === 'active' && Number(p.fba_inventory || 0) > 0 && (p.previous_inventory_status === 'out_of_stock' || (p.campaign_status === 'paused' && p.pause_reason?.includes('stock')))).length;
    return { activeOffers, lowStock, staleStock, activeAds, pausedAds, withoutCampaign, pausedByStock, restocked };
  }, [products, visibleProducts]);

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
    return applySort(base, sortBy, colSort);
  }, [products, search, filter, sortBy, colSort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // ── Ações ─────────────────────────────────────────────────────────────────
  const toggleCampaign = async (product) => {
    const campaignId = campaignIdOf(product);
    if (!account) return;
    const active = isCampaignActiveFn(product);
    setActionLoading(product.id);
    const optimisticStatus = active ? 'paused' : 'active';
    setProducts(cur => cur.map(p =>
      p.id === product.id ? { ...p, campaign_status: optimisticStatus, has_campaign: true } : p
    ));
    const { ok, classified } = await amazonPropagate(
      product.id,
      active ? 'pause_campaign_user_action' : 'enable_campaign_user_action',
      async () => {
        if (active) {
          const payload = { amazon_account_id: product.amazon_account_id || account.id };
          if (campaignId) payload.campaign_id = campaignId;
          if (product.asin) payload.asin = product.asin;
          if (product.sku) payload.sku = product.sku;
          const response = await base44.functions.invoke('pauseCampaign', payload);
          if (!response?.data?.ok) throw Object.assign(new Error(response?.data?.error || 'Falha ao pausar campanha'), { status: response?.data?.status });
        } else {
          const agentAction = await base44.entities.AgentAction.create({
            amazon_account_id: product.amazon_account_id || account.id, action: 'enable_campaign', asin: product.asin,
            campaign_id: campaignId, reason: 'Ativação manual', evidence: `Produto: ${product.asin}`,
            risk_level: 'medium', requires_approval: false,
          });
          await base44.functions.invoke('executeAgentAction', { action_id: agentAction.id, approve: true });
        }
      },
      {
        amazonAccountId: product.amazon_account_id || account.id,
        actionType: active ? 'pause_campaign' : 'enable_campaign',
        enqueuePayload: { amazon_account_id: product.amazon_account_id || account.id, campaign_id: campaignId, asin: product.asin },
      }
    );
    if (!ok) {
      setProducts(cur => cur.map(p =>
        p.id === product.id ? { ...p, campaign_status: active ? 'active' : 'paused' } : p
      ));
      if (classified?.code === 'auth') {
        setActionMsg({ type: 'error', text: 'Token expirado — reconecte em Configurações' });
        setTimeout(() => setActionMsg(null), 8000);
      }
    } else {
      await reloadProducts();
    }
    restoreProductContext(product.id);
    setActionLoading(null);
  };

  const cancelKickoff = async (product) => {
    if (!account || !product?.asin) return;
    try {
      const queue = await base44.entities.ProductKickoffQueue.filter({
        amazon_account_id: product.amazon_account_id || account.id, asin: product.asin, status: 'scheduled',
      });
      for (const item of queue) {
        await base44.entities.ProductKickoffQueue.update(item.id, { status: 'cancelled' });
      }
      base44.functions.invoke('autoStockCampaignGuard', {
        amazon_account_id: product.amazon_account_id || account.id,
        asin: product.asin,
        trigger: 'kickoff_cancelled_user',
      }).catch(() => {});
      setProductMsg(product.id, { type: 'success', text: 'Solicitação cancelada.' });
      await reloadProducts();
    } catch (e) {
      setProductMsg(product.id, { type: 'error', text: e.message || 'Erro ao cancelar.' });
    }
  };

  const archiveCampaign = async (product) => {
    const campaignId = campaignIdOf(product);
    if (!campaignId || !account) return;
    if (!window.confirm(`Tem certeza que deseja arquivar a campanha de ${product.asin}?`)) return;
    setActionLoading(product.id);
    try {
      const response = await base44.functions.invoke('archiveCampaign', {
        amazon_account_id: product.amazon_account_id || account.id, campaign_id: campaignId,
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

  const toggleSelect = (id) => setSelectedIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  const toggleSelectAll = () => selectedIds.size === paginated.length ? setSelectedIds(new Set()) : setSelectedIds(new Set(paginated.map(p => p.id)));
  const clearSelection = () => setSelectedIds(new Set());
  const selectedProducts = paginated.filter(p => selectedIds.has(p.id));

  const bulkPause = async () => {
    if (!account || !selectedProducts.length) return;
    const targets = selectedProducts.filter(p => productHasCampaign(p) && isCampaignActiveFn(p));
    if (!targets.length) { setActionMsg({ type: 'error', text: 'Nenhum produto selecionado com campanha ativa.' }); setTimeout(() => setActionMsg(null), 5000); return; }
    setBulkActionLoading('pause');
    setActionMsg({ type: 'info', text: `Pausando ${targets.length} campanhas...` });
    let success = 0, failed = 0;
    for (const product of targets) {
      try {
        const pausePayload = { amazon_account_id: product.amazon_account_id || account.id };
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
    await reloadProducts();
    setTimeout(() => setActionMsg(null), 10000);
  };

  const { activeOffers, lowStock, staleStock, activeAds, pausedAds, withoutCampaign, pausedByStock, restocked } = counters;
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
              {visibleProducts.length} ASINs ativos · {activeAds} ads ativos · {withoutCampaign} sem campanha
              {accounts.length > 1 && <span className="text-cyan ml-1">· {accounts.length} contas</span>}
            </p>
          </div>
        </div>
        {account && (
          <button
            type="button"
            disabled={priceQueryLoading}
            onClick={async () => {
              if (!account || priceQueryLoading) return;
              setPriceQueryLoading(true);
              setActionMsg({ type: 'info', text: 'Consultando preço do próximo produto ativo…' });
              try {
                const res = await base44.functions.invoke('refreshProductMarketPrice', {
                  amazon_account_id: account.id,
                  next_active: true,
                  force: false,
                });
                const data = res?.data || res;
                if (data?.cache_hit) {
                  setActionMsg({ type: 'info', text: `Cache válido para ${data.asin}. ${data.message}` });
                } else if (data?.ok && data?.status === 'success') {
                  setActionMsg({ type: 'success', text: `✓ ${data.asin} · ${data.provider} · R$ ${data.average} · ${data.offer_count} ofertas` });
                  await reloadProducts();
                } else {
                  setActionMsg({ type: 'error', text: data?.message || data?.error || 'Sem resultado' });
                }
              } catch (e) {
                setActionMsg({ type: 'error', text: e?.message || 'Erro ao consultar preço' });
              } finally {
                setPriceQueryLoading(false);
                setTimeout(() => setActionMsg(null), 12000);
              }
            }}
            className="flex items-center gap-2 px-3 py-2 bg-violet-500/15 border border-violet-500/30 text-violet-300 hover:bg-violet-500/25 text-xs font-semibold rounded-lg disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            {priceQueryLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <TrendingUp className="w-3.5 h-3.5" />}
            Consultar próximo ativo
          </button>
        )}
      </div>

      {actionMsg && (
        <div className={`px-4 py-3 rounded-xl border text-sm font-medium ${actionMsg.type === 'success' ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' : actionMsg.type === 'error' ? 'bg-red-400/10 border-red-400/20 text-red-400' : 'bg-cyan/10 border-cyan/20 text-cyan'}`}>
          {actionMsg.text}
        </div>
      )}

      {!loading && account && <HighAdherenceAlert accountId={account.id} />}

      {!loading && restockedProducts.length > 0 && (
        <RestockedAlert products={restockedProducts} account={account} onDone={load} />
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KpiCard label="Em Estoque" value={loading ? '—' : activeOffers} detail={`${lowStock} baixo estoque`} tone="success" />
        <KpiCard label="Desatualizado" value={loading ? '—' : staleStock} detail="sincronização necessária" tone={staleStock > 0 ? 'warning' : 'default'} />
        <KpiCard label="Ads Ativos" value={loading ? '—' : activeAds} detail={`${pausedAds} pausados`} tone="cyan" />
        <KpiCard label="Sem Campanha" value={loading ? '—' : withoutCampaign} detail={`${eligibleForKickoff} elegíveis p/ Kick-off`} tone={withoutCampaign > 0 ? 'warning' : 'default'} />
        <KpiCard label="Pausados p/ Estoque" value={loading ? '—' : pausedByStock} detail="pausa automática aplicada" tone={pausedByStock > 0 ? 'violet' : 'default'} />
      </div>

      {/* Busca */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
          <input
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { setSearch(searchInput.trim()); setPage(1); } }}
            placeholder="Buscar por ASIN, SKU ou nome..."
            className="w-full pl-10 pr-4 py-2.5 bg-surface-1 border border-surface-2 rounded-lg text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50"
          />
        </div>
        <button
          type="button"
          onClick={() => { setSearch(searchInput.trim()); setPage(1); }}
          className="px-4 py-2.5 bg-cyan/15 border border-cyan/30 text-cyan text-sm font-semibold rounded-lg hover:bg-cyan/25 transition-colors whitespace-nowrap"
        >
          Buscar
        </button>
        {search && (
          <button
            type="button"
            onClick={() => { setSearchInput(''); setSearch(''); setPage(1); }}
            className="flex items-center gap-1 px-3 py-2.5 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white text-sm rounded-lg transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Filtros */}
      <div className="flex flex-col gap-2">
        {search && (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="px-2.5 py-1 rounded-full bg-cyan/10 border border-cyan/20 text-cyan font-semibold">
              {filtered.length} produto{filtered.length !== 1 ? 's' : ''} encontrado{filtered.length !== 1 ? 's' : ''}
            </span>
            <span>para <span className="text-slate-300 font-medium">"{search}"</span></span>
          </div>
        )}
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
              {colSort && <span className="ml-2 text-cyan text-[10px]">ordenado por coluna</span>}
              {selectedIds.size > 0 && <span className="ml-2 text-cyan font-semibold">{selectedIds.size} selecionado{selectedIds.size > 1 ? 's' : ''}</span>}
            </p>
            <select value={sortBy} onChange={e => { setSortBy(e.target.value); setColSort(null); setPage(1); }}
              className="text-xs bg-surface-2 border border-surface-3 text-slate-300 rounded-lg px-2 py-1 focus:outline-none">
              <option value="newest">Mais recentes</option>
              <option value="oldest">Mais antigas</option>
              <option value="stock_high">Maior estoque</option>
              <option value="stock_low">Menor estoque</option>
              <option value="ads_active">Ads ativos primeiro</option>
              <option value="no_campaign">Sem campanha primeiro</option>
              <option value="out_of_stock">Sem estoque primeiro</option>
              <option value="last_update">Última atualização</option>
              <option value="champions">🏆 Campeões (Vendas + ACoS)</option>
              <option value="total_sales_30d">Vendas 30d</option>
              <option value="total_spend_30d">Spend 30d</option>
              <option value="price_avg_high">💰 Maior preço médio</option>
              <option value="price_avg_low">💰 Menor preço médio</option>
              <option value="price_not_checked">Sem preço consultado</option>
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
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Produto</th>
                  <SortTh label="Estoque" colKey="stock" colSort={colSort} onSort={handleColSort} />
                  <SortTh label="Status Ads" colKey="ads_status" colSort={colSort} onSort={handleColSort} />
                  <SortTh label="Vendas 30d" colKey="sales" colSort={colSort} onSort={handleColSort} />
                  <SortTh label="Spend 30d" colKey="spend" colSort={colSort} onSort={handleColSort} />
                  <SortTh label="ACoS" colKey="acos" colSort={colSort} onSort={handleColSort} />
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Units 30d</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">
                    <span title="Média, mínimo e máximo das ofertas públicas encontradas para este mesmo ASIN no marketplace atual.">
                      Preço Amazon ℹ
                    </span>
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Ações</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map(product => (
                  <ProductRow
                    key={product.id}
                    product={product}
                    account={account}
                    onToggleCampaign={toggleCampaign}
                    onArchiveCampaign={archiveCampaign}
                    onKickoff={openKickoff}
                    onAccelerator={setAcceleratorProduct}
                    onCancelKickoff={cancelKickoff}
                    actionLoading={actionLoading}
                    amazonPropagating={amazonPropagating[product.id]}
                    amazonResult={amazonResult[product.id]}
                    selected={selectedIds.has(product.id)}
                    onToggleSelect={toggleSelect}
                    isFocused={focusedProductId === product.id}
                    productMessage={productMessages[product.id]}
                    stuckQueueCount={stuckQueueByAsin[String(product.asin || '').toUpperCase()] || 0}
                    onNameUpdate={(id, name) => setProducts(cur => cur.map(item => item.id === id ? { ...item, display_name: name } : item))}
                    onPriceUpdated={(id, patch) => setProducts(cur => cur.map(item => item.id === id ? { ...item, ...patch } : item))}
                    divergenceBadge={product._divergent_count > 0 ? (
                      <CampaignDivergenceBadge
                        product={product}
                        accountId={account?.id}
                        onFixed={() => setProducts(cur => cur.map(p => p.id === product.id ? { ...p, _divergent_count: 0 } : p))}
                      />
                    ) : null}
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

      {kickoffProduct && kickoffStuckItems && (
        <KickoffWithQueueCleanModal
          product={kickoffProduct}
          account={account}
          stuckItems={kickoffStuckItems}
          onClose={() => { setKickoffProduct(null); setKickoffStuckItems(null); }}
          onDone={() => {
            const pid = kickoffProduct?.id;
            setKickoffProduct(null);
            setKickoffStuckItems(null);
            if (pid) {
              setProductMsg(pid, { type: 'success', text: 'Fila limpa. Novo kick-off agendado para a próxima janela.' });
              reloadProducts().then(() => restoreProductContext(pid));
              if (account?.id) loadStuckQueue(account.id);
            }
          }}
        />
      )}

      {kickoffProduct && !kickoffStuckItems && (
        <KickoffModal
          product={kickoffProduct}
          account={account}
          onClose={() => setKickoffProduct(null)}
          onDone={() => {
            const pid = kickoffProduct?.id;
            setKickoffProduct(null);
            if (pid) {
              setProductMsg(pid, { type: 'success', text: 'Campanha enviada para fila da Amazon.' });
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