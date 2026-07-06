/**
 * BudgetAllocationPanel
 * Painel de orçamento diário centralizado.
 * Exibe: produtos ativos, campanhas ativas, orçamento atual vs sugerido,
 * média por produto/campanha, diferença da referência R$60, motivos.
 */
import React, { useState, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import {
  DollarSign, Target, Package, Megaphone, TrendingUp, TrendingDown,
  Minus, AlertTriangle, CheckCircle, Loader2, RefreshCw, ChevronDown, ChevronUp
} from 'lucide-react';

const REFERENCE = 60.00;

function diff(val) {
  const d = val - REFERENCE;
  if (Math.abs(d) < 1) return null;
  return d;
}

function TrendIcon({ value, target }) {
  if (!value || !target) return <Minus className="w-3 h-3 text-slate-500" />;
  const ratio = value / target;
  if (ratio <= 1.0) return <TrendingDown className="w-3 h-3 text-emerald-400" />;
  return <TrendingUp className="w-3 h-3 text-amber-400" />;
}

export default function BudgetAllocationPanel({ account, campaigns = [], products = [], metricsDaily = [], autopilotConfig }) {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState(null);

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

  // Calcular valores a partir dos dados locais (sem chamar API)
  const activeCampaigns = campaigns.filter(c =>
    (c.state === 'enabled' || c.status === 'enabled') && !c.archived && c.state !== 'archived'
  );
  const activeProducts = products.filter(p =>
    p.status === 'active' && p.inventory_status !== 'out_of_stock'
  );

  const currentTotalBudget = activeCampaigns.reduce((s, c) => s + (c.daily_budget || 0), 0);
  const budgetPerProduct = activeProducts.length > 0 ? REFERENCE / activeProducts.length : 0;
  const budgetPerCampaign = activeCampaigns.length > 0 ? REFERENCE / activeCampaigns.length : 0;
  const budgetDiff = diff(currentTotalBudget);
  const suggestedFromConfig = autopilotConfig?.ai_suggested_daily_budget || 0;

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
          <h3 className="text-sm font-semibold text-slate-300">Orçamento Diário — Referência R${REFERENCE.toFixed(2)}</h3>
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
        <div className="bg-surface-2 rounded-lg p-3">
          <div className="flex items-center gap-1.5 mb-1">
            <Package className="w-3 h-3 text-cyan" />
            <p className="text-[10px] text-slate-400">Produtos ativos</p>
          </div>
          <p className="text-xl font-bold text-white">{activeProducts.length}</p>
          <p className="text-[10px] text-slate-500 mt-0.5">{budgetPerProduct > 0 ? `R$${budgetPerProduct.toFixed(2)}/produto` : '—'}</p>
        </div>

        <div className="bg-surface-2 rounded-lg p-3">
          <div className="flex items-center gap-1.5 mb-1">
            <Megaphone className="w-3 h-3 text-purple-400" />
            <p className="text-[10px] text-slate-400">Campanhas ativas</p>
          </div>
          <p className="text-xl font-bold text-white">{activeCampaigns.length}</p>
          <p className="text-[10px] text-slate-500 mt-0.5">{budgetPerCampaign > 0 ? `R$${budgetPerCampaign.toFixed(2)}/campanha` : '—'}</p>
        </div>

        <div className="bg-surface-2 rounded-lg p-3">
          <div className="flex items-center gap-1.5 mb-1">
            <DollarSign className="w-3 h-3 text-emerald-400" />
            <p className="text-[10px] text-slate-400">Gasto real D-1</p>
          </div>
          <p className="text-xl font-bold text-white">R${spendYesterday.toFixed(2)}</p>
          <p className="text-[10px] text-slate-500 mt-0.5">
            {spendYesterday > 0
              ? `${((spendYesterday / REFERENCE) * 100).toFixed(0)}% da ref. R$${REFERENCE}`
              : 'Aguardando relatório'}
          </p>
        </div>

        <div className="bg-surface-2 rounded-lg p-3">
          <div className="flex items-center gap-1.5 mb-1">
            <TrendingUp className="w-3 h-3 text-amber-400" />
            <p className="text-[10px] text-slate-400">Gasto ontem</p>
          </div>
          <p className="text-xl font-bold text-white">R${spendYesterday.toFixed(2)}</p>
          <p className="text-[10px] text-slate-500 mt-0.5">
            {spendYesterday > 0
              ? `${((spendYesterday / REFERENCE) * 100).toFixed(0)}% da referência`
              : 'Sem dados'}
          </p>
        </div>
      </div>

      {/* Barra de utilização — baseada no gasto real D-1 */}
      <div className="px-5 pb-4">
        <div className="flex justify-between text-[10px] mb-1.5 text-slate-400">
          <span>Gasto real D-1 vs referência (R${REFERENCE.toFixed(2)})</span>
          <span className={`font-semibold ${spendYesterday > 66 ? 'text-amber-400' : spendYesterday > 0 ? 'text-emerald-400' : 'text-slate-500'}`}>
            {spendYesterday > 0 ? `${((spendYesterday / REFERENCE) * 100).toFixed(0)}%` : '—'}
          </span>
        </div>
        <div className="h-2 bg-surface-3 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${spendYesterday > 66 ? 'bg-amber-500' : 'bg-emerald-500'}`}
            style={{ width: `${Math.min(140, (spendYesterday / REFERENCE) * 100)}%` }}
          />
        </div>
        <div className="flex justify-between text-[9px] text-slate-600 mt-1">
          <span>R$54 (-10%)</span>
          <span className="text-slate-500">R$60 referência</span>
          <span>R$66 (+10%)</span>
        </div>
        {currentTotalBudget > 0 && (
          <p className="text-[9px] text-slate-600 mt-1.5">
            Limite configurado Amazon: R${currentTotalBudget.toFixed(2)} (soma dos daily_budget das campanhas)
          </p>
        )}
      </div>

      {/* Resultado da simulação/aplicação */}
      {error && (
        <div className="mx-5 mb-4 bg-red-500/10 border border-red-500/20 rounded-lg p-3 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}

      {result && (
        <div className="border-t border-surface-2">
          {/* Resumo do cálculo */}
          <div className="px-5 py-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-surface-2 rounded-lg p-3">
              <p className="text-[10px] text-slate-400 mb-1">Total alocado</p>
              <p className={`text-lg font-bold ${result.within_tolerance ? 'text-emerald-400' : 'text-amber-400'}`}>
                R${(result.total_allocated || 0).toFixed(2)}
              </p>
              <p className="text-[10px] text-slate-500">
                {result.within_tolerance ? '✓ dentro da tolerância' : '⚠ fora da tolerância'}
              </p>
            </div>
            <div className="bg-surface-2 rounded-lg p-3">
              <p className="text-[10px] text-slate-400 mb-1">Por produto</p>
              <p className="text-lg font-bold text-white">R${(result.budget_per_product || 0).toFixed(2)}</p>
              <p className="text-[10px] text-slate-500">{result.active_products} produtos</p>
            </div>
            <div className="bg-surface-2 rounded-lg p-3">
              <p className="text-[10px] text-slate-400 mb-1">Por campanha</p>
              <p className="text-lg font-bold text-white">R${(result.budget_per_campaign || 0).toFixed(2)}</p>
              <p className="text-[10px] text-slate-500">{result.active_campaigns} campanhas</p>
            </div>
            <div className="bg-surface-2 rounded-lg p-3">
              <p className="text-[10px] text-slate-400 mb-1">Aplicadas</p>
              <p className="text-lg font-bold text-cyan">{result.campaigns_applied || 0}</p>
              <p className="text-[10px] text-slate-500">{result.campaigns_skipped || 0} sem mudança</p>
            </div>
          </div>

          {/* Detalhe por campanha */}
          {result.allocations && result.allocations.length > 0 && (
            <div className="border-t border-surface-2">
              <button
                onClick={() => setExpanded(e => !e)}
                className="w-full px-5 py-3 flex items-center justify-between text-xs text-slate-400 hover:text-slate-200 hover:bg-surface-2 transition-colors"
              >
                <span>Detalhe por campanha ({result.allocations.length})</span>
                {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>

              {expanded && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-surface-2 bg-surface-2/50">
                        <th className="px-4 py-2 text-left text-[10px] text-slate-500 uppercase">Campanha</th>
                        <th className="px-3 py-2 text-left text-[10px] text-slate-500 uppercase">Tipo</th>
                        <th className="px-3 py-2 text-right text-[10px] text-slate-500 uppercase">Atual</th>
                        <th className="px-3 py-2 text-right text-[10px] text-slate-500 uppercase">Sugerido</th>
                        <th className="px-3 py-2 text-right text-[10px] text-slate-500 uppercase">Δ%</th>
                        <th className="px-3 py-2 text-left text-[10px] text-slate-500 uppercase">ACoS</th>
                        <th className="px-3 py-2 text-left text-[10px] text-slate-500 uppercase">Motivo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.allocations.map((a, i) => {
                        const increased = a.suggested_budget > a.current_budget;
                        const decreased = a.suggested_budget < a.current_budget;
                        return (
                          <tr key={i} className="border-b border-surface-2/50 hover:bg-surface-2/40 transition-colors">
                            <td className="px-4 py-2 text-white truncate max-w-[180px]">{a.campaign_name || '—'}</td>
                            <td className="px-3 py-2">
                              <span className="px-1.5 py-0.5 rounded text-[9px] bg-surface-3 text-slate-400 font-medium">
                                {a.campaign_type}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-right text-slate-300">R${(a.current_budget || 0).toFixed(2)}</td>
                            <td className={`px-3 py-2 text-right font-semibold ${increased ? 'text-emerald-400' : decreased ? 'text-amber-400' : 'text-slate-300'}`}>
                              R${(a.suggested_budget || 0).toFixed(2)}
                            </td>
                            <td className={`px-3 py-2 text-right text-[10px] ${increased ? 'text-emerald-400' : decreased ? 'text-amber-400' : 'text-slate-500'}`}>
                              {a.change_pct !== null ? `${a.change_pct > 0 ? '+' : ''}${a.change_pct}%` : '—'}
                            </td>
                            <td className={`px-3 py-2 text-[10px] ${a.acos_30d > 0 && a.acos_30d <= 25 ? 'text-emerald-400' : a.acos_30d > 25 ? 'text-amber-400' : 'text-slate-500'}`}>
                              {a.acos_30d > 0 ? `${a.acos_30d}%` : '—'}
                            </td>
                            <td className="px-3 py-2 text-[10px] text-slate-500 max-w-[150px] truncate" title={a.perf_reason}>
                              {a.perf_reason}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Validação */}
          {result.validation && (
            <div className="px-5 py-3 border-t border-surface-2 flex flex-wrap gap-3">
              {Object.entries(result.validation).filter(([k]) => k !== 'sum_check').map(([k, v]) => (
                <div key={k} className="flex items-center gap-1 text-[10px]">
                  {v
                    ? <CheckCircle className="w-3 h-3 text-emerald-400" />
                    : <AlertTriangle className="w-3 h-3 text-red-400" />}
                  <span className={v ? 'text-emerald-400' : 'text-red-400'}>
                    {k.replace(/_/g, ' ')}
                  </span>
                </div>
              ))}
              <div className="flex items-center gap-1 text-[10px] text-slate-400">
                <span>Soma: R${(result.validation.sum_check || 0).toFixed(2)}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}