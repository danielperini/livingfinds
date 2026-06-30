import React from 'react';
import { DollarSign, Loader2 } from 'lucide-react';

export default function BudgetSuggestionCard({ metricsDaily, campaigns, products, loading }) {
  // Budget suggestion - baseado em 14 dias
  const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const metricsTwoWeeks = metricsDaily.filter(m => m.date >= twoWeeksAgo);
  const avgDailySpend = metricsTwoWeeks.length > 0 
    ? metricsTwoWeeks.reduce((sum, m) => sum + (m.spend || 0), 0) / metricsTwoWeeks.length 
    : 0;
  const totalProducts = products.length;
  const totalKeywords = campaigns.length > 0 ? campaigns.reduce((sum, c) => sum + 5, 0) : 0; // estimativa
  const suggestedBudget = avgDailySpend > 0 
    ? Math.max(avgDailySpend * 1.2, totalProducts * 2, totalKeywords * 0.5)
    : totalProducts * 2 + totalKeywords * 0.5;

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <DollarSign className="w-4 h-4 text-emerald-400" />
        <h2 className="text-sm font-semibold text-slate-300">Sugestão de Budget Diário</h2>
      </div>
      {loading ? (
        <div className="h-40 flex items-center justify-center"><Loader2 className="w-6 h-6 text-cyan animate-spin" /></div>
      ) : (
        <div className="space-y-4">
          <div className="text-center py-3 bg-surface-2 rounded-lg border border-surface-3">
            <p className="text-xs text-slate-500 mb-1">Budget Sugerido</p>
            <p className="text-2xl font-bold text-emerald-400">${suggestedBudget.toFixed(2)}</p>
            <p className="text-[10px] text-slate-500 mt-1">por dia</p>
          </div>
          
          <div className="space-y-2 text-xs">
            <div className="flex justify-between py-1.5 border-b border-surface-2">
              <span className="text-slate-500">Média diária (14d)</span>
              <span className="text-white font-semibold">${avgDailySpend.toFixed(2)}</span>
            </div>
            <div className="flex justify-between py-1.5 border-b border-surface-2">
              <span className="text-slate-500">Produtos (SKUs)</span>
              <span className="text-white font-semibold">{totalProducts}</span>
            </div>
            <div className="flex justify-between py-1.5 border-b border-surface-2">
              <span className="text-slate-500">Keywords estimadas</span>
              <span className="text-white font-semibold">{totalKeywords}</span>
            </div>
            <div className="flex justify-between py-1.5">
              <span className="text-slate-500">Campanhas ativas</span>
              <span className="text-emerald-400 font-semibold">{campaigns.filter(c => c.state === 'enabled' && !c.archived).length}</span>
            </div>
          </div>

          <div className="bg-cyan/5 border border-cyan/20 rounded-lg p-3 text-[10px] text-cyan">
            <p className="font-semibold mb-1">Como calculamos:</p>
            <p>Média dos últimos 14 dias + margem de 20%, considerando R$2/SKU e R$0,50/keyword.</p>
          </div>
        </div>
      )}
    </div>
  );
}