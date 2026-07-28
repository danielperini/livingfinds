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
import { useState } from 'react';
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

export default function KeywordInvestigatorTab({ account, products }) {
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
    if (!keyword.trim() || loadingScraping || scrapingKilled) return;
    setLoadingScraping(true);
    setScrapingError(null);
    setScrapingResult(null);
    try {
      const res = await base44.functions.invoke('scrapeAmazonKeywords', {
        keyword: keyword.trim(),
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
                {products.slice(0, 100).map(p => (
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
      <div className={`border rounded-xl p-4 space-y-3 ${scrapingKilled ? 'border-red-500/20 bg-red-500/5' : 'border-surface-2 bg-surface-1'}`}>
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
                <label className="text-[10px] text-slate-500 font-semibold uppercase mb-1 block">Keyword de Busca *</label>
                <input
                  value={keyword}
                  onChange={e => setKeyword(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleScrapingSearch()}
                  placeholder="ex: organizador de gaveta..."
                  className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan/50"
                />
              </div>
              <div className="w-44">
                <label className="text-[10px] text-slate-500 font-semibold uppercase mb-1 block">ASIN (opcional)</label>
                <input
                  value={asinManual}
                  onChange={e => setAsinManual(e.target.value.trim().toUpperCase())}
                  placeholder="B0CX..."
                  className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan/50 font-mono"
                  maxLength={12}
                />
              </div>
            </div>
            <button
              onClick={handleScrapingSearch}
              disabled={loadingScraping || !keyword.trim()}
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
      </div>

      {/* Resultados ScrapingBee */}
      {scrapingResult && !loadingScraping && (
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
    </div>
  );
}