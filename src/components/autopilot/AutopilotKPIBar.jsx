export default function AutopilotKPIBar({ runs, decisions, alerts, campaigns, config, loading, searchTerms = [] }) {
  const lastRun = runs[0];
  const pending = decisions.filter(d => d.status === 'pending').length;
  const approved = decisions.filter(d => d.status === 'approved').length;
  const executed = decisions.filter(d => d.status === 'executed').length;
  const failed = decisions.filter(d => d.status === 'failed').length;
  const unreadAlerts = alerts.filter(a => !a.is_read).length;
  const totalSpend = campaigns.reduce((s, c) => s + (c.spend || 0), 0);
  const budgetLimit = config?.total_daily_budget || config?.daily_budget_limit || 0;
  const budgetPct = budgetLimit > 0 ? (totalSpend / budgetLimit * 100) : 0;
  const currencySymbol = config?.currency_symbol || 'R$';

  const harvested = decisions.filter(d => d.decision_type === 'harvest_search_term').length;
  const bidIncreases = decisions.filter(d => d.action === 'increase_bid').length;
  const bidDecreases = decisions.filter(d => d.action === 'reduce_bid').length;
  const paused = decisions.filter(d => d.action === 'pause_campaign').length;

  const autonomyLabels = {
    0: 'Observador',
    1: 'Recomendações',
    2: 'Automação Segura',
    3: 'Autopilot Completo',
    4: 'Estratégico',
  };
  const autonomyLevel = config?.autonomy_level ?? 2;

  const cards = [
    {
      label: 'Nível de Autonomia',
      value: autonomyLabels[autonomyLevel] || `Nível ${autonomyLevel}`,
      sub: config?.enabled ? '✓ Autopilot ativo' : '— Autopilot desligado',
      color: config?.enabled ? 'text-emerald-400' : 'text-slate-500',
    },
    {
      label: 'Spend Total',
      value: `${currencySymbol}${totalSpend.toFixed(2)}`,
      sub: budgetLimit > 0 ? `${budgetPct.toFixed(0)}% do limite diário` : 'sem limite configurado',
      color: budgetPct > 90 ? 'text-red-400' : 'text-white',
    },
    {
      label: 'ACoS / ROAS Alvo',
      value: config?.target_acos ? `${config.target_acos}%` : '—',
      sub: `ROAS alvo: ${config?.target_roas || '—'}x`,
      color: 'text-amber-400',
    },
    {
      label: 'Decisões Pendentes',
      value: pending,
      sub: `${approved} aprovadas · ${executed} executadas · ${failed} falhas`,
      color: pending > 0 ? 'text-amber-400' : 'text-emerald-400',
    },
    {
      label: 'Termos Colhidos',
      value: harvested,
      sub: `${bidIncreases} bids ↑ · ${bidDecreases} bids ↓ · ${paused} pausas`,
      color: harvested > 0 ? 'text-cyan' : 'text-slate-400',
    },
    {
      label: 'Último Ciclo',
      value: lastRun
        ? new Date(lastRun.started_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        : '—',
      sub: lastRun?.status === 'completed'
        ? `${lastRun.decisions_generated || 0} decisões geradas`
        : (lastRun?.status === 'running' ? '⚡ Em execução...' : lastRun?.status || 'nunca executou'),
      color: lastRun?.status === 'running' ? 'text-amber-400' : 'text-slate-300',
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
      {cards.map((c, i) => (
        <div key={i} className={`bg-surface-1 border border-surface-2 rounded-xl p-4 ${loading ? 'animate-pulse' : ''}`}>
          <p className="text-xs text-slate-500 mb-1">{c.label}</p>
          <p className={`text-lg font-bold truncate ${c.color}`}>{c.value}</p>
          <p className="text-xs text-slate-600 mt-0.5">{c.sub}</p>
        </div>
      ))}
    </div>
  );
}