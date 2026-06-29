/**
 * createAutoCampaignForAsin — Cria campanha Sponsored Products AUTO para um ASIN.
 * Bid inicial: 0.25. Distribui budget do orçamento geral.
 * Verifica se já existe campanha para o ASIN antes de criar.
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

async function adsRequest(method, path, body, refreshToken, profileId, contentType = 'application/json') {
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
  if (!res.ok) throw new Error(`Amazon Ads API ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, asin, sku, product_name } = body;
    if (!amazon_account_id || !asin) return Response.json({ error: 'amazon_account_id and asin required' }, { status: 400 });

    // Resolver conta e credenciais
    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id).catch(() => null);
    if (!account) return Response.json({ ok: false, error: 'AmazonAccount não encontrada' });
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    if (!refreshToken) return Response.json({ ok: false, error: 'Sem refresh_token. Conecte o Amazon Ads primeiro.' });
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!profileId) return Response.json({ ok: false, error: 'ads_profile_id não configurado' });

    // Verificar se já existe campanha ativa para este ASIN
    const existingCampaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id, asin });
    const activeCampaign = existingCampaigns.find(c => c.state !== 'archived');
    if (activeCampaign) {
      return Response.json({ ok: false, error: `Já existe campanha ativa para ASIN ${asin}`, existing_campaign_id: activeCampaign.campaign_id });
    }

    // Buscar regra de budget
    const budgetRules = await base44.asServiceRole.entities.BudgetRule.filter({ amazon_account_id });
    const budgetRule = budgetRules[0] || { total_daily_budget: 100, max_budget_per_campaign: 20, min_auto_campaign_bid: 0.30 };

    // Calcular budget disponível para nova campanha
    const activeCampaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id });
    const currentTotalBudget = activeCampaigns
      .filter(c => c.state === 'enabled')
      .reduce((sum, c) => sum + (c.daily_budget || 0), 0);
    const availableBudget = budgetRule.total_daily_budget - currentTotalBudget;
    const campaignBudget = Math.min(
      Math.max(availableBudget * 0.1, 5),
      budgetRule.max_budget_per_campaign || 20
    );

    if (availableBudget <= 0) {
      return Response.json({ ok: false, error: 'Budget geral esgotado. Aumente o total_daily_budget ou pause campanhas existentes.' });
    }

    const campaignName = `AUTO | ${asin} | ${product_name ? product_name.slice(0, 30) : 'Produto'} | ${new Date().toISOString().slice(0, 10)}`;
    const today = new Date().toISOString().slice(0, 10);

    // Criar campanha na Amazon Ads API (v3)
    const campaignPayload = {
      campaigns: [{
        name: campaignName,
        targetingType: 'AUTO',
        state: 'ENABLED',
        budget: { budgetType: 'DAILY', budget: campaignBudget },
        startDate: today,
      }],
    };

    let campaignResult;
    try {
      campaignResult = await adsRequest('POST', '/sp/campaigns', campaignPayload, refreshToken, profileId, 'application/vnd.spCampaign.v3+json');
    } catch (e) {
      return Response.json({ ok: false, error: `Falha ao criar campanha: ${e.message}` });
    }

    const createdCampaign = campaignResult?.campaigns?.success?.[0] || campaignResult?.success?.[0] || (Array.isArray(campaignResult) ? campaignResult[0] : null);
    if (!createdCampaign?.campaignId) {
      return Response.json({ ok: false, error: 'Amazon Ads não retornou campaignId', details: campaignResult });
    }

    const campaignId = String(createdCampaign.campaignId);

    // Criar Ad Group
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
      const adGroupResult = await adsRequest('POST', '/sp/adGroups', adGroupPayload, refreshToken, profileId, 'application/vnd.spAdGroup.v3+json');
      adGroupId = String(adGroupResult?.adGroups?.success?.[0]?.adGroupId || adGroupResult?.success?.[0]?.adGroupId || '');
    } catch (e) {
      console.warn('AdGroup creation failed:', e.message);
    }

    // Criar Product Ad
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
        await adsRequest('POST', '/sp/productAds', adPayload, refreshToken, profileId, 'application/vnd.spProductAd.v3+json');
      } catch (e) {
        console.warn('ProductAd creation failed:', e.message);
      }
    }

    const now = new Date().toISOString();

    // Salvar no banco local
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

    // Atualizar produto
    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id, asin });
    if (products.length > 0) {
      await base44.asServiceRole.entities.Product.update(products[0].id, {
        has_campaign: true,
        campaign_status: 'active',
        linked_campaign_id: campaignId,
        auto_campaign_created_at: now,
      });
    }

    // Log
    await base44.asServiceRole.entities.LearningEvent.create({
      amazon_account_id,
      event_type: 'campaign_created',
      entity_type: 'campaign',
      entity_id: campaignId,
      observation: `Campanha AUTO criada para ASIN ${asin}: "${campaignName}" — Budget: $${campaignBudget}/dia, Bid inicial: $${budgetRule.min_auto_campaign_bid || 0.30}`,
      recorded_at: now,
    });

    return Response.json({
      ok: true,
      campaign_id: campaignId,
      ad_group_id: adGroupId,
      campaign_name: campaignName,
      daily_budget: campaignBudget,
      initial_bid: budgetRule.min_auto_campaign_bid || 0.30,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});