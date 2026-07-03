import React from 'react';
import { DollarSign, Loader2, Sparkles, TrendingUp, TrendingDown, Minus } from 'lucide-react';

export default function BudgetSuggestionCard({ metricsDaily, campaigns, products, loading, autopilotConfig }) {
  // Preferir sugestão da IA (gerada pelo dailyReportReconciliation) se disponível e recente
  const aiSuggested    = autopilotConfig?.ai_suggested_daily_budget || 0;
  const aiReasoning    = autopilotConfig?.ai_budget_reasoning       || '';
  const aiConfidence   = autopilotConfig?.ai_budget_confidence      || 0;
  const aiGeneratedAt  = autopilotConfig?.ai_budget_generated_at    || null;
  const aiBreakdown    = (() => { try { return JSON.parse(autopilotConfig?.ai_budget_breakdown || '{}'); } catch { return {}; } })();

  const isAiFresh = aiGeneratedAt
    ? (Date.now() - new Date(aiGeneratedAt).getTime()) < 48 * 3600000
    : false;

  // Fallback: cálculo estático por 30 dias
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const metricsThirtyDays = metricsDaily.filter(m => m.date >= thirtyDaysAgo);
  const avgDailySpend = metricsThirtyDays.length > 0
    ? metricsThirtyDays.reduce((sum, m) => sum + (m.spend || 0), 0) / metricsThirtyDays.length
    : 0;
  const totalProducts = products.length;
  const activeCampaigns = campaigns.filter(c => c.state === 'enabled' && !c.archived).length;
  const fallbackBudget = avgDailySpend > 0
    ? Math.max(avgDailySpend * 1.25, totalProducts * 2)
    : totalProducts * 2;

  const suggestedBudget = (isAiFresh && aiSuggested > 0) ? aiSuggested : fallbackBudget;
  const isAI = isAiFresh && aiSuggested > 0;

  const acosTrend = aiBreakdown?.acos_trend;
  const TrendIcon = acosTrend === 'improving' ? TrendingDown : acosTrend === 'worsening' ? TrendingUp : Minus;
  const trendColor = acosTrend === 'improving' ? 'text-emerald-400' : acosTrend === 'worsening' ? 'text-red-400' : 'text-slate-400';

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <DollarSign className="w-4 h-4 text-emerald-400" />
          <h2 className="text-sm font-semibold text-slate-300">Sugestão de Budget Diário</h2>
        </div>
        {isAI && (
          <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400 border border-violet-500/20 font-medium">
            <Sparkles className="w-2.5 h-2.5" /> IA
          </span>
        )}
      </div>

      {loading ? (
        <div className="h-40 flex items-center justify-center"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
      ) : (
        <div className="space-y-4">
          <div className="text-center py-3 bg-surface-2 rounded-lg border border-surface-3">
            <p className="text-xs text-slate-500 mb-1">{isAI ? 'Budget Sugerido pela IA' : 'Budget Sugerido'}</p>
            <p className="text-2xl font-bold text-emerald-400">R${suggestedBudget.toFixed(2)}</p>
            <p className="text-[10px] text-slate-500 mt-1">por dia</p>
            {isAI && aiConfidence > 0 && (
              <p className="text-[10px] text-violet-400 mt-0.5">confiança {aiConfidence}%</p>
            )}
          </div>

          <div className="space-y-2 text-xs">
            {isAI && (aiBreakdown?.avg_spend_30d != null || aiBreakdown?.avg_spend_14d != null) && (
              <div className="flex justify-between py-1.5 border-b border-surface-2">
                <span className="text-slate-500">Média diária (30d)</span>
                <span className="text-white font-semibold">R${(aiBreakdown.avg_spend_30d || aiBreakdown.avg_spend_14d || 0).toFixed(2)}</span>
              </div>
            )}
            {!isAI && (
              <div className="flex justify-between py-1.5 border-b border-surface-2">
                <span className="text-slate-500">Média diária (30d)</span>
                <span className="text-white font-semibold">R${avgDailySpend.toFixed(2)}</span>
              </div>
            )}
            {isAI && acosTrend && (
              <div className="flex justify-between py-1.5 border-b border-surface-2">
                <span className="text-slate-500">Tendência ACoS</span>
                <span className={`font-semibold flex items-center gap-1 ${trendColor}`}>
                  <TrendIcon className="w-3 h-3" />
                  {acosTrend === 'improving' ? 'Melhorando' : acosTrend === 'worsening' ? 'Piorando' : 'Estável'}
                </span>
              </div>
            )}
            <div className="flex justify-between py-1.5 border-b border-surface-2">
              <span className="text-slate-500">Produtos ativos</span>
              <span className="text-white font-semibold">{totalProducts}</span>
            </div>
            <div className="flex justify-between py-1.5">
              <span className="text-slate-500">Campanhas ativas</span>
              <span className="text-emerald-400 font-semibold">{activeCampaigns}</span>
            </div>
          </div>

          {isAI && aiReasoning && (
            <div className="bg-violet-500/5 border border-violet-500/20 rounded-lg p-3 text-[10px] text-violet-300">
              <p className="font-semibold mb-1 text-violet-400">Análise da IA:</p>
              <p className="leading-relaxed">{aiReasoning}</p>
              {aiGeneratedAt && (
                <p className="text-slate-600 mt-1">Atualizado: {new Date(aiGeneratedAt).toLocaleString('pt-BR')}</p>
              )}
            </div>
          )}

          {!isAI && (
            <div className="bg-cyan/5 border border-cyan/20 rounded-lg p-3 text-[10px] text-cyan">
              <p className="font-semibold mb-1">Como calculamos:</p>
              <p>Média real dos últimos 30 dias × 1.25. Ajustado automaticamente todo dia — sobe ou desce conforme o gasto real.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}