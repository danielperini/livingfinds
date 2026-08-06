import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const normalize = (value: unknown) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

function getAdsBaseUrl(region?: string) {
  const normalized = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (normalized.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (normalized.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAdsToken(refreshToken: string) {
  const clientId = Deno.env.get('ADS_CLIENT_ID');
  const clientSecret = Deno.env.get('ADS_CLIENT_SECRET');
  if (!clientId || !clientSecret || !refreshToken) throw new Error('Credenciais Amazon Ads incompletas.');

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || 'Falha ao gerar token Amazon Ads.');
  return data.access_token as string;
}

async function createNegativeExact(account: any, token: string, item: any) {
  const profileId = account?.ads_profile_id || account?.profile_id || Deno.env.get('ADS_PROFILE_ID');
  const clientId = Deno.env.get('ADS_CLIENT_ID');
  const url = `${getAdsBaseUrl(account?.region)}/sp/negativeKeywords`;
  const payload = {
    negativeKeywords: [{
      campaignId: String(item.campaign_id),
      adGroupId: String(item.ad_group_id),
      keywordText: item.term,
      matchType: 'NEGATIVE_EXACT',
      state: 'ENABLED',
    }],
  };

  let lastError: any = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': clientId || '',
        'Amazon-Advertising-API-Scope': String(profileId || ''),
        'Content-Type': 'application/vnd.spNegativeKeyword.v3+json',
        Accept: 'application/vnd.spNegativeKeyword.v3+json',
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    let data: any = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    const requestId = response.headers.get('x-amzn-requestid') || null;

    if (response.ok) return { ok: true, already_exists: false, data, request_id: requestId };
    if (response.status === 409) return { ok: true, already_exists: true, data, request_id: requestId };

    lastError = { status: response.status, data, request_id: requestId };
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after') || 0);
      await sleep(Math.max(retryAfter * 1000, attempt * 1500));
      continue;
    }
    if ([500, 502, 503, 504, 524].includes(response.status)) {
      await sleep(attempt * 2000);
      continue;
    }
    break;
  }

  const error: any = new Error(`Amazon Ads recusou a negativação (HTTP ${lastError?.status || 500}).`);
  error.amazon_response = lastError?.data;
  error.request_id = lastError?.request_id;
  throw error;
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const user = await base44.auth.me();
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const accountId = body.amazon_account_id;
    const minClicks = Math.max(10, Number(body.min_clicks || 10));
    const minSpend = Math.max(2, Number(body.min_spend || 2));
    const maxPerRun = Math.min(100, Math.max(1, Number(body.max_per_run || 30)));
    if (!accountId) return Response.json({ ok: false, error: 'amazon_account_id required' }, { status: 400 });

    const account = await base44.asServiceRole.entities.AmazonAccount.get(accountId).catch(() => null);
    if (!account) return Response.json({ ok: false, error: 'AmazonAccount não encontrada' }, { status: 404 });

    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    if (!refreshToken) return Response.json({ ok: false, error: 'Refresh token Amazon Ads ausente' }, { status: 400 });

    const [terms, campaigns, existingSuggestions, existingActions] = await Promise.all([
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: accountId }, '-clicks', 3000),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, null, 3000),
      base44.asServiceRole.entities.NegativeKeywordSuggestion.filter({ amazon_account_id: accountId }, '-created_date', 3000).catch(() => []),
      base44.asServiceRole.entities.AgentAction.filter({ amazon_account_id: accountId, action: 'negative_keyword' }, '-created_date', 3000).catch(() => []),
    ]);

    const activeCampaignIds = new Set(campaigns
      .filter((campaign: any) => !['archived', 'paused'].includes(String(campaign.state || campaign.status || '').toLowerCase()))
      .map((campaign: any) => String(campaign.campaign_id)));

    const existingKeys = new Set<string>();
    for (const row of existingSuggestions) {
      if (['rejected', 'failed'].includes(String(row.status || '').toLowerCase())) continue;
      existingKeys.add(`${row.campaign_id}|${row.ad_group_id}|${normalize(row.keyword_text)}`);
    }
    for (const row of existingActions) {
      if (['rejected', 'failed'].includes(String(row.status || '').toLowerCase())) continue;
      existingKeys.add(`${row.campaign_id}|${row.ad_group_id}|${normalize(row.keyword)}`);
    }

    const seen = new Set<string>();
    const candidates: any[] = [];
    for (const term of terms) {
      const text = normalize(term.search_term || term.query || term.keyword_text || term.keyword);
      const campaignId = String(term.campaign_id || '');
      const adGroupId = String(term.ad_group_id || '');
      const clicks = Number(term.clicks || 0);
      const spend = Number(term.spend || 0);
      const orders = Number(term.orders_14d ?? term.orders_7d ?? term.orders_30d ?? term.orders ?? 0);
      const sales = Number(term.sales_14d ?? term.sales_7d ?? term.sales_30d ?? term.sales ?? 0);
      if (!text || !campaignId || !adGroupId) continue;
      if (!activeCampaignIds.has(campaignId)) continue;
      if (clicks < minClicks || spend <= minSpend || orders > 0 || sales > 0) continue;

      const key = `${campaignId}|${adGroupId}|${text}`;
      if (seen.has(key) || existingKeys.has(key)) continue;
      seen.add(key);
      candidates.push({
        source_id: term.id,
        campaign_id: campaignId,
        ad_group_id: adGroupId,
        term: text,
        asin: term.advertised_asin || term.asin || null,
        clicks,
        spend,
        orders,
        sales,
      });
      if (candidates.length >= maxPerRun) break;
    }

    if (body.dry_run === true) {
      return Response.json({ ok: true, dry_run: true, candidates: candidates.length, items: candidates });
    }

    const token = await getAdsToken(refreshToken);
    let executed = 0;
    let alreadyExists = 0;
    let failed = 0;
    const results: any[] = [];

    for (const item of candidates) {
      const now = new Date().toISOString();
      const action = await base44.asServiceRole.entities.AgentAction.create({
        amazon_account_id: accountId,
        action: 'negative_keyword',
        asin: item.asin,
        campaign_id: item.campaign_id,
        ad_group_id: item.ad_group_id,
        keyword: item.term,
        reason: `${item.clicks} cliques, R$ ${item.spend.toFixed(2)} gastos e zero pedidos/vendas`,
        evidence: JSON.stringify({ source: 'SearchTerm', source_id: item.source_id, clicks: item.clicks, spend: item.spend, orders: 0, sales: 0, match_type: 'NEGATIVE_EXACT' }),
        risk_level: 'low',
        requires_approval: false,
        status: 'approved',
        reviewed_by: user.id,
        reviewed_at: now,
      });

      try {
        const amazon = await createNegativeExact(account, token, item);
        const status = amazon.already_exists ? 'already_exists' : 'executed';
        if (amazon.already_exists) alreadyExists += 1; else executed += 1;

        await base44.asServiceRole.entities.AgentAction.update(action.id, {
          status: 'executed',
          executed_at: now,
          execution_response: JSON.stringify(amazon.data).slice(0, 2000),
          amazon_request_id: amazon.request_id,
        });

        const suggestionRows = await base44.asServiceRole.entities.NegativeKeywordSuggestion.filter({
          amazon_account_id: accountId,
          campaign_id: item.campaign_id,
          ad_group_id: item.ad_group_id,
          keyword_text: item.term,
        }).catch(() => []);
        if (suggestionRows.length) {
          for (const row of suggestionRows) await base44.asServiceRole.entities.NegativeKeywordSuggestion.update(row.id, { status: 'approved', applied_at: now }).catch(() => {});
        } else {
          await base44.asServiceRole.entities.NegativeKeywordSuggestion.create({
            amazon_account_id: accountId,
            campaign_id: item.campaign_id,
            ad_group_id: item.ad_group_id,
            keyword_text: item.term,
            match_type: 'exact',
            clicks: item.clicks,
            spend: item.spend,
            sales: 0,
            acos: 0,
            reason: `${item.clicks} cliques, R$ ${item.spend.toFixed(2)} gastos e zero pedidos/vendas`,
            status: 'approved',
            applied_at: now,
          });
        }

        await base44.asServiceRole.entities.LearningEvent.create({
          amazon_account_id: accountId,
          event_type: 'negative_keyword_auto_applied',
          entity_type: 'search_term',
          entity_id: item.source_id || action.id,
          observation: JSON.stringify({ ...item, result: status, action_id: action.id }),
          recorded_at: now,
        }).catch(() => {});
        results.push({ ok: true, status, keyword: item.term, campaign_id: item.campaign_id });
      } catch (error) {
        failed += 1;
        await base44.asServiceRole.entities.AgentAction.update(action.id, {
          status: 'failed',
          execution_response: JSON.stringify({ error: error?.message, amazon_response: error?.amazon_response, request_id: error?.request_id }).slice(0, 2000),
        }).catch(() => {});
        results.push({ ok: false, keyword: item.term, campaign_id: item.campaign_id, error: error?.message || 'Falha na negativação' });
      }
    }

    return Response.json({ ok: true, candidates: candidates.length, executed, already_exists: alreadyExists, failed, results });
  } catch (error) {
    console.error('[autoNegateInefficientSearchTerms]', error);
    return Response.json({ ok: false, error: error?.message || 'Erro ao negativar termos ineficientes' }, { status: 500 });
  }
});
