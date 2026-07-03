/**
 * createManualCampaignsForAutoCampaigns
 *
 * Para cada campanha AUTO ativa sem campanha MANUAL vinculada ao mesmo ASIN,
 * cria pelo menos 1 campanha manual SP EXACT usando IA para sugerir keywords
 * conforme as regras do autoKickoffProduct (TermBank >= 4 pedidos, IA >= 90% conf.).
 *
 * Payload:
 *   amazon_account_id — obrigatório
 *   dry_run           — opcional (default false) — se true, só lista o que seria feito
 *   max_per_run       — opcional (default 10) — limite de ASINs por execução
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import Anthropic from 'npm:@anthropic-ai/sdk@0.37.0';

const tokenCache: Record<string, { access_token: string; expires_at: number }> = {};

async function getAdsToken(account: any) {
  const cached = tokenCache['bulk_create'];
  if (cached && cached.expires_at > Date.now() + 5000) return cached.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: account?.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '',
    client_id: Deno.env.get('ADS_CLIENT_ID') || '',
    client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token LWA falhou');
  tokenCache['bulk_create'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBaseUrl(account: any) {
  const r = (account?.region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsCall(account: any, method: string, path: string, body?: any) {
  const token = await getAdsToken(account);
  const profileId = account?.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
  const res = await fetch(`${getAdsBaseUrl(account)}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function norm(s: string) { return (s || '').toLowerCase().trim().replace(/\s+/g, ' '); }

async function suggestKeywordsWithAI(productName: string, asin: string, existingKeywords: Set<string>): Promise<string[]> {
  const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });

  const prompt = `Você é um especialista em Amazon Advertising Brasil.

Produto: "${productName}" (ASIN: ${asin})

Sugira 3 palavras-chave de cauda média/longa para uma campanha SP Manual EXACT no Amazon.com.br.

Regras:
- Cada termo deve ter volume de busca real no marketplace brasileiro
- Relevante ao produto (semântica compatível)
- Não violar políticas Amazon (sem marcas concorrentes, conteúdo adulto, etc.)
- Preferir termos com alta intenção de compra
- Não incluir: ${Array.from(existingKeywords).slice(0, 10).join(', ') || 'nenhum ainda'}

Responda SOMENTE em JSON:
{
  "keywords": [
    { "keyword": "string", "confidence": 0.90-1.0, "reason": "string curto" }
  ]
}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0]?.text || '{}';
  let parsed: any = {};
  try {
    const m = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m?.[0] || '{}');
  } catch { return []; }

  return (parsed.keywords || [])
    .filter((k: any) => (k.confidence || 0) >= 0.90 && !existingKeywords.has(norm(k.keyword)))
    .map((k: any) => k.keyword as string)
    .slice(0, 3);
}

async function createOneCampaign(account: any, asin: string, keyword: string, sku: string | null, budget: number, bid: number, now: string) {
  const campaignName = `SP | MANUAL | EXACT | ${asin} | ${keyword.slice(0, 40)}`.slice(0, 128);
  const profileId = account?.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';

  // 1. Campanha
  const campRes = await adsCall(account, 'POST', '/v2/sp/campaigns', [{
    name: campaignName,
    campaignType: 'sponsoredProducts',
    targetingType: 'manual',
    state: 'enabled',
    dailyBudget: budget,
    startDate: now.slice(0, 10).replace(/-/g, ''),
    bidding: { strategy: 'legacyForSales', adjustments: [] },
  }]);
  const campData: any = Array.isArray(campRes.data) ? campRes.data[0] : campRes.data;
  const amazonCampaignId = campData?.campaignId;
  if (!amazonCampaignId) throw new Error(`Campanha não criada: ${campData?.description || campData?.code || 'sem ID'}`);

  // 2. Ad Group
  const agRes = await adsCall(account, 'POST', '/v2/sp/adGroups', [{
    name: `AG | EXACT | ${asin}`,
    campaignId: amazonCampaignId,
    defaultBid: bid,
    state: 'enabled',
  }]);
  const agData: any = Array.isArray(agRes.data) ? agRes.data[0] : agRes.data;
  const amazonAdGroupId = agData?.adGroupId;
  if (!amazonAdGroupId) throw new Error('adGroupId não retornado');

  // 3. Product Ad (se tiver SKU)
  if (sku) {
    await adsCall(account, 'POST', '/v2/sp/productAds', [{
      campaignId: amazonCampaignId,
      adGroupId: amazonAdGroupId,
      sku,
      state: 'enabled',
    }]);
  }

  // 4. Keyword
  const kwRes = await adsCall(account, 'POST', '/v2/sp/keywords', [{
    campaignId: amazonCampaignId,
    adGroupId: amazonAdGroupId,
    keywordText: keyword,
    matchType: 'exact',
    state: 'enabled',
    bid,
  }]);
  const kwData: any = Array.isArray(kwRes.data) ? kwRes.data[0] : kwRes.data;
  const amazonKeywordId = kwData?.keywordId;

  return { amazonCampaignId, amazonAdGroupId, amazonKeywordId, campaignName };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false, max_per_run = 10 } = body;

    if (!amazon_account_id) {
      return Response.json({ ok: false, error: 'amazon_account_id é obrigatório.' }, { status: 400 });
    }

    const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id });
    const account = accs[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada.' });

    const aid = account.id;
    const now = new Date().toISOString();
    const BID = 0.50;
    const BUDGET = 5.00;

    // ── Carregar todas as campanhas ativas ────────────────────────────────
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: aid }, '-created_date', 2000
    );

    const activeCampaigns = allCampaigns.filter((c: any) =>
      (c.state === 'enabled' || c.status === 'enabled') &&
      c.state !== 'archived' && !c.archived
    );

    // ASINs com campanha AUTO ativa
    const autoCampaigns = activeCampaigns.filter((c: any) =>
      (c.targeting_type || '').toUpperCase() === 'AUTO' && c.asin
    );

    // ASINs com campanha MANUAL ativa
    const manualAsinSet = new Set(
      activeCampaigns
        .filter((c: any) => (c.targeting_type || '').toUpperCase() !== 'AUTO' && c.asin)
        .map((c: any) => c.asin)
    );

    // ASINs que têm AUTO mas NÃO têm MANUAL
    const missingManualAsins = [...new Set(autoCampaigns.map((c: any) => c.asin))]
      .filter(asin => !manualAsinSet.has(asin))
      .slice(0, max_per_run);

    console.log(`[createManualCampaignsForAutoCampaigns] AUTO sem MANUAL: ${missingManualAsins.length} ASINs`);

    if (missingManualAsins.length === 0) {
      return Response.json({
        ok: true,
        message: 'Todas as campanhas AUTO já têm pelo menos uma campanha MANUAL associada.',
        auto_count: autoCampaigns.length,
        manual_count: manualAsinSet.size,
        created: [],
      });
    }

    if (dry_run) {
      return Response.json({
        ok: true,
        dry_run: true,
        auto_count: autoCampaigns.length,
        manual_count: manualAsinSet.size,
        would_process: missingManualAsins,
      });
    }

    // ── Carregar produtos e keywords existentes ────────────────────────────
    const products = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id: aid }, null, 2000
    );
    const productMap: Record<string, any> = {};
    for (const p of products) productMap[p.asin] = p;

    const existingKeywords = await base44.asServiceRole.entities.Keyword.filter(
      { amazon_account_id: aid }, null, 2000
    );

    // ── Carregar TermBank ──────────────────────────────────────────────────
    const termBankAll = await base44.asServiceRole.entities.TermBank.filter(
      { amazon_account_id: aid }, '-orders', 500
    );

    const results: any[] = [];

    for (const asin of missingManualAsins) {
      // Rate limit: aguardar 400ms entre ASINs
      if (results.length > 0) await new Promise(r => setTimeout(r, 400));

      const product = productMap[asin] || null;
      const sku = product?.sku || null;
      const productName = product?.product_name || product?.display_name || asin;

      // Keywords existentes para este ASIN (deduplicação)
      const asinCampIds = new Set(allCampaigns.filter((c: any) => c.asin === asin).map((c: any) => c.campaign_id));
      const usedKws = new Set(
        existingKeywords
          .filter((k: any) => asinCampIds.has(k.campaign_id) && k.match_type === 'exact' && k.state !== 'archived')
          .map((k: any) => norm(k.keyword_text || k.keyword || ''))
      );

      // 1. Tentar TermBank: winner/learning, >= 4 pedidos
      const tbTerms = termBankAll
        .filter((t: any) =>
          t.asin === asin &&
          (t.orders || 0) >= 4 &&
          t.status !== 'negative' && t.status !== 'archived' &&
          !usedKws.has(norm(t.term || ''))
        )
        .sort((a: any, b: any) => (b.performance_score || 0) - (a.performance_score || 0))
        .slice(0, 3)
        .map((t: any) => t.term as string);

      // 2. Completar com IA se não tiver keywords suficientes
      let keywords = [...tbTerms];
      if (keywords.length < 1) {
        try {
          const aiKws = await suggestKeywordsWithAI(productName, asin, usedKws);
          keywords = aiKws.slice(0, 3);
        } catch (e) {
          console.warn(`[IA] Falha ao sugerir para ${asin}: ${e.message}`);
        }
      }

      // Garantir pelo menos 1 keyword
      if (keywords.length === 0) {
        results.push({ asin, ok: false, error: 'Sem keywords disponíveis (TermBank e IA sem resultado)' });
        continue;
      }

      // Criar 1 campanha manual por keyword (até 3)
      const asinResult: any = { asin, product_name: productName, campaigns: [], errors: [] };

      for (const keyword of keywords) {
        if (usedKws.has(norm(keyword))) {
          asinResult.campaigns.push({ keyword, skipped: true, reason: 'Já existe' });
          continue;
        }
        try {
          await new Promise(r => setTimeout(r, 300)); // rate limit entre keywords
          const created = await createOneCampaign(account, asin, keyword, sku, BUDGET, BID, now);

          // Persistir no banco
          const [campRecord, kwRecord] = await Promise.all([
            base44.asServiceRole.entities.Campaign.create({
              amazon_account_id: aid,
              campaign_id: String(created.amazonCampaignId),
              asin,
              sku: sku || null,
              name: created.campaignName,
              campaign_name: created.campaignName,
              campaign_type: 'SP',
              targeting_type: 'MANUAL',
              state: 'enabled',
              status: 'enabled',
              daily_budget: BUDGET,
              bidding_strategy: 'dynamicDownOnly',
              created_by_app: true,
              learning_eligible: true,
              launch_phase: 'new',
              days_running: 0,
              created_at: now,
              synced_at: now,
            }),
            created.amazonKeywordId ? base44.asServiceRole.entities.Keyword.create({
              amazon_account_id: aid,
              campaign_id: String(created.amazonCampaignId),
              ad_group_id: String(created.amazonAdGroupId),
              keyword_id: String(created.amazonKeywordId),
              asin,
              keyword_text: keyword,
              keyword,
              match_type: 'exact',
              state: 'enabled',
              status: 'enabled',
              current_bid: BID,
              bid: BID,
              source: 'manual',
              first_seen_at: now,
              last_seen_at: now,
              synced_at: now,
            }) : Promise.resolve(null),
          ]);

          // TermBank
          base44.asServiceRole.functions.invoke('recordTermPerformance', {
            amazon_account_id: aid,
            term: keyword,
            asin,
            product_name: productName,
            source: 'manual_kickoff',
            match_type: 'exact',
            campaign_id: campRecord.id,
            amazon_campaign_id: String(created.amazonCampaignId),
            bid_initial: BID,
            bid_current: BID,
          }).catch(() => {});

          usedKws.add(norm(keyword));
          asinResult.campaigns.push({ keyword, ok: true, campaign_id: String(created.amazonCampaignId), campaign_name: created.campaignName });
        } catch (err: any) {
          asinResult.campaigns.push({ keyword, ok: false, error: String(err?.message || err).slice(0, 200) });
          asinResult.errors.push(String(err?.message || err).slice(0, 100));
        }
      }

      asinResult.ok = asinResult.campaigns.some((c: any) => c.ok);
      results.push(asinResult);
    }

    const totalCreated = results.reduce((sum: number, r: any) => sum + (r.campaigns || []).filter((c: any) => c.ok).length, 0);
    const totalFailed = results.filter((r: any) => !r.ok).length;

    return Response.json({
      ok: true,
      asins_processed: results.length,
      campaigns_created: totalCreated,
      asins_failed: totalFailed,
      results,
    });

  } catch (error: any) {
    console.error('[createManualCampaignsForAutoCampaigns]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});