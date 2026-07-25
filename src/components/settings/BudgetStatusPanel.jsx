/**
 * BudgetStatusPanel — Painel de status de budget do dia atual
 * Atualiza automaticamente a cada 5 minutos via setInterval.
 * Lê AccountDailySpendController + PerformanceSettings diretamente.
 */
import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { ShieldAlert, ShieldCheck, AlertTriangle, Clock, TrendingUp } from 'lucide-react';

function getBrtDate() {
  return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
}

function fmt(v) {
  return `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;
}

const STATUS_CONFIG = {
  safe:        { label: 'Seguro',       color: 'text-emerald-400', bar: 'bg-emerald-500', border: 'border-emerald-500/20' },
  attention:   { label: 'Atenção',      color: 'text-amber-400',   bar: 'bg-amber-500',   border: 'border-amber-500/20' },
  critical:    { label: 'Crítico',      color: 'text-orange-400',  bar: 'bg-orange-500',  border: 'border-orange-500/20' },
  cap_imminent:{ label: 'Cap Iminente', color: 'text-red-400',     bar: 'bg-red-500',     border: 'border-red-500/20' },
  cap_reached: { label: 'Cap Atingido', color: 'text-red-400',     bar: 'bg-red-600',     border: 'border-red-500/30' },
};

export default function BudgetStatusPanel({ accountId }) {
  const [controller, setController] = useState(null);
  const [cap, setCap] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState(null);

  const load = useCallback(async () => {
    if (!accountId) return;
    try {
      const todayBRT = getBrtDate();
      const [controllers, psList] = await Promise.all([
        base44.entities.AccountDailySpendController.filter(
          { amazon_account_id: accountId, spend_date: todayBRT }, null, 1
        ).catch(() => []),
        base44.entities.PerformanceSettings.filter(
          { amazon_account_id: accountId }, '-updated_at', 1
        ).catch(() => []),
      ]);
      setController(controllers[0] || null);
      setCap(psList[0]?.daily_budget_limit || controllers[0]?.user_daily_spend_cap || 0);
      setLastUpdated(new Date());
    } catch {}
    setLoading(false);
  }, [accountId]);

  useEffect(() => {
    load();
    // Sem polling — dados são atualizados pelo motor backend a cada hora
  }, [load]);

  if (loading) {
    return (
      <div className="bg-surface-1 border border-surface-2 rounded-xl p-4 animate-pulse">
        <div className="h-4 bg-surface-3 rounded w-40 mb-3" />
        <div className="h-2.5 bg-surface-3 rounded w-full mb-2" />
        <div className="h-3 bg-surface-3 rounded w-32" />
      </div>
    );
  }

  const dailyBudget = Number(cap || controller?.user_daily_spend_cap || 0);
  const confirmedSpend = Number(controller?.confirmed_spend || 0);
  const projectedSpend = Number(controller?.projected_total_spend || confirmedSpend);
  const capStatus = controller?.cap_status || 'safe';
  const killSwitchActive = controller?.global_kill_switch === true;
  const lastCheck = controller?.last_kill_switch_check_at;

  const statusCfg = STATUS_CONFIG[capStatus] || STATUS_CONFIG.safe;
  const progressPct = dailyBudget > 0 ? Math.min(100, (confirmedSpend / dailyBudget) * 100) : 0;
  const projectedPct = dailyBudget > 0 ? Math.min(100, (projectedSpend / dailyBudget) * 100) : 0;

  // Cor da barra baseada no percentual confirmado
  let barColor = 'bg-emerald-500';
  if (progressPct >= 90) barColor = 'bg-red-500';
  else if (progressPct >= 70) barColor = 'bg-amber-500';

  return (
    <div className={`bg-surface-1 border rounded-xl p-4 space-y-3 ${killSwitchActive ? 'border-red-500/30' : 'border-surface-2'}`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {killSwitchActive
            ? <ShieldAlert className="w-4 h-4 text-red-400 flex-shrink-0" />
            : progressPct >= 70
            ? <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0" />
            : <ShieldCheck className="w-4 h-4 text-emerald-400 flex-shrink-0" />
          }
          <h3 className="text-sm font-semibold text-white">Status do Orçamento — Hoje</h3>
        </div>
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${statusCfg.color} ${statusCfg.border} bg-transparent`}>
          {statusCfg.label}
        </span>
      </div>

      {/* Kill switch banner */}
      {killSwitchActive && (
        <div className="flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg">
          <ShieldAlert className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
          <p className="text-xs text-red-300 font-medium">Kill Switch ativo — campanhas pausadas automaticamente</p>
        </div>
      )}

      {/* Barra de progresso */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-slate-400">Confirmado: <span className="text-white font-semibold">{fmt(confirmedSpend)}</span></span>
          <span className="text-slate-400">Cap: <span className="text-white font-semibold">{fmt(dailyBudget)}</span></span>
        </div>
        <div className="relative h-2.5 bg-surface-3 rounded-full overflow-hidden">
          {/* Projeção EOD (fundo) */}
          {projectedPct > progressPct && (
            <div
              className="absolute inset-y-0 left-0 rounded-full opacity-30 bg-amber-500 transition-all duration-500"
              style={{ width: `${projectedPct}%` }}
            />
          )}
          {/* Gasto confirmado (frente) */}
          <div
            className={`absolute inset-y-0 left-0 rounded-full transition-all duration-500 ${barColor}`}
            style={{ width: `${progressPct}%` }}
          />
          {/* Linha de threshold 97% */}
          <div
            className="absolute inset-y-0 w-px bg-red-400/60"
            style={{ left: '97%' }}
            title="Threshold de kill switch (97%)"
          />
        </div>
        <div className="flex items-center justify-between text-[10px] text-slate-500">
          <span>{progressPct.toFixed(1)}% utilizado</span>
          <span>Kill switch em 97% ({fmt(dailyBudget * 0.97)})</span>
        </div>
      </div>

      {/* Métricas em linha */}
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-surface-2 rounded-lg p-2.5 text-center">
          <p className="text-[10px] text-slate-500 mb-0.5">Confirmado</p>
          <p className="text-xs font-bold text-white">{fmt(confirmedSpend)}</p>
        </div>
        <div className="bg-surface-2 rounded-lg p-2.5 text-center">
          <p className="text-[10px] text-slate-500 mb-0.5">Projeção EOD</p>
          <p className={`text-xs font-bold ${projectedSpend > dailyBudget * 0.9 ? 'text-amber-400' : 'text-white'}`}>
            {fmt(projectedSpend)}
          </p>
        </div>
        <div className="bg-surface-2 rounded-lg p-2.5 text-center">
          <p className="text-[10px] text-slate-500 mb-0.5">Restante</p>
          <p className={`text-xs font-bold ${Math.max(0, dailyBudget - confirmedSpend) < dailyBudget * 0.15 ? 'text-red-400' : 'text-emerald-400'}`}>
            {fmt(Math.max(0, dailyBudget - confirmedSpend))}
          </p>
        </div>
      </div>

      {/* Rodapé */}
      <div className="flex items-center justify-between text-[10px] text-slate-600">
        <div className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {lastCheck
            ? <span>Último check: {new Date(lastCheck).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
            : <span>Aguardando primeiro check do motor</span>
          }
        </div>
        {lastUpdated && (
          <div className="flex items-center gap-1">
            <TrendingUp className="w-3 h-3" />
            <span>Atualizado às {lastUpdated.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        )}
      </div>
    </div>
  );
}