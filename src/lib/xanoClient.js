// Xano API client for Living Finds API
// Base URL: https://x8ki-letl-twmt.n7.xano.io/api:living-finds-api
// Auth: Bearer token (Xano authToken) stored in localStorage
// Never expose API key or tokens in frontend code

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

  const res = await fetch(`${XANO_BASE}${path}`, {
    ...options,
    headers,
  });

  if (res.status === 401) {
    clearXanoToken();
    throw { code: 'unauthorized', message: 'Sessão expirada. Por favor inicia sessão novamente.', status: 401 };
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  if (!res.ok) {
    throw { code: `xano_${res.status}`, message: data.message || data.error || `Erro ${res.status}`, status: res.status };
  }

  return data;
}

// ─── AUTH ────────────────────────────────────────────────────────────────────

export const xanoAuth = {
  login: (email, password) =>
    xanoFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  signup: (name, email, password) =>
    fetch('https://x8ki-letl-twmt.n7.xano.io/api:4BJNriiP/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password }),
    }).then(r => r.json()),

  me: () => xanoFetch('/auth/me'),

  refresh: () => xanoFetch('/auth/refresh', { method: 'POST' }),
};

// ─── DASHBOARD ───────────────────────────────────────────────────────────────

export const xanoDashboard = {
  getSummary: () => xanoFetch('/amazon/dashboard'),
  getDailyMetrics: () => xanoFetch('/amazon/metrics/daily_summary'),
  getRawMetrics: () => xanoFetch('/amazon/metrics/raw'),
};

// ─── CAMPAIGNS ───────────────────────────────────────────────────────────────

export const xanoCampaigns = {
  list: () => xanoFetch('/campaigns'),
  get: (id) => xanoFetch(`/campaigns/${id}`),
  update: (id, data) => xanoFetch(`/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  archive: (id) => xanoFetch(`/campaigns/${id}`, { method: 'DELETE' }),
  analyze: () => xanoFetch('/amazon/analysis/campaigns'),
  createFromSearchTerm: (data) => xanoFetch('/campaigns/create-from-search-term', { method: 'POST', body: JSON.stringify(data) }),
};

// ─── KEYWORDS ────────────────────────────────────────────────────────────────

export const xanoKeywords = {
  list: () => xanoFetch('/amazon/keywords'),
  analyze: () => xanoFetch('/amazon/keywords/analysis'),
  analyzeDetailed: () => xanoFetch('/amazon/analysis/keywords'),
  getRecommendations: (data) => xanoFetch('/amazon/keywords/recommendations', { method: 'POST', body: JSON.stringify(data) }),
};

// ─── PRODUCTS ────────────────────────────────────────────────────────────────

export const xanoProducts = {
  list: () => xanoFetch('/amazon/products'),
  performance: () => xanoFetch('/amazon/products/performance/list'),
};

// ─── ADS AGENT (Decisions / Memory / Rules) ──────────────────────────────────

export const xanoAdsAgent = {
  getDecisions: () => xanoFetch('/ads-agent/decisions'),
  getMemory: () => xanoFetch('/ads-agent/memory'),
  getRules: () => xanoFetch('/ads-agent/rules'),
};

// ─── AI ──────────────────────────────────────────────────────────────────────

export const xanoAI = {
  analyzeReports: (data) => xanoFetch('/ai/analyze-reports', { method: 'POST', body: JSON.stringify(data) }),
};

// ─── BIDS ────────────────────────────────────────────────────────────────────

export const xanoBids = {
  apply: (data) => xanoFetch('/bids/apply', { method: 'POST', body: JSON.stringify(data) }),
};

// ─── SYNC ────────────────────────────────────────────────────────────────────

export const xanoSync = {
  history30d: (data) => xanoFetch('/amazon/sync/history_30d', { method: 'POST', body: JSON.stringify(data) }),
  monthly: (data) => xanoFetch('/amazon/sync/monthly', { method: 'POST', body: JSON.stringify(data) }),
};

// ─── AMAZON ACCOUNTS ────────────────────────────────────────────────────────

export const xanoAmazonAccounts = {
  get: (id) => xanoFetch(`/amazon-accounts/${id}`),
  update: (id, data) => xanoFetch(`/amazon-accounts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
};

// ─── AMAZON AUTH (OAuth flows) ───────────────────────────────────────────────

export const xanoAmazonAuth = {
  startAds: (data) => xanoFetch('/amazon/auth/ads/start', { method: 'POST', body: JSON.stringify(data) }),
  startSPAPI: (data) => xanoFetch('/amazon/auth/spapi/start', { method: 'POST', body: JSON.stringify(data) }),
  getProfiles: () => xanoFetch('/amazon/ads/profiles'),
};

// ─── LOGS ────────────────────────────────────────────────────────────────────

export const xanoLogs = {
  getSyncLogs: () => xanoFetch('/logs'),
};