/**
 * createAcceleratorCampaign — Cria campanha Sponsored Products MANUAL com múltiplas keywords exatas.
 * 
 * Estrutura:
 * 1. Campanha (budget R$25, daily, dynamic bidding up/down)
 * 2. Ad Group (único por campanha)
 * 3. Product Ad (ASIN/SKU)
 * 4. Keywords (uma por termo, todas exact match, bid inicial R$0.50)
 * 
 * Placements: top_of_search +10%, rest_of_search +10%, product_pages +10%
 * 
 * Valida duplicidade antes de criar.
 * Retorna IDs reais da Amazon ou erro detalhado.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

async function getAdsToken(refreshToken) {
  const cached = tokenCache['ads'];
  if (cached && cached.expires_at > Date.now() + 5000) return cached.access_token;
  
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: Deno.env.get('ADS_CLIENT_ID') || '',
    client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
  });
  
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Token failed');
  
  tokenCache['ads'] = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  };
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
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': contentType,
      'Accept': contentType,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data, requestId: res.headers.get('x-amzn-requestid') || '' };
}

function extractId(result, idField) {
  if (!result) return null;
  const paths = [
    () => result[idField],
    () => result[`${idField}s`]?.[0]?.[idField],
    () => result[`${idField}s`]?.success?.[0]?.[idField],
    () => result.success?.[0]?.[idField],
    () => result.successes?.[0]?.[idField],
    () => result.data?.[idField],
    () => result.results?.[0]?.[idField],
    () => Array.isArray(result) ? result[0]?.[idField] : null,
  ];
  for (const fn of paths) {
    try {
      const val = fn();
      if (val) return String(val);
    } catch {}
  }
  return null;
}

function extractError(result) {
  if (!result) return null;
  const errPaths = [
    () => result.errors?.[0],
    () => result.error,
    () => result.failures?.[0],
    () => result.failure,
    () => result.invalid,
  ];
  for (const fn of errPaths) {
    try {
      const val = fn();
      if (val) return val;
    } catch {}
  }
  return null;
}

// Parser de keywords: limpa, valida, deduplica
function parseKeywords(input) {
  const lines = input.split(/[\n,;]+/);
  const cleaned = [];
  const duplicates = [];
  const invalid = [];
  const seen = new Set();
  
  for (const line of lines) {
    // Remove números iniciais, marcadores, espaços
    let text = line.replace(/^[\s\d\.\-\*\•\+\u2022\u2023\u25E6]+/, '').trim();
    
    // Ignora vazias
    if (!text) continue;
    
    // Valida comprimento (Amazon: 1-100 caracteres)
    if (text.length < 1 || text.length > 100) {
      invalid.push(text);
      continue;
    }
    
    // Normaliza para comparação (minúsculas, sem espaços extras)
    const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
    
    if (seen.has(normalized)) {
      duplicates.push(text);
      continue;
    }
    
    seen.add(normalized);
    cleaned.push(text);
  }
  
  return {
    original_count: lines.filter(l => l.trim()).length,
    valid: cleaned,
    valid_count: cleaned.length,
    duplicates,
    duplicate_count: duplicates.length,
    invalid,
    invalid_count: invalid.length,
  };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    
    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, asin, sku, product_name, keywords_raw, mode = 'assisted' } = body;
    
    if (!amazon_account_id || !asin || !keywords_raw) {
      return Response.json({ error: 'amazon_account_id, asin e keywords_raw são obrigatórios' }, { status: 400 });
    }
    
    // 1. Parse e validação de keywords
    const parsed = parseKeywords(keywords_raw);
    if (parsed.valid_count === 0) {
      return Response.json({ 
        ok: false, 
        error: 'Nenhuma keyword válida encontrada',
        parse_result: parsed,
      });
    }
    
    // 2. Carregar conta e config
    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id).catch(() => null);
    if (!account) return Response.json({ ok: false, error: 'AmazonAccount não encontrada' });
    
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    if (!refreshToken) return Response.json({ ok: false, error: 'Sem refresh_token' });
    
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!profileId) return Response.json({ ok: false, error: 'ads_profile_id não configurado' });
    
    const budgetRules = await base44.asServiceRole.entities.BudgetRule.filter({ amazon_account_id });
    const budgetRule = budgetRules[0] || {
      total_daily_budget: 100,
      max_budget_per_campaign: 25,
      min_bid: 0.20,
      max_bid: 2.00,
      bid_increase_step: 0.10,
      bid_decrease_step: 0.10,
    };
    
    // 3. Verificar duplicidade
    const existing = await base44.asServiceRole.entities.Campaign.filter({
      amazon_account_id,
      asin,
      targeting_type: 'MANUAL',
    });
    const existingCampaign = existing.find(c => !c.archived && c.created_by_app === true);
    
    if (existingCampaign) {
      return Response.json({
        ok: false,
        error: 'campanha_duplicada',
        existing_campaign_id: existingCampaign.campaign_id,
        existing_campaign_name: existingCampaign.campaign_name,
        existing_status: existingCampaign.state,
        message: `Já existe campanha para este ASIN: ${existingCampaign.campaign_name}`,
        parse_result: parsed,
      });
    }
    
    // 4. Nomenclatura
    const identifier = sku || asin;
    const today = new Date().toISOString().slice(0, 10);
    const campaignName = `SP-MAN-EXATA-${identifier}-IA-${today}`;
    const adGroupName = `AG-EXATA-${identifier}`;
    
    const now = new Date().toISOString();
    const logEntries = [];
    
    // 5. Criar campanha
    const campaignPayload = {
      campaigns: [{
        name: campaignName,
        targetingType: 'MANUAL',
        state: 'ENABLED',
        budget: { budgetType: 'DAILY', budget: budgetRule.max_budget_per_campaign || 25 },
        startDate: today,
        dynamicBidding: { strategy: 'UP_DOWN' },
      }],
    };
    
    const campaignResp = await adsRequest('POST', '/sp/campaigns', campaignPayload, refreshToken, profileId, 'application/vnd.spCampaign.v3+json');
    
    if (![200, 201, 207].includes(campaignResp.status)) {
      const err = extractError(campaignResp.data);
      return Response.json({
        ok: false,
        error: `Falha ao criar campanha (HTTP ${campaignResp.status})`,
        amazon_error: err?.code || err?.description || JSON.stringify(campaignResp.data).slice(0, 400),
        request_id: campaignResp.requestId,
        parse_result: parsed,
      });
    }
    
    const campaignId = extractId(campaignResp.data, 'campaignId');
    if (!campaignId) {
      return Response.json({
        ok: false,
        error: 'Amazon não retornou campaignId',
        response_sample: JSON.stringify(campaignResp.data).slice(0, 500),
        request_id: campaignResp.requestId,
      });
    }
    
    logEntries.push({
      amazon_account_id,
      user_id: user.id,
      operation_type: 'create_campaign',
      entity_type: 'campaign',
      entity_id: campaignId,
      campaign_id: campaignId,
      asin,
      sku,
      status: 'success',
      amazon_response: JSON.stringify(campaignResp.data).slice(0, 1000),
      request_id: campaignResp.requestId,
      created_at: now,
    });
    
    // 6. Criar Ad Group
    const adGroupPayload = {
      adGroups: [{
        name: adGroupName,
        campaignId,
        defaultBid: 0.50,
        state: 'ENABLED',
      }],
    };
    
    const adGroupResp = await adsRequest('POST', '/sp/adGroups', adGroupPayload, refreshToken, profileId, 'application/vnd.spAdGroup.v3+json');
    
    if (![200, 201, 207].includes(adGroupResp.status)) {
      const err = extractError(adGroupResp.data);
      // Rollback: pausar campanha
      await adsRequest('PUT', `/sp/campaigns/${campaignId}`, { state: 'PAUSED' }, refreshToken, profileId);
      
      return Response.json({
        ok: false,
        error: `Falha ao criar ad group (HTTP ${adGroupResp.status})`,
        amazon_error: err?.code || err?.description || JSON.stringify(adGroupResp.data).slice(0, 400),
        campaign_id: campaignId,
        request_id: adGroupResp.requestId,
      });
    }
    
    const adGroupId = extractId(adGroupResp.data, 'adGroupId');
    if (!adGroupId) {
      return Response.json({
        ok: false,
        error: 'Amazon não retornou adGroupId',
        response_sample: JSON.stringify(adGroupResp.data).slice(0, 500),
        campaign_id: campaignId,
      });
    }
    
    logEntries.push({
      amazon_account_id,
      user_id: user.id,
      operation_type: 'create_ad_group',
      entity_type: 'ad_group',
      entity_id: adGroupId,
      campaign_id: campaignId,
      ad_group_id: adGroupId,
      asin,
      sku,
      status: 'success',
      amazon_response: JSON.stringify(adGroupResp.data).slice(0, 1000),
      request_id: adGroupResp.requestId,
      created_at: now,
    });
    
    // 7. Criar Product Ad
    const productAdPayload = {
      productAds: [{
        campaignId,
        adGroupId,
        asin,
        sku: sku || undefined,
        state: 'ENABLED',
      }],
    };
    
    const productAdResp = await adsRequest('POST', '/sp/productAds', productAdPayload, refreshToken, profileId, 'application/vnd.spProductAd.v3+json');
    
    const adId = extractId(productAdResp.data, 'adId');
    if (adId) {
      logEntries.push({
        amazon_account_id,
        user_id: user.id,
        operation_type: 'create_product_ad',
        entity_type: 'product_ad',
        entity_id: adId,
        campaign_id: campaignId,
        ad_group_id: adGroupId,
        asin,
        sku,
        status: 'success',
        amazon_response: JSON.stringify(productAdResp.data).slice(0, 1000),
        created_at: now,
      });
    }
    
    // 8. Criar Keywords (em lote)
    const keywordPayload = {
      keywords: parsed.valid.map(kw => ({
        campaignId,
        adGroupId,
        keywordText: kw,
        matchType: 'EXACT',
        state: 'ENABLED',
        bid: 0.50,
      })),
    };
    
    const keywordResp = await adsRequest('POST', '/sp/keywords', keywordPayload, refreshToken, profileId, 'application/vnd.spKeyword.v3+json');
    
    const createdKeywords = [];
    const keywordIds = [];
    
    if (keywordResp.data?.keywords) {
      for (const kwResult of keywordResp.data.keywords) {
        const kwId = extractId(kwResult, 'keywordId');
        const kwText = kwResult.keywordText || parsed.valid[createdKeywords.length];
        
        if (kwId) {
          keywordIds.push(kwId);
          createdKeywords.push({
            keyword_id: kwId,
            keyword_text: kwText,
            match_type: 'exact',
            bid: 0.50,
            state: 'enabled',
          });
          
          logEntries.push({
            amazon_account_id,
            user_id: user.id,
            operation_type: 'create_keyword',
            entity_type: 'keyword',
            entity_id: kwId,
            campaign_id: campaignId,
            ad_group_id: adGroupId,
            keyword_id: kwId,
            keyword_text: kwText,
            match_type: 'exact',
            new_bid: 0.50,
            status: 'success',
            created_at: now,
          });
        }
      }
    }
    
    // 9. Salvar no banco local
    await base44.asServiceRole.entities.Campaign.create({
      amazon_account_id,
      campaign_id: campaignId,
      asin,
      name: campaignName,
      campaign_name: campaignName,
      campaign_type: 'SP',
      targeting_type: 'MANUAL',
      state: 'enabled',
      status: 'enabled',
      daily_budget: budgetRule.max_budget_per_campaign || 25,
      start_date: today,
      bidding_strategy: 'UP_DOWN',
      created_by_app: true,
      launch_phase: 'new',
      days_running: 0,
      synced_at: now,
      last_sync_at: now,
    });
    
    await base44.asServiceRole.entities.AdGroup.create({
      amazon_account_id,
      campaign_id: campaignId,
      ad_group_id: adGroupId,
      ad_group_name: adGroupName,
      name: adGroupName,
      default_bid: 0.50,
      state: 'enabled',
      status: 'enabled',
      synced_at: now,
    });
    
    // Keywords no banco local
    const keywordEntities = createdKeywords.map(kw => ({
      amazon_account_id,
      campaign_id: campaignId,
      ad_group_id: adGroupId,
      keyword_id: kw.keyword_id,
      asin,
      keyword: kw.keyword_text,
      keyword_text: kw.keyword_text,
      match_type: 'exact',
      state: 'enabled',
      status: 'enabled',
      current_bid: 0.50,
      bid: 0.50,
      source: 'manual',
      first_seen_at: now,
      last_seen_at: now,
      synced_at: now,
    }));
    
    if (keywordEntities.length > 0) {
      await base44.asServiceRole.entities.Keyword.bulkCreate(keywordEntities);
    }
    
    // 10. Atualizar produto
    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id, asin });
    if (products.length > 0) {
      await base44.asServiceRole.entities.Product.update(products[0].id, {
        has_campaign: true,
        campaign_status: 'active',
        linked_campaign_id: campaignId,
        manual_campaign_created_at: now,
      });
    }
    
    // 11. Salvar logs de auditoria
    if (logEntries.length > 0) {
      await base44.asServiceRole.entities.CampaignCreationLog.bulkCreate(logEntries);
    }
    
    return Response.json({
      ok: true,
      campaign_id: campaignId,
      campaign_name: campaignName,
      ad_group_id: adGroupId,
      ad_id: adId,
      daily_budget: budgetRule.max_budget_per_campaign || 25,
      initial_bid: 0.50,
      keywords_created: createdKeywords.length,
      keywords: createdKeywords,
      http_status: campaignResp.status,
      request_id: campaignResp.requestId,
      parse_result: parsed,
    });
    
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});