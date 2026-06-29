/**
 * createAutoCampaignForAsin — Cria campanha Sponsored Products AUTO para um ASIN.
 * Bid inicial: 0.25. Distribui budget do orçamento geral.
 * Verifica se já existe campanha para o ASIN antes de criar.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

async function getAdsToken() {
  const cached = tokenCache['ads'];
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: Deno.env.get('ADS_REFRESH_TOKEN'),
    client_id: Deno.env.get('ADS_CLIENT_ID'),
    client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token failed');
  tokenCache['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBaseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsRequest(method, path, body) {
  const token = await getAdsToken();
  const res = await fetch(`${getAdsBaseUrl()}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return await res.json();
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, asin, sku, product_name } = body;
    if (!amazon_account_id || !asin) return Response.json({ error: 'amazon_account_id and asin required' }, { status: 400 });

    // Verificar se já existe campanha ativa para este ASIN
    const existingCampaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id, asin });
    const activeCampaign = existingCampaigns.find(c => c.state !== 'archived');
    if (activeCampaign) {
      return Response.json({ ok: false, error: `Já existe campanha ativa para ASIN ${asin}`, existing_campaign_id: activeCampaign.campaign_id });
    }

    // Buscar regra de budget
    const budgetRules = await base44.asServiceRole.entities.BudgetRule.filter({ amazon_account_id });
    const budgetRule = budgetRules[0] || { total_daily_budget: 100, max_budget_per_campaign: 20, min_auto_campaign_bid: 0.25 };

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

    // Criar campanha na Amazon Ads API
    const campaignPayload = [{
      name: campaignName,
      campaignType: 'sponsoredProducts',
      targetingType: 'auto',
      state: 'enabled',
      dailyBudget: campaignBudget,
      startDate: today.replace(/-/g, ''),
    }];

    const campaignResult = await adsRequest('POST', '/v2/sp/campaigns', campaignPayload);
    const createdCampaign = Array.isArray(campaignResult) ? campaignResult[0] : campaignResult;

    if (!createdCampaign?.campaignId) {
      return Response.json({ ok: false, error: 'Amazon Ads API não retornou campaignId', details: createdCampaign });
    }

    const campaignId = String(createdCampaign.campaignId);

    // Criar Ad Group
    const adGroupPayload = [{
      name: `AdGroup | ${asin}`,
      campaignId: Number(campaignId),
      defaultBid: budgetRule.min_auto_campaign_bid || 0.25,
      state: 'enabled',
    }];
    const adGroupResult = await adsRequest('POST', '/v2/sp/adGroups', adGroupPayload);
    const createdAdGroup = Array.isArray(adGroupResult) ? adGroupResult[0] : adGroupResult;
    const adGroupId = String(createdAdGroup?.adGroupId || '');

    // Criar Product Ad
    if (adGroupId) {
      const adPayload = [{
        campaignId: Number(campaignId),
        adGroupId: Number(adGroupId),
        asin,
        sku: sku || null,
        state: 'enabled',
      }];
      await adsRequest('POST', '/v2/sp/productAds', adPayload);
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
        default_bid: budgetRule.min_auto_campaign_bid || 0.25,
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
      observation: `Campanha AUTO criada para ASIN ${asin}: "${campaignName}" — Budget: $${campaignBudget}/dia, Bid inicial: $${budgetRule.min_auto_campaign_bid || 0.25}`,
      recorded_at: now,
    });

    return Response.json({
      ok: true,
      campaign_id: campaignId,
      ad_group_id: adGroupId,
      campaign_name: campaignName,
      daily_budget: campaignBudget,
      initial_bid: budgetRule.min_auto_campaign_bid || 0.25,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});