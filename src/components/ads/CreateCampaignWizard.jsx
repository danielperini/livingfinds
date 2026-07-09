import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { X, Loader2, Zap, Sparkles, Package, Tag, Bot, ChevronRight, ChevronLeft, CheckCircle, AlertCircle } from 'lucide-react';

const STEPS = ['tipo', 'produto', 'keywords', 'confirmar'];

export default function CreateCampaignWizard({ account, products, onClose, onDone }) {
  const [step, setStep] = useState(0); // 0=tipo, 1=produto, 2=keywords, 3=confirmar
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  // Respostas do questionário
  const [campaignType, setCampaignType] = useState(''); // 'auto' | 'manual'
  const [selectedAsin, setSelectedAsin] = useState('');
  const [keywordSource, setKeywordSource] = useState(''); // 'amazon' | 'manual'
  const [manualKeywords, setManualKeywords] = useState('');

  const product = products.find(p => p.asin === selectedAsin);

  const canNext = () => {
    if (step === 0) return !!campaignType;
    if (step === 1) return !!selectedAsin;
    if (step === 2) {
      if (campaignType === 'auto') return true;
      if (keywordSource === 'amazon') return true;
      if (keywordSource === 'manual') return manualKeywords.trim().length > 0;
      return false;
    }
    return true;
  };

  const handleCreate = async () => {
    setLoading(true);
    setResult(null);
    try {
      if (campaignType === 'auto') {
        // Criar campanha AUTO via kickoff
        const res = await base44.functions.invoke('createAutoCampaignForAsinSafe', {
          amazon_account_id: account.id,
          asin: selectedAsin,
        });
        setResult(res?.data?.ok
          ? { ok: true, text: `Campanha AUTO criada para ${selectedAsin}.` }
          : { ok: false, text: res?.data?.error || 'Erro ao criar campanha AUTO.' }
        );
      } else {
        // Campanha MANUAL
        if (keywordSource === 'amazon') {
          // Usar sugestões da Amazon Ads
          const res = await base44.functions.invoke('createExactCampaignsFromAmazonSuggestions', {
            amazon_account_id: account.id,
            asin: selectedAsin,
            limit: 4,
            execute_now_if_window: true,
          });
          const d = res?.data;
          if (d?.scheduled) {
            setResult({ ok: true, text: `Agendado para a próxima janela: ${new Date(d.next_window).toLocaleString('pt-BR')}.` });
          } else if (d?.ok) {
            setResult({ ok: true, text: `${d.created} campanha(s) EXACT criada(s) com sugestões da Amazon.` });
          } else {
            setResult({ ok: false, text: d?.error || 'Erro ao criar campanhas.' });
          }
        } else {
          // Keywords digitadas manualmente
          const keywords = manualKeywords
            .split('\n')
            .map(k => k.trim())
            .filter(Boolean)
            .slice(0, 4);
          const res = await base44.functions.invoke('createManualCampaignV2', {
            amazon_account_id: account.id,
            asin: selectedAsin,
            keywords,
            match_type: 'EXACT',
          });
          const d = res?.data;
          setResult(d?.ok
            ? { ok: true, text: `Campanha manual criada com ${keywords.length} keyword(s).` }
            : { ok: false, text: d?.error || 'Erro ao criar campanha manual.' }
          );
        }
      }
    } catch (e) {
      setResult({ ok: false, text: e.message });
    } finally {
      setLoading(false);
    }
  };

  // Se já temos resultado, mostrar tela final
  if (result) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div className="bg-[#111827] border border-surface-2 rounded-2xl w-full max-w-md p-6 space-y-4">
          <div className={`flex flex-col items-center gap-3 text-center py-4 ${result.ok ? 'text-emerald-400' : 'text-red-400'}`}>
            {result.ok
              ? <CheckCircle className="w-10 h-10" />
              : <AlertCircle className="w-10 h-10" />}
            <p className="text-base font-semibold text-white">{result.ok ? 'Campanha criada!' : 'Erro ao criar'}</p>
            <p className="text-sm text-slate-400">{result.text}</p>
          </div>
          <div className="flex gap-3">
            {result.ok && (
              <button onClick={() => { onDone(); onClose(); }}
                className="flex-1 px-4 py-2.5 bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 text-sm font-semibold rounded-xl hover:bg-emerald-500/30 transition-colors">
                Ver campanhas
              </button>
            )}
            <button onClick={result.ok ? onClose : () => setResult(null)}
              className="flex-1 px-4 py-2.5 bg-surface-2 border border-surface-3 text-slate-300 text-sm font-semibold rounded-xl hover:text-white transition-colors">
              {result.ok ? 'Fechar' : 'Tentar novamente'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-[#111827] border border-surface-2 rounded-2xl w-full max-w-lg overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-2">
          <div>
            <p className="text-sm font-bold text-white">Nova Campanha</p>
            <p className="text-xs text-slate-500 mt-0.5">Passo {step + 1} de {STEPS.length}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Progress bar */}
        <div className="h-1 bg-surface-3">
          <div className="h-full bg-cyan transition-all" style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
        </div>

        {/* Content */}
        <div className="p-6 min-h-[280px] flex flex-col justify-between">

          {/* STEP 0 — Tipo de campanha */}
          {step === 0 && (
            <div className="space-y-3">
              <p className="text-sm font-semibold text-white mb-4">Que tipo de campanha você quer criar?</p>
              {[
                {
                  key: 'auto',
                  icon: Zap,
                  color: 'text-amber-400',
                  bg: 'border-amber-400/30 bg-amber-400/8',
                  label: 'Automática (AUTO)',
                  sub: 'A Amazon decide onde exibir. Ideal para descobrir novos termos. Gerida pela IA.',
                },
                {
                  key: 'manual',
                  icon: Sparkles,
                  color: 'text-cyan',
                  bg: 'border-cyan/30 bg-cyan/8',
                  label: 'Manual (MANUAL EXACT)',
                  sub: 'Você define os termos. Mais controle sobre bids e palavras-chave.',
                },
              ].map(opt => (
                <button key={opt.key} onClick={() => setCampaignType(opt.key)}
                  className={`w-full flex items-start gap-4 p-4 rounded-xl border-2 text-left transition-all ${
                    campaignType === opt.key ? opt.bg + ' border-opacity-100' : 'border-surface-2 hover:border-surface-3 bg-surface-2/40'
                  }`}>
                  <opt.icon className={`w-5 h-5 flex-shrink-0 mt-0.5 ${campaignType === opt.key ? opt.color : 'text-slate-500'}`} />
                  <div>
                    <p className={`text-sm font-semibold ${campaignType === opt.key ? 'text-white' : 'text-slate-400'}`}>{opt.label}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{opt.sub}</p>
                  </div>
                  {campaignType === opt.key && <CheckCircle className={`w-4 h-4 ml-auto flex-shrink-0 ${opt.color}`} />}
                </button>
              ))}
            </div>
          )}

          {/* STEP 1 — Produto */}
          {step === 1 && (
            <div className="space-y-3">
              <p className="text-sm font-semibold text-white mb-4">Para qual produto?</p>
              <select value={selectedAsin} onChange={e => setSelectedAsin(e.target.value)}
                className="w-full px-3 py-2.5 bg-surface-2 border border-surface-3 rounded-xl text-sm text-white focus:outline-none focus:border-cyan/50">
                <option value="">Selecionar produto...</option>
                {products.map(p => (
                  <option key={p.id} value={p.asin}>{p.asin} — {(p.product_name || p.display_name || '').slice(0, 50)}</option>
                ))}
              </select>
              {product && (
                <div className="flex items-center gap-3 p-3 bg-surface-2 border border-surface-3 rounded-xl">
                  {product.product_image_url
                    ? <img src={product.product_image_url} alt="" className="w-10 h-10 rounded object-cover bg-surface-3 flex-shrink-0" />
                    : <div className="w-10 h-10 rounded bg-surface-3 flex items-center justify-center flex-shrink-0"><Package className="w-5 h-5 text-slate-600" /></div>}
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-white truncate">{product.product_name || product.display_name}</p>
                    <p className="text-[10px] text-slate-500 font-mono mt-0.5">{product.asin}{product.sku ? ` · ${product.sku}` : ''}</p>
                    <p className={`text-[10px] mt-0.5 ${product.inventory_status === 'out_of_stock' ? 'text-red-400' : 'text-emerald-400'}`}>
                      {product.fba_inventory || 0} un. em estoque
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* STEP 2 — Keywords (só para MANUAL) */}
          {step === 2 && campaignType === 'manual' && (
            <div className="space-y-3">
              <p className="text-sm font-semibold text-white mb-4">De onde vêm as palavras-chave?</p>
              {[
                {
                  key: 'amazon',
                  icon: Bot,
                  color: 'text-violet-400',
                  bg: 'border-violet-400/30 bg-violet-400/8',
                  label: 'Sugestões da Amazon Ads',
                  sub: 'Usa os termos ranqueados pela IA a partir das sugestões oficiais da Amazon (confiança ≥ 90%).',
                },
                {
                  key: 'manual',
                  icon: Tag,
                  color: 'text-cyan',
                  bg: 'border-cyan/30 bg-cyan/8',
                  label: 'Digitar manualmente',
                  sub: 'Informe os termos exatos. Até 4 keywords por campanha, um por linha.',
                },
              ].map(opt => (
                <button key={opt.key} onClick={() => setKeywordSource(opt.key)}
                  className={`w-full flex items-start gap-4 p-4 rounded-xl border-2 text-left transition-all ${
                    keywordSource === opt.key ? opt.bg : 'border-surface-2 hover:border-surface-3 bg-surface-2/40'
                  }`}>
                  <opt.icon className={`w-5 h-5 flex-shrink-0 mt-0.5 ${keywordSource === opt.key ? opt.color : 'text-slate-500'}`} />
                  <div className="flex-1">
                    <p className={`text-sm font-semibold ${keywordSource === opt.key ? 'text-white' : 'text-slate-400'}`}>{opt.label}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{opt.sub}</p>
                  </div>
                  {keywordSource === opt.key && <CheckCircle className={`w-4 h-4 ml-auto flex-shrink-0 ${opt.color}`} />}
                </button>
              ))}

              {keywordSource === 'manual' && (
                <div className="mt-2">
                  <label className="text-xs text-slate-500 mb-1 block">Keywords (uma por linha, máx. 4)</label>
                  <textarea
                    rows={4}
                    value={manualKeywords}
                    onChange={e => setManualKeywords(e.target.value)}
                    placeholder={"caixa organizadora\ncaixa organizadora plástica\norganizador de gaveta"}
                    className="w-full px-3 py-2 bg-surface-2 border border-surface-3 rounded-xl text-sm text-white placeholder-slate-600 focus:outline-none focus:border-cyan/50 resize-none"
                  />
                  <p className="text-[10px] text-slate-600 mt-1">
                    {manualKeywords.split('\n').filter(k => k.trim()).length} / 4 keywords
                  </p>
                </div>
              )}
            </div>
          )}

          {/* STEP 2 — AUTO não precisa de keywords */}
          {step === 2 && campaignType === 'auto' && (
            <div className="flex flex-col items-center justify-center gap-3 text-center py-6">
              <div className="w-12 h-12 rounded-2xl bg-amber-400/15 border border-amber-400/25 flex items-center justify-center">
                <Zap className="w-6 h-6 text-amber-400" />
              </div>
              <p className="text-sm font-semibold text-white">Campanha AUTO</p>
              <p className="text-xs text-slate-400 max-w-xs">
                Não é necessário definir keywords. A Amazon descobre automaticamente quais termos são relevantes para <span className="text-cyan font-mono">{selectedAsin}</span>.
              </p>
            </div>
          )}

          {/* STEP 3 — Confirmação */}
          {step === 3 && (
            <div className="space-y-3">
              <p className="text-sm font-semibold text-white mb-4">Confirmar criação</p>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between py-2 border-b border-surface-2">
                  <span className="text-slate-500">Tipo</span>
                  <span className={`font-semibold ${campaignType === 'auto' ? 'text-amber-400' : 'text-cyan'}`}>
                    {campaignType === 'auto' ? '⚡ Automática' : '✦ Manual EXACT'}
                  </span>
                </div>
                <div className="flex justify-between py-2 border-b border-surface-2">
                  <span className="text-slate-500">Produto</span>
                  <span className="text-white font-mono text-xs">{selectedAsin}</span>
                </div>
                {campaignType === 'manual' && (
                  <div className="flex justify-between py-2 border-b border-surface-2">
                    <span className="text-slate-500">Keywords</span>
                    <span className="text-white">
                      {keywordSource === 'amazon'
                        ? 'Sugestões Amazon Ads (IA)'
                        : `${manualKeywords.split('\n').filter(k => k.trim()).length} manual(is)`}
                    </span>
                  </div>
                )}
              </div>
              {keywordSource === 'manual' && manualKeywords && (
                <div className="bg-surface-2 rounded-lg p-3">
                  <p className="text-[10px] text-slate-500 mb-1">Keywords:</p>
                  {manualKeywords.split('\n').filter(k => k.trim()).slice(0, 4).map((k, i) => (
                    <p key={i} className="text-xs text-white">· {k.trim()}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Navigation */}
          <div className="flex items-center justify-between mt-6 pt-4 border-t border-surface-2">
            <button
              onClick={() => step === 0 ? onClose() : setStep(s => s - 1)}
              className="flex items-center gap-1.5 px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
              {step === 0 ? 'Cancelar' : 'Voltar'}
            </button>

            {step < STEPS.length - 1 ? (
              <button
                onClick={() => setStep(s => s + 1)}
                disabled={!canNext()}
                className="flex items-center gap-1.5 px-5 py-2.5 bg-cyan text-white text-sm font-semibold rounded-xl hover:bg-cyan/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Continuar <ChevronRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                onClick={handleCreate}
                disabled={loading}
                className="flex items-center gap-2 px-5 py-2.5 bg-emerald-500 text-white text-sm font-semibold rounded-xl hover:bg-emerald-400 transition-colors disabled:opacity-50"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                {loading ? 'Criando...' : 'Criar campanha'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}