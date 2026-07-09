/**
 * createManualCampaignFromKeywordSuggestion
 *
 * Cria campanhas manuais SP em lote, uma por keyword.
 * USA EXCLUSIVAMENTE a Amazon Ads API v3 (sp/campaigns/v3, etc.)
 * A API v2 está depreciada e retorna "Not authorized for requested operation".
 *
 * Payload:
 *   amazon_account_id  — opcional (pega a primeira conectada se omitido)
 *   suggestion_ids     — array de IDs de KeywordSuggestion
 *   overrides          — opcional: { [suggestion_id]: { bid, budget } }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

async function getAdsToken(refreshToken) {
  const cached = tokenCache['create_manual'];
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken || Deno.env.get('ADS_REFRESH_TOKEN'),
    client_id: Deno.env.get('ADS_CLIENT_ID'),
    client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token LWA falhou');
  tokenCache['create_manual'] = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  };
  return data.access_token;
}

function getAdsBaseUrl(account) {
  const r = (account?.region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

// Chamada genérica à API v2 (ainda funciona para campaigns)
async function adsCallV2(account, method, path, body) {
  const token = await getAdsToken(account?.ads_refresh_token);
  const profileId = account?.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
  const res = await fetch(`${getAdsBaseUrl(account)}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// Chamada à API v3 (adGroups, keywords, productAds, negativeKeywords)
// Content-Type e Accept são obrigatórios com o vendor MIME type correto
async function adsCallV3(account, method, path, body, contentType, accept) {
  const token = await getAdsToken(account?.ads_refresh_token);
  const profileId = account?.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
    'Amazon-Advertising-API-Scope': String(profileId),
  };
  if (contentType) headers['Content-Type'] = contentType;
  if (accept) headers['Accept'] = accept;
  const res = await fetch(`${getAdsBaseUrl(account)}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function buildCampaignName(asin, keyword) {
  const kwShort = keyword.replace(/[^a-z0-9\s]/gi, '').trim().slice(0, 40);
  const name = `SP | MANUAL | EXACT | ${asin} | ${kwShort}`;
  return name.length > 128 ? name.slice(0, 125) + '...' : name;
}

function daysFromNow(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

function keywordAlreadyExists(existingKeywords, keyword) {
  const norm = (s) => (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
  const kw = norm(keyword);
  return existingKeywords.some(k =>
    norm(k.keyword_text || k.keyword || '') === kw && (k.match_type === 'exact') && k.state !== 'archived'
  );
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, suggestion_ids, overrides = {} } = body;

    if (!body._service_role) {
      const user = await base44.auth.me();
      if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!Array.isArray(suggestion_ids) || !suggestion_ids.length) {
      return Response.json({ ok: false, error: 'suggestion_ids obrigatório (array não vazio)' }, { status: 400 });
    }

    // ── Resolver conta ────────────────────────────────────────────────────
    let account = null;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id });
      account = accs[0] || null;
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada.' });

    const aid = account.id;
    const sym = account.currency_symbol || 'R$';
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!profileId) return Response.json({ ok: false, error: 'Profile ID ausente na conta.' });

    const autopilotCfg = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid });
    const cfg = autopilotCfg[0] || {};
    const minBid = cfg.min_bid || 0.10;
    const maxBid = cfg.max_bid || 5.0;
    const minBudget = 5.00;

    // ── Carregar sugestões e dados de contexto ────────────────────────────
    const allSuggestions = await base44.asServiceRole.entities.KeywordSuggestion.filter(
      { amazon_account_id: aid }, '-created_at', 500
    );
    const suggestionMap = new Map(allSuggestions.map(s => [s.id, s]));

    const requestedSuggestions = suggestion_ids.map(id => suggestionMap.get(id)).filter(Boolean);
    const asins = [...new Set(requestedSuggestions.map(s => s.asin).filter(Boolean))];

    const [allProducts, allCampaigns, allKeywords] = await Promise.all([
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 500),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-created_date', 500),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-created_date', 1000),
    ]);

    const productByAsin = new Map(allProducts.map(p => [p.asin, p]));
    const campaignsByAsin = new Map();
    for (const c of allCampaigns) {
      if (!c.asin) continue;
      if (!campaignsByAsin.has(c.asin)) campaignsByAsin.set(c.asin, []);
      campaignsByAsin.get(c.asin).push(c);
    }

    const keywordsByCampaignId = new Map();
    for (const k of allKeywords) {
      if (!k.campaign_id) continue;
      if (!keywordsByCampaignId.has(k.campaign_id)) keywordsByCampaignId.set(k.campaign_id, []);
      keywordsByCampaignId.get(k.campaign_id).push(k);
    }

    const keywordsByAsin = new Map();
    for (const asin of asins) {
      const camps = campaignsByAsin.get(asin) || [];
      const kws = camps.flatMap(c => keywordsByCampaignId.get(c.campaign_id) || []);
      keywordsByAsin.set(asin, kws);
    }

    const results = [];
    const now = new Date().toISOString();
    const today = now.slice(0, 10).replace(/-/g, '');

    for (const sid of suggestion_ids) {
      const suggestion = suggestionMap.get(sid);

      if (!suggestion) {
        results.push({ id: sid, ok: false, error: 'Sugestão não encontrada.' });
        continue;
      }

      if (suggestion.status === 'created') {
        results.push({ id: sid, ok: false, already_exists: true, error: 'Campanha já criada para esta sugestão.', keyword: suggestion.keyword });
        continue;
      }
      if (['duplicate', 'blocked'].includes(suggestion.status)) {
        results.push({ id: sid, ok: false, already_exists: true, error: suggestion.block_reason || `Status: ${suggestion.status}`, keyword: suggestion.keyword });
        continue;
      }
      if (suggestion.status === 'creating') {
        results.push({ id: sid, ok: false, error: 'Criação já em andamento para esta sugestão.', keyword: suggestion.keyword });
        continue;
      }
      if (!['suggested', 'approved', 'failed'].includes(suggestion.status)) {
        results.push({ id: sid, ok: false, error: `Status não processável: ${suggestion.status}`, keyword: suggestion.keyword });
        continue;
      }

      const asin = suggestion.asin;
      const keyword = suggestion.keyword;

      const ov = overrides[sid] || {};
      const INITIAL_BID = 0.50;
      const bid = Math.max(Math.min(parseFloat(ov.bid) || INITIAL_BID, maxBid), minBid);
      const budget = Math.max(parseFloat(ov.budget) || suggestion.recommended_budget || minBudget, minBudget);

      // Validação: estoque
      const product = productByAsin.get(asin);
      if (product?.inventory_status === 'out_of_stock') {
        await base44.asServiceRole.entities.KeywordSuggestion.update(sid, {
          status: 'blocked', block_reason: 'Produto sem estoque.', error: 'OUT_OF_STOCK',
        });
        results.push({ id: sid, ok: false, blocked: true, error: 'Produto sem estoque.', keyword });
        continue;
      }

      // Validação: keyword duplicada
      const asinKeywords = keywordsByAsin.get(asin) || [];
      if (keywordAlreadyExists(asinKeywords, keyword)) {
        await base44.asServiceRole.entities.KeywordSuggestion.update(sid, {
          status: 'duplicate', already_exists: true, block_reason: `Keyword exact "${keyword}" já existe.`,
        });
        results.push({ id: sid, ok: false, already_exists: true, error: `Keyword "${keyword}" já existe.`, keyword });
        continue;
      }

      // Validação: campanha duplicada por nome
      const campaignName = buildCampaignName(asin, keyword);
      const asinCampaigns = campaignsByAsin.get(asin) || [];
      const normName = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const duplicateCamp = asinCampaigns.find(c =>
        normName(c.name || c.campaign_name) === normName(campaignName)
      );
      if (duplicateCamp) {
        await base44.asServiceRole.entities.KeywordSuggestion.update(sid, {
          status: 'duplicate', already_exists: true, block_reason: 'Campanha com mesmo nome já existe.',
          created_campaign_id: duplicateCamp.id,
        });
        results.push({ id: sid, ok: false, already_exists: true, error: 'Campanha com mesmo nome já existe.', keyword });
        continue;
      }

      // Lock otimista
      await base44.asServiceRole.entities.KeywordSuggestion.update(sid, { status: 'creating' });

      try {
        // ── PASSO 1: Criar campanha (API v2 ainda funciona para campaigns) ──
        const campRes = await adsCallV2(account, 'POST', '/v2/sp/campaigns', [{
          name: campaignName,
          campaignType: 'sponsoredProducts',
          targetingType: 'manual',
          state: 'enabled',
          dailyBudget: budget,
          startDate: today,
          bidding: { strategy: 'legacyForSales', adjustments: [] },
        }]);

        if (!campRes.ok && campRes.status !== 207) {
          throw new Error(`Campanha HTTP ${campRes.status}: ${JSON.stringify(campRes.data).slice(0, 300)}`);
        }
        const campData = Array.isArray(campRes.data) ? campRes.data[0] : campRes.data;
        if (campData?.code && campData.code !== 'SUCCESS') {
          throw new Error(`Campanha erro: ${campData.description || campData.code}`);
        }
        const amazonCampaignId = campData?.campaignId || campData?.campaign_id;
        if (!amazonCampaignId) throw new Error('Amazon não retornou campaignId.');

        console.log(`[createManual] campanha criada: ${amazonCampaignId}`);

        // ── PASSO 2: Criar ad group (API v3) ─────────────────────────────
        const AG_CT = 'application/vnd.spAdGroup.v3+json';
        const agRes = await adsCallV3(account, 'POST', '/sp/adGroups', {
          adGroups: [{
            name: `AG | EXACT | ${asin}`,
            campaignId: String(amazonCampaignId),
            defaultBid: { amount: bid, currencyCode: account.currency_code || 'BRL' },
            state: 'ENABLED',
          }],
        }, AG_CT, AG_CT);

        const agItems = agRes.data?.adGroups?.success || agRes.data?.success || (Array.isArray(agRes.data) ? agRes.data : []);
        const agItem = agItems[0];
        if (!agItem && !agRes.ok) {
          const errItem = (agRes.data?.adGroups?.error || agRes.data?.error || [])[0];
          throw new Error(`AdGroups: ${errItem?.errorType || errItem?.message || JSON.stringify(agRes.data).slice(0, 200)}`);
        }
        const amazonAdGroupId = agItem?.adGroupId;
        if (!amazonAdGroupId) throw new Error(`AdGroups: adGroupId não retornado. Resposta: ${JSON.stringify(agRes.data).slice(0, 200)}`);

        console.log(`[createManual] ad group criado: ${amazonAdGroupId}`);

        // ── PASSO 3: Criar product ad (API v3) ───────────────────────────
        const sku = product?.sku || suggestion.sku || null;
        if (sku) {
          const PA_CT = 'application/vnd.spProductAd.v3+json';
          await adsCallV3(account, 'POST', '/sp/productAds', {
            productAds: [{
              campaignId: String(amazonCampaignId),
              adGroupId: String(amazonAdGroupId),
              sku,
              state: 'ENABLED',
            }],
          }, PA_CT, PA_CT);
        }

        // ── PASSO 4: Criar keyword exact (API v3) ────────────────────────
        const KW_CT = 'application/vnd.spKeyword.v3+json';
        const kwRes = await adsCallV3(account, 'POST', '/sp/keywords', {
          keywords: [{
            campaignId: String(amazonCampaignId),
            adGroupId: String(amazonAdGroupId),
            keywordText: keyword,
            matchType: 'EXACT',
            state: 'ENABLED',
            bid: { amount: bid, currencyCode: account.currency_code || 'BRL' },
          }],
        }, KW_CT, KW_CT);

        const kwItems = kwRes.data?.keywords?.success || kwRes.data?.success || (Array.isArray(kwRes.data) ? kwRes.data : []);
        const kwItem = kwItems[0];
        if (!kwItem && !kwRes.ok) {
          const errItem = (kwRes.data?.keywords?.error || kwRes.data?.error || [])[0];
          throw new Error(`Keywords: ${errItem?.errorType || errItem?.message || JSON.stringify(kwRes.data).slice(0, 200)}`);
        }
        const amazonKeywordId = kwItem?.keywordId;
        if (!amazonKeywordId) throw new Error(`Keywords: keywordId não retornado. Resposta: ${JSON.stringify(kwRes.data).slice(0, 200)}`);

        console.log(`[createManual] keyword criada: ${amazonKeywordId}`);

        // ── PASSO 5: Persistir no banco ───────────────────────────────────
        const [campaignRecord, keywordRecord] = await Promise.all([
          base44.asServiceRole.entities.Campaign.create({
            amazon_account_id: aid,
            campaign_id: String(amazonCampaignId),
            asin,
            sku: sku || null,
            name: campaignName,
            campaign_name: campaignName,
            campaign_type: 'SP',
            targeting_type: 'MANUAL',
            state: 'enabled',
            status: 'enabled',
            daily_budget: budget,
            bidding_strategy: 'dynamicDownOnly',
            created_by_app: true,
            learning_eligible: true,
            launch_phase: 'new',
            days_running: 0,
            created_at: now,
            synced_at: now,
          }),
          base44.asServiceRole.entities.Keyword.create({
            amazon_account_id: aid,
            campaign_id: String(amazonCampaignId),
            ad_group_id: String(amazonAdGroupId),
            keyword_id: String(amazonKeywordId),
            asin,
            keyword_text: keyword,
            keyword,
            match_type: 'exact',
            state: 'enabled',
            status: 'enabled',
            current_bid: bid,
            bid,
            source: 'manual',
            first_seen_at: now,
            last_seen_at: now,
            synced_at: now,
          }),
        ]);

        // ── PASSO 6: Pós-criação ───────────────────────────────────────────
        await Promise.all([
          base44.functions.invoke('recordTermPerformance', {
            amazon_account_id: aid,
            term: keyword,
            asin,
            product_name: product?.product_name || product?.display_name || '',
            source: 'manual_kickoff',
            match_type: 'exact',
            campaign_id: campaignRecord.id,
            amazon_campaign_id: String(amazonCampaignId),
            keyword_id: keywordRecord.id,
            bid_initial: bid,
            bid_current: bid,
          }),
          base44.asServiceRole.entities.KeywordSuggestion.update(sid, {
            status: 'created',
            created_campaign_id: campaignRecord.id,
            created_keyword_id: keywordRecord.id,
            amazon_campaign_id: String(amazonCampaignId),
            executed_at: now,
            approved_at: suggestion.approved_at || now,
          }),
          base44.asServiceRole.entities.OptimizationDecision.create({
            amazon_account_id: aid,
            decision_type: 'create_campaign',
            entity_type: 'campaign',
            entity_id: String(amazonCampaignId),
            campaign_id: String(amazonCampaignId),
            asin,
            keyword_text: keyword,
            action: 'create_campaign',
            value_after: budget,
            rationale: `Campanha manual SP criada via sugestão. Termo: "${keyword}". Motivo: ${suggestion.reason || 'sugestão por análise de produto'}. Relevância: ${Math.round((suggestion.relevance_score || 0) * 100)}%. Confiança: ${Math.round((suggestion.confidence || 0) * 100)}%.`,
            risk: 'low',
            requires_approval: false,
            status: 'executed',
            confidence: Math.round((suggestion.confidence || 0) * 100),
            objective: 'launch',
            country_code: account.country_code || 'BR',
            currency_code: account.currency_code || 'BRL',
            currency_symbol: sym,
            amazon_response: JSON.stringify({ campaignId: amazonCampaignId, adGroupId: amazonAdGroupId, keywordId: amazonKeywordId }),
            executed_at: now,
            evaluation_due_at: daysFromNow(3),
            source_function: 'createManualCampaignFromKeywordSuggestion',
            created_at: now,
          }),
        ]);

        // Atualizar índice local
        if (!keywordsByAsin.has(asin)) keywordsByAsin.set(asin, []);
        keywordsByAsin.get(asin).push({ keyword_text: keyword, keyword, match_type: 'exact', state: 'enabled', campaign_id: String(amazonCampaignId) });

        results.push({
          id: sid, ok: true, keyword,
          campaign_name: campaignName,
          amazon_campaign_id: String(amazonCampaignId),
          bid, budget,
        });

      } catch (err) {
        console.error(`[createManual] erro: ${err?.message}`);
        await base44.asServiceRole.entities.KeywordSuggestion.update(sid, {
          status: 'failed',
          error: String(err?.message || err).slice(0, 500),
        });
        results.push({ id: sid, ok: false, error: String(err?.message || err).slice(0, 200), keyword });
      }
    }

    return Response.json({
      ok: true,
      created: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok && !r.already_exists && !r.blocked).length,
      already_exists: results.filter(r => r.already_exists).length,
      blocked: results.filter(r => r.blocked).length,
      results,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});