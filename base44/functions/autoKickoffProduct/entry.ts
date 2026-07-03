/**
 * autoKickoffProduct — Kick-off automático completo para um ASIN.
 * 1. Cria 1 campanha AUTO (inline, sem inter-function call)
 * 2. Busca termos no TermBank (>= 4 pedidos) e search terms convertidos
 * 3. Se insuficiente, gera keywords via IA (Claude) com confiança >= 90%
 * 4. Cria uma campanha manual SP EXACT por keyword (v3 API)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import Anthropic from 'npm:@anthropic-ai/sdk@0.37.0';

const tokenCache: Record<string, { access_token: string; expires_at: number }> = {};

async function getAdsToken(refreshToken?: string): Promise<string> {
  const cached = tokenCache['ads'];
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
  const rt = refreshToken || Deno.env.get('ADS_REFRESH_TOKEN');
  if (!rt) throw new Error('Nenhum refresh token disponível para autenticação Amazon Ads.');
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: rt,
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
  tokenCache['ads'] = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  };
  return data.access_token;
}

function getAdsBaseUrl(account: any): string {
  const r = (account?.region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsCall(account: any, method: string, path: string, body: any, contentType = 'application/json') {
  const refreshToken = account?.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
  const token = await getAdsToken(refreshToken);
  const profileId = account?.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
  const res = await fetch(`${getAdsBaseUrl(account)}${path}`, {
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
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function buildCampaignName(asin: string, keyword: string): string {
  const kwShort = keyword.replace(/[^a-z0-9\s]/gi, '').trim().slice(0, 40);
  const name = `SP | MANUAL | EXACT | ${asin} | ${kwShort}`;
  return name.length > 128 ? name.slice(0, 125) + '...' : name;
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString();
}

function norm(s: string): string { return (s || '').toLowerCase().trim().replace(/\s+/g, ' '); }

async function generateKeywordsWithAI(pName: string, asin: string, needed: number): Promise<any[]> {
  const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });
  const prompt = `Você é especialista em Amazon Ads para o mercado brasileiro.

Produto: "${pName}" (ASIN: ${asin})

Gere exatamente ${needed} palavras-chave de alta intenção de compra para este produto no Amazon.com.br.

Critérios:
- Termos que compradores brasileiros realmente digitam ao buscar este produto
- Alta intenção de compra (não informativos)
- Sem marcas concorrentes ou termos proibidos
- Específicos o suficiente para converter (não genéricos demais)

Responda SOMENTE com JSON:
{
  "keywords": [
    { "keyword": "string", "confidence": 0.90, "reason": "string curto" }
  ]
}`;

  const genResp = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = genResp.content[0]?.text || '{}';
  let parsed: any = {};
  try {
    const m = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m?.[0] || '{}');
  } catch { parsed = {}; }

  return (parsed.keywords || [])
    .filter((k: any) => k.keyword && (k.confidence || 0) >= 0.90)
    .slice(0, needed)
    .map((k: any) => ({
      keyword: k.keyword,
      confidence: k.confidence || 0.90,
      source: 'ai_suggestion',
      motivo: k.reason || 'Gerado pela IA',
    }));
}

async function createManualCampaign(base44: any, account: any, asin: string, keyword: string, sku: string | null, product: any, bid: number, budget: number, now: string) {
  const aid = account.id;
  const sym = account.currency_symbol || 'R$';
  const campaignName = buildCampaignName(asin, keyword);
  const today = now.slice(0, 10);

  // PASSO 1: Campanha SP MANUAL (v3)
  const campRes = await adsCall(account, 'POST', '/sp/campaigns', {
    campaigns: [{
      name: campaignName,
      targetingType: 'MANUAL',
      state: 'ENABLED',
      budget: { budgetType: 'DAILY', budget },
      startDate: today,
    }],
  }, 'application/vnd.spCampaign.v3+json');

  const amazonCampaignId =
    campRes.data?.campaigns?.success?.[0]?.campaignId ||
    campRes.data?.success?.[0]?.campaignId ||
    campRes.data?.campaigns?.[0]?.campaignId ||
    (Array.isArray(campRes.data) ? campRes.data[0]?.campaignId : null);
  if (!amazonCampaignId) {
    const err = campRes.data?.campaigns?.error?.[0]?.description || campRes.data?.error || JSON.stringify(campRes.data).slice(0, 200);
    throw new Error(`Amazon erro campanha: ${err}`);
  }

  // PASSO 2: Ad group (v3)
  const agRes = await adsCall(account, 'POST', '/sp/adGroups', {
    adGroups: [{
      name: `AG | EXACT | ${asin}`,
      campaignId: amazonCampaignId,
      defaultBid: bid,
      state: 'ENABLED',
    }],
  }, 'application/vnd.spAdGroup.v3+json');

  const amazonAdGroupId =
    agRes.data?.adGroups?.success?.[0]?.adGroupId ||
    agRes.data?.success?.[0]?.adGroupId ||
    agRes.data?.adGroups?.[0]?.adGroupId;
  if (!amazonAdGroupId) throw new Error('Amazon não retornou adGroupId.');

  // PASSO 3: Product ad (v3) — tolerante a falha
  const skuVal = product?.sku || sku || null;
  await adsCall(account, 'POST', '/sp/productAds', {
    productAds: [{
      campaignId: amazonCampaignId,
      adGroupId: amazonAdGroupId,
      ...(skuVal ? { sku: skuVal } : { asin }),
      state: 'ENABLED',
    }],
  }, 'application/vnd.spProductAd.v3+json').catch(() => {});

  // PASSO 4: Keyword EXACT (v3)
  const kwRes = await adsCall(account, 'POST', '/sp/keywords', {
    keywords: [{
      campaignId: amazonCampaignId,
      adGroupId: amazonAdGroupId,
      keywordText: keyword,
      matchType: 'EXACT',
      state: 'ENABLED',
      bid: { value: bid, bidType: 'DEFAULT' },
    }],
  }, 'application/vnd.spKeyword.v3+json');

  const amazonKeywordId =
    kwRes.data?.keywords?.success?.[0]?.keywordId ||
    kwRes.data?.success?.[0]?.keywordId ||
    kwRes.data?.keywords?.[0]?.keywordId;
  if (!amazonKeywordId) {
    console.warn(`[createManualCampaign] keywordId não retornado: ${JSON.stringify(kwRes.data).slice(0, 150)}`);
  }

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
      keyword_id: amazonKeywordId ? String(amazonKeywordId) : `kw_${Date.now()}`,
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

  // PASSO 6: TermBank + registro
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
    rationale: `Campanha manual SP criada via kick-off automático. Termo: "${keyword}".`,
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
  }).catch(() => {});

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

    const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id });
    const account = accs[0] || null;
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada.' });

    const aid = account.id;
    const now = new Date().toISOString();
    const minBudget = 5.00;
    const initialBid = 0.50;

    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid, asin });
    const product = products[0] || null;
    const pName = product_name || product?.product_name || product?.display_name || asin;

    if (product?.inventory_status === 'out_of_stock') {
      return Response.json({ ok: false, error: 'Produto sem estoque — kick-off bloqueado.', blocked: true });
    }

    const results: any = {
      auto_campaign: null,
      manual_campaigns: [],
      keywords_source: [],
      term_bank_count: 0,
      ai_count: 0,
      errors: [],
    };

    // ══════════════════════════════════════════════════════════════════════
    // PASSO 1: Campanha AUTO (inline, sem inter-function call)
    // ══════════════════════════════════════════════════════════════════════
    try {
      const existingAuto = await base44.asServiceRole.entities.Campaign.filter(
        { amazon_account_id: aid, asin }, '-created_date', 20
      );
      const activeAuto = existingAuto.find((c: any) =>
        (c.targeting_type || '').toUpperCase() === 'AUTO' && c.archived !== true
      );

      if (activeAuto) {
        results.auto_campaign = {
          ok: true,
          campaign_id: activeAuto.campaign_id,
          campaign_name: activeAuto.name || activeAuto.campaign_name,
          daily_budget: activeAuto.daily_budget,
          already_exists: true,
        };
      } else {
        // Budget dinâmico
        const autopilotCfgs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid });
        const apCfg = autopilotCfgs[0] || null;
        const totalDailyBudget = apCfg?.total_daily_budget || apCfg?.daily_budget_limit || 500;
        const maxPerCampaign = apCfg?.maximum_campaign_budget || 20;
        const allActiveCamps = await base44.asServiceRole.entities.Campaign.filter(
          { amazon_account_id: aid }, '-created_date', 2000
        );
        const currentSpend = allActiveCamps
          .filter((c: any) => c.state === 'enabled' && c.archived !== true)
          .reduce((s: number, c: any) => s + (c.daily_budget || 0), 0);
        const available = totalDailyBudget - currentSpend;
        const autoBudget = Math.max(Math.min(Math.max(available * 0.1, 5), maxPerCampaign), 5);
        const autoName = `AUTO | ${asin} | ${now.slice(0, 10)}`;

        const autoCampRes = await adsCall(account, 'POST', '/sp/campaigns', {
          campaigns: [{
            name: autoName,
            targetingType: 'AUTO',
            state: 'ENABLED',
            budget: { budgetType: 'DAILY', budget: autoBudget },
            startDate: now.slice(0, 10),
          }],
        }, 'application/vnd.spCampaign.v3+json');

        const autoCampaignId =
          autoCampRes.data?.campaigns?.success?.[0]?.campaignId ||
          autoCampRes.data?.success?.[0]?.campaignId ||
          autoCampRes.data?.campaigns?.[0]?.campaignId ||
          (Array.isArray(autoCampRes.data) ? autoCampRes.data[0]?.campaignId : null);

        if (autoCampaignId) {
          await adsCall(account, 'POST', '/sp/adGroups', {
            adGroups: [{
              name: `AdGroup | ${asin}`,
              campaignId: autoCampaignId,
              defaultBid: 0.50,
              state: 'ENABLED',
            }],
          }, 'application/vnd.spAdGroup.v3+json').catch(() => {});

          await base44.asServiceRole.entities.Campaign.create({
            amazon_account_id: aid,
            campaign_id: String(autoCampaignId),
            asin,
            name: autoName,
            campaign_name: autoName,
            campaign_type: 'SP',
            targeting_type: 'AUTO',
            state: 'enabled',
            status: 'enabled',
            daily_budget: autoBudget,
            created_by_app: true,
            launch_phase: 'new',
            days_running: 0,
            created_at: now,
            synced_at: now,
          });

          results.auto_campaign = {
            ok: true,
            campaign_id: String(autoCampaignId),
            campaign_name: autoName,
            daily_budget: autoBudget,
            already_exists: false,
          };
        } else {
          const errDetail = autoCampRes.data?.campaigns?.error?.[0]?.description
            || autoCampRes.data?.error
            || JSON.stringify(autoCampRes.data).slice(0, 200);
          results.errors.push(`AUTO: ${errDetail}`);
        }
      }
    } catch (autoErr: any) {
      results.errors.push(`AUTO: ${autoErr.message}`);
    }

    // ══════════════════════════════════════════════════════════════════════
    // PASSO 2: Keywords — TermBank → Search Terms → IA
    // ══════════════════════════════════════════════════════════════════════
    const limit = Math.max(1, Math.min(max_keywords, 5));

    const existingKeywords = await base44.asServiceRole.entities.Keyword.filter(
      { amazon_account_id: aid }, '-created_date', 500
    );
    const existingCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: aid, asin }, '-created_date', 100
    );
    const asinCampIds = new Set(existingCampaigns.map((c: any) => c.campaign_id));
    const existingKwNorms = new Set(
      existingKeywords
        .filter((k: any) => asinCampIds.has(k.campaign_id) && k.match_type === 'exact' && k.state !== 'archived')
        .map((k: any) => norm(k.keyword_text || k.keyword || ''))
    );

    // 2a. TermBank: >= 4 pedidos
    const termBankRaw = await base44.asServiceRole.entities.TermBank.filter(
      { amazon_account_id: aid, asin }, '-orders', limit * 3
    );
    const termBankTerms = termBankRaw
      .filter((t: any) =>
        (t.orders || 0) >= 4 &&
        t.status !== 'negative' && t.status !== 'archived' &&
        !existingKwNorms.has(norm(t.term || ''))
      )
      .sort((a: any, b: any) => (b.performance_score || 0) - (a.performance_score || 0))
      .slice(0, limit);

    const selectedKeywords: any[] = termBankTerms.map((t: any) => ({
      keyword: t.term,
      confidence: Math.min(0.99, 0.70 + (t.performance_score || 0) / 200),
      source: 'term_bank',
      motivo: `TermBank: ${t.orders} pedidos`,
    }));
    results.term_bank_count = selectedKeywords.length;

    // 2b. Completar com IA se necessário
    const needed = limit - selectedKeywords.length;
    if (needed > 0) {
      // Primeiro tentar search terms convertidos
      const ownSearchTerms = await base44.asServiceRole.entities.SearchTerm.filter(
        { amazon_account_id: aid, advertised_asin: asin }, '-orders_14d', 100
      ).catch(() => []);
      for (const st of ownSearchTerms) {
        const term = (st.search_term || '').trim().toLowerCase();
        if (!term || term.length < 4) continue;
        const orders = (st.orders_7d || 0) + (st.orders_14d || 0);
        if (orders >= 2 && !existingKwNorms.has(norm(term)) && !selectedKeywords.some((k: any) => norm(k.keyword) === norm(term))) {
          selectedKeywords.push({
            keyword: term,
            confidence: Math.min(0.95, 0.75 + orders * 0.04),
            source: 'search_term_converted',
            motivo: `${orders} pedidos em search terms`,
          });
          if (selectedKeywords.length >= limit) break;
        }
      }

      // Fallback: gerar com IA
      const stillNeeded = limit - selectedKeywords.length;
      if (stillNeeded > 0) {
        try {
          const aiKws = await generateKeywordsWithAI(pName, asin, stillNeeded);
          const newKws = aiKws.filter((k: any) =>
            !existingKwNorms.has(norm(k.keyword)) &&
            !selectedKeywords.some((sk: any) => norm(sk.keyword) === norm(k.keyword))
          ).slice(0, stillNeeded);
          selectedKeywords.push(...newKws);
          results.ai_count = newKws.length;
        } catch (e: any) {
          console.warn('[autoKickoffProduct] Geração IA falhou:', e.message);
        }
      }
    }

    results.keywords_source = selectedKeywords.map((k: any) => ({
      keyword: k.keyword,
      confidence: Math.round((k.confidence || 0) * 100),
      source: k.source,
      motivo: k.motivo,
    }));

    // ══════════════════════════════════════════════════════════════════════
    // PASSO 3: Criar campanhas manuais
    // ══════════════════════════════════════════════════════════════════════
    for (const kw of selectedKeywords) {
      if (results.manual_campaigns.length > 0) await new Promise(r => setTimeout(r, 400));
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
        existingKwNorms.add(norm(kw.keyword));
      } catch (err: any) {
        results.manual_campaigns.push({ keyword: kw.keyword, ok: false, error: String(err?.message || err).slice(0, 200) });
        results.errors.push(`MANUAL [${kw.keyword}]: ${String(err?.message || err).slice(0, 100)}`);
      }
    }

    const createdCount = results.manual_campaigns.filter((r: any) => r.ok).length;
    const failedCount  = results.manual_campaigns.filter((r: any) => !r.ok && !r.skipped).length;

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

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});