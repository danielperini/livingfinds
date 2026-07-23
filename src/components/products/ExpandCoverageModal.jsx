import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { X, Zap, CheckCircle2, AlertCircle, Loader2, ChevronDown, ChevronUp } from 'lucide-react';

export default function ExpandCoverageModal({ accountId, asin, productName, onClose }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [showCreated, setShowCreated] = useState(false);
  const [maxCampaigns, setMaxCampaigns] = useState(30);

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await base44.functions.invoke('expandCoverageForAsin', {
        amazon_account_id: accountId,
        asin,
        max_campaigns: maxCampaigns,
      });
      const data = res?.data || res;
      if (data?.ok === false) {
        setError(data.error || 'Erro desconhecido');
      } else {
        setResult(data);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="relative w-full max-w-lg mx-4 bg-[#111827] border border-[#263244] rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#263244]">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-cyan" />
            <h2 className="text-base font-semibold text-white">Expansão de Cobertura</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {/* Info */}
          <div className="rounded-lg bg-[#172033] p-3 text-sm">
            <p className="text-white font-medium">{productName || asin}</p>
            <p className="text-slate-400 text-xs mt-1">ASIN: {asin}</p>
          </div>

          <p className="text-sm text-slate-300">
            Esta operação vai:
          </p>
          <ul className="text-xs text-slate-400 space-y-1 list-none">
            <li className="flex items-start gap-2"><span className="text-cyan mt-0.5">1.</span> Reativar a campanha AUTO pausada com budget de R$15</li>
            <li className="flex items-start gap-2"><span className="text-cyan mt-0.5">2.</span> Buscar termos no KeywordBank, sugestões Amazon e lista prioritária</li>
            <li className="flex items-start gap-2"><span className="text-cyan mt-0.5">3.</span> Criar até {maxCampaigns} campanhas manuais EXACT canônicas (1 keyword cada)</li>
            <li className="flex items-start gap-2"><span className="text-cyan mt-0.5">4.</span> Ignorar termos já cobertos por campanhas ativas</li>
          </ul>

          {/* Max campaigns slider */}
          {!result && !running && (
            <div className="flex items-center gap-3">
              <label className="text-xs text-slate-400 whitespace-nowrap">Máx. campanhas:</label>
              <input
                type="range"
                min={5}
                max={30}
                step={5}
                value={maxCampaigns}
                onChange={e => setMaxCampaigns(Number(e.target.value))}
                className="flex-1"
              />
              <span className="text-sm font-semibold text-cyan w-6 text-right">{maxCampaigns}</span>
            </div>
          )}

          {/* Running state */}
          {running && (
            <div className="rounded-lg bg-[#172033] border border-cyan/20 p-4 space-y-3">
              <div className="flex items-center gap-3">
                <Loader2 className="w-5 h-5 text-cyan animate-spin flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-white">Executando expansão...</p>
                  <p className="text-xs text-slate-400 mt-0.5">Isso pode levar 2-5 minutos (delay entre criações para evitar rate limit da Amazon)</p>
                </div>
              </div>
              <div className="h-1 bg-[#263244] rounded-full overflow-hidden">
                <div className="h-full bg-cyan rounded-full animate-pulse w-1/2" />
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-lg bg-red-900/20 border border-red-500/30 p-3 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-300">{error}</p>
            </div>
          )}

          {/* Result */}
          {result && (
            <div className="space-y-3">
              {/* Summary cards */}
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-[#172033] p-3 text-center">
                  <p className="text-2xl font-bold text-cyan">{result.campaigns_created}</p>
                  <p className="text-xs text-slate-400 mt-1">Campanhas criadas</p>
                </div>
                <div className="rounded-lg bg-[#172033] p-3 text-center">
                  <p className="text-2xl font-bold text-slate-300">{result.terms_found}</p>
                  <p className="text-xs text-slate-400 mt-1">Termos encontrados</p>
                </div>
                <div className="rounded-lg bg-[#172033] p-3 text-center">
                  <p className="text-2xl font-bold text-slate-400">{result.campaigns_skipped_duplicate}</p>
                  <p className="text-xs text-slate-400 mt-1">Já existiam</p>
                </div>
                <div className="rounded-lg bg-[#172033] p-3 text-center">
                  <p className={`text-2xl font-bold ${result.campaigns_failed > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                    {result.campaigns_failed > 0 ? result.campaigns_failed : '✓'}
                  </p>
                  <p className="text-xs text-slate-400 mt-1">{result.campaigns_failed > 0 ? 'Falhas' : 'Sem falhas'}</p>
                </div>
              </div>

              {/* AUTO status */}
              <div className={`rounded-lg p-3 flex items-center gap-2 text-sm ${result.auto_reactivated ? 'bg-emerald-900/20 border border-emerald-500/30' : 'bg-amber-900/20 border border-amber-500/30'}`}>
                {result.auto_reactivated
                  ? <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                  : <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0" />
                }
                <span className={result.auto_reactivated ? 'text-emerald-300' : 'text-amber-300'}>
                  {result.auto_reactivated
                    ? 'Campanha AUTO reativada com budget R$15'
                    : `AUTO não reativada: ${result.auto_reactivation_error || 'erro desconhecido'}`
                  }
                </span>
              </div>

              {/* Created campaigns list */}
              {result.created_campaigns?.length > 0 && (
                <div>
                  <button
                    onClick={() => setShowCreated(v => !v)}
                    className="flex items-center gap-1 text-xs text-cyan hover:underline"
                  >
                    {showCreated ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    Ver {result.created_campaigns.length} campanhas criadas
                  </button>
                  {showCreated && (
                    <div className="mt-2 max-h-48 overflow-y-auto space-y-1 scrollbar-thin">
                      {result.created_campaigns.map((c, i) => (
                        <div key={i} className="text-xs text-slate-300 flex items-center gap-2">
                          <CheckCircle2 className="w-3 h-3 text-emerald-400 flex-shrink-0" />
                          <span className="truncate">{c.keyword}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Errors */}
              {result.errors?.length > 0 && (
                <div className="rounded-lg bg-red-900/10 border border-red-500/20 p-3">
                  <p className="text-xs text-red-400 font-medium mb-1">{result.errors.length} erro(s):</p>
                  <div className="max-h-24 overflow-y-auto space-y-1 scrollbar-thin">
                    {result.errors.slice(0, 5).map((e, i) => (
                      <p key={i} className="text-xs text-red-300">{e.keyword}: {e.error}</p>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[#263244] flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-white border border-[#263244] hover:border-slate-500 transition-colors"
          >
            {result ? 'Fechar' : 'Cancelar'}
          </button>
          {!result && (
            <button
              onClick={handleRun}
              disabled={running}
              className="px-5 py-2 rounded-lg text-sm font-semibold bg-cyan text-white hover:bg-cyan/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-colors"
            >
              {running ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Executando...</>
              ) : (
                <><Zap className="w-4 h-4" /> Iniciar Expansão</>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}