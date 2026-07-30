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

  // Column sort: cycle asc â†’ desc â†’ null (reset to dropdown)
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

  // â”€â”€ MULTI-ACCOUNT LOAD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

      // Detectar divergÃªncias: campanhas paused no DB mas amazon_status=enabled
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

      // Enriquecer produtos com contagem de divergÃªncias
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

  // â”€â”€ VISIBILITY + DEDUP (multi-account aware) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      if (!existing) { byAsin.sã7¶‰žËkºwµçE±½…‘¥¹œ€˜˜…½Õ¹Ð€˜˜€ñ!¥¡‘¡•É•¹•±•ÉÐ…½Õ¹Ñ%õí…½Õ¹Ð¹¥‘ô€¼ùô4(4(€€€€€ì…±½…‘¥¹œ€˜˜É•ÍÑ½­•‘AÉ½‘ÕÑÌ¹±•¹Ñ €ø€À€˜˜€ 4(€€€€€€€€ñI•ÍÑ½­•‘±•ÉÐÁÉ½‘ÕÑÌõíÉ•ÍÑ½­•‘AÉ½‘ÕÑÍô…½Õ¹Ðõí…½Õ¹Ñô½¹½¹”õí±½…‘ô€¼ø4(€€€€€€¥ô4(4(€€€€€ì¼¨-A%Ì€¨½ô4(€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰É¥É¥µ½±Ì´È±œéÉ¥µ½±Ì´Ô…À´Ìˆø4(€€€€€€€€ñ-Á¥…É±…‰•°ô‰´ÍÑ½ÅÕ”ˆÙ…±Õ”õí±½…‘¥¹œ€ü€ŸŠPœ€è…Ñ¥Ù•=™™•ÉÍô‘•Ñ…¥°õí€‘í±½ÝMÑ½­ô‰…¥á¼•ÍÑ½ÅÕ•ôÑ½¹”ô‰ÍÕ•ÍÌˆ€¼ø4(€€€€€€€€ñ-Á¥…É±…‰•°ô‰•Í…ÑÕ…±¥é…‘¼ˆÙ…±Õ”õí±½…‘¥¹œ€ü€ŸŠPœ€èÍÑ…±•MÑ½­ô‘•Ñ…¥°ô‰Í¥¹É½¹¥é‡Ÿ¼¹••ÍÏ…É¥„ˆÑ½¹”õíÍÑ…±•MÑ½¬€ø€À€ü€Ý…É¹¥¹œœ€è€‘•™…Õ±Ðô€¼ø4(€€€€€€€€ñ-Á¥…É±…‰•°ô‰‘ÌÑ¥Ù½ÌˆÙ…±Õ”õí±½…‘¥¹œ€ü€ŸŠPœ€è…Ñ¥Ù•‘Íô‘•Ñ…¥°õí€‘íÁ…ÕÍ•‘‘ÍôÁ…ÕÍ…‘½ÍôÑ½¹”ô‰å…¸ˆ€¼ø4(€€€€€€€€ñ-Á¥…É±…‰•°ô‰M•´…µÁ…¹¡„ˆÙ…±Õ”õí±½…‘¥¹œ€ü€ŸŠPœ€èÝ¥Ñ¡½ÕÑ…µÁ…¥¹ô‘•Ñ…¥°õí€‘í•±¥¥‰±•½É-¥­½™™ô•±•ŸµÙ•¥ÌÀ¼-¥¬µ½™™ôÑ½¹”õíÝ¥Ñ¡½ÕÑ…µÁ…¥¸€ø€À€ü€Ý…É¹¥¹œœ€è€‘•™…Õ±Ðô€¼ø4(€€€€€€€€ñ-Á¥…É±…‰•°ô‰A…ÕÍ…‘½ÌÀ¼ÍÑ½ÅÕ”ˆÙ…±Õ”õí±½…‘¥¹œ€ü€ŸŠPœ€èÁ…ÕÍ•‘	åMÑ½­ô‘•Ñ…¥°ô‰Á…ÕÍ„…ÕÑ½·…Ñ¥„…Á±¥…‘„ˆÑ½¹”õíÁ…ÕÍ•‘	åMÑ½¬€ø€À€ü€Ù¥½±•Ðœ€è€‘•™…Õ±Ðô€¼ø4(€€€€€€ð½‘¥Øø4(4(€€€€€ì¼¨	ÕÍ„€¨½ô4(€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™±•à¥Ñ•µÌµ•¹Ñ•È…À´Èˆø4(€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰É•±…Ñ¥Ù”™±•à´Äˆø4(€€€€€€€€€€ñM•…É ±…ÍÍ9…µ”ô‰…‰Í½±ÕÑ”±•™Ð´ÌÑ½À´Ä¼È€µÑÉ…¹Í±…Ñ”µä´Ä¼ÈÜ´Ð ´ÐÑ•áÐµÍ±…Ñ”´ÔÀÀÁ½¥¹Ñ•Èµ•Ù•¹ÑÌµ¹½¹”ˆ€¼ø4(€€€€€€€€€€ñ¥¹ÁÕÐ4(€€€€€€€€€€€Ù…±Õ”õíÍ•…É¡%¹ÁÕÑô4(€€€€€€€€€€€½¹¡…¹”õí”€ôøÍ•ÑM•…É¡%¹ÁÕÐ¡”¹Ñ…É•Ð¹Ù…±Õ”¥ô4(€€€€€€€€€€€½¹-•å½Ý¸õí”€ôøì¥˜€¡”¹­•ä€ôôô€¹Ñ•Èœ¤ìÍ•ÑM•…É ¡Í•…É¡%¹ÁÕÐ¹ÑÉ¥´ ¤¤ìÍ•ÑA…” Ä¤ìôõô4(€€€€€€€€€€€Á±…•¡½±‘•Èô‰	ÕÍ…ÈÁ½ÈM%8°M-T½Ô¹½µ”¸¸¸ˆ4(€€€€€€€€€€€±…ÍÍ9…µ”ô‰Üµ™Õ±°Á°´ÄÀÁÈ´ÐÁä´È¸Ô‰œµÍÕÉ™…”´Ä‰½É‘•È‰½É‘•ÈµÍÕÉ™…”´ÈÉ½Õ¹‘•µ±œÑ•áÐµÍ´Ñ•áÐµÍ±…Ñ”´ÌÀÀÁ±…•¡½±‘•ÈµÍ±…Ñ”´ØÀÀ™½ÕÌé½ÕÑ±¥¹”µ¹½¹”™½ÕÌé‰½É‘•Èµå…¸¼ÔÀˆ4(€€€€€€€€€€¼ø4(€€€€€€€€ð½‘¥Øø4(€€€€€€€€ñ‰ÕÑÑ½¸4(€€€€€€€€€ÑåÁ”ô‰‰ÕÑÑ½¸ˆ4(€€€€€€€€€½¹±¥¬õì ¤€ôøìÍ•ÑM•…É ¡Í•…É¡%¹ÁÕÐ¹ÑÉ¥´ ¤¤ìÍ•ÑA…” Ä¤ìõô4(€€€€€€€€€±…ÍÍ9…µ”ô‰Áà´ÐÁä´È¸Ô‰œµå…¸¼ÄÔ‰½É‘•È‰½É‘•Èµå…¸¼ÌÀÑ•áÐµå…¸Ñ•áÐµÍ´™½¹ÐµÍ•µ¥‰½±É½Õ¹‘•µ±œ¡½Ù•Èé‰œµå…¸¼ÈÔÑÉ…¹Í¥Ñ¥½¸µ½±½ÉÌÝ¡¥Ñ•ÍÁ…”µ¹½ÝÉ…Àˆ4(€€€€€€€€ø4(€€€€€€€€€	ÕÍ…È4(€€€€€€€€ð½‰ÕÑÑ½¸ø4(€€€€€€€íÍ•…É €˜˜€ 4(€€€€€€€€€€ñ‰ÕÑÑ½¸4(€€€€€€€€€€€ÑåÁ”ô‰‰ÕÑÑ½¸ˆ4(€€€€€€€€€€€½¹±¥¬õì ¤€ôøìÍ•ÑM•…É¡%¹ÁÕÐ œœ¤ìÍ•ÑM•…É  œœ¤ìÍ•ÑA…” Ä¤ìõô4(€€€€€€€€€€€±…ÍÍ9…µ”ô‰™±•à¥Ñ•µÌµ•¹Ñ•È…À´ÄÁà´ÌÁä´È¸Ô‰œµÍÕÉ™…”´È‰½É‘•È‰½É‘•ÈµÍÕÉ™…”´ÌÑ•áÐµÍ±…Ñ”´ÐÀÀ¡½Ù•ÈéÑ•áÐµÝ¡¥Ñ”Ñ•áÐµÍ´É½Õ¹‘•µ±œÑÉ…¹Í¥Ñ¥½¸µ½±½ÉÌˆ4(€€€€€€€€€€ø4(€€€€€€€€€€€€ñ`±…ÍÍ9…µ”ô‰Ü´Ì¸Ô ´Ì¸Ôˆ€¼ø4(€€€€€€€€€€ð½‰ÕÑÑ½¸ø4(€€€€€€€€¥ô4(€€€€€€ð½‘¥Øø4(4(€€€€€ì¼¨¥±ÑÉ½Ì€¨½ô4(€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™±•à™±•àµ½°…À´Èˆø4(€€€€€€€íÍ•…É €˜˜€ 4(€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™±•à¥Ñ•µÌµ•¹Ñ•È…À´ÈÑ•áÐµáÌÑ•áÐµÍ±…Ñ”´ÐÀÀˆø4(€€€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”ô‰Áà´È¸ÔÁä´ÄÉ½Õ¹‘•µ™Õ±°‰œµå…¸¼ÄÀ‰½É‘•È‰½É‘•Èµå…¸¼ÈÀÑ•áÐµå…¸™½¹ÐµÍ•µ¥‰½±ˆø4(€€€€€€€€€€€€€í™¥±Ñ•É•¹±•¹Ñ¡ôÁÉ½‘ÕÑ½í™¥±Ñ•É•¹±•¹Ñ €„ôô€Ä€ü€Ìœ€è€œô•¹½¹ÑÉ…‘½í™¥±Ñ•É•¹±•¹Ñ €„ôô€Ä€ü€Ìœ€è€œô4(€€€€€€€€€€€€ð½ÍÁ…¸ø4(€€€€€€€€€€€€ñÍÁ…¸ùÁ…É„€ñÍÁ…¸±…ÍÍ9…µ”ô‰Ñ•áÐµÍ±…Ñ”´ÌÀÀ™½¹Ðµµ•‘¥Õ´ˆø‰íÍ•…É¡ôˆð½ÍÁ…¸øð½ÍÁ…¸ø4(€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€¥ô4(€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™±•à¥Ñ•µÌµ•¹Ñ•È…À´Ä¸Ô™±•àµÝÉ…Àˆø4(€€€€€€€€€€ñ¥±Ñ•È±…ÍÍ9…µ”ô‰Ü´Ì¸Ô ´Ì¸ÔÑ•áÐµÍ±…Ñ”´ÔÀÀ™±•àµÍ¡É¥¹¬´Àˆ€¼ø4(€€€€€€€€€íl4(€€€€€€€€€€€ì­•äè€…±°œ°±…‰•°èQ½‘½Ì€ ‘íÙ¥Í¥‰±•AÉ½‘ÕÑÌ¹±•¹Ñ¡ô¥€ô°4(€€€€€€€€€€€ì­•äè€½™™•É}…Ñ¥Ù”œ°±…‰•°èÍÑ½ÅÕ”=,€ ‘í…Ñ¥Ù•=™™•ÉÍô¥€ô°4(€€€€€€€€€€€ì­•äè€±½Ý}ÍÑ½¬œ°±…‰•°è	…¥á¼ÍÑ½ÅÕ”€ ‘í±½ÝMÑ½­ô¥€ô°4(€€€€€€€€€€€ì­•äè€ÍÑ…±•}ÍÑ½¬œ°±…‰•°è•Í…ÑÕ…±¥é…‘¼€ ‘íÍÑ…±•MÑ½­ô¥€ô°4(€€€€€€€€€€€ì­•äè€…‘Í}…Ñ¥Ù”œ°±…‰•°è‘ÌÑ¥Ù½Ì€ ‘í…Ñ¥Ù•‘Íô¥€ô°4(€€€€€€€€€€€ì­•äè€…‘Í}Á…ÕÍ•œ°±…‰•°è‘ÌA…ÕÍ…‘½Ì€ ‘íÁ…ÕÍ•‘‘Íô¥€ô°4(€€€€€€€€€€€ì­•äè€¹½}…µÁ…¥¸œ°±…‰•°èM•´…µÁ…¹¡„€ ‘íÝ¥Ñ¡½ÕÑ…µÁ…¥¹ô¥€ô°4(€€€€€€€€€€€€¸¸¸¡É•ÍÑ½­•€ø€À€ümì­•äè€É•ÍÑ½­•œ°±…‰•°èƒÂ~RI•…‰…ÍÑ•¥‘½Ì€ ‘íÉ•ÍÑ½­•‘ô¥€õt€èmt¤°4(€€€€€€€€€t¹µ…À¡¥Ñ•´€ôø€ 4(€€€€€€€€€€€€ñ‰ÕÑÑ½¸ÑåÁ”ô‰‰ÕÑÑ½¸ˆ­•äõí¥Ñ•´¹­•åô½¹±¥¬õì ¤€ôøìÍ•Ñ¥±Ñ•È¡¥Ñ•´¹­•ä¤ìÍ•ÑA…” Ä¤ìõô4(€€€€€€€€€€€€€±…ÍÍ9…µ”õíÑ•áÐµáÌÁà´ÌÁä´Ä¸ÔÉ½Õ¹‘•µ™Õ±°‰½É‘•ÈÑÉ…¹Í¥Ñ¥½¸µ½±½ÉÌÝ¡¥Ñ•ÍÁ…”µ¹½ÝÉ…À€‘í™¥±Ñ•È€ôôô¥Ñ•´¹­•ä€ü€‰œµå…¸¼ÈÀÑ•áÐµå…¸‰½É‘•Èµå…¸¼ÌÀœ€è€‰œµÍÕÉ™…”´ÈÑ•áÐµÍ±…Ñ”´ÔÀÀ‰½É‘•ÈµÍÕÉ™…”´Ì¡½Ù•ÈéÑ•áÐµÍ±…Ñ”´ÌÀÀõôø4(€€€€€€€€€€€€€í¥Ñ•´¹±…‰•±ô4(€€€€€€€€€€€€ð½‰ÕÑÑ½¸ø4(€€€€€€€€€€¤¥ô4(€€€€€€€€ð½‘¥Øø4(€€€€€€ð½‘¥Øø4(4(€€€€€í±½…‘¥¹œ€ü€ 4(€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™±•à¥Ñ•µÌµ•¹Ñ•È©ÕÍÑ¥™äµ•¹Ñ•ÈÁä´ÈÀˆøñ1½…‘•ÈÈ±…ÍÍ9…µ”ô‰Ü´Ü ´ÜÑ•áÐµå…¸…¹¥µ…Ñ”µÍÁ¥¸ˆ€¼øð½‘¥Øø4(€€€€€€¤€è€……½Õ¹Ð€ü€ 4(€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™±•à™±•àµ½°¥Ñ•µÌµ•¹Ñ•È©ÕÍÑ¥™äµ•¹Ñ•ÈÁä´ÈÀ…À´ÌÑ•áÐµ•¹Ñ•Èˆø4(€€€€€€€€€€ñA…­…”±…ÍÍ9…µ”ô‰Ü´ÄÈ ´ÄÈÑ•áÐµÍ±…Ñ”´ØÀÀˆ€¼ø4(€€€€€€€€€€ñÀ±…ÍÍ9…µ”ô‰Ñ•áÐµÍ´Ñ•áÐµÍ±…Ñ”´ÐÀÀˆù9•¹¡Õµ„½¹Ñ„µ…é½¸½¹™¥ÕÉ…‘„¸ð½Àø4(€€€€€€€€ð½‘¥Øø4(€€€€€€¤€è™¥±Ñ•É•¹±•¹Ñ €ôôô€À€ü€ 4(€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™±•à™±•àµ½°¥Ñ•µÌµ•¹Ñ•È©ÕÍÑ¥™äµ•¹Ñ•ÈÁä´ÈÀ…À´ÌÑ•áÐµ•¹Ñ•Èˆø4(€€€€€€€€€€ñA…­…”±…ÍÍ9…µ”ô‰Ü´ÄÈ ´ÄÈÑ•áÐµÍ±…Ñ”´ØÀÀˆ€¼ø4(€€€€€€€€€€ñÀ±…ÍÍ9…µ”ô‰Ñ•áÐµÍ´Ñ•áÐµÍ±…Ñ”´ÐÀÀˆùíÁÉ½‘ÕÑÌ¹±•¹Ñ €ôôô€À€ü€M•´ÁÉ½‘ÕÑ½Ì¸á•ÕÑ”Õ´Må¹Œ¹¼…Í¡‰½…É¸œ€è€9•¹¡Õ´ÁÉ½‘ÕÑ¼•¹½¹ÑÉ…‘¼½´•ÍÑ•Ì™¥±ÑÉ½Ì¸ôð½Àø4(€€€€€€€€ð½‘¥Øø4(€€€€€€¤€è€ 4(€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰‰œµÍÕÉ™…”´Ä‰½É‘•È‰½É‘•ÈµÍÕÉ™…”´ÈÉ½Õ¹‘•µá°½Ù•É™±½Üµ¡¥‘‘•¸ˆø4(€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰Áà´ÐÁä´Ì‰½É‘•Èµˆ‰½É‘•ÈµÍÕÉ™…”´È™±•à¥Ñ•µÌµ•¹Ñ•È©ÕÍÑ¥™äµ‰•ÑÝ••¸ˆø4(€€€€€€€€€€€€ñÀ±…ÍÍ9…µ”ô‰Ñ•áÐµáÌÑ•áÐµÍ±…Ñ”´ÔÀÀˆø4(€€€€€€€€€€€€€í™¥±Ñ•É•¹±•¹Ñ¡ôÁÉ½‘ÕÑ½Ìƒ
ÜÃ…¥¹„íÍ…™•A…•ô‘”íÑ½Ñ…±A…•Íô4(€€€€€€€€€€€€€í½±M½ÉÐ€˜˜€ñÍÁ…¸±…ÍÍ9…µ”ô‰µ°´ÈÑ•áÐµå…¸Ñ•áÐµlÄÁÁátˆù½É‘•¹…‘¼Á½È½±Õ¹„ð½ÍÁ…¸ùô4(€€€€€€€€€€€€€íÍ•±•Ñ•‘%‘Ì¹Í¥é”€ø€À€˜˜€ñÍÁ…¸±…ÍÍ9…µ”ô‰µ°´ÈÑ•áÐµå…¸™½¹ÐµÍ•µ¥‰½±ˆùíÍ•±•Ñ•‘%‘Ì¹Í¥é•ôÍ•±•¥½¹…‘½íÍ•±•Ñ•‘%‘Ì¹Í¥é”€ø€Ä€ü€Ìœ€è€œôð½ÍÁ…¸ùô4(€€€€€€€€€€€€ð½Àø4(€€€€€€€€€€€€ñÍ•±•ÐÙ…±Õ”õíÍ½ÉÑ	åô½¹¡…¹”õí”€ôøìÍ•ÑM½ÉÑ	ä¡”¹Ñ…É•Ð¹Ù…±Õ”¤ìÍ•Ñ½±M½ÉÐ¡¹Õ±°¤ìÍ•ÑA…” Ä¤ìõô4(€€€€€€€€€€€€€±…ÍÍ9…µ”ô‰Ñ•áÐµáÌ‰œµÍÕÉ™…”´È‰½É‘•È‰½É‘•ÈµÍÕÉ™…”´ÌÑ•áÐµÍ±…Ñ”´ÌÀÀÉ½Õ¹‘•µ±œÁà´ÈÁä´Ä™½ÕÌé½ÕÑ±¥¹”µ¹½¹”ˆø4(€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰¹•Ý•ÍÐˆù5…¥ÌÉ••¹Ñ•Ìð½½ÁÑ¥½¸ø4(€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰½±‘•ÍÐˆù5…¥Ì…¹Ñ¥…Ìð½½ÁÑ¥½¸ø4(€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰ÍÑ½­}¡¥ ˆù5…¥½È•ÍÑ½ÅÕ”ð½½ÁÑ¥½¸ø4(€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰ÍÑ½­}±½Üˆù5•¹½È•ÍÑ½ÅÕ”ð½½ÁÑ¥½¸ø4(€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰…‘Í}…Ñ¥Ù”ˆù‘Ì…Ñ¥Ù½ÌÁÉ¥µ•¥É¼ð½½ÁÑ¥½¸ø4(€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰¹½}…µÁ…¥¸ˆùM•´…µÁ…¹¡„ÁÉ¥µ•¥É¼ð½½ÁÑ¥½¸ø4(€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰½ÕÑ}½™}ÍÑ½¬ˆùM•´•ÍÑ½ÅÕ”ÁÉ¥µ•¥É¼ð½½ÁÑ¥½¸ø4(€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰±…ÍÑ}ÕÁ‘…Ñ”ˆûi±Ñ¥µ„…ÑÕ…±¥é‡Ÿ¼ð½½ÁÑ¥½¸ø4(€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰¡…µÁ¥½¹ÌˆûÂ~>…µÁ—Õ•Ì€¡Y•¹‘…Ì€¬½L¤ð½½ÁÑ¥½¸ø4(€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰Ñ½Ñ…±}Í…±•Í|ÌÁˆùY•¹‘…Ì€ÌÁð½½ÁÑ¥½¸ø4(€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰Ñ½Ñ…±}ÍÁ•¹‘|ÌÁˆùMÁ•¹€ÌÁð½½ÁÑ¥½¸ø4(€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰ÁÉ¥•}…Ù}¡¥ ˆûÂ~JÀ5…¥½ÈÁÉ—¼·¥‘¥¼ð½½ÁÑ¥½¸ø4(€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰ÁÉ¥•}…Ù}±½ÜˆûÂ~JÀ5•¹½ÈÁÉ—¼·¥‘¥¼ð½½ÁÑ¥½¸ø4(€€€€€€€€€€€€€€ñ½ÁÑ¥½¸Ù…±Õ”ô‰ÁÉ¥•}¹½Ñ}¡•­•ˆùM•´ÁÉ—¼½¹ÍÕ±Ñ…‘¼ð½½ÁÑ¥½¸ø4(€€€€€€€€€€€€ð½Í•±•Ðø4(€€€€€€€€€€ð½‘¥Øø4(4(€€€€€€€€€íÍ•±•Ñ•‘%‘Ì¹Í¥é”€ø€À€˜˜€ 4(€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰Áà´ÐÁä´È¸Ô‰œµå…¸¼ÄÀ‰½É‘•Èµˆ‰½É‘•Èµå…¸¼ÈÀ™±•à¥Ñ•µÌµ•¹Ñ•È…À´Ì™±•àµÝÉ…Àˆø4(€€€€€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”ô‰Ñ•áÐµáÌ™½¹ÐµÍ•µ¥‰½±Ñ•áÐµå…¸ˆùíÍ•±•Ñ•‘%‘Ì¹Í¥é•ôÁÉ½‘ÕÑ½íÍ•±•Ñ•‘%‘Ì¹Í¥é”€ø€Ä€ü€Ìœ€è€œôÍ•±•¥½¹…‘½íÍ•±•Ñ•‘%‘Ì¹Í¥é”€ø€Ä€ü€Ìœ€è€œôð½ÍÁ…¸ø4(€€€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™±•à¥Ñ•µÌµ•¹Ñ•È…À´È™±•àµÝÉ…Àˆø4(€€€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸ÑåÁ”ô‰‰ÕÑÑ½¸ˆ½¹±¥¬õí‰Õ±­A…ÕÍ•ô‘¥Í…‰±•õì„…‰Õ±­Ñ¥½¹1½…‘¥¹ô4(€€€€€€€€€€€€€€€€€±…ÍÍ9…µ”ô‰™±•à¥Ñ•µÌµ•¹Ñ•È…À´Ä¸ÔÁà´ÌÁä´Ä¸ÔÑ•áÐµáÌ™½¹ÐµÍ•µ¥‰½±É½Õ¹‘•µ±œ‰½É‘•È‰œµ…µ‰•È´ÔÀÀ¼ÄÔ‰½É‘•Èµ…µ‰•È´ÔÀÀ¼ÌÀÑ•áÐµ…µ‰•È´ÐÀÀ¡½Ù•Èé‰œµ…µ‰•È´ÔÀÀ¼ÈÔ‘¥Í…‰±•é½Á…¥Ñä´ÔÀÑÉ…¹Í¥Ñ¥½¸µ½±½ÉÌˆø4(€€€€€€€€€€€€€€€€€í‰Õ±­Ñ¥½¹1½…‘¥¹œ€ôôô€Á…ÕÍ”œ€ü€ñ1½…‘•ÈÈ±…ÍÍ9…µ”ô‰Ü´Ì ´Ì…¹¥µ…Ñ”µÍÁ¥¸ˆ€¼ø€è€ñA…ÕÍ”±…ÍÍ9…µ”ô‰Ü´Ì ´Ìˆ€¼ùô4(€€€€€€€€€€€€€€€€€A…ÕÍ…È…µÁ…¹¡…Ì4(€€€€€€€€€€€€€€€€ð½‰ÕÑÑ½¸ø4(€€€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸ÑåÁ”ô‰‰ÕÑÑ½¸ˆ½¹±¥¬õí±•…ÉM•±•Ñ¥½¹ô4(€€€€€€€€€€€€€€€€€±…ÍÍ9…µ”ô‰™±•à¥Ñ•µÌµ•¹Ñ•È…À´ÄÁà´È¸ÔÁä´Ä¸ÔÑ•áÐµáÌÑ•áÐµÍ±…Ñ”´ÐÀÀ¡½Ù•ÈéÑ•áÐµÝ¡¥Ñ”ÑÉ…¹Í¥Ñ¥½¸µ½±½ÉÌˆø4(€€€€€€€€€€€€€€€€€€ñ`±…ÍÍ9…µ”ô‰Ü´Ì ´Ìˆ€¼ù1¥µÁ…ÈÍ•±—Ÿ¼4(€€€€€€€€€€€€€€€€ð½‰ÕÑÑ½¸ø4(€€€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€¥ô4(4(€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰½Ù•É™±½Üµàµ…ÕÑ¼ˆø4(€€€€€€€€€€€€ñÑ…‰±”±…ÍÍ9…µ”ô‰Üµ™Õ±°Ñ•áÐµÍ´ˆø4(€€€€€€€€€€€€€€ñÑ¡•…ø4(€€€€€€€€€€€€€€€€ñÑÈ±…ÍÍ9…µ”ô‰‰½É‘•Èµˆ‰½É‘•ÈµÍÕÉ™…”´È‰œµÍÕÉ™…”´È¼ÐÀˆø4(€€€€€€€€€€€€€€€€€€ñÑ ±…ÍÍ9…µ”ô‰Áà´ÌÁä´ÌÜ´ÄÀˆø4(€€€€€€€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸ÑåÁ”ô‰‰ÕÑÑ½¸ˆ½¹±¥¬õíÑ½±•M•±•Ñ±±ô4(€€€€€€€€€€€€€€€€€€€€€±…ÍÍ9…µ”õíÀ´À¸ÔÉ½Õ¹‘•ÑÉ…¹Í¥Ñ¥½¸µ½±½ÉÌ€‘íÍ•±•Ñ•‘%‘Ì¹Í¥é”€ôôôÁ…¥¹…Ñ•¹±•¹Ñ €˜˜Á…¥¹…Ñ•¹±•¹Ñ €ø€À€ü€Ñ•áÐµå…¸œ€è€Ñ•áÐµÍ±…Ñ”´ØÀÀ¡½Ù•ÈéÑ•áÐµÍ±…Ñ”´ÐÀÀõôø4(€€€€€€€€€€€€€€€€€€€€€íÍ•±•Ñ•‘%‘Ì¹Í¥é”€ôôôÁ…¥¹…Ñ•¹±•¹Ñ €˜˜Á…¥¹…Ñ•¹±•¹Ñ €ø€À€ü€ñ¡•­MÅÕ…É”±…ÍÍ9…µ”ô‰Ü´Ð ´Ðˆ€¼ø€è€ñMÅÕ…É”±…ÍÍ9…µ”ô‰Ü´Ð ´Ðˆ€¼ùô4(€€€€€€€€€€€€€€€€€€€€ð½‰ÕÑÑ½¸ø4(€€€€€€€€€€€€€€€€€€ð½Ñ ø4(€€€€€€€€€€€€€€€€€€ñÑ ±…ÍÍ9…µ”ô‰Áà´ÐÁä´ÌÑ•áÐµ±•™ÐÑ•áÐµáÌ™½¹ÐµÍ•µ¥‰½±Ñ•áÐµÍ±…Ñ”´ÔÀÀÕÁÁ•É…Í”ÑÉ…­¥¹œµÝ¥‘•ÈÝ¡¥Ñ•ÍÁ…”µ¹½ÝÉ…ÀˆùAÉ½‘ÕÑ¼ð½Ñ ø4(€€€€€€€€€€€€€€€€€€ñM½ÉÑQ ±…‰•°ô‰ÍÑ½ÅÕ”ˆ½±-•äô‰ÍÑ½¬ˆ½±M½ÉÐõí½±M½ÉÑô½¹M½ÉÐõí¡…¹‘±•½±M½ÉÑô€¼ø4(€€€€€€€€€€€€€€€€€€ñM½ÉÑQ ±…‰•°ô‰MÑ…ÑÕÌ‘Ìˆ½±-•äô‰…‘Í}ÍÑ…ÑÕÌˆ½±M½ÉÐõí½±M½ÉÑô½¹M½ÉÐõí¡…¹‘±•½±M½ÉÑô€¼ø4(€€€€€€€€€€€€€€€€€€ñM½ÉÑQ ±…‰•°ô‰Y•¹‘…Ì€ÌÁˆ½±-•äô‰Í…±•Ìˆ½±M½ÉÐõí½±M½ÉÑô½¹M½ÉÐõí¡…¹‘±•½±M½ÉÑô€¼ø4(€€€€€€€€€€€€€€€€€€ñM½ÉÑQ ±…‰•°ô‰MÁ•¹€ÌÁˆ½±-•äô‰ÍÁ•¹ˆ½±M½ÉÐõí½±M½ÉÑô½¹M½ÉÐõí¡…¹‘±•½±M½ÉÑô€¼ø4(€€€€€€€€€€€€€€€€€€ñM½ÉÑQ ±…‰•°ô‰½Lˆ½±-•äô‰…½Ìˆ½±M½ÉÐõí½±M½ÉÑô½¹M½ÉÐõí¡…¹‘±•½±M½ÉÑô€¼ø4(€€€€€€€€€€€€€€€€€€ñÑ ±…ÍÍ9…µ”ô‰Áà´ÐÁä´ÌÑ•áÐµ±•™ÐÑ•áÐµáÌ™½¹ÐµÍ•µ¥‰½±Ñ•áÐµÍ±…Ñ”´ÔÀÀÕÁÁ•É…Í”ÑÉ…­¥¹œµÝ¥‘•ÈÝ¡¥Ñ•ÍÁ…”µ¹½ÝÉ…ÀˆùU¹¥ÑÌ€ÌÁð½Ñ ø4(€€€€€€€€€€€€€€€€€€ñÑ ±…ÍÍ9…µ”ô‰Áà´ÐÁä´ÌÑ•áÐµ±•™ÐÑ•áÐµáÌ™½¹ÐµÍ•µ¥‰½±Ñ•áÐµÍ±…Ñ”´ÔÀÀÕÁÁ•É…Í”ÑÉ…­¥¹œµÝ¥‘•ÈÝ¡¥Ñ•ÍÁ…”µ¹½ÝÉ…Àˆø4(€€€€€€€€€€€€€€€€€€€€ñÍÁ…¸Ñ¥Ñ±”ô‰7¥‘¥„°·µ¹¥µ¼”·…á¥µ¼‘…Ì½™•ÉÑ…ÌÃé‰±¥…Ì•¹½¹ÑÉ…‘…ÌÁ…É„•ÍÑ”µ•Íµ¼M%8¹¼µ…É­•ÑÁ±…”…ÑÕ…°¸ˆø4(€€€€€€€€€€€€€€€€€€€€€AÉ—¼µ…é½¸ƒŠä4(€€€€€€€€€€€€€€€€€€€€ð½ÍÁ…¸ø4(€€€€€€€€€€€€€€€€€€ð½Ñ ø4(€€€€€€€€€€€€€€€€€€ñÑ ±…ÍÍ9…µ”ô‰Áà´ÐÁä´ÌÑ•áÐµ±•™ÐÑ•áÐµáÌ™½¹ÐµÍ•µ¥‰½±Ñ•áÐµÍ±…Ñ”´ÔÀÀÕÁÁ•É…Í”ÑÉ…­¥¹œµÝ¥‘•ÈÝ¡¥Ñ•ÍÁ…”µ¹½ÝÉ…ÀˆùŸÕ•Ìð½Ñ ø4(€€€€€€€€€€€€€€€€ð½ÑÈø4(€€€€€€€€€€€€€€ð½Ñ¡•…ø4(€€€€€€€€€€€€€€ñÑ‰½‘äø4(€€€€€€€€€€€€€€€íÁ…¥¹…Ñ•¹µ…À¡ÁÉ½‘ÕÐ€ôø€ 4(€€€€€€€€€€€€€€€€€€ñAÉ½‘ÕÑI½Ü4(€€€€€€€€€€€€€€€€€€€­•äõíÁÉ½‘ÕÐ¹¥‘ô4(€€€€€€€€€€€€€€€€€€€ÁÉ½‘ÕÐõíÁÉ½‘ÕÑô4(€€€€€€€€€€€€€€€€€€€…½Õ¹Ðõí…½Õ¹Ñô4(€€€€€€€€€€€€€€€€€€€½¹Q½±•…µÁ…¥¸õíÑ½±•…µÁ…¥¹ô4(€€€€€€€€€€€€€€€€€€€½¹É¡¥Ù•…µÁ…¥¸õí…É¡¥Ù•…µÁ…¥¹ô4(€€€€€€€€€€€€€€€€€€€½¹-¥­½™˜õí½Á•¹-¥­½™™ô4(€€€€€€€€€€€€€€€€€€€½¹•±•É…Ñ½ÈõíÍ•Ñ•±•É…Ñ½ÉAÉ½‘ÕÑô4(€€€€€€€€€€€€€€€€€€€½¹…¹•±-¥­½™˜õí…¹•±-¥­½™™ô4(€€€€€€€€€€€€€€€€€€€…Ñ¥½¹1½…‘¥¹œõí…Ñ¥½¹1½…‘¥¹ô4(€€€€€€€€€€€€€€€€€€€…µ…é½¹AÉ½Á……Ñ¥¹œõí…µ…é½¹AÉ½Á……Ñ¥¹mÁÉ½‘ÕÐ¹¥‘uô4(€€€€€€€€€€€€€€€€€€€…µ…é½¹I•ÍÕ±Ðõí…µ…é½¹I•ÍÕ±ÑmÁÉ½‘ÕÐ¹¥‘uô4(€€€€€€€€€€€€€€€€€€€Í•±•Ñ•õíÍ•±•Ñ•‘%‘Ì¹¡…Ì¡ÁÉ½‘ÕÐ¹¥¥ô4(€€€€€€€€€€€€€€€€€€€½¹Q½±•M•±•ÐõíÑ½±•M•±•Ñô4(€€€€€€€€€€€€€€€€€€€¥Í½ÕÍ•õí™½ÕÍ•‘AÉ½‘ÕÑ%€ôôôÁÉ½‘ÕÐ¹¥‘ô4(€€€€€€€€€€€€€€€€€€€ÁÉ½‘ÕÑ5•ÍÍ…”õíÁÉ½‘ÕÑ5•ÍÍ…•ÍmÁÉ½‘ÕÐ¹¥‘uô4(€€€€€€€€€€€€€€€€€€€ÍÑÕ­EÕ•Õ•½Õ¹ÐõíÍÑÕ­EÕ•Õ•	åÍ¥¹mMÑÉ¥¹œ¡ÁÉ½‘ÕÐ¹…Í¥¸ñð€œœ¤¹Ñ½UÁÁ•É…Í” ¥tñð€Áô4(€€€€€€€€€€€€€€€€€€€½¹9…µ•UÁ‘…Ñ”õì¡¥°¹…µ”¤€ôøÍ•ÑAÉ½‘ÕÑÌ¡ÕÈ€ôøÕÈ¹µ…À¡¥Ñ•´€ôø¥Ñ•´¹¥€ôôô¥€üì€¸¸¹¥Ñ•´°‘¥ÍÁ±…å}¹…µ”è¹…µ”ô€è¥Ñ•´¤¥ô4(€€€€€€€€€€€€€€€€€€€½¹AÉ¥•UÁ‘…Ñ•õì¡¥°Á…Ñ ¤€ôøÍ•ÑAÉ½‘ÕÑÌ¡ÕÈ€ôøÕÈ¹µ…À¡¥Ñ•´€ôø¥Ñ•´¹¥€ôôô¥€üì€¸¸¹¥Ñ•´°€¸¸¹Á…Ñ ô€è¥Ñ•´¤¥ô4(€€€€€€€€€€€€€€€€€€€‘¥Ù•É•¹•	…‘”õíÁÉ½‘ÕÐ¹}‘¥Ù•É•¹Ñ}½Õ¹Ð€ø€À€ü€ 4(€€€€€€€€€€€€€€€€€€€€€€ñ…µÁ…¥¹¥Ù•É•¹•	…‘”4(€€€€€€€€€€€€€€€€€€€€€€€ÁÉ½‘ÕÐõíÁÉ½‘ÕÑô4(€€€€€€€€€€€€€€€€€€€€€€€…½Õ¹Ñ%õí…½Õ¹Ðü¹¥‘ô4(€€€€€€€€€€€€€€€€€€€€€€€½¹¥á•õì ¤€ôøÍ•ÑAÉ½‘ÕÑÌ¡ÕÈ€ôøÕÈ¹µ…À¡À€ôøÀ¹¥€ôôôÁÉ½‘ÕÐ¹¥€üì€¸¸¹À°}‘¥Ù•É•¹Ñ}½Õ¹Ðè€Àô€èÀ¤¥ô4(€€€€€€€€€€€€€€€€€€€€€€¼ø4(€€€€€€€€€€€€€€€€€€€€¤€è¹Õ±±ô4(€€€€€€€€€€€€€€€€€€¼ø4(€€€€€€€€€€€€€€€€¤¥ô4(€€€€€€€€€€€€€€ð½Ñ‰½‘äø4(€€€€€€€€€€€€ð½Ñ…‰±”ø4(€€€€€€€€€€ð½‘¥Øø4(4(€€€€€€€€€íÑ½Ñ…±A…•Ì€ø€Ä€˜˜€ 4(€€€€€€€€€€€€ñ‘¥Ø±…ÍÍ9…µ”ô‰™±•à¥Ñ•µÌµ•¹Ñ•È©ÕÍÑ¥™äµ•¹Ñ•È…À´ÈÁà´ÐÁä´Ì‰½É‘•ÈµÐ‰½É‘•ÈµÍÕÉ™…”´Èˆø4(€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸ÑåÁ”ô‰‰ÕÑÑ½¸ˆ½¹±¥¬õì ¤€ôøÍ•ÑA…”¡Œ€ôø5…Ñ ¹µ…à Ä°Œ€´€Ä¤¥ô‘¥Í…‰±•õíÍ…™•A…”€ôôô€Åô4(€€€€€€€€€€€€€€€±…ÍÍ9…µ”ô‰Áà´ÌÁä´Ä¸ÔÑ•áÐµáÌÉ½Õ¹‘•µ±œ‰œµÍÕÉ™…”´È‰½É‘•È‰½É‘•ÈµÍÕÉ™…”´ÌÑ•áÐµÍ±…Ñ”´ÐÀÀ¡½Ù•ÈéÑ•áÐµÝ¡¥Ñ”‘¥Í…‰±•é½Á…¥Ñä´ÐÀÑÉ…¹Í¥Ñ¥½¸µ½±½ÉÌˆûŠ@¹Ñ•É¥½Èð½‰ÕÑÑ½¸ø4(€€€€€€€€€€€€€€ñÍÁ…¸±…ÍÍ9…µ”ô‰Ñ•áÐµáÌÑ•áÐµÍ±…Ñ”´ÔÀÀˆùíÍ…™•A…•ô€¼íÑ½Ñ…±A…•Íôð½ÍÁ…¸ø4(€€€€€€€€€€€€€€ñ‰ÕÑÑ½¸ÑåÁ”ô‰‰ÕÑÑ½¸ˆ½¹±¥¬õì ¤€ôøÍ•ÑA…”¡Œ€ôø5…Ñ ¹µ¥¸¡Ñ½Ñ…±A…•Ì°Œ€¬€Ä¤¥ô‘¥Í…‰±•õíÍ…™•A…”€ôôôÑ½Ñ…±A…•Íô4(€€€€€€€€€€€€€€€±…ÍÍ9…µ”ô‰Áà´ÌÁä´Ä¸ÔÑ•áÐµáÌÉ½Õ¹‘•µ±œ‰œµÍÕÉ™…”´È‰½É‘•È‰½É‘•ÈµÍÕÉ™…”´ÌÑ•áÐµÍ±…Ñ”´ÐÀÀ¡½Ù•ÈéÑ•áÐµÝ¡¥Ñ”‘¥Í…‰±•é½Á…¥Ñä´ÐÀÑÉ…¹Í¥Ñ¥½¸µ½±½ÉÌˆùAËÍá¥µ„ƒŠHð½‰ÕÑÑ½¸ø4(€€€€€€€€€€€€ð½‘¥Øø4(€€€€€€€€€€¥ô4(€€€€€€€€ð½‘¥Øø4(€€€€€€¥ô4(4(€€€€€í­¥­½™™AÉ½‘ÕÐ€˜˜­¥­½™™MÑÕ­%Ñ•µÌ€˜˜€ 4(€€€€€€€€ñ-¥­½™™]¥Ñ¡EÕ•Õ•±•…¹5½‘…°4(€€€€€€€€€ÁÉ½‘ÕÐõí­¥­½™™AÉ½‘ÕÑô4(€€€€€€€€€…½Õ¹Ðõí…½Õ¹Ñô4(€€€€€€€€€ÍÑÕ­%Ñ•µÌõí­¥­½™™MÑÕ­%Ñ•µÍô4(€€€€€€€€€½¹±½Í”õì ¤€ôøìÍ•Ñ-¥­½™™AÉ½‘ÕÐ¡¹Õ±°¤ìÍ•Ñ-¥­½™™MÑÕ­%Ñ•µÌ¡¹Õ±°¤ìõô4(€€€€€€€€€½¹½¹”õì ¤€ôøì4(€€€€€€€€€€€½¹ÍÐÁ¥€ô­¥­½™™AÉ½‘ÕÐü¹¥ì4(€€€€€€€€€€€Í•Ñ-¥­½™™AÉ½‘ÕÐ¡¹Õ±°¤ì4(€€€€€€€€€€€Í•Ñ-¥­½™™MÑÕ­%Ñ•µÌ¡¹Õ±°¤ì4(€€€€€€€€€€€¥˜€¡Á¥¤ì4(€€€€€€€€€€€€€Í•ÑAÉ½‘ÕÑ5Íœ¡Á¥°ìÑåÁ”è€ÍÕ•ÍÌœ°Ñ•áÐè€¥±„±¥µÁ„¸9½Ù¼­¥¬µ½™˜…•¹‘…‘¼Á…É„„ÁËÍá¥µ„©…¹•±„¸œô¤ì4(€€€€€€€€€€€€€É•±½…‘AÉ½‘ÕÑÌ ¤¹Ñ¡•¸  ¤€ôøÉ•ÍÑ½É•AÉ½‘ÕÑ½¹Ñ•áÐ¡Á¥¤¤ì4(€€€€€€€€€€€€€¥˜€¡…½Õ¹Ðü¹¥¤±½…‘MÑÕ­EÕ•Õ”¡…½Õ¹Ð¹¥¤ì4(€€€€€€€€€€€ô4(€€€€€€€€€õô4(€€€€€€€€¼ø4(€€€€€€¥ô4(4(€€€€€í­¥­½™™AÉ½‘ÕÐ€˜˜€…­¥­½™™MÑÕ­%Ñ•µÌ€˜˜€ 4(€€€€€€€€ñ-¥­½™™5½‘…°4(€€€€€€€€€ÁÉ½‘ÕÐõí­¥­½™™AÉ½‘ÕÑô4(€€€€€€€€€…½Õ¹Ðõí…½Õ¹Ñô4(€€€€€€€€€½¹±½Í”õì ¤€ôøÍ•Ñ-¥­½™™AÉ½‘ÕÐ¡¹Õ±°¥ô4(€€€€€€€€€½¹½¹”õì ¤€ôøì4(€€€€€€€€€€€½¹ÍÐÁ¥€ô­¥­½™™AÉ½‘ÕÐü¹¥ì4(€€€€€€€€€€€Í•Ñ-¥­½™™AÉ½‘ÕÐ¡¹Õ±°¤ì4(€€€€€€€€€€€¥˜€¡Á¥¤ì4(€€€€€€€€€€€€€Í•ÑAÉ½‘ÕÑ5Íœ¡Á¥°ìÑåÁ”è€ÍÕ•ÍÌœ°Ñ•áÐè€…µÁ…¹¡„•¹Ù¥…‘„Á…É„™¥±„‘„µ…é½¸¸œô¤ì4(€€€€€€€€€€€€€É•±½…‘AÉ½‘ÕÑÌ ¤¹Ñ¡•¸  ¤€ôøÉ•ÍÑ½É•AÉ½‘ÕÑ½¹Ñ•áÐ¡Á¥¤¤ì4(€€€€€€€€€€€ô4(€€€€€€€€€õô4(€€€€€€€€¼ø4(€€€€€€¥ô4(4(€€€€€í…•±•É…Ñ½ÉAÉ½‘ÕÐ€˜˜€ 4(€€€€€€€€ñ•±•É…Ñ½É5½‘…°4(€€€€€€€€€ÁÉ½‘ÕÐõí…•±•É…Ñ½ÉAÉ½‘ÕÑô4(€€€€€€€€€…½Õ¹Ðõí…½Õ¹Ñô4(€€€€€€€€€½¹±½Í”õì ¤€ôøÍ•Ñ•±•É…Ñ½ÉAÉ½‘ÕÐ¡¹Õ±°¥ô4(€€€€€€€€€½¹½¹”õì ¤€ôøì4(€€€€€€€€€€€½¹ÍÐÁ¥€ô…•±•É…Ñ½ÉAÉ½‘ÕÐü¹¥ì4(€€€€€€€€€€€Í•Ñ•±•É…Ñ½ÉAÉ½‘ÕÐ¡¹Õ±°¤ì4(€€€€€€€€€€€¥˜€¡Á¥¤ì4(€€€€€€€€€€€€€Í•ÑAÉ½‘ÕÑ5Íœ¡Á¥°ìÑåÁ”è€ÍÕ•ÍÌœ°Ñ•áÐè€…µÁ…¹¡„É¥…‘„”Ù¥¹Õ±…‘„„•ÍÑ”ÁÉ½‘ÕÑ¼¸œô¤ì4(€€€€€€€€€€€€€É•±½…‘AÉ½‘ÕÑÌ ¤¹Ñ¡•¸  ¤€ôøÉ•ÍÑ½É•AÉ½‘ÕÑ½¹Ñ•áÐ¡Á¥¤¤ì4(€€€€€€€€€€€ô4(€€€€€€€€€õô4(€€€€€€€€¼ø4(€€€€€€¥ô4(€€€€ð½‘¥Øø4(€€¤ì4)ô(