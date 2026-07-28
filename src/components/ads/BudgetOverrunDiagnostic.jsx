import { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { AlertTriangle, RefreshCw, Loader2, CheckCircle, ChevronDown, ChevronUp, Zap, Sparkles, TrendingUp } from 'lucide-react';

const AMAZON_MIN_BUDGET = 15;

/**
 * BudgetOverrunDiagnostic v2
 * 
 * Lógica CORRETA:
 * - A soma dos daily_budgets por campanha PODE e DEVE ser maior que o daily_budget_limit.
 *   O daily_budget_limit é o CAP de GASTO REAL (controlado pelo pacing engine), não a soma.
 * - Alerta real: campanhas com daily_budget < R$15 (mínimo Amazon), que causam "orçamento excedido" intraday.
 * - Informação secundária: gasto confirmado hoje vs cap diário (AccountDailySpendController).
 */
export default function BudgetOverrunDiagnostic({ campaigns, account, onRedistributed }) {
  const [spendController, setSpendController] = useState(null);
  const [fixing, setFixing] = useState(false);
  const [result, setResult] = useState(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!account?.id) return;
    const today = new Date().toISOString().slice(0, 10);
    base44.entities.AccountDailySpendController.filter(
      { amazon_account_id: account.id, spend_date: today }, null, 1
    ).then(rows => setSpendController(rows[0] || null)).catch(() => {});
  }, [account?.id]);

  const enabledCampaigns = campaigns.filter(c => {
    const s = (c.state || c.status || '').toLowerCase();
    return s === 'enabled';
  });

  // Campanhas abaixo do mínimo Amazon
  const belowMinimum = enabledCampaigns.filter(c => Number(c.daily_budget || 0) < AMAZON_MIN_BUDGET);

  // Informação de gasto real do dia
  const confirmedSpend = Number(spendController?.confirmed_spend || 0);
  const dailyCap = Number(spendController?.user_daily_spend_cap || 0);
  const spendPct = dailyCap > 0 ? (confirmedSpend / dailyCap * 100) : 0;
  const capStatus = spendController?.cap_status || null;

  const spendColor = capStatus === 'cap_reached' ? 'text-red-400'
    : capStatus === 'critical' || spendPct >= 85 ? 'text-amber-400'
    : 'text-emerald-400';

  const fixBelowMinimum = async () => {
    if (!account?.id || fixing || belowMinimum.length === 0) return;
    if (!window.confirm(`Elevar daily_budget de ${belowMinimum.length} campanha(s) para R$${AMAZON_MIN_BUDGET} (mínimo Amazon)?\n\nIsso evita o bloqueio intraday por "orçamento excedido".`)) return;
    setFixing(true);
    setResult(null);
    try {
      const res = await base44.functions.invoke('redistributeCampaignBudgets', {
        mode: 'fix_below_minimum',
        dry_run: false,
      });
      const d = res?.data;
      if (d?.ok) {
        setResult({ type: 'success', text: `${d.adjusted} campanha(s) elevada(s) para R$${AMAZON_MIN_BUDGET}` });
        if (onRedistributed) onRedistributed();
      } else {
        setResult({ type: 'error', text: d?.error || 'Erro ao corrigir orçamentos' });
      }
    } catch (e) {
      setResult({ type: 'error', text: e.message });
    } finally {
      setFixing(false);
      setTimeout(() => setResult(null), 12000);
    }
  };

  return (
    <div className="space-y-1.5">
      {/* Alerta de campanhas abaixo do mínimo Amazon */}
      {belowMinimum.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg overflow-hidden">
          <button
            onClick={() => setExpanded(v => !v)}
            className="w-full flex items-center gap-2 px-3 py-2 text-left"
          >
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold text-amber-300">
                {belowMinimum.length} campanha(s) abaixo de R${AMAZON_MIN_BUDGET}
              </p>
              <p className="text-[9px] text-amber-400/70">Mínimo Amazon — causa bloqueio intraday</p>
            </div>
            {expanded
              ? <ChevronUp className="w-3 h-3 text-amber-400 flex-shrink-0" />
              : <ChevronDown className="w-3 h-3 text-amber-400 flex-shrink-0" />
            }
          </button>

          {expanded && (
            <div className="px-3 pb-3 space-y-2 border-t border-amber-500/20">
              <div className="max-h-36 overflow-y-auto scrollbar-thin space-y-1 mt-2">
                {belowMinimum.map(c => {
                  const isAuto = (c.targeting_type || '').toUpperCase() === 'AUTO';
                  const budget = Number(c.daily_budget || 0);
                  return (
                    <div key={c.id} className="flex items-center gap-1.5">
                      {isAuto
                        ? <Zap className="w-2.5 h-2.5 text-amber-400 flex-shrink-0" />
                        : <Sparkles className="w-2.5 h-2.5 text-cyan flex-shrink-0" />
                      }
                      <span className="text-[9px] text-slate-400 truncate flex-1">{c.name || c.campaign_name}</span>
                      <span className="text-[9px] font-mono text-red-400 flex-shrink-0 font-bold">
                        R${budget.toFixed(2)}
                      </span>
                      <span className="text-[9px] text-slate-600 flex-shrink-0">→ R${AMAZON_MIN_BUDGET}</span>
                    </div>
                  );
                })}
              </div>
              <button
                onClick={fixBelowMinimum}
                disabled={fixing}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] font-semibold bg-amber-500/20 border border-amber-500/40 text-amber-300 hover:bg-amber-500/30 rounded-lg transition-colors disabled:opacity-50"
              >
                {fixing
                  ? <><Loader2 className="w-3 h-3 animate-spin" /> Corrigindo...</>
                  : <><TrendingUp className="w-3 h-3" /> Elevar todas para R${AMAZON_MIN_BUDGET}</>
                }
              </button>
            </div>
          )}
        </div>
      )}

      {/* Resultado */}
      {result && (
        <p className={`text-[10px] text-center font-semibold px-2 py-1 rounded ${result.type === 'success' ? 'text-emerald-400 bg-emerald-500/10' : 'text-red-400 bg-red-500/10'}`}>
          {result.text}
        </p>
      )}

      {/* Gasto real do dia vs cap (informação secundária) */}
      {dailyCap > 0 && (
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${
          capStatus === 'cap_reached' ? 'bg-red-500/8 border-red-500/20'
          : capStatus === 'critical' || spendPct >= 85 ? 'bg-amber-500/8 border-amber-500/20'
          : 'bg-emerald-500/8 border-emerald-500/20'
        }`}>
          <span className={`text-[10px] font-medium ${spendColor}`}>
            Gasto hoje: R${confirmedSpend.toFixed(2)} / R${dailyCap.toFixed(0)}
          </span>
          <span className={`text-[9px] font-mono ml-auto ${spendColor}`}>
            {spendPct.toFixed(0)}%
          </span>
        </div>
      )}

      {/* Tudo OK */}
      {belowMinimum.length === 0 && dailyCap === 0 && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-500/8 border border-emerald-500/20 rounded-lg">
          <CheckCircle className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
          <span className="text-[10px] text-emerald-300 font-medium">
            Orçamentos OK · {enabledCampaigns.length} campanhas ativas
          </span>
        </div>
      )}
    </div>
  );
}