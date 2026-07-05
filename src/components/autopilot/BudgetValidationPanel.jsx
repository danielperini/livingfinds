import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import {
  TrendingUp, TrendingDown, Minus, Loader2, RefreshCw,
  CheckCircle, AlertCircle, DollarSign, BarChart2
} from 'lucide-react';

const TREND_ICONS = {
  growth: { icon: TrendingUp, color: 'text-emerald-400', label: '↑ Crescimento' },
  decline: { icon: TrendingDown, color: 'text-red-400', label: '↓ Queda' },
  stable: { icon: Minus, color: 'text-slate-400', label: '→ Estável' },
};

function DeltaBadge({ delta, deltaPercent }) {
  if (delta === null || delta === undefined) return <span className="text-slate-600 text-xs">—</span>;
  const isUp = delta > 0;
  const isDown = delta < 0;
  const color = isUp ? 'text-emerald-400' : isDown ? 'text-red-400' : 'text-slate-400';
  return (
    <span className={`text-xs font-semibold ${color}`}>
      {isUp ? '+' : ''}{delta.toFixed(2)} ({isUp ? '+' : ''}{(deltaPercent || 0).toFixed(1)}%)
    </span>
  );
}

export default function BudgetValidationPanel({ account }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [applyingId, setApplyingId] = useState(null);
  const [applied, setApplied] = useState(new Set());

  const runValidation = async () => {
    if (!account) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await base44.functions.invoke('validateCampaignBudgets', {
        amazon_account_id: account.id,
      });
      const data = res?.data;
      if (data?.ok) {
        setResult(data);
      } else {
        setError(data?.error || 'Falha ao executar validação.');
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const applyBudget = async (suggestion) => {
    setApplyingId(suggestion.campaign_id);
    try {
      await base44.entities.Campaign.update(suggestion.campaign_id, {
        daily_budget: suggestion.suggested_budget,
        reconciliation_status: 'ok',
        reconciliation_notes: `Budget ajustado via validação 30d: ${suggestion.reasoning?.slice(0, 300)}`,
      });
      setApplied(prev => new Set([...prev, suggestion.campaign_id]));
    } catch (e) {
      alert('Erro ao aplicar budget: ' + e.message);
    } finally {
      setApplyingId(null);
    }
  };

  const suggestions = result?.suggestions || [];
  const sym = 'R$';

  return (
    <div className="space-y-4">
      {/* Header com resumo e botão */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-emerald-400" />
            Validação de Budget por Campanha
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Analisa gasto real dos últimos 30 dias e sugere orçamento diário ideal com reserva de 30%.
          </p>
        </div>
        <button
          onClick={runValidation}
          disabled={loading || !account}
          className="flex items-center gap-2 px-4 py-2 text-xs font-semibold bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25 rounded-lg transition-colors disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {loading ? 'Analisando...' : 'Analisar Agora'}
        </button>
      </div>

      {/* KPIs do resultado */}
      {result && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: 'Campanhas analisadas', value: result.campaigns_analyzed, color: 'text-cyan' },
            { label: 'Sem dados suficientes', value: result.campaigns_skipped_no_data, color: 'text-slate-400' },
            { label: 'Gasto médio real/dia', value: `${sym}${(result.total_avg_spend_30d || 0).toFixed(2)}`, color: 'text-white' },
            { label: 'Budget total sugerido', value: `${sym}${(result.total_suggested_budget || 0).toFixed(2)}`, color: 'text-emerald-400' },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-surface-2 rounded-lg p-3 border border-surface-3">
              <p className={`text-sm font-bold ${color}`}>{value}</p>
              <p className="text-[10px] text-slate-500 mt-0.5">{label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Reserva info */}
      {result && (
        <div className="flex items-center gap-2 p-3 bg-emerald-500/5 border border-emerald-500/20 rounded-lg text-xs text-emerald-300">
          <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" />
          Reserva operacional de <strong>30%</strong> aplicada automaticamente sobre a média ponderada (60% 30d + 40% 15d).
          Budget atual total: <strong>{sym}{(result.total_current_budget || 0).toFixed(2)}/dia</strong> →
          Sugerido: <strong>{sym}{(result.total_suggested_budget || 0).toFixed(2)}/dia</strong>
        </div>
      )}

      {/* Erro */}
      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-300">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Tabela de sugestões */}
      {suggestions.length > 0 && (
        <div className="rounded-xl border border-surface-2 overflow-hidden">
          <div className="px-4 py-2 border-b border-surface-2 bg-surface-1 flex items-center gap-2">
            <BarChart2 className="w-3.5 h-3.5 text-slate-500" />
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              {suggestions.length} campanhas com sugestão (ordenadas por maior delta)
            </span>
          </div>
          <table className="w-full">
            <thead>
              <tr className="border-b border-surface-2 bg-surface-1/50">
                {['Campanha', 'Budget Atual', 'Gasto Médio 30d', 'Sugerido (+30%)', 'Δ Diferença', 'Tendência', 'Dias', 'Ação'].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {suggestions.map((s) => {
                const isApplied = applied.has(s.campaign_id);
                const isApplying = applyingId === s.campaign_id;
                const trendCfg = TREND_ICONS[s.trend] || TREND_ICONS.stable;
                const TrendIcon = trendCfg.icon;
                const bigDelta = s.delta !== null && Math.abs(s.delta) > 5;

                return (
                  <tr key={s.campaign_id} className={`border-b border-surface-2/40 transition-colors ${isApplied ? 'bg-emerald-500/5' : 'hover:bg-surface-2/40'}`}>
                    <td className="px-4 py-3 max-w-[200px]">
                      <p className="text-xs font-semibold text-white truncate">{s.name || '—'}</p>
                      <p className="text-[10px] font-mono text-slate-500">{s.amazon_campaign_id}</p>
                    </td>
                    <td className="px-4 py-3 text-xs font-mono text-slate-300 whitespace-nowrap">
                      {sym}{(s.current_budget || 0).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-xs font-mono text-slate-400 whitespace-nowrap">
                      {sym}{(s.avg_spend_30d || 0).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-xs font-mono font-bold text-emerald-400 whitespace-nowrap">
                      {sym}{(s.suggested_budget || 0).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <DeltaBadge delta={s.delta} deltaPercent={s.delta_percent} />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`flex items-center gap-1 text-xs ${trendCfg.color}`}>
                        <TrendIcon className="w-3 h-3" />{trendCfg.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {s.days_analyzed}d
                    </td>
                    <td className="px-4 py-3">
                      {isApplied ? (
                        <span className="flex items-center gap-1 text-xs text-emerald-400">
                          <CheckCircle className="w-3 h-3" /> Aplicado
                        </span>
                      ) : (
                        <button
                          onClick={() => applyBudget(s)}
                          disabled={isApplying || !bigDelta}
                          title={!bigDelta ? 'Diferença menor que R$5 — ajuste não necessário' : `Aplicar ${sym}${s.suggested_budget}/dia`}
                          className={`flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg transition-colors disabled:opacity-40 ${
                            bigDelta
                              ? 'bg-cyan/10 border border-cyan/30 text-cyan hover:bg-cyan/20'
                              : 'bg-surface-3 border border-surface-3 text-slate-600 cursor-not-allowed'
                          }`}
                        >
                          {isApplying ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                          {isApplying ? 'Aplicando...' : 'Aplicar'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty state */}
      {!loading && !result && !error && (
        <div className="text-center py-12 text-slate-500">
          <DollarSign className="w-8 h-8 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Clique em <strong className="text-slate-400">Analisar Agora</strong> para calcular os budgets sugeridos.</p>
          <p className="text-xs mt-1 text-slate-600">Análise automática baseada no gasto real dos últimos 30 dias · Reserva de 30% aplicada</p>
        </div>
      )}
    </div>
  );
}