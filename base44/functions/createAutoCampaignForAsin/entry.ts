/**
 * createAutoCampaignForAsin — Cria campanha Sponsored Products AUTO para um ASIN.
 * Com reconciliação, idempotência, tratamento de HTTP 207 e parser tolerante.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

async function getAdsToken(refreshToken) {
  const cached = tokenCache['ads'];
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: Deno.env.get('ADS_CLIENT_ID'),
    client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Token failed');
  tokenCache['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBaseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsRequestWithDetails(method, path, body, refreshToken, profileId, contentType = 'application/json') {
  const token = await getAdsToken(refreshToken);
  const res = await fetch(`${getAdsBaseUrl()}${path}`, {
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
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data, headers: { requestId: res.headers.get('x-amzn-requestid') || '' } };
}

function extractCampaignId(result) {
  if (!result) return null;
  const paths = [
    () => result.campaignId,
    () => result.campaigns?.[0]?.campaignId,
    () => result.campaigns?.success?.[0]?.campaignId,
    () => result.success?.[0]?.campaignId,
    () => result.successes?.[0]?.campaignId,
    () => result.data?.campaignId,
    () => result.data?.campaigns?.[0]?.campaignId,
    () => result.result?.campaignId,
    () => result.results?.[0]?.campaignId,
    () => Array.isArray(result) ? result[0]?.campaignId : null,
  ];
  for (const fn of paths) {
    try {
      const val = fn();
      if (val) return String(val);
    } catch {}
  }
  return null;
}

function extractCampaignError(result) {
  if (!result) return null;
  const errPaths = [
    () => result.errors?.[0],
    () => result.error,
    () => result.failures?.[0],
    () => result.failure,
    () => result.invalid,
    () => result.campaigns?.error?.[0],
    () => result.campaigns?.failures?.[0],
  ];
  for (const fn of errPaths) {
    try {
      const val = fn();
      if (val) return val;
    } catch {}
  }
  return null;
}

function extractAdGroupId(result) {
  if (!result) return null;
  const paths = [
    () => result.adGroupId,
    () => result.adGroups?.[0]?.adGroupId,
    () => result.adGroups?.success?.[0]?.adGroupId,
    () => result.success?.[0]?.adGroupId,
    () => result.data?.adGroupId,
    () => result.data?.adGroups?.[0]?.adGroupId,
  ];
  for (const fn of paths) {
    try {
      const val = fn();
      if (val) return String(val);
    } catch {}
  }
  return null;
}

async function reconcileCampaign(token, profileId, campaignName, asin) {
  try {
    const res = await fetch(`${getAdsBaseUrl()}/sp/campaigns/list`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
        'Amazon-Advertising-API-Scope': String(profileId),
        'Content-Type': 'application/vnd.spCampaign.v3+json',
        'Accept': 'application/vnd.spCampaign.v3+json',
      },
      body: JSON.stringify({
        stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
        maxResults: 100,
      }),
    });
    const data = await res.json();
    const campaigns = data?.campaigns || [];
    const found = campaigns.find(c => 
      c.name?.includes(asin) || 
      c.name === campaignName ||
      (c.name?.includes('AUTO') && c.name?.includes(asin))
    );
    return found ? String(found.campaignId) : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, asin, sku, product_name } = body;
    if (!amazon_account_id || !asin) return Response.json({ error: 'amazon_account_id and asin required' }, { status: 400 });

    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id).catch(() => null);
    if (!account) return Response.json({ ok: false, error: 'AmazonAccount não encontrada' });
    
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    if (!refreshToken) return Response.json({ ok: false, error: 'Sem refresh_token. Conecte o Amazon Ads primeiro.' });
    
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!profileId) return Response.json({ ok: false, error: 'ads_profile_id não configurado' });

    // 1. Verificar campanha existente local
    const existingCampaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id, asin });
    const activeCampaign = existingCampaigns.find(c => c.archived !== true);
    if (activeCampaign) {
      return Response.json({ 
        ok: true, 
        campaign_id: activeCampaign.campaign_id,
        campaign_name: activeCampaign.campaign_name,
        daily_budget: activeCampaign.daily_budget,
        already_exists: true,
        message: 'Campanha já existe para este ASIN'
      });
    }

    // 2. Buscar regra de budget
    const budgetRules = await base44.asServiceRole.entities.BudgetRule.filter({ amazon_account_id });
    const budgetRule = budgetRules[0] || { total_daily_budget: 100, max_budget_per_campaign: 20, min_auto_campaign_bid: 0.30 };

    // 3. Calcular budget disponível
    const activeCampaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id });
    const currentTotalBudget = activeCampaigns
      .filter(c => c.state === 'enabled' && c.archived !== true)
      .reduce((sum, c) => sum + (c.daily_budget || 0), 0);
    const availableBudget = budgetRule.total_daily_budget - currentTotalBudget;
    const campaignBudget = Math.min(
      Math.max(availableBudget * 0.1, 5),
      budgetRule.max_budget_per_campaign || 20
    );

    if (availableBudget <= 0) {
      return Response.json({ ok: false, error: 'Budget geral esgotado. Aumente o total_daily_budget ou pause campanhas existentes.' });
    }

    const campaignName = `AUTO | ${asin} | ${new Date().toISOString().slice(0, 10)}`;
    const today = new Date().toISOString().slice(0, 10);
    const clientRequestToken = `kickoff:${asin}:${Date.now()}`;

    // 4. Verificar duplicata na Amazon antes de criar
    const token = await getAdsToken(refreshToken);
    const existingCampaignId = await reconcileCampaign(token, profileId, campaignName, asin);
    
    let campaignResult;
    let campaignId = existingCampaignId;
    
    if (!campaignId) {
      // Criar campanha na Amazon Ads API v3
      const campaignPayload = {
        campaigns: [{
          name: campaignName,
          targetingType: 'AUTO',
          state: 'ENABLED',
          budget: { budgetType: 'DAILY', budget: campaignBudget },
          startDate: today,
        }],
      };

      try {
        campaignResult = await adsRequestWithDetails('POST', '/sp/campaigns', campaignPayload, refreshToken, profileId, 'application/vnd.spCampaign.v3+json');
      } catch (e) {
        return Response.json({ ok: false, error: `Falha ao criar campanha: ${e.message}` });
      }

      // Extrair campaignId de forma tolerante
      const responseData = campaignResult.data;
      campaignId = extractCampaignId(responseData);

      // Reconciliação se não encontrou campaignId
      if (!campaignId && [200, 201, 207].includes(campaignResult.status)) {
        campaignId = await reconcileCampaign(token, profileId, campaignName, asin);
      }

      if (!campaignId) {
        const errorDetail = extractCampaignError(responseData);
        return Response.json({ 
          ok: false, 
          error: 'Amazon Ads não retornou campaignId',
          http_status: campaignResult.status,
          request_id: campaignResult.headers.requestId,
          amazon_error: errorDetail ? (errorDetail.code || errorDetail.description || JSON.stringify(errorDetail)) : null,
          response_sample: JSON.stringify(responseData).slice(0, 500),
        });
      }
    } else {
      // Campanha já existe na Amazon
      campaignResult = { status: 200, data: { campaignId }, headers: { requestId: '' } };
    }

    // 7. Criar Ad Group
    let adGroupId = '';
    try {
      const adGroupPayload = {
        adGroups: [{
          name: `AdGroup | ${asin}`,
          campaignId,
          defaultBid: budgetRule.min_auto_campaign_bid || 0.30,
          state: 'ENABLED',
        }],
      };
      const adGroupResult = await adsRequestWithDetails('POST', '/sp/adGroups', adGroupPayload, refreshToken, profileId, 'application/vnd.spAdGroup.v3+json');
      adGroupId = String(adGroupResult.data?.adGroups?.success?.[0]?.adGroupId || adGroupResult.data?.success?.[0]?.adGroupId || '');
    } catch (e) {
      console.warn('AdGroup creation failed:', e.message);
    }

    // 8. Criar Product Ad — com confirmação do adId
    let productAdId = '';
    if (adGroupId) {
      try {
        const adPayload = {
          productAds: [{
            campaignId,
            adGroupId,
            asin,
            sku: sku || undefined,
            state: 'ENABLED',
          }],
        };
        const adResult = await adsRequestWithDetails('POST', '/sp/productAds', adPayload, refreshToken, profileId, 'application/vnd.spProductAd.v3+json');
        // Extrair adId de forma tolerante
        productAdId = String(
          adResult.data?.productAds?.success?.[0]?.adId || 
          adResult.data?.success?.[0]?.adId || 
          adResult.data?.adId || 
          ''
        );
        if (!productAdId && [200, 201, 207].includes(adResult.status)) {
          console.warn(`ProductAd criado mas adId não extraído. Status: ${adResult.status}`);
        }
      } catch (e) {
        console.error('ProductAd creation failed:', e.message);
      }
    }

    const now = new Date().toISOString();

    // 9. Salvar no banco local
    const savedCampaign = await base44.asServiceRole.entities.Campaign.create({
      amazon_account_id,
      campaign_id: campaignId,
      asin,
      name: campaignName,
      campaign_name: campaignName,
      campaign_type: 'SP',
      targeting_type: 'AUTO',
      state: 'enabled',
      status: 'enabled',
      daily_budget: campaignBudget,
      start_date: today,
      created_by_app: true,
      launch_phase: 'new',
      days_running: 0,
      created_at: now,
      synced_at: now,
      last_sync_at: now,
    });

    if (adGroupId) {
      await base44.asServiceRole.entities.AdGroup.create({
        amazon_account_id,
        campaign_id: campaignId,
        ad_group_id: adGroupId,
        ad_group_name: `AdGroup | ${asin}`,
        name: `AdGroup | ${asin}`,
        default_bid: budgetRule.min_auto_campaign_bid || 0.30,
        state: 'enabled',
        status: 'enabled',
        synced_at: now,
      });
    }

    // Salvar productAdId se confirmado
    if (productAdId) {
      await base44.asServiceRole.entities.ProductAd.create({
        amazon_account_id,
        campaign_id: campaignId,
        ad_group_id: adGroupId,
        ad_id: productAdId,
        asin,
        sku: sku || null,
        state: 'enabled',
        status: 'enabled',
        synced_at: now,
      }).catch(() => {});
    }

    // 10. Atualizar produto
    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id, asin });
    if (products.length > 0) {
      await base44.asServiceRole.entities.Product.update(products[0].id, {
        has_campaign: true,
        campaign_status: 'active',
        linked_campaign_id: campaignId,
        auto_campaign_created_at: now,
      });
    }

    // 11. Log
    await base44.asServiceRole.entities.LearningEvent.create({
      amazon_account_id,
      event_type: 'campaign_created',
      entity_type: 'campaign',
      entity_id: campaignId,
      observation: `Campanha AUTO criada para ASIN ${asin}: "${campaignName}" — Budget: $${campaignBudget}/dia`,
      recorded_at: now,
    });

    return Response.json({
      ok: true,
      campaign_id: campaignId,
      ad_group_id: adGroupId,
      product_ad_id: productAdId || null,
      campaign_name: campaignName,
      daily_budget: campaignBudget,
      initial_bid: budgetRule.min_auto_campaign_bid || 0.30,
      http_status: campaignResult.status,
      request_id: campaignResult.headers.requestId,
      ad_confirmed: !!adGroupId,
      product_ad_confirmed: !!productAdId,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});