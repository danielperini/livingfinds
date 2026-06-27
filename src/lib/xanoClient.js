// Xano API client — único gateway para dados Amazon
// Base URL: https://x8ki-letl-twmt.n7.xano.io/api:living-finds-api
// Auth: Bearer token (authToken) em localStorage

const XANO_BASE = 'https://x8ki-letl-twmt.n7.xano.io/api:living-finds-api';

function getAuthToken() {
  return localStorage.getItem('xano_auth_token');
}

export function setXanoToken(token) {
  localStorage.setItem('xano_auth_token', token);
}

export function clearXanoToken() {
  localStorage.removeItem('xano_auth_token');
}

export function isXanoAuthenticated() {
  return !!getAuthToken();
}

async function xanoFetch(path, options = {}) {
  const token = getAuthToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };

  const res = await fetch(`${XANO_BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    clearXanoToken();
    throw { code: 'unauthorized', message: 'Sessão expirada. Inicia sessão novamente.', status: 401 };
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  if (!res.ok) {
    throw { code: `xano_${res.status}`, message: data.message || data.error || `Erro ${res.status}`, status: res.status };
  }

  return data;
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

export const xanoAuth = {
  login: (email, password) =>
    xanoFetch('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),

  signup: (name, email, password) =>
    fetch('https://x8ki-letl-twmt.n7.xano.io/api:4BJNriiP/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password }),
    }).then(r => r.json()),

  me: () => xanoFetch('/auth/me'),
  refresh: () => xanoFetch('/auth/refresh', { method: 'POST' }),
};

// ─── DASHBOARD ────────────────────────────────────────────────────────────────

export const xanoDashboard = {
  // KPI cards — GET /base44/dashboard_cards
  // Retorna: [{ label, value, unit, change_percent, trend, inverse_trend }]
  getCards: () => xanoFetch('/base44/dashboard_cards'),

  // Métricas diárias — GET /amazon/metrics/daily_summary?start_date=&end_date=
  // Retorna: [{ date, spend, sales, ads_sales, cost, acos, tacos, clicks, impressions }]
  getDailyMetrics: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return xanoFetch(`/amazon/metrics/daily_summary${qs ? '?' + qs : ''}`);
  },

  // Sumário agregado (fallback)
  getSummary: () => xanoFetch('/amazon/dashboard'),
};

// ─── CAMPANHAS ────────────────────────────────────────────────────────────────

export const xanoCampaigns = {
  // Lista campanhas — GET /amazon/campaigns
  list: () => xanoFetch('/amazon/campaigns'),

  get: (id) => xanoFetch(`/campaigns/${id}`),

  // Pausar/ativar campanha — PATCH /campaigns/{id}
  toggleState: (id, state) =>
    xanoFetch(`/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify({ state }) }),

  // Alterar budget — PATCH /campaigns/{id}
  updateBudget: (id, daily_budget) =>
    xanoFetch(`/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify({ daily_budget }) }),

  archive: (id) => xanoFetch(`/campaigns/${id}`, { method: 'DELETE' }),
  analyze: () => xanoFetch('/amazon/analysis/campaigns'),
};

// ─── KEYWORDS ─────────────────────────────────────────────────────────────────

export const xanoKeywords = {
  list: () => xanoFetch('/amazon/keywords'),
  analyze: () => xanoFetch('/amazon/keywords/analysis'),
  getRecommendations: (data) =>
    xanoFetch('/amazon/keywords/recommendations', { method: 'POST', body: JSON.stringify(data) }),
};

// ─── PRODUCTS ─────────────────────────────────────────────────────────────────

export const xanoProducts = {
  list: () => xanoFetch('/amazon/products'),
  performance: () => xanoFetch('/amazon/products/performance/list'),
};

// ─── DECISÕES / AGENTE ────────────────────────────────────────────────────────

export const xanoDecisions = {
  // Lista decisões pendentes — GET /ads-agent/decisions
  list: () => xanoFetch('/ads-agent/decisions'),

  // Aprovar decisão — POST /decisions/approve
  approve: (decision_id) =>
    xanoFetch('/decisions/approve', { method: 'POST', body: JSON.stringify({ decision_id }) }),

  // Rejeitar decisão — POST /decisions/reject
  reject: (decision_id) =>
    xanoFetch('/decisions/reject', { method: 'POST', body: JSON.stringify({ decision_id }) }),
};

export const xanoAdsAgent = {
  getDecisions: () => xanoFetch('/ads-agent/decisions'),
  getMemory: () => xanoFetch('/ads-agent/memory'),
  getRules: () => xanoFetch('/ads-agent/rules'),
};

// ─── BIDS ─────────────────────────────────────────────────────────────────────

export const xanoBids = {
  // Aplicar bids — POST /bids/apply
  // body: { bids: [{ keyword_id, bid }] }
  apply: (data) => xanoFetch('/bids/apply', { method: 'POST', body: JSON.stringify(data) }),
};

// ─── SYNC ─────────────────────────────────────────────────────────────────────

export const xanoSync = {
  // Sincronização completa — POST /sync/full-daily
  fullDaily: (data = {}) =>
    xanoFetch('/sync/full-daily', { method: 'POST', body: JSON.stringify(data) }),

  history30d: (data) =>
    xanoFetch('/amazon/sync/history_30d', { method: 'POST', body: JSON.stringify(data) }),

  monthly: (data) =>
    xanoFetch('/amazon/sync/monthly', { method: 'POST', body: JSON.stringify(data) }),
};

// ─── AMAZON ACCOUNTS ──────────────────────────────────────────────────────────

export const xanoAmazonAccounts = {
  get: (id) => xanoFetch(`/amazon-accounts/${id}`),
  update: (id, data) =>
    xanoFetch(`/amazon-accounts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
};

// ─── AMAZON AUTH (OAuth) ──────────────────────────────────────────────────────

export const xanoAmazonAuth = {
  startAds: (data) =>
    xanoFetch('/amazon/auth/ads/start', { method: 'POST', body: JSON.stringify(data) }),
  startSPAPI: (data) =>
    xanoFetch('/amazon/auth/spapi/start', { method: 'POST', body: JSON.stringify(data) }),
  getProfiles: () => xanoFetch('/amazon/ads/profiles'),
};

// ─── LOGS ─────────────────────────────────────────────────────────────────────

export const xanoLogs = {
  getSyncLogs: () => xanoFetch('/logs'),
};

// ─── DEBUG ────────────────────────────────────────────────────────────────────

export const xanoDebug = {
  testSPAPI: () => xanoFetch('/debug/spapi-test'),
};