import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import Anthropic from 'npm:@anthropic-ai/sdk@0.37.0';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (value: string) => String(value || '').toLowerCase().trim().replace(/\s+/g, ' ');

function brazilHour() {
  const parts = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === 'hour')?.value || 0);
}

function inWindow() {
  return [0, 1, 2, 3, 13].includes(brazilHour());
}

async function ads(base44: any, accountId: string, operation: string, method: string, path: string, payload: any, contentType = 'application/json') {
  const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
    amazon_account_id: accountId,
    operation,
    method,
    path,
    payload,
    content_type: contentType,
    accept: contentType,
    _service_role: true,
  });
  return response?.data || response || {};
}

function idFrom(data: any, group: string, field: string) {
  const payload = data?.payload || data || {};
  return payload?.[group]?.success?.[0]?.[field]
    || payload?.success?.[0]?.[field]
    || payload?.[group]?.[0]?.[field]
    || (Array.isArray(payload) ? payload[0]?.[field] : null);
}

function campaignName(asin: string, keyword: string) {
  const clean = keyword.replace(/[^a-z0-9\sáéíóúâêôãõç-]/gi, '').trim().slice(0, 40);
  return `SP | MANUAL | EXACT | ${asin} | ${clean}`.slice(0, 128);
}

async function aiKeywords(productName: string, asin: string, count: number) {
  if (count <= 0 || !Deno.env.get('ANTHROPIC_API_KEY')) return [];
  const client = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });
  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 700,
    messages: [{ role: 'user', content: `Gere ${count} palavras-chave exatas de alta intenção para Amazon Brasil. Produto: ${productName}. ASIN: ${asin}. Sem marcas concorrentes. Responda apenas JSON: {"keywords":[{"keyword":"texto","confidence":0.95}]}` }],
  });
  const text = response.content[0]?.text || '{}';
  const match = text.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(match?.[0] || '{}');
  return (parsed.keywords || []).filter((item: any) => item.keyword && Number(item.confidence || 0) >= 0.9).slice(0, count).map((item: any) => ({ keyword: String(item.keyword).trim(), confidence: Number(item.confidence || 0.9), source: 'ai_suggestion' }));
}

async function ensureTerm(base44: any, accountId: string, asin: string, keyword: string, source: string, campaignId: string | null) {
  const existing = await base44.asServiceRole.entities.TermBank.filter({ amazon_account_id: accountId, asin, normalized_term: norm(keyword) }, '-updated_at', 1).catch(() => []);
  const payload = {
    amazon_account_id: accountId,
    asin,
    term: keyword,
    normalized_term: norm(keyword),
    status: 'active',
    classification: 'winner',
    source,
    active_campaign_id: campaignId,
    last_used_at: new Date().toISOString(),
  };
  if (existing[0]) await base44.asServiceRole.entities.TermBank.update(existing[0].id, payload);
  else await base44.asServiceRole.entities.TermBank.create(payload);
}

async function createManual(base44: any, account: any, product: any, asin: string, keyword: string, bid: number, budget: number) {
  const accountId = account.id;
  const now = new Date().toISOString();
  const name = campaignName(asin, keyword);

  const campaignResponse = await ads(base44, accountId, 'createManualCampaign', 'POST', '/sp/campaigns', {
    campaigns: [{ name, targetingType: 'MANUAL', state: 'ENABLED', budget: { budgetType: 'DAILY', budget }, startDate: now.slice(0, 10) }],
  }, 'application/vnd.spCampaign.v3+json');
  const campaignId = idFrom(campaignResponse, 'campaigns', 'campaignId');
  if (!campaignId) throw new Error(campaignResponse?.errors?.[0]?.message || 'Amazon não retornou campaignId');

  await wait(14000);
  const adGroupResponse = await ads(base44, accountId, 'createManualAdGroup', 'POST', '/sp/adGroups', {
    adGroups: [{ name: `AG | EXACT | ${asin}`, campaignId, defaultBid: bid, state: 'ENABLED' }],
  }, 'application/vnd.spAdGroup.v3+json');
  const adGroupId = idFrom(adGroupResponse, 'adGroups', 'adGroupId');
  if (!adGroupId) throw new Error(adGroupResponse?.errors?.[0]?.message || 'Amazon não retornou adGroupId');

  await wait(14000);
  await ads(base44, accountId, 'createManualProductAd', 'POST', '/sp/productAds', {
    productAds: [{ campaignId, adGroupId, ...(product?.sku ? { sku: product.sku } : { asin }), state: 'ENABLED' }],
  }, 'application/vnd.spProductAd.v3+json');

  await wait(14000);
  const keywordResponse = await ads(base44, accountId, 'createExactKeyword', 'POST', '/sp/keywords', {
    keywords: [{ campaignId, adGroupId, keywordText: keyword, matchType: 'EXACT', state: 'ENABLED', bid: { value: bid, bidType: 'DEFAULT' } }],
  }, 'application/vnd.spKeyword.v3+json');
  const keywordId = idFrom(keywordResponse, 'keywords', 'keywordId');

  await base44.asServiceRole.entities.Campaign.create({ amazon_account_id: accountId, campaign_id: String(campaignId), asin, sku: product?.sku || null, name, campaign_name: name, campaign_type: 'SP', targeting_type: 'MANUAL', state: 'enabled', status: 'enabled', daily_budget: budget, created_by_app: true, learning_eligible: true, launch_phase: 'new', created_at: now, synced_at: now });
  await base44.asServiceRole.entities.Keyword.create({ amazon_account_id: accountId, campaign_id: String(campaignId), ad_group_id: String(adGroupId), keyword_id: keywordId ? String(keywordId) : `kw_${Date.now()}`, asin, keyword_text: keyword, keyword, match_type: 'exact', state: 'enabled', status: 'enabled', current_bid: bid, bid, source: 'kickoff_v2', first_seen_at: now, last_seen_at: now, synced_at: now });
  await ensureTerm(base44, accountId, asin, keyword, 'kickoff_v2', String(campaignId));

  return { ok: true, keyword, campaign_id: String(campaignId), ad_group_id: String(adGroupId), keyword_id: keywordId ? String(keywordId) : null };
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    const body = await request.json().catch(() => ({}));
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const { amazon_account_id: accountId, asin, sku, product_name: productName, max_keywords = 4 } = body;
    if (!accountId || !asin) return Response.json({ ok: false, error: 'amazon_account_id e asin são obrigatórios' }, { status: 400 });

    if (!body._window_execution && !inWindow()) {
      const response = await base44.functions.invoke('scheduleProductKickoff', { amazon_account_id: accountId, asin, sku, product_name: productName, mode: 'auto_plus_four' });
      return Response.json(response?.data || response || {});
    }

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });

    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId, asin }, '-updated_at', 1);
    const product = products[0] || { asin, sku, product_name: productName || asin };
    if (product.inventory_status === 'out_of_stock') return Response.json({ ok: false, blocked: true, error: 'Produto sem estoque — Kick-off bloqueado' });

    const existingCampaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId, asin }, '-created_date', 200);
    let autoCampaign = existingCampaigns.find((campaign: any) => String(campaign.targeting_type || '').toUpperCase() === 'AUTO' && !campaign.archived && !['archived', 'ended'].includes(String(campaign.state || campaign.status).toLowerCase()));

    if (!autoCampaign) {
      const now = new Date().toISOString();
      const name = `AUTO | ${asin} | ${now.slice(0, 10)}`;
      const response = await ads(base44, accountId, 'createAutoCampaign', 'POST', '/sp/campaigns', {
        campaigns: [{ name, targetingType: 'AUTO', state: 'ENABLED', budget: { budgetType: 'DAILY', budget: 5 }, startDate: now.slice(0, 10) }],
      }, 'application/vnd.spCampaign.v3+json');
      const campaignId = idFrom(response, 'campaigns', 'campaignId');
      if (!campaignId) return Response.json({ ok: false, error: response?.errors?.[0]?.message || 'Amazon não retornou campaignId da AUTO' });

      await wait(14000);
      const adGroupResponse = await ads(base44, accountId, 'createAutoAdGroup', 'POST', '/sp/adGroups', {
        adGroups: [{ name: `AG | AUTO | ${asin}`, campaignId, defaultBid: 0.5, state: 'ENABLED' }],
      }, 'application/vnd.spAdGroup.v3+json');
      const adGroupId = idFrom(adGroupResponse, 'adGroups', 'adGroupId');
      if (adGroupId) {
        await wait(14000);
        await ads(base44, accountId, 'createAutoProductAd', 'POST', '/sp/productAds', {
          productAds: [{ campaignId, adGroupId, ...(product?.sku ? { sku: product.sku } : { asin }), state: 'ENABLED' }],
        }, 'application/vnd.spProductAd.v3+json');
      }

      autoCampaign = await base44.asServiceRole.entities.Campaign.create({ amazon_account_id: accountId, campaign_id: String(campaignId), asin, sku: product?.sku || sku || null, name, campaign_name: name, campaign_type: 'SP', targeting_type: 'AUTO', state: 'enabled', status: 'enabled', daily_budget: 5, created_by_app: true, launch_phase: 'new', created_at: now, synced_at: now });
    }

    const existingKeywords = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-created_date', 2000);
    const campaignIds = new Set(existingCampaigns.map((campaign: any) => String(campaign.campaign_id)));
    const existingTerms = new Set(existingKeywords.filter((keyword: any) => campaignIds.has(String(keyword.campaign_id)) && String(keyword.match_type).toLowerCase() === 'exact').map((keyword: any) => norm(keyword.keyword_text || keyword.keyword)));

    const limit = Math.max(1, Math.min(Number(max_keywords || 4), 4));
    const selected: any[] = [];
    const termBank = await base44.asServiceRole.entities.TermBank.filter({ amazon_account_id: accountId, asin }, '-performance_score', 100).catch(() => []);
    for (const term of termBank) {
      const text = String(term.term || '').trim();
      if (!text || existingTerms.has(norm(text)) || ['negative', 'archived'].includes(term.status)) continue;
      if (Number(term.orders || 0) < 4 && term.classification !== 'winner') continue;
      selected.push({ keyword: text, source: 'term_bank' });
      if (selected.length >= limit) break;
    }

    if (selected.length < limit) {
      const searchTerms = await base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: accountId, advertised_asin: asin }, '-orders_14d', 200).catch(() => []);
      for (const term of searchTerms) {
        const text = String(term.search_term || '').trim();
        const orders = Number(term.orders_7d || 0) + Number(term.orders_14d || 0);
        if (!text || orders < 2 || existingTerms.has(norm(text)) || selected.some((item) => norm(item.keyword) === norm(text))) continue;
        selected.push({ keyword: text, source: 'search_term_converted' });
        if (selected.length >= limit) break;
      }
    }

    if (selected.length < limit) {
      const generated = await aiKeywords(productName || product.product_name || product.display_name || asin, asin, limit - selected.length).catch(() => []);
      for (const item of generated) if (!existingTerms.has(norm(item.keyword)) && !selected.some((selectedItem) => norm(selectedItem.keyword) === norm(item.keyword))) selected.push(item);
    }

    const manualCampaigns = [];
    for (const item of selected.slice(0, limit)) {
      try {
        const created = await createManual(base44, account, product, asin, item.keyword, 0.5, 5);
        manualCampaigns.push({ ...created, source: item.source });
      } catch (error) {
        manualCampaigns.push({ ok: false, keyword: item.keyword, source: item.source, error: error?.message || String(error) });
      }
      await wait(14000);
    }

    return Response.json({
      ok: true,
      asin,
      auto_campaign: { ok: true, campaign_id: autoCampaign.campaign_id, already_exists: Boolean(existingCampaigns.find((campaign: any) => campaign.id === autoCampaign.id)) },
      manual_campaigns_created: manualCampaigns.filter((item) => item.ok).length,
      manual_campaigns_failed: manualCampaigns.filter((item) => !item.ok).length,
      manual_campaigns: manualCampaigns,
      spacing_seconds: 14,
      gateway: true,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro no Kick-off V2' }, { status: 500 });
  }
});
