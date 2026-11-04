import { appParams } from '@/lib/app-params';

function isUnauthorized(error) {
  return error?.status === 401
    || error?.response?.status === 401
    || error?.data?.status === 401
    || /401|unauthorized|não autorizado/i.test(String(error?.message || ''));
}

async function refreshAccessToken() {
  if (typeof window === 'undefined') return null;
  const refreshToken = window.localStorage.getItem('base44_refresh_token');
  if (!refreshToken) return null;
  const response = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!response.ok) return null;
  const data = await response.json();
  if (!data?.token) return null;
  window.localStorage.setItem('base44_access_token', data.token);
  if (data.refresh_token) window.localStorage.setItem('base44_refresh_token', data.refresh_token);
  return data.token;
}

async function invokeMotorStatus(client, accountId) {
  try {
    return await client.functions.invoke('getMotorDashboardStatus', { account_id: accountId });
  } catch (error) {
    if (!isUnauthorized(error)) throw error;

    const token = await refreshAccessToken();
    if (token && appParams.appId) {
      const response = await fetch(`/api/apps/${encodeURIComponent(appParams.appId)}/functions/getMotorDashboardStatus`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ account_id: accountId }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) return { data };
    }

    // Fallback for sessions that can still be revalidated by the SDK.
    try { await client.auth.me(); } catch {}
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
