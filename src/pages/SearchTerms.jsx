import { useState, useEffect, useCallback, useRef } from 'react';
import { base44 } from '@/api/base44Client';
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

function calcMetrics(kw) {
  const clicks     = kw.clicks     || 0;
  const orders     = kw.orders     || 0;
  const spend      = kw.spend      || 0;
  const sales      = kw.sales      || 0;
  const impressions= kw.impressions|| 0;

  const ctr    = impressions > 0 ? (clicks / impressions) * 100 : (kw.ctr || 0);
  const cpc    = clicks > 0 ? spend / clicks : (kw.cpc || 0);
  const cvr    = clicks > 0 ? (orders / clicks) * 100 : 0;
  const cpa    = orders > 0 ? spend / orders : 0;
  const acos   = sales > 0 ? (spend / sales) * 100 : (kw.acos || 0);
  const roas   = spend > 0 ? sales / spend : (kw.roas || 0);
  const rpc    = clicks > 0 ? sales / clicks : 0; // receita por clique

  return { clicks, orders, spend, sales, impressions, ctr, cpc, cvr, cpa, acos, roas, rpc };
}

function classifyTerm(m, cfg) {
  const { clicks, orders, spend, acos, roas, cpc } = m;
  const { meta_acos, limite_cliques, limite_custo } = cfg;

  if (clicks < 3) return 'no_data';
  if (orders >= 2 && (acos <= meta_acos || roas >= 5)) return 'winner';
  if (orders === 1 && acos <= meta_acos) return 'migrate_exact';
  if (orders === 1 && acos > meta_acos) return 'promising';
  if (clicks >= limite_cliques && spend >= limite_custo && orders === 0) return 'negate_candidate';
  if (clicks >= 5 && orders === 0) return 'inefficient';
  if (clicks < 10 && orders === 0) return 'exploratory';
  return 'promising';
}

function calcBidSuggested(m, cls, cfg) {
  const { cpc, roas, acos, orders, clicks, spend } = m;
  const baseBid = cpc > 0 ? cpc : 0.25;
  const { aumento_vencedor, reducao_fraco, meta_acos } = cfg;

  if (cls === 'winner' && roas >= 5) return +(baseBid * (1 + aumento_vencedor / 100)).toFixed(2);
  if (cls === 'winner' && acos <= meta_acos) return +(baseBid * 1.10).toFixed(2);
  if (cls === 'migrate_exact') return +(baseBid * 1.10).toFixed(2);
  if (cls === 'negate_candidate') return +(baseBid * (1 - reducao_fraco / 100)).toFixed(2);
  if (cls === 'inefficient') return +(baseBid * 0.75).toFixed(2);
  return +baseBid.toFixed(2);
}

function getRecommendation(cls, m) {
  if (cls === 'winner') return `Termo vencedor. ROAS ${m.roas.toFixed(1)}x. Migrar para EXACT e aumentar bid.`;
  if (cls === 'migrate_exact') return `1 venda com ACoS ${m.acos.toFixed(1)}%. Criar versão EXACT.`;
  if (cls === 'negate_candidate') return `${m.clicks} cliques, R$${m.spend.toFixed(2)} gasto, zero compras. Negativar.`;
  if (cls === 'inefficient') return `Cliques sem conversão. Reduzir bid ${m.acos > 0 ? `(ACoS ${m.acos.toFixed(1)}%)` : ''}.`;
  if (cls === 'promising') return `${m.orders > 0 ? `${m.orders} venda(s), manter observando` : 'Potencial. Aguardar mais dados'}.`;
  if (cls === 'exploratory') return 'Poucos dados. Manter rodando.';
  return 'Dados insuficientes.';
}

// ─── Parâmetros padrão ───────────────────────────────────────────────────────

const DEFAULT_CFG = {
  meta_acos: 20,
  limite_cliques: 10,
  limite_custo: 15,
  aumento_vencedor: 20,
  reducao_fraco: 30,
  mult_exact: 1.00,
  mult_phrase: 0.70,
  mult_broad: 0.45,
};

// ─── Componente ───────────────────────────────────────────────────────────────

export default function SearchTerms() {
  const [account, setAccount] = useState(null);
  const [keywords, setKeywords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterClass, setFilterClass] = useState('all');
  const [sortBy, setSortBy] = useState('roas');
  const [actionMsg, setActionMsg] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [cfg, setCfg] = useState(DEFAULT_CFG);
  const [showCfg, setShowCfg] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef(null);

  const notify = (type, text, ms = 8000) => {
    setActionMsg({ type, text });
    setTimeout(() => setActionMsg(null), ms);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      const accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      const acc = accounts[0] || null;
      setAccount(acc);
      if (!acc) return;

      const [kws, apCfgs] = await Promise.all([
        base44.entities.Keyword.filter({ amazon_account_id: acc.id }, '-spend', 1000),
        base44.entities.AutopilotConfig.filter({ amazon_account_id: acc.id }, null, 1),
      ]);

      const ap = apCfgs[0];
      if (ap?.target_acos) setCfg(p => ({ ...p, meta_acos: ap.target_acos }));

      setKeywords(kws);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Ações ─────────────────────────────────────────────────────────────────

  const addToTermBank = async (kw, m, bid) => {
    setActionLoading(kw.id + '_tb');
    const term = normalizeText(kw.keyword_text || kw.keyword);
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
        confidence: m.orders >= 2 ? 92 : 78,
        impressions: m.impressions,
        clicks: m.clicks,
        spend: m.spend,
        sales: m.sales,
        orders: m.orders,
        acos: m.acos,
        roas: m.roas,
        cpc: m.cpc,
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
    setActionLoading(id);
    const term = normalizeText(kw.keyword_text || kw.keyword);
    const baseBid = m.cpc > 0 ? m.cpc : 0.25;
    const mult = matchType === 'EXACT' ? cfg.mult_exact : matchType === 'PHRASE' ? cfg.mult_phrase : cfg.mult_broad;
    const bid = +(baseBid * mult).toFixed(2);

    try {
      await base44.entities.KeywordSuggestion.create({
        amazon_account_id: account.id,
        campaign_id: kw.campaign_id || '',
        ad_group_id: kw.ad_group_id || '',
        keyword_text: term,
        match_type: matchType.toLowerCase(),
        bid,
        status: 'pending',
        source: 'search_term_analysis',
        rationale: `Derivado de termo com ${m.orders} compra(s), ROAS ${m.roas.toFixed(1)}x, ACoS ${m.acos.toFixed(1)}%`,
        orders: m.orders,
        acos: m.acos,
        roas: m.roas,
        created_at: new Date().toISOString(),
      });
      notify('success', `✓ Sugestão ${matchType} criada: "${term}" bid R$${bid.toFixed(2)}`);
    } catch (e) { notify('error', e.message); }
    finally { setActionLoading(null); }
  };

  const adjustBid = async (kw, m, direction) => {
    setActionLoading(kw.id + '_bid');
    const current = m.cpc > 0 ? m.cpc : 0.25;
    const pct = direction === 'up' ? cfg.aumento_vencedor : cfg.reducao_fraco;
    const newBid = direction === 'up'
      ? +(current * (1 + pct / 100)).toFixed(2)
      : +(current * (1 - pct / 100)).toFixed(2);

    try {
      await base44.entities.AmazonActionQueue.create({
        amazon_account_id: account.id,
        operation: 'keyword_bid_update',
        entity_type: 'keyword',
        entity_id: kw.keyword_id || kw.id,
        keyword_id: kw.keyword_id || kw.id,
        campaign_id: kw.campaign_id || '',
        payload: JSON.stringify({ bid: newBid, bid_before: current, reason: `search_term_analysis_${direction}` }),
        status: 'pending',
        priority: direction === 'up' ? 'high' : 'normal',
        confidence: direction === 'up' ? 85 : 90,
        source: 'SearchTerms',
        created_at: new Date().toISOString(),
        max_attempts: 3,
      });
      notify('success', `✓ Bid ${direction === 'up' ? 'aumentado' : 'reduzido'}: R$${current.toFixed(2)} → R$${newBid.toFixed(2)} (+${pct}%)`);
    } catch (e) { notify('error', e.message); }
    finally { setActionLoading(null); }
  };

  const negateKeyword = async (kw, m) => {
    setActionLoading(kw.id + '_neg');
    const term = normalizeText(kw.keyword_text || kw.keyword);
    try {
      await base44.entities.NegativeKeywordSuggestion.create({
        amazon_account_id: account.id,
        campaign_id: kw.campaign_id || '',
        ad_group_id: kw.ad_group_id || '',
        keyword_text: term,
        match_type: 'exact',
        clicks: m.clicks,
        spend: m.spend,
        sales: m.sales,
        acos: m.acos,
        reason: `${m.clicks} cliques, R$${m.spend.toFixed(2)} gasto, ${m.orders} pedidos — candidato a negativação`,
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

  const processed = keywords.map(kw => {
    const m = calcMetrics(kw);
    const cls = classifyTerm(m, cfg);
    const bidSuggested = calcBidSuggested(m, cls, cfg);
    const recommendation = getRecommendation(cls, m);
    return { ...kw, _m: m, _cls: cls, _bidSuggested: bidSuggested, _rec: recommendation };
  });

  const filtered = processed.filter(kw => {
    const term = normalizeText(kw.keyword_text || kw.keyword);
    const matchSearch = !search || term.includes(normalizeText(search));
    const matchClass = filterClass === 'all' || kw._cls === filterClass;
    return matchSearch && matchClass;
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
  const totalSpend = processed.reduce((s, k) => s + k._m.spend, 0);
  const totalSales = processed.reduce((s, k) => s + k._m.sales, 0);
  const overallRoas = totalSpend > 0 ? totalSales / totalSpend : 0;

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
              {keywords.length} termos · {winners} vencedores · {toNegate} para negativar · ROAS geral {overallRoas.toFixed(1)}x
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
              { key: 'meta_acos',       label: 'ACoS alvo (%)',      step: 1 },
              { key: 'limite_cliques',  label: 'Cliques sem venda',  step: 1 },
              { key: 'limite_custo',    label: 'Custo limite (R$)',   step: 1 },
              { key: 'aumento_vencedor',label: 'Aumento bid (%)',     step: 5 },
              { key: 'reducao_fraco',   label: 'Redução bid (%)',     step: 5 },
              { key: 'mult_exact',      label: 'Mult EXACT',          step: 0.05 },
              { key: 'mult_phrase',     label: 'Mult PHRASE',         step: 0.05 },
              { key: 'mult_broad',      label: 'Mult BROAD',          step: 0.05 },
            ].map(f => (
              <div key={f.key}>
                <label className="text-[10px] text-slate-500 block mb-1">{f.label}</label>
                <input type="number" step={f.step} value={cfg[f.key]}
                  onChange={e => setCfg(p => ({ ...p, [f.key]: parseFloat(e.target.value) }))}
                  className="w-full px-2 py-1.5 bg-surface-2 border border-surface-3 text-slate-300 text-xs rounded-lg focus:outline-none focus:border-cyan/50" />
              </div>
            ))}
          </div>
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

      {/* Filtros */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Pesquisar termo..."
            className="w-full sm:w-56 pl-9 pr-4 py-2 bg-surface-1 border border-surface-2 rounded-lg text-xs text-slate-300 placeholder-slate-600 focus:outline-none focus:border-cyan/50" />
        </div>
        <select value={sortBy} onChange={e => setSortBy(e.target.value)}
          className="text-xs bg-surface-2 border border-surface-3 text-slate-300 rounded-lg px-2 py-2 focus:outline-none">
          <option value="roas">↓ ROAS</option>
          <option value="acos">↑ ACoS</option>
          <option value="orders">↓ Pedidos</option>
          <option value="spend">↓ Spend</option>
          <option value="sales">↓ Vendas</option>
          <option value="clicks">↓ Cliques</option>
        </select>
        <span className="text-xs text-slate-500 self-center ml-auto">{filtered.length} termos exibidos</span>
      </div>

      {/* Tabela */}
      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-7 h-7 text-cyan animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <Search className="w-10 h-10 text-slate-600" />
          <p className="text-sm text-slate-400">Nenhum termo encontrado. Importe um relatório CSV da Amazon Ads.</p>
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
                  const acosColor = m.acos > cfg.meta_acos * 1.5 ? 'text-red-400' : m.acos > cfg.meta_acos ? 'text-amber-400' : m.acos > 0 ? 'text-emerald-400' : 'text-slate-600';
                  const roasColor = m.roas >= 5 ? 'text-emerald-400' : m.roas >= 2 ? 'text-cyan' : m.roas > 0 ? 'text-amber-400' : 'text-slate-600';
                  const isWinner = cls === 'winner' || cls === 'migrate_exact';
                  const isNegate = cls === 'negate_candidate';
                  const bidCurrent = m.cpc > 0 ? m.cpc : (kw.current_bid || kw.bid || 0);
                  const loadingPrefix = actionLoading?.startsWith(kw.id);

                  return (
                    <tr key={kw.id} className="border-b border-surface-2/30 hover:bg-surface-2/20 transition-colors">
                      {/* Termo */}
                      <td className="px-3 py-2 max-w-[200px]">
                        <p className="font-medium text-slate-200 truncate" title={kw.keyword_text || kw.keyword}>
                          {normalizeText(kw.keyword_text || kw.keyword) || '—'}
                        </p>
                        <p className="text-slate-600 font-mono truncate text-[10px]">{kw.match_type || kw.keyword_match_type || ''}</p>
                        <p className="text-slate-600 mt-0.5 truncate text-[10px]" title={kw._rec}>{kw._rec}</p>
                      </td>
                      {/* Classe */}
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className={`px-2 py-0.5 rounded-full border font-medium ${cfg_.color}`}>{cfg_.label}</span>
                      </td>
                      {/* Métricas */}
                      <td className="px-3 py-2 text-slate-400">{m.impressions > 0 ? m.impressions.toLocaleString('pt-BR') : '—'}</td>
                      <td className="px-3 py-2 text-slate-400">{m.clicks}</td>
                      <td className="px-3 py-2 text-slate-400">{m.ctr > 0 ? `${m.ctr.toFixed(2)}%` : '—'}</td>
                      <td className="px-3 py-2 text-slate-300">R${m.spend.toFixed(2)}</td>
                      <td className="px-3 py-2 text-slate-400">{m.cpc > 0 ? `R$${m.cpc.toFixed(2)}` : '—'}</td>
                      <td className="px-3 py-2 font-semibold text-slate-200">{m.orders}</td>
                      <td className="px-3 py-2 text-slate-400">{m.cvr > 0 ? `${m.cvr.toFixed(2)}%` : '—'}</td>
                      <td className="px-3 py-2 text-slate-400">{m.cpa > 0 ? `R$${m.cpa.toFixed(2)}` : '—'}</td>
                      <td className="px-3 py-2 text-emerald-400 font-semibold">{m.sales > 0 ? `R$${m.sales.toFixed(2)}` : '—'}</td>
                      <td className="px-3 py-2"><span className={`font-semibold ${acosColor}`}>{m.acos > 0 ? `${m.acos.toFixed(1)}%` : '—'}</span></td>
                      <td className="px-3 py-2"><span className={`font-semibold ${roasColor}`}>{m.roas > 0 ? `${m.roas.toFixed(1)}x` : '—'}</span></td>
                      <td className="px-3 py-2 text-slate-400">{m.rpc > 0 ? `R$${m.rpc.toFixed(2)}` : '—'}</td>
                      <td className="px-3 py-2 text-slate-300">{bidCurrent > 0 ? `R$${bidCurrent.toFixed(2)}` : '—'}</td>
                      <td className="px-3 py-2">
                        <span className={`font-semibold ${kw._bidSuggested > bidCurrent ? 'text-emerald-400' : kw._bidSuggested < bidCurrent ? 'text-amber-400' : 'text-slate-400'}`}>
                          R${kw._bidSuggested.toFixed(2)}
                        </span>
                      </td>
                      {/* Ações */}
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1 flex-wrap">
                          {/* TermBank */}
                          <button onClick={() => addToTermBank(kw, m, kw._bidSuggested)} disabled={!!actionLoading}
                            className="flex items-center gap-0.5 px-1.5 py-1 bg-surface-2 border border-surface-3 text-slate-400 hover:text-cyan hover:border-cyan/30 rounded transition-colors disabled:opacity-40"
                            title="Adicionar ao TermBank">
                            {actionLoading === kw.id + '_tb' ? <Loader2 className="w-3 h-3 animate-spin" /> : <BookOpen className="w-3 h-3" />}
                          </button>

                          {/* EXACT */}
                          <button onClick={() => createVariant(kw, m, 'EXACT')} disabled={!!actionLoading}
                            className="px-1.5 py-1 bg-cyan/10 border border-cyan/20 text-cyan hover:bg-cyan/20 rounded text-[10px] font-bold transition-colors disabled:opacity-40"
                            title={`Criar EXACT · bid R$${(m.cpc * cfg.mult_exact).toFixed(2)}`}>
                            {actionLoading === kw.id + '_EXACT' ? <Loader2 className="w-3 h-3 animate-spin" /> : 'E'}
                          </button>

                          {/* PHRASE */}
                          <button onClick={() => createVariant(kw, m, 'PHRASE')} disabled={!!actionLoading}
                            className="px-1.5 py-1 bg-blue-500/10 border border-blue-500/20 text-blue-400 hover:bg-blue-500/20 rounded text-[10px] font-bold transition-colors disabled:opacity-40"
                            title={`Criar PHRASE · bid R$${(m.cpc * cfg.mult_phrase).toFixed(2)}`}>
                            P
                          </button>

                          {/* BROAD */}
                          <button onClick={() => createVariant(kw, m, 'BROAD')} disabled={!!actionLoading}
                            className="px-1.5 py-1 bg-violet-500/10 border border-violet-500/20 text-violet-400 hover:bg-violet-500/20 rounded text-[10px] font-bold transition-colors disabled:opacity-40"
                            title={`Criar BROAD · bid R$${(m.cpc * cfg.mult_broad).toFixed(2)}`}>
                            B
                          </button>

                          {/* Aumentar bid */}
                          {isWinner && (
                            <button onClick={() => adjustBid(kw, m, 'up')} disabled={!!actionLoading}
                              className="p-1 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 rounded transition-colors disabled:opacity-40"
                              title={`Aumentar bid +${cfg.aumento_vencedor}%`}>
                              {actionLoading === kw.id + '_bid' ? <Loader2 className="w-3 h-3 animate-spin" /> : <TrendingUp className="w-3 h-3" />}
                            </button>
                          )}

                          {/* Reduzir bid */}
                          {(cls === 'inefficient' || cls === 'negate_candidate') && (
                            <button onClick={() => adjustBid(kw, m, 'down')} disabled={!!actionLoading}
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