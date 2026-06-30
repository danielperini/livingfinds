import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Rocket, CheckCircle, XCircle, AlertTriangle, Loader2, X, ChevronRight, Info, ShieldAlert, Package, DollarSign, Target } from 'lucide-react';

export default function AcceleratorModal({ product, account, onClose, onDone }) {
  const [step, setStep] = useState('keywords'); // keywords | validate | preview | creating | done
  const [keywordsRaw, setKeywordsRaw] = useState('');
  const [parsed, setParsed] = useState(null);
  const [validation, setValidation] = useState(null);
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // Parse keywords ao digitar (debounce manual)
  const handleKeywordsChange = (value) => {
    setKeywordsRaw(value);
    if (value.trim().length > 0) {
      const lines = value.split(/[\n,;]+/).filter(l => l.trim());
      const cleaned = [];
      const duplicates = [];
      const invalid = [];
      const brandConflicts = [];
      const seen = new Set();
      
      for (const line of lines) {
        let text = line.replace(/^[\s\d\.\-\*\•\+\u2022\u2023\u25E6]+/, '').trim();
        if (!text) continue;
        if (text.length < 1 || text.length > 100) { invalid.push(text); continue; }
        
        // Verificar marcas conflitantes (simplificado)
        const lowerText = text.toLowerCase();
        if (lowerText.includes('tuya') || lowerText.includes('alexa') || lowerText.includes('google home')) {
          // Verificar se produto é compatível
          brandConflicts.push(text);
        }
        
        const normalized = text.toLowerCase().replace(/\s+/g, ' ');
        if (seen.has(normalized)) { duplicates.push(text); continue; }
        seen.add(normalized);
        cleaned.push(text);
      }
      
      setParsed({
        original_count: lines.length,
        valid_count: cleaned.length,
        valid: cleaned,
        duplicate_count: duplicates.length,
        invalid_count: invalid.length,
        brand_conflict_count: brandConflicts.length,
        brand_conflicts: brandConflicts,
      });
    } else {
      setParsed(null);
    }
  };

  // Validar pré-criação
  const validate = async () => {
    if (!parsed || parsed.valid_count === 0) return;
    
    setValidation({ loading: true });
    try {
      // Chamar validação backend
      const res = await base44.functions.invoke('validateAdGroupCreation', {
        amazon_account_id: account.id,
        asin: product.asin,
        sku: product.sku,
        keywords: parsed.valid,
        match_type: 'exact',
        campaign_type: 'SP',
        targeting_type: 'MANUAL',
      });
      
      const d = res.data;
      
      if (d?.ok) {
        const hasBlocks = d.validations?.blocks?.length > 0;
        const hasAlerts = d.validations?.alerts?.length > 0;
        
        setValidation({
          loading: false,
          passed: !hasBlocks,
          blocks: d.validations?.blocks || [],
          alerts: d.validations?.alerts || [],
          warnings: d.validations?.warnings || [],
          checks: d.validations?.checks || {},
          duplicate: d.validations?.existing_campaign || null,
          sku_conflict: d.validations?.sku_conflict || null,
        });
        
        if (!hasBlocks) setStep('preview');
      } else {
        setValidation({ loading: false, error: d?.error || 'Erro na validação' });
      }
    } catch (e) {
      setValidation({ loading: false, error: e.message });
    }
  };

  // Criar campanha
  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await base44.functions.invoke('createAcceleratorCampaign', {
        amazon_account_id: account.id,
        asin: product.asin,
        sku: product.sku,
        product_name: product.product_name,
        keywords_raw: keywordsRaw,
        mode: 'assisted',
      });
      
      const d = res.data;
      if (d?.ok) {
        setResult(d);
        setStep('done');
        onDone?.();
      } else {
        setError(d?.error || d?.message || 'Erro ao criar campanha');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setCreating(false);
    }
  };

  const canProceed = parsed && parsed.valid_count > 0;
  const identifier = (product.sku || product.asin).replace(/[^A-Z0-9]/gi, '-').toUpperCase();
  const today = new Date().toISOString().slice(0, 7); // YYYY-MM
  const productName = (product.product_name || 'PRODUTO').slice(0, 20).toUpperCase().replace(/[^A-Z0-9]/gi, '-');
  const campaignName = `SP-MAN-EXATA-${identifier}-CONVERSAO-${today}`;
  const adGroupName = `AG-SP-EXATA-${identifier}-${productName}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-surface-1 border border-surface-2 rounded-2xl w-full max-w-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-2 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-cyan/15 border border-cyan/20 flex items-center justify-center">
              <Rocket className="w-5 h-5 text-cyan" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">Acelerador de Campanhas</h2>
              <p className="text-xs text-slate-400 font-mono">{product.asin}{product.sku ? ` · ${product.sku}` : ''}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors text-lg leading-none">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Steps */}
        <div className="flex items-center gap-2 px-6 py-3 bg-surface-2/40 border-b border-surface-2 flex-shrink-0">
          {[
            { key: 'keywords', label: '1. Keywords' },
            { key: 'validate', label: '2. Validar' },
            { key: 'preview', label: '3. Prévia' },
            { key: 'creating', label: '4. Criar' },
            { key: 'done', label: '5. Concluído' },
          ].map((s, i, arr) => (
            <div key={s.key} className="flex items-center gap-2">
              <span className={`text-xs font-semibold px-2 py-1 rounded-full ${
                step === s.key ? 'bg-cyan text-white' :
                (['done', 'creating'].includes(step) && ['keywords', 'validate', 'preview', 'creating'].includes(s.key)) ? 'bg-emerald-500/20 text-emerald-400' :
                'bg-surface-3 text-slate-500'
              }`}>
                {s.label}
              </span>
              {i < arr.length - 1 && <ChevronRight className="w-3 h-3 text-slate-600" />}
            </div>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto scrollbar-thin p-6">
          {/* STEP 1: Keywords */}
          {step === 'keywords' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-white mb-1">Palavras-chave pesquisadas por IA</h3>
                <p className="text-xs text-slate-500">
                  Cole uma palavra-chave por linha ou separe por vírgula/ponto e vírgula. Todas serão criadas em correspondência exata.
                </p>
              </div>

              <textarea
                value={keywordsRaw}
                onChange={(e) => handleKeywordsChange(e.target.value)}
                placeholder="lixeira automática&#10;lixeira inteligente 13 litros&#10;lixeira com sensor de aproximação"
                className="w-full h-48 px-4 py-3 bg-surface-2 border border-surface-3 rounded-xl text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-cyan/50 resize-none font-mono"
              />

              {parsed && (
                <div className="grid grid-cols-4 gap-3">
                  <div className="bg-surface-2 rounded-xl p-3 border border-surface-3">
                    <p className="text-xs text-slate-500">Recebidas</p>
                    <p className="text-lg font-bold text-white">{parsed.original_count}</p>
                  </div>
                  <div className="bg-emerald-400/10 rounded-xl p-3 border border-emerald-400/20">
                    <p className="text-xs text-emerald-400">Válidas</p>
                    <p className="text-lg font-bold text-emerald-400">{parsed.valid_count}</p>
                  </div>
                  <div className="bg-amber-400/10 rounded-xl p-3 border border-amber-400/20">
                    <p className="text-xs text-amber-400">Duplicadas</p>
                    <p className="text-lg font-bold text-amber-400">{parsed.duplicate_count}</p>
                  </div>
                  <div className="bg-red-400/10 rounded-xl p-3 border border-red-400/20">
                    <p className="text-xs text-red-400">Inválidas</p>
                    <p className="text-lg font-bold text-red-400">{parsed.invalid_count}</p>
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button onClick={onClose} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors">
                  Cancelar
                </button>
                <button
                  onClick={validate}
                  disabled={!canProceed}
                  className="flex items-center gap-2 px-5 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60"
                >
                  Validar <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}

          {/* STEP 2: Validação */}
          {step === 'validate' && validation?.loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 text-cyan animate-spin" />
              <p className="text-sm text-slate-400 ml-3">Validando campanha...</p>
            </div>
          )}

          {step === 'validate' && validation && !validation.loading && (
            <div className="space-y-4">
              {/* Blocos críticos */}
              {validation.blocks?.length > 0 && (
                <div className="space-y-2">
                  {validation.blocks.map((block, i) => (
                    <div key={i} className="flex items-start gap-3 px-4 py-3 bg-red-400/10 border border-red-400/20 rounded-xl">
                      <XCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-semibold text-red-300">Bloqueio: {block.field}</p>
                        <p className="text-xs text-red-400/80 mt-1">{block.message}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Alertas */}
              {validation.alerts?.length > 0 && (
                <div className="space-y-2">
                  {validation.alerts.map((alert, i) => (
                    <div key={i} className="flex items-start gap-3 px-4 py-3 bg-amber-400/10 border border-amber-400/20 rounded-xl">
                      <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="text-sm font-semibold text-amber-300">Alerta: {alert.field}</p>
                        <p className="text-xs text-amber-400/80 mt-1">{alert.message}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Conflito de SKU */}
              {validation.sku_conflict && (
                <div className="bg-surface-2 rounded-xl p-4 border border-surface-3">
                  <div className="flex items-center gap-2 mb-3">
                    <Package className="w-4 h-4 text-cyan" />
                    <p className="text-sm font-semibold text-white">ASIN com múltiplos SKUs</p>
                  </div>
                  <p className="text-xs text-slate-500 mb-3">
                    Este ASIN está associado a mais de um SKU. Selecione qual será anunciado:
                  </p>
                  <div className="space-y-2">
                    {validation.sku_conflict.skus.map((sku, i) => (
                      <label key={i} className="flex items-center gap-3 p-3 bg-surface-3 rounded-lg cursor-pointer hover:bg-surface-3/80 transition-colors">
                        <input type="radio" name="selected_sku" value={sku.sku} className="w-4 h-4" defaultChecked={sku.is_primary} />
                        <div className="flex-1">
                          <p className="text-sm font-semibold text-white">{sku.sku}</p>
                          <p className="text-xs text-slate-400">R$ {sku.price?.toFixed(2)} · {sku.stock_status || 'Estoque desconhecido'}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {/* Campanha duplicada */}
              {validation.duplicate && (
                <div className="flex items-start gap-3 px-4 py-3 bg-amber-400/10 border border-amber-400/20 rounded-xl">
                  <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-semibold text-amber-300">Campanha já existe</p>
                    <p className="text-xs text-amber-400/80 mt-1">
                      Já existe uma campanha para este ASIN: <span className="font-mono">{validation.duplicate.campaign_name}</span> ({validation.duplicate.state})
                    </p>
                  </div>
                </div>
              )}

              {!validation.blocks?.length && !validation.alerts?.length && !validation.sku_conflict && !validation.duplicate && (
                <div className="flex items-center gap-3 px-4 py-3 bg-emerald-400/10 border border-emerald-400/20 rounded-xl">
                  <CheckCircle className="w-5 h-5 text-emerald-400 flex-shrink-0" />
                  <p className="text-sm font-semibold text-emerald-300">Validação concluída! Tudo certo para criar a campanha.</p>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => setStep('keywords')} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors">
                  Voltar
                </button>
                {!validation.blocks?.length && (
                  <button onClick={() => setStep('preview')} className="flex items-center gap-2 px-5 py-2 bg-cyan hover:bg-cyan/90 text-white text-sm font-semibold rounded-lg transition-colors">
                    Continuar <ChevronRight className="w-4 h-4" />
                  </button>
                )}
                <button onClick={onClose} className="px-5 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm font-semibold rounded-lg transition-colors">
                  Fechar
                </button>
              </div>
            </div>
          )}

          {/* STEP 3: Prévia */}
          {step === 'preview' && validation && (
            <div className="space-y-4">
              <div className="bg-surface-2 rounded-xl p-4 border border-surface-3 space-y-3">
                <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Info className="w-4 h-4 text-cyan" />
                  Prévia da Campanha
                </h3>

                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <p className="text-slate-500 mb-0.5">Produto</p>
                      <p className="text-slate-200 font-medium truncate">{product.product_name || product.asin}</p>
                    </div>
                    <div>
                      <p className="text-slate-500 mb-0.5">ASIN</p>
                      <p className="text-slate-200 font-mono">{product.asin}</p>
                    </div>
                    <div>
                      <p className="text-slate-500 mb-0.5">SKU</p>
                      <p className="text-slate-200 font-mono">{product.sku || 'N/A'}</p>
                    </div>
                    <div>
                      <p className="text-slate-500 mb-0.5">Campanha</p>
                      <p className="text-slate-200 font-mono text-[10px]">{campaignName}</p>
                    </div>
                    <div>
                      <p className="text-slate-500 mb-0.5">Grupo de Anúncios</p>
                      <p className="text-slate-200 font-mono text-[10px]">{adGroupName}</p>
                    </div>
                    <div>
                      <p className="text-slate-500 mb-0.5">Orçamento Diário</p>
                      <p className="text-emerald-400 font-semibold">R$ 25,00</p>
                    </div>
                  </div>

                  <div className="border-t border-surface-3 pt-3">
                    <p className="text-xs text-slate-500 mb-2 font-semibold">Configurações de Lance:</p>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="bg-surface-3 rounded-lg px-3 py-2">
                        <p className="text-[10px] text-slate-400">Lance Inicial</p>
                        <p className="text-sm font-semibold text-white">R$ 0,30</p>
                      </div>
                      <div className="bg-surface-3 rounded-lg px-3 py-2">
                        <p className="text-[10px] text-slate-400">Estratégia</p>
                        <p className="text-xs text-slate-200">Down only</p>
                      </div>
                    </div>
                  </div>

                  <div className="border-t border-surface-3 pt-3">
                    <p className="text-xs text-slate-500 mb-2 font-semibold">Ajustes de Placement (Grupo Novo):</p>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="bg-surface-3 rounded-lg px-3 py-2 text-center">
                        <p className="text-[10px] text-slate-400">Topo Pesquisa</p>
                        <p className="text-sm font-semibold text-slate-300">0%</p>
                      </div>
                      <div className="bg-surface-3 rounded-lg px-3 py-2 text-center">
                        <p className="text-[10px] text-slate-400">Restante</p>
                        <p className="text-sm font-semibold text-slate-300">0%</p>
                      </div>
                      <div className="bg-surface-3 rounded-lg px-3 py-2 text-center">
                        <p className="text-[10px] text-slate-400">Páginas Produto</p>
                        <p className="text-sm font-semibold text-slate-300">0%</p>
                      </div>
                    </div>
                    <p className="text-[10px] text-slate-500 mt-2 flex items-center gap-1">
                      <ShieldAlert className="w-3 h-3" />
                      Configuração conservadora para grupo em aprendizado
                    </p>
                  </div>
                </div>
              </div>

              {parsed?.valid && parsed.valid_count > 0 && (
                <div className="bg-surface-2 rounded-xl p-4 border border-surface-3">
                  <p className="text-xs text-slate-500 mb-2 font-semibold">
                    Keywords que serão criadas ({parsed.valid_count}):
                  </p>
                  <div className="max-h-32 overflow-y-auto scrollbar-thin space-y-1">
                    {parsed.valid.slice(0, 10).map((kw, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <CheckCircle className="w-3 h-3 text-emerald-400 flex-shrink-0" />
                        <span className="text-slate-300">{kw}</span>
                      </div>
                    ))}
                    {parsed.valid_count > 10 && (
                      <p className="text-xs text-slate-500 italic">+{parsed.valid_count - 10} mais...</p>
                    )}
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => setStep('keywords')} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors">
                  Voltar
                </button>
                <button
                  onClick={create}
                  disabled={creating}
                  className="flex items-center gap-2 px-5 py-2 bg-emerald-500 hover:bg-emerald-400 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60"
                >
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
                  {creating ? 'Criando...' : 'Criar Campanha'}
                </button>
              </div>
            </div>
          )}

          {/* STEP 4: Criando */}
          {step === 'creating' && (
            <div className="flex flex-col items-center justify-center py-12 space-y-4">
              <Loader2 className="w-12 h-12 text-cyan animate-spin" />
              <p className="text-sm font-semibold text-white">Criando campanha na Amazon Ads...</p>
              <p className="text-xs text-slate-500">Isso pode levar alguns segundos</p>
            </div>
          )}

          {/* STEP 5: Concluído */}
          {step === 'done' && result && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <CheckCircle className="w-8 h-8 text-emerald-400 flex-shrink-0" />
                <div>
                  <p className="text-sm font-bold text-white">Campanha criada com sucesso!</p>
                  <p className="text-xs text-slate-400">{result.keywords_created} keywords criadas</p>
                </div>
              </div>

              <div className="bg-surface-2 rounded-xl p-4 border border-surface-3 space-y-3">
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <p className="text-slate-500">Campanha</p>
                    <p className="text-slate-200 font-mono text-[10px] truncate">{result.campaign_name}</p>
                  </div>
                  <div>
                    <p className="text-slate-500">Campaign ID</p>
                    <p className="text-slate-200 font-mono text-[10px]">{result.campaign_id}</p>
                  </div>
                  <div>
                    <p className="text-slate-500">Orçamento</p>
                    <p className="text-emerald-400 font-semibold">R$ {result.daily_budget}/dia</p>
                  </div>
                  <div>
                    <p className="text-slate-500">Bid Inicial</p>
                    <p className="text-slate-200">R$ {result.initial_bid}</p>
                  </div>
                </div>
              </div>

              {result.keywords && result.keywords.length > 0 && (
                <div className="bg-surface-2 rounded-xl p-4 border border-surface-3">
                  <p className="text-xs text-slate-500 mb-2 font-semibold">Keywords criadas:</p>
                  <div className="max-h-40 overflow-y-auto scrollbar-thin space-y-1.5">
                    {result.keywords.map((k, i) => (
                      <div key={i} className="flex items-center justify-between text-xs bg-surface-3 rounded-lg px-3 py-2">
                        <span className="text-slate-300 truncate flex-1">{k.keyword_text}</span>
                        <span className="text-cyan font-mono ml-2">R$ {k.bid}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex justify-end pt-2">
                <button onClick={onClose} className="px-5 py-2 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-sm font-semibold rounded-lg transition-colors">
                  Fechar
                </button>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-start gap-3 px-4 py-3 bg-red-400/10 border border-red-400/20 rounded-xl">
              <XCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-red-300">Erro</p>
                <p className="text-xs text-red-400/80 mt-1">{error}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}