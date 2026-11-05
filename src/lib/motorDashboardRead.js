import { appParams } from './app-params.js';

async function readHealthFallback() {
  const response = await fetch('/health', { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.daily_motor) return null;
  return { data: { ...data, read_only: true, status_source: 'health_fallback' } };
}

function isUnauthorized(error) {
  return error?.status === 401
    || error?.response?.status === 401
    || error?.data?.status === 401
    || /401|unauthorized|não autorizado/i.test(String(error?.message || ''));
}

async function refreshAccessToken() {
  if (typeof window === 'undefined') return null;
  const refreshToken = window.localStorage.getItem('base44_refresh_token');
  const accessToken = window.localStorage.getItem('base44_access_token');
  if (!refreshToken && !accessToken) return null;
  const response = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(refreshToken
      ? { refresh_token: refreshToken }
      : { refresh_token: accessToken }),
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
    if (token) {
      // Self-hosted builds may not expose VITE_BASE44_APP_ID. The server accepts
      // this stable application route and validates the renewed session token.
      const appId = appParams.appId || 'livingfinds';
      const response = await fetch(`/api/apps/${encodeURIComponent(appId)}/functions/getMotorDashboardStatus`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ account_id: accountId }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok) return { data };
    }

    // Fallback for sessions that can still be revalidated by the SDK.
    try { await client.auth.me(); } catch {}
    try {
      return await client.functions.invoke('getMotorDashboardStatus', { account_id: accountId });
    } catch (retryError) {
      if (!isUnauthorized(retryError)) throw retryError;
      // /health is public, read-only and already exposes the current motor
      // ledger state. Keep the dashboard informative while the session is
      // renewed; never use this path for mutations.
      const health = await readHealthFallback();
      if (health) return health;
      throw retryError;
    }
  }
}

async function invokeReadOnlyFunction(client, functionName, payload) {
  try {
    return await client.functions.invoke(functionName, payload);
  } catch (error) {
    if (!isUnauthorized(error)) throw error;
  }

  const appId = appParams.appId || 'livingfinds';
  const route = `/api/apps/${encodeURIComponent(appId)}/functions/${encodeURIComponent(functionName)}`;
  const direct = async (token) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(route, {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) return { data };
    if (response.status !== 401) throw Object.assign(new Error(data?.error || `Request failed with status code ${response.status}`), { status: response.status, data });
    return null;
  };

  // First preserve a valid same-origin session cookie; this is the normal
  // self-hosted path and does not require exposing a token to the caller.
  const cookieResponse = await direct(null);
  if (cookieResponse) return cookieResponse;

  const token = await refreshAccessToken();
  const tokenResponse = token ? await direct(token) : null;
  if (tokenResponse) return tokenResponse;

  try { await client.auth.me(); } catch {}
  return await client.functions.invoke(functionName, payload);
}

export async function loadMotorCycleEvidence(client, payload) {
  const response = await invokeReadOnlyFunction(client, 'getMotorCycleEvidence', payload);
  const data = response?.data ?? response;
  if (!data?.ok) throw new Error(data?.error || 'Evidência indisponível');
  return data;
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
