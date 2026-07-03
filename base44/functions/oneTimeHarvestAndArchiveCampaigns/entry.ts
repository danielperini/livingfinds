import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const KEEP_CAMPAIGNS = [
  'AUTO | B0G1MZLYS9 | 2026-06-30',
  'Organizador Talheres Manual Produtos',
  'Organizador Talheres Manual Palavras',
  'Gimbal Manual Palavras',
  'Gimbal Manual Produtos',
  'Bastão Selfie [Produtos]',
  'Ventilador [Produtos]',
  'Ventilador [PALAVRAS]',
  'LIXEIRA 15 LTS [PRODUTOS]',
  'Lixeiras Sensor [PALAVRAS]',
  'NEBULIZADOR [PRODUTOS]',
  'Nebulizador Mesh [PALAVRAS]',
  'Campanha Manual PRODUTO - Lapela - 17/01',
  'Manual Palavras - Lapela - 17/01',
];

const normalize = (value) => String(value || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const keepNames = new Set(KEEP_CAMPAIGNS.map(normalize));
const tokenCache = new Map();

async function getToken(account) {
  const refreshToken = account?.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
  const clientId = Deno.env.get('ADS_CLIENT_ID');
  const clientSecret = Deno.env.get('ADS_CLIENT_SECRET');
  if (!refreshToken || !clientId || !clientSecret) throw new Error('Credenciais Amazon Ads incompletas.');

  const key = String(account?.id || 'default');
  const cached = tokenCache.get(key);
  if (cached?.expiresAt > Date.now()) return cached.value;

  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.error || 'Falha no OAuth Amazon Ads.');
  tokenCache.set(key, { value: data.access_token, expiresAt: Date.now() + (number(data.expires_in || 3600) - 60) * 1000 });
  return data.access_token;
}

function adsBase() {
  const region = String(Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (region.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (region.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function archiveRemote(account, campaigns) {
  if (!campaigns.length) return { archived: 0, errors: [] };
  const token = await getToken(account);
  const clientId = Deno.env.get('ADS_CLIENT_ID');
  const profileId = account?.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
  if (!profileId) throw new Error('Amazon Ads Profile ID não configurado.');

  let archived = 0;
  const errors = [];
  for (let i = 0; i < campaigns.length; i += 100) {
    const batch = campaigns.slice(i, i + 100);
    const response = await fetch(`${adsBase()}/sp/campaigns`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': clientId,
        'Amazon-Advertising-API-Scope': String(profileId),
        'Content-Type': 'application/vnd.spCampaign.v3+json',
        Accept: 'application/vnd.spCampaign.v3+json',
      },
      body: JSON.stringify({
        campaigns: batch.map((campaign) => ({
          campaignId: String(campaign.campaign_id),
          state: 'ARCHIVED',
        })),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      errors.push({ status: response.status, campaign_ids: batch.map((c) => c.campaign_id), response: data });
      continue;
    }
    const failedIndexes = new Set((data?.errors || []).map((error) => Number(error.index)));
    archived += batch.filter((_, index) => !failedIndexes.has(index)).length;
    for (const error of data?.errors || []) errors.push({ campaign_id: batch[error.index]?.campaign_id, response: error });
  }
  return { archived, errors };
}

function termMetrics(term) {
  const orders = number(term.orders_14d ?? term.orders_7d ?? term.orders ?? term.purchases ?? term.units_ordered);
  const sales = number(term.sales_14d ?? term.sales_7d ?? term.sales ?? term.revenue ?? term.sales_amount);
  const spend = number(term.spend ?? term.cost);
  const clicks = number(term.clicks);
  const impressions = number(term.impressions);
  const acos = sales > 0 ? spend / sales * 100 : 999;
  const roas = spend > 0 ? sales / spend : sales > 0 ? 99 : 0;
  const conversionRate = clicks > 0 ? orders / clicks * 100 : orders > 0 ? 100 : 0;
  const performanceScore = Math.min(100, Math.round(
    Math.min(40, orders * 4) +
    Math.min(25, roas * 8) +
    Math.min(20, conversionRate) +
    (acos <= 25 ? 15 : acos <= 40 ? 8 : 0)
  ));
  return { orders, sales, spend, clicks, impressions, acos, roas, conversionRate, performanceScore };
}

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(request);
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const accountId = body.amazon_account_id;
    if (!accountId) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });
    if (body.confirm !== 'EXECUTAR_UNICA_VEZ') {
      return Response.json({ ok: false, error: 'Confirmação inválida. Use confirm=EXECUTAR_UNICA_VEZ.' }, { status: 400 });
    }

    const previousRuns = await base44.asServiceRole.entities.SyncExecutionLog.filter({
      amazon_account_id: accountId,
      operation: 'one_time_harvest_archive_legacy_campaigns',
      status: 'success',
    }, '-completed_at', 1);
    if (previousRuns.length) {
      return Response.json({ ok: false, already_executed: true, error: 'Esta rotina única já foi concluída e não pode ser repetida.' }, { status: 409 });
    }

    const account = await base44.asServiceRole.entities.AmazonAccount.get(accountId);
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });

    const campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-created_date', 10000);
    const selected = campaigns.filter((campaign) => keepNames.has(normalize(campaign.name || campaign.campaign_name)));
    const selectedIds = new Set(selected.map((campaign) => String(campaign.campaign_id)));
    const foundNames = new Set(selected.map((campaign) => normalize(campaign.name || campaign.campaign_name)));
    const missingKeepCampaigns = KEEP_CAMPAIGNS.filter((name) => !foundNames.has(normalize(name)));

    const searchTerms = await base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: accountId }, '-orders', 10000);
    const eligibleTerms = searchTerms
      .filter((term) => selectedIds.has(String(term.campaign_id)))
      .map((term) => ({ term, metrics: termMetrics(term) }))
      .filter(({ term, metrics }) => {
        const text = String(term.search_term || term.term || term.keyword_text || '').trim();
        const goodPerformance = metrics.sales > 0 && (metrics.acos <= 40 || metrics.roas >= 2) && metrics.performanceScore >= 60;
        return text && metrics.orders > 5 && goodPerformance;
      });

    let termsCreated = 0;
    let termsUpdated = 0;
    const harvested = [];
    for (const { term, metrics } of eligibleTerms) {
      const text = String(term.search_term || term.term || term.keyword_text).trim();
      const normalizedTerm = normalize(text);
      const existing = await base44.asServiceRole.entities.TermBank.filter({ amazon_account_id: accountId, normalized_term: normalizedTerm }, '-updated_at', 10);
      const campaign = selected.find((item) => String(item.campaign_id) === String(term.campaign_id));
      const record = {
        amazon_account_id: accountId,
        term: text,
        normalized_term: normalizedTerm,
        asin: term.advertised_asin || term.asin || campaign?.asin || null,
        sku: term.sku || campaign?.sku || null,
        campaign_id: String(term.campaign_id),
        source: 'csv_import',
        classification: 'winner',
        orders: metrics.orders,
        sales: metrics.sales,
        spend: metrics.spend,
        clicks: metrics.clicks,
        impressions: metrics.impressions,
        acos: Number(metrics.acos.toFixed(2)),
        roas: Number(metrics.roas.toFixed(2)),
        conversion_rate: Number(metrics.conversionRate.toFixed(2)),
        performance_score: metrics.performanceScore,
        last_seen_at: new Date().toISOString(),
        notes: 'Importado pela rotina única de preservação antes do arquivamento de campanhas legadas.',
      };
      if (existing.length) {
        await base44.asServiceRole.entities.TermBank.update(existing[0].id, record);
        termsUpdated += 1;
      } else {
        await base44.asServiceRole.entities.TermBank.create(record);
        termsCreated += 1;
      }
      harvested.push({ term: text, campaign: campaign?.name || campaign?.campaign_name, ...metrics });
    }

    const archiveCandidates = campaigns.filter((campaign) => {
      const state = String(campaign.state || campaign.status || '').toLowerCase();
      const hasRemoteId = Boolean(campaign.campaign_id);
      return hasRemoteId && !keepNames.has(normalize(campaign.name || campaign.campaign_name)) && state !== 'archived' && campaign.archived !== true;
    });

    const remoteResult = await archiveRemote(account, archiveCandidates);
    const failedIds = new Set(remoteResult.errors.map((error) => String(error.campaign_id || '')).filter(Boolean));
    let localArchived = 0;
    for (const campaign of archiveCandidates) {
      if (failedIds.has(String(campaign.campaign_id))) continue;
      await base44.asServiceRole.entities.Campaign.update(campaign.id, {
        state: 'archived',
        status: 'archived',
        archived: true,
        archived_at: new Date().toISOString(),
        archive_reason: 'Rotina única: campanhas legadas não incluídas na lista de preservação.',
      });
      localArchived += 1;
    }

    const completedAt = new Date().toISOString();
    const summary = {
      keep_campaigns_requested: KEEP_CAMPAIGNS.length,
      keep_campaigns_found: selected.length,
      missing_keep_campaigns: missingKeepCampaigns,
      search_terms_scanned: searchTerms.length,
      eligible_terms: eligibleTerms.length,
      terms_created: termsCreated,
      terms_updated: termsUpdated,
      archive_candidates: archiveCandidates.length,
      archived_remote: remoteResult.archived,
      archived_local: localArchived,
      archive_errors: remoteResult.errors,
    };

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'one_time_harvest_archive_legacy_campaigns',
      status: remoteResult.errors.length ? 'error' : 'success',
      trigger_type: 'manual_one_time',
      started_at: startedAt,
      completed_at: completedAt,
      records_processed: termsCreated + termsUpdated + localArchived,
      result_summary: JSON.stringify(summary).slice(0, 4000),
      error_message: remoteResult.errors.length ? JSON.stringify(remoteResult.errors).slice(0, 1000) : null,
    });

    return Response.json({
      ok: remoteResult.errors.length === 0,
      one_time: true,
      completed_at: completedAt,
      summary,
      harvested_terms: harvested,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro na rotina única' }, { status: 500 });
  }
});
