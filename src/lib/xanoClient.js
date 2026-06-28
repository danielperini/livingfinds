/**
 * xanoClient — Referência de endpoints Xano
 * O frontend NUNCA chama o Xano diretamente.
 * Todas as chamadas passam por xanoProxy (backend) ou importFromXano.
 *
 * Namespaces:
 *   api:amazon       → https://x8ki-letl-twmt.n7.xano.io/api:amazon  (principal)
 *   api:amazon-oauth → https://x8ki-letl-twmt.n7.xano.io/api:amazon-oauth
 *   api:ads-learning → https://x8ki-letl-twmt.n7.xano.io/api:ads-learning
 *
 * XANO_BASE_URL (secret no Base44) deve apontar para api:amazon.
 */

// Estado de conexão (localStorage)
const STATUS_KEY = 'lf_xano_status';

export function getXanoStatus() {
  try { return JSON.parse(localStorage.getItem(STATUS_KEY) || 'null'); }
  catch { return null; }
}

export function setXanoStatus(status) {
  localStorage.setItem(STATUS_KEY, JSON.stringify(status));
  window.dispatchEvent(new Event('lf_xano_status_change'));
}

export function clearXanoStatus() {
  localStorage.removeItem(STATUS_KEY);
  window.dispatchEvent(new Event('lf_xano_status_change'));
}

export function isXanoAuthenticated() {
  const s = getXanoStatus();
  return !!(s && s.ok);
}

// Compat stubs
export function setXanoToken() {}
export function clearXanoToken() { clearXanoStatus(); }

/**
 * Endpoints do namespace api:amazon (XANO_BASE_URL aponta aqui)
 * Usar via xanoProxy: base44.functions.invoke('xanoProxy', { method, path })
 */
export const XANO_ENDPOINTS = {
  // Validação
  health:              { method: 'GET',  path: '/health' },
  debug:               { method: 'GET',  path: '/debug' },

  // Dashboard
  dashboard:           { method: 'GET',  path: '/dashboard' },

  // Sync
  syncAll:             { method: 'POST', path: '/sync_all' },
  reportsDownload:     { method: 'POST', path: '/reports/download' },

  // IA
  analyzeWithAI:       { method: 'POST', path: '/analyze-with-ai' },
};