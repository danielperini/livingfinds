/**
 * ZeroBidFixPanel
 * Corrige bids de keywords SP Manual Exact com zero impressões e bid abaixo do mínimo competitivo.
 * Fluxo: dry_run preview → tabela agrupada por campanha → confirmar → resultado.
 */
import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import {
  Zap, Loader2, CheckCircle, XCircle, AlertTriangle, ChevronDown,
  ChevronUp, ArrowRight, Play
} from 'lucide-react';

const CATEGORY_COLORS = {
  lixeira:   'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
  fechadura: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  headset:   'text-blue-400 bg-blue-500/10 border-blue-500/20',
  microfone: 'text-violet-400 bg-violet-500/10 border-violet-500/20',
  outros:    'text-slate-400 bg-slate-500/10 border-slate-500/20',
};

function fmt(v) {
  return `R$${Number(v || 0).toFixed(2)}`;
}

function CampaignGroup({ campaign, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-surface-2 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-surface-2/40 hover:bg-surface-2/60 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-bold text-white truncate">{campaign.campaign_name}</span>
          <span className="text-[10px] px-2 py-0.5 bg-cyan/10 border border-cyan/20 text-cyan rounded-full flex-shrink-0">
            {campaign.keywords.length} keyword{campaign.keywords.length !== 1 ? 's' : ''}
          </span>
        </div>
        {open ? <ChevronUp className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />}
      </button>
      {open && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-surface-2 bg-surface-2/20">
                {['Keyword', 'Match', 'Categoria', 'Bid Atual', '', 'Bid Novo'].map((h, i) => (
                  <th key={i} className="px-4 py-2 text-left text-[10px] font-semibold text-slate-500 uppercase whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {campaign.keywords.map((kw, i) => {
                const catStyle = CATEGORY_COLORS[kw.category] || CATEGORY_COLORS.outros;
                return (
                  <tr key={i} className="border-b border-surface-2/40 hover:bg-surface-2/20 transition-colors">
                    <td className="px-4 py-2.5 font-medium text-white">{kw.keyword_text}</td>
                    <td className="px-4 py-2.5 text-slate-400">{kw.match_type}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${catStyle}`}>{kw.category}</span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-red-400">{fmt(kw.current_bid)}</td>
                    <td className="px-4 py-2.5">
                      <ArrowRight className="w-3.5 h-3.5 text-slate-600" />
                    </td>
                    <td className="px-4 py-2.5 font-mono font-bold text-emerald-400">{fmt(kw.new_bid)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function ZeroBidFixPanel({ account }) {
  const [phase, setPhase] = useState('idle'); // idle | loading_preview | preview | applying | result
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const runPreview = async () => {
    if (!account) return;
    setPhase('loading_preview');
    setError(null);
    setPreview(null);
    try {
      const res = await base44.functions.invoke('fixZeroCampaignBids', {
        amazon_account_id: account.id,
        dry_run: true,
      });
      const data = res?.data || res;
      if (data?.ok) {
        setPreview(data);
        setPhase('preview');
      } else {
        setError(data?.error || 'Erro ao carregar preview');
        setPhase('idle');
      }
    } catch (e) {
      setError(e.message);
      setPhase('idle');
    }
  };

  const runFix = async () => {
    if (!account || !preview) return;
    setPhase('applying');
    setError(null);
    try {
      const res = await base44.functions.invoke('fixZeroCampaignBids', {
        amazon_account_id: account.id,
        dry_run: false,
      });
      const data = res?.data || res;
      setResult(data);
      setPhase('result');
    } catch (e) {
      setError(e.message);
      setPhase('preview');
    }
  };

  const reset = () => {
    setPhase('idle');
    setPreview(null);
    setResult(null);
    setError(null);
  };

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center flex-shrink-0 mt-0.5">
            <Zap className="w-4 h-4 text-amber-400" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-white">Corrigir Bids Zerados</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Keywords SP Manual Exact sem impressões com bid {'<'} R$0,75 — eleva para valor competitivo por categoria.
            </p>
          </div>
        </div>

        {phase === 'idle' && (
          <button
            onClick={runPreview}
            disabled={!account}
            className="flex items-center gap-2 px-4 py-2 bg-amber-500/15 border border-amber-500/30 text-amber-300 hover:bg-amber-500/25 text-sm font-semibold rounded-lg disabled:opacity-50 transition-colors flex-shrink-0"
          >
            <Zap className="w-3.5 h-3.5" />
            Analisar Keywords
          </button>
        )}

        {(phase === 'preview' || phase === 'result') && (
          <button onClick={reset} className="text-xs text-slate-500 hover:text-slate-300 px-3 py-1.5 border border-surface-3 rounded-lg transition-colors">
            Nova análise
          </button>
        )}
      </div>

      {/* Regras de detecção */}
      {phase === 'idle' && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {[
            { cat: 'lixeira', bid: 'R$1,20', style: CATEGORY_COLORS.lixeira },
            { cat: 'fechadura', bid: 'R$1,50', style: CATEGORY_COLORS.fechadura },
            { cat: 'headset/fone', bid: 'R$1,00', style: CATEGORY_COLORS.headset },
            { cat: 'microfone', bid: 'R$0,90', style: CATEGORY_COLORS.microfone },
            { cat: 'outros', bid: 'R$0,85', style: CATEGORY_COLORS.outros },
          ].map(({ cat, bid, style }) => (
            <div key={cat} className={`flex items-center justify-between px-2.5 py-2 rounded-lg border text-[10px] font-medium ${style}`}>
              <span>{cat}</span>
              <span className="font-bold">{bid}</span>
            </div>
          ))}
        </div>
      )}

      {/* Carregando preview */}
      {phase === 'loading_preview' && (
        <div className="flex items-center justify-center py-10 gap-2">
          <Loader2 className="w-5 h-5 text-amber-400 animate-spin" />
          <p className="text-sm text-slate-400">Analisando keywords...</p>
        </div>
      )}

      {/* Aplicando */}
      {phase === 'applying' && (
        <div className="flex items-center justify-center py-10 gap-2">
          <Loader2 className="w-5 h-5 text-emerald-400 animate-spin" />
          <p className="text-sm text-slate-400">Aplicando bids na Amazon Ads...</p>
        </div>
      )}

      {/* Erro */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-400">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Preview */}
      {phase === 'preview' && preview && (
        <div className="space-y-4">
          {/* Resumo */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="bg-surface-2 rounded-xl p-3 text-center">
              <p className="text-[10px] text-slate-500 mb-0.5">Keywords elegíveis</p>
              <p className="text-xl font-bold text-amber-400">{preview.total_eligible}</p>
            </div>
            <div className="bg-surface-2 rounded-xl p-3 text-center">
              <p className="text-[10px] text-slate-500 mb-0.5">Campanhas afetadas</p>
              <p className="text-xl font-bold text-white">{preview.campaigns_affected}</p>
            </div>
            <div className="bg-surface-2 rounded-xl p-3 text-center sm:col-span-1 col-span-2">
              <p className="text-[10px] text-slate-500 mb-0.5">Bid mínimo → teto</p>
              <p className="text-sm font-bold text-slate-300">R$0,85 → R$2,50</p>
            </div>
          </div>

          {preview.total_eligible === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 gap-2">
              <CheckCircle className="w-8 h-8 text-emerald-400" />
              <p className="text-sm text-slate-300 font-semibold">Nenhuma keyword elegível encontrada</p>
              <p className="text-xs text-slate-500">Todos os bids já estão acima de R$0,75 ou as keywords têm impressões.</p>
            </div>
          ) : (
            <>
              {/* Lista agrupada por campanha */}
              <div className="space-y-2 max-h-80 overflow-y-auto scrollbar-thin">
                {preview.preview.map((campaign, i) => (
                  <CampaignGroup key={campaign.campaign_id || i} campaign={campaign} defaultOpen={i === 0} />
                ))}
              </div>

              {/* Botão confirmar */}
              <div className="flex items-center justify-between flex-wrap gap-3 pt-2 border-t border-surface-2">
                <p className="text-xs text-slate-500">
                  Teto máximo absoluto: R$2,50 · Apenas keywords sem impressões · Registrado em AdsBidChangeLog
                </p>
                <button
                  onClick={runFix}
                  className="flex items-center gap-2 px-5 py-2.5 bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 text-sm font-bold rounded-lg transition-colors"
                >
                  <Play className="w-4 h-4" />
                  Confirmar e Aplicar ({preview.total_eligible})
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Resultado */}
      {phase === 'result' && result && (
        <div className="space-y-4">
          {/* Resumo */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-3 text-center">
              <p className="text-[10px] text-emerald-400 mb-0.5">Corrigidos</p>
              <p className="text-xl font-bold text-emerald-400">{result.total_fixed}</p>
            </div>
            <div className="bg-surface-2 rounded-xl p-3 text-center">
              <p className="text-[10px] text-slate-500 mb-0.5">Analisados</p>
              <p className="text-xl font-bold text-white">{result.total_analyzed}</p>
            </div>
            <div className="bg-surface-2 rounded-xl p-3 text-center">
              <p className="text-[10px] text-slate-500 mb-0.5">Elegíveis</p>
              <p className="text-xl font-bold text-amber-400">{result.total_eligible}</p>
            </div>
            <div className={`${(result.errors?.length || 0) > 0 ? 'bg-red-500/10 border border-red-500/20' : 'bg-surface-2'} rounded-xl p-3 text-center`}>
              <p className="text-[10px] text-slate-500 mb-0.5">Erros</p>
              <p className={`text-xl font-bold ${(result.errors?.length || 0) > 0 ? 'text-red-400' : 'text-slate-400'}`}>{result.errors?.length || 0}</p>
            </div>
          </div>

          {result.total_fixed > 0 && (
            <div className="flex items-center gap-2 px-4 py-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-sm text-emerald-300">
              <CheckCircle className="w-4 h-4 flex-shrink-0" />
              {result.total_fixed} keyword{result.total_fixed !== 1 ? 's' : ''} corrigida{result.total_fixed !== 1 ? 's' : ''} com sucesso — alterações registradas no Log de Bids.
            </div>
          )}

          {result.errors?.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-semibold text-red-400">Erros ({result.errors.length})</p>
              <div className="max-h-40 overflow-y-auto scrollbar-thin space-y-1">
                {result.errors.map((e, i) => (
                  <div key={i} className="flex items-start gap-2 px-3 py-2 bg-red-500/5 border border-red-500/15 rounded-lg text-xs">
                    <XCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
                    <span className="text-red-300 font-medium">{e.keyword}</span>
                    <span className="text-slate-500 truncate">{e.reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}