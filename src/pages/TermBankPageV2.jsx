import { useCallback, useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { BookOpen, Loader2, RefreshCw, Search, Megaphone, CheckCircle, Clock } from 'lucide-react';
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
  const [purging, setPurging] = useState(false);
  const [schedulingId, setSchedulingId] = useState(null);
  const [scheduledIds, setScheduledIds] = useState({});

  const [account, setAccount] = useState(null);

  const toConf100 = (c) => c == null ? 0 : c <= 1 ? Math.round(c * 100) : Math.round(c);

  const isTermIncomplete = (kw) => {
    if (!kw) return true;
    const k = kw.trim();
    if (k.length < 3) return true;
    if (/\.{2,}$|:\s*$/.test(k)) return true;
    const allowedShort = new Set(['de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'ao', 'os', 'as', 'e', 'a', 'o']);
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
      if (!acc) {setLoading(false);return;}
      setAccount(acc);

      // Background tasks — silenciosos, não bloqueiam o carregamento
      setTimeout(() => {
        base44.functions.invoke('updateTermBankFromAutomaticCampaigns', { amazon_account_id: acc.id }).catch(() => {});
        base44.functions.invoke('cleanupLegacySuggestions', { amazon_account_id: acc.id }).catch(() => {});
      }, 3000);

      const [t, s, p] = await Promise.all([
      base44.entities.TermBank.filter({ amazon_account_id: acc.id }, '-confidence', 500),
      base44.entities.KeywordSuggestion.filter({ amazon_account_id: acc.id }, '-created_at', 500),
      base44.entities.Product.filter({ amazon_account_id: acc.id }, '-updated_at', 200)]
      );

      // Mostrar todos os produtos ativos (independente de estoque) para que sugestões funcionem
      const activeProducts = p.filter((prod) => prod.status !== 'archived' && prod.status !== 'inactive');
      const activeAsins = new Set(activeProducts.map((prod) => prod.asin).filter(Boolean));

      const validTerms = t.
      filter((term) => !isTermIncomplete(term.term) && term.asin && activeAsins.has(term.asin)).
      sort((a, b) => toConf100(b.confidence) - toConf100(a.confidence));
      setTerms(validTerms);

      setSuggestions(s.filter((x) =>
      x.status !== 'rejected' &&
      x.deleted_by_user !== true &&
      !isTermIncomplete(x.keyword) &&
      x.asin && activeAsins.has(x.asin)
      ));
      setProducts(activeProducts);
    } catch (e) {
      // Ignorar erros "App not found" que são erros de infra não críticos
      if (!e.message?.includes('App not found')) {
        setMessage({ type: 'error', text: `Erro ao carregar: ${e.message}` });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {load();}, [load]);

  const handleScheduleCampaign = useCallback(async (term) => {
    if (!account || schedulingId) return;
    const scrollY = window.scrollY;
    setSchedulingId(term.id);
    setMessage(null);
    try {
      const res = await base44.functions.invoke('scheduleManualCampaignFromTerm', {
        amazon_account_id: account.id,
        asin: term.asin,
        keyword: term.term,
        product_name: term.product_name || term.asin,
        sku: term.sku || null,
      });
      const d = res?.data || {};
      if (d?.ok) {
        setMessage({ type: d.executed ? 'success' : 'info', text: d.message });
        setScheduledIds(prev => ({ ...prev, [term.id]: d.executed ? 'executed' : 'queued' }));
        window.dispatchEvent(new CustomEvent('term-campaign-queued', { detail: { asin: term.asin, keyword: term.term } }));
      } else if (d?.already_exists || d?.already_queued) {
        setMessage({ type: 'info', text: d.error || `Campanha já existe ou está na fila para "${term.term}".` });
        setScheduledIds(prev => ({ ...prev, [term.id]: 'exists' }));
      } else {
        setMessage({ type: 'error', text: d?.error || 'Erro ao agendar campanha' });
      }
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    } finally {
      setSchedulingId(null);
      setTimeout(() => window.scrollTo({ top: scrollY, behavior: 'instant' }), 100);
    }
  }, [account, schedulingId]);

  const handlePurge = useCallback(async () => {
    if (!account) return;
    if (!window.confirm('Isso irá remover todos os termos sem performance real e arquivar campanhas sem gasto. Continuar?')) return;
    setPurging(true);
    setMessage({ type: 'info', text: 'Limpando termos e campanhas sem performance...' });
    try {
      const res = await base44.functions.invoke('purgeStaleTermsAndCampaigns', {
        amazon_account_id: account.id,
        dry_run: false
      });
      const d = res?.data;
      if (d?.ok) {
        setMessage({
          type: 'success',
          text: `✓ ${d.terms_deleted} termos removidos · ${d.suggestions_archived} sugestões arquivadas · ${d.campaigns_archived} campanhas arquivadas${d.campaigns_failed > 0 ? ` · ${d.campaigns_failed} campanhas falharam` : ''}`
        });
        const scrollY = window.scrollY;
        load().finally(() => requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: 'instant' })));
      } else {
        setMessage({ type: 'error', text: d?.error || 'Erro ao limpar' });
      }
    } catch (e) {
      setMessage({ type: 'error', text: e.message });
    } finally {
      setPurging(false);
    }
  }, [account, load]);



  const amazonSuggestions = suggestions.filter((s) =>
  ['AMAZON_ADS_SUGGESTED_KEYWORD', 'AMAZON_ADS_SUGGESTED_TARGET', 'AMAZON_ADS_RECOMMENDATION'].includes(s.source)
  );

  const q = search.toLowerCase();
  const filteredTerms = terms.filter((t) => `${t.term || ''} ${t.asin || ''} ${t.product_name || ''}`.toLowerCase().includes(q));



  const tabs = [
  { id: 'amazon', label: `🎯 Amazon Ads Suggestions`, count: amazonSuggestions.filter((s) => !['archived_by_policy', 'superseded'].includes(s.status)).length },
  { id: 'terms', label: '📚 TermBank', count: terms.length }];


  return (
    <div className="space-y-5 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <BookOpen className="h-5 w-5 text-violet-400" />
          <div>
            <h1 className="text-lg font-bold text-white">Banco de Termos</h1>
            <p className="text-xs text-slate-400">
              {terms.length} termos · {amazonSuggestions.filter((s) => s.status !== 'archived_by_policy').length} sugestões Amazon Ads
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} disabled={loading} className="rounded-lg border border-surface-3 p-2 text-slate-300 disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>



      <div className="flex gap-1 border-b border-surface-2">
        {tabs.map((t) =>
        <button
          key={t.id}
          onClick={() => setTab(t.id)}
          className={`px-4 py-3 text-sm transition-colors ${tab === t.id ? 'border-b-2 border-cyan text-cyan' : 'text-slate-500 hover:text-slate-300'}`}>
          
            {t.label} {t.count > 0 && <span className="ml-1 text-xs opacity-70">({t.count})</span>}
          </button>
        )}
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Pesquisar palavra, ASIN ou produto"
          className="w-full rounded-lg border border-surface-2 bg-surface-1 py-2 pl-10 pr-3 text-sm text-white" />
        
      </div>

      {message &&
      <div className={`rounded-lg p-3 text-sm ${message.type === 'success' ? 'bg-emerald-400/10 text-emerald-300' : message.type === 'info' ? 'bg-amber-400/10 text-amber-300' : 'bg-red-400/10 text-red-300'}`}>
          {message.text}
        </div>
      }

      {loading ?
      <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-violet-400" />
        </div> :
      tab === 'amazon' ?
      <AmazonSuggestionsTab
        suggestions={amazonSuggestions.filter((s) => `${s.keyword || ''} ${s.asin || ''}`.toLowerCase().includes(q))}
        products={products}
        account={account}
        onRefresh={load} /> :


      <div className="overflow-hidden rounded-xl border border-surface-2 bg-surface-1">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-2 bg-surface-2/40">
                  {['Termo', 'Conf.', 'Produto / ASIN', 'Status', 'Pedidos', 'Vendas', 'Gasto', 'ACoS', 'ROAS', ''].map((h) =>
                <th key={h} className="px-4 py-3 text-left text-xs uppercase text-slate-500">{h}</th>
                )}
                </tr>
              </thead>
              <tbody>
                {filteredTerms.map((t) => {
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
                      <td className="px-4 py-3 text-xs text-slate-300">{t.acos ? `${fmt(t.acos, 1)}%` : '0%'}</td>
                      <td className="px-4 py-3 text-xs text-slate-300">{t.roas ? `${fmt(t.roas)}x` : '0,00x'}</td>
                      <td className="px-4 py-3">
                        {scheduledIds[t.id] === 'executed' ? (
                          <span className="flex items-center gap-1 text-[10px] text-emerald-400"><CheckCircle className="w-3 h-3" />Criada</span>
                        ) : scheduledIds[t.id] === 'queued' ? (
                          <span className="flex items-center gap-1 text-[10px] text-amber-400"><Clock className="w-3 h-3" />Agendada</span>
                        ) : scheduledIds[t.id] === 'exists' ? (
                          <span className="text-[10px] text-slate-500">Já existe</span>
                        ) : (
                          <button
                            onClick={() => handleScheduleCampaign(t)}
                            disabled={schedulingId === t.id}
                            title="Criar campanha EXACT com bid R$ 0,50"
                            className="flex items-center gap-1 px-2 py-1 text-[10px] font-semibold rounded-lg border border-cyan/30 bg-cyan/10 text-cyan hover:bg-cyan/20 disabled:opacity-50 transition-colors whitespace-nowrap"
                          >
                            {schedulingId === t.id
                              ? <Loader2 className="w-3 h-3 animate-spin" />
                              : <Megaphone className="w-3 h-3" />}
                            Criar campanha
                          </button>
                        )}
                      </td>
                    </tr>);

              })}
              </tbody>
            </table>
          </div>
        </div>
      }
    </div>);

}