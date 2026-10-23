export async function loadMotorDashboardStatus(client, accountId) {
  const response = await client.functions.invoke('getMotorDashboardStatus', { account_id: accountId });
  const data = response?.data ?? response;
  if (!data?.daily_motor) throw new Error(data?.error || 'Diagnóstico do motor indisponível');
  return data;
}

/** Refresh existing read queries plus the read-only status. Never starts a cycle. */
export async function refreshMotorDashboard({ reloadSources, loadStatus }) {
  return await Promise.all([reloadSources?.(), loadStatus()]);
}

export function recentDecisionMessage({ complete, loading, error }, count, historical) {
  if (error) return `Não foi possível confirmar as decisões recentes: ${error}`;
  if (loading || !complete) return 'Consultando todas as páginas de decisões…';
  return count === 0 ? `Nenhuma decisão nas últimas 24h. Histórico preservado: ${historical} decisões.` : `${count} decisões nas últimas 24h.`;
}
