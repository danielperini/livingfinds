import { useCallback, useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { BookOpen, Loader2, RefreshCw, Search, Trash2, AlertTriangle, CheckCheck, Target } from 'lucide-react';
import SuggestionsPanel from '@/components/termbank/SuggestionsPanel';
import AmazonSuggestionsTab from '@/components/termbank/AmazonSuggestionsTab';

const fmt = (v, d = 2) => Number(v || 0).toFixed(d).replace('.', ',');

export default function TermBankPageV2() {
  const [terms, setTerms] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [products, setProducts] = useState([]);
  const [tab, setTab] = useState('amazon');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState(null);
  const [message, setMessage] = useState(null);
  const [cleaning, setCleaning] = useState(false);
  const [approveAllRunning, setApproveAllRunning] = useState(false);
  const [account, setAccount] = useState(null);

  const MIN_CONFIDENCE = 75;
  const MAX_SUGGESTIONS_PER_ASIN = 10;

  const toConf100 = (c) => c == null ? 0 : c <= 1 ? Math.round(c * 100) : Math.round(c);

  // Sugestões legadas (origem IA) — separadas das Amazon
  const legacySuggestions = suggestions.filter(s =>
    ['OPENAI_TITLE_ANALYSIS', 'CLAUDE_PRODUCT_ANALYSIS', 'AI_GENERATED', 'GPT_TITLE_ANALYSIS', 'PRODUCT_ANALYSIS',
     'AUTOMATIC_SEARCH_TERM', 'MANUAL_SEARCH_TERM', 'CONVERTED_TERM_EXPANSION', 'USER'].includes(s.source) &&
    !['archived_by_policy', 'superseded'].includes(s.status)
  );

  // Top 10 das sugestões legadas
  const top10Suggestions = (() => {
    const byAsin = {};
    for (const s of legacySuggestions) {
      const conf = toConf100(s.confidence || s.relevance_score);
      if (conf < MIN_CONFIDENCE) continue;
      if (!byAsin[s.asin]) byAsin[s.asin] = [];
      byAsin[s.asin].push({ ...s, _conf100: conf });
    }
    const result = [];
    for (const asin of Object.keys(byAsin)) {
      const sorted = [...byAsin[asin]].sort((a, b) => b._conf100 - a._conf100);
      result.push(...sorted.slice(0, 10));
    }
    return result;
  })();

  const excessCount = legacySuggestions.length - top10Suggestions.length;

  const isTermIncomplete = (kw) => {
    if (!kw) return true;
    const k = kw.trim();
    if (k.length < 3) return true;
    if (/\.{2,}$|:\s*$/.test(k)) return true;
    const allowedShort = new Set(['de','do','da','dos','das','em','no','na','ao','os','as','e','a','o']);
    const lastWord = k.split(/\s+/).pop() || '';
    if (lastWord.length <= 2 && !allowedShort.has(lastWord.toLowerCase())) return true;
    if (/^[\d\s\W]+$/.test(k)) return true;
    return false;
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const me = await base44.auth.me();
      let accounts = await base44.entities.AmazonAccount.filter({ user_id: me.id });
      if (!accounts.length) accounts = await base44.entities.AmazonAccount.list();
      const acc = accounts[0];
      if (!acc) { setLoading(false); return; }
      setAccount(acc);

      base44.functions.invoke('updateTermBankFromAutomaticCampaigns', { amazon_account_id: acc.id }).catch(() => {});

      const [t, s, p] = await Promise.all([
        base44.entities.TermBank.filter({ amazon_account_id: acc.id }, '-confidence', 500),
        base44.entities.KeywordSuggestion.filter({ amazon_account_id: acc.id }, '-created_at', 500),
        base44.entities.Product.filter({ amazon_account_id: acc.id }, '-updated_at', 200),
      ]);

      const activeProducts = p.filter(prod =>
        prod.status === 'active' &&
        prod.inventory_status !== 'out_of_stock' &&
        Number(prod.fba_inventory ?? prod.fba_quantity ?? 0) > 0
      );
      const activeAsins = new Set(activeProducts.map(prod => prod.asin).filter(Boolean));

      const validTerms = t
        .filter(term => !isTermIncomplete(term.term) && term.asin && activeAsins.has(term.asin))
        .sort((a, b) => toConf100(b.confidence) - toConf100(a.confidence));
      setTerms(validTerms);

      setSuggestions(s.filter(x =>
        x.status !== 'rejected' &&
        x.deleted_by_user !== true &&
        !isTermIncomplete(x.keyword) &&
        x.asin && activeAsins.has(x.asin)
      ));
      setProducts(activeProducts);
    } catch (e) {
      setMessage({ type: 'error', text: `Erro ao carregar: ${e.message}` });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const cleanExcess = async () => {
    if (excessCount <= 0) return;
    setCleaning(true);
    setMessage(null);
    try {
      const keepIds = new Set(top10Suggestions.map(s => s.id));
      const toDelete = legacySuggestions.filter(s => !keepIds.has(s.id));
      const BATCH = 10;
      let deleted = 0;
      for (let i = 0; i < toDelete.length; i += BATCH) {
        const batch = toDelete.slice(i, i + BATCH);
        await Promise.all(batch.map(s => base44.entities.KeywordSuggestion.delete(s.id)));
        deleted += batch.length;
        if (i + BATCH < toDelete.length) await new Promise(r => setTimeout(r, 300));
      }
      setMessage({ type: 'success', text: `✓ ${deleted} sugestões excedentes removidas.` });
      await load();
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    } finally {
      setCleaning(false);
    }
  };

  const approveAll = async () => {
    if (!account || approveAllRunning) return;
    const pending = top10Suggestions.filter(s => !['created', 'approved'].includes(s.status));
    if (!pending.length) { setMessage({ type: 'error', text: 'Nenhuma sugestão pendente.' }); return; }
    setApproveAllRunning(true);
    setMessage(null);
    let success = 0, failed = 0;
    for (const s of pending) {
      setWorkingId(s.id);
      try {
        const res = await base44.functions.invoke('reviewKeywordSuggestion', { suggestion_id: s.id, action: 'approve' });
        if (res?.data?.ok) success++;
        else failed++;
      } catch { failed++; }
      await new Promise(r => setTimeout(r, 800));
    }
    setWorkingId(null);
    setApproveAllRunning(false);
    setMessage({ type: success > 0 ? 'success' : 'error', text: `✓ ${success} campanhas criadas${failed > 0 ? ` · ${failed} falhas` : ''}.` });
    await load();
  };

  async function review(suggestion, action) {
    if (action === 'approve' && isTermIncomplete(suggestion.keyword)) {
      setMessage({ type: 'error', text: `Termo incompleto: "${suggestion.keyword}"` });
      return;
    }
    setWorkingId(suggestion.id);
    setMessage(null);
    try {
      const res = await base44.functions.invoke('reviewKeywordSuggestion', { suggestion_id: suggestion.id, action });
      const data = res?.data || {};
      if (!data.ok) throw new Error(data.error || 'Falha ao processar sugestão');
      if (action === 'approve') {
        setMessage({ type: 'success', text: `Campanha criada para "${suggestion.keyword}".` });
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

  const amazonSuggestions = suggestions.filter(s =>
    ['AMAZON_ADS_SUGGESTED_KEYWORD', 'AMAZON_ADS_SUGGESTED_TARGET', 'AMAZON_ADS_RECOMMENDATION'].includes(s.source)
  );

  const q = search.toLowerCase();
  const filteredSuggestions = top10Suggestions.filter(s => `${s.keyword||''} ${s.asin||''} ${s.sku||''}`.toLowerCase().includes(q));
  const filteredTerms = terms.filter(t => `${t.term||''} ${t.asin||''} ${t.product_name||''}`.toLowerCase().includes(q));

  const tabs = [
    { id: 'amazon', label: `🎯 Amazon Ads Suggestions`, count: amazonSuggestions.filter(s => !['archived_by_policy','superseded'].includes(s.status)).length },
    { id: 'terms', label: '📚 TermBank', count: terms.length },
    { id: 'legacy', label: '📦 Sugestões anteriores', count: top10Suggestions.length },
  ];

  return (
    <div className="space-y-5 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <BookOpen className="h-5 w-5 text-violet-400" />
          <div>
            <h1 className="text-lg font-bold text-white">Banco de Termos</h1>
            <p className="text-xs text-slate-400">
              {terms.length} termos · {amazonSuggestions.filter(s => s.status !== 'archived_by_policy').length} sugestões Amazon Ads
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {tab === 'legacy' && top10Suggestions.filter(s => !['created','approved'].includes(s.status)).length > 0 && (
            <button
              onClick={approveAll}
              disabled={approveAllRunning || loading}
              className="flex items-center gap-2 rounded-lg bg-emerald-500/15 border border-emerald-500/30 px-3 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 transition-colors disabled:opacity-50"
            >
              {approveAllRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}
              {approveAllRunning ? 'Criando...' : `Aprovar todas (${top10Suggestions.filter(s => !['created','approved'].includes(s.status)).length})`}
            </button>
          )}
          <button onClick={load} className="rounded-lg border border-surface-3 p-2 text-slate-300">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {tab === 'legacy' && excessCount > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/8 px-4 py-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-400 flex-shrink-0" />
            <p className="text-sm text-amber-300">
              <strong>{excessCount}</strong> sugestões excedentes ao limite de 10 por produto.
            </p>
          </div>
          <button onClick={cleanExcess} disabled={cleaning}
            className="flex items-center gap-1.5 rounded-lg bg-amber-500/20 border border-amber-500/40 px-3 py-1.5 text-xs font-semibold text-amber-300 hover:bg-amber-500/30 transition-colors disabled:opacity-50 flex-shrink-0">
            {cleaning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            {cleaning ? 'Limpando...' : 'Limpar excesso'}
          </button>
        </div>
      )}

      <div className="flex gap-1 border-b border-surface-2">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-3 text-sm transition-colors ${tab === t.id ? 'border-b-2 border-cyan text-cyan' : 'text-slate-500 hover:text-slate-300'}`}
          >
            {t.label} {t.count > 0 && <span className="ml-1 text-xs opacity-70">({t.count})</span>}
          </button>
        ))}
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Pesquisar palavra, ASIN ou produto"
          className="w-full rounded-lg border border-surface-2 bg-surface-1 py-2 pl-10 pr-3 text-sm text-white"
        />
      </div>

      {message && (
        <div className={`rounded-lg p-3 text-sm ${message.type === 'success' ? 'bg-emerald-400/10 text-emerald-300' : 'bg-red-400/10 text-red-300'}`}>
          {message.text}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-violet-400" />
        </div>
      ) : tab === 'amazon' ? (
        <AmazonSuggestionsTab
          suggestions={amazonSuggestions.filter(s => `${s.keyword||''} ${s.asin||''}`.toLowerCase().includes(q))}
          products={products}
          account={account}
          onRefresh={load}
        />
      ) : tab === 'legacy' ? (
        <SuggestionsPanel
          suggestions={filteredSuggestions}
          products={products}
          workingId={workingId}
          onReview={review}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-surface-2 bg-surface-1">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/40">
                  {['Termo','Conf.','Produto / ASIN','Status','Pedidos','Vendas','Gasto','ACoS','ROAS'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs uppercase text-slate-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredTerms.map(t => {
                  const conf = toConf100(t.confidence);
                  const confColor = conf >= 90 ? 'text-emerald-400' : conf >= 75 ? 'text-amber-400' : 'text-red-400';
                  return (
                    <tr key={t.id} className="border-b border-surface-2/40">
                      <td className="px-4 py-3 font-semibold text-white">{t.term}</td>
                      <td className="px-4 py-3"><span className={`text-xs font-bold ${confColor}`}>{conf > 0 ? `${conf}%` : '—'}</span></td>
                      <td className="px-4 py-3"><p className="max-w-[200px] truncate text-xs text-slate-200">{t.product_name || 'Produto não identificado'}</p><p className="font-mono text-[10px] text-cyan">{t.asin || 'Sem ASIN'}</p></td>
                      <td className="px-4 py-3 text-xs"><span className={t.status === 'active' ? 'text-emerald-400' : 'text-slate-500'}>{t.status || 'inactive'}</span></td>
                      <td className="px-4 py-3 text-cyan">{t.orders || 0}</td>
                      <td className="px-4 py-3 text-xs text-slate-300">R${fmt(t.sales)}</td>
                      <td className="px-4 py-3 text-xs text-slate-300">R${fmt(t.spend)}</td>
                      <td className="px-4 py-3 text-xs text-slate-300">{t.acos ? `${fmt(t.acos,1)}%` : '0%'}</td>
                      <td className="px-4 py-3 text-xs text-slate-300">{t.roas ? `${fmt(t.roas)}x` : '0,00x'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}