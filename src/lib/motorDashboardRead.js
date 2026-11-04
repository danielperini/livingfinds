function isUnauthorized(error) {
  return error?.status === 401
    || error?.response?.status === 401
    || error?.data?.status === 401
    || /401|unauthorized|não autorizado/i.test(String(error?.message || ''));
}

async function invokeMotorStatus(client, accountId) {
  try {
    return await client.functions.invoke('getMotorDashboardStatus', { account_id: accountId });
  } catch (error) {
    if (!isUnauthorized(error)) throw error;

    // Revalida a sessão antes de repetir a leitura. O SDK atualiza o token
    // persistido quando a sessão ainda pode ser renovada.
    try {
      await client.auth.me();
    } catch {
      // A segunda tentativa abaixo preserva o erro original se a sessão expirou.
    }
    return await client.functions.invoke('getMotorDashboardStatus', { account_id: accountId });
  }
}

export async function loadMotorDashboardStatus(client, accountId) {
  const response = await invokeMotorStatus(client, accountId);
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
  return count === 0 ? `Nenhuma decisão nova nas últimas 24h. Consulte decisões stale, bloqueios e filtragem na auditoria. Histórico preservado: ${historical} decisões.` : `${count} decisões nas últimas 24h.`;
}
