/**
 * autoKickoffProduct — Kick-off automático completo para um ASIN.
 *
 * Regras:
 *  1. Cria 1 campanha AUTO (via createAutoCampaignForAsin)
 *  2. Busca até 3 termos do TermBank com >= 4 pedidos, classificados como winner (prioridade)
 *  3. Se TermBank retornar < 3 termos, completa com sugestões da IA com confiança >= 90%
 *     validadas por: relevância ao produto, conformidade com políticas Amazon, busca confirmada
 *  4. Cria uma campanha manual SP EXACT por keyword (via createManualCampaignFromKeywordSuggestion)
 *
 * A IA valida cada sugestão respondendo 3 critérios:
 *   - tem_procura: o termo tem volume de busca relevante no marketplace
 *   - pertinente_produto: o termo é compatível semanticamente com o produto
 *   - conforme_amazon: não viola políticas de anúncio da Amazon
 *
 * Confidence final = (relevance_score * 0.5 + ai_confidence * 0.5) >= 0.90 para auto-aplicar.
 *
 * Payload:
 *   amazon_account_id — obrigatório
 *   asin              — obrigatório
 *   sku               — opcional
 *   product_name      — opcional
 *   max_keywords      — opcional (default: 3)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import Anthropic from 'npm:@anthropic-ai/sdk@0.37.0';

const tokenCache = {};

async function getAdsToken(refreshToken) {
  const cached = tokenCache['auto_kickoff'];
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
  tokenCache['auto_kickoff'] = {
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

function norm(s) { return (s || '').toLowerCase().trim().replace(/\s+/g, ' '); }

/**
 * Valida sugestões da IA com Claude: tem_procura, pertinente_produto, conforme_amazon
 * Retorna lista filtrada com confidence >= threshold
 */
async function validateSuggestionsWithAI(suggestions, productName, asin, threshold = 0.90) {
  const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });

  const prompt = `Você é um especialista em Amazon Advertising e SEO de marketplace.

Produto: "${productName}" (ASIN: ${asin})

Para cada palavra-chave abaixo, avalie 3 critérios (true/false cada um):
1. tem_procura: O termo tem volume de busca real no Amazon.com.br (não é nicho obscuro ou termo inútil)
2. pertinente_produto: O termo é semanticamente relevante e compatível com o produto descrito
3. conforme_amazon: O termo não viola políticas de anúncio da Amazon (sem conteúdo adulto, armas, produtos proibidos, marcas concorrentes sem permissão, etc.)

Palavras-chave para validar:
${suggestions.map((s, i) => `${i + 1}. "${s.keyword}" (confiança atual: ${Math.round((s.confidence || 0) * 100)}%)`).join('\n')}

Responda SOMENTE em JSON com este schema exato:
{
  "validations": [
    {
      "keyword": "string",
      "tem_procura": true/false,
      "pertinente_produto": true/false,
      "conforme_amazon": true/false,
      "confidence_final": 0.0-1.0,
      "motivo": "string curto"
    }
  ]
}

confidence_final deve ser 0.0 se qualquer critério for false.
Se todos os 3 forem true, confidence_final = média ponderada entre a confiança original (40%) e 0.95 (60%).`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0]?.text || '{}';
  let parsed;
  try {
    // Extrair JSON do texto da resposta
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch?.[0] || '{}');
  } catch {
    return [];
  }

  const validations = parsed.validations || [];
  return validations.filter(v =>
    v.tem_procura === true &&
    v.pertinente_produto === true &&
    v.conforme_amazon === true &&
    (v.confidence_final || 0) >= threshold
  ).map(v => ({
    keyword: v.keyword,
    confidence: v.confidence_final,
    motivo: v.motivo,
    source: 'ai_suggestion',
  }));
}

/**
 * Cria uma campanha manual SP EXACT para um termo
 */
async function createManualCampaign(base44, account, asin, keyword, sku, product, bid, budget, now) {
  const aid = account.id;
  const sym = account.currency_symbol || 'R$';
  const campaignName = buildCampaignName(asin, keyword);

  // PASSO 1: Campanha
  const campRes = await adsCall(account, 'POST', '/v2/sp/campaigns', [{
    name: campaignName,
    campaignType: 'sponsoredProducts',
    targetingType: 'manual',
    state: 'enabled',
    dailyBudget: budget,
    startDate: now.slice(0, 10).replace(/-/g, ''),
    bidding: { strategy: 'legacyForSales', adjustments: [] },
  }]);
  const campData = Array.isArray(campRes.data) ? campRes.data[0] : campRes.data;
  if (campData?.code && campData.code !== 'SUCCESS') {
    throw new Error(`Amazon erro campanha: ${campData.description || campData.code}`);
  }
  const amazonCampaignId = campData?.campaignId || campData?.campaign_id;
  if (!amazonCampaignId) throw new Error('Amazon não retornou campaignId.');

  // PASSO 2: Ad group
  const agRes = await adsCall(account, 'POST', '/v2/sp/adGroups', [{
    name: `AG | EXACT | ${asin}`,
    campaignId: amazonCampaignId,
    defaultBid: bid,
    state: 'enabled',
  }]);
  const agData = Array.isArray(agRes.data) ? agRes.data[0] : agRes.data;
  const amazonAdGroupId = agData?.adGroupId;
  if (!amazonAdGroupId) throw new Error('Amazon não retornou adGroupId.');

  // PASSO 3: Product ad
  const skuVal = product?.sku || sku || null;
  if (skuVal) {
    await adsCall(account, 'POST', '/v2/sp/productAds', [{
      campaignId: amazonCampaignId,
      adGroupId: amazonAdGroupId,
      sku: skuVal,
      state: 'enabled',
    }]);
  }

  // PASSO 4: Keyword exact
  const kwRes = await adsCall(account, 'POST', '/v2/sp/keywords', [{
    campaignId: amazonCampaignId,
    adGroupId: amazonAdGroupId,
    keywordText: keyword,
    matchType: 'exact',
    state: 'enabled',
    bid,
  }]);
  const kwData = Array.isArray(kwRes.data) ? kwRes.data[0] : kwRes.data;
  const amazonKeywordId = kwData?.keywordId;
  if (!amazonKeywordId) throw new Error('Amazon não retornou keywordId.');

  // PASSO 5: Persistir no banco
  const [campaignRecord, keywordRecord] = await Promise.all([
    base44.asServiceRole.entities.Campaign.create({
      amazon_account_id: aid,
      campaign_id: String(amazonCampaignId),
      asin,
      sku: skuVal || null,
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

  // PASSO 6: TermBank + OptimizationDecision
  await Promise.all([
    base44.asServiceRole.functions.invoke('recordTermPerformance', {
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
      rationale: `Campanha manual SP criada via kick-off automático (autoKickoffProduct). Termo: "${keyword}". Fonte: TermBank ou IA com confiança >= 90%.`,
      risk: 'low',
      requires_approval: false,
      status: 'executed',
      confidence: 90,
      objective: 'launch',
      country_code: account.country_code || 'BR',
      currency_code: account.currency_code || 'BRL',
      currency_symbol: sym,
      amazon_response: JSON.stringify({ campaignId: amazonCampaignId, adGroupId: amazonAdGroupId, keywordId: amazonKeywordId }),
      executed_at: now,
      evaluation_due_at: daysFromNow(3),
      source_function: 'autoKickoffProduct',
      created_at: now,
    }),
  ]);

  return {
    ok: true,
    keyword,
    campaign_name: campaignName,
    amazon_campaign_id: String(amazonCampaignId),
    bid,
    budget,
  };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, asin, sku, product_name, max_keywords = 3 } = body;

    if (!amazon_account_id || !asin) {
      return Response.json({ ok: false, error: 'amazon_account_id e asin são obrigatórios.' }, { status: 400 });
    }

    // ── Resolver conta ─────────────────────────────────────────────────────
    const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id });
    const account = accs[0] || null;
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada.' });

    const aid = account.id;
    const now = new Date().toISOString();
    const sym = account.currency_symbol || 'R$';
    const minBudget = 5.00;
    const initialBid = 0.50;

    // ── Carregar produto ────────────────────────────────────────────────────
    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid, asin });
    const product = products[0] || null;
    const pName = product_name || product?.product_name || product?.display_name || asin;

    if (product?.inventory_status === 'out_of_stock') {
      return Response.json({ ok: false, error: 'Produto sem estoque — kick-off bloqueado.', blocked: true });
    }

    const results = {
      auto_campaign: null,
      manual_campaigns: [],
      keywords_source: [],
      term_bank_count: 0,
      ai_count: 0,
      errors: [],
    };

    // ══════════════════════════════════════════════════════════════════════
    // PASSO 1: Campanha AUTO
    // ══════════════════════════════════════════════════════════════════════
    const autoRes = await base44.asServiceRole.functions.invoke('createAutoCampaignForAsin', {
      amazon_account_id: aid,
      asin,
      sku: sku || product?.sku,
      product_name: pName,
    });
    const autoData = autoRes?.data || autoRes;
    if (autoData?.ok) {
      results.auto_campaign = {
        ok: true,
        campaign_id: autoData.campaign_id,
        campaign_name: autoData.campaign_name,
        daily_budget: autoData.daily_budget,
        already_exists: autoData.already_exists || false,
      };
    } else {
      results.errors.push(`AUTO: ${autoData?.error || 'Falha ao criar campanha AUTO'}`);
      // Não bloqueia — continua com as manuais
    }

    // ══════════════════════════════════════════════════════════════════════
    // PASSO 2: Keywords — prioridade TermBank, fallback IA
    // ══════════════════════════════════════════════════════════════════════
    const limit = Math.max(1, Math.min(max_keywords, 5));

    // 2a. Carregar keywords já existentes para deduplicação
    const existingKeywords = await base44.asServiceRole.entities.Keyword.filter(
      { amazon_account_id: aid }, '-created_date', 500
    );
    const existingCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: aid, asin }, '-created_date', 100
    );
    const asinCampIds = new Set(existingCampaigns.map(c => c.campaign_id));
    const existingKwNorms = new Set(
      existingKeywords
        .filter(k => asinCampIds.has(k.campaign_id) && k.match_type === 'exact' && k.state !== 'archived')
        .map(k => norm(k.keyword_text || k.keyword || ''))
    );

    // 2b. Buscar no TermBank: winner, >= 4 pedidos, mesmo ASIN ou compatível
    const termBankRaw = await base44.asServiceRole.entities.TermBank.filter(
      { amazon_account_id: aid, asin }, '-orders', limit * 3
    );
    const termBankTerms = termBankRaw
      .filter(t =>
        (t.orders || 0) >= 4 &&
        t.status !== 'negative' && t.status !== 'archived' &&
        !existingKwNorms.has(norm(t.term || ''))
      )
      .sort((a, b) => (b.performance_score || 0) - (a.performance_score || 0))
      .slice(0, limit);

    const selectedKeywords = termBankTerms.map(t => ({
      keyword: t.term,
      confidence: Math.min(0.99, 0.70 + (t.performance_score || 0) / 200),
      source: 'term_bank',
      motivo: `TermBank: ${t.orders} pedidos, score ${t.performance_score || 0}`,
    }));
    results.term_bank_count = selectedKeywords.length;

    // 2c. Se precisar de mais termos, buscar sugestões da IA
    const needed = limit - selectedKeywords.length;
    if (needed > 0) {
      let aiSuggestions = [];

      // Tentar função existente de sugestão
      const suggestRes = await base44.asServiceRole.functions.invoke('suggestKeywordsForKickoff', {
        amazon_account_id: aid,
        asin,
        product_name: pName,
      }).catch(() => null);

      const suggestData = suggestRes?.data || suggestRes;
      if (suggestData?.suggestions?.length > 0) {
        // Filtrar sugestões não duplicadas
        const candidates = suggestData.suggestions.filter(s =>
          !existingKwNorms.has(norm(s.keyword || '')) &&
          !selectedKeywords.some(sk => norm(sk.keyword) === norm(s.keyword))
        );

        if (candidates.length > 0) {
          // Validar com IA (Claude) as candidatas — confiança >= 90%
          const validated = await validateSuggestionsWithAI(
            candidates.slice(0, Math.min(needed * 3, 15)),
            pName,
            asin,
            0.90
          );
          aiSuggestions = validated.slice(0, needed);
        }
      }

      // Se ainda não tiver sugestões validadas, usar as da suggestKeywordsForKickoff com confiança >= 90% direto
      if (aiSuggestions.length === 0 && suggestData?.suggestions?.length > 0) {
        const highConf = suggestData.suggestions
          .filter(s =>
            (s.confidence || 0) >= 0.90 &&
            !existingKwNorms.has(norm(s.keyword || '')) &&
            !selectedKeywords.some(sk => norm(sk.keyword) === norm(s.keyword))
          )
          .slice(0, needed);
        aiSuggestions = highConf.map(s => ({
          keyword: s.keyword,
          confidence: s.confidence,
          source: 'ai_suggestion',
          motivo: s.reason || 'Alta confiança pela IA',
        }));
      }

      selectedKeywords.push(...aiSuggestions);
      results.ai_count = aiSuggestions.length;
    }

    results.keywords_source = selectedKeywords.map(k => ({
      keyword: k.keyword,
      confidence: Math.round((k.confidence || 0) * 100),
      source: k.source,
      motivo: k.motivo,
    }));

    // ══════════════════════════════════════════════════════════════════════
    // PASSO 3: Criar campanhas manuais sequencialmente (rate limit)
    // ══════════════════════════════════════════════════════════════════════
    for (const kw of selectedKeywords) {
      // Aguardar 300ms entre chamadas Amazon para respeitar rate limits
      if (results.manual_campaigns.length > 0) {
        await new Promise(r => setTimeout(r, 300));
      }

      // Verificar duplicatas novamente (pode ter sido criada no loop)
      if (existingKwNorms.has(norm(kw.keyword))) {
        results.manual_campaigns.push({ keyword: kw.keyword, ok: false, skipped: true, reason: 'Já existe' });
        continue;
      }

      try {
        const created = await createManualCampaign(
          base44, account, asin, kw.keyword,
          sku || product?.sku, product,
          initialBid, minBudget, now
        );
        results.manual_campaigns.push({ ...created, source: kw.source });
        // Adicionar ao índice local para deduplicação no mesmo loop
        existingKwNorms.add(norm(kw.keyword));
      } catch (err) {
        results.manual_campaigns.push({ keyword: kw.keyword, ok: false, error: String(err?.message || err).slice(0, 200) });
        results.errors.push(`MANUAL [${kw.keyword}]: ${String(err?.message || err).slice(0, 100)}`);
      }
    }

    const createdCount = results.manual_campaigns.filter(r => r.ok).length;
    const failedCount  = results.manual_campaigns.filter(r => !r.ok && !r.skipped).length;

    return Response.json({
      ok: true,
      asin,
      product_name: pName,
      auto_campaign: results.auto_campaign,
      manual_campaigns_created: createdCount,
      manual_campaigns_failed: failedCount,
      manual_campaigns: results.manual_campaigns,
      keywords_source: results.keywords_source,
      term_bank_count: results.term_bank_count,
      ai_count: results.ai_count,
      errors: results.errors.length > 0 ? results.errors : undefined,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});