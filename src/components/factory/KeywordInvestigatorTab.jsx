/**
 * KeywordInvestigatorTab
 *
 * PRIORIDADE 1 (automático): Fontes oficiais Amazon via syncAmazonKeywordSuggestionsByAsin
 *   → Retorna sugestões da Amazon Ads API para o ASIN selecionado.
 *
 * PRIORIDADE 2 (sob demanda, desativado por padrão): ScrapingBee
 *   → Pesquisa pública complementar. Requer toggle explícito + confirmação.
 *   → Kill switch: se ScrapingBee retornar erro, desativa automaticamente.
 *   → Limite visual: aviso de consumo de créditos antes de executar.
 */
import { useMemo, useState } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Search, Loader2, Sparkles, TrendingUp, Tag, ShoppingCart,
  Package, AlertCircle, CheckCircle, Copy, ChevronDown, ChevronUp,
  Plus, Zap, AlertTriangle, ToggleLeft, ToggleRight, Shield
} from 'lucide-react';

const SECTION_CONFIG = {
  suggestions:        { label: 'Autocomplete Amazon',  color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20', icon: Search },
  related:            { label: 'Buscas Relacionadas',  color: 'text-cyan',        bg: 'bg-cyan/10 border-cyan/20',               icon: TrendingUp },
  sponsored_keywords: { label: 'Termos Patrocinados',  color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/20',     icon: Tag },
  organic_titles:     { label: 'Títulos Orgânicos',    color: 'text-violet-400',  bg: 'bg-violet-500/10 border-violet-500/20',   icon: ShoppingCart },
  product_keywords:   { label: 'Keywords do Produto',  color: 'text-blue-400',    bg: 'bg-blue-500/10 border-blue-500/20',       icon: Package },
  people_also_buy:    { label: 'Compram Juntos',        color: 'text-pink-400',    bg: 'bg-pink-500/10 border-pink-500/20',       icon: Plus },
};

function KeywordChip({ text, onCopy, copied }) {
  return (
    <button
      onClick={() => onCopy(text)}
      title="Copiar keyword"
      className={`group inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs border transition-colors ${
        copied === text
          ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
          : 'bg-surface-2 border-surface-3 text-slate-300 hover:border-cyan/40 hover:text-white hover:bg-surface-3'
      }`}
    >
      {copied === text
        ? <CheckCircle className="w-3 h-3 flex-shrink-0" />
        : <Copy className="w-3 h-3 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
      }
      <span className="truncate max-w-[200px]">{text}</span>
    </button>
  );
}

function ResultSection({ sectionKey, items, copied, onCopy, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!items || items.length === 0) return null;
  const cfg = SECTION_CONFIG[sectionKey] || { label: sectionKey, color: 'text-slate-400', bg: 'bg-surface-2 border-surface-3', icon: Search };
  const Icon = cfg.icon;
  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-2/40 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className={`flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-lg border ${cfg.bg} ${cfg.color}`}>
            <Icon className="w-3 h-3" />
            {cfg.label}
          </span>
          <span className="text-[10px] text-slate-500">{items.length} termos</span>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
      </button>
      {open && (
        <div className="px-4 pb-4">
          <div className="flex flex-wrap gap-1.5">
            {items.map((kw, i) => (
              <KeywordChip key={i} text={kw} onCopy={onCopy} copied={copied} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Resultado das sugestões oficiais da Amazon Ads
function AmazonAdsResults({ suggestions, asin }) {
  const [copied, setCopied] = useState(null);
  const [copiedAll, setCopiedAll] = useState(false);

  const handleCopy = (text) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(text);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleCopyAll = () => {
    navigator.clipboard.writeText(suggestions.map(s => s.keyword || s).join('\n')).catch(() => {});
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 3000);
  };

  if (!suggestions || suggestions.length === 0) return null;

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-2">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-lg border bg-emerald-500/10 border-emerald-500/20 text-emerald-400">
            <Zap className="w-3 h-3" />
            Amazon Ads API
          </span>
          <span className="text-[10px] text-slate-500">{suggestions.length} sugestões · {asin}</span>
          <span className="text-[9px] px-1.5 py-0.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-full">oficial</span>
        </div>
        <button
          onClick={handleCopyAll}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
            copiedAll ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300' : 'bg-surface-2 border-surface-3 text-slate-300 hover:text-white'
          }`}
        >
          {copiedAll ? <CheckCircle className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copiedAll ? 'Copiado!' : 'Copiar todas'}
        </button>
      </div>
      <div className="px-4 py-4">
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((s, i) => {
            const kw = typeof s === 'string' ? s : (s.keyword || s.keywordText || '');
            return <KeywordChip key={i} text={kw} onCopy={handleCopy} copied={copied} />;
          })}
        </div>
      </div>
    </div>
  );
}

const normalizeKeyword = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const STOPWORDS = new Set(['de', 'do', 'da', 'dos', 'das', 'para', 'com', 'sem', 'por', 'uma', 'um', 'e', 'o', 'a']);
const BLOCKED_BRANDS = /\b(oster|tramontina|onikuma|coibeu)\b/i;
const IRRELEVANT_PATTERNS = /\b(taca|taça|secador|porta vinho|porta rolhas|abridor de lata|kit de vinho|presente)\b/i;

function classifyProductRelevance(keyword, productTitle) {
  const normalized = normalizeKeyword(keyword);
  if (BLOCKED_BRANDS.test(normalized)) return { allowed: false, score: 0, label: 'Bloqueada', reason: 'Marca de terceiro' };
  if (IRRELEVANT_PATTERNS.test(normalized)) return { allowed: false, score: 0, label: 'Bloqueada', reason: 'Produto/acessório incompatível' };

  const titleTokens = normalizeKeyword(productTitle).split(' ').filter((token) => token.length >= 4 && !STOPWORDS.has(token));
  const matches = titleTokens.filter((token) => normalized.includes(token));
  const wineOpenerProduct = /\b(vinho|rolha)\b/i.test(productTitle) && /\b(abridor|saca|rolha|sacarolha|descorchador)\b/i.test(productTitle);
  const openerAnchor = /\b(abridor|saca\s*rolha|sacarolha|sacarrolha|descorchador|rolha)\b/i.test(normalized);
  if (wineOpenerProduct && !openerAnchor) return { allowed: false, score: 0, label: 'Bloqueada', reason: 'Busca genérica de vinho, sem intenção de abridor' };

  const specificity = Math.min(18, normalized.split(' ').length * 3);
  const score = Math.min(100, 38 + Math.min(48, matches.length * 16) + specificity + (openerAnchor ? 10 : 0));
  if (matches.length === 0 && !openerAnchor) return { allowed: false, score: 0, label: 'Bloqueada', reason: 'Sem aderência ao título do produto' };
  return { allowed: true, score, label: score >= 78 ? 'Prioridade alta' : score >= 60 ? 'Teste controlado' : 'Baixa prioridade', reason: matches.length ? `Aderência: ${matches.slice(0, 3).join(', ')}` : 'Sinônimo aderente' };
}

function sortValue(row, key) {
  const value = row[key];
  return typeof value === 'number' ? value : String(value || '').toLocaleLowerCase('pt-BR');
}

export default function KeywordInvestigatorTab({ account, products = [], terms = [] }) {
  // ── Amazon Ads (fonte 1 — padrão) ──────────────────────────────────────
  const [selectedAsin, setSelectedAsin] = useState('');
  const [loadingAmazon, setLoadingAmazon] = useState(false);
  const [amazonResult, setAmazonResult] = useState(null);
  const [amazonError, setAmazonError] = useState(null);

  // ── ScrapingBee (fonte 2 — sob demanda) ────────────────────────────────
  const [scrapingEnabled, setScrapingEnabled] = useState(false);
  const [scrapingKilled, setScrapingKilled] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [asinManual, setAsinManual] = useState('');
  const [loadingScraping, setLoadingScraping] = useState(false);
  const [scrapingResult, setScrapingResult] = useState(null);
  const [scrapingError, setScrapingError] = useState(null);
  const [copied, setCopied] = useState(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [sortKey, setSortKey] = useState('score');
  const [sortDir, setSortDir] = useState('desc');

  const selectedProduct = useMemo(
    () => products.find((product) => product.asin === selectedAsin),
    [products, selectedAsin],
  );
  const productOptions = useMemo(() => [...products].sort((a, b) =>
    String(a.product_name || a.display_name || a.title || '').localeCompare(
      String(b.product_name || b.display_name || b.title || ''), 'pt-BR'
    )
  ), [products]);

  const investigationRows = useMemo(() => {
    const byKeyword = new Map();
    const productTitle = selectedProduct?.product_name || selectedProduct?.display_name || selectedProduct?.title || '';
    const add = (keywordText, source, baseScore = 40) => {
      const keywordValue = normalizeKeyword(keywordText);
      if (keywordValue.length < 3) return;
      const relevance = classifyProductRelevance(keywordValue, productTitle);
      if (!relevance.allowed) return;
      const existing = byKeyword.get(keywordValue) || {
        keyword: keywordValue, source: [], organic_score: 0, paid_impressions: 0,
        paid_sales: 0, paid_orders: 0, paid_spend: 0, score: 0, classification: relevance.label, reason: relevance.reason,
      };
      existing.source = [...new Set([...existing.source, source])];
      existing.score = Math.max(existing.score, Math.round((baseScore * 0.35) + (relevance.score * 0.65)));
      if (source === 'Orgânico inferido') existing.organic_score = Math.max(existing.organic_score, baseScore);
      byKeyword.set(keywordValue, existing);
    };

    if (scrapingResult) {
      (scrapingResult.suggestions || []).forEach((item) => add(item, 'Autocomplete Amazon', 82));
      (scrapingResult.related || []).forEach((item) => add(item, 'Busca relacionada', 76));
      (scrapingResult.sponsored_keywords || []).forEach((item) => add(item, 'Patrocinado inferido', 68));
      (scrapingResult.organic_titles || []).forEach((item) => add(item, 'Orgânico inferido', 62));
      (scrapingResult.product_keywords || []).forEach((item) => add(item, 'Página do concorrente', 58));
    }
    (amazonResult?.suggestions || []).forEach((item) => add(item.keyword || item.keywordText || item, 'Sugestão Amazon Ads', 88));

    terms.filter((term) => term.asin === selectedAsin).forEach((term) => {
      const keywordValue = normalizeKeyword(term.term || term.keyword);
      if (!keywordValue) return;
      add(keywordValue, 'Dados Ads da conta', 55);
      const row = byKeyword.get(keywordValue);
      row.paid_impressions += Number(term.impressions || 0);
      row.paid_sales += Number(term.sales || 0);
      row.paid_orders += Number(term.orders || 0);
      row.paid_spend += Number(term.spend || 0);
      row.score = Math.min(100, Math.max(row.score, Math.round(
        45 + Math.min(30, row.paid_impressions / 100) + Math.min(20, row.paid_orders * 5) + Math.min(15, row.paid_sales / 50)
      )));
      row.classification = row.paid_orders >= 2 ? 'Comprovada' : row.paid_orders >= 1 ? 'Validar exact' : row.classification;
      row.reason = row.paid_orders >= 1 ? `${row.paid_orders} pedido(s) confirmado(s) na conta` : row.reason;
    });

    return [...byKeyword.values()]
      .map((row) => ({ ...row, contribution: row.paid_sales > 0 ? row.paid_sales / Math.max(1, [...byKeyword.values()].reduce((sum, item) => sum + item.paid_sales, 0)) * 100 : 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 200);
  }, [amazonResult, scrapingResult, selectedAsin, selectedProduct, terms]);

  const sortedRows = useMemo(() => [...investigationRows].sort((a, b) => {
    const left = sortValue(a, sortKey); const right = sortValue(b, sortKey);
    if (left === right) return 0;
    const result = left > right ? 1 : -1;
    return sortDir === 'asc' ? result : -result;
  }), [investigationRows, sortKey, sortDir]);

  const toggleSort = (key) => {
    if (key === sortKey) setSortDir((direction) => direction === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  // ── Amazon Ads handler ─────────────────────────────────────────────────
  const handleAmazonSearch = async () => {
    if (!selectedAsin || loadingAmazon) return;
    setLoadingAmazon(true);
    setAmazonError(null);
    setAmazonResult(null);
    try {
      const res = await base44.functions.invoke('syncAmazonKeywordSuggestionsByAsin', {
        amazon_account_id: account.id,
        asin: selectedAsin,
      });
      const data = res?.data || res;
      if (data?.ok || data?.synced >= 0 || Array.isArray(data?.suggestions)) {
        // Lê as sugestões do banco após sync
        const sugs = await base44.entities.KeywordSuggestion.filter(
          { amazon_account_id: account.id, asin: selectedAsin },
          '-created_at', 100
        ).catch(() => []);
        setAmazonResult({ asin: selectedAsin, suggestions: sugs });
      } else {
        setAmazonError(data?.error || 'Erro ao buscar sugestões Amazon Ads');
      }
    } catch (e) {
      setAmazonError(e.message);
    } finally {
      setLoadingAmazon(false);
    }
  };

  // ── ScrapingBee handler ────────────────────────────────────────────────
  const handleScrapingSearch = async () => {
    const derivedKeyword = keyword.trim() || String(selectedProduct?.product_name || selectedProduct?.display_name || selectedProduct?.title || '').trim();
    if (!derivedKeyword || loadingScraping || scrapingKilled) return;
    setLoadingScraping(true);
    setScrapingError(null);
    setScrapingResult(null);
    try {
      const res = await base44.functions.invoke('scrapeAmazonKeywords', {
        keyword: derivedKeyword,
        asin: asinManual.trim() || undefined,
        marketplace: 'BR',
      });
      const data = res?.data || res;
      if (data?.ok) {
        setScrapingResult(data);
      } else {
        // Kill switch: erro do ScrapingBee → desativa
        setScrapingKilled(true);
        setScrapingEnabled(false);
        setScrapingError(data?.error || 'ScrapingBee indisponível — pesquisa pública desativada automaticamente.');
      }
    } catch (e) {
      setScrapingKilled(true);
      setScrapingEnabled(false);
      setScrapingError('Erro de conexão com ScrapingBee — pesquisa pública desativada.');
    } finally {
      setLoadingScraping(false);
    }
  };

  const handleCopy = (text) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(text);
    setTimeout(() => setCopied(null), 2000);
  };

  const getAllScrapingKeywords = () => {
    if (!scrapingResult) return [];
    const all = new Set([
      ...(scrapingResult.suggestions || []),
      ...(scrapingResult.related || []),
      ...(scrapingResult.sponsored_keywords || []),
      ...(scrapingResult.organic_titles || []),
      ...(scrapingResult.product_keywords || []),
      ...(scrapingResult.people_also_buy || []),
    ]);
    return Array.from(all);
  };

  const handleCopyAll = () => {
    const all = getAllScrapingKeywords();
    navigator.clipboard.writeText(all.join('\n')).catch(() => {});
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 3000);
  };

  return (
    <div className="space-y-5">

      {/* ── FONTE 1: Amazon Ads API ───────────────────────────────────────── */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2 mb-1">
          <Zap className="w-4 h-4 text-emerald-400" />
          <p className="text-xs font-bold text-white">Sugestões Amazon Ads (Oficial)</p>
          <span className="text-[9px] px-1.5 py-0.5 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-full">prioridade 1</span>
        </div>
        <p className="text-[10px] text-slate-500">
          Busca sugestões de keywords diretamente da Amazon Ads API para o ASIN selecionado. Dados oficiais, sem custo adicional.
        </p>
        <div className="flex gap-3 flex-wrap items-end">
          {products && products.length > 0 ? (
            <div className="flex-1 min-w-[220px]">
              <label className="text-[10px] text-slate-500 font-semibold uppercase mb-1 block">Produto / ASIN</label>
              <select
                value={selectedAsin}
                onChange={e => setSelectedAsin(e.target.value)}
                className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-xs text-slate-300 focus:outline-none"
              >
                <option value="">— selecionar produto —</option>
                {productOptions.map(p => (
                  <option key={p.id} value={p.asin}>
                    {p.asin} · {(p.product_name || p.display_name || '').slice(0, 35)}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="flex-1 min-w-[180px]">
              <label className="text-[10px] text-slate-500 font-semibold uppercase mb-1 block">ASIN</label>
              <input
                value={selectedAsin}
                onChange={e => setSelectedAsin(e.target.value.trim().toUpperCase())}
                placeholder="B0CX..."
                className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan/50 font-mono"
                maxLength={12}
              />
            </div>
          )}
          <button
            onClick={handleAmazonSearch}
            disabled={loadingAmazon || !selectedAsin}
            className="flex items-center gap-2 px-5 py-2 bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 text-sm font-semibold rounded-lg disabled:opacity-50 transition-colors"
          >
            {loadingAmazon ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            {loadingAmazon ? 'Buscando...' : 'Buscar via Amazon Ads'}
          </button>
        </div>

        {amazonError && (
          <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
            {amazonError}
          </div>
        )}
      </div>

      {/* Resultado Amazon Ads */}
      {amazonResult && !loadingAmazon && (
        <AmazonAdsResults suggestions={amazonResult.suggestions} asin={amazonResult.asin} />
      )}

      {/* ── FONTE 2: ScrapingBee (sob demanda) ───────────────────────────── */}
      {false && (<div className={`border rounded-xl p-4 space-y-3 ${scrapingKilled ? 'border-red-500/20 bg-red-500/5' : 'border-surface-2 bg-surface-1'}`}>
        {/* Header com toggle */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-slate-400" />
            <p className="text-xs font-bold text-slate-300">Pesquisa Pública (ScrapingBee)</p>
            <span className="text-[9px] px-1.5 py-0.5 bg-slate-500/15 border border-slate-500/20 text-slate-400 rounded-full">opcional · sob demanda</span>
            {scrapingKilled && (
              <span className="text-[9px] px-1.5 py-0.5 bg-red-500/15 border border-red-500/20 text-red-400 rounded-full">desativado automaticamente</span>
            )}
          </div>
          {!scrapingKilled && (
            <button
              onClick={() => setScrapingEnabled(v => !v)}
              className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors ${
                scrapingEnabled
                  ? 'bg-amber-500/15 border-amber-500/30 text-amber-300'
                  : 'bg-surface-2 border-surface-3 text-slate-400 hover:text-slate-300'
              }`}
            >
              {scrapingEnabled
                ? <ToggleRight className="w-4 h-4" />
                : <ToggleLeft className="w-4 h-4" />
              }
              {scrapingEnabled ? 'Ativado' : 'Ativar'}
            </button>
          )}
        </div>

        {!scrapingEnabled && !scrapingKilled && (
          <p className="text-[10px] text-slate-600">
            Extrai sugestões de autocomplete, buscas relacionadas e termos patrocinados diretamente da Amazon BR via scraping.
            Complementar às fontes oficiais. Desativado por padrão para conservar créditos ScrapingBee.
          </p>
        )}

        {scrapingKilled && (
          <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/15 rounded-lg text-xs text-red-400">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            {scrapingError || 'ScrapingBee indisponível. Kill switch acionado automaticamente.'}
          </div>
        )}

        {scrapingEnabled && !scrapingKilled && (
          <div className="space-y-3">
            {/* Aviso de consumo */}
            <div className="flex items-start gap-2 px-3 py-2 bg-amber-500/8 border border-amber-500/20 rounded-lg">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
              <p className="text-[10px] text-amber-300">
                Cada pesquisa consome créditos ScrapingBee. Use apenas quando as sugestões da Amazon Ads não forem suficientes.
              </p>
            </div>
            <div className="flex gap-3 flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <label className="text-[10px] text-slate-500 font-semibold uppercase mb-1 block">Keyword-base (opcional se escolher produto)</label>
                <input
                  value={keyword}
                  onChange={e => setKeyword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleScrapingSearch()}
                  placeholder="ex: organizador de gaveta; se vazio, usa o título do produto"
                  className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan/50"
                />
              </div>
              <div className="w-44">
                <label className="text-[10px] text-slate-500 font-semibold uppercase mb-1 block">ASIN (opcional)</label>
                <input
                  value={asinManual}
                  onChange={e => setAsinManual(e.target.value.trim().toUpperCase())}
                  placeholder="ASIN do concorrente (B0...)"
                  className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan/50 font-mono"
                  maxLength={12}
                />
              </div>
            </div>
            <button
              onClick={handleScrapingSearch}
              disabled={loadingScraping || (!keyword.trim() && !selectedProduct)}
              className="flex items-center gap-2 px-5 py-2 bg-violet-500/20 border border-violet-500/35 text-violet-300 hover:bg-violet-500/30 text-sm font-semibold rounded-lg disabled:opacity-50 transition-colors"
            >
              {loadingScraping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              {loadingScraping ? 'Investigando...' : 'Pesquisar via ScrapingBee'}
            </button>
            {loadingScraping && (
              <div className="flex flex-col items-center justify-center py-8 gap-2">
                <Loader2 className="w-6 h-6 text-violet-400 animate-spin" />
                <p className="text-xs text-slate-400">Consultando Amazon via ScrapingBee... 5–15s</p>
              </div>
            )}
          </div>
        )}
      </div>)}

      {/* Resultados da fonte externa removida. */}
      {false && scrapingResult && !loadingScraping && (
        <div className="space-y-3">
           <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-xs font-semibold text-white">{getAllScrapingKeywords().length} keywords únicas</span>
              <span className="text-[10px] text-slate-500">para "{scrapingResult.keyword}"</span>
              {scrapingResult.asin && <span className="text-[10px] font-mono text-cyan">{scrapingResult.asin}</span>}
              <span className="text-[9px] px-1.5 py-0.5 bg-violet-500/10 border border-violet-500/20 text-violet-400 rounded-full">ScrapingBee</span>
            </div>
            <button
              onClick={handleCopyAll}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                copiedAll ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300' : 'bg-surface-2 border-surface-3 text-slate-300 hover:text-white'
              }`}
            >
              {copiedAll ? <CheckCircle className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedAll ? 'Copiado!' : 'Copiar todas'}
            </button>
          </div>
          {scrapingResult.warning && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
              {scrapingResult.warning} Tente um ASIN concorrente ou uma keyword mais específica.
            </div>
          )}
          {Object.keys(SECTION_CONFIG).map(key => (
            <ResultSection
              key={key}
              sectionKey={key}
              items={scrapingResult[key]}
              copied={copied}
              onCopy={handleCopy}
              defaultOpen={key === 'suggestions' || key === 'related'}
            />
          ))}
          {getAllScrapingKeywords().length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 gap-2 text-slate-500">
              <Search className="w-8 h-8 opacity-30" />
              <p className="text-sm">Nenhuma keyword encontrada.</p>
            </div>
          )}
        </div>
      )}

      {amazonResult && (
        <div className="overflow-hidden rounded-xl border border-surface-2 bg-surface-1">
          <div className="border-b border-surface-2 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-white">Tabela de investigação — até 200 keywords</h3>
                <p className="mt-1 text-[10px] text-slate-500">Produto próprio: {selectedProduct?.product_name || selectedAsin || 'não selecionado'} · Concorrente: {asinManual || 'não informado'}</p>
              </div>
              <span className="rounded-full border border-violet-500/25 bg-violet-500/10 px-2 py-1 text-[10px] font-semibold text-violet-300">{sortedRows.length} classificadas</span>
            </div>
            <p className="mt-2 text-[10px] text-slate-500">Impressões, vendas e contribuição são dados da sua conta Amazon Ads. A tabela remove marcas de terceiros, acessórios incompatíveis e buscas genéricas; relevância orgânica continua sendo uma inferência pública.</p>
          </div>
          <div className="max-h-[540px] overflow-auto">
            <table className="w-full min-w-[860px] text-left text-xs">
              <thead className="sticky top-0 bg-surface-2 text-[10px] uppercase tracking-wide text-slate-500">
                <tr>{[
                  ['keyword', 'Keyword'], ['classification', 'Classificação'], ['source', 'Fontes'], ['organic_score', 'Orgânico*'], ['paid_impressions', 'Impressões Ads'], ['paid_sales', 'Vendas Ads'], ['contribution', 'Contribuição'], ['score', 'Score'],
                ].map(([key, label]) => <th key={key} className="whitespace-nowrap px-3 py-2 font-semibold"><button onClick={() => toggleSort(key)} className="hover:text-cyan">{label} {sortKey === key ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}</button></th>)}</tr>
              </thead>
              <tbody>{sortedRows.map((row) => <tr key={row.keyword} className="border-t border-surface-2/70 text-slate-300"><td className="px-3 py-2 font-medium text-white">{row.keyword}<p className="mt-0.5 text-[9px] text-slate-500">{row.reason}</p></td><td className="px-3 py-2 text-[10px] text-cyan">{row.classification}</td><td className="px-3 py-2 text-[10px] text-slate-400">{row.source.join(' · ')}</td><td className="px-3 py-2">{row.organic_score || '—'}</td><td className="px-3 py-2">{row.paid_impressions.toLocaleString('pt-BR')}</td><td className="px-3 py-2">R${row.paid_sales.toFixed(2)}</td><td className="px-3 py-2">{row.contribution.toFixed(1)}%</td><td className="px-3 py-2 font-semibold text-emerald-400">{row.score}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
