/**
 * BudgetBelowMinimumPanel
 * Detecta campanhas com daily_budget < R$15 (mínimo Amazon)
 * e oferece correção bulk com 1 clique.
 */
import { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { AlertTriangle, ChevronDown, ChevronUp, Loader2, CheckCircle } from 'lucide-react';

const AMAZON_MIN = 15;

export default function BudgetBelowMinimumPanel({ campaigns, account, onFixed }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const belowMin = campaigns.filter(c => {
    const s = (c.state || c.status || '').toLowerCase();
    return s === 'enabled' && Number(c.daily_budget || 0) < AMAZON_MIN;
  });

  if (belowMin.length === 0) return null;

  const fix = async () => {
    if (!account || loading) return;
    if (!window.confirm(`Elevar ${belowMin.length} campanha(s) para R$15/dia na Amazon? Esta ação não pode ser desfeita.`)) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await base44.functions.invoke('redistributeCampaignBudgets', {
        mode: 'fix_below_minimum',
        amazon_account_id: account.id,
        dry_run: false,
      });
      const d = res?.data ?? res;
      if (d?.ok) {
        setResult({ type: 'success', text: `${d.adjusted ?? belowMin.length} campanha(s) corrigidas para R$15` });
        onFixed?.();
      } else {
        setResult({ type: 'error', text: d?.error || 'Erro ao corrigir' });
      }
    } catch (e) {
      setResult({ type: 'error', text: e.message });
    } finally {
      setLoading(false);
      setTimeout(() => setResult(null), 10000);
    }
  };

  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/8 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <AlertTriangle className="w-3 h-3 text-amber-400 flex-shrink-0" />
        <span className="text-[10px] font-semibold text-amber-300 flex-1">
          {belowMin.length} campanha(s) abaixo do mínimo Amazon (R$15)
        </span>
        {expanded ? <ChevronUp className="w-3 h-3 text-amber-400" /> : <ChevronDown className="w-3 h-3 text-amber-400" />}
      </button>

      {expanded && (
        <div className="px-2.5 pb-2 space-y-1.5">
          {/* Campaign list */}
          <div className="max-h-32 overflow-y-auto space-y-1 scrollbar-thin">
            {belowMin.map(c => (
              <div key={c.id} className="flex items-center justify-between text-[10px]">
                <span className="text-slate-300 truncate flex-1 mr-2">{c.name || c.campaign_name}</span>
                <span className="text-amber-400 font-mono font-bold flex-shrink-0">
                  R${Number(c.daily_budget || 0).toFixed(0)} → R$15
                </span>
              </div>
            ))}
          </div>

          {/* Fix button */}
          <button
            onClick={fix}
            disabled={loading}
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] font-semibold bg-amber-500/20 border border-amber-500/40 text-amber-300 hover:bg-amber-500/30 rounded transition-colors disabled:opacity-50"
          >
            {loading
              ? <><Loader2 className="w-3 h-3 animate-spin" /> Corrigindo...</>
              : <><CheckCircle className="w-3 h-3" /> Elevar todas para R$15</>}
          </button>

          {result && (
            <p className={`text-[10px] text-center font-medium ${result.type === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>
              {result.text}
            </p>
          )}
        </div>
      )}
    </div>
  );
}