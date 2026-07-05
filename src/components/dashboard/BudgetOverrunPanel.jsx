import React, { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, TrendingUp, Flame, Zap } from 'lucide-react';

/**
 * BudgetOverrunPanel
 * Mostra campanhas ativas cujo gasto acumulado nos últimos 7 dias
 * ultrapassou (ou está próximo de ultrapassar) o budget diário configurado.
 *
 * Lógica de classificação:
 *  - "crítico"  → gasto médio/dia >= 95% do daily_budget
 *  - "atenção"  → gasto médio/dia >= 75% do daily_budget
 *  Apenas campanhas ativas (enabled) com daily_budget > 0.
 */
export default function BudgetOverrunPanel({ campaigns = [], metricsDaily = [], loading, sym = 'R$' }) {
  const [expanded, setExpanded] = useState(true);

  // Janela dos últimos 7 dias
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  // Agrupar gasto por campanha nos últimos 7 dias (deduplicado por campaign+date)
  const seen = new Set();
  const spendByCampaign = {};
  const daysByCampaign = {};

  for (const m of metricsDaily) {
    if (!m.date || m.date < sevenDaysAgo) continue;
    const key = `${m.campaign_id}-${m.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!spendByCampaign[m.campaign_id]) {
      spendByCampaign[m.campaign_id] = 0;
      daysByCampaign[m.campaign_id] = new Set();
    }
    spendByCampaign[m.campaign_id] += Number(m.spend || 0);
    daysByCampaign[m.campaign_id].add(m.date);
  }

  // Filtrar apenas campanhas ativas com budget definido
  const activeCampaigns = campaigns.filter(c =>
    (c.state === 'enabled' || c.status === 'enabled') &&
    !c.archived &&
    Number(c.daily_budget || 0) > 0
  );

  const flagged = activeCampaigns
    .map(c => {
      const totalSpend7d = spendByCampaign[c.campaign_id] || spendByCampaign[c.id] || 0;
      const daysWithData = (daysByCampaign[c.campaign_id] || daysByCampaign[c.id] || new Set()).size;
      const avgSpendPerDay = daysWithData > 0 ? totalSpend7d / daysWithData : 0;
      const budget = Number(c.daily_budget || 0);
      const utilizationPct = budget > 0 ? (avgSpendPerDay / budget) * 100 : 0;

      if (utilizationPct < 75) return null;

      return {
        id: c.id,
        name: c.name || c.campaign_name || '—',
        budget,
        avgSpendPerDay,
        totalSpend7d,
        daysWithData,
        utilizationPct,
        severity: utilizationPct > 100 ? 'exceeded' : utilizationPct >= 95 ? 'critical' : 'warning',
        acos: c.acos || 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.utilizationPct - a.utilizationPct);

  const exceededCount = flagged.filter(c => c.severity === 'exceeded').length;
  const criticalCount = flagged.filter(c => c.severity === 'critical').length;
  const warningCount = flagged.filter(c => c.severity === 'warning').length;

  if (!loading && flagged.length === 0) return null;

  return (
    <div className={`rounded-xl border overflow-hidden ${exceededCount > 0 ? 'border-red-600/50 bg-red-600/8' : criticalCount > 0 ? 'border-red-500/30 bg-red-500/5' : 'border-amber-500/30 bg-amber-500/5'}`}>
      {/* Header */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full px-5 py-4 flex items-center justify-between hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${exceededCount > 0 ? 'bg-red-600/25' : criticalCount > 0 ? 'bg-red-500/20' : 'bg-amber-500/20'}`}>
            {exceededCount > 0
              ? <Flame className="w-4 h-4 text-red-500 animate-pulse" />
              : criticalCount > 0
              ? <Flame className="w-4 h-4 text-red-400" />
              : <AlertTriangle className="w-4 h-4 text-amber-400" />}
          </div>
          <div className="text-left">
            <p className={`text-sm font-semibold ${exceededCount > 0 ? 'text-red-400' : criticalCount > 0 ? 'text-red-300' : 'text-amber-300'}`}>
              {exceededCount > 0 ? '🚨 Orçamento Ultrapassado' : 'Orçamento em Risco'}
            </p>
            <p className="text-[11px] text-slate-400 mt-0.5">
              {exceededCount > 0 && <span className="text-red-500 font-semibold">{exceededCount} excedida{exceededCount > 1 ? 's' : ''} · IA ajustará preventivamente</span>}
              {exceededCount > 0 && (criticalCount > 0 || warningCount > 0) && ' · '}
              {exceededCount === 0 && criticalCount > 0 && <span className="text-red-400 font-medium">{criticalCount} crítica{criticalCount > 1 ? 's' : ''}</span>}
              {exceededCount === 0 && criticalCount > 0 && warningCount > 0 && ' · '}
              {warningCount > 0 && <span className="text-amber-400 font-medium">{warningCount} em atenção</span>}
              {' '}— média dos últimos 7 dias
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex gap-1.5">
            {exceededCount > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-600/25 text-red-400 border border-red-600/40 animate-pulse">
                {exceededCount} &gt;100%
              </span>
            )}
            {criticalCount > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-500/20 text-red-400 border border-red-500/30">
                {criticalCount} ≥95%
              </span>
            )}
            {warningCount > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30">
                {warningCount} ≥75%
              </span>
            )}
          </div>
          {expanded ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
        </div>
      </button>

      {/* Lista de campanhas */}
      {expanded && (
        <div className="border-t border-white/5">
          {loading ? (
            <div className="p-6 text-center text-sm text-slate-500">Calculando...</div>
          ) : (
            <div className="divide-y divide-white/5">
              {flagged.map(c => {
                const isExceeded = c.severity === 'exceeded';
                const isCritical = c.severity === 'critical';
                const barWidth = Math.min(120, c.utilizationPct); // permite visualmente ultrapassar 100%
                return (
                  <div key={c.id} className={`px-5 py-3 flex flex-col sm:flex-row sm:items-center gap-3 ${isExceeded ? 'bg-red-600/10 border-l-4 border-red-600' : ''}`}>
                    {/* Nome + badge */}
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${isExceeded ? 'bg-red-500 animate-pulse' : isCritical ? 'bg-red-400' : 'bg-amber-400'}`} />
                      <p className={`text-sm font-medium truncate ${isExceeded ? 'text-red-200' : 'text-white'}`}>{c.name}</p>
                      {isExceeded && (
                        <span className="flex-shrink-0 flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-red-600/25 text-red-400 border border-red-600/40 font-bold">
                          <Flame className="w-2.5 h-2.5" /> EXCEDIDO
                        </span>
                      )}
                      {!isExceeded && isCritical && (
                        <span className="flex-shrink-0 flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/20 font-semibold">
                          <TrendingUp className="w-2.5 h-2.5" /> CRÍTICO
                        </span>
                      )}
                    </div>

                    {/* Barra de utilização */}
                    <div className="flex-1 min-w-0 max-w-xs">
                      <div className="flex justify-between text-[10px] mb-1">
                        <span className="text-slate-400">Uso do orçamento (7d)</span>
                        <span className={`font-bold ${isExceeded ? 'text-red-500' : isCritical ? 'text-red-400' : 'text-amber-400'}`}>
                          {c.utilizationPct.toFixed(0)}%
                          {isExceeded && <span className="ml-1 text-red-500">⚠</span>}
                        </span>
                      </div>
                      <div className="h-1.5 bg-surface-3 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${isExceeded ? 'bg-red-600' : isCritical ? 'bg-red-500' : 'bg-amber-400'}`}
                          style={{ width: `${Math.min(100, barWidth)}%` }}
                        />
                      </div>
                      {isExceeded && (
                        <p className="text-[9px] text-red-400 mt-0.5 flex items-center gap-1">
                          <Zap className="w-2.5 h-2.5" /> IA irá reduzir bids preventivamente no próximo ciclo
                        </p>
                      )}
                    </div>

                    {/* Valores */}
                    <div className="flex gap-4 text-xs flex-shrink-0">
                      <div className="text-right">
                        <p className="text-slate-500">Média/dia</p>
                        <p className={`font-semibold ${isCritical ? 'text-red-300' : 'text-amber-300'}`}>
                          {sym}{c.avgSpendPerDay.toFixed(2)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-slate-500">Budget</p>
                        <p className="text-slate-300 font-semibold">{sym}{c.budget.toFixed(2)}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-slate-500">Total 7d</p>
                        <p className="text-white font-semibold">{sym}{c.totalSpend7d.toFixed(2)}</p>
                      </div>
                      {c.acos > 0 && (
                        <div className="text-right">
                          <p className="text-slate-500">ACoS</p>
                          <p className={`font-semibold ${c.acos > 50 ? 'text-red-400' : c.acos > 30 ? 'text-amber-400' : 'text-emerald-400'}`}>
                            {c.acos.toFixed(1)}%
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}