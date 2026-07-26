import { useState, useEffect, useMemo } from 'react';
import { base44 } from '@/api/base44Client';
import { DollarSign, TrendingUp, TrendingDown, Minus, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';

/**
 * Painel de histórico de alterações de orçamento automáticas.
 * Lê OptimizationDecision com decision_type = 'budget_change' ou 'budget_increase'.
 */
export default function BudgetHistoryPanel({ accountId }) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [showCount, setShowCount] = useState(10);

  useEffect(() => {
    if (!accountId) return;
    setLoading(true);
    base44.entities.OptimizationDecision.filter(
      {
        amazon_account_id: accountId,
        decision_type: { $in: ['budget_change', 'budget_increase', 'IMMEDIATE_BUDGET_RESCUE', 'manual_reactivation_with_budget'] },
      },
      '-created_at',
      100
    )
      .catch(() => [])
      .then((rows) => {
        // Fallback: incluir registros com action contendo 'budget'
        return rows.length > 0
          ? rows
          : base44.entities.OptimizationDecision.filter(
              { amazon_account_id: accountId, entity_type: 'campaign' },
              '-created_at',
              200
            ).catch(() => []).then((all) =>
              all.filter((r) =>
                String(r.action || '').toLowerCase().includes('budget') ||
                String(r.decision_type || '').toLowerCase().includes('budget') ||
                String(r.rule_key || '').toLowerCase().includes('budget') ||
                String(r.rule_key || '').toLowerCase().includes('rescue')
              )
            );
      })
      .then((rows) => setRecords(rows))
      .finally(() => setLoading(false));
  }, [accountId]);

  const stats = useMemo(() => {
    if (!records.length) return null;
    const totalIncreases = records.filter((r) => (r.value_after || 0) > (r.value_before || 0)).length;
    const totalDecreases = records.filter((r) => (r.value_after || 0) < (r.value_before || 0)).length;
    const avgIncrease = records
      .filter((r) => (r.value_after || 0) > (r.value_before || 0))
      .reduce((s, r) => s + ((r.value_after || 0) - (r.value_before || 0)), 0) / (totalIncreases || 1);
    const rescues = records.filter(
      (r) => String(r.rule_key || r.decision_type || '').toLowerCase().includes('rescue') ||
             String(r.rule_key || '').toLowerCase().includes('reactivation')
    ).length;
    return { totalIncreases, totalDecreases, avgIncrease, rescues };
  }, [records]);

  const visible = records.slice(0, showCount);

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' }) +
      ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function dirIcon(before, after) {
    if (!before || !after) return <Minus className="w-3 h-3 text-slate-500" />;
    if (after > before) return <TrendingUp className="w-3 h-3 text-emerald-400" />;
    if (after < before) return <TrendingDown className="w-3 h-3 text-red-400" />;
    return <Minus className="w-3 h-3 text-slate-500" />;
  }

  function pctChange(before, after) {
    if (!before || !after) return null;
    const pct = ((after - before) / before) * 100;
    return pct;
  }

  function ruleLabel(r) {
    const rk = String(r.rule_key || r.decision_type || '').toLowerCase();
    if (rk.includes('rescue') || rk.includes('reactivation')) return 'Resgate de Budget';
    if (rk.includes('increase')) return 'Aumento automático';
    if (rk.includes('decrease') || rk.includes('reduce')) return 'Redução automática';
    if (rk.includes('budget')) return 'Ajuste de orçamento';
    return r.action || r.decision_type || 'Ajuste';
  }

  function ruleColor(r) {
    const rk = String(r.rule_key || r.decision_type || '').toLowerCase();
    if (rk.includes('rescue') || rk.includes('reactivation')) return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
    if (rk.includes('increase')) return 'text-cyan bg-cyan/10 border-cyan/20';
    if (rk.includes('decrease') || rk.includes('reduce')) return 'text-amber-400 bg-amber-500/10 border-amber-500/20';
    return 'text-slate-400 bg-surface-3 border-surface-3';
  }

  if (!accountId) return null;

  return (
    <div className="bg-surface-1 border border-surface-2 rounded-xl overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-surface-2/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <DollarSign className="w-4 h-4 text-cyan" />
          <h2 className="text-sm font-semibold text-slate-300">Histórico de Alterações de Orçamento</h2>
          {loading ? (
            <Loader2 className="w-3.5 h-3.5 text-slate-500 animate-spin ml-1" />
          ) : (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface-2 border border-surface-3 text-slate-500 font-medium">
              {records.length} registros
            </span>
          )}
        </div>
        {expanded ? (
          <ChevronUp className="w-4 h-4 text-slate-500" />
        ) : (
          <ChevronDown className="w-4 h-4 text-slate-500" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-surface-2">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="w-5 h-5 text-cyan animate-spin" />
            </div>
          ) : records.length === 0 ? (
            <p className="text-xs text-slate-600 text-center py-8">
              Nenhuma alteração de orçamento automática encontrada.
            </p>
          ) : (
            <>
              {/* Resumo estatístico */}
              {stats && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-4 border-b border-surface-2 bg-surface-2/30">
                  <div className="text-center">
                    <p className="text-lg font-bold text-emerald-400">{stats.totalIncreases}</p>
                    <p className="text-[10px] text-slate-500">Aumentos</p>
                  </div>
                  <div className="text-center">
                    <p className="text-lg font-bold text-amber-400">{stats.totalDecreases}</p>
                    <p className="text-[10px] text-slate-500">Reduções</p>
                  </div>
                  <div className="text-center">
                    <p className="text-lg font-bold text-cyan">R${stats.avgIncrease.toFixed(2)}</p>
                    <p className="text-[10px] text-slate-500">Aumento médio</p>
                  </div>
                  <div className="text-center">
                    <p className="text-lg font-bold text-violet-400">{stats.rescues}</p>
                    <p className="text-[10px] text-slate-500">Resgates / Reativações</p>
                  </div>
                </div>
              )}

              {/* Tabela */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-[#0D0F14]">
                    <tr className="border-b border-surface-2">
                      {['Data', 'Campanha / ASIN', 'Tipo', 'Orçamento Anterior', 'Novo Orçamento', 'Variação', 'Motivo', 'Status'].map((h) => (
                        <th key={h} className="px-4 py-2.5 text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((r, i) => {
                      const before = r.value_before ?? r.current_value;
                      const after = r.value_after ?? r.proposed_value;
                      const pct = pctChange(before, after);

                      return (
                        <tr key={r.id || i} className="border-b border-surface-2/40 hover:bg-surface-2/30 transition-colors">
                          <td className="px-4 py-2.5 whitespace-nowrap text-slate-400">{fmtDate(r.created_at || r.created_date)}</td>
                          <td className="px-4 py-2.5 max-w-[180px]">
                            <p className="text-slate-300 truncate">{r.campaign_id || r.entity_id || '—'}</p>
                            {r.asin && (
                              <p className="text-[10px] font-mono text-cyan">{r.asin}</p>
                            )}
                          </td>
                          <td className="px-4 py-2.5">
                            <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${ruleColor(r)}`}>
                              {ruleLabel(r)}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-slate-400 font-mono">
                            {before != null ? `R$${Number(before).toFixed(2)}` : '—'}
                          </td>
                          <td className="px-4 py-2.5 font-mono font-bold">
                            <span className={after > before ? 'text-emerald-400' : after < before ? 'text-amber-400' : 'text-slate-300'}>
                              {after != null ? `R$${Number(after).toFixed(2)}` : '—'}
                            </span>
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-1">
                              {dirIcon(before, after)}
                              {pct !== null && (
                                <span className={`text-[10px] font-semibold ${pct > 0 ? 'text-emerald-400' : pct < 0 ? 'text-red-400' : 'text-slate-500'}`}>
                                  {pct > 0 ? '+' : ''}{pct.toFixed(1)}%
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-2.5 max-w-[240px]">
                            <p className="text-[10px] text-slate-400 line-clamp-2 leading-relaxed">{r.rationale || r.reason || r.action || '—'}</p>
                          </td>
                          <td className="px-4 py-2.5">
                            <span className={`inline-block text-[9px] font-bold px-2 py-0.5 rounded-full border ${
                              r.status === 'executed' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                              r.status === 'failed' ? 'bg-red-500/10 text-red-400 border-red-500/20' :
                              r.status === 'approved' ? 'bg-cyan/10 text-cyan border-cyan/20' :
                              'bg-surface-3 text-slate-500 border-surface-3'
                            }`}>
                              {r.status || '—'}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Carregar mais */}
              {showCount < records.length && (
                <div className="p-3 border-t border-surface-2 text-center">
                  <button
                    onClick={() => setShowCount((n) => n + 20)}
                    className="text-[11px] text-cyan hover:underline"
                  >
                    Carregar mais ({records.length - showCount} restantes)
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}