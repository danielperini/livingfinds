import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { PlayCircle, DollarSign, Loader2, X, CheckCircle, AlertCircle } from 'lucide-react';

/**
 * Mini-modal para reativar uma campanha pausada + ajustar budget em uma ação.
 * Chama reactivateWinnerCampaign + adjustCampaignBudgets sequencialmente.
 * onDone({ state, status, daily_budget }) é chamado ANTES de onClose para garantir
 * que o estado local seja atualizado antes que o botão desapareça.
 */
export default function ReactivateWithBudgetModal({ campaign, account, onClose, onDone }) {
  const suggestedBudget = (campaign.recommended_daily_budget > 0)
    ? parseFloat(Number(campaign.recommended_daily_budget).toFixed(2))
    : parseFloat(((campaign.daily_budget || 8) * 1.2).toFixed(2));

  const [budget, setBudget] = useState(String(suggestedBudget));
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null); // null | { ok, text }

  const handleConfirm = async () => {
    const newBudget = parseFloat(budget);
    if (!newBudget || newBudget < 1) return;
    setLoading(true);
    setResult(null);

    const amazonCampaignId = campaign.campaign_id || campaign.amazon_campaign_id;

    try {
      // 1. Reativar na Amazon
      const res1 = await base44.functions.invoke('reactivateWinnerCampaign', {
        amazon_account_id: account.id,
        campaign_id: amazonCampaignId,
        campaign_db_id: campaign.id,
        asin: campaign.asin,
        force: true,
        _service_role: true,
      });
      if (!res1?.data?.ok) throw new Error(res1?.data?.error || 'Falha ao reativar');

      // 2. Ajustar budget na Amazon
      const res2 = await base44.functions.invoke('adjustCampaignBudgets', {
        amazon_account_id: account.id,
        campaign_id: amazonCampaignId,
        new_budget: newBudget,
        reason: 'manual_reactivation_with_budget_adjustment',
        _service_role: true,
      });
      if (res2?.data?.ok === false) throw new Error(res2?.data?.error || 'Falha ao ajustar budget');

      // 3. Atualizar entidade local
      await base44.entities.Campaign.update(campaign.id, {
        state: 'enabled',
        status: 'enabled',
        amazon_status: 'enabled',
        is_operational: true,
        daily_budget: newBudget,
        budget_last_changed_at: new Date().toISOString(),
        budget_change_reason: 'manual_reactivation_with_budget',
      });

      // 4. Logar decisão (fire-and-forget)
      base44.entities.OptimizationDecision.create({
        amazon_account_id: account.id,
        decision_type: 'budget_change',
        entity_type: 'campaign',
        entity_id: amazonCampaignId,
        campaign_id: amazonCampaignId,
        asin: campaign.asin,
        action: 'manual_reactivation_with_budget',
        value_before: campaign.daily_budget,
        value_after: newBudget,
        rationale: `Reativação manual + ajuste de budget: R$${(campaign.daily_budget || 0).toFixed(2)} → R$${newBudget.toFixed(2)}. ROAS ${(campaign.roas || 0).toFixed(2)}x.`,
        rule_key: 'manual_reactivation_with_budget',
        risk: 'low',
        status: 'executed',
        executed_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      }).catch(() => {});

      setResult({ ok: true, text: `Reativada · Budget R$${newBudget.toFixed(2)}/dia` });

      // Chamar onDone ANTES de fechar para que o estado seja atualizado primeiro
      // (isso faz o botão desaparecer automaticamente pois state passa a 'enabled')
      onDone?.({ state: 'enabled', status: 'enabled', daily_budget: newBudget });
      // Fechar após breve delay para mostrar feedback de sucesso
      setTimeout(() => onClose(), 900);

    } catch (e) {
      setResult({ ok: false, text: e.message || 'Erro desconhecido' });
      setLoading(false);
    }
  };

  const budgetBefore = campaign.daily_budget || 0;
  const budgetAfter = parseFloat(budget) || 0;
  const pctChange = budgetBefore > 0 ? Math.round((budgetAfter / budgetBefore - 1) * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative z-10 w-full max-w-sm mx-4 bg-[#111827] border border-surface-2 rounded-2xl shadow-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <PlayCircle className="w-4 h-4 text-emerald-400" />
              Reativar + Ajustar Budget
            </h3>
            <p className="text-[11px] text-slate-400 mt-0.5 truncate max-w-[260px]">
              {campaign.name || campaign.campaign_name}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-600 hover:text-slate-300 -mt-0.5">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Métricas da campanha */}
        <div className="grid grid-cols-3 gap-2 mb-4">
          {[
            { label: 'Spend', value: `R$${(campaign.spend || 0).toFixed(2)}` },
            { label: 'Vendas', value: `R$${(campaign.sales || 0).toFixed(2)}`, color: 'text-emerald-400' },
            { label: 'ROAS', value: `${(campaign.roas || 0).toFixed(2)}x`, color: 'text-cyan' },
          ].map((m) => (
            <div key={m.label} className="bg-surface-2 rounded-lg px-3 py-2 text-center">
              <p className="text-[10px] text-slate-500">{m.label}</p>
              <p className={`text-xs font-bold ${m.color || 'text-white'}`}>{m.value}</p>
            </div>
          ))}
        </div>

        {/* Status → ENABLED confirmado */}
        <div className="flex items-center gap-2 px-3 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg mb-4">
          <CheckCircle className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
          <span className="text-xs text-emerald-300 font-semibold">Status → ENABLED</span>
        </div>

        {/* Campo de budget */}
        <div className="mb-4">
          <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-300 mb-1.5">
            <DollarSign className="w-3.5 h-3.5 text-cyan" />
            Novo Budget Diário (R$)
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              step="0.10"
              min="1"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              className="flex-1 px-3 py-2 bg-surface-3 border border-surface-3 focus:border-cyan/50 rounded-lg text-sm text-white font-bold focus:outline-none"
            />
            <div className="text-right text-[10px] text-slate-500 whitespace-nowrap">
              <p>Antes: R${budgetBefore.toFixed(2)}</p>
              {budgetAfter !== budgetBefore && budgetAfter > 0 && (
                <p className={pctChange > 0 ? 'text-emerald-400' : 'text-amber-400'}>
                  {pctChange > 0 ? '+' : ''}{pctChange}%
                </p>
              )}
            </div>
          </div>
          {campaign.recommended_daily_budget > 0 && (
            <p className="text-[10px] text-cyan/70 mt-1">
              Recomendado Amazon: R${parseFloat(campaign.recommended_daily_budget).toFixed(2)}
            </p>
          )}
        </div>

        {/* Resultado inline */}
        {result && (
          <div className={`flex items-center gap-2 px-3 py-2 rounded-lg mb-3 text-xs font-semibold ${
            result.ok
              ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300'
              : 'bg-red-500/10 border border-red-500/20 text-red-400'
          }`}>
            {result.ok
              ? <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" />
              : <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />}
            {result.text}
          </div>
        )}

        {/* Botões */}
        <div className="flex gap-2">
          <button
            onClick={onClose}
            disabled={loading}
            className="flex-1 py-2 text-xs font-semibold text-slate-400 bg-surface-2 border border-surface-3 rounded-lg hover:text-white transition-colors disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading || !budget || parseFloat(budget) < 1}
            className="flex-1 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            {loading ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Aplicando...</>
            ) : (
              <><PlayCircle className="w-3.5 h-3.5" /> Confirmar</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}