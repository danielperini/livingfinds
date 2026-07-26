import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { PlayCircle, DollarSign, X, Loader2, CheckCircle, AlertCircle } from 'lucide-react';

/**
 * Mini-modal compacto para reativar campanha pausada + ajustar budget em um clique.
 * Chama reactivateWinnerCampaign + adjustCampaignBudgets e aplica atualização otimista.
 */
export default function ReactivateWithBudgetModal({ campaign, account, onClose, onSuccess }) {
  const suggestedBudget = campaign.recommended_daily_budget
    ? Number(campaign.recommended_daily_budget)
    : Math.round(((campaign.daily_budget || 8) * 1.2) * 100) / 100;

  const [budget, setBudget] = useState(suggestedBudget.toFixed(2));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const campaignName = campaign.name || campaign.campaign_name || 'Campanha';
  const prevBudget = campaign.daily_budget || 0;

  const handleConfirm = async () => {
    const newBudget = parseFloat(budget);
    if (!newBudget || newBudget < 1) {
      setError('Budget mínimo: R$1,00');
      return;
    }

    setLoading(true);
    setError(null);

    const amazonCampaignId = campaign.campaign_id || campaign.amazon_campaign_id;

    try {
      // 1. Reativar campanha
      const reactivateRes = await base44.functions.invoke('reactivateWinnerCampaign', {
        amazon_account_id: account.id,
        campaign_id: amazonCampaignId,
        campaign_db_id: campaign.id,
        asin: campaign.asin,
        force_enable: true,
        force: true,
        _service_role: true,
      });

      const reactivateData = reactivateRes?.data ?? reactivateRes;
      if (!reactivateData?.ok) {
        throw new Error(reactivateData?.error || 'Falha ao reativar na Amazon');
      }

      // 2. Ajustar budget
      const budgetRes = await base44.functions.invoke('adjustCampaignBudgets', {
        amazon_account_id: account.id,
        campaign_id: amazonCampaignId,
        new_budget: newBudget,
        force: true,
        _service_role: true,
      });

      const budgetData = budgetRes?.data ?? budgetRes;
      // Budget update may succeed even if response is partial — log but don't block
      const budgetOk = budgetData?.ok !== false;

      // 3. Atualizar entidade Campaign localmente
      await base44.entities.Campaign.update(campaign.id, {
        status: 'enabled',
        state: 'enabled',
        amazon_status: 'enabled',
        daily_budget: newBudget,
        is_operational: true,
      }).catch(() => {});

      // 4. Log em OptimizationDecision
      base44.entities.OptimizationDecision.create({
        amazon_account_id: account.id,
        decision_type: 'budget_change',
        entity_type: 'campaign',
        entity_id: amazonCampaignId,
        campaign_id: amazonCampaignId,
        asin: campaign.asin,
        action: 'manual_reactivation_with_budget',
        value_before: prevBudget,
        value_after: newBudget,
        rationale: `Reativação manual com ajuste de budget: R$${prevBudget.toFixed(2)} → R$${newBudget.toFixed(2)}. Status: pausado → ENABLED. Campanha: ${campaignName}.`,
        risk: 'low',
        status: 'executed',
        source_function: 'ReactivateWithBudgetModal',
        executed_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      }).catch(() => {});

      onSuccess({
        ...campaign,
        status: 'enabled',
        state: 'enabled',
        amazon_status: 'enabled',
        daily_budget: newBudget,
        is_operational: true,
      }, {
        campaignName,
        prevBudget,
        newBudget,
        budgetWarning: !budgetOk ? (budgetData?.error || 'Budget pode não ter sido atualizado na Amazon') : null,
      });

    } catch (e) {
      setError(e.message || 'Erro ao executar ação');
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative bg-[#111827] border border-[#263244] rounded-2xl p-5 w-full max-w-sm shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/15 border border-emerald-500/25 flex items-center justify-center">
              <PlayCircle className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <p className="text-sm font-bold text-white">Reativar + Ajustar Budget</p>
              <p className="text-[10px] text-slate-500">Ação única na Amazon Ads</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-white rounded-lg hover:bg-surface-2 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Campaign name */}
        <div className="mb-4 px-3 py-2 bg-[#172033] border border-[#263244] rounded-xl">
          <p className="text-[10px] text-slate-500 mb-0.5">Campanha</p>
          <p className="text-xs font-medium text-white truncate">{campaignName}</p>
          <div className="flex items-center gap-3 mt-1">
            <span className="text-[10px] text-slate-400">
              Spend: <span className="text-white">R${(campaign.spend || 0).toFixed(2)}</span>
            </span>
            <span className="text-[10px] text-slate-400">
              Vendas: <span className="text-emerald-400">R${(campaign.sales || 0).toFixed(2)}</span>
            </span>
            {(campaign.roas || 0) > 0 && (
              <span className="text-[10px] text-slate-400">
                ROAS: <span className="text-cyan">{(campaign.roas || 0).toFixed(2)}x</span>
              </span>
            )}
          </div>
        </div>

        {/* Status field — fixed ENABLED */}
        <div className="mb-3">
          <p className="text-xs text-slate-400 mb-1.5 font-medium">Novo Status</p>
          <div className="flex items-center gap-2 px-3 py-2 bg-emerald-500/10 border border-emerald-500/25 rounded-xl">
            <CheckCircle className="w-4 h-4 text-emerald-400 flex-shrink-0" />
            <span className="text-sm font-semibold text-emerald-300">ENABLED</span>
            <span className="ml-auto text-[10px] text-emerald-400/60">confirmado</span>
          </div>
        </div>

        {/* Budget field */}
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-xs text-slate-400 font-medium">Novo Budget Diário</p>
            <span className="text-[10px] text-slate-500">
              Atual: R${prevBudget.toFixed(2)}
              {campaign.recommended_daily_budget && (
                <span className="ml-1.5 text-amber-400">· Amazon recomenda R${Number(campaign.recommended_daily_budget).toFixed(2)}</span>
              )}
            </span>
          </div>
          <div className="relative">
            <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
            <input
              type="number"
              step="0.10"
              min="1"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              className="w-full pl-8 pr-4 py-2.5 bg-[#0F172A] border border-[#334155] rounded-xl text-sm text-white font-semibold focus:outline-none focus:border-cyan/50 focus:ring-1 focus:ring-cyan/20"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-slate-500">BRL/dia</span>
          </div>
          {parseFloat(budget) > prevBudget && (
            <p className="text-[10px] text-emerald-400 mt-1">
              +R${(parseFloat(budget) - prevBudget).toFixed(2)} ({Math.round(((parseFloat(budget) / prevBudget) - 1) * 100)}% de aumento)
            </p>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="mb-3 flex items-start gap-2 px-3 py-2 bg-red-500/10 border border-red-500/25 rounded-xl">
            <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-red-300">{error}</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={onClose}
            disabled={loading}
            className="flex-1 py-2.5 text-sm font-semibold bg-[#172033] border border-[#263244] text-slate-300 hover:text-white rounded-xl transition-colors disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading}
            className="flex-1 py-2.5 text-sm font-bold bg-emerald-500/20 border border-emerald-500/35 text-emerald-300 hover:bg-emerald-500/30 rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {loading ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Executando...</>
            ) : (
              <><PlayCircle className="w-4 h-4" /> Confirmar</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}