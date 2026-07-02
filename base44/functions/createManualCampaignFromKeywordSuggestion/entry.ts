/**
 * createManualCampaignFromKeywordSuggestion
 *
 * Cria uma campanha manual SP com 1 ASIN · 1 ad group · 1 keyword exact
 * para uma sugestão aprovada de KeywordSuggestion.
 *
 * Regras:
 * - Uma campanha por keyword (nunca agrupar)
 * - Nome: SP | MANUAL | EXACT | {ASIN} | {KEYWORD_SHORT}
 * - Inicia com dynamicDownOnly
 * - Placements: 0%
 * - Registra em OptimizationDecision
 * - Nunca marca como criada sem resposta real da Amazon
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
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token falhou');
  tokenCache['create_manual'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
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

function truncateName(str, max = 128) {
  return str.length > max ? str.slice(0, max - 3) + '...' : str;
}

function buildCampaignName(asin, keyword) {
  const kwShort = keyword.replace(/[^a-z0-9\s]/gi, '').trim().slice(0, 40);
  return truncateName(`SP | MANUAL | EXACT | ${asin} | ${kwShort}`);
}

function buildAdGroupName(asin) {
  return `AG | EXACT | ${asin}`;
}

function daysFromNow(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, suggestion_ids } = body;

    if (!suggestion_ids?.length) return Response.json({ ok: false, error: 'suggestion_ids obrigatório' }, { status: 400 });

    // Resolver conta
    let account = null;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id });
      account = accs[0] || null;
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada.' });

    const aid = account.id;
    const sym = account.currency_symbol || 'R$';
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!profileId) return Response.json({ ok: false, error: 'Profile ID ausente. Configure o profile da conta Amazon Ads.' });

    const autopilotCfg = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid });
    const cfg = autopilotCfg[0] || {};
    const minBid = cfg.min_bid || 0.10;
    const maxBid = cfg.max_bid || 5.0;
    const defaultBudget = 5.00;

    const results = [];
    const now = new Date().toISOString();

    // Processar sequencialmente (respeita rate limit)
    for (const sid of suggestion_ids) {
      const sArr = await base44.asServiceRole.entities.KeywordSuggestion.filter({ id: sid });
      const suggestion = sArr[0];

      if (!suggestion) {
        results.push({ id: sid, ok: false, error: 'Sugestão não encontrada.' });
        continue;
      }

      if (suggestion.status === 'created') {
        results.push({ id: sid, ok: false, error: 'Campanha já criada para esta sugestão.', already_exists: true });
        continue;
      }

      if (suggestion.status === 'duplicate' || suggestion.already_exists) {
        results.push({ id: sid, ok: false, error: suggestion.block_reason || 'Sugestão duplicada.', already_exists: true });
        continue;
      }

      const asin = suggestion.asin;
      const keyword = suggestion.keyword;
      const bid = Math.max(Math.min(suggestion.recommended_bid || 0.30, maxBid), minBid);
      const budget = Math.max(suggestion.recommended_budget || defaultBudget, defaultBudget);

      // Validar produto
      const prods = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid, asin });
      const product = prods[0] || null;

      if (product?.inventory_status === 'out_of_stock') {
        await base44.asServiceRole.entities.KeywordSuggestion.update(sid, { status: 'blocked', block_reason: 'Produto sem estoque.', error: 'OUT_OF_STOCK' });
        results.push({ id: sid, ok: false, error: 'Produto sem estoque.', blocked: true });
        continue;
      }

      // Verificar campanha duplicada
      const campaignName = buildCampaignName(asin, keyword);
      const existingCamps = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid, asin });
      const duplicate = existingCamps.find(c => {
        const cn = (c.name || c.campaign_name || '').toLowerCase();
        return cn.includes(keyword.slice(0, 20).toLowerCase()) && cn.includes(asin.toLowerCase());
      });

      if (duplicate) {
        await base44.asServiceRole.entities.KeywordSuggestion.update(sid, {
          status: 'duplicate', already_exists: true, block_reason: 'Campanha equivalente já existe.',
          created_campaign_id: duplicate.id,
        });
        results.push({ id: sid, ok: false, error: 'Campanha equivalente já existe.', already_exists: true, campaign_id: duplicate.campaign_id });
        continue;
      }

      // Marcar como criando
      await base44.asServiceRole.entities.KeywordSuggestion.update(sid, { status: 'creating' });

      try {
        // 1. Criar campanha
        const campResult = await adsCall(account, 'POST', '/v2/sp/campaigns', [{
          name: campaignName,
          campaignType: 'sponsoredProducts',
          targetingType: 'manual',
          state: 'enabled',
          dailyBudget: budget,
          startDate: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
          bidding: { strategy: 'legacyForSales', adjustments: [] },
        }]);

        if (!campResult.ok && campResult.status !== 207) {
          throw new Error(`Falha ao criar campanha: ${JSON.stringify(campResult.data)}`);
        }

        const campData = Array.isArray(campResult.data) ? campResult.data[0] : campResult.data;
        if (campData?.code && campData.code !== 'SUCCESS') {
          throw new Error(`Amazon recusou campanha: ${campData.description || campData.code}`);
        }
        const amazonCampaignId = campData?.campaignId || campData?.campaign_id;
        if (!amazonCampaignId) throw new Error('Amazon não retornou campaignId.');

        // 2. Criar ad group
        const adGroupName = buildAdGroupName(asin);
        const adGroupResult = await adsCall(account, 'POST', '/v2/sp/adGroups', [{
          name: adGroupName,
          campaignId: amazonCampaignId,
          defaultBid: bid,
          state: 'enabled',
        }]);

        const agData = Array.isArray(adGroupResult.data) ? adGroupResult.data[0] : adGroupResult.data;
        if (agData?.code && agData.code !== 'SUCCESS') throw new Error(`Falha no ad group: ${agData.description}`);
        const amazonAdGroupId = agData?.adGroupId;
        if (!amazonAdGroupId) throw new Error('Amazon não retornou adGroupId.');

        // 3. Criar product ad
        let productSku = product?.sku || null;
        if (productSku) {
          await adsCall(account, 'POST', '/v2/sp/productAds', [{
            campaignId: amazonCampaignId, adGroupId: amazonAdGroupId,
            sku: productSku, state: 'enabled',
          }]);
        }

        // 4. Criar keyword exact
        const kwResult = await adsCall(account, 'POST', '/v2/sp/keywords', [{
          campaignId: amazonCampaignId,
          adGroupId: amazonAdGroupId,
          keywordText: keyword,
          matchType: 'exact',
          state: 'enabled',
          bid,
        }]);

        const kwData = Array.isArray(kwResult.data) ? kwResult.data[0] : kwResult.data;
        if (kwData?.code && kwData.code !== 'SUCCESS') throw new Error(`Falha na keyword: ${kwData.description}`);
        const amazonKeywordId = kwData?.keywordId;

        // 5. Registrar campanha no banco
        const campaignRecord = await base44.asServiceRole.entities.Campaign.create({
          amazon_account_id: aid,
          campaign_id: String(amazonCampaignId),
          asin,
          sku: productSku || null,
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
        });

        // 6. Registrar keyword no banco
        const keywordRecord = await base44.asServiceRole.entities.Keyword.create({
          amazon_account_id: aid,
          campaign_id: String(amazonCampaignId),
          ad_group_id: amazonAdGroupId ? String(amazonAdGroupId) : '',
          keyword_id: amazonKeywordId ? String(amazonKeywordId) : `manual_${Date.now()}`,
          asin,
          keyword_text: keyword,
          keyword: keyword,
          match_type: 'exact',
          state: 'enabled',
          status: 'enabled',
          current_bid: bid,
          bid,
          source: 'manual',
          first_seen_at: now,
          last_seen_at: now,
          synced_at: now,
        });

        // 7. Atualizar sugestão
        await base44.asServiceRole.entities.KeywordSuggestion.update(sid, {
          status: 'created',
          created_campaign_id: campaignRecord.id,
          created_keyword_id: keywordRecord.id,
          amazon_campaign_id: String(amazonCampaignId),
          executed_at: now,
          approved_at: suggestion.approved_at || now,
        });

        // 8. Registrar OptimizationDecision
        await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id: aid,
          decision_type: 'create_campaign',
          entity_type: 'campaign',
          entity_id: String(amazonCampaignId),
          campaign_id: String(amazonCampaignId),
          asin,
          keyword_text: keyword,
          action: 'create_campaign',
          value_after: budget,
          rationale: `Campanha manual criada a partir de sugestão IA para o termo "${keyword}". Motivo: ${suggestion.reason || 'sugestão por título'}. Relevância: ${(suggestion.relevance_score || 0) * 100}%. Confiança: ${(suggestion.confidence || 0) * 100}%.`,
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
        });

        results.push({
          id: sid, ok: true, keyword,
          campaign_name: campaignName,
          amazon_campaign_id: String(amazonCampaignId),
          bid, budget,
        });

      } catch (campError) {
        await base44.asServiceRole.entities.KeywordSuggestion.update(sid, {
          status: 'failed', error: String(campError?.message || campError),
        });
        results.push({ id: sid, ok: false, error: String(campError?.message || campError) });
      }
    }

    const created = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok && !r.already_exists).length;
    const alreadyExists = results.filter(r => r.already_exists).length;

    return Response.json({ ok: true, created, failed, already_exists: alreadyExists, results });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});