/**
 * createManualCampaignFromKeywordSuggestion
 *
 * Cria campanhas manuais SP em lote, uma por keyword.
 * Regra central: 1 ASIN · 1 ad group · 1 keyword exact por campanha.
 *
 * Payload:
 *   amazon_account_id  — opcional (pega a primeira conectada se omitido)
 *   suggestion_ids     — array de IDs de KeywordSuggestion
 *   overrides          — opcional: { [suggestion_id]: { bid, budget } }
 *
 * Validações por item:
 *   - Sugestão existe e está em status 'suggested' (não criada, não bloqueada)
 *   - Produto com estoque (out_of_stock → bloqueia)
 *   - Campanha duplicada por nome (nome canônico: SP|MANUAL|EXACT|{ASIN}|{KW})
 *   - Keyword exact duplicada na campanha existente do produto
 *
 * Sequência por sugestão:
 *   1. Criar campanha Amazon
 *   2. Criar ad group
 *   3. Criar product ad (se SKU disponível)
 *   4. Criar keyword exact
 *   5. Registrar Campaign + Keyword + OptimizationDecision no banco
 *   6. Atualizar KeywordSuggestion para 'created'
 *
 * NUNCA marca como criado sem ID real retornado pela Amazon.
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

async function adsCall(account, method, path, body) {
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

function buildCampaignName(asin, keyword) {
  const kwShort = keyword.replace(/[^a-z0-9\s]/gi, '').trim().slice(0, 40);
  const name = `SP | MANUAL | EXACT | ${asin} | ${kwShort}`;
  return name.length > 128 ? name.slice(0, 125) + '...' : name;
}

function daysFromNow(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

// Verifica se uma keyword exact já existe nas campanhas do produto
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
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, suggestion_ids, overrides = {} } = body;

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

    // ── Carregar todas as sugestões de uma vez (batch) ────────────────────
    const allSuggestions = await base44.asServiceRole.entities.KeywordSuggestion.filter(
      { amazon_account_id: aid }, '-created_at', 500
    );
    const suggestionMap = new Map(allSuggestions.map(s => [s.id, s]));

    // ── Pré-carregar produtos e keywords existentes por ASIN ──────────────
    // Identifica os ASINs únicos das sugestões solicitadas
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
    const campaignIds = new Set(allCampaigns.map(c => c.campaign_id));
    const keywordsByCampaignId = new Map();
    for (const k of allKeywords) {
      if (!k.campaign_id) continue;
      if (!keywordsByCampaignId.has(k.campaign_id)) keywordsByCampaignId.set(k.campaign_id, []);
      keywordsByCampaignId.get(k.campaign_id).push(k);
    }

    // Keywords existentes por ASIN (todas as campanhas do produto)
    const keywordsByAsin = new Map();
    for (const asin of asins) {
      const camps = campaignsByAsin.get(asin) || [];
      const kws = camps.flatMap(c => keywordsByCampaignId.get(c.campaign_id) || []);
      keywordsByAsin.set(asin, kws);
    }

    // ── Processar sugestões sequencialmente (rate limit Amazon) ──────────
    const results = [];
    const now = new Date().toISOString();

    for (const sid of suggestion_ids) {
      const suggestion = suggestionMap.get(sid);

      if (!suggestion) {
        results.push({ id: sid, ok: false, error: 'Sugestão não encontrada.' });
        continue;
      }

      // Só processa status 'suggested' — idempotência
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

      const asin = suggestion.asin;
      const keyword = suggestion.keyword;

      // Aplicar overrides de bid/budget do frontend
      const ov = overrides[sid] || {};
      // Bid inicial padrão R$0.50 — ajustado pelo smartBidFromCpc/calibrateBidsNoImpressions após primeiros dados
      const INITIAL_BID = 0.50;
      const bid = Math.max(Math.min(
        parseFloat(ov.bid) || INITIAL_BID,
        maxBid
      ), minBid);
      const budget = Math.max(
        parseFloat(ov.budget) || suggestion.recommended_budget || minBudget,
        minBudget
      );

      // ── Validação 1: produto existe e tem estoque ─────────────────────
      const product = productByAsin.get(asin);
      if (product?.inventory_status === 'out_of_stock') {
        await base44.asServiceRole.entities.KeywordSuggestion.update(sid, {
          status: 'blocked', block_reason: 'Produto sem estoque.', error: 'OUT_OF_STOCK',
        });
        results.push({ id: sid, ok: false, blocked: true, error: 'Produto sem estoque.', keyword });
        continue;
      }

      // ── Validação 2: keyword exact já existe nas campanhas do ASIN ────
      const asinKeywords = keywordsByAsin.get(asin) || [];
      if (keywordAlreadyExists(asinKeywords, keyword)) {
        await base44.asServiceRole.entities.KeywordSuggestion.update(sid, {
          status: 'duplicate', already_exists: true, block_reason: `Keyword exact "${keyword}" já existe em campanha deste produto.`,
        });
        results.push({ id: sid, ok: false, already_exists: true, error: `Keyword "${keyword}" já existe.`, keyword });
        continue;
      }

      // ── Validação 3: campanha com nome idêntico já existe ─────────────
      const campaignName = buildCampaignName(asin, keyword);
      const asinCampaigns = campaignsByAsin.get(asin) || [];
      const normName = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const duplicateCamp = asinCampaigns.find(c =>
        normName(c.name || c.campaign_name) === normName(campaignName)
      );
      if (duplicateCamp) {
        await base44.asServiceRole.entities.KeywordSuggestion.update(sid, {
          status: 'duplicate', already_exists: true,
          block_reason: 'Campanha com mesmo nome já existe.',
          created_campaign_id: duplicateCamp.id,
        });
        results.push({ id: sid, ok: false, already_exists: true, error: 'Campanha com mesmo nome já existe.', keyword });
        continue;
      }

      // ── Marcar como criando (lock otimista) ───────────────────────────
      await base44.asServiceRole.entities.KeywordSuggestion.update(sid, { status: 'creating' });

      try {
        // PASSO 1: Criar campanha na Amazon
        const campRes = await adsCall(account, 'POST', '/v2/sp/campaigns', [{
          name: campaignName,
          campaignType: 'sponsoredProducts',
          targetingType: 'manual',
          state: 'enabled',
          dailyBudget: budget,
          startDate: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
          bidding: { strategy: 'legacyForSales', adjustments: [] },
        }]);

        if (!campRes.ok && campRes.status !== 207) {
          throw new Error(`Amazon recusou campanha (${campRes.status}): ${JSON.stringify(campRes.data)}`);
        }
        const campData = Array.isArray(campRes.data) ? campRes.data[0] : campRes.data;
        if (campData?.code && campData.code !== 'SUCCESS') {
          throw new Error(`Amazon erro campanha: ${campData.description || campData.code}`);
        }
        const amazonCampaignId = campData?.campaignId || campData?.campaign_id;
        if (!amazonCampaignId) throw new Error('Amazon não retornou campaignId.');

        // PASSO 2: Criar ad group
        const agRes = await adsCall(account, 'POST', '/v2/sp/adGroups', [{
          name: `AG | EXACT | ${asin}`,
          campaignId: amazonCampaignId,
          defaultBid: bid,
          state: 'enabled',
        }]);
        const agData = Array.isArray(agRes.data) ? agRes.data[0] : agRes.data;
        if (agData?.code && agData.code !== 'SUCCESS') {
          throw new Error(`Amazon erro ad group: ${agData.description || agData.code}`);
        }
        const amazonAdGroupId = agData?.adGroupId;
        if (!amazonAdGroupId) throw new Error('Amazon não retornou adGroupId.');

        // PASSO 3: Criar product ad (se SKU disponível)
        const sku = product?.sku || suggestion.sku || null;
        if (sku) {
          await adsCall(account, 'POST', '/v2/sp/productAds', [{
            campaignId: amazonCampaignId,
            adGroupId: amazonAdGroupId,
            sku,
            state: 'enabled',
          }]);
        }

        // PASSO 4: Criar keyword exact
        const kwRes = await adsCall(account, 'POST', '/v2/sp/keywords', [{
          campaignId: amazonCampaignId,
          adGroupId: amazonAdGroupId,
          keywordText: keyword,
          matchType: 'exact',
          state: 'enabled',
          bid,
        }]);
        const kwData = Array.isArray(kwRes.data) ? kwRes.data[0] : kwRes.data;
        if (kwData?.code && kwData.code !== 'SUCCESS') {
          throw new Error(`Amazon erro keyword: ${kwData.description || kwData.code}`);
        }
        const amazonKeywordId = kwData?.keywordId;
        if (!amazonKeywordId) throw new Error('Amazon não retornou keywordId.');

        // PASSO 5: Persistir no banco
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

        // PASSO 6: Marcar sugestão como criada + registrar decisão
        await Promise.all([
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
            rationale: `Campanha manual SP criada via sugestão IA. Termo: "${keyword}". Motivo: ${suggestion.reason || 'sugestão por análise de produto'}. Relevância: ${Math.round((suggestion.relevance_score || 0) * 100)}%. Confiança: ${Math.round((suggestion.confidence || 0) * 100)}%.`,
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

        // Atualizar índice local para validação das próximas sugestões do mesmo ASIN
        if (!keywordsByAsin.has(asin)) keywordsByAsin.set(asin, []);
        keywordsByAsin.get(asin).push({ keyword_text: keyword, keyword, match_type: 'exact', state: 'enabled', campaign_id: String(amazonCampaignId) });

        results.push({
          id: sid, ok: true, keyword,
          campaign_name: campaignName,
          amazon_campaign_id: String(amazonCampaignId),
          bid, budget,
        });

      } catch (err) {
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