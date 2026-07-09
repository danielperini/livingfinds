import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { History, ChevronDown, ChevronRight, User, Clock } from 'lucide-react';

const FIELD_LABELS = {
  target_acos: 'ACoS Alvo',
  max_acos: 'ACoS Máximo',
  target_roas: 'ROAS Alvo',
  target_tacos: 'TACoS Alvo',
  max_tacos: 'TACoS Máximo',
  daily_budget_limit: 'Budget Diário (R$)',
  target_cpc: 'CPC Alvo (R$)',
  max_cpc: 'CPC Máximo (R$)',
  min_bid: 'Bid Mínimo (R$)',
  max_bid: 'Bid Máximo (R$)',
  max_bid_increase_pct: 'Aumento Máx. Bid (%)',
  max_bid_decrease_pct: 'Redução Máx. Bid (%)',
  objective: 'Objetivo Estratégico',
  primary_goal: 'Meta Principal',
  dayparting_enabled: 'Dayparting',
  placement_optimization_enabled: 'Otimização de Placement',
  top_of_search_limit: 'Top of Search Máx. (%)',
  rest_of_search_limit: 'Rest of Search Máx. (%)',
  product_page_limit: 'Product Pages Máx. (%)',
  ai_auto_optimization: 'Otimização Automática IA',
  minimum_campaign_budget: 'Budget Mínimo/Campanha (R$)',
  weekly_campaign_capacity: 'Capacidade Semanal',
};

function fmtVal(v) {
  if (v === true) return 'Ativo';
  if (v === false) return 'Inativo';
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') return String(v);
  return String(v);
}

function fmtDate(d) {
  if (!d) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  }).format(new Date(d));
}

export default function PerformanceSettingsHistoryTable({ accountId }) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedIds, setExpandedIds] = useState(new Set());

  useEffect(() => {
    if (!accountId) return;
    setLoading(true);
    base44.entities.PerformanceSettingsHistory
      .filter({ amazon_account_id: accountId }, '-changed_at', 50)
      .then(rows => setHistory(rows))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [accountId]);

  const toggle = (id) => setExpandedIds(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  if (loading) return (
    <div className="flex items-center gap-2 py-4 text-xs text-slate-500">
      <History className="w-4 h-4 animate-pulse" /> Carregando histórico...
    </div>
  );

  if (history.length === 0) return (
    <div className="py-6 text-center text-xs text-slate-600">
      Nenhuma alteração registrada ainda.
    </div>
  );

  return (
    <div className="space-y-2">
      {history.map((entry) => {
        const id = entry.id;
        const expanded = expandedIds.has(id);
        const changes = entry.changed_fields || [];
        const relevantChanges = changes.filter(c => FIELD_LABELS[c.field]);
        const label = relevantChanges.length > 0
          ? relevantChanges.map(c => FIELD_LABELS[c.field] || c.field).join(', ')
          : 'Configurações atualizadas';

        return (
          <div key={id} className="bg-surface-2 border border-surface-3 rounded-lg overflow-hidden">
            <button
              onClick={() => toggle(id)}
              className="w-full flex items-start gap-3 px-4 py-3 hover:bg-surface-3/40 transition-colors text-left"
            >
              <Clock className="w-4 h-4 text-slate-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-slate-200 truncate">{label}</p>
                <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                  <span className="flex items-center gap-1 text-[10px] text-slate-500">
                    <User className="w-3 h-3" />
                    {entry.changed_by_name || entry.changed_by_email || 'Usuário'}
                  </span>
                  <span className="text-[10px] text-slate-600">{fmtDate(entry.changed_at)}</span>
                  {relevantChanges.length > 0 && (
                    <span className="text-[10px] text-cyan/60">{relevantChanges.length} campo(s) alterado(s)</span>
                  )}
                </div>
              </div>
              <div className="flex-shrink-0 mt-0.5">
                {expanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-500" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-500" />}
              </div>
            </button>

            {expanded && relevantChanges.length > 0 && (
              <div className="border-t border-surface-3 px-4 py-3">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] text-slate-500 uppercase">
                      <th className="text-left pb-2 font-semibold">Campo</th>
                      <th className="text-left pb-2 font-semibold">Antes</th>
                      <th className="text-left pb-2 font-semibold">Depois</th>
                    </tr>
                  </thead>
                  <tbody>
                    {relevantChanges.map((c, i) => (
                      <tr key={i} className="border-t border-surface-3/50">
                        <td className="py-1.5 pr-4 text-slate-400">{FIELD_LABELS[c.field] || c.field}</td>
                        <td className="py-1.5 pr-4 text-red-400 font-mono">{fmtVal(c.old_value)}</td>
                        <td className="py-1.5 text-emerald-400 font-mono font-semibold">{fmtVal(c.new_value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}