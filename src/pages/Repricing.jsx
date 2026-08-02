import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
  Tag,
  Upload,
  X,
} from 'lucide-react';
import { base44 } from '@/api/base44Client';

const finiteNumber = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

const money = value => finiteNumber(value)
  ? Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  : '—';

const brazilDay = (value = Date.now()) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const normalizeSku = value => String(value || '').trim().toUpperCase().replace(/\s+/g, '-').replace(/-{2,}/g, '-');

const isOperationalConfirmation = item => item.history_type === 'price_confirmed'
  && item.status === 'confirmed'
  && finiteNumber(item.price_before) && Number(item.price_before) > 0
  && finiteNumber(item.price_after) && Number(item.price_after) > 0
  && Math.abs(Number(item.price_after) - Number(item.price_before)) >= 0.01
  && item.amazon_response != null;

const time = value => value
  ? new Date(value).toLocaleTimeString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  : '—';

const sourceLabel = source => {
  if (source === 'automatic_repricing') return 'Motor / IA';
  if (source === 'manual_suggested_price') return 'Aplicação manual';
  return source || 'Origem não registrada';
};

function percentChange(before, after) {
  const oldPrice = Number(before);
  const newPrice = Number(after);
  if (!(oldPrice > 0) || !Number.isFinite(newPrice)) return null;
  return ((newPrice - oldPrice) / oldPrice) * 100;
}

function Stat({ label, value, detail, tone = 'slate' }) {
  const tones = {
    slate: 'border-surface-2 bg-surface-1 text-slate-200',
    cyan: 'border-cyan/20 bg-cyan/5 text-cyan',
    green: 'border-emerald-500/20 bg-emerald-500/5 text-emerald-400',
    red: 'border-red-500/20 bg-red-500/5 text-red-400',
  };
  return <div className={`rounded-xl border p-4 ${tones[tone]}`}><p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p><p className="mt-1 text-xl font-bold">{value}</p>{detail && <p className="mt-1 text-[10px] text-slate-500">{detail}</p>}</div>;
}

function CompetitorModal({ row, onClose }) {
  if (!row) return null;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <div className="max-h-[88vh] w-full max-w-5xl overflow-hidden rounded-xl border border-violet-500/30 bg-surface-1 shadow-2xl">
      <div className="flex items-start justify-between gap-4 border-b border-surface-2 p-4"><div><h3 className="text-sm font-semibold text-violet-300">Concorrentes identificados — {row.sku}</h3><p className="mt-1 text-xs text-slate-400">{row.title}</p><p className="mt-1 text-[10px] text-slate-600">Até 10 genéricos equivalentes pesquisados pelo ScrapingBee · dados agregados e inferidos</p></div><button type="button" onClick={onClose} className="rounded-lg border border-surface-3 p-2 text-slate-400 hover:text-white"><X className="h-4 w-4" /></button></div>
      <div className="grid grid-cols-3 gap-3 border-b border-surface-2 p-4"><Stat label="Preço médio" value={money(row.similar_competitor_average)} tone="cyan" /><Stat label="Preço mínimo" value={money(row.similar_competitor_minimum)} tone="green" /><Stat label="Preço máximo" value={money(row.similar_competitor_maximum)} /></div>
      <div className="max-h-[58vh] overflow-auto"><table className="w-full text-xs"><thead className="sticky top-0 bg-surface-2 text-left text-[10px] uppercase text-slate-500"><tr>{['#', 'ASIN', 'Produto', 'Preço', 'Similaridade', 'Posição', 'Amazon'].map(label => <th key={label} className="whitespace-nowrap px-4 py-3">{label}</th>)}</tr></thead><tbody>{row.similar_products.map((item, index) => <tr key={`${item.asin}-${index}`} className="border-t border-surface-2/60"><td className="px-4 py-3 text-slate-600">{index + 1}</td><td className="whitespace-nowrap px-4 py-3 font-mono text-cyan">{item.asin}</td><td className="min-w-[320px] max-w-[520px] px-4 py-3 text-slate-300"><p className="line-clamp-2">{item.title}</p><p className="mt-1 text-[9px] text-slate-600">{item.brand || 'Genérico'}{item.sponsored ? ' · patrocinado' : ''}</p></td><td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-200">{money(item.averagePrice)}</td><td className="whitespace-nowrap px-4 py-3 text-emerald-400">{Math.round(Number(item.similarity || 0) * 100)}/100</td><td className="whitespace-nowrap px-4 py-3 text-slate-500">{item.organic_position || '—'}</td><td className="px-4 py-3"><a href={item.amazonUrl || `https://www.amazon.com.br/dp/${item.asin}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-cyan hover:underline">Abrir <ExternalLink className="h-3 w-3" /></a></td></tr>)}</tbody></table>{!row.similar_products.length && <p className="p-8 text-center text-xs text-slate-500">Nenhum concorrente equivalente válido nesta consulta.</p>}</div>
    </div>
  </div>;
}

export default function Repricing() {
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState('');
  const [selectedDate, setSelectedDate] = useState(brazilDay());
  const [history, setHistory] = useState([]);
  const [products, setProducts] = useState([]);
  const [economics, setEconomics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [syncingSkus, setSyncingSkus] = useState(false);
  const [skuSyncResult, setSkuSyncResult] = useState(null);
  const [executingPrices, setExecutingPrices] = useState(false);
  const [priceExecutionResult, setPriceExecutionResult] = useState(null);
  const [skuSort, setSkuSort] = useState({ key: 'status', direction: 'asc' });
  const [historySort, setHistorySort] = useState({ key: 'changed_at', direction: 'desc' });
  const [connection, setConnection] = useState(null);
  const [importingCosts, setImportingCosts] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('all');
  const [showAudit, setShowAudit] = useState(false);
  const [selectedCompetitors, setSelectedCompetitors] = useState(null);
  const costFileRef = useRef(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const me = await base44.auth.me();
        let rows = await base44.entities.AmazonAccount.filter({ user_id: me.id }).catch(() => []);
        if (!rows.length) rows = await base44.entities.AmazonAccount.filter({ status: 'connected' }).catch(() => []);
        if (!rows.length) rows = await base44.entities.AmazonAccount.list('-updated_date', 100).catch(() => []);
        if (!active) return;
        setAccounts(rows);
        setAccountId(rows[0]?.id || '');
        if (!rows.length) setLoading(false);
      } catch (loadError) {
        if (!active) return;
        setError(loadError?.message || 'Não foi possível carregar as contas Amazon.');
        setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setError('');
    try {
      const [historyRows, productRows, economicsRows] = await Promise.all([
        base44.entities.ProductEconomicsHistory.filter(
          { amazon_account_id: accountId },
          '-changed_at',
          2000,
        ),
        base44.entities.Product.filter({ amazon_account_id: accountId }, '-updated_date', 5000),
        base44.entities.ProductEconomics.filter({ amazon_account_id: accountId }, '-updated_at', 5000),
      ]);
      setHistory(historyRows || []);
      setProducts(productRows || []);
      setEconomics(economicsRows || []);
    } catch (loadError) {
      setError(loadError?.message || 'Não foi possível carregar o histórico confirmado de preços.');
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => { load(); }, [load]);

  const checkAmazonConnection = async () => {
    if (!accountId) return;
    setCheckingConnection(true);
    setError('');
    try {
      const response = await base44.functions.invoke('runAutomaticRepricing', {
        operation: 'connection_check',
        amazon_account_id: accountId,
      });
      const result = response?.data || response;
      if (!result?.ok) throw new Error(result?.error || 'Falha ao verificar a Amazon SP-API.');
      setConnection(result.results?.[0] || null);
    } catch (connectionError) {
      setConnection({ connected: false, message: connectionError?.message || 'Falha ao verificar a Amazon SP-API.' });
    } finally {
      setCheckingConnection(false);
    }
  };

  const refreshAllSkus = async () => {
    if (!accountId) return;
    setSyncingSkus(true);
    setSkuSyncResult(null);
    setError('');
    try {
      const response = await base44.functions.invoke('syncProductCatalogV2', {
        amazon_account_id: accountId,
        trigger_type: 'repricing_full_sku_refresh',
      });
      const result = response?.data || response;
      if (!result?.ok) throw new Error(result?.error || 'Falha ao sincronizar SKUs pela FBA Inventory API.');
      const namesResponse = await base44.functions.invoke('enrichProductNames', {
        amazon_account_id: accountId,
        force_all: true,
      });
      const names = namesResponse?.data || namesResponse;
      const listingsResponse = await base44.functions.invoke('syncListingEnhancementData', {
        amazon_account_id: accountId,
        limit: 500,
        basic_only: true,
      });
      const listings = listingsResponse?.data || listingsResponse;
      setSkuSyncResult({ ...result, names, listings });
      await load();
    } catch (syncError) {
      setError(syncError?.message || 'Falha ao atualizar a lista completa de SKUs.');
    } finally {
      setSyncingSkus(false);
    }
  };

  const executePlannedPrices = async () => {
    if (!accountId || !window.confirm('Executar agora os preços planejados elegíveis? O motor consultará a Amazon novamente e poderá alterar preços reais, respeitando margem, confiança e o teto móvel de R$ 2 por SKU/24h.')) return;
    setExecutingPrices(true);
    setPriceExecutionResult(null);
    setError('');
    try {
      const evaluationResponse = await base44.functions.invoke('runAutomaticRepricing', {
        operation: 'execute_planned',
        amazon_account_id: accountId,
        confirm_execute_planned: true,
      });
      const evaluationPayload = evaluationResponse?.data || evaluationResponse;
      if (!evaluationPayload?.ok) throw new Error(evaluationPayload?.error || 'Falha na avaliação dos preços planejados.');
      const evaluation = evaluationPayload.results?.[0] || {};
      let processing = { processed: 0, results: [] };
      let reconciliation = { processed: 0, results: [] };
      if (Number(evaluation.queued || 0) > 0) {
        const processingResponse = await base44.functions.invoke('runAutomaticRepricing', {
          operation: 'process_queue',
          amazon_account_id: accountId,
          max_actions: 20,
        });
        const processingPayload = processingResponse?.data || processingResponse;
        if (!processingPayload?.ok) throw new Error(processingPayload?.error || 'Falha ao publicar a fila de preços.');
        processing = processingPayload.results?.[0] || processing;
        const reconciliationResponse = await base44.functions.invoke('runAutomaticRepricing', {
          operation: 'reconcile',
          amazon_account_id: accountId,
          max_actions: 20,
        });
        const reconciliationPayload = reconciliationResponse?.data || reconciliationResponse;
        reconciliation = reconciliationPayload?.results?.[0] || reconciliation;
      }
      setPriceExecutionResult({ evaluation, processing, reconciliation });
      setSelectedDate(brazilDay());
      await load();
    } catch (executionError) {
      setError(executionError?.message || 'Falha ao executar os preços planejados.');
    } finally {
      setExecutingPrices(false);
    }
  };

  const importCostSpreadsheet = async event => {
    const file = event.target.files?.[0];
    if (!file || !accountId) return;
    setImportingCosts(true);
    setImportResult(null);
    setError('');
    try {
      const upload = await base44.integrations.Core.UploadFile({ file });
      const response = await base44.functions.invoke('importProductEconomics', {
        amazon_account_id: accountId,
        file_url: upload.file_url,
        original_file_name: file.name,
        enable_repricing_for_active: true,
        run_decision_engine: true,
        refresh_amazon_status: true,
      });
      const result = response?.data || response;
      if (!result?.ok) throw new Error(result?.error || 'Falha ao importar custos.');
      setImportResult(result);
      await load();
    } catch (importError) {
      setError(importError?.message || 'Falha ao importar a planilha de custos.');
    } finally {
      setImportingCosts(false);
      if (costFileRef.current) costFileRef.current.value = '';
    }
  };

  const productIndex = useMemo(() => {
    const map = new Map();
    for (const product of products) {
      if (product.id) map.set(`id:${product.id}`, product);
      if (product.sku) map.set(`sku:${normalizeSku(product.sku)}`, product);
      if (product.asin) map.set(`asin:${String(product.asin).trim().toUpperCase()}`, product);
    }
    return map;
  }, [products]);

  const rows = useMemo(() => {
    const seen = new Set();
    return history
    .filter(item => brazilDay(item.changed_at) === selectedDate)
    .filter(isOperationalConfirmation)
    .filter(item => {
      const key = normalizeSku(item.normalized_sku || item.sku || item.asin || item.product_id || item.id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(item => {
      const product = productIndex.get(`id:${item.product_id}`) ||
        productIndex.get(`sku:${normalizeSku(item.sku)}`) ||
        productIndex.get(`asin:${String(item.asin || '').trim().toUpperCase()}`) || {};
      const evidence = item.decision_evidence || {};
      const minimumProfitablePrice = finiteNumber(item.minimum_profitable_price)
        ? Number(item.minimum_profitable_price)
        : null;
      const calculatedRecommendation = finiteNumber(evidence.guarded_suggested_price)
        ? Number(evidence.guarded_suggested_price)
        : finiteNumber(evidence.ideal_suggested_price)
          ? Number(evidence.ideal_suggested_price)
          : Number(item.price_after);
      const recommendedPrice = minimumProfitablePrice == null
        ? calculatedRecommendation
        : Math.max(calculatedRecommendation, minimumProfitablePrice);
      return {
        ...item,
        title: product.display_name || product.product_name || product.title || 'Título não disponível no cadastro',
        percent: percentChange(item.price_before, item.price_after),
        current_amazon_price: finiteNumber(product.price) ? Number(product.price) : Number(item.price_after),
        recommended_price: recommendedPrice,
        minimum_profitable_price: minimumProfitablePrice,
        recommendation_no_loss: minimumProfitablePrice != null && recommendedPrice >= minimumProfitablePrice,
      };
    })
    .filter(item => source === 'all' || (source === 'automatic'
      ? item.source === 'automatic_repricing'
      : item.source !== 'automatic_repricing'))
    .filter(item => {
      const needle = search.trim().toLowerCase();
      if (!needle) return true;
      return [item.sku, item.asin, item.title].some(value => String(value || '').toLowerCase().includes(needle));
    })
    .sort((left, right) => {
      const numericKeys = new Set(['price_before', 'price_after', 'current_amazon_price', 'recommended_price', 'percent']);
      let leftValue;
      let rightValue;
      if (historySort.key === 'changed_at') {
        leftValue = new Date(left.changed_at).getTime();
        rightValue = new Date(right.changed_at).getTime();
      } else if (numericKeys.has(historySort.key)) {
        leftValue = Number(left[historySort.key] || 0);
        rightValue = Number(right[historySort.key] || 0);
      } else {
        leftValue = String(left[historySort.key] || '').toLocaleLowerCase('pt-BR');
        rightValue = String(right[historySort.key] || '').toLocaleLowerCase('pt-BR');
      }
      const comparison = typeof leftValue === 'number'
        ? leftValue - rightValue
        : leftValue.localeCompare(rightValue, 'pt-BR');
      return historySort.direction === 'asc' ? comparison : -comparison;
    });
  }, [history, historySort, productIndex, search, selectedDate, source]);

  const changeHistorySort = key => setHistorySort(current => ({
    key,
    direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
  }));

  const historyColumns = [
    ['changed_at', 'Horário'], ['sku', 'SKU'], ['asin', 'ASIN'], ['title', 'Título'],
    ['price_before', 'Valor anterior'], ['price_after', 'Valor alterado'],
    ['current_amazon_price', 'Preço atual Amazon'], ['recommended_price', 'Preço recomendado IA'],
    ['percent', 'Alteração'], ['source', 'Origem'], ['status', 'Confirmação'],
  ];

  const auditRows = useMemo(() => history
    .filter(item => brazilDay(item.changed_at) === selectedDate)
    .filter(item => !isOperationalConfirmation(item)), [history, selectedDate]);

  const recommendationRows = useMemo(() => {
    const seen = new Set();
    const historyCandidates = history.filter(item => ['price_recommendation', 'economic_evaluation'].includes(item.history_type));
    const economicsCandidates = economics.map(item => ({
      ...item,
      id: `economics:${item.id}`,
      history_type: 'economic_evaluation',
      changed_at: item.last_repricing_decision_at || item.updated_at,
      price_before: item.current_price,
      price_after: item.suggested_price,
      minimum_profitable_price: item.minimum_profitable_price,
      decision_evidence: item.decision_evidence || {},
      decision_reason: item.decision_reason || item.repricing_block_reason,
      status: item.repricing_status,
    })).filter(item => item.sku && (item.current_price > 0 || Object.keys(item.decision_evidence || {}).length > 0));
    return [...historyCandidates, ...economicsCandidates]
      .sort((left, right) => new Date(right.changed_at).getTime() - new Date(left.changed_at).getTime())
      .filter(item => {
        const key = normalizeSku(item.normalized_sku || item.sku || item.asin);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(item => {
        const product = productIndex.get(`id:${item.product_id}`) || productIndex.get(`sku:${normalizeSku(item.sku)}`) || productIndex.get(`asin:${String(item.asin || '').trim().toUpperCase()}`) || {};
        const evidence = item.decision_evidence || {};
        const exactAverage = evidence.competitor_offer_price_average || evidence.competitor_reference_price_average;
        const similarAverage = evidence.similar_competitor_price_average;
        const similarProducts = Array.isArray(evidence.similar_competitor_products) ? evidence.similar_competitor_products : [];
        const salesEstimates = similarProducts.map(match => Number(match.competitor_sales_estimate)).filter(value => Number.isFinite(value) && value > 0);
        const competitorAverage = finiteNumber(exactAverage) && finiteNumber(similarAverage)
          ? (Number(exactAverage) + Number(similarAverage)) / 2
          : finiteNumber(exactAverage) ? Number(exactAverage) : finiteNumber(similarAverage) ? Number(similarAverage) : null;
        const clicks = Number(evidence.ads_clicks_30d || 0);
        const orders = Number(evidence.ads_orders_30d || 0);
        const currentPrice = Number(evidence.current_price || item.price_before || product.price || 0);
        const similarPriceDifference = finiteNumber(similarAverage) && currentPrice > 0
          ? currentPrice - Number(similarAverage)
          : null;
        return {
          ...item,
          title: product.display_name || product.product_name || product.title || 'Título não disponível',
          current_price: currentPrice,
          recommended_price: Number(evidence.guarded_suggested_price || evidence.ideal_suggested_price || item.price_after || evidence.current_price || item.price_before || product.price || 0),
          competitor_average: competitorAverage,
          exact_competitor_average: finiteNumber(exactAverage) ? Number(exactAverage) : null,
          similar_competitor_average: finiteNumber(similarAverage) ? Number(similarAverage) : null,
          similar_competitor_minimum: finiteNumber(evidence.similar_competitor_price_minimum) ? Number(evidence.similar_competitor_price_minimum) : similarProducts.length ? Math.min(...similarProducts.map(match => Number(match.averagePrice)).filter(value => Number.isFinite(value) && value > 0)) : null,
          similar_competitor_maximum: finiteNumber(evidence.similar_competitor_price_maximum) ? Number(evidence.similar_competitor_price_maximum) : similarProducts.length ? Math.max(...similarProducts.map(match => Number(match.averagePrice)).filter(value => Number.isFinite(value) && value > 0)) : null,
          similar_count: Number(evidence.similar_competitor_product_count || 0),
          similar_products: similarProducts,
          similar_competition_error: evidence.similar_competition_error || null,
          similar_competition_checked_at: evidence.similar_competition_checked_at || null,
          similar_competition_search_queries: evidence.similar_competition_search_queries || [],
          similar_sales_estimate_average: salesEstimates.length ? salesEstimates.reduce((sum, value) => sum + value, 0) / salesEstimates.length : null,
          similar_sales_estimate_count: salesEstimates.length,
          similar_price_difference: similarPriceDifference,
          similar_price_difference_pct: similarPriceDifference == null ? null : (similarPriceDifference / Number(similarAverage)) * 100,
          ads_sales_per_click: clicks > 0 ? orders / clicks : null,
          confidence: Number(evidence.decision_confidence || item.confidence || 0),
        };
      });
  }, [economics, history, productIndex]);

  const summary = useMemo(() => ({
    total: rows.length,
    increases: rows.filter(row => Number(row.percent) > 0).length,
    reductions: rows.filter(row => Number(row.percent) < 0).length,
    automatic: rows.filter(row => row.source === 'automatic_repricing').length,
  }), [rows]);

  const allSkuRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const activeRank = product => product.status === 'active' && Number(product.available_quantity || 0) > 0 ? 0 : 1;
    const valueFor = (product, key) => {
      if (key === 'status') return activeRank(product);
      if (key === 'available_quantity' || key === 'total_quantity' || key === 'price') return Number(product[key] || 0);
      return String(product[key] || '').toLocaleLowerCase('pt-BR');
    };
    return [...products]
      .filter(product => product.sku)
      .filter(product => !needle || [
        product.sku,
        product.asin,
        product.display_name,
        product.product_name,
      ].some(value => String(value || '').toLowerCase().includes(needle)))
      .sort((left, right) => {
        const priority = activeRank(left) - activeRank(right);
        if (priority !== 0) return priority;
        const leftValue = valueFor(left, skuSort.key);
        const rightValue = valueFor(right, skuSort.key);
        const comparison = typeof leftValue === 'number'
          ? leftValue - rightValue
          : leftValue.localeCompare(rightValue, 'pt-BR');
        return (skuSort.direction === 'asc' ? comparison : -comparison) || normalizeSku(left.sku).localeCompare(normalizeSku(right.sku));
      });
  }, [products, search, skuSort]);

  const changeSkuSort = key => setSkuSort(current => ({
    key,
    direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
  }));

  const skuColumns = [
    ['sku', 'SKU'], ['asin', 'ASIN'], ['display_name', 'Produto'],
    ['status', 'Status Amazon'], ['available_quantity', 'Estoque disponível'],
    ['total_quantity', 'Estoque total'], ['price', 'Preço Amazon'],
    ['listing_checked_at', 'Última confirmação'],
  ];

  return (
    <div className="min-h-full p-4 md:p-6 space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2"><Tag className="h-5 w-5 text-cyan" /><h1 className="text-xl font-bold text-white">Repricing</h1></div>
          <p className="mt-1 text-xs text-slate-500">Preços alterados e confirmados na Amazon. O painel não exibe recomendações ainda não publicadas.</p>
        </div>
      <div className="flex flex-wrap gap-2"><input ref={costFileRef} type="file" accept=".xlsx,.xls,.csv" onChange={importCostSpreadsheet} className="hidden" /><button onClick={() => costFileRef.current?.click()} disabled={importingCosts || !accountId} className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-400 disabled:opacity-50">{importingCosts ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}{importingCosts ? 'Importando dados...' : 'Importar planilha econômica'}</button><button onClick={checkAmazonConnection} disabled={checkingConnection || !accountId} className="inline-flex items-center justify-center gap-2 rounded-lg border border-cyan/30 bg-cyan/10 px-3 py-2 text-xs font-semibold text-cyan disabled:opacity-50">{checkingConnection ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />}Testar conexão Amazon</button><button onClick={refreshAllSkus} disabled={syncingSkus || !accountId} className="inline-flex items-center justify-center gap-2 rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-xs font-semibold text-violet-300 disabled:opacity-50">{syncingSkus ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}{syncingSkus ? 'Sincronizando SKUs...' : 'Atualizar todos os SKUs'}</button><button onClick={executePlannedPrices} disabled={executingPrices || syncingSkus || !accountId} className="inline-flex items-center justify-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-300 disabled:opacity-50">{executingPrices ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />}{executingPrices ? 'Executando repricing...' : 'Executar preços planejados'}</button><button onClick={load} disabled={loading || !accountId} className="inline-flex items-center justify-center gap-2 rounded-lg border border-surface-3 px-3 py-2 text-xs text-slate-300 hover:bg-surface-2 disabled:opacity-50">{loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}Atualizar painel</button></div>
      </div>

      {importResult && <section className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4"><div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-400" /><div><h2 className="text-sm font-bold text-emerald-400">Custos importados e motor acionado</h2><p className="mt-1 text-xs text-slate-400">{importResult.processed || 0} linhas lidas · {importResult.created || 0} criadas · {importResult.updated || 0} atualizadas · {importResult.active_updated || 0} ativas verificadas pela Amazon · {importResult.inactive_updated || 0} inativas/sem estoque mantidas sem repricing · {importResult.unmatched || 0} SKUs não encontrados · {importResult.errors || 0} erros.</p><p className="mt-1 text-[10px] text-slate-500">O motor foi acionado somente após a importação válida; toda publicação continua sujeita à margem, confiança, teto móvel e confirmação da Amazon.</p>{importResult.amazon_status_warning && <p className="mt-2 text-xs text-amber-400">Status Amazon não confirmado: {importResult.amazon_status_warning} Os custos foram preservados e o repricing ficou bloqueado.</p>}{importResult.decision_engine?.ok === false && <p className="mt-2 text-xs text-amber-400">Custos salvos, mas o motor reportou: {importResult.decision_engine.error || 'falha não detalhada'}.</p>}{(importResult.processed || 0) === 0 && <p className="mt-2 text-xs font-semibold text-amber-400">Nenhuma linha válida foi extraída. Confira os detalhes da importação antes de considerar o processo concluído.</p>}{Array.isArray(importResult.error_details) && importResult.error_details.length > 0 && <details className="mt-3 text-xs text-amber-300"><summary className="cursor-pointer font-semibold">Exibir erros por SKU</summary><ul className="mt-2 space-y-1">{importResult.error_details.slice(0, 20).map((item, index) => <li key={`${item.sku || 'linha'}-${index}`}><span className="font-mono">{item.sku || 'SKU ausente'}</span>: {item.error}</li>)}</ul>{importResult.error_details.length > 20 && <p className="mt-2 text-slate-500">Mais {importResult.error_details.length - 20} erro(s) não exibidos.</p>}</details>}</div></div></section>}

      {skuSyncResult && <section className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-4 text-xs text-slate-300"><span className="font-semibold text-violet-300">Lista de SKUs atualizada pela Amazon.</span> {skuSyncResult.inventory_asins || 0} itens recebidos · {skuSyncResult.created || 0} criados · {skuSyncResult.updated || 0} atualizados · {skuSyncResult.names?.enriched || 0} títulos completados · {skuSyncResult.listings?.synced || 0} listings/preços confirmados · {skuSyncResult.marked_absent || 0} ausentes marcados sem estoque · {skuSyncResult.mapping_conflicts || 0} conflitos.</section>}

      {priceExecutionResult && <section className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-xs text-slate-300"><span className="font-semibold text-amber-300">Ciclo de repricing executado.</span> {priceExecutionResult.evaluation?.evaluated || 0} SKUs avaliados · {priceExecutionResult.evaluation?.queued || 0} preços elegíveis enfileirados · {priceExecutionResult.processing?.processed || 0} ações processadas · {(priceExecutionResult.reconciliation?.results || []).filter(item => item.status === 'confirmed').length} preços confirmados pela Amazon. Recomendações bloqueadas não foram publicadas.</section>}

      {connection && <section className={`rounded-xl border p-4 ${connection.connected ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-red-500/20 bg-red-500/5'}`}><div className="flex items-start gap-3">{connection.connected ? <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-400" /> : <Tag className="mt-0.5 h-5 w-5 text-red-400" />}<div className="min-w-0"><h2 className={`text-sm font-bold ${connection.connected ? 'text-emerald-400' : 'text-red-400'}`}>{connection.connected ? 'Repricing conectado à Amazon SP-API' : 'Conexão SP-API incompleta'}</h2><p className="mt-1 text-xs text-slate-400">{connection.message || (connection.connected ? 'OAuth, Listings Items e Product Pricing foram validados sem alterar preços.' : 'Confira os detalhes abaixo.')}</p>{connection.checks && <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-5">{Object.entries(connection.checks).map(([name, check]) => <div key={name} className="rounded-lg border border-surface-3 bg-surface-1/60 p-2"><p className="text-[10px] font-semibold uppercase text-slate-500">{name}</p><p className={`mt-1 text-[10px] ${check.ok ? 'text-emerald-400' : check.skipped ? 'text-amber-400' : 'text-red-400'}`}>{check.message}</p></div>)}</div>}</div></div></section>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Alterações no dia" value={summary.total} detail="Somente preços confirmados" tone="cyan" />
        <Stat label="Aumentos" value={summary.increases} detail="Percentual positivo" tone="green" />
        <Stat label="Reduções" value={summary.reductions} detail="Percentual negativo" tone="red" />
        <Stat label="Motor / IA" value={summary.automatic} detail="Decisões automáticas confirmadas" />
      </div>

      <section className="rounded-xl border border-surface-2 bg-surface-1">
        <div className="flex flex-col gap-3 border-b border-surface-2 p-4 xl:flex-row xl:items-center">
          <div className="relative min-w-0 flex-1"><Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-600" /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar SKU, ASIN ou título" className="w-full rounded-lg border border-surface-3 bg-surface-2 py-2 pl-9 pr-3 text-xs text-slate-200 outline-none focus:border-cyan/40" /></div>
          <label className="flex items-center gap-2 rounded-lg border border-surface-3 bg-surface-2 px-3 py-2 text-xs text-slate-400"><CalendarDays className="h-4 w-4" /><input type="date" value={selectedDate} onChange={event => setSelectedDate(event.target.value)} className="bg-transparent text-slate-200 outline-none" /></label>
          <select value={accountId} onChange={event => setAccountId(event.target.value)} className="rounded-lg border border-surface-3 bg-surface-2 px-3 py-2 text-xs text-slate-200">
            {accounts.map(account => <option key={account.id} value={account.id}>{account.seller_name || account.account_name || account.marketplace_id || account.id}</option>)}
          </select>
          <select value={source} onChange={event => setSource(event.target.value)} className="rounded-lg border border-surface-3 bg-surface-2 px-3 py-2 text-xs text-slate-200">
            <option value="all">Todas as origens</option><option value="automatic">Motor / IA</option><option value="manual">Aplicação manual</option>
          </select>
        </div>

        {error && <div className="m-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>}
        {loading ? <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-cyan" /></div> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="border-b border-surface-2 bg-surface-2/40 text-left text-[10px] uppercase tracking-wider text-slate-500">
                {historyColumns.map(([key, label]) => <th key={key} className="whitespace-nowrap px-4 py-3"><button type="button" onClick={() => changeHistorySort(key)} className="inline-flex items-center gap-1 hover:text-cyan">{label}{historySort.key === key ? historySort.direction === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" /> : <span className="text-slate-700">↕</span>}</button></th>)}
              </tr></thead>
              <tbody>{rows.map(row => {
                const positive = Number(row.percent) > 0;
                const negative = Number(row.percent) < 0;
                return <tr key={row.id} className="border-b border-surface-2/50 hover:bg-surface-2/30">
                  <td className="whitespace-nowrap px-4 py-3 text-slate-500">{time(row.changed_at)}</td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono font-semibold text-cyan">{row.sku || '—'}</td>
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-slate-400">{row.asin || '—'}</td>
                  <td className="min-w-[260px] max-w-[420px] px-4 py-3 text-slate-300"><p className="line-clamp-2">{row.title}</p></td>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-400">{money(row.price_before)}</td>
                  <td className="whitespace-nowrap px-4 py-3 font-semibold text-white">{money(row.price_after)}</td>
                  <td className="whitespace-nowrap px-4 py-3"><p className="font-semibold text-cyan">{money(row.current_amazon_price)}</p><p className="mt-1 text-[9px] text-slate-600">Listings Items API</p></td>
                  <td className="min-w-[190px] whitespace-nowrap px-4 py-3"><p className="font-semibold text-violet-300">{money(row.recommended_price)}</p><p className={`mt-1 text-[9px] ${row.recommendation_no_loss ? 'text-emerald-400' : 'text-amber-400'}`}>{row.recommendation_no_loss ? `Sem prejuízo · piso ${money(row.minimum_profitable_price)}` : 'Proteção econômica aplicada'}</p><p className="mt-1 text-[9px] text-slate-600">Offers · Featured Offer · FOEP · referência</p></td>
                  <td className={`whitespace-nowrap px-4 py-3 font-bold ${positive ? 'text-emerald-400' : negative ? 'text-red-400' : 'text-slate-500'}`}>
                    <span className="inline-flex items-center gap-1">{positive ? <ArrowUpRight className="h-3.5 w-3.5" /> : negative ? <ArrowDownRight className="h-3.5 w-3.5" /> : null}{row.percent == null ? '—' : `${row.percent > 0 ? '+' : ''}${row.percent.toFixed(2)}%`}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3"><span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] ${row.source === 'automatic_repricing' ? 'border-violet-500/20 bg-violet-500/10 text-violet-400' : 'border-surface-3 text-slate-400'}`}>{row.source === 'automatic_repricing' && <Bot className="h-3 w-3" />}{sourceLabel(row.source)}</span></td>
                  <td className="whitespace-nowrap px-4 py-3"><span className="inline-flex items-center gap-1 text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" />Amazon confirmada</span></td>
                </tr>;
              })}</tbody>
            </table>
            {!rows.length && !error && <div className="py-16 text-center"><Tag className="mx-auto h-7 w-7 text-slate-700" /><p className="mt-3 text-sm text-slate-400">Nenhum preço confirmado nesta data.</p><p className="mt-1 text-xs text-slate-600">Recomendações e ações pendentes não são contabilizadas como alteração.</p></div>}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-violet-500/20 bg-surface-1">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-2 p-4"><div><h2 className="text-sm font-semibold text-violet-300">Análise de preços da concorrência</h2><p className="mt-1 text-[10px] text-slate-500">Até 10 genéricos equivalentes por SKU, pesquisados somente pelo ScrapingBee no back-end e classificados por produto, modelo, cor e tamanho.</p><p className="mt-1 text-[10px] text-emerald-400">Ciclo horário no minuto :36 e estudo diário completo às 02:37. O preço recomendado continua protegido internamente por margem líquida ≥15% e confiança superior a 95%.</p></div><span className="rounded-full border border-violet-500/20 bg-violet-500/10 px-3 py-1 text-xs font-semibold text-violet-300">{recommendationRows.length} SKUs</span></div>
        <div className="max-h-[520px] overflow-auto"><table className="w-full text-xs"><thead className="sticky top-0 z-10 bg-surface-2"><tr className="text-left text-[10px] uppercase tracking-wider text-slate-500">{['SKU', 'Produto', 'Preço atual', 'Concorrentes identificados', 'Preço médio', 'Preço mínimo', 'Preço máximo', 'Preço recomendado'].map(label => <th key={label} className="whitespace-nowrap px-4 py-3">{label}</th>)}</tr></thead><tbody>{recommendationRows.map(row => <tr key={row.id} className="border-t border-surface-2/60 hover:bg-surface-2/30"><td className="whitespace-nowrap px-4 py-3 font-mono font-semibold text-cyan">{row.sku || '—'}</td><td className="min-w-[280px] max-w-[420px] px-4 py-3 text-slate-300"><p className="line-clamp-2">{row.title}</p></td><td className="whitespace-nowrap px-4 py-3 text-slate-300">{money(row.current_price)}</td><td className="whitespace-nowrap px-4 py-3"><button type="button" onClick={() => setSelectedCompetitors(row)} disabled={!row.similar_count} title={row.similar_competition_error || row.similar_competition_search_queries.join(' · ')} className="inline-flex items-center gap-1 rounded-lg border border-cyan/20 bg-cyan/5 px-3 py-1.5 font-semibold text-cyan enabled:hover:bg-cyan/10 disabled:cursor-not-allowed disabled:border-surface-3 disabled:text-slate-600">{row.similar_count ? `${row.similar_count} concorrente(s)` : row.similar_competition_error ? 'Falha na pesquisa' : row.similar_competition_checked_at ? '0 concorrentes encontrados' : 'Aguardando pesquisa'} <ExternalLink className="h-3 w-3" /></button></td><td className="whitespace-nowrap px-4 py-3 font-semibold text-cyan">{money(row.similar_competitor_average)}</td><td className="whitespace-nowrap px-4 py-3 text-emerald-400">{money(row.similar_competitor_minimum)}</td><td className="whitespace-nowrap px-4 py-3 text-amber-400">{money(row.similar_competitor_maximum)}</td><td className="whitespace-nowrap px-4 py-3"><p className="font-bold text-violet-300">{money(row.recommended_price)}</p><p className="mt-1 text-[9px] text-slate-600">margem e confiança validadas no motor</p></td></tr>)}</tbody></table>{!recommendationRows.length && <p className="p-8 text-center text-xs text-slate-500">O primeiro estudo diário preencherá esta tabela automaticamente. Produtos sem custos confirmados permanecem protegidos e não recebem preço automático.</p>}</div>
      </section>

      <section className="rounded-xl border border-surface-2 bg-surface-1">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-2 p-4"><div><h2 className="text-sm font-semibold text-slate-200">Todos os SKUs da conta</h2><p className="mt-1 text-[10px] text-slate-500">Catálogo e estoque canônicos da FBA Inventory API. Esta lista não representa alterações de preço.</p></div><span className="rounded-full border border-violet-500/20 bg-violet-500/10 px-3 py-1 text-xs font-semibold text-violet-300">{allSkuRows.length} de {products.filter(product => product.sku).length} SKUs</span></div>
        <div className="max-h-[520px] overflow-auto"><table className="w-full text-xs"><thead className="sticky top-0 z-10 bg-surface-2"><tr className="text-left text-[10px] uppercase tracking-wider text-slate-500">{skuColumns.map(([key, label]) => <th key={key} className="whitespace-nowrap px-4 py-3"><button type="button" onClick={() => changeSkuSort(key)} className="inline-flex items-center gap-1 hover:text-cyan">{label}{skuSort.key === key ? skuSort.direction === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" /> : <span className="text-slate-700">↕</span>}</button></th>)}</tr></thead><tbody>{allSkuRows.map(product => {
          const hasActiveInventory = product.status === 'active' && Number(product.available_quantity || 0) > 0;
          const listingChecked = Boolean(product.listing_checked_at);
          const activeAndBuyable = hasActiveInventory && product.listing_buyable === true;
          const statusLabel = activeAndBuyable ? 'Ativo e comprável' : hasActiveInventory && !listingChecked ? 'Ativo · validação pendente' : product.inventory_status === 'out_of_stock' ? 'Sem estoque' : product.listing_status === 'not_found' ? 'Listing não encontrado' : 'Não comprável confirmado';
          return <tr key={product.id || `${product.sku}-${product.asin}`} className="border-t border-surface-2/60 hover:bg-surface-2/30"><td className="whitespace-nowrap px-4 py-3 font-mono font-semibold text-cyan">{product.sku}</td><td className="whitespace-nowrap px-4 py-3 font-mono text-slate-400">{product.asin || '—'}</td><td className="min-w-[260px] max-w-[420px] px-4 py-3 text-slate-300"><p className="line-clamp-2">{product.display_name || product.product_name || 'Título pendente'}</p></td><td className="whitespace-nowrap px-4 py-3"><span className={`rounded-full border px-2 py-1 text-[10px] ${activeAndBuyable ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400' : hasActiveInventory ? 'border-cyan/20 bg-cyan/10 text-cyan' : 'border-amber-500/20 bg-amber-500/10 text-amber-400'}`}>{statusLabel}</span></td><td className="whitespace-nowrap px-4 py-3 text-right font-semibold text-slate-200">{Number(product.available_quantity || 0).toLocaleString('pt-BR')}</td><td className="whitespace-nowrap px-4 py-3 text-right text-slate-400">{Number(product.total_quantity ?? product.fba_inventory ?? 0).toLocaleString('pt-BR')}</td><td className="whitespace-nowrap px-4 py-3 text-right text-slate-300">{money(product.price)}</td><td className="whitespace-nowrap px-4 py-3 text-slate-500">{product.listing_checked_at ? new Date(product.listing_checked_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'Nunca'}</td></tr>;
        })}</tbody></table>{!allSkuRows.length && <p className="p-8 text-center text-xs text-slate-500">Nenhum SKU carregado. Use “Atualizar todos os SKUs”.</p>}</div>
      </section>

      <section className="rounded-xl border border-surface-2 bg-surface-1">
        <button type="button" onClick={() => setShowAudit(value => !value)} className="flex w-full items-center justify-between p-4 text-left">
          <span><span className="text-sm font-semibold text-slate-300">Auditoria de registros não operacionais</span><span className="ml-2 text-xs text-amber-400">{auditRows.length}</span><span className="mt-1 block text-[10px] text-slate-500">Pendências, falhas, bloqueios, recomendações e legados inconsistentes continuam localizáveis, mas não contam como preço alterado.</span></span>
          <span className="text-xs text-cyan">{showAudit ? 'Ocultar' : 'Exibir'}</span>
        </button>
        {showAudit && <div className="overflow-x-auto border-t border-surface-2"><table className="w-full text-xs"><thead><tr className="bg-surface-2/40 text-left text-[10px] uppercase text-slate-500">{['Horário', 'SKU', 'Tipo', 'Status', 'Antes', 'Depois', 'Motivo'].map(label => <th key={label} className="px-4 py-3">{label}</th>)}</tr></thead><tbody>{auditRows.map(item => <tr key={item.id} className="border-t border-surface-2/50"><td className="px-4 py-3 text-slate-500">{time(item.changed_at)}</td><td className="px-4 py-3 font-mono text-cyan">{item.sku || '—'}</td><td className="px-4 py-3 text-slate-400">{item.history_type || 'legado'}</td><td className="px-4 py-3 text-amber-400">{item.status || 'inconsistente'}</td><td className="px-4 py-3 text-slate-500">{money(item.price_before)}</td><td className="px-4 py-3 text-slate-500">{money(item.price_after)}</td><td className="max-w-[420px] px-4 py-3 text-slate-500">{item.reason || item.decision_reason || 'Sem motivo registrado.'}</td></tr>)}</tbody></table>{!auditRows.length && <p className="p-4 text-xs text-slate-500">Nenhum registro não operacional nesta data.</p>}</div>}
      </section>
      <CompetitorModal row={selectedCompetitors} onClose={() => setSelectedCompetitors(null)} />
    </div>
  );
}
