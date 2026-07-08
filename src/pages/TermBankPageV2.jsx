import { useCallback, useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { BookOpen, Loader2, RefreshCw, Search, Trash2, AlertTriangle, Sparkles, CheckCheck, PackagePlus } from 'lucide-react';
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
  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState('');
  const [approveAllRunning, setApproveAllRunning] = useState(false);
  const [account, setAccount] = useState(null);
  const [genRestocked, setGenRestocked] = useState(false);

  const MIN_CONFIDENCE = 75;

  // Normaliza confidence: aceita 0-1 float ou 0-100 int
  const toConf100 = (c) => c == null ? 0 : c <= 1 ? Math.round(c * 100) : Math.round(c);

  // Top 10 por produto: filtrar confidence >= 75, ordenar por confidence desc
  const top10Suggestions = (() => {
    const byAsin = {};
    for (const s of suggestions) {
      const conf = toConf100(s.confidence || s.relevance_score);
      if (conf < MIN_CONFIDENCE) continue; // rejeitar baixa confiança
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

  const excessCount = suggestions.length - top10Suggestions.length;

  const cleanExcess = async () => {
    if (excessCount <= 0) return;
    setCleaning(true);
    setMessage(null);
    try {
      const keepIds = new Set(top10Suggestions.map(s => s.id));
      const toDelete = suggestions.filter(s => !keepIds.has(s.id));

      // Deletar em lotes de 10 com pausa de 300ms para não exceder rate limit
      const BATCH = 10;
      let deleted = 0;
      for (let i = 0; i < toDelete.length; i += BATCH) {
        const batch = toDelete.slice(i, i + BATCH);
        await Promise.all(batch.map(s => base44.entities.KeywordSuggestion.delete(s.id)));
        deleted += batch.length;
        if (i + BATCH < toDelete.length) {
          await new Promise(r => setTimeout(r, 300));
        }
      }

      setMessage({ type: 'success', text: `✓ ${deleted} sugestões excedentes removidas. Mantidas as top 10 por produto.` });
      await load();
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    } finally {
      setCleaning(false);
    }
  };

  // Gera sugestões via IA para todos os produtos com título, em lotes
  const generateSuggestions = async () => {
    if (!account || generating) return;
    setGenerating(true);
    setGenProgress('Iniciando geração...');
    setMessage(null);
    try {
      const productsWithTitle = products.filter(p => p.product_name || p.display_name);
      if (!productsWithTitle.length) {
        setMessage({ type: 'error', text: 'Nenhum produto com título encontrado. Sincronize os títulos primeiro.' });
        return;
      }

      let totalGenerated = 0;
      let totalRejected = 0;
      let errors = 0;
      for (let i = 0; i < productsWithTitle.length; i++) {
        const p = productsWithTitle[i];
        setGenProgress(`Processando ${p.asin || p.sku} (${i + 1}/${productsWithTitle.length})...`);
        try {
          const res = await base44.functions.invoke('suggestProductKeywordsWithAI', {
            amazon_account_id: account.id,
            asin: p.asin,
            product_id: p.id,
            product_name: p.product_name || p.display_name,
            force_ai: false,
          });
          const d = res?.data;
          if (d?.ok && !d?.skipped) {
            totalGenerated += d.new_suggestions || d.suggestions_created || 0;
          }
          if (d?.terms_rejected_low_confidence) totalRejected += d.terms_rejected_low_confidence;
        } catch (err) { errors++; }
        if (i < productsWithTitle.length - 1) await new Promise(r => setTimeout(r, 800));
      }

      setGenProgress('');
      if (totalGenerated === 0) {
        setMessage({ type: 'error', text: `Nenhum termo atingiu confiança mínima de ${MIN_CONFIDENCE}%.${totalRejected > 0 ? ` ${totalRejected} rejeitados por baixa confiança.` : ''}${errors > 0 ? ` ${errors} erros.` : ''}` });
      } else {
        setMessage({ type: 'success', text: `Termos criados com sucesso. ${totalGenerated} sugestão(ões) com confidence >= ${MIN_CONFIDENCE}%.${errors > 0 ? ` ${errors} erros.` : ''}` });
      }
      await load();
    } catch (e) {
      setMessage({ type: 'error', text: `Erro: ${e.message}` });
      setGenProgress('');
    } finally {
      setGenerating(false);
      setGenProgress('');
    }
  };

  // Aprovar todas as sugestões pendentes em sequência
  const approveAll = async () => {
    if (!account || approveAllRunning) return;
    const pending = top10Suggestions.filter(s => !['created', 'approved'].includes(s.status));
    if (!pending.length) {
      setMessage({ type: 'error', text: 'Nenhuma sugestão pendente para aprovar.' });
      return;
    }
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
      const [t, s, p] = await Promise.all([
        base44.entities.TermBank.filter({ amazon_account_id: acc.id }, '-confidence', 500),
        base44.entities.KeywordSuggestion.filter({ amazon_account_id: acc.id }, '-confidence', 500),
        base44.entities.Product.filter({ amazon_account_id: acc.id }, '-updated_at', 200),
      ]);
      const activeProducts = p.filter(prod =>
        prod.status === 'active' &&
        (Number(prod.fba_inventory ?? prod.fba_quantity ?? 0) > 0 ||
         prod.inventory_status === 'in_stock' ||
         prod.inventory_status === 'available' ||
         prod.inventory_status == null)
      );
      const activeAsins = new Set(activeProducts.map(prod => prod.asin).filter(Boolean));

      // TermBank: ordenar por confidence desc
      const validTerms = t
        .filter(term => !isTermIncomplete(term.term) && (!term.asin || activeAsins.has(term.asin)))
        .sort((a, b) => toConf100(b.confidence) - toConf100(a.confidence));
      setTerms(validTerms);

      // Sugestões: filtrar rejeitadas, incompletas e baixa confiança
      setSuggestions(s.filter(x =>
        x.status !== 'rejected' &&
        x.deleted_by_user !== true &&
        !isTermIncomplete(x.keyword) &&
        (!x.asin || activeAsins.has(x.asin))
      ));
      setProducts(activeProducts);
    } catch (e) {
      setMessage({ type: 'error', text: `Erro ao carregar: ${e.message}` });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function review(suggestion, action) {
    // Validar antes de enviar
    if (action === 'approve' && isTermIncomplete(suggestion.keyword)) {
      setMessage({ type: 'error', text: `Termo rejeitado por parecer incompleto: "${suggestion.keyword}"` });
      return;
    }
    if (action === 'approve' && toConf100(suggestion.confidence || suggestion.relevance_score) < MIN_CONFIDENCE) {
      setMessage({ type: 'error', text: `Termo com confiança abaixo de ${MIN_CONFIDENCE}% não pode ser aprovado.` });
      return;
    }

    setWorkingId(suggestion.id);
    setMessage(null);
    try {
      const res = await base44.functions.invoke('reviewKeywordSuggestion', { suggestion_id: suggestion.id, action });
      const data = res?.data || {};
      if (!data.ok) throw new Error(data.error || 'Falha ao processar sugestão');

      if (action === 'approve') {
        const campStatus = data.campaign_status;
        const statusLabels = {
          enabled: 'Campanha ativa',
          active: 'Campanha ativa',
          created: 'Campanha criada',
          incomplete: 'Campanha incompleta (reparo agendado)',
          paused: 'Campanha pausada',
          archived: 'Campanha arquivada',
          failed: 'Falha ao criar campanha',
        };
        const statusText = statusLabels[campStatus] || 'Campanha criada';
        setMessage({ type: campStatus === 'failed' ? 'error' : 'success', text: `${statusText} para "${suggestion.keyword}" (${data.product_name || suggestion.asin}). Termo adicionado ao TermBank.` });
      } else {
        setMessage({ type: 'success', text: 'Sugestão removida.' });
      }
      await load();
    } catch (e) {
      setMessage({ type: 'error', text: e?.response?.data?.error || e.message || 'Erro ao processar sugestão.' });
    } finally {
      setWorkingId(null);
    }
  }

  const q = search.toLowerCase();
  const filteredSuggestions = top10Suggestions.filter((s) => `${s.keyword || ''} ${s.asin || ''} ${s.sku || ''}`.toLowerCase().includes(q));
  const filteredTerms = terms.filter((t) => `${t.term || ''} ${t.asin || ''} ${t.product_name || ''}`.toLowerCase().includes(q));

  const rejectedLowConf = suggestions.filter(s => toConf100(s.confidence || s.relevance_score) < MIN_CONFIDENCE).length;

  return <div className="space-y-5 p-6">
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <BookOpen className="h-5 w-5 text-violet-400" />
        <div>
          <h1 className="text-lg font-bold text-white">Banco de Termos</h1>
          <p className="text-xs text-slate-400">
            {terms.length} termos · {terms.filter(t => t.status === 'active').length} ativos · {top10Suggestions.length} sugestões (conf ≥{MIN_CONFIDENCE}%)
            {rejectedLowConf > 0 && <span className="text-amber-400 ml-1">· {rejectedLowConf} ocultos por baixa confiança</span>}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={generateSuggestions}
          disabled={generating || loading}
          className="flex items-center gap-2 rounded-lg bg-violet-500/15 border border-violet-500/30 px-3 py-2 text-xs font-semibold text-violet-300 hover:bg-violet-500/25 transition-colors disabled:opacity-50"
        >
          {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {generating ? 'Gerando...' : 'Gerar com IA'}
        </button>
        {top10Suggestions.filter(s => !['created', 'approved'].includes(s.status)).length > 0 && (
          <button
            onClick={approveAll}
            disabled={approveAllRunning || loading}
            className="flex items-center gap-2 rounded-lg bg-emerald-500/15 border border-emerald-500/30 px-3 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/25 transition-colors disabled:opacity-50"
          >
            {approveAllRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}
            {approveAllRunning ? 'Criando...' : `Aprovar todas (${top10Suggestions.filter(s => !['created', 'approved'].includes(s.status)).length})`}
          </button>
        )}
        <button
          onClick={async () => {
            if (!account || genRestocked) return;
            setGenRestocked(true);
            setMessage(null);
            try {
              const res = await base44.functions.invoke('processNewOrRestockedProductsForTermBank', {
                amazon_account_id: account.id, trigger: 'manual_ui'
              });
              const d = res?.data;
              if (d?.ok) {
                const s = d.stats || {};
                setMessage({ type: 'success', text: `✓ ${s.terms_created || 0} termos criados para ${s.products_processed || 0} produto(s) novo(s)/reabastecido(s).` });
                await load();
              } else {
                setMessage({ type: 'error', text: d?.error || 'Falha ao gerar termos de produtos.' });
              }
            } catch (e) {
              setMessage({ type: 'error', text: e.message });
            } finally {
              setGenRestocked(false);
            }
          }}
          disabled={genRestocked || loading}
          className="flex items-center gap-2 rounded-lg bg-cyan/10 border border-cyan/25 px-3 py-2 text-xs font-semibold text-cyan hover:bg-cyan/20 transition-colors disabled:opacity-50"
          title="Gerar termos iniciais para produtos novos ou reabastecidos"
        >
          {genRestocked ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackagePlus className="h-3.5 w-3.5" />}
          {genRestocked ? 'Gerando...' : 'Produtos novos'}
        </button>
        <button onClick={load} className="rounded-lg border border-surface-3 p-2 text-slate-300">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
    </div>

    {genProgress && (
      <div className="flex items-center gap-2 rounded-xl border border-violet-500/20 bg-violet-500/5 px-4 py-3 text-xs text-violet-300">
        <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
        {genProgress}
      </div>
    )}

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
    {loading ? <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-violet-400" /></div> : tab === 'suggestions' ? <SuggestionsPanel suggestions={top10Suggestions.filter(s => `${s.keyword||''} ${s.asin||''} ${s.sku||''}`.toLowerCase().includes(q))} products={products} workingId={workingId} onReview={review} /> : <div className="overflow-hidden rounded-xl border border-surface-2 bg-surface-1"><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-surface-2 bg-surface-2/40">{['Termo','Conf.','Produto / ASIN','Status','Pedidos','Vendas','Gasto','ACoS','ROAS'].map(h => <th key={h} className="px-4 py-3 text-left text-xs uppercase text-slate-500">{h}</th>)}</tr></thead><tbody>{filteredTerms.map(t => {
  const conf = toConf100(t.confidence);
  const confColor = conf >= 90 ? 'text-emerald-400' : conf >= 75 ? 'text-amber-400' : 'text-red-400';
  return <tr key={t.id} className="border-b border-surface-2/40">
    <td className="px-4 py-3 font-semibold text-white">{t.term}</td>
    <td className="px-4 py-3"><span className={`text-xs font-bold ${confColor}`}>{conf > 0 ? `${conf}%` : '—'}</span></td>
    <td className="px-4 py-3"><p className="max-w-[200px] truncate text-xs text-slate-200">{t.product_name || 'Produto não identificado'}</p><p className="font-mono text-[10px] text-cyan">{t.asin || 'Sem ASIN'}</p></td>
    <td className="px-4 py-3 text-xs"><span className={t.status === 'active' ? 'text-emerald-400' : 'text-slate-500'}>{t.status || 'inactive'}</span></td>
    <td className="px-4 py-3 text-cyan">{t.orders || 0}</td>
    <td className="px-4 py-3 text-xs text-slate-300">R${fmt(t.sales)}</td>
    <td className="px-4 py-3 text-xs text-slate-300">R${fmt(t.spend)}</td>
    <td className="px-4 py-3 text-xs text-slate-300">{t.acos ? `${fmt(t.acos,1)}%` : '0%'}</td>
    <td className="px-4 py-3 text-xs text-slate-300">{t.roas ? `${fmt(t.roas)}x` : '0,00x'}</td>
  </tr>;
})}</tbody></table></div></div>}
  </div>;
}