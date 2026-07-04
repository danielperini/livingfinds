import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms:number) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (value:any) => String(value || '').toLowerCase().trim().replace(/\s+/g, ' ');

function brazilHour() {
  const parts = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === 'hour')?.value || 0);
}

function inWindow() { return [0, 1, 2, 3, 13].includes(brazilHour()); }

async function ads(base44:any, accountId:string, operation:string, method:string, path:string, payload:any, contentType='application/json') {
  const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
    amazon_account_id: accountId, operation, method, path, payload,
    content_type: contentType, accept: contentType, _service_role: true,
  });
  return response?.data || response || {};
}

function idFrom(data:any, group:string, field:string) {
  const payload = data?.payload || data || {};
  return payload?.[group]?.success?.[0]?.[field]
    || payload?.success?.[0]?.[field]
    || payload?.[group]?.[0]?.[field]
    || (Array.isArray(payload) ? payload[0]?.[field] : null);
}

function campaignName(asin:string, keyword:string) {
  const clean = keyword.replace(/[^a-z0-9\sáéíóúâêôãõç-]/gi, '').trim().slice(0, 40);
  return `SP | MANUAL | EXACT | ${asin} | ${clean}`.slice(0, 128);
}

async function ensureTerm(base44:any, accountId:string, asin:string, keyword:string, campaignId:string|null) {
  const existing = await base44.asServiceRole.entities.TermBank.filter({ amazon_account_id: accountId, asin, normalized_term: norm(keyword) }, '-updated_at', 1).catch(() => []);
  const payload = {
    amazon_account_id: accountId, asin, term: keyword, normalized_term: norm(keyword),
    status: 'active', classification: 'winner', source: 'keyword_suggestion_95',
    active_campaign_id: campaignId, last_used_at: new Date().toISOString(),
  };
  if (existing[0]) await base44.asServiceRole.entities.TermBank.update(existing[0].id, payload);
  else await base44.asServiceRole.entities.TermBank.create(payload);
}

async function createManual(base44:any, account:any, product:any, asin:string, keyword:string, bid:number, budget:number) {
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

  await base44.asServiceRole.entities.Campaign.create({
    amazon_account_id: accountId, campaign_id: String(campaignId), asin, sku: product?.sku || null,
    name, campaign_name: name, campaign_type: 'SP', targeting_type: 'MANUAL', state: 'enabled', status: 'enabled',
    daily_budget: budget, created_by_app: true, learning_eligible: true, launch_phase: 'new', created_at: now, synced_at: now,
  });
  await base44.asServiceRole.entities.Keyword.create({
    amazon_account_id: accountId, campaign_id: String(campaignId), ad_group_id: String(adGroupId),
    keyword_id: keywordId ? String(keywordId) : `kw_${Date.now()}`, asin, keyword_text: keyword, keyword,
    match_type: 'exact', state: 'enabled', status: 'enabled', current_bid: bid, bid,
    source: 'keyword_suggestion_95', first_seen_at: now, last_seen_at: now, synced_at: now,
  });
  await ensureTerm(base44, accountId, asin, keyword, String(campaignId));
  return { ok: true, keyword, campaign_id: String(campaignId), ad_group_id: String(adGroupId), keyword_id: keywordId ? String(keywordId) : null };
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    const body = await request.json().catch(() => ({}));
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const accountId = body.amazon_account_id;
    const asin = String(body.asin || '').trim().toUpperCase();
    if (!accountId || !asin) return Response.json({ ok: false, error: 'amazon_account_id e asin são obrigatórios' }, { status: 400 });

    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId, asin }, '-updated_at', 1);
    const product = products[0];
    if (!product) return Response.json({ ok: false, blocked: true, error: 'Produto não encontrado no banco do app.' }, { status: 404 });
    if (product.inventory_status === 'out_of_stock' || Number(product.fba_inventory || 0) <= 0) {
      return Response.json({ ok: false, blocked: true, error: 'Produto sem estoque — Kick-off bloqueado' });
    }
    if (product.cost_confirmed !== true || product.cost_confirmation_required === true) {
      return Response.json({
        ok: false, blocked: true, reason: 'cost_confirmation_required',
        error: 'Confirme o custo do produto e o custo extra antes de criar campanhas.',
        product_id: product.id, asin, product_cost: product.product_cost ?? null, extra_cost: product.extra_cost ?? 0,
      }, { status: 409 });
    }

    const price = Number(product.buy_box_price || product.price || 0);
    const productCost = Number(product.product_cost || 0);
    const extraCost = Number(product.extra_cost || 0);
    const amazonFees = Number(product.amazon_fees || 0);
    const availableProfit = Math.max(0, Number((price - productCost - extraCost - amazonFees).toFixed(2)));
    if (price <= 0 || availableProfit <= 0) {
      return Response.json({
        ok: false, blocked: true, reason: 'no_available_profit',
        error: 'Campanhas bloqueadas: preço ou lucro disponível por venda é insuficiente.',
        price, product_cost: productCost, extra_cost: extraCost, amazon_fees: amazonFees, available_profit_per_sale: availableProfit,
      }, { status: 409 });
    }

    const breakEvenAcos = Number(((availableProfit / price) * 100).toFixed(2));
    const maxAdSpendPerOrder = availableProfit;
    const budget = Math.max(1, Math.min(5, Number((availableProfit * 0.30).toFixed(2))));
    const bid = Math.max(0.10, Math.min(0.50, Number((availableProfit * 0.10).toFixed(2))));
    await base44.asServiceRole.entities.Product.update(product.id, {
      contribution_margin: availableProfit,
      available_profit_per_sale: availableProfit,
      maximum_ad_spend_per_order: maxAdSpendPerOrder,
      break_even_acos_pct: breakEvenAcos,
      profit_margin_pct: breakEvenAcos,
      auto_campaign_eligible: true,
    });

    if (!body._window_execution && !inWindow()) {
      const response = await base44.functions.invoke('scheduleProductKickoff', {
        amazon_account_id: accountId, asin, sku: product.sku, product_name: product.product_name || product.display_name || asin, mode: 'auto_plus_four',
      });
      return Response.json({ ...(response?.data || response || {}), profitability_guard: { available_profit_per_sale: availableProfit, maximum_ad_spend_per_order: maxAdSpendPerOrder, break_even_acos_pct: breakEvenAcos, initial_budget: budget, initial_bid: bid } });
    }

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });

    const existingCampaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId, asin }, '-created_date', 200);
    let autoCampaign = existingCampaigns.find((campaign:any) => String(campaign.targeting_type || '').toUpperCase() === 'AUTO' && !campaign.archived && !['archived', 'ended'].includes(String(campaign.state || campaign.status).toLowerCase()));

    if (!autoCampaign) {
      const now = new Date().toISOString();
      const name = `AUTO | ${asin} | ${now.slice(0, 10)}`;
      const response = await ads(base44, accountId, 'createAutoCampaign', 'POST', '/sp/campaigns', {
        campaigns: [{ name, targetingType: 'AUTO', state: 'ENABLED', budget: { budgetType: 'DAILY', budget }, startDate: now.slice(0, 10) }],
      }, 'application/vnd.spCampaign.v3+json');
      const campaignId = idFrom(response, 'campaigns', 'campaignId');
      if (!campaignId) return Response.json({ ok: false, error: response?.errors?.[0]?.message || 'Amazon não retornou campaignId da AUTO' });

      await wait(14000);
      const adGroupResponse = await ads(base44, accountId, 'createAutoAdGroup', 'POST', '/sp/adGroups', {
        adGroups: [{ name: `AG | AUTO | ${asin}`, campaignId, defaultBid: bid, state: 'ENABLED' }],
      }, 'application/vnd.spAdGroup.v3+json');
      const adGroupId = idFrom(adGroupResponse, 'adGroups', 'adGroupId');
      if (adGroupId) {
        await wait(14000);
        await ads(base44, accountId, 'createAutoProductAd', 'POST', '/sp/productAds', {
          productAds: [{ campaignId, adGroupId, ...(product?.sku ? { sku: product.sku } : { asin }), state: 'ENABLED' }],
        }, 'application/vnd.spProductAd.v3+json');
      }
      autoCampaign = await base44.asServiceRole.entities.Campaign.create({
        amazon_account_id: accountId, campaign_id: String(campaignId), asin, sku: product.sku || null,
        name, campaign_name: name, campaign_type: 'SP', targeting_type: 'AUTO', state: 'enabled', status: 'enabled',
        daily_budget: budget, created_by_app: true, launch_phase: 'new', created_at: now, synced_at: now,
      });
    }

    const existingKeywords = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-created_date', 2000);
    const campaignIds = new Set(existingCampaigns.map((campaign:any) => String(campaign.campaign_id)));
    const existingTerms = new Set(existingKeywords.filter((keyword:any) => campaignIds.has(String(keyword.campaign_id)) && String(keyword.match_type).toLowerCase() === 'exact').map((keyword:any) => norm(keyword.keyword_text || keyword.keyword)));

    const threshold = Math.max(0.95, Number(product.keyword_confidence_threshold || 0.95));
    const suggestions = await base44.asServiceRole.entities.KeywordSuggestion.filter({ amazon_account_id: accountId, asin }, '-confidence', 200).catch(() => []);
    const selected:any[] = [];
    for (const suggestion of suggestions) {
      const keyword = String(suggestion.keyword || '').trim();
      const confidence = Number(suggestion.confidence || 0);
      const matchType = String(suggestion.match_type || 'exact').toLowerCase();
      const status = String(suggestion.status || 'suggested').toLowerCase();
      if (!keyword || confidence < threshold || matchType !== 'exact') continue;
      if (['rejected', 'archived', 'blocked'].includes(status) || existingTerms.has(norm(keyword))) continue;
      if (selected.some((item) => norm(item.keyword) === norm(keyword))) continue;
      selected.push({ keyword, confidence, suggestion_id: suggestion.id });
      if (selected.length >= 4) break;
    }

    const manualCampaigns:any[] = [];
    if (selected.length >= 4) {
      for (const item of selected.slice(0, 4)) {
        try {
          const created = await createManual(base44, account, product, asin, item.keyword, bid, budget);
          manualCampaigns.push({ ...created, confidence: item.confidence, suggestion_id: item.suggestion_id });
          await base44.asServiceRole.entities.KeywordSuggestion.update(item.suggestion_id, { status: 'applied' }).catch(() => {});
        } catch (error) {
          manualCampaigns.push({ ok: false, keyword: item.keyword, confidence: item.confidence, error: error?.message || String(error) });
        }
        await wait(14000);
      }
    }

    return Response.json({
      ok: true, asin,
      auto_campaign: { ok: true, campaign_id: autoCampaign.campaign_id, already_exists: Boolean(existingCampaigns.find((campaign:any) => campaign.id === autoCampaign.id)) },
      manual_campaigns_created: manualCampaigns.filter((item) => item.ok).length,
      manual_campaigns_failed: manualCampaigns.filter((item) => !item.ok).length,
      manual_campaigns_waiting_for_confidence: selected.length < 4,
      high_confidence_keywords_found: selected.length,
      required_confidence: threshold,
      manual_campaigns: manualCampaigns,
      profitability_guard: { price, product_cost: productCost, extra_cost: extraCost, amazon_fees: amazonFees, available_profit_per_sale: availableProfit, maximum_ad_spend_per_order: maxAdSpendPerOrder, break_even_acos_pct: breakEvenAcos, initial_budget: budget, initial_bid: bid },
      spacing_seconds: 14, gateway: true,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro no Kick-off V2' }, { status: 500 });
  }
});
