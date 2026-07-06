import React from 'react';
import { DollarSign, Loader2, Sparkles, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { classifyCampaigns } from '@/lib/campaignUtils';

const DAY_MS = 86400000;

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function productIsActive(product) {
  const status = String(product?.status || product?.inventory_status || '').toLowerCase();
  if (['inactive', 'archived', 'deleted', 'out_of_stock'].includes(status)) return false;
  if (product?.is_active === false) return false;
  return true;
}

function metricTimestamp(metric) {
  const candidates = [metric?.updated_at, metric?.synced_at, metric?.created_date, metric?.date];
  for (const candidate of candidates) {
    const timestamp = new Date(candidate || 0).getTime();
    if (Number.isFinite(timestamp) && timestamp > 0) return timestamp;
  }
  return 0;
}

export default function BudgetSuggestionCard({ metricsDaily = [], campaigns = [], products = [], loading, autopilotConfig }) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS).toISOString().slice(0, 10);
  const metricsThirtyDays = metricsDaily.filter((metric) => metric?.date && metric.date >= thirtyDaysAgo);

  // Deduplica por campaign_id + date para evitar contar o mesmo gasto em múltiplos
  // relatórios (searchTerms, products e campaigns cobrem as mesmas campanhas).
  // Prioriza o report_type "campaigns" que tem o valor mais preciso; se não existir,
  // usa o primeiro registro encontrado para aquele par campanha+dia.
  const seenCampDay = new Map();
  for (const metric of metricsThirtyDays) {
    if (!metric.campaign_id || !metric.date) continue;
    const key = `${metric.campaign_id}|${metric.date}`;
    const existing = seenCampDay.get(key);
    if (!existing || metric.report_type === 'campaigns') {
      seenCampDay.set(key, metric);
    }
  }
  const spendByDay = {};
  for (const metric of seenCampDay.values()) {
    const date = metric.date;
    if (!spendByDay[date]) spendByDay[date] = 0;
    spendByDay[date] += number(metric.spend);
  }

  const dailyEntries = Object.entries(spendByDay).sort(([dateA], [dateB]) => dateA.localeCompare(dateB));
  const daysWithData = dailyEntries.length;
  const totalSpend = dailyEntries.reduce((sum, [, spend]) => sum + spend, 0);
  const avgDailySpend = daysWithData > 0 ? totalSpend / daysWithData : 0;
  const latestMetricTimestamp = metricsThirtyDays.reduce((latest, metric) => Math.max(latest, metricTimestamp(metric)), 0);
  const latestMetricDate = dailyEntries.length ? dailyEntries[dailyEntries.length - 1][0] : null;

  // Usa a mesma classificação consolidada do Dashboard para não divergir a contagem.
  const campaignSummary = classifyCampaigns(campaigns);
  const activeCampaignList = campaignSummary.active;
  const activeCampaigns = campaignSummary.active_count;
  const activeCampaignBudget = activeCampaignList.reduce((sum, campaign) => sum + number(campaign.daily_budget || campaign.budget), 0); // exibição apenas
  const activeProducts = products.filter(productIsActive).length;

  // Regra: média diária real deduplificada + reserva operacional de 10%.
  // NÃO usar soma de daily_budget das campanhas como mínimo — esse valor é configurado
  // e pode divergir muito do gasto real, inflando artificialmente a sugestão.
  const reserveRate = 0.10;
  const recalculatedBudget = avgDailySpend > 0 ? avgDailySpend * (1 + reserveRate) : 0;

  const aiSuggested = number(autopilotConfig?.ai_suggested_daily_budget);
  const aiReasoning = autopilotConfig?.ai_budget_reasoning || '';
  const aiConfidence = number(autopilotConfig?.ai_budget_confidence);
  const aiGeneratedAt = autopilotConfig?.ai_budget_generated_at || null;
  const aiGeneratedTimestamp = aiGeneratedAt ? new Date(aiGeneratedAt).getTime() : 0;
  const aiBreakdown = (() => {
    try { return JSON.parse(autopilotConfig?.ai_budget_breakdown || '{}'); }
    catch { return {}; }
  })();

  // Análise semanal: sugestão é válida por 7 dias a partir da geração
  const isAiFresh = aiGeneratedTimestamp > 0 && Date.now() - aiGeneratedTimestamp < 7 * 24 * 3600000;
  const usePersistedAI = aiSuggested > 0 && isAiFresh;

  // Limitador obrigatório: R$50–R$65. Corrige valores históricos fora da faixa (ex: R$466,88)
  const BUDGET_MIN = 50;
  const BUDGET_MAX = 65;
  const rawBudget = usePersistedAI ? aiSuggested : recalculatedBudget;
  const suggestedBudget = rawBudget > 0
    ? Math.min(BUDGET_MAX, Math.max(BUDGET_MIN, rawBudget))
    : rawBudget;
  const confidence = usePersistedAI
    ? aiConfidence
    : Math.min(95, Math.max(55, Math.round((daysWithData / 30) * 100)));

  const previousDaySpend = dailyEntries.length > 1 ? number(dailyEntries[dailyEntries.length - 2][1]) : 0;
  const latestDaySpend = dailyEntries.length ? number(dailyEntries[dailyEntries.length - 1][1]) : 0;
  const trend = latestDaySpend > previousDaySpend ? 'growth' : latestDaySpend < previousDaySpend ? 'decline' : 'stable';

  const acosTrend = usePersistedAI ? aiBreakdown?.acos_trend : null;
  const TrendIcon = acosTrend === 'improving' ? TrendingDown : acosTrend === 'worsening' ? TrendingUp : Minus;
  const trendColor = acosTrend === 'improving' ? 'text-emerald-400' : acosTrend === 'worsening' ? 'text-red-400' : 'text-slate-400';

  const currentReasoning = daysWithData > 0
    ? `Média real de ${daysWithData} dia(s): R$${avgDailySpend.toFixed(2)}/dia. ${activeCampaigns} campanhas ativas. Faixa permitida: R$${BUDGET_MIN}–R$${BUDGET_MAX}.`
    : `Sem dados de gasto ainda. ${activeCampaigns} campanhas ativas. Faixa permitida: R$${BUDGET_MIN}–R$${BUDGET_MAX}.`;

  const updatedAt = usePersistedAI ? aiGeneratedAt : latestMetricTimestamp || null;

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <DollarSign className="w-4 h-4 text-emerald-400" />
          <h2 className="text-sm font-semibold text-slate-300">Sugestão de Budget Diário</h2>
        </div>
        <span className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400 border border-violet-500/20 font-medium">
          <Sparkles className="w-2.5 h-2.5" /> IA
        </span>
      </div>

      {loading ? (
        <div className="h-40 flex items-center justify-center"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
      ) : (
        <div className="space-y-4">
          <div className="text-center py-3 bg-surface-2 rounded-lg border border-surface-3">
            <p className="text-xs text-slate-500 mb-1">Budget Sugerido pela IA</p>
            <p className="text-2xl font-bold text-emerald-400">R${suggestedBudget.toFixed(2)}</p>
            <p className="text-[10px] text-slate-500 mt-1">por dia</p>
            <p className="text-[10px] text-violet-400 mt-0.5">confiança {confidence}%</p>
          </div>

          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between py-1.5 border-b border-surface-2">
              <span className="text-slate-500">Budget calculado (antes do limitador)</span>
              <span className="text-slate-300 font-semibold">R${rawBudget > 0 ? rawBudget.toFixed(2) : '—'}</span>
            </div>
            <div className="flex justify-between py-1.5 border-b border-surface-2">
              <span className="text-slate-500">Faixa permitida</span>
              <span className="text-cyan font-semibold">R${BUDGET_MIN},00 – R${BUDGET_MAX},00</span>
            </div>
            <div className="flex justify-between py-1.5 border-b border-surface-2">
              <span className="text-slate-500">Média diária real ({daysWithData}d)</span>
              <span className="text-white font-semibold">R${avgDailySpend.toFixed(2)}</span>
            </div>
            <div className="flex justify-between py-1.5 border-b border-surface-2">
              <span className="text-slate-500">Produtos ativos</span>
              <span className="text-white font-semibold">{activeProducts}</span>
            </div>
            <div className="flex justify-between py-1.5">
              <span className="text-slate-500">Campanhas ativas</span>
              <span className="text-emerald-400 font-semibold">{activeCampaigns}</span>
            </div>
          </div>

          <div className="bg-violet-500/5 border border-violet-500/20 rounded-lg p-3 text-[10px] text-violet-300">
            <p className="font-semibold mb-1 text-violet-400">Análise da IA:</p>
            <p className="leading-relaxed">{usePersistedAI && aiReasoning ? aiReasoning : currentReasoning}</p>
            {updatedAt && (
              <p className="text-slate-600 mt-1">Atualizado pelo relatório: {new Date(updatedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}