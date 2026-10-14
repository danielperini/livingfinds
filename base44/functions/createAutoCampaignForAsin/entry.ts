/**
 * createAutoCampaignForAsin — Cria campanha Sponsored Products AUTO para um ASIN.
 * Com reconciliação, idempotência, tratamento de HTTP 207 e parser tolerante.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { proportionalActivationBid } from '../../shared/activationBidPolicy.ts';
import { hasFreshAdsInventory, availableAdsStock } from '../../shared/stockAdsPolicy.ts';
import { campaignCoverageEligible } from '../../shared/campaignCoverageEligibility.ts';

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

async function reconcileCampaign(token, profileId, campaignName) {
  try {
    let nextToken = undefined;
    for (let page = 0; page < 20; page++) {
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
          ...(nextToken ? { nextToken } : {}),
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const campaigns = data?.campaigns || [];
      // A name match must include the seller SKU; ASIN alone can identify
      // multiple distinct seller offers and would reactivate the wrong one.
      const found = campaigns.find(c => String(c.state || '').toUpperCase() !== 'ARCHIVED'
        && String(c.name || '') === campaignName);
      if (found?.campaignId) return String(found.campaignId);
      nextToken = data?.nextToken;
      if (!nextToken) break;
    }
    return null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (body._service_role !== true) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { amazon_account_id, asin, sku, product_name } = body;
    if (!amazon_account_id || !asin) return Response.json({ error: 'amazon_account_id and asin required' }, { status: 400 });

    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazon_account_id).catch(() => null);
    if (!account) return Response.json({ ok: false, error: 'AmazonAccount não encontrada' });

    const productRows = await base44.asServiceRole.entities.Product.filter({
      amazon_account_id, asin: String(asin).toUpperCase(), ...(sku ? { sku } : {}),
    }, '-updated_date', 100).catch(() => []);
    const productMatches = productRows.filter((product: any) => product.status !== 'archived' && product.catalog_sync_status !== 'duplicate');
    const product = productMatches.length === 1 ? productMatches[0] : null;
    if (!product || !hasFreshAdsInventory(product) || availableAdsStock(product) <= 0 || !campaignCoverageEligible(product)) {
      return Response.json({ ok: false, blocked: true, error: 'AUTO exige um único SKU/ASIN, oferta elegível e saldo FBA vendável atualizado.' }, { status: 409 });
    }
    
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    if (!refreshToken) return Response.json({ ok: false, error: 'Sem refresh_token. Conecte o Amazon Ads primeiro.' });
    
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!profileId) return Response.json({ ok: false, error: 'ads_profile_id não configurado' });

    const [performanceRows, earlyAutopilotRows, economicRows, assessmentRows] = await Promise.all([
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id }, '-updated_at', 1).catch(() => []),
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id }, '-updated_at', 1).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id, asin, sku: product?.sku }, '-updated_at', 20).catch(() => []),
      base44.asServiceRole.entities.DailyProductAdsAssessment.filter({ amazon_account_id, asin, sku: product?.sku }, '-assessment_date', 20).catch(() => []),
    ]);
    const goalSettings = { ...(earlyAutopilotRows[0] || {}), ...(performanceRows[0] || {}) };
    const economics = economicRows.find((row: any) => String(row.sku || '').trim().toUpperCase() === String(product.sku).trim().toUpperCase()) || {};
    const assessment = assessmentRows.find((row: any) => String(row.sku || '').trim().toUpperCase() === String(product.sku).trim().toUpperCase()) || {};
    const costsConfirmed = product.cost_confirmed === true || economics.costs_confirmed_by_user === true;
    const contribution = Number(economics.contribution_margin_amount ?? product.contribution_margin ?? product.available_profit_per_sale ?? 0);
    const safeCpc = Number(assessment.safe_max_cpc || economics.safe_max_cpc || 0);
    if (!costsConfirmed || contribution <= 0 || safeCpc <= 0) {
      return Response.json({
        ok: false, blocked: true, reason: 'verified_positive_economics_required',
        error: 'Kick-off AUTO bloqueado: custo confirmado, margem positiva e CPC econômico precisam estar disponíveis.',
        asin, sku: product.sku, costs_confirmed: costsConfirmed, contribution_margin: contribution,
        safe_max_cpc: safeCpc,
      }, { status: 409 });
    }
    if (safeCpc < 0.50) {
      return Response.json({
        ok: false, blocked: true, reason: 'economic_cpc_below_minimum_discovery_bid',
        error: 'Kick-off AUTO bloqueado: o limite econômico seguro por clique é inferior ao lance mínimo de R$ 0,50.',
        asin, sku: product.sku, safe_max_cpc: safeCpc, minimum_discovery_bid: 0.50,
      }, { status: 409 });
    }
    const siblingProducts = await base44.asServiceRole.entities.Product.filter({ amazon_account_id, asin: String(asin).toUpperCase() }, '-updated_date', 100).catch(() => []);
    const distinctAsinSkus = new Set(siblingProducts.filter((row: any) => row.status !== 'archived').map((row: any) => String(row.sku || '').trim().toUpperCase()).filter(Boolean));
    // AUTO e a camada de descoberta do funil. Ela sempre nasce no piso
    // configurado e so e elevada posteriormente pelo motor, quando houver
    // entrega e evidencia economica. Assim uma criacao/reconciliacao nunca
    // introduz um CPC alto por conta propria.
    const requestedDiscoveryBid = 0.50;
    const launchAtMinimum = body.launch_at_minimum !== false;
    const initialBid = Math.round(Math.min(
      safeCpc,
      launchAtMinimum ? requestedDiscoveryBid : proportionalActivationBid(goalSettings, economics, assessment),
    ) * 100) / 100;

    const existingCampaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id, asin });
    const productAds = await base44.asServiceRole.entities.ProductAd.filter({ amazon_account_id }, '-synced_at', 5000).catch(() => []);
    const productAdSkusByCampaign = new Map<string, Set<string>>();
    for (const ad of productAds) {
      const campaignId = String(ad.campaign_id || '');
      const adSku = String(ad.sku || '').trim().toUpperCase();
      if (!campaignId || !adSku) continue;
      const values = productAdSkusByCampaign.get(campaignId) || new Set<string>();
      values.add(adSku);
      productAdSkusByCampaign.set(campaignId, values);
    }
    const autoCampaign = existingCampaigns.find((c: any) => {
      const targeting = String(c.targeting_type || '').toUpperCase();
      const name = String(c.name || c.campaign_name || '').toUpperCase();
      const state = String(c.state || c.status || '').toUpperCase();
      const campaignId = String(c.amazon_campaign_id || c.campaign_id || '');
      const linkedSkus = productAdSkusByCampaign.get(campaignId) || new Set<string>();
      const productSku = String(product.sku).trim().toUpperCase();
      const identityMatches = linkedSkus.size === 1 && linkedSkus.has(productSku)
        || linkedSkus.size === 0 && String(c.sku || '').trim().toUpperCase() === productSku
        || linkedSkus.size === 0 && !c.sku && distinctAsinSkus.size === 1;
      return identityMatches && c.archived !== true && state !== 'ARCHIVED'
        && !name.includes('MANUAL') && (name.includes('AUTO') || (targeting === 'AUTO' && !name.includes('EXACT')));
    });
    if (autoCampaign) {
      // O estado confirmado pela sincronização atual tem precedência. Um
      // amazon_status legado nunca pode bloquear a cobertura AUTO do SKU.
      const state = String(autoCampaign.state || autoCampaign.status || autoCampaign.amazon_status || '').toUpperCase();
      const effectiveCampaignId = autoCampaign.campaign_id || autoCampaign.amazon_campaign_id;
      if (!effectiveCampaignId) return Response.json({ ok: false, error: 'Campanha AUTO local sem ID Amazon' });
      const paused = ['PAUSED', 'PAUSED_BY_ADVERTISER'].includes(state);
      if (paused) {
        // Stock recovery and an explicit one-shot manual kickoff are the only
        // reactivation owners. Do not silently undo a manual/business pause.
        return Response.json({
          ok: true, campaign_id: String(effectiveCampaignId), already_exists: true,
          reactivated: false, action_label: 'existing_paused_preserved',
          reason: 'awaiting_stock_guard_or_explicit_manual_kickoff_confirmation',
        });
      }
      // Nao redefinir o lance de uma AUTO existente. O mesmo endpoint e
      // chamado a cada ciclo de cobertura; rebaixar o Ad Group ao piso aqui
      // apagaria a evolucao gradual feita por bid/dayparting e esconderia o
      // efeito das decisoes economicas anteriores.
      await base44.asServiceRole.entities.Product.update(product.id, {
        has_campaign: true, campaign_status: 'active', linked_campaign_id: effectiveCampaignId,
      }).catch(() => {});
      return Response.json({
        ok: true,
        campaign_id: effectiveCampaignId,
        campaign_name: autoCampaign.name || autoCampaign.campaign_name,
        daily_budget: autoCampaign.daily_budget,
        already_exists: true,
        reactivated: false,
        action_label: 'existing_enabled',
        launch_bid_policy: launchAtMinimum ? 'configured_minimum' : 'proportional_override',
        proportional_bid: initialBid,
      });
    }

    // Usar AutopilotConfig como fonte principal de budget (mais atualizado que BudgetRule)
    const autopilotConfigs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id });
    const autopilotConfig = autopilotConfigs[0] || null;

    // The account-wide cap is enforced against actual spend by the spend
    // controller. Per-campaign budgets are independent limits/references and
    // must not be summed or divided across products here.
    const budgetRules = await base44.asServiceRole.entities.BudgetRule.filter({ amazon_account_id });
    const budgetRule = budgetRules[0] || {};
    const maxPerCampaign = autopilotConfig?.maximum_campaign_budget || budgetRule.max_budget_per_campaign || 20;
    const configuredInitialBudget = Number(autopilotConfig?.minimum_campaign_budget
      || budgetRule.minimum_campaign_budget || 5);
    const campaignBudget = Math.max(5, Math.min(Number(maxPerCampaign), configuredInitialBudget));

    const skuToken = String(product.sku).trim().replace(/[^a-z0-9-]/gi, '').slice(0, 24);
    const campaignName = `AUTO | ${asin} | ${skuToken} | ${new Date().toISOString().slice(0, 10)}`;
    const today = new Date().toISOString().slice(0, 10);

    const token = await getAdsToken(refreshToken);
    const existingCampaignId = await reconcileCampaign(token, profileId, campaignName);
    
    let campaignResult;
    let campaignId = existingCampaignId;

    // Reconcile encontra campanhas que existem na Amazon mesmo quando o banco
    // local perdeu o vinculo. Nesse caminho tambem precisamos reativar a
    // campanha; antes ela era apenas importada localmente e permanecia PAUSED.
    if (campaignId) {
      const enabled = await adsRequestWithDetails(
        'PUT', '/sp/campaigns',
        { campaigns: [{ campaignId: String(campaignId), state: 'ENABLED' }] },
        refreshToken, String(profileId), 'application/vnd.spCampaign.v3+json'
      );
      const enabledError = extractCampaignError(enabled.data);
      if (![200, 201, 207].includes(enabled.status) || enabledError) {
        return Response.json({
          ok: false,
          error: `Falha ao reativar AUTO reconciliada ${campaignId}`,
          http_status: enabled.status,
          amazon_error: enabledError,
          request_id: enabled.headers?.requestId || '',
        });
      }
    }
    
    if (!campaignId) {
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

      const responseData = campaignResult.data;
      campaignId = extractCampaignId(responseData);

      if (!campaignId && [200, 201, 207].includes(campaignResult.status)) {
        for (let attempt = 0; attempt < 4 && !campaignId; attempt++) {
          if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 750 * attempt));
          campaignId = await reconcileCampaign(token, profileId, campaignName);
        }
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
      campaignResult = { status: 200, data: { campaignId }, headers: { requestId: '' } };
    }

    let adGroupId = '';
    try {
      const adGroupPayload = {
        adGroups: [{
          name: `AdGroup | ${asin} | ${skuToken}`,
          campaignId,
          defaultBid: initialBid,
          state: 'ENABLED',
        }],
      };
      const adGroupResult = await adsRequestWithDetails('POST', '/sp/adGroups', adGroupPayload, refreshToken, profileId, 'application/vnd.spAdGroup.v3+json');
      adGroupId = String(adGroupResult.data?.adGroups?.success?.[0]?.adGroupId || adGroupResult.data?.success?.[0]?.adGroupId || '');
    } catch (e) {
      console.warn('AdGroup creation failed:', e.message);
    }

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

    const existingLocal = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id, campaign_id: campaignId });
    const campaignRecord = {
      amazon_account_id,
      campaign_id: campaignId,
      asin,
      sku: product.sku,
      sku_identity_status: productAdId ? 'verified_product_ad' : 'unknown',
      name: campaignName,
      campaign_name: campaignName,
      campaign_type: 'SP',
      targeting_type: 'AUTO',
      state: productAdId ? 'enabled' : 'incomplete',
      status: productAdId ? 'enabled' : 'incomplete',
      amazon_status: productAdId ? 'enabled' : 'incomplete',
      is_operational: Boolean(productAdId),
      completion_status: productAdId ? 'complete' : 'product_ad_confirmation_pending',
      archived: false,
      daily_budget: campaignBudget,
      start_date: today,
      created_by_app: true,
      launch_phase: 'new',
      days_running: 0,
      created_at: now,
      synced_at: now,
      last_sync_at: now,
      currency_code: account.currency_code || 'BRL',
      marketplace_id: account.marketplace_id || 'A2Q3Y263D00KWC',
      profile_id: String(profileId),
    };
    const savedCampaign = existingLocal.length > 0
      ? await base44.asServiceRole.entities.Campaign.update(existingLocal[0].id, campaignRecord)
      : await base44.asServiceRole.entities.Campaign.create(campaignRecord);

    if (adGroupId) {
      await base44.asServiceRole.entities.AdGroup.create({
        amazon_account_id,
        campaign_id: campaignId,
        ad_group_id: adGroupId,
        ad_group_name: `AdGroup | ${asin} | ${skuToken}`,
        name: `AdGroup | ${asin} | ${skuToken}`,
        default_bid: initialBid,
        state: 'enabled',
        status: 'enabled',
        synced_at: now,
      });
    }

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

    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id, asin, sku: product.sku }, '-updated_date', 10);
    if (products.length > 0) {
      await base44.asServiceRole.entities.Product.update(products[0].id, {
        has_campaign: true,
        campaign_status: 'active',
        linked_campaign_id: campaignId,
        auto_campaign_created_at: now,
      });
    }

    await base44.asServiceRole.entities.LearningEvent.create({
      amazon_account_id,
      event_type: 'campaign_created',
      entity_type: 'campaign',
      entity_id: campaignId,
      observation: `Campanha AUTO vinculada para ASIN ${asin}: "${campaignName}" — Budget: R$ ${campaignBudget.toFixed(2).replace('.', ',')}/dia`,
      recorded_at: now,
    });

    return Response.json({
      ok: true,
      campaign_id: campaignId,
      ad_group_id: adGroupId,
      product_ad_id: productAdId || null,
      campaign_name: campaignName,
      daily_budget: campaignBudget,
      initial_bid: initialBid,
      http_status: campaignResult.status,
      request_id: campaignResult.headers.requestId,
      ad_confirmed: !!adGroupId,
      product_ad_confirmed: !!productAdId,
      already_exists: !!existingCampaignId,
      currency_code: account.currency_code || 'BRL',
      action_label: existingCampaignId ? 'reactivated' : 'created',
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});
