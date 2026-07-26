import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Search, Loader2, Sparkles, TrendingUp, Tag, ShoppingCart,
  Package, AlertCircle, CheckCircle, Copy, ChevronDown, ChevronUp, Plus
} from 'lucide-react';

const SECTION_CONFIG = {
  suggestions:       { label: 'Autocomplete Amazon',    color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20', icon: Search },
  related:           { label: 'Buscas Relacionadas',    color: 'text-cyan',        bg: 'bg-cyan/10 border-cyan/20',               icon: TrendingUp },
  sponsored_keywords:{ label: 'Termos Patrocinados',    color: 'text-amber-400',   bg: 'bg-amber-500/10 border-amber-500/20',     icon: Tag },
  organic_titles:    { label: 'Títulos Orgânicos',      color: 'text-violet-400',  bg: 'bg-violet-500/10 border-violet-500/20',   icon: ShoppingCart },
  product_keywords:  { label: 'Keywords do Produto',    color: 'text-blue-400',    bg: 'bg-blue-500/10 border-blue-500/20',       icon: Package },
  people_also_buy:   { label: 'Compram Juntos',         color: 'text-pink-400',    bg: 'bg-pink-500/10 border-pink-500/20',       icon: Plus },
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
      {copied === text ? <CheckCircle className="w-3 h-3 flex-shrink-0" /> : <Copy className="w-3 h-3 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />}
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

export default function KeywordInvestigatorTab({ account, products }) {
  const [keyword, setKeyword] = useState('');
  const [asin, setAsin] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(null);
  const [copiedAll, setCopiedAll] = useState(false);

  const handleSearch = async () => {
    if (!keyword.trim() || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await base44.functions.invoke('scrapeAmazonKeywords', {
        keyword: keyword.trim(),
        asin: asin.trim() || undefined,
        marketplace: 'BR',
      });
      const data = res?.data || res;
      if (data?.ok) {
        setResult(data);
      } else {
        setError(data?.error || 'Erro ao buscar keywords');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = (text) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(text);
    setTimeout(() => setCopied(null), 2000);
  };

  const getAllKeywords = () => {
    if (!result) return [];
    const all = new Set([
      ...(result.suggestions || []),
      ...(result.related || []),
      ...(result.sponsored_keywords || []),
      ...(result.organic_titles || []),
      ...(result.product_keywords || []),
      ...(result.people_also_buy || []),
    ]);
    return Array.from(all);
  };

  const handleCopyAll = () => {
    const all = getAllKeywords();
    navigator.clipboard.writeText(all.join('\n')).catch(() => {});
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 3000);
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start gap-3 px-4 py-3 bg-violet-500/5 border border-violet-500/15 rounded-xl">
        <Sparkles className="w-4 h-4 text-violet-400 flex-shrink-0 mt-0.5" />
        <div>
          <p className="text-xs font-semibold text-violet-300">Keyword Investigator — Powered by ScrapingBee</p>
          <p className="text-[10px] text-slate-400 mt-0.5">
            Extrai sugestões de autocomplete, buscas relacionadas, termos patrocinados e orgânicos diretamente da Amazon BR.
            Insira uma keyword de pesquisa ou ASIN de produto para descobrir oportunidades.
          </p>
        </div>
      </div>

      {/* Form */}
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-4 space-y-3">
        <div className="flex gap-3 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <label className="text-[10px] text-slate-500 font-semibold uppercase mb-1 block">Keyword de Busca *</label>
            <input
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder="ex: organizador de gaveta, capa notebook..."
              className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan/50"
            />
          </div>
          <div className="w-48">
            <label className="text-[10px] text-slate-500 font-semibold uppercase mb-1 block">ASIN (opcional)</label>
            <div className="flex gap-2">
              <input
                value={asin}
                onChange={e => setAsin(e.target.value.trim().toUpperCase())}
                placeholder="B0CX..."
                className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan/50 font-mono"
                maxLength={12}
              />
            </div>
          </div>
          {products && products.length > 0 && (
            <div className="w-56">
              <label className="text-[10px] text-slate-500 font-semibold uppercase mb-1 block">Ou selecione produto</label>
              <select
                onChange={e => {
                  const p = products.find(p => p.asin === e.target.value);
                  if (p) { setAsin(p.asin); if (!keyword) setKeyword(p.product_name?.split(' ').slice(0, 3).join(' ') || ''); }
                }}
                className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-xs text-slate-300 focus:outline-none"
              >
                <option value="">— selecionar —</option>
                {products.slice(0, 50).map(p => (
                  <option key={p.id} value={p.asin}>{p.asin} · {(p.product_name || p.display_name || '').slice(0, 30)}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        <button
          onClick={handleSearch}
          disabled={loading || !keyword.trim()}
          className="flex items-center gap-2 px-5 py-2 bg-violet-500/20 border border-violet-500/35 text-violet-300 hover:bg-violet-500/30 text-sm font-semibold rounded-lg disabled:opacity-50 transition-colors"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          {loading ? 'Investigando...' : 'Investigar Keywords'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-400">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <Loader2 className="w-8 h-8 text-violet-400 animate-spin" />
          <p className="text-sm text-slate-400">Consultando Amazon via ScrapingBee...</p>
          <p className="text-xs text-slate-600">Isso pode levar 5–15 segundos</p>
        </div>
      )}

      {/* Results */}
      {result && !loading && (
        <div className="space-y-3">
          {/* Summary bar */}
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-xs font-semibold text-white">{getAllKeywords().length} keywords únicas encontradas</span>
              <span className="text-[10px] text-slate-500">para "{result.keyword}"</span>
              {result.asin && <span className="text-[10px] font-mono text-cyan">{result.asin}</span>}
            </div>
            <button
              onClick={handleCopyAll}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                copiedAll
                  ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                  : 'bg-surface-2 border-surface-3 text-slate-300 hover:text-white'
              }`}
            >
              {copiedAll ? <CheckCircle className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedAll ? 'Copiado!' : 'Copiar todas'}
            </button>
          </div>

          {/* Sections */}
          {Object.keys(SECTION_CONFIG).map(key => (
            <ResultSection
              key={key}
              sectionKey={key}
              items={result[key]}
              copied={copied}
              onCopy={handleCopy}
              defaultOpen={key === 'suggestions' || key === 'related'}
            />
          ))}

          {getAllKeywords().length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 gap-2 text-slate-500">
              <Search className="w-8 h-8 opacity-30" />
              <p className="text-sm">Nenhuma keyword encontrada para esta busca.</p>
              <p className="text-xs">Tente uma keyword diferente ou verifique se o ASIN está correto.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}