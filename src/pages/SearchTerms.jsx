import { useState, useEffect, useCallback, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { dedupeSearchTermRows, getSearchTermDataContext, matchesSearchTermFilter, SEARCH_TERM_FILTERS } from '@/lib/searchTermReview.js';
import {
  Search, Filter, RefreshCw, Loader2, TrendingUp, TrendingDown,
  ArrowUpRight, X, CheckCircle, AlertCircle, Brain, Upload,
  Settings, BookOpen, Plus, ChevronDown, ChevronUp
} from 'lucide-react';

// ─── Normalização de texto ────────────────────────────────────────────────────

function normalizeText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    // Correções comuns de OCR/digitação
    .replace(/^ixeira/, 'lixeira')
    .replace(/eletrnica/g, 'eletronica')
    .replace(/biomtrica/g, 'biometrica')
    .replace(/[^\w\s\u00C0-\u00FF]/g, '')
    .trim();
}

// ─── Classificação ───────────────────────────────────────────────────────────

const CLASSIFICATION_CONFIG = {
  winner:           { label: 'Vencedor',    color: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20' },
  migrate_exact:    { label: 'Migrar EXACT', color: 'text-cyan bg-cyan/10 border-cyan/20' },
  promising:        { label: 'Promissor',   color: 'text-blue-400 bg-blue-400/10 border-blue-400/20' },
  exploratory:      { label: 'Exploratório',color: 'text-slate-400 bg-slate-400/10 border-slate-400/20' },
  inefficient:      { label: 'Ineficiente', color: 'text-amber-400 bg-amber-400/10 border-amber-400/20' },
  negate_candidate: { label: 'Negativar',   color: 'text-red-400 bg-red-400/10 border-red-400/20' },
  no_data:          { label: 'Sem Dados',   color: 'text-slate-500 bg-slate-500/10 border-slate-500/20' },
};

async function loadAllRows(entity, filter) {
  const rows = [];
  const ids = new Set();
  const pageSize = 500;
  for (let page = 0; page < 1000; page += 1) {
    const result = await entity.filter(filter, 'id', pageSize, page * pageSize);
    for (const row of result || []) {
      if (ids.has(row.id)) throw new Error('A paginação repetiu registros; atualize os dados antes de analisar.');
      ids.add(row.id);
      rows.push(row);
    }
    if (!result || result.length < pageSize) return dedupeSearchTermRows(rows);
  }
  throw new Error('O conjunto ultrapassa o limite seguro de páginas. Refine o escopo para evitar uma análise parcial.');
}

function metric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function calcMetrics(kw) {
  const clicks = metric(kw.clicks);
  const orders = metric(kw.orders_14d ?? kw.orders);
  const spend = metric(kw.spend);
  const sales = metric(kw.sales_14d ?? kw.sales);
  const impressions = metric(kw.impressions);
  const ctr = impressions > 0 && clicks !== null ? (clicks / impressions) * 100 : metric(kw.ctr);
  const cpc = clicks > 0 && spend !== null ? spend / clicks : metric(kw.cpc);
  const cvr = clicks > 0 && orders !== null ? (orders / clicks) * 100 : null;
  const cpa = orders > 0 && spend !== null ? spend / orders : null;
  const acos = sales > 0 && spend !== null ? (spend / sales) * 100 : metric(kw.acos_14d ?? kw.acos);
  const roas = spend > 0 && sales !== null ? sales / spend : metric(kw.roas_14d ?? kw.roas);
  const rpc = clicks > 0 && sales !== null ? sales / clicks : null;
  return { clicks, orders, spend, sales, impressions, ctr, cpc, cvr, cpa, acos, roas, rpc, negative_review_eligible: kw.negative_review_eligible === true };
}

function classifyTerm(m, cfg) {
  const clicks = m.clicks ?? 0;
  const orders = m.orders ?? 0;
  const spend = m.spend ?? 0;
  const acos = m.acos;
  const roas = m.roas;
  const hasEvidence = [m.clicks, m.orders, m.spend, m.sales, m.impressions].some((value) => value !== null);
  if (!hasEvidence || m.orders === null || (clicks === 0 && orders === 0 && spend === 0)) return 'no_data';
  if (orders < 3 && clicks < 3 && orders === 0) return 'exploratory';
  const acosWinner = cfg.meta_acos != null && acos != null && acos <= cfg.meta_acos;
  const roasWinner = cfg.meta_roas != null && roas != null && roas >= cfg.meta_roas;
  if (orders >= 2 && (acosWinner || roasWinner)) return 'winner';
  if (orders === 1 && acosWinner) return 'migrate_exact';
  if (orders === 1) return 'promising';
  if (orders === 0 && m.negative_review_eligible === true) return 'negate_candidate';
  if (orders === 0 && clicks > 0) return 'inefficient';
  return 'promising';
}

function calcBidSuggested(m, cls, cfg, kw) {
  const baseBid = metric(kw._target?.suggested_bid) ?? (kw._target?.synced_at ? metric(kw._target.current_bid) ?? metric(kw._target.bid) : null);
  if (baseBid === null || baseBid <= 0) return null;
  if (cls === 'winner' && cfg.aumento_vencedor != null) return +(baseBid * (1 + cfg.aumento_vencedor / 100)).toFixed(2);
  if (cls === 'migrate_exact' && cfg.aumento_vencedor != null) return +(baseBid * (1 + cfg.aumento_vencedor / 100)).toFixed(2);
  if ((cls === 'negate_candidate' || cls === 'inefficient') && cfg.reducao_fraco != null) return +(baseBid * (1 - cfg.reducao_fraco / 100)).toFixed(2);
  return null;
}

function getRecommendation(cls, m) {
  if (cls === 'winner') return `Vencedor conforme meta efetiva: ROAS ${m.roas == null ? '—' : `${m.roas.toFixed(1)}x`}, ACoS ${m.acos == null ? '—' : `${m.acos.toFixed(1)}%`}.`;
  if (cls === 'migrate_exact') return `Uma venda atribuída e dentro da meta ACoS configurada (${m.acos?.toFixed(1) ?? '—'}%).`;
  if (cls === 'negate_candidate') return 'Elegível para revisão segundo regra validada pelo motor; requer conferência antes de negativar.';
  if (cls === 'inefficient') return 'Sem pedidos registrados nesta janela. Revise janela de atribuição, dados e oferta; sem ação automática.';
  if (cls === 'promising') return `${(m.orders ?? 0) > 0 ? `${m.orders} venda(s), manter observando` : 'Aguardar mais dados'}.`;
  if (cls === 'exploratory') return 'Amostra pequena; manter em observação.';
  return 'Dados insuficientes.';
}

// ─── Parâmetros padrão ───────────────────────────────────────────────────────

const DEFAULT_CFG = {
  meta_acos: null, meta_roas: null, limite_cliques: null, limite_custo: null,
  aumento_vencedor: null, reducao_fraco: null,
};

// ─── Componente ───────────────────────────────────────────────────────────────

export default function SearchTerms() {
  const [account, setAccount] = useState(null);
  const [keywords, setKeywords] = useState([]);
  const [bidTargets, setBidTargets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [metricContext, setMetricContext] = useState({ periodStatus: 'no_data', updatedAt: null, marketplace: null, accountId: null });
  const [reviewFilter, setReviewFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [filterClass, setFilterClass] = useState('all');
  const [sortBy, setSortBy] = useState('roas');
  const [actionMsg, setActionMsg] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [cfg, setCfg] = useState(DEFAULT_CFG);
  const [configSource, setConfigSource] = useState('não carregada');
  const [showCfg, setShowCfg] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef(null);

  const notify = (type, text, ms = 8000) => {
    setActionMsg({ type, text });
    setTimeout(() => setActionMsg(null), ms);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0] || null;
      setAccount(acc);
      if (!acc) {
        setKeywords([]);
        setBidTargets([]);
        setMetricContext({ periodStatus: 'no_data', updatedAt: null, marketplace: null, accountId: null });
        return;
      }

      const [searchTerms, targets] = await Promise.all([
        loadAllRows(base44.entities.SearchTerm, { amazon_account_id: acc.id }),
        loadAllRows(base44.entities.Keyword, { amazon_account_id: acc.id }),
      ]);
      const apCfgs = await base44.entities.AutopilotConfig.filter({ amazon_account_id: acc.id }, '-updated_date', 1);
      const ap = apCfgs[0] || null;
      if (ap) {
        setCfg({
          ...DEFAULT_CFG,
          meta_acos: metric(ap.target_acos ?? ap.acos_target),
          meta_roas: metric(ap.target_roas ?? ap.roas_target),
          aumento_vencedor: metric(ap.max_bid_increase_pct),
          reducao_fraco: metric(ap.max_bid_decrease_pct),
          limite_cliques: metric(ap.min_clicks_for_decision),
          limite_custo: metric(ap.min_spend_for_decision),
        });
        setConfigSource(`AutopilotConfig ${ap.id} · ${ap.updated_date || ap.updated_at || 'atualização não informada'}`);
      } else {
        setCfg(DEFAULT_CFG);
        setConfigSource('nenhuma configuração salva para esta conta');
      }
      setKeywords(searchTerms);
      setBidTargets(targets);
      setMetricContext(getSearchTermDataContext(searchTerms, acc));
    } catch (error) {
      setLoadError(error?.message || 'Falha ao carregar os termos e métricas desta conta.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Ações ─────────────────────────────────────────────────────────────────

  const addToTermBank = async (kw, m, bid) => {
    setActionLoading(kw.id + '_tb');
    const term = normalizeText(kw.search_term || kw.search_term_original || kw.keyword_text || kw.keyword);
    try {
      await base44.entities.TermBank.create({
        amazon_account_id: account.id,
        term,
        term_normalized: term,
        asin: kw.asin || '',
        sku: kw.sku || '',
        match_type: 'exact',
        recommended_match_type: 'EXACT',
        source: 'search_term_auto',
        term_type: m.orders >= 2 ? 'primary_high_conversion' : 'mid_tail',
        status: 'active',
        promotion_status: 'kickoff_candidate',
        
        ...(m.impressions == null ? {} : { impressions: m.impressions }),
        ...(m.clicks == null ? {} : { clicks: m.clicks }),
        ...(m.spend == null ? {} : { spend: m.spend }),
        ...(m.sales == null ? {} : { sales: m.sales }),
        ...(m.orders == null ? {} : { orders: m.orders }),
        ...(m.acos == null ? {} : { acos: m.acos }),
        ...(m.roas == null ? {} : { roas: m.roas }),
        ...(m.cpc == null ? {} : { cpc: m.cpc }),
        bid_initial: bid,
        bid_current: bid,
        classification: m.orders > 0 ? 'winner' : 'learning',
        created_at: new Date().toISOString(),
      });
      notify('success', `✓ "${term}" adicionado ao TermBank com bid R$${bid.toFixed(2)}`);
    } catch (e) { notify('error', e.message); }
    finally { setActionLoading(null); }
  };

  const createVariant = async (kw, m, matchType) => {
    const id = kw.id + '_' + matchType;
    const baseBid = metric(kw._target?.suggested_bid) ?? (kw._target?.synced_at ? metric(kw._target.current_bid) ?? metric(kw._target.bid) : null);
    if (baseBid === null || baseBid <= 0) {
      notify('info', 'Sem lance atual ou sugerido da Amazon; não foi criada uma sugestão com valor inventado.');
      return;
    }
    setActionLoading(id);
    const term = normalizeText(kw.search_term || kw.search_term_original || kw.keyword_text || kw.keyword);
    try {
      await base44.entities.KeywordSuggestion.create({
        amazon_account_id: account.id, campaign_id: kw.campaign_id || '', ad_group_id: kw.ad_group_id || '',
        keyword_text: term, match_type: matchType.toLowerCase(), bid: baseBid, status: 'pending',
        source: 'search_term_analysis',
        rationale: `Proposta EXACT usando bid de referência ${baseBid}; pedidos ${m.orders ?? 'ausentes'}, ROAS ${m.roas == null ? 'ausente' : m.roas.toFixed(1)}, ACoS ${m.acos == null ? 'ausente' : m.acos.toFixed(1)}.`,
        orders: m.orders, acos: m.acos, ...(m.roas == null ? {} : { roas: m.roas }), created_at: new Date().toISOString(),
      });
      notify('success', `Sugestão ${matchType} criada com bid de referência Amazon R$${baseBid.toFixed(2)}; requer revisão.`);
    } catch (e) { notify('error', e.message); }
    finally { setActionLoading(null); }
  };

  const adjustBid = async (kw, m, direction) => {
    const current = kw._target?.synced_at ? metric(kw._target.current_bid) ?? metric(kw._target.bid) : null;
    const pct = direction === 'up' ? cfg.aumento_vencedor : cfg.reducao_fraco;
    if (current === null || current <= 0 || pct === null || pct === undefined) {
      notify('info', 'Bid ou limite de variação ausente na configuração efetiva; nenhuma ação foi proposta.');
      return;
    }
    setActionLoading(kw.id + '_bid');
    const newBid = direction === 'up' ? +(current * (1 + pct / 100)).toFixed(2) : +(current * (1 - pct / 100)).toFixed(2);
    try {
      await base44.entities.AmazonActionQueue.create({
        amazon_account_id: account.id, operation: 'keyword_bid_update', entity_type: 'keyword',
        entity_id: kw.keyword_id || kw.id, keyword_id: kw.keyword_id || kw.id, campaign_id: kw.campaign_id || '',
        payload: JSON.stringify({ bid: newBid, bid_before: current, reason: `search_term_analysis_${direction}` }),
        status: 'pending', priority: direction === 'up' ? 'high' : 'normal', confidence: 85,
        source: 'SearchTerms', created_at: new Date().toISOString(), max_attempts: 3,
      });
      notify('info', `Proposta enfileirada para revisão: R$${current.toFixed(2)} → R$${newBid.toFixed(2)}. Ainda não confirmada na Amazon.`);
    } catch (e) { notify('error', e.message); }
    finally { setActionLoading(null); }
  };

  const negateKeyword = async (kw, m) => {
    setActionLoading(kw.id + '_neg');
    const term = normalizeText(kw.search_term || kw.search_term_original || kw.keyword_text || kw.keyword);
    try {
      await base44.entities.NegativeKeywordSuggestion.create({
        amazon_account_id: account.id,
        campaign_id: kw.campaign_id || '',
        ad_group_id: kw.ad_group_id || '',
        keyword_text: term,
        match_type: 'exact',
        clicks: m.clicks,
        spend: m.spend,
        ...(m.sales == null ? {} : { sales: m.sales }),
        ...(m.orders == null ? {} : { orders: m.orders }),
        acos: m.acos,
        reason: `${m.clicks} cliques, R$${m.spend == null ? '—' : m.spend.toFixed(2)} gasto, ${m.orders} pedidos — candidato a negativação`,
        status: 'pending',
      });
      notify('success', `✓ Negativação sugerida para "${term}"`);
    } catch (e) { notify('error', e.message); }
    finally { setActionLoading(null); }
  };

  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !account) return;
    setImporting(true);
    notify('info', 'Importando relatório...');
    try {
      const uploadRes = await base44.integrations.Core.UploadFile({ file });
      const importRes = await base44.functions.invoke('importSearchTermReport', {
        file_url: uploadRes.file_url,
        amazon_account_id: account.id,
      });
      if (importRes.data?.ok) {
        notify('success', `✓ ${importRes.data.imported || 0} termos importados`);
        await load();
      } else {
        notify('error', importRes.data?.error || 'Falha na importação');
      }
    } catch (err) { notify('error', err.message); }
    finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // ── Dados processados ─────────────────────────────────────────────────────

  const bidTargetById = new Map(bidTargets.filter((row) => row.keyword_id).map((row) => [String(row.keyword_id), row]));
  const processed = keywords.map(kw => {
    const m = calcMetrics(kw);
    const target = bidTargetById.get(String(kw.keyword_id || '')) || null;
    const enriched = { ...kw, orders: m.orders, sales: m.sales, asin: kw.advertised_asin || kw.asin, sku: kw.advertised_sku || kw.sku, _target: target };
    const cls = classifyTerm(m, cfg);
    const bidSuggested = calcBidSuggested(m, cls, cfg, target || {});
    const recommendation = getRecommendation(cls, m);
    return { ...enriched, _m: m, _cls: cls, _bidSuggested: bidSuggested, _rec: recommendation };
  });

  const filtered = processed.filter(kw => {
    const term = normalizeText(kw.search_term || kw.search_term_original || kw.keyword_text || kw.keyword);
    const matchSearch = !search || term.includes(normalizeText(search));
    const matchClass = filterClass === 'all' || kw._cls === filterClass;
    const matchReviewFilter = matchesSearchTermFilter(kw, reviewFilter);
    return matchSearch && matchClass && matchReviewFilter;
  }).sort((a, b) => {
    if (sortBy === 'roas')   return (b._m.roas || 0) - (a._m.roas || 0);
    if (sortBy === 'acos')   return (a._m.acos || 0) - (b._m.acos || 0);
    if (sortBy === 'spend')  return (b._m.spend || 0) - (a._m.spend || 0);
    if (sortBy === 'sales')  return (b._m.sales || 0) - (a._m.sales || 0);
    if (sortBy === 'clicks') return (b._m.clicks || 0) - (a._m.clicks || 0);
    if (sortBy === 'orders') return (b._m.orders || 0) - (a._m.orders || 0);
    return 0;
  });

  const classCounts = processed.reduce((acc, kw) => {
    acc[kw._cls] = (acc[kw._cls] || 0) + 1;
    return acc;
  }, {});

  const winners   = (classCounts.winner || 0) + (classCounts.migrate_exact || 0);
  const toNegate  = classCounts.negate_candidate || 0;
  const overallRoas = null; // Linhas diárias podem compartilhar a janela de atribuição; somá-las criaria dupla contagem.

  return (
    <div className="p-5 space-y-5 animate-fade-in">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
            <Search className="w-5 h-5 text-cyan" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Análise de Search Terms</h1>
            <p className="text-xs text-slate-400">
              {keywords.length} termos da conta (todas as páginas) · {winners} vencedores · {toNegate} para revisar · ROAS agregado indisponível (janelas podem se sobrepor)
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" onChange={handleImportFile} className="hidden" />
          <button onClick={() => fileInputRef.current?.click()} disabled={importing || !account}
            className="flex items-center gap-1.5 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-60">
            <Upload className={`w-3.5 h-3.5 ${importing ? 'animate-spin' : ''}`} />
            {importing ? 'Importando...' : 'Importar CSV'}
          </button>
          <button onClick={() => setShowCfg(p => !p)}
            className="flex items-center gap-1.5 px-3 py-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white text-xs rounded-lg transition-colors">
            <Settings className="w-3.5 h-3.5" />
            Parâmetros
          </button>
          <button onClick={load} disabled={loading} className="p-2 bg-surface-2 border border-surface-3 text-slate-400 hover:text-white rounded-lg transition-colors">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Painel de parâmetros */}
      {showCfg && (
        <div className="bg-surface-1 border border-surface-2 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-slate-300 mb-3">Parâmetros de decisão</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { key: 'meta_acos', label: 'ACoS alvo efetivo (%)', step: 1 },
              { key: 'meta_roas', label: 'ROAS alvo efetivo', step: 0.1 },
              { key: 'limite_cliques', label: 'Cliques mínimos p/ decisão', step: 1 },
              { key: 'limite_custo', label: 'Gasto mínimo p/ decisão', step: 1 },
              { key: 'aumento_vencedor', label: 'Teto aumento bid (%)', step: 1 },
              { key: 'reducao_fraco', label: 'Teto redução bid (%)', step: 1 },
            ].map(f => (
              <div key={f.key}>
                <label className="text-[10px] text-slate-500 block mb-1">{f.label}</label>
                <input type="number" step={f.step} value={cfg[f.key] ?? ''} readOnly aria-readonly="true"
                  className="w-full px-2 py-1.5 bg-surface-2 border border-surface-3 text-slate-300 text-xs rounded-lg focus:outline-none focus:border-cyan/50" />
              </div>
            ))}
          </div>
          <p className="mt-3 text-[10px] text-slate-500">Origem: {configSource}. Campos ausentes permanecem sem valor; esta tela não grava alterações de configuração.</p>
        </div>
      )}

      {/* Mensagem de ação */}
      {actionMsg && (
        <div className={`px-4 py-3 rounded-xl border text-xs font-medium ${
          actionMsg.type === 'success' ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-300' :
          actionMsg.type === 'error'   ? 'bg-red-400/10 border-red-400/20 text-red-400' :
          'bg-cyan/10 border-cyan/20 text-cyan'
        }`}>{actionMsg.text}</div>
      )}

      {/* KPI cards por classe */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        {Object.entries(CLASSIFICATION_CONFIG).map(([key, c]) => (
          <button key={key} onClick={() => setFilterClass(filterClass === key ? 'all' : key)}
            className={`p-3 rounded-xl border text-left transition-all ${filterClass === key ? 'ring-1 ring-cyan/50' : 'opacity-80 hover:opacity-100'} ${c.color.split(' ').filter(x => x.startsWith('bg') || x.startsWith('border')).join(' ')}`}>
            <p className={`text-lg font-bold ${c.color.split(' ')[0]}`}>{classCounts[key] || 0}</p>
            <p className="text-[10px] text-slate-500 leading-tight mt-0.5">{c.label}</p>
          </button>
        ))}
      </div>

      {/* Escopo dos dados */}
      <div className="rounded-lg border border-surface-2 bg-surface-1 px-3 py-2 text-[11px] text-slate-400">
        <div>Conta: {account?.name || account?.account_name || account?.id || '—'} · Marketplace: {metricContext.marketplace || 'não informado'} · Moeda: {metricContext.currency || 'não informada'} · Termos: {keywords.length} distintos (unique_key) · Alvos carregados: {bidTargets.length}</div>
        <div>Métricas de pedido/venda usam a janela 14d do SearchTerm; período dos registros: {metricContext.periodStatus === 'known' ? `${metricContext.periodStart} a ${metricContext.periodEnd}${metricContext.attributionWindowDays ? ` · janela origem ${metricContext.attributionWindowDays}d` : ''}` : metricContext.periodStatus === 'mixed' ? 'períodos mistos nos registros' : metricContext.periodStatus === 'no_data' ? 'sem dados' : 'não registrada pela origem'} · Métricas atualizadas: {metricContext.updatedAt ? new Date(metricContext.updatedAt).toLocaleString('pt-BR') : 'data não informada'}</div>
      </div>
      {loadError && <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{loadError} · Atualize ou verifique a conexão Amazon.</div>}

      {/* Filtros */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Pesquisar termo..."
            className="w-full sm:w-56 pl-9 pr-4 py-2 bg-surface-1 border border-surface-2 rounded-lg text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
        </div>
        <select aria-label="Filtro de métricas" value={reviewFilter} onChange={e => setReviewFilter(e.target.value)}
          className="text-xs bg-surface-2 border border-surface-3 text-slate-300 rounded-lg px-2 py-2 focus:outline-none">
          {Object.entries(SEARCH_TERM_FILTERS).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}
        </select>
        <select value={sortBy} onChange={e => setSortBy(e.target.value)}
          className="text-xs bg-surface-2 border border-surface-3 text-slate-300 rounded-lg px-2 py-2 focus:outline-none">
          <option value="roas">↓ ROAS</option>
          <option value="acos">↑ ACoS</option>
          <option value="orders">↓ Pedidos</option>
          <option value="spend">↓ Spend</option>
          <option value="sales">↓ Vendas</option>
          <option value="clicks">↓ Cliques</option>
        </select>
        <span className="text-xs text-slate-500 self-center ml-auto">{filtered.length} de {processed.length} registros · filtro aplicado antes da tabela</span>
      </div>

      <p className="-mt-3 text-[10px] text-slate-500">Definição: {SEARCH_TERM_FILTERS[reviewFilter].definition} · Sem limiar de cliques ou gasto predefinido; filtros apenas identificam linhas para revisão.</p>

      {/* Tabela */}
      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-7 h-7 text-cyan animate-spin" /></div>
      ) : loadError ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-8 text-center text-sm text-red-300">Os resultados podem estar incompletos porque houve falha de carregamento. Corrija a conexão e tente novamente.</div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <Search className="w-10 h-10 text-slate-600" />
          <p className="text-sm text-slate-400">Nenhum registro corresponde ao filtro atual nesta janela. Isso não confirma ausência de gasto, clique ou venda fora da janela importada.</p>
        </div>
      ) : (
        <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/50">
                  {['Termo', 'Classe', 'Impr.', 'Cliques', 'CTR', 'Spend', 'CPC', 'Compras', 'CVR', 'CPA', 'Vendas', 'ACoS', 'ROAS', 'R$/clique', 'Bid atual', 'Bid sugerido', 'Ações'].map(h => (
                    <th key={h} className="px-3 py-2.5 text-left font-semibold text-slate-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(kw => {
                  const m = kw._m;
                  const cls = kw._cls;
                  const cfg_ = CLASSIFICATION_CONFIG[cls] || CLASSIFICATION_CONFIG.no_data;
                  const acosColor = m.acos != null && cfg.meta_acos != null && m.acos > cfg.meta_acos * 1.5 ? 'text-red-400' : m.acos != null && cfg.meta_acos != null && m.acos > cfg.meta_acos ? 'text-amber-400' : m.acos != null && m.acos > 0 ? 'text-emerald-400' : 'text-slate-600';
                  const roasColor = m.roas != null && cfg.meta_roas != null && m.roas >= cfg.meta_roas ? 'text-emerald-400' : m.roas != null && m.roas > 0 ? 'text-amber-400' : 'text-slate-600';
                  const isWinner = cls === 'winner' || cls === 'migrate_exact';
                  const isNegate = cls === 'negate_candidate';
                  const bidCurrent = kw._target?.synced_at ? metric(kw._target.current_bid) ?? metric(kw._target.bid) : null;
                  const loadingPrefix = actionLoading?.startsWith(kw.id);

                  return (
                    <tr key={kw.id} className="border-b border-surface-2/30 hover:bg-surface-2/20 transition-colors">
                      {/* Termo */}
                      <td className="px-3 py-2 max-w-[200px]">
                        <p className="font-medium text-slate-200 truncate" title={kw.search_term || kw.search_term_original || kw.keyword_text || kw.keyword}>
                          {normalizeText(kw.search_term || kw.search_term_original || kw.keyword_text || kw.keyword) || '—'}
                        </p>
                        <p className="text-slate-600 font-mono truncate text-[10px]">{kw.match_type || kw.keyword_match_type || ''}</p>
                        <p className="text-slate-600 mt-0.5 truncate text-[10px]" title={kw._rec}>{kw._rec}</p>
                      </td>
                      {/* Classe */}
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className={`px-2 py-0.5 rounded-full border font-medium ${cfg_.color}`}>{cfg_.label}</span>
                      </td>
                      {/* Métricas */}
                      <td className="px-3 py-2 text-slate-400">{m.impressions == null || m.impressions <= 0 ? '—' : m.impressions.toLocaleString('pt-BR')}</td>
                      <td className="px-3 py-2 text-slate-400">{m.clicks == null ? '—' : m.clicks.toLocaleString('pt-BR')}</td>
                      <td className="px-3 py-2 text-slate-400">{m.ctr == null || m.ctr <= 0 ? '—' : `${m.ctr.toFixed(2)}%`}</td>
                      <td className="px-3 py-2 text-slate-300">R${m.spend == null ? '—' : m.spend.toFixed(2)}</td>
                      <td className="px-3 py-2 text-slate-400">{m.cpc == null || m.cpc <= 0 ? '—' : `R${m.cpc.toFixed(2)}`}</td>
                      <td className="px-3 py-2 font-semibold text-slate-200">{m.orders == null ? '—' : m.orders}</td>
                      <td className="px-3 py-2 text-slate-400">{m.cvr == null ? '—' : `${m.cvr.toFixed(2)}%`}</td>
                      <td className="px-3 py-2 text-slate-400">{m.cpa == null ? '—' : `R${m.cpa.toFixed(2)}`}</td>
                      <td className="px-3 py-2 text-emerald-400 font-semibold">{m.sales == null ? '—' : `R${m.sales.toFixed(2)}`}</td>
                      <td className="px-3 py-2"><span className={`font-semibold ${acosColor}`}>{m.acos == null ? '—' : `${m.acos.toFixed(1)}%`}</span></td>
                      <td className="px-3 py-2"><span className={`font-semibold ${roasColor}`}>{m.roas == null ? '—' : `${m.roas.toFixed(1)}x`}</span></td>
                      <td className="px-3 py-2 text-slate-400">{m.rpc == null ? '—' : `R${m.rpc.toFixed(2)}`}</td>
                      <td className="px-3 py-2 text-slate-300">{bidCurrent != null && bidCurrent > 0 ? `R${bidCurrent.toFixed(2)}` : '—'}</td>
                      <td className="px-3 py-2">
                        <span className={`font-semibold ${kw._bidSuggested > bidCurrent ? 'text-emerald-400' : kw._bidSuggested < bidCurrent ? 'text-amber-400' : 'text-slate-400'}`}>
                          {kw._bidSuggested == null ? '—' : `R${kw._bidSuggested.toFixed(2)}`}
                        </span>
                      </td>
                      {/* Ações */}
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1 flex-wrap">
                          {/* TermBank */}
                          <button onClick={() => addToTermBank(kw, m, kw._bidSuggested)} disabled={!!actionLoading || kw._bidSuggested == null}
                            className="flex items-center gap-0.5 px-1.5 py-1 bg-surface-2 border border-surface-3 text-slate-400 hover:text-cyan hover:border-cyan/30 rounded transition-colors disabled:opacity-40"
                            title="Adicionar ao TermBank">
                            {actionLoading === kw.id + '_tb' ? <Loader2 className="w-3 h-3 animate-spin" /> : <BookOpen className="w-3 h-3" />}
                          </button>

                          {/* EXACT */}
                          <button onClick={() => createVariant(kw, m, 'EXACT')} disabled={!!actionLoading || bidCurrent == null || bidCurrent <= 0}
                            className="px-1.5 py-1 bg-cyan/10 border border-cyan/20 text-cyan hover:bg-cyan/20 rounded text-[10px] font-bold transition-colors disabled:opacity-40"
                            title={bidCurrent == null ? 'Bid da Amazon indisponível' : `Criar sugestão EXACT com bid de referência R$${bidCurrent.toFixed(2)}`}>
                            {actionLoading === kw.id + '_EXACT' ? <Loader2 className="w-3 h-3 animate-spin" /> : 'E'}
                          </button>

                          {/* Aumentar bid */}
                          {isWinner && (
                            <button onClick={() => adjustBid(kw, m, 'up')} disabled={!!actionLoading || cfg.aumento_vencedor == null || bidCurrent == null}
                              className="p-1 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 rounded transition-colors disabled:opacity-40"
                              title={`Aumentar bid +${cfg.aumento_vencedor}%`}>
                              {actionLoading === kw.id + '_bid' ? <Loader2 className="w-3 h-3 animate-spin" /> : <TrendingUp className="w-3 h-3" />}
                            </button>
                          )}

                          {/* Reduzir bid */}
                          {(cls === 'inefficient' || cls === 'negate_candidate') && (
                            <button onClick={() => adjustBid(kw, m, 'down')} disabled={!!actionLoading || cfg.reducao_fraco == null || bidCurrent == null}
                              className="p-1 bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 rounded transition-colors disabled:opacity-40"
                              title={`Reduzir bid -${cfg.reducao_fraco}%`}>
                              <TrendingDown className="w-3 h-3" />
                            </button>
                          )}

                          {/* Negativar */}
                          {isNegate && (
                            <button onClick={() => negateKeyword(kw, m)} disabled={!!actionLoading}
                              className="p-1 bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 rounded transition-colors disabled:opacity-40"
                              title="Sugerir negativação">
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Legenda de ações */}
          <div className="px-4 py-2 border-t border-surface-2 flex items-center gap-4 text-[10px] text-slate-600">
            <span><span className="text-cyan font-bold">E</span> = EXACT</span>
            <span><span className="text-blue-400 font-bold">P</span> = PHRASE</span>
            <span><span className="text-violet-400 font-bold">B</span> = BROAD</span>
            <span className="flex items-center gap-1"><BookOpen className="w-2.5 h-2.5" /> = TermBank</span>
            <span className="flex items-center gap-1"><TrendingUp className="w-2.5 h-2.5 text-emerald-400" /> = Aumentar bid</span>
            <span className="flex items-center gap-1"><TrendingDown className="w-2.5 h-2.5 text-amber-400" /> = Reduzir bid</span>
            <span className="flex items-center gap-1"><X className="w-2.5 h-2.5 text-red-400" /> = Negativar</span>
          </div>
        </div>
      )}
    </div>
  );
}