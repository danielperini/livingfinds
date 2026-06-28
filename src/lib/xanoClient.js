/**
 * Xano API Client — Base44 → Xano → Amazon
 *
 * Autenticação: X-API-Key header (XANO_API_KEY via backend functions)
 * O frontend NÃO chama o Xano diretamente — usa funções backend do Base44
 * que injectam a chave secreta.
 *
 * Para chamadas diretas do frontend (sem segredo), usar os métodos abaixo
 * que passam pela função backend `xanoProxy`.
 *
 * Base URL configurada via XANO_BASE_URL (env var no Base44).
 */

export const XANO_BASE = import.meta.env.VITE_XANO_BASE_URL
  || 'https://x8ki-letl-twmt.n7.xano.io/api:living-finds-api';

// ─── XANO STATUS (sem auth — para health check público) ────────────────────
export async function checkXanoHealth() {
  try {
    const res = await fetch(`${XANO_BASE}/health`, {
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data, timestamp: new Date().toISOString() };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err.message, timestamp: new Date().toISOString() };
  }
}

// ─── XANO CONNECTION STATE ─────────────────────────────────────────────────
// Persiste o resultado do último health check para mostrar no UI
const XANO_STATUS_KEY = 'lf_xano_status';

export function getXanoStatus() {
  try {
    return JSON.parse(localStorage.getItem(XANO_STATUS_KEY) || 'null');
  } catch { return null; }
}

export function setXanoStatus(status) {
  localStorage.setItem(XANO_STATUS_KEY, JSON.stringify(status));
  window.dispatchEvent(new Event('lf_xano_status_change'));
}

// ─── LEGACY COMPAT (remover referências antigas) ───────────────────────────
// Mantidos temporariamente para não quebrar imports existentes
export function isXanoAuthenticated() {
  const s = getXanoStatus();
  return !!(s && s.ok);
}
export function setXanoToken() {} // no-op
export function clearXanoToken() {
  localStorage.removeItem(XANO_STATUS_KEY);
  window.dispatchEvent(new Event('lf_xano_status_change'));
}

// ─── ENDPOINTS (chamados via backend function xanoProxy) ───────────────────
// O frontend invoca base44.functions.invoke('xanoProxy', { method, path, body })
// e o backend injeta o X-API-Key e XANO_BASE_URL dos secrets.

export const XANO_ENDPOINTS = {
  // Health
  health: { method: 'GET', path: '/health' },

  // Dashboard
  dashboard: { method: 'GET', path: '/amazon/dashboard' },
  dashboardCards: { method: 'GET', path: '/base44/dashboard_cards' },
  dailyMetrics: { method: 'GET', path: '/amazon/metrics/daily_summary' },
  logs: { method: 'GET', path: '/logs' },

  // Campanhas
  campaigns: { method: 'GET', path: '/campaigns' },
  campaignsAnalysis: { method: 'GET', path: '/amazon/analysis/campaigns' },
  updateCampaign: (id) => ({ method: 'PATCH', path: `/campaigns/${id}` }),
  deleteCampaign: (id) => ({ method: 'DELETE', path: `/campaigns/${id}` }),

  // Keywords
  keywords: { method: 'GET', path: '/amazon/keywords' },
  updateKeyword: (id) => ({ method: 'PATCH', path: `/keywords/${id}` }),

  // Produtos
  products: { method: 'GET', path: '/amazon/products' },
  productsPerformance: { method: 'GET', path: '/amazon/products/performance/list' },

  // Decisões
  decisions: { method: 'GET', path: '/ads-agent/decisions' },
  approveDecision: { method: 'POST', path: '/decisions/approve' },
  rejectDecision: { method: 'POST', path: '/decisions/reject' },
  executeDecision: { method: 'POST', path: '/decisions/execute' },

  // Bids
  applyBids: { method: 'POST', path: '/bids/apply' },

  // Sync
  syncAds: { method: 'POST', path: '/sync/ads' },
  syncProducts: { method: 'POST', path: '/sync/products' },
  syncSales: { method: 'POST', path: '/sync/sales' },
  syncAll: { method: 'POST', path: '/amazon/sync_all' },
  syncFullDaily: { method: 'POST', path: '/sync/full-daily' },

  // Recomendações & Learning
  generateRecommendations: { method: 'POST', path: '/recommendations/generate' },
  learningStatus: { method: 'GET', path: '/learning/status' },
  learningStart: { method: 'POST', path: '/learning/start' },
  learningStop: { method: 'POST', path: '/learning/stop' },
  learningEvents: { method: 'GET', path: '/learning/events' },
  agentMemory: { method: 'GET', path: '/ads-agent/memory' },
  agentRules: { method: 'GET', path: '/ads-agent/rules' },

  // Reports
  reportsStatus: { method: 'GET', path: '/reports/status' },
  reportsPipeline: { method: 'POST', path: '/reports/pipeline/run' },

  // Métricas
  metricsCalculate: { method: 'POST', path: '/metrics/calculate' },
};