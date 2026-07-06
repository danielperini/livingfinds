/**
 * BudgetAllocationPanel
 * Painel de orçamento diário centralizado.
 * Exibe: produtos ativos, campanhas ativas, orçamento atual vs sugerido,
 * média por produto/campanha, diferença da referência R$60, motivos.
 */
import React, { useState, useCallback, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import {
  DollarSign, Target, Megaphone, TrendingUp, TrendingDown,
  Minus, AlertTriangle, CheckCircle, Loader2, RefreshCw, ChevronDown, ChevronUp
} from 'lucide-react';

function TrendIcon({ value, target }) {
  if (!value || !target) return <Minus className="w-3 h-3 text-slate-500" />;
  const ratio = value / target;
  if (ratio <= 1.0) return <TrendingDown className="w-3 h-3 text-emerald-400" />;
  return <TrendingUp className="w-3 h-3 text-amber-400" />;
}

export default function BudgetAllocationPanel({ account, campaigns = [], products = [], metricsDaily = [], autopilotConfig }) {
  const [result, setResult]         = useState(null);
  const [loading, setLoading]       = useState(false);
  const [expanded, setExpanded]     = useState(false);
  const [error, setError]           = useState(null);
  const [budgetCfg, setBudgetCfg]   = useState(null);

  // Carregar BudgetConfiguration (fonte oficial)
  useEffect(() => {
    if (!account?.id) return;
    base44.entities.BudgetConfiguration.filter({ amazon_account_id: account.id })
      .then(rows => setBudgetCfg(rows[0] || null))
      .catch(() => {});
  }, [account?.id]);

  const runCalculation = useCallback(async (dryRun = true) => {
    if (!account?.id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await base44.functions.invoke('calculateDailyBudgetAllocation', {
        amazon_account_id: account.id,
        dry_run: dryRun,
        trigger: dryRun ? 'painel_visualizacao' : 'manual_apply',
      });
      setResult(res.data);
    } catch (e) {
      setError(e?.message || 'Erro ao calcular alocação');
    } finally {
      setLoading(false);
    }
  }, [account]);

  // Campanhas elegíveis (excluir arquivadas) — deduplicar por campaign_id
  const activeCampaignsRaw = campaigns.filter(c =>
    (c.state === 'enabled' || c.status === 'enabled') && !c.archived && c.state !== 'archived'
  );
  const seenCampIds = new Set();
  const activeCampaigns = activeCampaignsRaw.filter(c => {
    const key = c.campaign_id || c.id;
    if (seenCampIds.has(key)) return false;
    seenCampIds.add(key);
    return true;
  });
  const activeProducts = products.filter(p =>
    p.status === 'active' && p.inventory_status !== 'out_of_stock'
  );

  // Limite diário oficial = BudgetConfiguration.calculated_daily_budget
  // NÃO é a soma dos budgets individuais das campanhas
  const officialDailyLimit  = budgetCfg?.calculated_daily_budget || 0;
  const budgetFloor         = budgetCfg?.daily_budget_floor  || 50;
  const budgetCeiling       = budgetCfg?.daily_budget_ceiling || 130;
  const currentTotalBudget  = activeCampaigns.reduce((s, c) => s + (c.daily_budget || 0), 0); // só para info

  // Orçamento do dia atual a partir das métricas
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const seen = new Set();
  let spendToday = 0, spendYesterday = 0;
  for (const m of metricsDaily) {
    const k = `${m.campaign_id}-${m.date}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (m.date === today) spendToday += m.spend || 0;
    if (m.date === yesterday) spendYesterday += m.spend || 0;
  }

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-surface-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Target className="w-4 h-4 text-cyan" />
          <h3 className="text-sm font-semibold text-slate-300">
            Orçamento Diário — Limite: {officialDailyLimit > 0 ? `R$${officialDailyLimit.toFixed(2)}` : `R$${budgetFloor}–R$${budgetCeiling}`}
          </h3>
          {officialDailyLimit === 0 && (
            <span className="text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded">Configure o Motor de Orçamento nas Configurações</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => runCalculation(true)}
            disabled={loading || !account?.id}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-2 border border-surface-3 text-slate-300 hover:text-white text-xs rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            Simular
          </button>
          <button
            onClick={() => runCalculation(false)}
            disabled={loading || !account?.id}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan/20 border border-cyan/30 text-cyan hover:bg-cyan/30 text-xs rounded-lg transition-colors disabled:opacity-50"
          >
            <DollarSign className="w-3 h-3" />
            Aplicar
          </button>
        </div>
      </div>

      {/* KPIs principais */}
      <div className="p-5 grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-cyan/5 border border-cyan/20 rounded-lg p-3">
          <div className="flex items-center gap-1.5 mb-1">
            <Target className="w-3 h-3 text-cyan" />
            <p className="text-[10px] text-cyan">Limite Diário Geral</p>
          </div>
          <p className="text-xl font-bold text-white">{officialDailyLimit > 0 ? `R$${officialDailyLimit.toFixed(2)}` : '—'}</p>
          <p className="text-[10px] text-slate-500 mt-0.5">R${budgetFloor}–R${budgetCeiling} faixa</p>
        </div>

        <div className="bg-surface-2 rounded-lg p-3">
          <div className="flex items-center gap-1.5 mb-1">
            <Megaphone className="w-3 h-3 text-purple-400" />
            <p className="text-[10px] text-slate-400">Campanhas elegíveis</p>
          </div>
          <p className="text-xl font-bold text-white">{activeCampaigns.length}</p>
          <p className="text-[10px] text-slate-500 mt-0.5">
            {budgetCfg?.weekly_campaign_capacity ? `de ${budgetCfg.weekly_campaign_capacity} capacidade` : 'budget R$15/cada'}
          </p>
        </div>

        <div className="bg-surface-2 rounded-lg p-3">
          <div className="flex items-center gap-1.5 mb-1">
            <DollarSign className="w-3 h-3 text-emerald-400" />
            <p className="text-[10px] text-slate-400">Gasto real D-1</p>
          </div>
          <p className="text-xl font-bold text-white">R${spendYesterday.toFixed(2)}</p>
          <p className="text-[10px] text-slate-500 mt-0.5">
            {spendYesterday > 0 && officialDailyLimit > 0
              ? `${((spendYesterday / officialDailyLimit) * 100).toFixed(0)}% do limite`
              : 'Aguardando relatório'}
          </p>
        </div>

        <div className="bg-surface-2 rounded-lg p-3">
          <div className="flex items-center gap-1.5 mb-1">
            <TrendingUp className="w-3 h-3 text-amber-400" />
            <p className="text-[10px] text-slate-400">Soma budgets individuais</p>
          </div>
          <p className="text-xl font-bold text-slate-400">R${currentTotalBudget.toFixed(2)}</p>
          <p className="text-[10px] text-slate-500 mt-0.5">≠ limite geral (normal)</p>
        </div>
      </div>

      {/* Barra de utilização — gasto D-1 vs limite oficial */}
      <div className="px-5 pb-4">
        <div className="flex justify-between text-[10px] mb-1.5 text-slate-400">
          <span>Gasto real D-1 vs limite diário ({officialDailyLimit > 0 ? `R$${officialDailyLimit.toFixed(2)}` : 'não calculado'})</span>
          <span className={`font-semibold ${
            officialDailyLimit > 0 && spendYesterday > officialDailyLimit ? 'text-red-400'
            : spendYesterday > 0 ? 'text-emerald-400' : 'text-slate-500'
          }`}>
            {spendYesterday > 0 && officialDailyLimit > 0
              ? `${((spendYesterday / officialDailyLimit) * 100).toFixed(0)}%`
              : '—'}
          </span>
        </div>
        <div className="h-2 bg-surface-3 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              officialDailyLimit > 0 && spendYesterday > officialDailyLimit ? 'bg-red-500'
              : 'bg-emerald-500'
            }`}
            style={{ width: officialDailyLimit > 0 ? `${Math.min(100, (spendYesterday / officialDailyLimit) * 100)}%` : '0%' }}
          />
        </div>
        <div className="flex justify-between text-[9px] text-slate-600 mt-1">
          <span>R${budgetFloor} (mínimo)</span>
          <span className="text-slate-500">{officialDailyLimit > 0 ? `R$${officialDailyLimit.toFixed(2)} limite` : 'Configure o Motor'}</span>
          <span>R${budgetCeiling} (máximo)</span>
        </div>
        <p className="text-[9px] text-slate-600 mt-1.5">
          ⚠ Soma dos budgets individuais (R${currentTotalBudget.toFixed(2)}) pode ser maior que o limite — isso é normal e esperado.
        </p>
      </div>

      {/* Resultado da simulação/aplicação */}
      {error && (
        <div className="mx-5 mb-4 bg-red-500/10 border border-red-500/20 rounded-lg p-3 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}

      {result && (
        <div className="border-t border-surface-2 px-5 py-4">
          <div className={`p-3 rounded-lg text-xs mb-3 ${result.ok ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border border-red-500/20 text-red-400'}`}>
            {result.ok
              ? `✓ Limite calculado: R$${result.daily_limit?.toFixed(2)} • ${result.eligible_campaigns} campanhas • ${result.campaigns_increased || 0} receberam +R$${result.budget_increment}`
              : `✗ ${result.error}`}
          </div>
          {result.ok && result.allocations && result.allocations.length > 0 && (
            <div>
              <button onClick={() => setExpanded(e => !e)}
                className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 mb-2 transition-colors">
                {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                Detalhe por campanha ({result.allocations.length})
              </button>
              {expanded && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-surface-2">
                        {['Campanha', 'Atual', 'Sugerido', 'Ação', 'Spend D-1', 'Pedidos D-1', 'ACoS 30d', 'Motivo'].map(h => (
                          <th key={h} className="px-3 py-2 text-left text-[10px] text-slate-500 uppercase whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.allocations.map((a, i) => (
                        <tr key={i} className="border-b border-surface-2/50 hover:bg-surface-2/40">
                          <td className="px-3 py-1.5 text-white truncate max-w-[180px]">{a.campaign_name || '—'}</td>
                          <td className="px-3 py-1.5 text-slate-300">R${(a.current_budget || 0).toFixed(2)}</td>
                          <td className={`px-3 py-1.5 font-semibold ${a.action === 'aumentar' ? 'text-emerald-400' : 'text-slate-300'}`}>
                            R${(a.suggested_budget || 0).toFixed(2)}
                          </td>
                          <td className="px-3 py-1.5">
                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${a.action === 'aumentar' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-surface-3 text-slate-500'}`}>
                              {a.action}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-slate-300">R${(a.yesterday_spend || 0).toFixed(2)}</td>
                          <td className="px-3 py-1.5 text-slate-300">{a.yesterday_orders || 0}</td>
                          <td className={`px-3 py-1.5 text-[10px] font-semibold ${(a.acos_30d || 0) > 0 && (a.acos_30d || 0) <= 25 ? 'text-emerald-400' : (a.acos_30d || 0) > 0 ? 'text-amber-400' : 'text-slate-500'}`}>
                            {(a.acos_30d || 0) > 0 ? `${a.acos_30d}%` : '—'}
                          </td>
                          <td className="px-3 py-1.5 text-[10px] text-slate-500 max-w-[150px] truncate" title={a.reason}>{a.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}