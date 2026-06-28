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
// POST /auth/login  { email, password } → { authToken }
// GET  /auth/me
// POST /auth/refresh

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

// ─── HEALTH ───────────────────────────────────────────────────────────────────
// GET /health

export const xanoHealth = {
  check: () => xanoFetch('/health'),
};

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
// GET /base44/dashboard_cards  ?start_date &end_date &account_id
// GET /amazon/dashboard        ?start_date &end_date &account_id
// GET /amazon/metrics/daily_summary  ?start_date &end_date &account_id
// GET /dashboard/summary
// GET /dashboard/campaigns
// GET /dashboard/decisions   ?status &decision_type &asin &campaign_id
// GET /dashboard/keywords
// GET /dashboard/knowledge   ?knowledge_type &entity_type &asin
// GET /dashboard/logs        ?type
// GET /dashboard/products
// GET /dashboard/search-terms

export const xanoDashboard = {
  getCards: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return xanoFetch(`/base44/dashboard_cards${qs ? '?' + qs : ''}`);
  },
  getSummary: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return xanoFetch(`/amazon/dashboard${qs ? '?' + qs : ''}`);
  },
  getDailyMetrics: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return xanoFetch(`/amazon/metrics/daily_summary${qs ? '?' + qs : ''}`);
  },
  getRawMetrics: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return xanoFetch(`/amazon/metrics/raw${qs ? '?' + qs : ''}`);
  },
  getDashboardSummary: () => xanoFetch('/dashboard/summary'),
  getDashboardCampaigns: () => xanoFetch('/dashboard/campaigns'),
  getDashboardKeywords: () => xanoFetch('/dashboard/keywords'),
  getDashboardProducts: () => xanoFetch('/dashboard/products'),
  getDashboardSearchTerms: () => xanoFetch('/dashboard/search-terms'),
  getDashboardLogs: (type) => xanoFetch(`/dashboard/logs${type ? '?type=' + type : ''}`),
  getDashboardDecisions: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return xanoFetch(`/dashboard/decisions${qs ? '?' + qs : ''}`);
  },
  getDashboardKnowledge: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return xanoFetch(`/dashboard/knowledge${qs ? '?' + qs : ''}`);
  },
};

// ─── CAMPANHAS ────────────────────────────────────────────────────────────────
// GET    /campaigns               ?page &per_page &status  (endpoint funcional)
// POST   /campaigns               { profile_id, name, campaign_type, daily_budget, status }
// PATCH  /campaigns/{id}          { state?, daily_budget?, x_api_key }
// DELETE /campaigns/{id}          { profile_id }
// GET    /amazon/analysis/campaigns ?start_date &end_date &user_id &account_id &x_api_key
// POST   /campaigns/create-from-search-term { search_term_id, new_campaign_name, initial_bid }
// NOTE: /amazon/campaigns está com bug no Xano — usar /campaigns

export const xanoCampaigns = {
  list: (params = {}) => {
    // /amazon/campaigns tem bug (account_id não suportado) — usar /campaigns
    const qs = new URLSearchParams(params).toString();
    return xanoFetch(`/campaigns${qs ? '?' + qs : ''}`);
  },
  listAll: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return xanoFetch(`/campaigns${qs ? '?' + qs : ''}`);
  },
  create: (data) => xanoFetch('/campaigns', { method: 'POST', body: JSON.stringify(data) }),
  update: (id, data) =>
    xanoFetch(`/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  archive: (id, profile_id) =>
    xanoFetch(`/campaigns/${id}`, { method: 'DELETE', body: JSON.stringify({ profile_id }) }),
  toggleState: (id, state) =>
    xanoFetch(`/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify({ state }) }),
  updateBudget: (id, daily_budget) =>
    xanoFetch(`/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify({ daily_budget }) }),
  analyze: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return xanoFetch(`/amazon/analysis/campaigns${qs ? '?' + qs : ''}`);
  },
  createFromSearchTerm: (data) =>
    xanoFetch('/campaigns/create-from-search-term', { method: 'POST', body: JSON.stringify(data) }),
};

// ─── KEYWORDS ─────────────────────────────────────────────────────────────────
// GET    /amazon/keywords          ?campaign_id &ad_group_id &state &search &match_type
// GET    /keywords                 ?page &per_page &campaign_id &status
// POST   /keywords                 { profile_id, campaign_id, ad_group_id, keyword_text, match_type, bid, status }
// PATCH  /keywords/{id}            { profile_id, bid, status }
// DELETE /keywords/{id}            { profile_id }
// GET    /amazon/keywords/analysis ?account_id &start_date &end_date
// GET    /amazon/analysis/keywords ?start_date &end_date &account_id
// POST   /amazon/keywords/recommendations { amazon_account_id, amazon_ad_group_id, amazon_campaign_id, max_results }
// POST   /keywords/negative        { search_term_id }

export const xanoKeywords = {
  list: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return xanoFetch(`/amazon/keywords${qs ? '?' + qs : ''}`);
  },
  listAll: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return xanoFetch(`/keywords${qs ? '?' + qs : ''}`);
  },
  create: (data) => xanoFetch('/keywords', { method: 'POST', body: JSON.stringify(data) }),
  update: (id, data) =>
    xanoFetch(`/keywords/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  archive: (id, profile_id) =>
    xanoFetch(`/keywords/${id}`, { method: 'DELETE', body: JSON.stringify({ profile_id }) }),
  analyze: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return xanoFetch(`/amazon/keywords/analysis${qs ? '?' + qs : ''}`);
  },
  analyzeDeep: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return xanoFetch(`/amazon/analysis/keywords${qs ? '?' + qs : ''}`);
  },
  getRecommendations: (data) =>
    xanoFetch('/amazon/keywords/recommendations', { method: 'POST', body: JSON.stringify(data) }),
  negative: (search_term_id) =>
    xanoFetch('/keywords/negative', { method: 'POST', body: JSON.stringify({ search_term_id }) }),
};

// ─── PRODUTOS ─────────────────────────────────────────────────────────────────
// GET /amazon/products               ?search &asin &sku &status
// GET /products                      ?page &per_page &category
// GET /amazon/products/performance/list ?start_date &end_date &account_id

export const xanoProducts = {
  list: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return xanoFetch(`/amazon/products${qs ? '?' + qs : ''}`);
  },
  listAll: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return xanoFetch(`/products${qs ? '?' + qs : ''}`);
  },
  performance: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return xanoFetch(`/amazon/products/performance/list${qs ? '?' + qs : ''}`);
  },
};

// ─── DECISÕES / AGENTE ────────────────────────────────────────────────────────
// GET  /ads-agent/decisions
// GET  /ads-agent/memory
// GET  /ads-agent/rules
// POST /decisions/approve  { decision_id }
// POST /decisions/reject   { decision_id }
// POST /decisions/execute  { decision_id }

export const xanoDecisions = {
  list: () => xanoFetch('/ads-agent/decisions'),
  approve: (decision_id) =>
    xanoFetch('/decisions/approve', { method: 'POST', body: JSON.stringify({ decision_id }) }),
  reject: (decision_id) =>
    xanoFetch('/decisions/reject', { method: 'POST', body: JSON.stringify({ decision_id }) }),
  execute: (decision_id) =>
    xanoFetch('/decisions/execute', { method: 'POST', body: JSON.stringify({ decision_id }) }),
};

export const xanoAdsAgent = {
  getDecisions: () => xanoFetch('/ads-agent/decisions'),
  getMemory: () => xanoFetch('/ads-agent/memory'),
  getRules: () => xanoFetch('/ads-agent/rules'),
};

// ─── BIDS ─────────────────────────────────────────────────────────────────────
// POST /bids/apply  { user_id, x_api_key, updates: [{ keyword_id, bid }] }

export const xanoBids = {
  apply: (data) => xanoFetch('/bids/apply', { method: 'POST', body: JSON.stringify(data) }),
};

// ─── SYNC ─────────────────────────────────────────────────────────────────────
// POST /sync/full-daily        { amazon_account_id, date }
// POST /amazon/sync/history_30d { account_id, x_api_key }
// POST /amazon/sync/monthly    { account_id, year, month }

export const xanoSync = {
  fullDaily: (data = {}) => {
    const today = new Date().toISOString().slice(0, 10);
    return xanoFetch('/sync/full-daily', {
      method: 'POST',
      body: JSON.stringify({ date: today, ...data }),
    });
  },
  history30d: (data) =>
    xanoFetch('/amazon/sync/history_30d', { method: 'POST', body: JSON.stringify(data) }),
  monthly: (data) =>
    xanoFetch('/amazon/sync/monthly', { method: 'POST', body: JSON.stringify(data) }),
};

// ─── RELATÓRIOS ───────────────────────────────────────────────────────────────
// POST /reports/pipeline/run
// POST /reports/request/full   { profile_id, refresh_token, seller_id, marketplace_id, date_start, date_end }
// POST /reports/request/ads-sponsored-products { profile_id, refresh_token, date_start, date_end }
// POST /reports/poll
// POST /reports/download
// POST /reports/process

export const xanoReports = {
  runPipeline: () => xanoFetch('/reports/pipeline/run', { method: 'POST', body: JSON.stringify({}) }),
  requestFull: (data) =>
    xanoFetch('/reports/request/full', { method: 'POST', body: JSON.stringify(data) }),
  requestSponsoredProducts: (data) =>
    xanoFetch('/reports/request/ads-sponsored-products', { method: 'POST', body: JSON.stringify(data) }),
  poll: () => xanoFetch('/reports/poll', { method: 'POST', body: JSON.stringify({}) }),
  download: () => xanoFetch('/reports/download', { method: 'POST', body: JSON.stringify({}) }),
  process: () => xanoFetch('/reports/process', { method: 'POST', body: JSON.stringify({}) }),
};

// ─── MÉTRICAS & IA ────────────────────────────────────────────────────────────
// POST /metrics/calculate    { start_date, end_date }
// POST /metrics/recalculate
// POST /knowledge/analyze    { start_date, end_date }
// POST /recommendations/generate { since_date }
// POST /ai/analyze-reports   { date_start, date_end, asin }
// GET  /learning/events
// GET  /learning/status

export const xanoMetrics = {
  calculate: (data) =>
    xanoFetch('/metrics/calculate', { method: 'POST', body: JSON.stringify(data) }),
  recalculate: () =>
    xanoFetch('/metrics/recalculate', { method: 'POST', body: JSON.stringify({}) }),
};

export const xanoKnowledge = {
  analyze: (data) =>
    xanoFetch('/knowledge/analyze', { method: 'POST', body: JSON.stringify(data) }),
};

export const xanoRecommendations = {
  generate: (since_date) =>
    xanoFetch('/recommendations/generate', { method: 'POST', body: JSON.stringify({ since_date }) }),
};

export const xanoLearning = {
  getEvents: () => xanoFetch('/learning/events'),
  getStatus: () => xanoFetch('/learning/status'),
};

export const xanoAI = {
  analyzeReports: (data) =>
    xanoFetch('/ai/analyze-reports', { method: 'POST', body: JSON.stringify(data) }),
};

// ─── AMAZON ACCOUNTS ──────────────────────────────────────────────────────────
// GET   /amazon-accounts/{id}   ?x_api_key
// PATCH /amazon-accounts/{id}   { max_daily_budget_limit, ai_auto_optimization, status, x_api_key }

export const xanoAmazonAccounts = {
  get: (id) => xanoFetch(`/amazon-accounts/${id}`),
  update: (id, data) =>
    xanoFetch(`/amazon-accounts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
};

// ─── AMAZON AUTH (OAuth) ──────────────────────────────────────────────────────
// POST /amazon/auth/ads/start   { redirect_uri }
// POST /amazon/auth/spapi/start { seller_central_url }
// GET  /amazon/ads/profiles

export const xanoAmazonAuth = {
  startAds: (data) =>
    xanoFetch('/amazon/auth/ads/start', { method: 'POST', body: JSON.stringify(data) }),
  startSPAPI: (data) =>
    xanoFetch('/amazon/auth/spapi/start', { method: 'POST', body: JSON.stringify(data) }),
  getProfiles: () => xanoFetch('/amazon/ads/profiles'),
};

// ─── LOGS ─────────────────────────────────────────────────────────────────────
// GET /logs  ?page &per_page &x_api_key

export const xanoLogs = {
  getSyncLogs: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return xanoFetch(`/logs${qs ? '?' + qs : ''}`);
  },
};

// ─── DEBUG ────────────────────────────────────────────────────────────────────
// GET /debug/spapi-test    ?x_api_key
// GET /debug/amazon-token
// GET /debug-dates

export const xanoDebug = {
  testSPAPI: () => xanoFetch('/debug/spapi-test'),
  testAmazonToken: () => xanoFetch('/debug/amazon-token'),
  checkDates: () => xanoFetch('/debug-dates'),
};