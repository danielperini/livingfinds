import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { Loader2, Plus, Trash2, Rocket, CheckCircle, XCircle, ChevronRight, Sparkles, Info } from 'lucide-react';

const MATCH_TYPES = ['exact', 'phrase', 'broad'];

const SOURCE_COLORS = {
  search_term_converted: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
  existing_keyword:      'text-cyan bg-cyan/10 border-cyan/20',
  ai_suggestion:         'text-violet-400 bg-violet-400/10 border-violet-400/20',
  cross_asin_validated:  'text-amber-400 bg-amber-400/10 border-amber-400/20',
};

export default function KickoffModal({ product, account, onClose, onDone }) {
  const [step, setStep] = useState('auto');
  const [autoResult, setAutoResult] = useState(null);
  const [autoLoading, setAutoLoading] = useState(false);
  const [autoError, setAutoError] = useState(null);
  const [showTechDetails, setShowTechDetails] = useState(false);
  const [lastErrorDetails, setLastErrorDetails] = useState(null);

  // Keywords para campanhas manuais
  const [keywords, setKeywords] = useState([{ text: '', matchType: 'exact', bid: '0.50' }]);
  const [manualLoading, setManualLoading] = useState(false);
  const [manualResults, setManualResults] = useState([]);
  const [manualError, setManualError] = useState(null);

  // Sugestões da IA
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [suggestionsLoaded, setSuggestionsLoaded] = useState(false);

  // Ao entrar no step manual, buscar sugestões automaticamente
  useEffect(() => {
    if (step === 'manual' && !suggestionsLoaded) {
      fetchSuggestions();
    }
  }, [step]);

  const fetchSuggestions = async () => {
    setLoadingSuggestions(true);
    try {
      const res = await base44.functions.invoke('suggestKeywordsForKickoff', {
        amazon_account_id: account.id,
        asin: product.asin,
        product_name: product.product_name || product.display_name || '',
      });
      const data = res?.data;
      if (data?.ok && data.suggestions?.length > 0) {
        setSuggestions(data.suggestions);
        // Pré-popular keywords com as sugestões (sem sobrescrever se o user já editou)
        const hasUserInput = keywords.some(k => k.text.trim());
        if (!hasUserInput) {
          setKeywords(
            data.suggestions.slice(0, 10).map(s => ({
              text: s.keyword,
              matchType: s.match_type || 'exact',
              bid: String((s.bid || 0.50).toFixed(2)),
              _source: s.source,
              _source_label: s.source_label,
              _reason: s.reason,
              _confidence: s.confidence,
            }))
          );
        }
      }
      setSuggestionsLoaded(true);
    } catch {
      setSuggestionsLoaded(true);
    } finally {
      setLoadingSuggestions(false);
    }
  };

  const runAuto = async () => {
    setAutoLoading(true);
    setAutoError(null);
    setLastErrorDetails(null);
    setShowTechDetails(false);
    try {
      const res = await base44.functions.invoke('createAutoCampaignForAsin', {
        amazon_account_id: account.id,
        asin: product.asin,
        sku: product.sku,
        product_name: product.product_name,
      });
      const d = res.data;
      if (d?.ok) {
        setAutoResult(d);
        setStep('manual');
      } else {
        let errorMsg = d?.error || 'Erro ao criar campanha AUTO';
        if (d?.http_status) errorMsg += ` (HTTP ${d.http_status})`;
        if (d?.amazon_error) errorMsg += ` — ${d.amazon_error}`;
        setAutoError(errorMsg);
        setLastErrorDetails({
          http_status: d.http_status,
          request_id: d.request_id,
          amazon_error: d.amazon_error,
          response_sample: d.response_sample,
          profile_id: account.ads_profile_id,
          region: account.region,
        });
        setShowTechDetails(true);
      }
    } catch (e) {
      setAutoError(e.message);
      setLastErrorDetails({ error: e.message });
      setShowTechDetails(true);
    } finally {
      setAutoLoading(false);
    }
  };

  const addKeyword = () => setKeywords(prev => [...prev, { text: '', matchType: 'exact', bid: '0.50' }]);
  const removeKeyword = (i) => setKeywords(prev => prev.filter((_, idx) => idx !== i));
  const updateKeyword = (i, field, val) => setKeywords(prev => prev.map((k, idx) => idx === i ? { ...k, [field]: val } : k));

  const runManual = async () => {
    const valid = keywords.filter(k => k.text.trim());
    if (valid.length === 0) { setManualError('Adicione pelo menos uma palavra-chave.'); return; }
    setManualLoading(true);
    setManualError(null);
    const results = [];
    for (const kw of valid) {
      try {
        const res = await base44.functions.invoke('createManualCampaignFromKeywordSuggestion', {
          amazon_account_id: account.id,
          asin: product.asin,
          sku: product.sku,
          product_name: product.product_name,
          keyword: kw.text.trim(),
          match_type: kw.matchType,
          bid: parseFloat(kw.bid) || 0.50,
        });
        results.push({ keyword: kw.text.trim(), ok: res.data?.ok, name: res.data?.campaign_name, error: res.data?.error });
      } catch (e) {
        results.push({ keyword: kw.text.trim(), ok: false, error: e.message });
      }
    }
    setManualResults(results);
    setManualLoading(false);
    setStep('done');
    onDone?.();
  };

  const skipManual = () => { setStep('done'); onDone?.(); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-surface-1 border border-surface-2 rounded-2xl w-full max-w-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-2">
          <div className="flex items-center gap-2.5">
            <Rocket className="w-5 h-5 text-cyan" />
            <div>
              <h2 className="text-sm font-bold text-white">Kick-off de Produto</h2>
              <p className="text-xs text-slate-400 font-mono">{product.asin}{product.sku ? ` · ${product.sku}` : ''}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors text-lg leading-none">✕</button>
        </div>

        {/* Steps indicator */}
        <div className="flex items-center gap-2 px-6 py-3 bg-surface-2/40 border-b border-surface-2">
          {[
            { key: 'auto', label: '1. Campanha AUTO' },
            { key: 'manual', label: '2. Campanhas Manuais' },
            { key: 'done', label: '3. Concluído' },
          ].map((s, i, arr) => (
            <div key={s.key} className="flex items-center gap-2">
              <span className={`text-xs font-semibold px-2 py-1 rounded-full ${step === s.key ? 'bg-cyan text-white' : (step === 'done' || (step === 'manual' && s.key === 'auto')) ? 'bg-emerald-500/20 text-emerald-400' : 'bg-surface-3 text-slate-500'}`}>
                {s.label}
              </span>
              {i < arr.length - 1 && <ChevronRight className="w-3 h-3 text-slate-600" />}
            </div>
          ))}
        </div>

        <div className="p-6">
          {/* STEP 1: AUTO */}
          {step === 'auto' && (
            <div className="space-y-4">
              <p className="text-sm text-slate-300">
                Primeiro vamos criar uma <span className="text-cyan font-semibold">campanha AUTO</span> para o produto. Ela captura os primeiros search terms e gera dados de performance.
              </p>
              {product.product_name && (
                <div className="px-4 py-3 bg-surface-2 rounded-xl">
                  <p className="text-xs text-slate-500 mb-0.5">Produto</p>
                  <p className="text-sm text-white font-medium">{product.product_name}</p>
                </div>
              )}
              {autoError && (
                <div className="space-y-2">
                  <p className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2 whitespace-pre-wrap">{autoError}</p>
                  {lastErrorDetails && showTechDetails && (
                    <div className="text-xs bg-slate-900/50 border border-slate-700 rounded-lg p-3 font-mono text-slate-300 max-h-48 overflow-y-auto scrollbar-thin">
                      <p className="font-semibold text-slate-400 mb-2">Detalhes Técnicos:</p>
                      <div className="space-y-1">
                        <p>ASIN: {product.asin}</p>
                        <p>SKU: {product.sku || 'N/A'}</p>
                        <p>Profile ID: {account.ads_profile_id || 'N/A'}</p>
                        <p>Região: {account.region || 'N/A'}</p>
                        {lastErrorDetails.http_status && <p>HTTP Status: {lastErrorDetails.http_status}</p>}
                        {lastErrorDetails.request_id && <p>Request ID: {lastErrorDetails.request_id}</p>}
                        {lastErrorDetails.amazon_error && <p>Amazon Error: {lastErrorDetails.amazon_error}</p>}
                        {lastErrorDetails.response_sample && (
                          <div className="mt-2">
                            <p className="font-semibold text-slate-400">Resposta Amazon:</p>
                            <pre className="whitespace-pre-wrap text-[10px] mt-1">{lastErrorDetails.response_sample}</pre>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {lastErrorDetails && (
                    <button onClick={() => setShowTechDetails(!showTechDetails)} className="text-xs text-cyan hover:text-cyan/80">
                      {showTechDetails ? 'Ocultar detalhes técnicos' : 'Ver detalhes técnicos'}
                    </button>
                  )}
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors">Cancelar</button>
                <button onClick={runAuto} disabled={autoLoading}
                  className="flex items-center gap-2 px-5 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60">
                  {autoLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
                  {autoLoading ? 'Criando campanha AUTO...' : 'Criar Campanha AUTO'}
                </button>
              </div>
            </div>
          )}

          {/* STEP 2: MANUAL */}
          {step === 'manual' && (
            <div className="space-y-4">
              {autoResult && (
                <div className="flex items-center gap-2 px-3 py-2 bg-emerald-400/10 border border-emerald-400/20 rounded-lg">
                  <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                  <p className="text-xs text-emerald-300">
                    Campanha AUTO criada: <span className="font-semibold">{autoResult.campaign_name}</span> — Budget R${autoResult.daily_budget}/dia
                  </p>
                </div>
              )}

              {/* Banner de sugestões IA */}
              {loadingSuggestions ? (
                <div className="flex items-center gap-2.5 px-4 py-3 bg-violet-500/10 border border-violet-500/20 rounded-xl">
                  <Loader2 className="w-4 h-4 text-violet-400 animate-spin flex-shrink-0" />
                  <p className="text-xs text-violet-300">A IA está a analisar termos e histórico compatíveis com este produto...</p>
                </div>
              ) : suggestions.length > 0 ? (
                <div className="flex items-start gap-2.5 px-4 py-3 bg-violet-500/10 border border-violet-500/20 rounded-xl">
                  <Sparkles className="w-4 h-4 text-violet-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-violet-300">
                      {suggestions.length} palavra(s)-chave pré-selecionada(s) pela IA
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Baseadas em termos convertidos, keywords históricas e análise de produtos similares. Edite ou remova conforme necessário.
                    </p>
                  </div>
                </div>
              ) : null}

              <div>
                <p className="text-sm text-slate-300 mb-1">
                  Palavras-chave para <span className="text-white font-semibold">campanhas manuais</span> — uma campanha por keyword.
                </p>
                <p className="text-xs text-slate-500">Deixe em branco para saltar esta etapa.</p>
              </div>

              <div className="space-y-2 max-h-64 overflow-y-auto scrollbar-thin pr-1">
                {keywords.map((kw, i) => (
                  <div key={i} className="space-y-1">
                    <div className="flex items-center gap-2">
                      <input
                        value={kw.text}
                        onChange={e => updateKeyword(i, 'text', e.target.value)}
                        placeholder={`Palavra-chave ${i + 1}`}
                        className="flex-1 min-w-0 px-3 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan/50"
                      />
                      <select value={kw.matchType} onChange={e => updateKeyword(i, 'matchType', e.target.value)}
                        className="px-2 py-2 bg-surface-2 border border-surface-3 text-slate-300 text-xs rounded-lg focus:outline-none w-24">
                        {MATCH_TYPES.map(m => <option key={m} value={m}>{m}</option>)}
                      </select>
                      <input
                        value={kw.bid}
                        onChange={e => updateKeyword(i, 'bid', e.target.value)}
                        placeholder="Bid"
                        className="w-20 px-2 py-2 bg-surface-2 border border-surface-3 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-cyan/50 text-center"
                      />
                      <button onClick={() => removeKeyword(i)} disabled={keywords.length === 1}
                        className="p-1.5 text-slate-600 hover:text-red-400 transition-colors disabled:opacity-30">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    {/* Badge de origem da sugestão */}
                    {kw._source && (
                      <div className="flex items-center gap-1.5 pl-1">
                        <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${SOURCE_COLORS[kw._source] || 'text-slate-500 bg-surface-3 border-surface-3'}`}>
                          <Sparkles className="w-2.5 h-2.5" />
                          {kw._source_label}
                        </span>
                        {kw._reason && (
                          <span className="text-[10px] text-slate-500 truncate max-w-[220px]">{kw._reason}</span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <button onClick={addKeyword}
                className="flex items-center gap-1.5 text-xs text-cyan hover:text-cyan/80 transition-colors">
                <Plus className="w-3.5 h-3.5" /> Adicionar palavra-chave
              </button>

              {manualError && <p className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">{manualError}</p>}

              <div className="flex justify-end gap-2 pt-2">
                <button onClick={skipManual} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors">
                  Saltar etapa
                </button>
                <button onClick={runManual} disabled={manualLoading || loadingSuggestions}
                  className="flex items-center gap-2 px-5 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60">
                  {manualLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
                  {manualLoading ? 'Criando campanhas...' : `Criar ${keywords.filter(k => k.text.trim()).length || ''} Campanha(s) Manual`}
                </button>
              </div>
            </div>
          )}

          {/* STEP 3: DONE */}
          {step === 'done' && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <CheckCircle className="w-8 h-8 text-emerald-400 flex-shrink-0" />
                <div>
                  <p className="text-sm font-bold text-white">Kick-off concluído!</p>
                  <p className="text-xs text-slate-400">{product.asin} está a caminho dos resultados.</p>
                </div>
              </div>

              {autoResult && (
                <div className="px-4 py-3 bg-surface-2 rounded-xl">
                  <p className="text-xs text-slate-500 mb-1 font-semibold">Campanha AUTO</p>
                  <p className="text-sm text-white">{autoResult.campaign_name}</p>
                  <p className="text-xs text-slate-400">Budget R${autoResult.daily_budget}/dia · Bid R$0.50</p>
                </div>
              )}

              {manualResults.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs text-slate-500 font-semibold">Campanhas Manuais</p>
                  {manualResults.map((r, i) => (
                    <div key={i} className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs ${r.ok ? 'bg-emerald-400/5 border-emerald-400/20 text-emerald-300' : 'bg-red-400/5 border-red-400/20 text-red-300'}`}>
                      {r.ok ? <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" /> : <XCircle className="w-3.5 h-3.5 flex-shrink-0" />}
                      <span className="font-mono font-semibold">{r.keyword}</span>
                      {r.ok ? <span className="text-slate-400">→ {r.name}</span> : <span className="text-red-400">{r.error}</span>}
                    </div>
                  ))}
                </div>
              )}

              <div className="flex justify-end pt-2">
                <button onClick={onClose}
                  className="px-5 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm font-semibold rounded-lg transition-colors">
                  Fechar
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}