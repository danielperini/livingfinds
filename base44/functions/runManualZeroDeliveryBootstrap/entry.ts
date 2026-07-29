import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import {
  BOOTSTRAP_COOLDOWN_HOURS,
  buildBootstrapIdempotencyKey,
  calculateBootstrapBid,
  diagnoseZeroDelivery,
} from '../../shared/manualZeroDeliveryBootstrap.ts';

const norm = (v: any) => String(v || '').trim().toLowerCase();
const fresh = (v: any, hours = 30) => {
  const time = new Date(v || 0).getTime();
  return Number.isFinite(time) && Date.now() - time <= hours * 3600_000;
};
const list = (r: any, key: string) => {
  const data = r?.data?.payload || r?.data || r?.payload || r || {};
  return Array.isArray(data?.[key]) ? data[key] : [];
};
const cid = (c: any) => String(c.amazon_campaign_id || c.campaign_id || '');

async function ads(base44: any, accountId: string, operation: string, path: string, payload: any, contentType: string) {
  const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
    amazon_account_id: accountId, operation, method: 'POST', path, payload,
    content_type: contentType, accept: contentType, max_attempts: 3, _service_role: true,
  });
  return response?.data || response || {};
}

async function updateDiagnosis(base44: any, campaign: any, status: string, reason: string, now: string, dryRun: boolean) {
  if (dryRun) return;
  const next = new Date(Date.now() + (status === 'cooldown' ? BOOTSTRAP_COOLDOWN_HOURS : 24) * 3600_000).toISOString();
  await base44.asServiceRole.entities.Campaign.update(campaign.id, {
    delivery_status: status, delivery_block_reason: reason,
    last_serving_check_at: now, next_delivery_review_at: next,
  }).catch(() => {});
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    const dryRun = body.dry_run === true;
    const now = new Date().toISOString();
    const accountRows = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1).catch(() => [])
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 10).catch(() => []);
    const results: any[] = [];
    const structureReports: any[] = [];

    for (const account of accountRows) {
      const aid = account.id;
      // A estrutura local pode estar incompleta mesmo com Campaign sincronizada.
      // Reconciliar as três entidades canônicas antes do diagnóstico evita tanto
      // falso "zero delivery" quanto bloqueio permanente por dados parciais.
      const [adGroupKeywordSync, productAdSync] = await Promise.all([
        base44.asServiceRole.functions.invoke('syncAdGroupsAndKeywords', {
          amazon_account_id: aid,
          _service_role: true,
        }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } })),
        base44.asServiceRole.functions.invoke('syncProductAds', {
          amazon_account_id: aid,
          _service_role: true,
        }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } })),
      ]);
      const structureSync = {
        ad_groups_keywords: adGroupKeywordSync?.data || adGroupKeywordSync || {},
        product_ads: productAdSync?.data || productAdSync || {},
      };
      structureReports.push({ amazon_account_id: aid, ...structureSync });
      const [campaigns, groups, keywords, adsRows, products, economics, settingsRows] = await Promise.all([
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-updated_at', 1000).catch(() => []),
        base44.asServiceRole.entities.AdGroup.filter({ amazon_account_id: aid }, '-updated_at', 2000).catch(() => []),
        base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.ProductAd.filter({ amazon_account_id: aid }, '-updated_at', 3000).catch(() => []),
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, '-updated_at', 2000).catch(() => []),
        base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, '-updated_at', 2000).catch(() => []),
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1).catch(() => []),
      ]);
      const settings = settingsRows[0] || {};

      for (const campaign of campaigns) {
        const campaignId = cid(campaign);
        if (!campaignId || norm(campaign.campaign_type) !== 'sp' || norm(campaign.targeting_type) !== 'manual') continue;
        const localGroups = groups.filter((g: any) => String(g.campaign_id || g.amazon_campaign_id) === campaignId);
        const localKeywords = keywords.filter((k: any) => String(k.campaign_id) === campaignId && norm(k.match_type) === 'exact');
        const localAds = adsRows.filter((a: any) => String(a.campaign_id) === campaignId);
        const asin = String(campaign.asin || localAds[0]?.asin || '');
        const product = products.find((p: any) => String(p.asin) === asin);
        const eco = economics.find((e: any) => String(e.asin) === asin || (product && String(e.sku) === String(product.sku)));
        const metrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter({
          amazon_account_id: aid, campaign_id: campaignId,
        }, '-date', 2).catch(() => []);
        const newestMetric = metrics[0];
        const metricDate = newestMetric?.date ? new Date(`${newestMetric.date}T23:59:59Z`) : null;
        const metricsFresh = Boolean(metricDate && Date.now() - metricDate.getTime() <= 48 * 3600_000 && fresh(campaign.last_sync_at || campaign.synced_at, 30));

        let remoteCampaign: any = null;
        let remoteGroups: any[] = [];
        let remoteKeywords: any[] = [];
        let remoteAds: any[] = [];
        if (localGroups.length && localKeywords.length && localAds.length && metricsFresh) {
          const [rc, rg, rk, ra] = await Promise.all([
            ads(base44, aid, 'bootstrapConfirmCampaign', '/sp/campaigns/list', { campaignIdFilter: [campaignId], maxResults: 10 }, 'application/vnd.spCampaign.v3+json').catch(() => ({})),
            ads(base44, aid, 'bootstrapConfirmAdGroup', '/sp/adGroups/list', { campaignIdFilter: [campaignId], maxResults: 100 }, 'application/vnd.spAdGroup.v3+json').catch(() => ({})),
            ads(base44, aid, 'bootstrapConfirmKeyword', '/sp/keywords/list', { campaignIdFilter: [campaignId], matchTypeFilter: ['EXACT'], maxResults: 100 }, 'application/vnd.spKeyword.v3+json').catch(() => ({})),
            ads(base44, aid, 'bootstrapConfirmProductAd', '/sp/productAds/list', { campaignIdFilter: [campaignId], maxResults: 100 }, 'application/vnd.spProductAd.v3+json').catch(() => ({})),
          ]);
          remoteCampaign = list(rc, 'campaigns')[0];
          remoteGroups = list(rg, 'adGroups');
          remoteKeywords = list(rk, 'keywords');
          remoteAds = list(ra, 'productAds');
        }

        for (const keyword of localKeywords) {
          const keywordId = String(keyword.keyword_id || '');
          // Prefer keyword-level delivery. A campaign may be serving while one
          // exact keyword remains at zero impressions and zero clicks.
          const keywordMetricsFresh = fresh(
            keyword.metrics_synced_at || keyword.synced_at || keyword.updated_at ||
              campaign.last_sync_at || campaign.synced_at,
            48,
          );
          const deliveryMetric = keywordMetricsFresh
            ? {
              impressions: keyword.impressions,
              clicks: keyword.clicks,
              spend: keyword.spend,
              orders: keyword.orders,
              source: 'keyword',
            }
            : { ...newestMetric, source: 'campaign_fallback' };
          const diagnosis = diagnoseZeroDelivery({
            campaignType: campaign.campaign_type, targetingType: campaign.targeting_type,
            matchType: keyword.match_type,
            structureComplete: Boolean(localGroups.length && localAds.length && keywordId),
            remoteEnabled: norm(remoteCampaign?.state) === 'enabled' &&
              remoteGroups.some((g: any) => norm(g.state) === 'enabled') &&
              remoteKeywords.some((k: any) => String(k.keywordId) === keywordId && norm(k.state) === 'enabled') &&
              remoteAds.some((a: any) => norm(a.state) === 'enabled'),
            metricsFresh: metricsFresh && (keywordMetricsFresh || Boolean(newestMetric)),
            stock: product?.available_quantity ?? product?.fba_inventory ?? 0,
            stockEligible: product?.inventory_status !== 'out_of_stock',
            listingEligible: product?.ads_eligibility_status === 'eligible' && product?.listing_buyable !== false &&
              product?.offer_active !== false && product?.listing_suppressed !== true,
            impressions: deliveryMetric?.impressions, clicks: deliveryMetric?.clicks, spend: deliveryMetric?.spend,
            createdAt: campaign.start_date || campaign.created_at || campaign.created_date,
            attempts: keyword.zero_delivery_attempts, lastRescueAt: keyword.last_bid_rescue_at,
          });
          if (!diagnosis.eligible) {
            await updateDiagnosis(base44, campaign, diagnosis.status, diagnosis.status, now, dryRun);
            results.push({ campaign_id: campaignId, keyword_id: keywordId, action: 'none', ...diagnosis });
            continue;
          }

          const recResponse = await ads(base44, aid, 'bootstrapBidRecommendation', '/sp/targets/bid/recommendations', {
            targetingExpressionRequests: [{
              type: 'KEYWORD_BID', campaignId,
              adGroupId: String(keyword.ad_group_id || localGroups[0]?.ad_group_id || ''),
              keywordId,
            }],
          }, 'application/json').catch(() => ({}));
          const recommendation = list(recResponse, 'recommendations')[0]?.suggestedBid || {};
          if (!dryRun) {
            await base44.asServiceRole.entities.Keyword.update(keyword.id, {
              suggested_bid_low: recommendation.rangeLower ?? null,
              suggested_bid_mid: recommendation.suggested ?? null,
              suggested_bid_high: recommendation.rangeUpper ?? null,
              suggested_bid_checked_at: now,
            }).catch(() => {});
          }
          const currentBid = Number(keyword.current_bid || keyword.bid || 0);
          const bid = calculateBootstrapBid({
            currentBid,
            suggestedLow: recommendation.rangeLower,
            suggestedMid: recommendation.suggested,
            safeMaxCpc: eco?.safe_max_cpc || settings.max_cpc,
            sustainableCpc: eco?.maximum_profitable_ad_spend || product?.maximum_ad_spend_per_order,
            maxBid: settings.max_bid,
          });
          if (!bid.eligible) {
            await updateDiagnosis(base44, campaign, bid.reason, bid.reason, now, dryRun);
            results.push({ campaign_id: campaignId, keyword_id: keywordId, action: 'none', ...bid });
            continue;
          }
          const attempt = diagnosis.attempt!;
          const window = new Date().toISOString().slice(0, 10);
          const key = buildBootstrapIdempotencyKey({ accountId: aid, campaignId, keywordId, attempt, window, bid: bid.bid });
          const duplicates = await base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: aid, idempotency_key: key }, null, 5).catch(() => []);
          if (duplicates.some((d: any) => ['approved', 'executing', 'executed'].includes(norm(d.status)))) {
            results.push({ campaign_id: campaignId, keyword_id: keywordId, action: 'none', status: 'idempotent_duplicate', idempotency_key: key });
            continue;
          }
          const decisionData = {
            amazon_account_id: aid, decision_type: 'manual_zero_delivery_bootstrap',
            entity_type: 'keyword', entity_id: keywordId, campaign_id: campaignId,
            ad_group_id: String(keyword.ad_group_id || localGroups[0]?.ad_group_id || ''),
            keyword_id: keywordId, keyword_text: keyword.keyword_text, asin,
            action: 'increase_bid', current_value: currentBid, proposed_value: bid.bid,
            value_before: currentBid, value_after: bid.bid, change_pct: bid.changePct,
            rationale: `Bootstrap controlado tentativa ${attempt}/2; campanha entre 7 e 15 dias; aumento máximo de 10% e teto absoluto de R$0,70, além do limite econômico.`,
            risk: 'low', requires_approval: false, approval_status: 'auto_approved',
            status: dryRun ? 'proposed' : 'approved', queue_status: dryRun ? 'not_queued' : 'pending',
            idempotency_key: key, source_function: 'manual_zero_delivery_bootstrap',
            evidence: JSON.stringify({ metrics: deliveryMetric, suggested_bid: recommendation, economic_cap: eco?.safe_max_cpc || settings.max_cpc }),
            created_at: now, updated_at: now,
          };
          if (dryRun) {
            results.push({ campaign_id: campaignId, keyword_id: keywordId, action: 'increase_bid', dry_run: true, bid, idempotency_key: key });
            continue;
          }
          const decision = await base44.asServiceRole.entities.OptimizationDecision.create(decisionData);
          const execution = await base44.asServiceRole.functions.invoke('executePairedManualBidDecision', {
            decision_id: decision.id, _service_role: true,
          }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
          results.push({ campaign_id: campaignId, keyword_id: keywordId, action: 'increase_bid', bid, decision_id: decision.id, execution: execution?.data || execution });
        }
      }
    }
    return Response.json({
      ok: true,
      stage: 'manual_zero_delivery_bootstrap',
      dry_run: dryRun,
      structure_reconciled: true,
      structure_reports: structureReports,
      results,
    });
  } catch (error: any) {
    return Response.json({ ok: false, stage: 'manual_zero_delivery_bootstrap', error: error?.message || String(error) }, { status: 500 });
  }
});
