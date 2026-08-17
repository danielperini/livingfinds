/**
 * runDailyAmazonActionQueue — Processa a fila Amazon Ads e aplica invariantes canônicos.
 *
 * Invariante canônico:
 * - existe no máximo 1 campanha AUTO não arquivada por ASIN;
 * - a vencedora é escolhida por desempenho real de 30 dias;
 * - as demais são arquivadas na Amazon antes da atualização local;
 * - campanhas manuais nunca entram nessa consolidação.
 *
 * Ordem de execução das ações:
 * 1. Criar campanhas → 2. Criar ad groups → 3. Criar anúncios → 4. Criar keywords/targets
 * 5. Criar negativas → 6. Atualizar bids → 7. Atualizar budgets → 8. Pausar/ativar/arquivar
 *
 * Respeita HTTP 429 Retry-After, trata respostas parciais e não confirma estado local
 * antes da confirmação da Amazon.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = new Map();
const MAX_429_RETRIES = 3;
const AUTO_DEDUP_LOOKBACK_DAYS = 30;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function numberValue(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstNumber(record, fields, fallback = 0) {
  for (const field of fields) {
    if (record?.[field] !== undefined && record?.[field] !== null && record?.[field] !== '') {
      const value = Number(record[field]);
      if (Number.isFinite(value)) return value;
    }
  }
  return fallback;
}

function campaignIdOf(record) {
  return String(record?.campaign_id || record?.amazon_campaign_id || record?.campaignId || '');
}

function normalizedState(record) {
  return String(record?.state || record?.status || '').toLowerCase();
}

function isAutomaticCampaign(record) {
  const targetingType = String(record?.targeting_type || record?.targetingType || '').toUpperCase();
  return targetingType === 'AUTO';
}

function isNonArchivedCampaign(record) {
  return normalizedState(record) !== 'archived';
}

function normalizeSearchTerm(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function getAdsToken(refreshToken) {
  if (!refreshToken) throw new Error('ADS_REFRESH_TOKEN ausente para a conta');

  const cacheKey = String(refreshToken);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expires_at > Date.now()) return cached.access_token;

  const clientId = Deno.env.get('ADS_CLIENT_ID');
  const clientSecret = Deno.env.get('ADS_CLIENT_SECRET');
  if (!clientId || !clientSecret) throw new Error('ADS_CLIENT_ID ou ADS_CLIENT_SECRET ausente');

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(
      new Error(data.error_description || data.error || `Token failed (${res.status})`),
      { status: res.status },
    );
  }

  tokenCache.set(cacheKey, {
    access_token: data.access_token,
    expires_at: Date.now() + Math.max(60, numberValue(data.expires_in, 3600) - 60) * 1000,
  });
  return data.access_token;
}

function getAdsBaseUrl(region) {
  const r = String(region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

function amazonErrorMessage(status, data) {
  const firstError = data?.campaigns?.error?.[0]
    || data?.keywords?.error?.[0]
    || data?.negativeKeywords?.error?.[0]
    || data?.error?.[0]
    || data?.error;

  if (typeof firstError === 'string') return firstError;
  if (firstError && typeof firstError === 'object') {
    return firstError.errorValue || firstError.message || firstError.errorType || JSON.stringify(firstError);
  }
  return data?.message || data?.details || `Amazon Ads HTTP ${status}`;
}

async function adsRequestV3(method, path, body, refreshToken, profileId, region, contentType = 'application/json') {
  if (!profileId) throw new Error('ads_profile_id ausente para a conta');

  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const token = await getAdsToken(refreshToken);
    const res = await fetch(`${getAdsBaseUrl(region)}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
        'Amazon-Advertising-API-Scope': String(profileId),
        'Content-Type': contentType,
        'Accept': contentType,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    const requestId = res.headers.get('x-amzn-requestid') || res.headers.get('x-amz-request-id') || '';

    if (res.status === 429 && attempt < MAX_429_RETRIES) {
      const retryAfterSeconds = numberValue(res.headers.get('retry-after'), 0);
      const delayMs = retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : Math.min(30000, 1000 * (2 ** attempt) + Math.floor(Math.random() * 500));
      await sleep(delayMs);
      continue;
    }

    if (!res.ok) {
      throw Object.assign(
        new Error(amazonErrorMessage(res.status, data)),
        {
          status: res.status,
          amazon_response: data,
          request_id: requestId,
        },
      );
    }

    return { status: res.status, data, requestId };
  }

  throw new Error('Amazon Ads: limite de tentativas excedido');
}

function entityResult(result, collection, idField, id) {
  const bucket = result?.data?.[collection] || result?.data || {};
  const successes = Array.isArray(bucket?.success) ? bucket.success : [];
  const errors = Array.isArray(bucket?.error) ? bucket.error : [];
  const normalizedId = String(id);

  const matchingError = errors.find(item => String(item?.[idField] || item?.campaignId || item?.keywordId || '') === normalizedId);
  if (matchingError) {
    return { ok: false, error: matchingError.errorValue || matchingError.message || matchingError.errorType || 'Erro Amazon sem detalhe' };
  }

  if (successes.length > 0) {
    const matchingSuccess = successes.find(item => String(item?.[idField] || item?.campaignId || item?.keywordId || '') === normalizedId);
    return matchingSuccess
      ? { ok: true, item: matchingSuccess }
      : { ok: false, error: 'Amazon não confirmou o recurso na resposta de sucesso' };
  }

  if (errors.length === 0 && result?.status >= 200 && result?.status < 300) {
    return { ok: true, item: null };
  }

  return { ok: false, error: 'Resposta Amazon inconclusiva' };
}

function buildCampaignAsinMap(searchTerms) {
  const votesByCampaign = new Map();

  for (const row of searchTerms) {
    const campaignId = campaignIdOf(row);
    const asin = String(row?.advertised_asin || row?.advertisedAsin || row?.asin || '');
    if (!campaignId || !asin) continue;

    if (!votesByCampaign.has(campaignId)) votesByCampaign.set(campaignId, new Map());
    const votes = votesByCampaign.get(campaignId);
    const weight = Math.max(1, firstNumber(row, ['impressions'], 0));
    votes.set(asin, numberValue(votes.get(asin), 0) + weight);
  }

  const result = new Map();
  for (const [campaignId, votes] of votesByCampaign.entries()) {
    const winner = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (winner) result.set(campaignId, winner[0]);
  }
  return result;
}

function buildCampaignMetrics30d(metricsRows, cutoffDate) {
  const byCampaign = new Map();

  for (const row of metricsRows) {
    const campaignId = campaignIdOf(row);
    if (!campaignId) continue;
    if (row?.date && String(row.date).slice(0, 10) < cutoffDate) continue;

    if (!byCampaign.has(campaignId)) {
      byCampaign.set(campaignId, { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0 });
    }
    const metrics = byCampaign.get(campaignId);
    metrics.impressions += firstNumber(row, ['impressions'], 0);
    metrics.clicks += firstNumber(row, ['clicks'], 0);
    metrics.spend += firstNumber(row, ['spend', 'cost'], 0);
    metrics.sales += firstNumber(row, ['sales', 'sales_14d', 'sales14d'], 0);
    metrics.orders += firstNumber(row, ['orders', 'orders_14d', 'purchases14d', 'purchases'], 0);
  }

  return byCampaign;
}

function buildSearchTermStats30d(searchTerms, cutoffDate) {
  const byCampaign = new Map();

  for (const row of searchTerms) {
    const campaignId = campaignIdOf(row);
    if (!campaignId) continue;
    if (row?.date && String(row.date).slice(0, 10) < cutoffDate) continue;

    if (!byCampaign.has(campaignId)) {
      byCampaign.set(campaignId, {
        terms: new Set(),
        convertingTerms: new Set(),
        impressions: 0,
        clicks: 0,
        spend: 0,
        sales: 0,
        orders: 0,
      });
    }

    const stats = byCampaign.get(campaignId);
    const term = normalizeSearchTerm(row?.search_term || row?.searchTerm || row?.keyword_text || row?.keyword);
    const orders = firstNumber(row, ['orders_30d', 'purchases30d', 'orders_14d', 'purchases14d', 'orders_7d', 'purchases7d', 'orders', 'purchases'], 0);

    if (term) stats.terms.add(term);
    if (term && orders > 0) stats.convertingTerms.add(term);

    stats.impressions += firstNumber(row, ['impressions'], 0);
    stats.clicks += firstNumber(row, ['clicks'], 0);
    stats.spend += firstNumber(row, ['spend', 'cost'], 0);
    stats.sales += firstNumber(row, ['sales_30d', 'sales30d', 'sales_14d', 'sales14d', 'sales_7d', 'sales7d', 'sales'], 0);
    stats.orders += orders;
  }

  return byCampaign;
}

function rankAutomaticCampaigns(campaigns, metrics30d, searchStats30d, targetAcos, targetRoas) {
  const candidates = campaigns.map(campaign => {
    const campaignId = campaignIdOf(campaign);
    const persistedMetrics = metrics30d.get(campaignId) || {};
    const searchStats = searchStats30d.get(campaignId) || {};

    const impressions = numberValue(persistedMetrics.impressions, firstNumber(campaign, ['impressions_30d', 'impressions'], 0));
    const clicks = numberValue(persistedMetrics.clicks, firstNumber(campaign, ['clicks_30d', 'clicks'], 0));
    const spend = numberValue(persistedMetrics.spend, firstNumber(campaign, ['spend_30d', 'spend', 'cost'], 0));
    const sales = numberValue(persistedMetrics.sales, firstNumber(campaign, ['sales_30d', 'sales'], 0));
    const orders = numberValue(persistedMetrics.orders, firstNumber(campaign, ['orders_30d', 'orders'], 0));
    const uniqueTerms = searchStats?.terms?.size || firstNumber(campaign, ['search_terms_count', 'terms_count'], 0);
    const convertingTerms = searchStats?.convertingTerms?.size || firstNumber(campaign, ['converting_terms_count'], 0);
    const acos = sales > 0 ? (spend / sales) * 100 : null;
    const roas = spend > 0 ? sales / spend : 0;
    const cvr = clicks > 0 ? orders / clicks : 0;

    return {
      campaign,
      campaignId,
      impressions,
      clicks,
      spend,
      sales,
      orders,
      uniqueTerms,
      convertingTerms,
      acos,
      roas,
      cvr,
      hasSales: sales > 0 || orders > 0,
      isEnabled: normalizedState(campaign) === 'enabled',
      isOperational: campaign?.is_operational === true,
    };
  });

  const maximum = field => Math.max(1, ...candidates.map(item => numberValue(item[field], 0)));
  const maxOrders = maximum('orders');
  const maxSales = maximum('sales');
  const maxConvertingTerms = maximum('convertingTerms');
  const maxUniqueTerms = maximum('uniqueTerms');
  const maxImpressions = maximum('impressions');
  const maxClicks = maximum('clicks');
  const effectiveTargetRoas = Math.max(0.01, numberValue(targetRoas, 4));

  for (const candidate of candidates) {
    const acosEfficiency = candidate.acos === null
      ? 0
      : candidate.acos <= targetAcos
        ? 1
        : candidate.acos <= targetAcos * 1.5
          ? 0.5
          : 0;
    const roasEfficiency = Math.min(1, candidate.roas / effectiveTargetRoas);

    candidate.efficiencyScore = Math.round((
      (candidate.orders / maxOrders) * 0.30
      + (candidate.sales / maxSales) * 0.25
      + (candidate.convertingTerms / maxConvertingTerms) * 0.15
      + (candidate.uniqueTerms / maxUniqueTerms) * 0.12
      + (candidate.impressions / maxImpressions) * 0.07
      + (candidate.clicks / maxClicks) * 0.03
      + roasEfficiency * 0.04
      + acosEfficiency * 0.02
      + (candidate.isEnabled ? 0.01 : 0)
      + (candidate.isOperational ? 0.01 : 0)
    ) * 10000) / 100;
  }

  return candidates.sort((a, b) => {
    if (a.hasSales !== b.hasSales) return a.hasSales ? -1 : 1;
    if (b.efficiencyScore !== a.efficiencyScore) return b.efficiencyScore - a.efficiencyScore;
    if (b.orders !== a.orders) return b.orders - a.orders;
    if (b.sales !== a.sales) return b.sales - a.sales;
    if (b.convertingTerms !== a.convertingTerms) return b.convertingTerms - a.convertingTerms;
    if (b.uniqueTerms !== a.uniqueTerms) return b.uniqueTerms - a.uniqueTerms;
    if (b.impressions !== a.impressions) return b.impressions - a.impressions;
    if (a.acos !== null && b.acos !== null && a.acos !== b.acos) return a.acos - b.acos;
    if (b.roas !== a.roas) return b.roas - a.roas;
    if (b.clicks !== a.clicks) return b.clicks - a.clicks;
    return a.campaignId.localeCompare(b.campaignId);
  });
}

async function enforceSingleAutomaticCampaignPerAsin(base44, account) {
  const startedAt = new Date().toISOString();
  const cutoffDate = new Date(Date.now() - AUTO_DEDUP_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);

  const [campaigns, metricsRows, searchTerms, performanceSettings] = await Promise.all([
    base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: account.id }, null, 500).catch(() => []),
    base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: account.id }, '-date', 5000).catch(() => []),
    base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: account.id }, '-date', 5000).catch(() => []),
    base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: account.id }, '-updated_at', 1).catch(() => []),
  ]);

  const activeAutomaticCampaigns = campaigns.filter(campaign => isAutomaticCampaign(campaign) && isNonArchivedCampaign(campaign));
  if (activeAutomaticCampaigns.length <= 1) {
    return { account_id: account.id, groups_with_duplicates: 0, archived: 0, failed: 0, winners: [] };
  }

  const campaignAsinMap = buildCampaignAsinMap(searchTerms);
  const metrics30d = buildCampaignMetrics30d(metricsRows, cutoffDate);
  const searchStats30d = buildSearchTermStats30d(searchTerms, cutoffDate);
  const settings = performanceSettings[0] || {};
  const targetAcos = firstNumber(settings, ['target_acos', 'acos_target'], firstNumber(account, ['target_acos', 'acos_target'], 15));
  const targetRoas = firstNumber(settings, ['target_roas', 'roas_target'], firstNumber(account, ['target_roas', 'roas_target'], 4));

  const campaignsByAsin = new Map();
  const unmappedCampaigns = [];

  for (const campaign of activeAutomaticCampaigns) {
    const campaignId = campaignIdOf(campaign);
    const asin = String(campaign?.asin || campaign?.advertised_asin || campaignAsinMap.get(campaignId) || '');
    if (!campaignId || !asin) {
      unmappedCampaigns.push({ campaign_id: campaignId, name: campaign?.name || campaign?.campaign_name || '' });
      continue;
    }
    if (!campaignsByAsin.has(asin)) campaignsByAsin.set(asin, []);
    campaignsByAsin.get(asin).push(campaign);
  }

  const archiveCandidates = [];
  const winners = [];

  for (const [asin, asinCampaigns] of campaignsByAsin.entries()) {
    if (asinCampaigns.length <= 1) continue;

    const ranking = rankAutomaticCampaigns(asinCampaigns, metrics30d, searchStats30d, targetAcos, targetRoas);
    const winner = ranking[0];
    winners.push({
      asin,
      campaign_id: winner.campaignId,
      name: winner.campaign?.name || winner.campaign?.campaign_name || '',
      efficiency_score: winner.efficiencyScore,
      orders_30d: winner.orders,
      sales_30d: winner.sales,
      unique_terms_30d: winner.uniqueTerms,
      converting_terms_30d: winner.convertingTerms,
      impressions_30d: winner.impressions,
      acos_30d: winner.acos,
      roas_30d: winner.roas,
    });

    for (const duplicate of ranking.slice(1)) {
      archiveCandidates.push({
        asin,
        winner,
        duplicate,
        idempotency_key: `auto_campaign_canonical_archive|${account.id}|${asin}|${duplicate.campaignId}|winner:${winner.campaignId}`,
      });
    }
  }

  if (archiveCandidates.length === 0) {
    return {
      account_id: account.id,
      groups_with_duplicates: 0,
      archived: 0,
      failed: 0,
      winners,
      unmapped_campaigns: unmappedCampaigns,
    };
  }

  const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
  const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
  const region = account.region || Deno.env.get('ADS_REGION');
  const archived = [];
  const failed = [];

  for (let index = 0; index < archiveCandidates.length; index += 10) {
    const batch = archiveCandidates.slice(index, index + 10);

    try {
      const result = await adsRequestV3(
        'PUT',
        '/sp/campaigns',
        { campaigns: batch.map(item => ({ campaignId: item.duplicate.campaignId, state: 'ARCHIVED' })) },
        refreshToken,
        profileId,
        region,
        'application/vnd.spCampaign.v3+json',
      );

      for (const item of batch) {
        const confirmation = entityResult(result, 'campaigns', 'campaignId', item.duplicate.campaignId);
        if (!confirmation.ok) {
          failed.push({
            asin: item.asin,
            campaign_id: item.duplicate.campaignId,
            winner_campaign_id: item.winner.campaignId,
            error: confirmation.error,
            request_id: result.requestId,
          });
          continue;
        }

        await base44.asServiceRole.entities.Campaign.update(item.duplicate.campaign.id, {
          state: 'archived',
          status: 'archived',
          synced_at: new Date().toISOString(),
        });

        archived.push({
          asin: item.asin,
          campaign_id: item.duplicate.campaignId,
          name: item.duplicate.campaign?.name || item.duplicate.campaign?.campaign_name || '',
          winner_campaign_id: item.winner.campaignId,
          winner_efficiency_score: item.winner.efficiencyScore,
          duplicate_efficiency_score: item.duplicate.efficiencyScore,
          reason: 'canonical_single_auto_campaign_per_asin',
          idempotency_key: item.idempotency_key,
          request_id: result.requestId,
        });
      }
    } catch (error) {
      for (const item of batch) {
        failed.push({
          asin: item.asin,
          campaign_id: item.duplicate.campaignId,
          winner_campaign_id: item.winner.campaignId,
          error: error.message,
          amazon_status: error.status || null,
          request_id: error.request_id || '',
        });
      }
    }
  }

  await base44.asServiceRole.entities.SyncExecutionLog.create({
    amazon_account_id: account.id,
    operation: 'canonical_single_auto_campaign_per_asin',
    trigger_type: 'automatic',
    status: failed.length === 0 ? 'success' : archived.length > 0 ? 'partial' : 'error',
    execution_date: new Date().toISOString().slice(0, 10),
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - new Date(startedAt).getTime(),
    records_processed: archiveCandidates.length,
    error_message: failed.length > 0 ? `${failed.length} campanha(s) não confirmada(s) pela Amazon` : null,
    result_summary: JSON.stringify({
      rule: 'one_non_archived_auto_campaign_per_asin',
      selection_window_days: AUTO_DEDUP_LOOKBACK_DAYS,
      selection_priority: ['orders', 'sales', 'converting_terms', 'unique_terms', 'impressions', 'roas', 'acos', 'clicks'],
      winners,
      archived,
      failed,
      unmapped_campaigns: unmappedCampaigns,
    }).slice(0, 12000),
  }).catch(() => {});

  return {
    account_id: account.id,
    groups_with_duplicates: winners.length,
    candidates_to_archive: archiveCandidates.length,
    archived: archived.length,
    failed: failed.length,
    winners,
    archived_campaigns: archived,
    failures: failed,
    unmapped_campaigns: unmappedCampaigns,
  };
}

async function assertNoExistingAutoCampaign(base44, accountId, asin) {
  if (!asin) return { allowed: false, reason: 'ASIN ausente na ação de criação AUTO' };

  const campaigns = await base44.asServiceRole.entities.Campaign.filter({
    amazon_account_id: accountId,
    asin,
  }, null, 100).catch(() => []);

  const existing = campaigns.find(campaign => isAutomaticCampaign(campaign) && isNonArchivedCampaign(campaign));
  return existing
    ? { allowed: false, reason: `Campanha AUTO já existente para ${asin}: ${campaignIdOf(existing)}` }
    : { allowed: true, reason: 'ok' };
}

Deno.serve(async (req) => {
  const startTime = Date.now();

  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const executionDate = new Date().toISOString().slice(0, 10);

    const connectedAccounts = await base44.asServiceRole.entities.AmazonAccount.filter(
      { status: 'connected' },
      null,
      100,
    ).catch(() => []);

    const canonicalAutoResults = [];
    for (const account of connectedAccounts) {
      try {
        canonicalAutoResults.push(await enforceSingleAutomaticCampaignPerAsin(base44, account));
      } catch (error) {
        canonicalAutoResults.push({ account_id: account.id, error: error.message, archived: 0, failed: 1 });
      }
    }

    const actions = await base44.asServiceRole.entities.AgentAction.filter(
      { status: { $in: ['pending', 'approved', 'scheduled'] } },
      'created_at',
      500,
    );

    if (actions.length === 0) {
      return Response.json({
        ok: true,
        message: 'Nenhuma ação pendente',
        canonical_auto_campaign_rule: canonicalAutoResults,
        duration: Date.now() - startTime,
      });
    }

    const actionsByAccount = {};
    for (const action of actions) {
      if (!actionsByAccount[action.amazon_account_id]) actionsByAccount[action.amazon_account_id] = [];
      actionsByAccount[action.amazon_account_id].push(action);
    }

    const accountsById = new Map(connectedAccounts.map(account => [account.id, account]));
    const results = [];
    let totalProcessed = 0;
    let totalSucceeded = 0;
    let totalFailed = 0;
    let totalRescheduled = 0;

    for (const [accountId, accountActions] of Object.entries(actionsByAccount)) {
      const account = accountsById.get(accountId)
        || await base44.asServiceRole.entities.AmazonAccount.get(accountId).catch(() => null);

      if (!account || account.status !== 'connected') {
        results.push({ account: accountId, error: 'Conta não conectada', actions_skipped: accountActions.length });
        continue;
      }

      const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
      const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
      const region = account.region || Deno.env.get('ADS_REGION');

      const order = {
        'create_auto_campaign': 1,
        'create_manual_campaign': 1,
        'create_keyword': 2,
        'create_product_target': 2,
        'negative_keyword': 3,
        'update_bid': 4,
        'update_budget': 4,
        'pause_campaign': 5,
        'enable_campaign': 5,
        'archive_campaign': 5,
      };
      accountActions.sort((a, b) => (order[a.action] || 99) - (order[b.action] || 99));

      let accountSucceeded = 0;
      let accountFailed = 0;
      let accountRescheduled = 0;

      for (const action of accountActions) {
        totalProcessed++;
        const now = new Date().toISOString();

        try {
          let apiResult = null;
          let requestId = '';

          if (action.action === 'create_auto_campaign') {
            const autoGuard = await assertNoExistingAutoCampaign(base44, accountId, action.asin);
            if (!autoGuard.allowed) {
              await base44.asServiceRole.entities.AgentAction.update(action.id, {
                status: 'executed',
                executed_at: now,
                execution_response: `SKIPPED_CANONICAL_GUARD: ${autoGuard.reason}`,
              });
              accountSucceeded++;
              totalSucceeded++;
              results.push({ action_id: action.id, status: 'skipped', reason: autoGuard.reason });
              continue;
            }
          }

          switch (action.action) {
            case 'update_bid': {
              const result = await adsRequestV3(
                'PUT',
                '/sp/keywords',
                { keywords: [{ keywordId: action.keyword_id, bid: action.new_value }] },
                refreshToken,
                profileId,
                region,
                'application/vnd.spKeyword.v3+json',
              );
              const confirmation = entityResult(result, 'keywords', 'keywordId', action.keyword_id);
              if (!confirmation.ok) throw new Error(confirmation.error);
              apiResult = result.data;
              requestId = result.requestId;

              const kws = await base44.asServiceRole.entities.Keyword.filter({
                amazon_account_id: accountId,
                keyword_id: action.keyword_id,
              });
              if (kws.length > 0) {
                await base44.asServiceRole.entities.Keyword.update(kws[0].id, {
                  current_bid: action.new_value,
                  bid: action.new_value,
                });
              }
              break;
            }

            case 'update_budget': {
              const result = await adsRequestV3(
                'PUT',
                '/sp/campaigns',
                { campaigns: [{
                  campaignId: action.campaign_id,
                  budget: { budgetType: 'DAILY', budget: action.new_value },
                }] },
                refreshToken,
                profileId,
                region,
                'application/vnd.spCampaign.v3+json',
              );
              const confirmation = entityResult(result, 'campaigns', 'campaignId', action.campaign_id);
              if (!confirmation.ok) throw new Error(confirmation.error);
              apiResult = result.data;
              requestId = result.requestId;

              const camps = await base44.asServiceRole.entities.Campaign.filter({
                amazon_account_id: accountId,
                campaign_id: action.campaign_id,
              });
              if (camps.length > 0) {
                await base44.asServiceRole.entities.Campaign.update(camps[0].id, {
                  daily_budget: action.new_value,
                  synced_at: now,
                });
              }
              break;
            }

            case 'pause_campaign': {
              const result = await adsRequestV3(
                'PUT',
                '/sp/campaigns',
                { campaigns: [{ campaignId: action.campaign_id, state: 'PAUSED' }] },
                refreshToken,
                profileId,
                region,
                'application/vnd.spCampaign.v3+json',
              );
              const confirmation = entityResult(result, 'campaigns', 'campaignId', action.campaign_id);
              if (!confirmation.ok) throw new Error(confirmation.error);
              apiResult = result.data;
              requestId = result.requestId;

              const camps = await base44.asServiceRole.entities.Campaign.filter({
                amazon_account_id: accountId,
                campaign_id: action.campaign_id,
              });
              if (camps.length > 0) {
                await base44.asServiceRole.entities.Campaign.update(camps[0].id, {
                  state: 'paused',
                  status: 'paused',
                  synced_at: now,
                });
              }
              break;
            }

            case 'enable_campaign': {
              const result = await adsRequestV3(
                'PUT',
                '/sp/campaigns',
                { campaigns: [{ campaignId: action.campaign_id, state: 'ENABLED' }] },
                refreshToken,
                profileId,
                region,
                'application/vnd.spCampaign.v3+json',
              );
              const confirmation = entityResult(result, 'campaigns', 'campaignId', action.campaign_id);
              if (!confirmation.ok) throw new Error(confirmation.error);
              apiResult = result.data;
              requestId = result.requestId;

              const camps = await base44.asServiceRole.entities.Campaign.filter({
                amazon_account_id: accountId,
                campaign_id: action.campaign_id,
              });
              if (camps.length > 0) {
                await base44.asServiceRole.entities.Campaign.update(camps[0].id, {
                  state: 'enabled',
                  status: 'enabled',
                  synced_at: now,
                });
              }
              break;
            }

            case 'archive_campaign': {
              const result = await adsRequestV3(
                'PUT',
                '/sp/campaigns',
                { campaigns: [{ campaignId: action.campaign_id, state: 'ARCHIVED' }] },
                refreshToken,
                profileId,
                region,
                'application/vnd.spCampaign.v3+json',
              );
              const confirmation = entityResult(result, 'campaigns', 'campaignId', action.campaign_id);
              if (!confirmation.ok) throw new Error(confirmation.error);
              apiResult = result.data;
              requestId = result.requestId;

              const camps = await base44.asServiceRole.entities.Campaign.filter({
                amazon_account_id: accountId,
                campaign_id: action.campaign_id,
              });
              if (camps.length > 0) {
                await base44.asServiceRole.entities.Campaign.update(camps[0].id, {
                  state: 'archived',
                  status: 'archived',
                  synced_at: now,
                });
              }
              break;
            }

            case 'negative_keyword': {
              const result = await adsRequestV3(
                'POST',
                '/sp/negativeKeywords',
                { negativeKeywords: [{
                  campaignId: action.campaign_id,
                  adGroupId: action.ad_group_id,
                  keywordText: action.keyword,
                  matchType: 'NEGATIVE_EXACT',
                  state: 'ENABLED',
                }] },
                refreshToken,
                profileId,
                region,
                'application/vnd.spNegativeKeyword.v3+json',
              );
              apiResult = result.data;
              requestId = result.requestId;
              break;
            }

            default:
              throw new Error(`Ação '${action.action}' não mapeada`);
          }

          await base44.asServiceRole.entities.AgentAction.update(action.id, {
            status: 'executed',
            executed_at: now,
            execution_response: JSON.stringify({ request_id: requestId, amazon_response: apiResult }).slice(0, 1000),
          });

          accountSucceeded++;
          totalSucceeded++;
          results.push({ action_id: action.id, status: 'executed', request_id: requestId });
        } catch (error) {
          const retryable = [409, 429, 504, 524].includes(numberValue(error.status, 0));

          await base44.asServiceRole.entities.AgentAction.update(action.id, {
            status: retryable ? 'scheduled' : 'failed',
            executed_at: retryable ? null : now,
            execution_response: JSON.stringify({
              error: error.message,
              amazon_status: error.status || null,
              request_id: error.request_id || '',
              retryable,
            }).slice(0, 1000),
          });

          if (retryable) {
            accountRescheduled++;
            totalRescheduled++;
            results.push({ action_id: action.id, status: 'scheduled', error: error.message, amazon_status: error.status || null });
          } else {
            accountFailed++;
            totalFailed++;
            results.push({ action_id: action.id, status: 'failed', error: error.message, amazon_status: error.status || null });
          }
        }
      }

      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: accountId,
        operation: 'runDailyAmazonActionQueue',
        trigger_type: 'automatic',
        status: accountFailed === 0 ? (accountRescheduled > 0 ? 'partial' : 'success') : 'partial',
        execution_date: executionDate,
        started_at: new Date(startTime).toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        records_processed: accountSucceeded + accountFailed + accountRescheduled,
        error_message: accountFailed > 0
          ? `${accountFailed} ação(ões) falharam`
          : accountRescheduled > 0
            ? `${accountRescheduled} ação(ões) reagendadas`
            : null,
      });
    }

    return Response.json({
      ok: true,
      accounts_processed: Object.keys(actionsByAccount).length,
      total_actions: actions.length,
      processed: totalProcessed,
      succeeded: totalSucceeded,
      failed: totalFailed,
      rescheduled: totalRescheduled,
      canonical_auto_campaign_rule: canonicalAutoResults,
      results,
      duration_ms: Date.now() - startTime,
    });
  } catch (error) {
    console.error('[ActionQueue] Erro geral:', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});
