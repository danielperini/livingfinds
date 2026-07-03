import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Loader2, Plus, Trash2, Rocket, CheckCircle, XCircle,
  ChevronRight, Sparkles, Zap, Database, Bot, AlertTriangle
} from 'lucide-react';

const MATCH_TYPES = ['exact'];

const SOURCE_COLORS = {
  search_term_converted: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
  existing_keyword:      'text-cyan bg-cyan/10 border-cyan/20',
  ai_suggestion:         'text-violet-400 bg-violet-400/10 border-violet-400/20',
  cross_asin_validated:  'text-amber-400 bg-amber-400/10 border-amber-400/20',
  term_bank:             'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
};

const SOURCE_LABELS = {
  term_bank:    'TermBank',
  ai_suggestion: 'IA validada',
};

export default function KickoffModal({ product, account, onClose, onDone }) {
  // Modo: 'choose' | 'auto_full' | 'manual_flow'
  const [mode, setMode] = useState('choose');

  // ── Kick-off automático completo ──────────────────────────────────────────
  const [autoFullLoading, setAutoFullLoading] = useState(false);
  const [autoFullResult, setAutoFullResult]   = useState(null);
  const [autoFullError, setAutoFullError]     = useState(null);

  // ── Fluxo manual (legado) ─────────────────────────────────────────────────
  const [step, setStep]               = useState('auto');
  const [autoResult, setAutoResult]   = useState(null);
  const [autoLoading, setAutoLoading] = useState(false);
  const [autoError, setAutoError]     = useState(null);
  const [showTechDetails, setShowTechDetails]   = useState(false);
  const [lastErrorDetails, setLastErrorDetails] = useState(null);

  const [keywords, setKeywords]         = useState([{ text: '', matchType: 'exact', bid: '0.50' }]);
  const [manualLoading, setManualLoading]   = useState(false);
  const [manualResults, setManualResults]   = useState([]);
  const [manualError, setManualError]       = useState(null);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [suggestions, setSuggestions]     = useState([]);
  const [suggestionsLoaded, setSuggestionsLoaded] = useState(false);

  useEffect(() => {
    if (mode === 'manual_flow' && step === 'manual' && !suggestionsLoaded) {
      fetchSuggestions();
    }
  }, [mode, step]);

  // ── Kick-off Automático Completo ──────────────────────────────────────────
  const runAutoFull = async () => {
    setAutoFullLoading(true);
    setAutoFullError(null);
    try {
      const res = await base44.functions.invoke('autoKickoffProduct', {
        amazon_account_id: account.id,
        asin: product.asin,
        sku: product.sku,
        product_name: product.product_name || product.display_name,
        max_keywords: 3,
      });
      const d = res?.data;
      if (d?.ok) {
        setAutoFullResult(d);
      } else {
        setAutoFullError(d?.error || 'Erro no kick-off automático');
      }
    } catch (e) {
      setAutoFullError(e.message);
    } finally {
      setAutoFullLoading(false);
    }
  };

  // ── Fluxo manual: sugestões IA ────────────────────────────────────────────
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

  // ── Fluxo manual: campanha AUTO ───────────────────────────────────────────
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
        const ok = res.data?.ok;
        if (ok) {
          base44.functions.invoke('recordTermPerformance', {
            amazon_account_id: account.id,
            term: kw.text.trim(),
            asin: product.asin,
            product_name: product.product_name || product.display_name || '',
            source: kw._source === 'search_term_converted' ? 'search_term_auto'
              : kw._source === 'cross_asin_validated' ? 'cross_asin'
              : kw._from_term_bank ? 'manual_kickoff'
              : 'user_input',
            match_type: kw.matchType || 'exact',
            bid_initial: parseFloat(kw.bid) || 0.50,
            bid_current: parseFloat(kw.bid) || 0.50,
            amazon_campaign_id: res.data?.amazon_campaign_id || '',
          }).catch(() => {});
        }
        results.push({ keyword: kw.text.trim(), ok, name: res.data?.campaign_name, error: res.data?.error });
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

        <div className="p-6">

          {/* ── CHOOSE MODE ─────────────────────────────────────────────────── */}
          {mode === 'choose' && (
            <div className="space-y-4">
              {product.product_name && (
                <div className="px-4 py-3 bg-surface-2 rounded-xl">
                  <p className="text-xs text-slate-500 mb-0.5">Produto</p>
                  <p className="text-sm text-white font-medium">{product.product_name}</p>
                </div>
              )}

              <p className="text-sm text-slate-400">Como deseja iniciar as campanhas?</p>

              {/* Opção 1 — Automático Completo */}
              <button
                onClick={() => { setMode('auto_full'); runAutoFull(); }}
                className="w-full flex items-start gap-4 p-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10 transition-colors text-left"
              >
                <div className="w-9 h-9 rounded-lg bg-emerald-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Zap className="w-5 h-5 text-emerald-400" />
                </div>
                <div>
                  <p className="text-sm font-bold text-emerald-300">Kick-off Automático Completo</p>
                  <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                    Cria 1 campanha AUTO + 3 campanhas manuais automaticamente. 
                    Prioriza termos do <span className="text-emerald-400 font-semibold">TermBank</span> (≥ 4 pedidos). 
                    Se insuficiente, usa sugestões da <span className="text-violet-400 font-semibold">IA com confiança ≥ 90%</span> validadas para busca, produto e políticas Amazon.
                  </p>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border bg-emerald-400/10 border-emerald-400/20 text-emerald-400">
                      <Database className="w-2.5 h-2.5" /> TermBank
                    </span>
                    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border bg-violet-400/10 border-violet-400/20 text-violet-400">
                      <Bot className="w-2.5 h-2.5" /> IA ≥ 90% conf.
                    </span>
                    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border bg-cyan/10 border-cyan/20 text-cyan">
                      1 AUTO + 3 Manual
                    </span>
                  </div>
                </div>
              </button>

              {/* Opção 2 — Manual */}
              <button
                onClick={() => setMode('manual_flow')}
                className="w-full flex items-start gap-4 p-4 rounded-xl border border-surface-2 bg-surface-2/30 hover:bg-surface-2/60 transition-colors text-left"
              >
                <div className="w-9 h-9 rounded-lg bg-cyan/15 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Sparkles className="w-5 h-5 text-cyan" />
                </div>
                <div>
                  <p className="text-sm font-bold text-white">Configurar Manualmente</p>
                  <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                    Cria a campanha AUTO e depois você escolhe as keywords para as campanhas manuais. Sugestões da IA são carregadas automaticamente para ajudar.
                  </p>
                </div>
              </button>

              <div className="flex justify-end pt-1">
                <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors">Cancelar</button>
              </div>
            </div>
          )}

          {/* ── AUTO FULL MODE ───────────────────────────────────────────────── */}
          {mode === 'auto_full' && (
            <div className="space-y-4">
              {autoFullLoading && (
                <div className="flex flex-col items-center justify-center py-10 gap-4">
                  <div className="relative">
                    <div className="w-14 h-14 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                      <Loader2 className="w-7 h-7 text-emerald-400 animate-spin" />
                    </div>
                  </div>
                  <div className="text-center">
                    <p className="text-sm font-semibold text-white">Kick-off em andamento...</p>
                    <p className="text-xs text-slate-400 mt-1">Criando campanhas e validando keywords com a IA</p>
                  </div>
                  <div className="w-full space-y-2 text-xs text-slate-500">
                    {[
                      '① Criando campanha AUTO...',
                      '② Buscando termos no TermBank (≥ 4 pedidos)...',
                      '③ IA validando: busca · produto · políticas Amazon...',
                      '④ Criando 3 campanhas manuais EXACT...',
                    ].map((step, i) => (
                      <div key={i} className="flex items-center gap-2 px-3 py-1.5 bg-surface-2/50 rounded-lg">
                        <Loader2 className="w-3 h-3 animate-spin text-emerald-400 flex-shrink-0" />
                        {step}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {autoFullError && !autoFullLoading && (
                <div className="space-y-3">
                  <div className="flex items-start gap-2 p-3 bg-red-400/10 border border-red-400/20 rounded-xl">
                    <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-red-400">{autoFullError}</p>
                  </div>
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setMode('choose')} className="px-4 py-2 text-sm text-slate-400 hover:text-white">← Voltar</button>
                    <button onClick={runAutoFull} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded-lg">Tentar novamente</button>
                  </div>
                </div>
              )}

              {autoFullResult && !autoFullLoading && (
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <CheckCircle className="w-7 h-7 text-emerald-400 flex-shrink-0" />
                    <div>
                      <p className="text-sm font-bold text-white">Kick-off concluído!</p>
                      <p className="text-xs text-slate-400">{product.asin} · {autoFullResult.manual_campaigns_created} campanhas manuais criadas</p>
                    </div>
                  </div>

                  {/* Campanha AUTO */}
                  <div className="px-4 py-3 bg-surface-2 rounded-xl">
                    <p className="text-xs text-slate-500 mb-1 font-semibold uppercase tracking-wider">Campanha AUTO</p>
                    {autoFullResult.auto_campaign?.ok ? (
                      <div className="flex items-center gap-2">
                        <CheckCircle className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                        <p className="text-xs text-white">{autoFullResult.auto_campaign.campaign_name}</p>
                        {autoFullResult.auto_campaign.already_exists && <span className="text-[10px] text-amber-400">(já existia)</span>}
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <XCircle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                          <p className="text-xs text-amber-400 font-medium">Não foi possível criar a campanha AUTO</p>
                        </div>
                        {autoFullResult.errors?.[0] && (
                          <p className="text-[10px] text-slate-400 pl-5 leading-relaxed">
                            {autoFullResult.errors[0].replace(/^AUTO:\s*/i, '')}
                          </p>
                        )}
                        <p className="text-[10px] text-slate-500 pl-5">As campanhas manuais foram criadas normalmente.</p>
                      </div>
                    )}
                  </div>

                  {/* Campanhas manuais */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider">Campanhas Manuais</p>
                      <div className="flex items-center gap-2 text-[10px]">
                        {autoFullResult.term_bank_count > 0 && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border bg-emerald-400/10 border-emerald-400/20 text-emerald-400">
                            <Database className="w-2.5 h-2.5" /> {autoFullResult.term_bank_count} TermBank
                          </span>
                        )}
                        {autoFullResult.ai_count > 0 && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border bg-violet-400/10 border-violet-400/20 text-violet-400">
                            <Bot className="w-2.5 h-2.5" /> {autoFullResult.ai_count} IA
                          </span>
                        )}
                      </div>
                    </div>
                    {autoFullResult.manual_campaigns?.map((r, i) => (
                      <div key={i} className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs ${
                        r.ok ? 'bg-emerald-400/5 border-emerald-400/20 text-emerald-300'
                          : r.skipped ? 'bg-slate-400/5 border-slate-400/20 text-slate-400'
                          : 'bg-red-400/5 border-red-400/20 text-red-300'
                      }`}>
                        {r.ok ? <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" />
                          : r.skipped ? <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                          : <XCircle className="w-3.5 h-3.5 flex-shrink-0" />}
                        <span className="font-mono font-semibold">{r.keyword}</span>
                        {r.ok && (
                          <span className={`ml-auto text-[10px] px-1.5 py-0.5 rounded border font-medium ${
                            r.source === 'term_bank'
                              ? 'bg-emerald-400/10 border-emerald-400/20 text-emerald-400'
                              : 'bg-violet-400/10 border-violet-400/20 text-violet-400'
                          }`}>
                            {r.source === 'term_bank' ? 'TermBank' : 'IA'}
                          </span>
                        )}
                        {r.skipped && <span className="text-slate-500">{r.reason}</span>}
                        {!r.ok && !r.skipped && <span className="text-red-400 text-[10px] truncate">{r.error}</span>}
                      </div>
                    ))}
                    {!autoFullResult.manual_campaigns?.length && (
                      <p className="text-xs text-slate-500 px-2">Nenhuma keyword elegível encontrada.</p>
                    )}
                  </div>

                  <div className="flex justify-end pt-1">
                    <button onClick={() => { onDone?.(); onClose(); }}
                      className="px-5 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm font-semibold rounded-lg transition-colors">
                      Fechar
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── MANUAL FLOW ─────────────────────────────────────────────────── */}
          {mode === 'manual_flow' && (
            <>
              {/* Steps indicator */}
              <div className="flex items-center gap-2 mb-5 -mt-1">
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

              {/* STEP 1: AUTO */}
              {step === 'auto' && (
                <div className="space-y-4">
                  <p className="text-sm text-slate-300">
                    Primeiro vamos criar uma <span className="text-cyan font-semibold">campanha AUTO</span> para o produto.
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
                            <p>Profile ID: {account.ads_profile_id || 'N/A'}</p>
                            {lastErrorDetails.http_status && <p>HTTP Status: {lastErrorDetails.http_status}</p>}
                            {lastErrorDetails.amazon_error && <p>Amazon Error: {lastErrorDetails.amazon_error}</p>}
                          </div>
                        </div>
                      )}
                      {lastErrorDetails && (
                        <button onClick={() => setShowTechDetails(!showTechDetails)} className="text-xs text-cyan hover:text-cyan/80">
                          {showTechDetails ? 'Ocultar detalhes' : 'Ver detalhes técnicos'}
                        </button>
                      )}
                    </div>
                  )}
                  <div className="flex justify-between gap-2 pt-2">
                    <button onClick={() => setMode('choose')} className="px-4 py-2 text-sm text-slate-400 hover:text-white">← Voltar</button>
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
                        Campanha AUTO criada: <span className="font-semibold">{autoResult.campaign_name}</span>
                      </p>
                    </div>
                  )}
                  {loadingSuggestions ? (
                    <div className="flex items-center gap-2.5 px-4 py-3 bg-violet-500/10 border border-violet-500/20 rounded-xl">
                      <Loader2 className="w-4 h-4 text-violet-400 animate-spin flex-shrink-0" />
                      <p className="text-xs text-violet-300">A IA está a analisar termos compatíveis...</p>
                    </div>
                  ) : suggestions.length > 0 ? (
                    <div className="flex items-start gap-2.5 px-4 py-3 bg-violet-500/10 border border-violet-500/20 rounded-xl">
                      <Sparkles className="w-4 h-4 text-violet-400 flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-violet-300">{suggestions.length} palavra(s)-chave pré-selecionada(s) pela IA</p>
                    </div>
                  ) : null}

                  <p className="text-sm text-slate-300 mb-1">
                    Palavras-chave para <span className="text-white font-semibold">campanhas manuais</span> — uma campanha por keyword.
                  </p>

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
                          <span className="px-2 py-2 bg-surface-2/50 border border-surface-3 text-slate-500 text-xs rounded-lg w-20 text-center select-none">exact</span>
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
                        {kw._source && (
                          <div className="flex items-center gap-1.5 pl-1">
                            <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border ${SOURCE_COLORS[kw._source] || 'text-slate-500 bg-surface-3 border-surface-3'}`}>
                              <Sparkles className="w-2.5 h-2.5" />
                              {kw._source_label}
                            </span>
                            {kw._reason && <span className="text-[10px] text-slate-500 truncate max-w-[220px]">{kw._reason}</span>}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  <button onClick={addKeyword} className="flex items-center gap-1.5 text-xs text-cyan hover:text-cyan/80 transition-colors">
                    <Plus className="w-3.5 h-3.5" /> Adicionar palavra-chave
                  </button>

                  {manualError && <p className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">{manualError}</p>}

                  <div className="flex justify-end gap-2 pt-2">
                    <button onClick={skipManual} className="px-4 py-2 text-sm text-slate-400 hover:text-white">Saltar etapa</button>
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}