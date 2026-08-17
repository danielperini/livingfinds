import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const MIN_ACTIVE_MANUAL = 6;
const REVIEW_HOURS = 72;
const MAX_BID_RECOVERIES = 2;
const MAX_BID_INCREASE_PCT = 0.20;
const DEFAULT_MIN_BID = 0.25;
const DEFAULT_MAX_BID = 0.70;
const DEFAULT_BUDGET = 5;
const AMAZON_PROPAGATION_MS = 14000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (value: unknown) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const upper = (value: unknown) => String(value || '').trim().toUpperCase();
const number = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const enabled = (value: unknown) => ['ENABLED', 'ACTIVE'].includes(upper(value));

function hoursSince(value: unknown): number {
  const ts = new Date(String(value || 0)).getTime();
  return Number.isFinite(ts) && ts > 0 ? (Date.now() - ts) / 3600000 : Number.POSITIVE_INFINITY;
}

function amazonId(value: any): string {
  return String(value?.campaign_id || value?.amazon_campaign_id || value?.keyword_id || value?.amazon_keyword_id || value?.id || '');
}

function responseId(data: any, group: string, field: string): string | null {
  const payload = data?.payload || data || {};
  return payload?.[group]?.success?.[0]?.[field]
    || payload?.success?.[0]?.[field]
    || payload?.[group]?.[0]?.[field]
    || (Array.isArray(payload) ? payload[0]?.[field] : null)
    || null;
}

async function ads(base44: any, accountId: string, operation: string, method: string, path: string, payload: any, contentType: string) {
  const result = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
    amazon_account_id: accountId,
    operation,
    method,
    path,
    payload,
    content_type: contentType,
    accept: contentType,
    _service_role: true,
  });
  const data = result?.data || result || {};
  const status = number(data.status || data.amazon_status);
  const ok = data.ok === true || (status >= 200 && status < 300);
  if (!ok) {
    const message = data?.amazon_error || data?.error || data?.message || `${operation} falhou`;
    const error: any = new Error(message);
    error.status = status;
    error.payload = data;
    throw error;
  }
  return data;
}

async function list(entity: any, filters: Record<string, unknown>, sort = '-created_date', limit = 5000) {
  return entity?.filter ? entity.filter(filters, sort, limit).catch(() => []) : [];
}

async function createDecision(base44: any, payload: any) {
  const prior = await list(base44.asServiceRole.entities.OptimizationDecision, {
    amazon_account_id: payload.amazon_account_id,
    idempotency_key: payload.idempotency_key,
  }, '-created_at', 1);
  if (prior.length) return prior[0];
  return base44.asServiceRole.entities.OptimizationDecision.create(payload);
}

function campaignName(asin: string, term: string) {
  const clean = String(term || '').replace(/[^a-z0-9\sáéíóúâêôãõç-]/gi, '').trim().slice(0, 45);
  return `SP | MANUAL | EXACT | ${asin} | ${clean}`.slice(0, 128);
}

function productIsActive(product: any): boolean {
  const status = norm(product.status || product.listing_status || product.offer_status || product.inventory_status);
  const stock = number(product.fba_inventory ?? product.fulfillable_quantity ?? product.stock_quantity ?? product.inventory);
  const inactive = ['inactive', 'closed', 'deleted', 'suppressed', 'out_of_stock', 'inativo', 'sem estoque'];
  return Boolean(product.asin) && stock > 0 && !inactive.includes(status);
}

function manualExactCampaign(campaign: any): boolean {
  const targeting = upper(campaign.targeting_type || campaign.targetingType);
  const name = upper(campaign.name || campaign.campaign_name);
  const state = campaign.state || campaign.status;
  return enabled(state) && (targeting === 'MANUAL' || name.includes('MANUAL')) && (name.includes('EXACT') || !campaign.match_type || upper(campaign.match_type) === 'EXACT');
}

function campaignMatchesProduct(campaign: any, product: any): boolean {
  const asin = upper(product.asin);
  const sku = upper(product.sku);
  const campaignAsin = upper(campaign.asin || campaign.product_asin || campaign.advertised_asin);
  const campaignSku = upper(campaign.sku || campaign.product_sku);
  return campaignAsin === asin || Boolean(sku && campaignSku === sku);
}

async function updateKeywordBid(base44: any, accountId: string, keyword: any, campaign: any, bid: number, idempotencyKey: string) {
  const keywordId = String(keyword.keyword_id || keyword.amazon_keyword_id || keyword.id || '');
  const campaignId = String(campaign.campaign_id || campaign.amazon_campaign_id || campaign.id || '');
  if (!keywordId || !campaignId) throw new Error('Keyword ou campanha sem ID Amazon para alteração de bid.');

  const result = await ads(base44, accountId, 'recoverZeroClickKeywordBid', 'PUT', '/sp/keywords', {
    keywords: [{ keywordId, campaignId, state: 'ENABLED', bid: { value: bid, bidType: 'DEFAULT' } }],
    idempotencyKey,
  }, 'application/vnd.spKeyword.v3+json');

  await base44.asServiceRole.entities.Keyword.update(keyword.id, {
    current_bid: bid,
    bid,
    last_bid_change_at: new Date().toISOString(),
    last_bid_change_reason: 'zero_click_recovery',
    synced_at: new Date().toISOString(),
  }).catch(() => {});
  return result;
}

async function createManualExact(base44: any, account: any, product: any, term: string, bid: number, budget: number, idempotencyKey: string) {
  const accountId = account.id;
  const asin = upper(product.asin);
  const now = new Date().toISOString();
  const name = campaignName(asin, term);

  const existingCampaigns = await list(base44.asServiceRole.entities.Campaign, { amazon_account_id: accountId, asin }, '-created_date', 1000);
  const duplicate = existingCampaigns.find((campaign: any) => {
    const campaignTerm = norm(campaign.keyword_text || campaign.keyword || String(campaign.name || campaign.campaign_name).split('|').pop());
    return manualExactCampaign(campaign) && campaignTerm === norm(term);
  });
  if (duplicate) return { ok: true, already_exists: true, campaign_id: amazonId(duplicate), term };

  const campaignResult = await ads(base44, accountId, 'createZeroClickReplacementCampaign', 'POST', '/sp/campaigns', {
    campaigns: [{
      name,
      targetingType: 'MANUAL',
      state: 'ENABLED',
      budget: { budgetType: 'DAILY', budget },
      startDate: now.slice(0, 10),
    }],
    idempotencyKey,
  }, 'application/vnd.spCampaign.v3+json');
  const campaignId = responseId(campaignResult, 'campaigns', 'campaignId');
  if (!campaignId) throw new Error('Amazon não confirmou campaignId da campanha substituta.');

  await wait(AMAZON_PROPAGATION_MS);
  const adGroupResult = await ads(base44, accountId, 'createZeroClickReplacementAdGroup', 'POST', '/sp/adGroups', {
    adGroups: [{ name: `AG | EXACT | ${asin}`, campaignId, defaultBid: bid, state: 'ENABLED' }],
  }, 'application/vnd.spAdGroup.v3+json');
  const adGroupId = responseId(adGroupResult, 'adGroups', 'adGroupId');
  if (!adGroupId) throw new Error('Amazon não confirmou adGroupId da campanha substituta.');

  await wait(AMAZON_PROPAGATION_MS);
  const productAdResult = await ads(base44, accountId, 'createZeroClickReplacementProductAd', 'POST', '/sp/productAds', {
    productAds: [{ campaignId, adGroupId, ...(product.sku ? { sku: product.sku } : { asin }), state: 'ENABLED' }],
  }, 'application/vnd.spProductAd.v3+json');
  const productAdId = responseId(productAdResult, 'productAds', 'adId') || responseId(productAdResult, 'productAds', 'productAdId');
  if (!productAdId) throw new Error('Amazon não confirmou Product Ad da campanha substituta.');

  await wait(AMAZON_PROPAGATION_MS);
  const keywordResult = await ads(base44, accountId, 'createZeroClickReplacementKeyword', 'POST', '/sp/keywords', {
    keywords: [{ campaignId, adGroupId, keywordText: term, matchType: 'EXACT', state: 'ENABLED', bid: { value: bid, bidType: 'DEFAULT' } }],
  }, 'application/vnd.spKeyword.v3+json');
  const keywordId = responseId(keywordResult, 'keywords', 'keywordId');
  if (!keywordId) throw new Error('Amazon não confirmou keyword EXACT da campanha substituta.');

  const localCampaign = await base44.asServiceRole.entities.Campaign.create({
    amazon_account_id: accountId,
    campaign_id: String(campaignId),
    amazon_campaign_id: String(campaignId),
    asin,
    sku: product.sku || null,
    name,
    campaign_name: name,
    campaign_type: 'SP',
    targeting_type: 'MANUAL',
    match_type: 'exact',
    state: 'enabled',
    status: 'enabled',
    daily_budget: budget,
    created_by_app: true,
    structure_complete: true,
    amazon_confirmed: true,
    completion_status: 'complete',
    lifecycle_state: 'complete',
    idempotency_key: idempotencyKey,
    created_at: now,
    synced_at: now,
  });

  await base44.asServiceRole.entities.Keyword.create({
    amazon_account_id: accountId,
    campaign_id: String(campaignId),
    ad_group_id: String(adGroupId),
    keyword_id: String(keywordId),
    asin,
    keyword_text: term,
    keyword: term,
    match_type: 'exact',
    state: 'enabled',
    status: 'enabled',
    current_bid: bid,
    bid,
    source: 'zero_click_replacement',
    idempotency_key: `${idempotencyKey}|keyword`,
    first_seen_at: now,
    last_seen_at: now,
    synced_at: now,
  });

  return { ok: true, confirmed: true, campaign_id: String(campaignId), ad_group_id: String(adGroupId), product_ad_id: String(productAdId), keyword_id: String(keywordId), local_campaign_id: localCampaign.id, term };
}

async function pauseCampaign(base44: any, accountId: string, campaign: any, reason: string) {
  const campaignId = String(campaign.campaign_id || campaign.amazon_campaign_id || campaign.id || '');
  if (!campaignId) throw new Error('Campanha antiga sem ID Amazon para pausa.');
  const result = await ads(base44, accountId, 'pauseZeroClickCampaign', 'PUT', '/sp/campaigns', {
    campaigns: [{ campaignId, state: 'PAUSED' }],
  }, 'application/vnd.spCampaign.v3+json');
  await base44.asServiceRole.entities.Campaign.update(campaign.id, {
    state: 'paused',
    status: 'paused',
    paused_at: new Date().toISOString(),
    pause_reason: reason,
    synced_at: new Date().toISOString(),
  }).catch(() => {});
  return result;
}

async function selectTerms(base44: any, accountId: string, product: any, excluded: Set<string>, quantity: number) {
  const asin = upper(product.asin);
  const selected: Array<{ term: string; source: string; source_id?: string }> = [];

  const termBank = await list(base44.asServiceRole.entities.TermBank, { amazon_account_id: accountId, asin, status: 'active' }, '-relevance_score', 1000);
  for (const row of termBank) {
    const term = String(row.term || row.keyword || row.normalized_term || '').trim();
    const relevance = number(row.relevance_score ?? row.confidence ?? row.relevance, 1);
    if (!term || excluded.has(norm(term)) || relevance < 0.90) continue;
    selected.push({ term, source: 'TermBank', source_id: row.id });
    excluded.add(norm(term));
    if (selected.length >= quantity) return selected;
  }

  const suggestions = await list(base44.asServiceRole.entities.KeywordSuggestion, { amazon_account_id: accountId, asin }, '-confidence', 1000);
  for (const row of suggestions) {
    const term = String(row.keyword || row.term || '').trim();
    const confidence = number(row.confidence ?? row.relevance_score, 0);
    const status = norm(row.status || 'suggested');
    if (!term || excluded.has(norm(term)) || confidence < 0.90 || ['rejected', 'archived', 'blocked'].includes(status)) continue;
    selected.push({ term, source: 'AmazonAdsSuggestions', source_id: row.id });
    excluded.add(norm(term));
    if (selected.length >= quantity) return selected;
  }

  return selected;
}

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  const base44 = createClientFromRequest(req);
  const body = await req.json().catch(() => ({}));

  if (!body._service_role) {
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
  }

  const accounts = body.amazon_account_id
    ? await list(base44.asServiceRole.entities.AmazonAccount, { id: body.amazon_account_id }, '-created_date', 1)
    : await list(base44.asServiceRole.entities.AmazonAccount, { status: 'connected' }, '-created_date', 50);

  const summary: any = {
    ok: true,
    started_at: startedAt,
    accounts: 0,
    active_skus: 0,
    campaigns_checked: 0,
    bids_adjusted: 0,
    campaigns_replaced: 0,
    campaigns_created_for_floor: 0,
    deficits_remaining: 0,
    skipped_no_stock: 0,
    skipped_no_terms: 0,
    errors: [],
  };

  for (const account of accounts) {
    const aid = account.id;
    summary.accounts += 1;
    try {
      const [products, campaigns, keywords, metrics, settingsRows, decisions] = await Promise.all([
        list(base44.asServiceRole.entities.Product, { amazon_account_id: aid }, '-updated_at', 3000),
        list(base44.asServiceRole.entities.Campaign, { amazon_account_id: aid }, '-updated_at', 5000),
        list(base44.asServiceRole.entities.Keyword, { amazon_account_id: aid }, '-updated_at', 10000),
        list(base44.asServiceRole.entities.CampaignMetricsDaily, { amazon_account_id: aid }, '-date', 20000),
        list(base44.asServiceRole.entities.PerformanceSettings, { amazon_account_id: aid }, '-updated_at', 1),
        list(base44.asServiceRole.entities.OptimizationDecision, { amazon_account_id: aid, source_function: 'recoverZeroClickManualCampaigns' }, '-created_at', 10000),
      ]);

      const settings = settingsRows[0] || {};
      const minBid = Math.max(0.10, number(settings.min_bid, DEFAULT_MIN_BID));
      const maxBid = Math.max(minBid, number(settings.max_bid, DEFAULT_MAX_BID));
      const maxIncrease = Math.min(MAX_BID_INCREASE_PCT, Math.max(0.01, number(settings.max_bid_increase_pct, MAX_BID_INCREASE_PCT)));
      const budget = Math.max(1, number(settings.minimum_campaign_budget, DEFAULT_BUDGET));

      const metricsByCampaign = new Map<string, any>();
      for (const row of metrics) {
        const id = String(row.campaign_id || row.amazon_campaign_id || '');
        if (!id) continue;
        const current = metricsByCampaign.get(id) || { clicks: 0, impressions: 0, orders: 0, sales: 0, spend: 0 };
        current.clicks += number(row.clicks);
        current.impressions += number(row.impressions);
        current.orders += number(row.orders || row.purchases);
        current.sales += number(row.sales || row.attributed_sales);
        current.spend += number(row.spend || row.cost);
        metricsByCampaign.set(id, current);
      }

      const keywordsByCampaign = new Map<string, any[]>();
      for (const keyword of keywords) {
        const id = String(keyword.campaign_id || '');
        if (!id) continue;
        const rows = keywordsByCampaign.get(id) || [];
        rows.push(keyword);
        keywordsByCampaign.set(id, rows);
      }

      const activeProducts = products.filter(productIsActive);
      summary.active_skus += activeProducts.length;
      summary.skipped_no_stock += products.length - activeProducts.length;

      for (const product of activeProducts) {
        const asin = upper(product.asin);
        const sku = String(product.sku || '').trim();
        const productCampaigns = campaigns.filter((campaign: any) => campaignMatchesProduct(campaign, product));
        const activeManuals = productCampaigns.filter(manualExactCampaign);
        const exactTerms = new Set<string>();
        const completeManuals: any[] = [];

        for (const campaign of activeManuals) {
          const campaignId = String(campaign.campaign_id || campaign.amazon_campaign_id || campaign.id || '');
          const exactKeyword = (keywordsByCampaign.get(campaignId) || []).find((keyword: any) => enabled(keyword.state || keyword.status) && upper(keyword.match_type || keyword.matchType) === 'EXACT');
          if (!exactKeyword) continue;
          exactTerms.add(norm(exactKeyword.keyword_text || exactKeyword.keyword));
          completeManuals.push({ campaign, keyword: exactKeyword });
        }

        for (const item of completeManuals) {
          summary.campaigns_checked += 1;
          const campaign = item.campaign;
          const keyword = item.keyword;
          const campaignId = String(campaign.campaign_id || campaign.amazon_campaign_id || campaign.id || '');
          const agg = metricsByCampaign.get(campaignId) || { clicks: 0, impressions: 0, orders: 0, sales: 0, spend: 0 };
          if (agg.clicks > 0 || agg.orders > 0 || agg.sales > 0) continue;
          if (hoursSince(campaign.start_date || campaign.created_at || campaign.created_date) < REVIEW_HOURS) continue;

          const prior = decisions.filter((d: any) => String(d.campaign_id || d.entity_id || '') === campaignId);
          const recoveries = prior.filter((d: any) => norm(d.decision_type) === 'zero_click_bid_recovery' && !['failed', 'error', 'cancelled'].includes(norm(d.status)));
          const latestRecovery = [...recoveries].sort((a: any, b: any) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())[0];

          if (recoveries.length < MAX_BID_RECOVERIES) {
            if (latestRecovery && hoursSince(latestRecovery.created_at || latestRecovery.created_date) < REVIEW_HOURS) continue;
            const currentBid = Math.max(minBid, number(keyword.current_bid ?? keyword.bid ?? campaign.default_bid, minBid));
            const suggestedLow = number(keyword.suggested_bid_low ?? keyword.suggestedBidLow);
            const candidate = suggestedLow > currentBid ? Math.min(suggestedLow, currentBid * (1 + maxIncrease)) : currentBid * (1 + maxIncrease);
            const nextBid = Math.round(Math.min(maxBid, Math.max(currentBid + 0.02, candidate)) * 100) / 100;
            if (nextBid <= currentBid) continue;
            const key = `zero_click_bid_recovery|${aid}|${campaignId}|${recoveries.length + 1}`;
            const existing = await list(base44.asServiceRole.entities.OptimizationDecision, { amazon_account_id: aid, idempotency_key: key }, '-created_at', 1);
            if (existing.length) continue;

            try {
              const amazonResponse = await updateKeywordBid(base44, aid, keyword, campaign, nextBid, key);
              await createDecision(base44, {
                amazon_account_id: aid,
                campaign_id: campaignId,
                keyword_id: keyword.keyword_id || keyword.id,
                asin,
                sku,
                decision_type: 'zero_click_bid_recovery',
                action: 'increase_bid',
                status: 'confirmed',
                value_before: currentBid,
                value_after: nextBid,
                reason: `Campanha manual EXACT sem clique após ${Math.floor(hoursSince(campaign.created_at || campaign.created_date) / 24)} dias; recuperação ${recoveries.length + 1}/${MAX_BID_RECOVERIES}.`,
                source_function: 'recoverZeroClickManualCampaigns',
                idempotency_key: key,
                next_evaluation_at: new Date(Date.now() + REVIEW_HOURS * 3600000).toISOString(),
                created_at: new Date().toISOString(),
                amazon_response: JSON.stringify(amazonResponse),
              });
              summary.bids_adjusted += 1;
            } catch (error: any) {
              summary.errors.push({ asin, campaign_id: campaignId, stage: 'increase_bid', status: error.status || 0, error: error.message });
            }
            continue;
          }

          if (latestRecovery && hoursSince(latestRecovery.created_at || latestRecovery.created_date) < REVIEW_HOURS) continue;
          const oldTerm = String(keyword.keyword_text || keyword.keyword || '').trim();
          const key = `zero_click_replace|${aid}|${asin}|${campaignId}|${norm(oldTerm)}`;
          const existing = await list(base44.asServiceRole.entities.OptimizationDecision, { amazon_account_id: aid, idempotency_key: key }, '-created_at', 1);
          if (existing.length) continue;

          const candidates = await selectTerms(base44, aid, product, new Set(exactTerms), 1);
          if (!candidates.length) {
            summary.skipped_no_terms += 1;
            continue;
          }

          const candidate = candidates[0];
          try {
            const currentBid = Math.max(minBid, Math.min(maxBid, number(keyword.current_bid ?? keyword.bid, minBid)));
            const replacement = await createManualExact(base44, account, product, candidate.term, currentBid, budget, key);
            if (!replacement.confirmed && !replacement.already_exists) throw new Error('Substituta não confirmada pela Amazon.');
            await pauseCampaign(base44, aid, campaign, `Substituída por ${candidate.term} após duas recuperações sem clique.`);
            exactTerms.add(norm(candidate.term));
            await createDecision(base44, {
              amazon_account_id: aid,
              campaign_id: campaignId,
              asin,
              sku,
              decision_type: 'zero_click_replace',
              action: 'replace_manual_exact_campaign',
              status: 'confirmed',
              old_term: oldTerm,
              new_term: candidate.term,
              reason: 'Campanha sem clique após duas recuperações de bid e duas janelas de 72 horas.',
              source_function: 'recoverZeroClickManualCampaigns',
              idempotency_key: key,
              created_at: new Date().toISOString(),
              amazon_response: JSON.stringify(replacement),
            });
            if (candidate.source_id && candidate.source === 'AmazonAdsSuggestions') {
              await base44.asServiceRole.entities.KeywordSuggestion.update(candidate.source_id, { status: 'applied' }).catch(() => {});
            }
            summary.campaigns_replaced += 1;
          } catch (error: any) {
            summary.errors.push({ asin, campaign_id: campaignId, stage: 'replace_campaign', status: error.status || 0, error: error.message });
          }
        }

        const refreshedActiveCount = completeManuals.length;
        const deficit = Math.max(0, MIN_ACTIVE_MANUAL - refreshedActiveCount);
        if (deficit <= 0) continue;

        const candidates = await selectTerms(base44, aid, product, exactTerms, deficit);
        for (let index = 0; index < candidates.length; index++) {
          const candidate = candidates[index];
          const key = `manual_exact_floor|${aid}|${asin}|${norm(candidate.term)}`;
          const existing = await list(base44.asServiceRole.entities.OptimizationDecision, { amazon_account_id: aid, idempotency_key: key }, '-created_at', 1);
          if (existing.length) continue;
          try {
            const created = await createManualExact(base44, account, product, candidate.term, minBid, budget, key);
            await createDecision(base44, {
              amazon_account_id: aid,
              campaign_id: created.campaign_id,
              asin,
              sku,
              decision_type: 'manual_exact_floor',
              action: 'create_manual_exact_campaign',
              status: 'confirmed',
              new_term: candidate.term,
              reason: `Garantia canônica de no mínimo ${MIN_ACTIVE_MANUAL} campanhas manuais EXACT ativas para SKU com estoque.`,
              source_function: 'recoverZeroClickManualCampaigns',
              idempotency_key: key,
              created_at: new Date().toISOString(),
              amazon_response: JSON.stringify(created),
            });
            summary.campaigns_created_for_floor += 1;
            exactTerms.add(norm(candidate.term));
            if (candidate.source_id && candidate.source === 'AmazonAdsSuggestions') {
              await base44.asServiceRole.entities.KeywordSuggestion.update(candidate.source_id, { status: 'applied' }).catch(() => {});
            }
          } catch (error: any) {
            summary.errors.push({ asin, stage: 'create_floor_campaign', term: candidate.term, status: error.status || 0, error: error.message });
          }
          await wait(AMAZON_PROPAGATION_MS);
        }
        summary.deficits_remaining += Math.max(0, deficit - candidates.length);
      }
    } catch (error: any) {
      summary.errors.push({ amazon_account_id: aid, stage: 'account', error: error.message });
    }
  }

  summary.ok = summary.errors.length === 0;
  summary.completed_at = new Date().toISOString();
  summary.duration_ms = Date.now() - new Date(startedAt).getTime();
  return Response.json(summary, { status: summary.ok ? 200 : 207 });
});
