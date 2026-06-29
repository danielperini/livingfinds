export default function AutopilotKPIBar({ runs, decisions, alerts, campaigns, config, loading }) {
  const lastRun = runs[0];
  const pending = decisions.filter(d => d.status === 'pending').length;
  const approved = decisions.filter(d => d.status === 'approved').length;
  const executed = decisions.filter(d => d.status === 'executed').length;
  const unreadAlerts = alerts.filter(a => !a.is_read).length;
  const totalSpend = campaigns.reduce((s, c) => s + (c.spend || 0), 0);
  const budgetPct = config?.daily_budget_limit > 0 ? (totalSpend / config.daily_budget_limit * 100) : 0;

  const cards = [
    { label: 'Spend Total (30d)', value: `$${totalSpend.toFixed(2)}`, sub: `${budgetPct.toFixed(0)}% do limite diário`, color: budgetPct > 90 ? 'text-red-400' : 'text-white' },
    { label: 'Limite Diário', value: config?.daily_budget_limit ? `$${config.daily_budget_limit}` : '—', sub: 'máximo configurado', color: 'text-cyan' },
    { label: 'ACoS Alvo', value: config?.acos_target ? `${config.acos_target}%` : '—', sub: `ROAS alvo: ${config?.roas_target || '—'}x`, color: 'text-amber-400' },
    { label: 'Decisões Pendentes', value: pending, sub: `${approved} aprovadas · ${executed} executadas`, color: pending > 0 ? 'text-amber-400' : 'text-emerald-400' },
    { label: 'Alertas Ativos', value: unreadAlerts, sub: `${alerts.length} total`, color: unreadAlerts > 0 ? 'text-red-400' : 'text-slate-400' },
    { label: 'Último Ciclo', value: lastRun ? new Date(lastRun.started_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—', sub: lastRun?.status === 'completed' ? `${lastRun.decisions_generated} decisões` : (lastRun?.status || 'nunca rodou'), color: 'text-slate-300' },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
      {cards.map((c, i) => (
        <div key={i} className={`bg-surface-1 border border-surface-2 rounded-xl p-4 ${loading ? 'animate-pulse' : ''}`}>
          <p className="text-xs text-slate-500 mb-1">{c.label}</p>
          <p className={`text-xl font-bold ${c.color}`}>{c.value}</p>
          <p className="text-xs text-slate-600 mt-0.5">{c.sub}</p>
        </div>
      ))}
    </div>
  );
}