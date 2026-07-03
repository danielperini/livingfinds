import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (value: string) => String(value || '').toLowerCase().trim().replace(/\s+/g, ' ');

async function ads(base44: any, accountId: string, operation: string, method: string, path: string, payload: any, contentType: string) {
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

function extract(data: any, group: string, field: string) {
  const payload = data?.payload || data || {};
  return payload?.[group]?.success?.[0]?.[field]
    || payload?.success?.[0]?.[field]
    || payload?.[group]?.[0]?.[field]
    || (Array.isArray(payload) ? payload[0]?.[field] : null);
}

function listOf(data: any, key: string) {
  const payload = data?.payload || data || {};
  if (Array.isArray(payload?.[key])) return payload[key];
  if (Array.isArray(payload)) return payload;
  return [];
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });
    if (!body.amazon_account_id || !body.asin || !String(body.keyword || '').trim()) return Response.json({ ok: false, error: 'Conta, ASIN e termo obrigatórios' }, { status: 400 });

    const accountId = body.amazon_account_id;
    const asin = String(body.asin);
    const keyword = String(body.keyword).trim();
    const bid = Math.max(0.25, Number(body.bid || 0.5));
    const budget = Math.max(5, Number(body.budget || 5));
    const now = new Date().toISOString();
    const clean = keyword.replace(/[^a-z0-9\sáéíóúâêôãõç-]/gi, '').trim().slice(0, 40);
    const name = `SP | MANUAL | EXACT | ${asin} | ${clean}`.slice(0, 128);

    const existing = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId, asin, name }, '-created_date', 1).catch(() => []);
    if (existing[0]) {
      const repair = await base44.asServiceRole.functions.invoke('repairExactAdGroupKeywords', { amazon_account_id: accountId, asins: [asin], _window_execution: true, _service_role: true });
      const data = repair?.data || repair || {};
      const complete = data?.results?.some((item: any) => item.campaign_id === String(existing[0].campaign_id) && item.complete === true);
      return Response.json({ ok: complete, already_exists: true, campaign_id: existing[0].campaign_id, keyword, completion_status: complete ? 'complete' : 'incomplete', repair: data });
    }

    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId, asin }, '-updated_at', 1).catch(() => []);
    const product = products[0] || {};

    const campaignResponse = await ads(base44, accountId, 'createManualCampaignV2', 'POST', '/sp/campaigns', {
      campaigns: [{ name, targetingType: 'MANUAL', state: 'ENABLED', budget: { budgetType: 'DAILY', budget }, startDate: now.slice(0, 10) }],
    }, 'application/vnd.spCampaign.v3+json');
    const campaignId = extract(campaignResponse, 'campaigns', 'campaignId');
    if (!campaignId) return Response.json({ ok: false, completion_status: 'incomplete', error: campaignResponse?.errors?.[0]?.message || 'Amazon não retornou campaignId' });

    await wait(14000);
    const adGroupResponse = await ads(base44, accountId, 'createManualAdGroupV2', 'POST', '/sp/adGroups', {
      adGroups: [{ name: `AG | EXACT | ${asin}`, campaignId, defaultBid: bid, state: 'ENABLED' }],
    }, 'application/vnd.spAdGroup.v3+json');
    const adGroupId = extract(adGroupResponse, 'adGroups', 'adGroupId');
    if (!adGroupId) return Response.json({ ok: false, completion_status: 'incomplete', campaign_id: String(campaignId), error: adGroupResponse?.errors?.[0]?.message || 'Amazon não retornou adGroupId' });

    await wait(14000);
    const productAdResponse = await ads(base44, accountId, 'createManualProductAdV2', 'POST', '/sp/productAds', {
      productAds: [{ campaignId, adGroupId, ...(product?.sku || body.sku ? { sku: product?.sku || body.sku } : { asin }), state: 'ENABLED' }],
    }, 'application/vnd.spProductAd.v3+json');
    if (!productAdResponse?.ok && productAdResponse?.status !== 207) return Response.json({ ok: false, completion_status: 'incomplete', campaign_id: String(campaignId), ad_group_id: String(adGroupId), error: productAdResponse?.errors?.[0]?.message || 'Falha ao criar anúncio do produto' });

    await wait(14000);
    const keywordResponse = await ads(base44, accountId, 'createExactKeywordV2', 'POST', '/sp/keywords', {
      keywords: [{ campaignId, adGroupId, keywordText: keyword, matchType: 'EXACT', state: 'ENABLED', bid: { value: bid, bidType: 'DEFAULT' } }],
    }, 'application/vnd.spKeyword.v3+json');
    const keywordId = extract(keywordResponse, 'keywords', 'keywordId');
    if (!keywordId && !keywordResponse?.ok) return Response.json({ ok: false, completion_status: 'incomplete', campaign_id: String(campaignId), ad_group_id: String(adGroupId), error: keywordResponse?.errors?.[0]?.message || 'Falha ao criar palavra-chave exata' });

    await wait(14000);
    const verification = await ads(base44, accountId, 'verifyExactKeywordAfterCreate', 'POST', '/sp/keywords/list', {
      campaignIdFilter: [String(campaignId)],
      adGroupIdFilter: [String(adGroupId)],
      stateFilter: { include: ['ENABLED'] },
      matchTypeFilter: ['EXACT'],
      maxResults: 100,
    }, 'application/vnd.spKeyword.v3+json');
    const activeKeywords = listOf(verification, 'keywords').filter((item: any) => String(item.state || '').toUpperCase() === 'ENABLED');
    const complete = activeKeywords.length > 0;

    const localCampaign = await base44.asServiceRole.entities.Campaign.create({ amazon_account_id: accountId, campaign_id: String(campaignId), asin, sku: product?.sku || body.sku || null, name, campaign_name: name, campaign_type: 'SP', targeting_type: 'MANUAL', state: 'enabled', status: complete ? 'enabled' : 'incomplete', daily_budget: budget, created_by_app: true, learning_eligible: true, launch_phase: 'new', completion_status: complete ? 'complete' : 'incomplete', is_incomplete: !complete, keyword_count: activeKeywords.length, ad_group_id: String(adGroupId), created_at: now, synced_at: now });

    await base44.asServiceRole.entities.Keyword.create({ amazon_account_id: accountId, campaign_id: String(campaignId), ad_group_id: String(adGroupId), keyword_id: keywordId ? String(keywordId) : `kw_${Date.now()}`, asin, keyword_text: keyword, keyword, match_type: 'exact', state: complete ? 'enabled' : 'pending', status: complete ? 'enabled' : 'pending', current_bid: bid, bid, source: 'manual_v2', first_seen_at: now, last_seen_at: now, synced_at: now });

    const termRows = await base44.asServiceRole.entities.TermBank.filter({ amazon_account_id: accountId, asin, normalized_term: norm(keyword) }, '-updated_at', 1).catch(() => []);
    const termPayload = { amazon_account_id: accountId, asin, term: keyword, normalized_term: norm(keyword), status: complete ? 'active' : 'learning', classification: complete ? 'winner' : 'new', source: 'manual_v2', active_campaign_id: complete ? String(campaignId) : null, last_used_at: now };
    if (termRows[0]) await base44.asServiceRole.entities.TermBank.update(termRows[0].id, termPayload);
    else await base44.asServiceRole.entities.TermBank.create(termPayload);

    if (!complete) {
      await base44.asServiceRole.entities.KeywordRepairQueue.create({ amazon_account_id: accountId, asin, campaign_id: String(campaignId), ad_group_id: String(adGroupId), status: 'scheduled', queue_hour: 13, queue_window: '13:00-14:00', scheduled_at: new Date().toISOString(), attempt_count: 0 }).catch(() => {});
    }

    return Response.json({ ok: complete, completion_status: complete ? 'complete' : 'incomplete', keyword, campaign_id: String(campaignId), ad_group_id: String(adGroupId), keyword_id: keywordId ? String(keywordId) : null, active_keywords: activeKeywords.length, repair_scheduled: !complete, spacing_seconds: 14, local_campaign_id: localCampaign?.id || null });
  } catch (error) {
    return Response.json({ ok: false, completion_status: 'incomplete', error: error?.message || 'Erro ao criar campanha manual V2' }, { status: 500 });
  }
});
