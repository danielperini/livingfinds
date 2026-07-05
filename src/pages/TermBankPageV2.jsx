import { useCallback, useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { BookOpen, Loader2, RefreshCw, Search, Trash2, AlertTriangle } from 'lucide-react';
import SuggestionsPanel from '@/components/termbank/SuggestionsPanel';

const fmt = (v, d = 2) => Number(v || 0).toFixed(d).replace('.', ',');

export default function TermBankPageV2() {
  const [terms, setTerms] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [products, setProducts] = useState([]);
  const [tab, setTab] = useState('suggestions');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState(null);
  const [message, setMessage] = useState(null);
  const [cleaning, setCleaning] = useState(false);

  // Top 10 por produto: agrupar sugestões por asin e pegar as 10 mais relevantes
  const top10Suggestions = (() => {
    const byAsin = {};
    for (const s of suggestions) {
      if (!byAsin[s.asin]) byAsin[s.asin] = [];
      byAsin[s.asin].push(s);
    }
    const result = [];
    for (const asin of Object.keys(byAsin)) {
      const sorted = [...byAsin[asin]].sort((a, b) =>
        (b.relevance_score || b.confidence || 0) - (a.relevance_score || a.confidence || 0)
      );
      result.push(...sorted.slice(0, 10));
    }
    return result;
  })();

  const excessCount = suggestions.length - top10Suggestions.length;

  const cleanExcess = async () => {
    if (excessCount <= 0) return;
    setCleaning(true);
    setMessage(null);
    try {
      const keepIds = new Set(top10Suggestions.map(s => s.id));
      const toDelete = suggestions.filter(s => !keepIds.has(s.id));
      await Promise.all(toDelete.map(s => base44.entities.KeywordSuggestion.delete(s.id)));
      setMessage({ type: 'success', text: `✓ ${toDelete.length} sugestões excedentes removidas. Mantidas as top 10 por produto.` });
      await load();
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    } finally {
      setCleaning(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      if (!accounts.length) accounts = await base44.entities.AmazonAccount.list();
      const account = accounts[0];
      if (!account) return;
      const [t, s, p] = await Promise.all([
        base44.entities.TermBank.filter({ amazon_account_id: account.id }, '-performance_score', 1000),
        base44.entities.KeywordSuggestion.filter({ amazon_account_id: account.id }, '-created_at', 1000),
        base44.entities.Product.filter({ amazon_account_id: account.id }, '-updated_at', 2000),
      ]);
      setTerms(t);
      setSuggestions(s.filter((x) => x.status !== 'rejected' && x.deleted_by_user !== true));
      setProducts(p);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function review(suggestion, action) {
    setWorkingId(suggestion.id);
    setMessage(null);
    try {
      const res = await base44.functions.invoke('reviewKeywordSuggestion', { suggestion_id: suggestion.id, action });
      const data = res?.data || {};
      if (!data.ok) throw new Error(data.error || 'Falha ao processar sugestão');

      if (action === 'approve') {
        const campStatus = data.campaign_status;
        const statusLabels = {
          enabled: '✅ Campanha ativa',
          active: '✅ Campanha ativa',
          created: '✅ Campanha criada',
          incomplete: '⚠️ Campanha incompleta (reparo agendado)',
          paused: '⏸ Campanha pausada',
          archived: '📦 Campanha arquivada',
          failed: '❌ Falha ao criar campanha',
        };
        const statusText = statusLabels[campStatus] || '✅ Campanha criada';
        setMessage({ type: campStatus === 'failed' ? 'error' : 'success', text: `${statusText} para "${suggestion.keyword}" (${data.product_name || suggestion.asin}). Termo adicionado ao TermBank.` });
      } else {
        setMessage({ type: 'success', text: 'Sugestão removida.' });
      }
      await load();
    } catch (e) {
      setMessage({ type: 'error', text: e?.response?.data?.error || e.message });
    } finally {
      setWorkingId(null);
    }
  }

  const q = search.toLowerCase();
  const filteredSuggestions = suggestions.filter((s) => `${s.keyword || ''} ${s.asin || ''} ${s.sku || ''}`.toLowerCase().includes(q));
  const filteredTerms = terms.filter((t) => `${t.term || ''} ${t.asin || ''} ${t.product_name || ''}`.toLowerCase().includes(q));

  return <div className="space-y-5 p-6">
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <BookOpen className="h-5 w-5 text-violet-400" />
        <div>
          <h1 className="text-lg font-bold text-white">Banco de Termos</h1>
          <p className="text-xs text-slate-400">{terms.length} termos · {terms.filter(t => t.status === 'active').length} ativos · {top10Suggestions.length} sugestões (top 10/produto)</p>
        </div>
      </div>
      <button onClick={load} className="rounded-lg border border-surface-3 p-2 text-slate-300">
        <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
      </button>
    </div>

    {excessCount > 0 && (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/8 px-4 py-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-400 flex-shrink-0" />
          <p className="text-sm text-amber-300">
            <strong>{excessCount}</strong> sugestões excedentes ao limite de 10 por produto.
            Removê-las libera créditos e mantém a lista organizada.
          </p>
        </div>
        <button onClick={cleanExcess} disabled={cleaning}
          className="flex items-center gap-1.5 rounded-lg bg-amber-500/20 border border-amber-500/40 px-3 py-1.5 text-xs font-semibold text-amber-300 hover:bg-amber-500/30 transition-colors disabled:opacity-50 flex-shrink-0">
          {cleaning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          {cleaning ? 'Limpando...' : 'Limpar excesso'}
        </button>
      </div>
    )}

    <div className="flex gap-2 border-b border-surface-2">
      <button onClick={() => setTab('terms')} className={`px-4 py-3 text-sm ${tab === 'terms' ? 'border-b-2 border-violet-400 text-violet-400' : 'text-slate-500'}`}>📚 TermBank ({terms.length})</button>
      <button onClick={() => setTab('suggestions')} className={`px-4 py-3 text-sm ${tab === 'suggestions' ? 'border-b-2 border-violet-400 text-violet-400' : 'text-slate-500'}`}>🤖 Sugestões IA ({top10Suggestions.length}{excessCount > 0 ? ` de ${suggestions.length}` : ''})</button>
    </div>
    <div className="relative max-w-md"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Pesquisar palavra, ASIN ou produto" className="w-full rounded-lg border border-surface-2 bg-surface-1 py-2 pl-10 pr-3 text-sm text-white" /></div>
    {message && <div className={`rounded-lg p-3 text-sm ${message.type === 'success' ? 'bg-emerald-400/10 text-emerald-300' : 'bg-red-400/10 text-red-300'}`}>{message.text}</div>}
    {loading ? <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-violet-400" /></div> : tab === 'suggestions' ? <SuggestionsPanel suggestions={top10Suggestions.filter(s => `${s.keyword||''} ${s.asin||''} ${s.sku||''}`.toLowerCase().includes(q))} products={products} workingId={workingId} onReview={review} /> : <div className="overflow-hidden rounded-xl border border-surface-2 bg-surface-1"><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-surface-2 bg-surface-2/40">{['Termo','Produto / ASIN','Uso','Status','Pedidos','Vendas','Gasto','ACoS','ROAS'].map(h => <th key={h} className="px-4 py-3 text-left text-xs uppercase text-slate-500">{h}</th>)}</tr></thead><tbody>{filteredTerms.map(t => <tr key={t.id} className="border-b border-surface-2/40"><td className="px-4 py-3 font-semibold text-white">{t.term}</td><td className="px-4 py-3"><p className="max-w-[260px] truncate text-xs text-slate-200">{t.product_name || 'Produto não identificado'}</p><p className="font-mono text-[10px] text-cyan">{t.asin || 'Sem ASIN'}</p></td><td className="px-4 py-3 text-xs">{t.used_by_product || t.amazon_campaign_id ? <span className="text-emerald-400">Em uso</span> : <span className="text-slate-500">Nenhum produto</span>}</td><td className="px-4 py-3 text-xs"><span className={t.status === 'active' ? 'text-emerald-400' : 'text-slate-500'}>{t.status || 'inactive'}</span></td><td className="px-4 py-3 text-cyan">{t.orders || 0}</td><td className="px-4 py-3 text-xs text-slate-300">R${fmt(t.sales)}</td><td className="px-4 py-3 text-xs text-slate-300">R${fmt(t.spend)}</td><td className="px-4 py-3 text-xs text-slate-300">{t.acos ? `${fmt(t.acos,1)}%` : '0%'}</td><td className="px-4 py-3 text-xs text-slate-300">{t.roas ? `${fmt(t.roas)}x` : '0,00x'}</td></tr>)}</tbody></table></div></div>}
  </div>;
}