/**
 * Calibra keywords com zero de impressoes confirmado por relatorio diario.
 * Ausencia de metrica, campanha incompleta, economia pendente e produto
 * inelegivel nunca sao interpretados como zero e nunca aumentam o lance.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { classifyUnifiedEconomicStatus } from '../../shared/economicDecisionState.ts';
import {
  classifyNoImpressionCalibration,
  shouldMaintainActiveNoImpressionAlert,
  type NoImpressionCalibrationDecision,
} from '../../shared/noImpressionCalibrationPolicy.ts';

const MAX_BID = 1.00;
const MIN_BID = 0.25;
const BOOST_AMOUNT = 0.10;
const BID_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 500;
const tokenCache: Record<string, { access_token: string; expires_at: number }> = {};

const text = (value: unknown): string => String(value ?? '').trim();
const lower = (value: unknown): string => text(value).toLowerCase();
const finite = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function rowTime(row: any): number {
  const value = row?.updated_date || row?.updated_at || row?.created_date || row?.created_at || 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestBy(rows: any[], keyOf: (row: any) => string): Map<string, any> {
  const result = new Map<string, any>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const current = result.get(key);
    if (!current || rowTime(row) > rowTime(current)) result.set(key, row);
  }
  return result;
}

async function loadAll(
  entity: any,
  query: Record<string, unknown>,
  sort = '-updated_date',
  maxRows = 20000,
): Promise<any[]> {
  const rows: any[] = [];
  for (let offset = 0; offset < maxRows; offset += PAGE_SIZE) {
    const page = await entity.filter(query, sort, PAGE_SIZE, offset).catch(() => []);
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function getAdsToken(refreshToken: string): Promise<string> {
  const cached = tokenCache.ads;
  if (cached && cached.expires_at > Date.now() + 5000) return cached.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: Deno.env.get('ADS_CLIENT_ID') || '',
    client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
  });
  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || data.error || 'Token failed');
  tokenCache.ads = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  };
  return data.access_token;
}

function getAdsBaseUrl(): string {
  const region = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (region.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (region.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsRequest(
  method: string,
  path: string,
  body: any,
  refreshToken: string,
  profileId: string,
): Promise<{ status: number; data: any }> {
  const token = await getAdsToken(refreshToken);
  const response = await fetch(`${getAdsBaseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': 'application/vnd.spKeyword.v3+json',
      Accept: 'application/vnd.spKeyword.v3+json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const responseText = await response.text();
  let data: any;
  try { data = JSON.parse(responseText); } catch { data = { raw: responseText }; }
  return { status: response.status, data };
}

async function updateKeywordBid(
  base44: any,
  account: any,
  keyword: any,
  resolvedAsin: string,
  newBid: number,
  refreshToken: string,
  profileId: string,
  now: Date,
): Promise<{ ok: boolean; error?: string; new_bid?: number }> {
  const currentBid = finite(keyword.current_bid ?? keyword.bid, MIN_BID);
  const clampedBid = Number(Math.min(Math.max(newBid, MIN_BID), MAX_BID).toFixed(2));
  const response = await adsRequest(
    'PUT',
    '/sp/keywords',
    { keywords: [{ keywordId: keyword.keyword_id, bid: clampedBid }] },
    refreshToken,
    profileId,
  );
  if (![200, 207].includes(response.status)) {
    return { ok: false, error: `HTTP ${response.status}` };
  }

  await base44.asServiceRole.entities.Keyword.update(keyword.id, {
    current_bid: clampedBid,
    bid: clampedBid,
    last_seen_at: now.toISOString(),
  });
  await base44.asServiceRole.entities.AdsBidChangeLog.create({
    amazon_account_id: account.id,
    entity_type: 'keyword',
    entity_id: keyword.keyword_id,
    keyword_id: keyword.keyword_id,
    keyword: keyword.keyword_text || keyword.keyword || '',
    campaign_id: keyword.campaign_id || '',
    asin: resolvedAsin || keyword.asin || '',
    old_bid: currentBid,
    new_bid: clampedBid,
    change_amount: Number((clampedBid - currentBid).toFixed(2)),
    change_percent: Number((((clampedBid - currentBid) / Math.max(currentBid, 0.01)) * 100).toFixed(1)),
    direction: 'increase',
    reason: 'Zero de impressoes confirmado por TargetingMetricsDaily em dois dias; calibracao controlada.',
    evidence: 'TargetingMetricsDaily:2_daily_rows:0_impressions',
    source: 'calibrateBidsNoImpressions',
    ai_confidence: 95,
    risk_level: 'low',
    status: 'executed',
    created_at: now.toISOString(),
  });
  return { ok: true, new_bid: clampedBid };
}

function campaignIsOperational(campaign: any): boolean {
  if (!campaign) return false;
  const state = lower(campaign.state || campaign.status || campaign.amazon_status);
  const delivery = lower(campaign.delivery_status);
  return state === 'enabled'
    && campaign.is_operational !== false
    && campaign.api_missing !== true
    && campaign.archived !== true
    && !delivery.includes('manual_pause_lock');
}

function productEligibility(product: any): 'eligible' | 'ineligible' | 'unknown' {
  if (!product) return 'unknown';
  const available = finite(product.available_quantity ?? product.fba_inventory, 0);
  const eligibility = lower(product.ads_eligibility_status);
  const inventory = lower(product.inventory_status);
  const scope = lower(product.ads_scope_status);
  if (
    available <= 0
    || inventory === 'out_of_stock'
    || ['out_of_stock', 'listing_suppressed', 'listing_inactive', 'offer_inactive', 'not_buyable', 'mapping_conflict', 'not_authorized', 'manual_block'].includes(eligibility)
    || ['not_authorized', 'manual_block', 'mapping_conflict'].includes(scope)
    || product.listing_buyable === false
    || product.offer_active === false
    || product.listing_suppressed === true
  ) return 'ineligible';
  if (eligibility === 'eligible' && available > 0) return 'eligible';
  return 'unknown';
}

function campaignStructureReady(campaign: any, enabledProductAds: Set<string>): boolean {
  if (!campaign) return false;
  const campaignId = text(campaign.campaign_id || campaign.amazon_campaign_id);
  const journey = text(campaign.campaign_journey_stage).toUpperCase();
  const completion = lower(campaign.completion_status);
  return !!campaignId
    && enabledProductAds.has(campaignId)
    && lower(campaign.state || campaign.status) !== 'incomplete'
    && campaign.is_incomplete !== true
    && journey !== 'INCOMPLETE'
    && (!completion || completion === 'complete');
}

function campaignEconomicsReady(campaign: any, economics: any, nowMs: number): boolean {
  if (!campaign || !economics) return false;
  const campaignEconomicState = lower(campaign.economic_state);
  const risk = lower(campaign.risk_state);
  const allowedStates = new Set(['learning', 'valid', 'profitable', 'normal', 'economically_valid']);
  if (!allowedStates.has(campaignEconomicState)) return false;
  if (['economics_pending', 'out_of_stock', 'not_buyable', 'structure', 'no_same_sku_sale'].includes(risk)) return false;
  return !classifyUnifiedEconomicStatus(economics, nowMs).block_expansion;
}

function alertKey(alert: any): string {
  return text(alert.keyword_id || (alert.entity_type === 'keyword' ? alert.entity_id : ''));
}

function decisionToAlertUpdate(
  alert: any,
  decision: NoImpressionCalibrationDecision,
  nowIso: string,
): any | null {
  if (!alert) return null;
  if (decision.action === 'RESOLVE_IMPRESSIONS' || decision.action === 'RESOLVE_INELIGIBLE') {
    return {
      id: alert.id,
      status: 'resolved',
      resolved_at: nowIso,
      resolution_reason: decision.reason,
      data_freshness: decision.action === 'RESOLVE_IMPRESSIONS' ? 'fresh' : 'unknown',
      updated_at: nowIso,
    };
  }
  if (decision.action === 'STALE_NO_DATA' || decision.action === 'STALE_GUARDRAIL') {
    return {
      id: alert.id,
      status: 'stale',
      resolution_reason: decision.reason,
      data_freshness: decision.action === 'STALE_NO_DATA' ? 'stale' : 'unknown',
      updated_at: nowIso,
    };
  }
  return null;
}

async function applyAlertUpdates(base44: any, updates: any[]): Promise<void> {
  for (let index = 0; index < updates.length; index += 50) {
    const batch = updates.slice(index, index + 50);
    try {
      await base44.asServiceRole.entities.Alert.bulkUpdate(batch);
    } catch {
      for (const update of batch) {
        const { id, ...data } = update;
        await base44.asServiceRole.entities.Alert.update(id, data).catch(() => {});
      }
    }
  }
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const now = new Date();
    const nowIso = now.toISOString();
    const cutoff48h = now.getTime() - 48 * 60 * 60 * 1000;
    const dates = Array.from({ length: 3 }, (_, index) =>
      new Date(now.getTime() - index * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    );
    const payload = await request.clone().json().catch(() => ({}));
    const reconcileOnly = payload.reconcile_only === true;
    const accounts = payload.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: payload.amazon_account_id }, undefined, 10)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, undefined, 50);

    const summary: any = {
      accounts_processed: 0,
      keywords_analyzed: 0,
      keywords_boosted: 0,
      keywords_held_confirmed_zero: 0,
      keywords_held_no_data: 0,
      keywords_held_guardrail: 0,
      alerts_created: 0,
      alerts_resolved: 0,
      alerts_staled: 0,
      duplicate_alerts_resolved: 0,
      errors: [],
    };

    for (const account of accounts) {
      try {
        const accountId = account.id;
        const [keywordRows, campaignRows, productRows, productAdRows, economicsRows, activeAlerts, acknowledgedAlerts, recentBidLogs, metricPages] = await Promise.all([
          loadAll(base44.asServiceRole.entities.Keyword, { amazon_account_id: accountId }),
          loadAll(base44.asServiceRole.entities.Campaign, { amazon_account_id: accountId }),
          loadAll(base44.asServiceRole.entities.Product, { amazon_account_id: accountId }),
          loadAll(base44.asServiceRole.entities.ProductAd, { amazon_account_id: accountId }),
          loadAll(base44.asServiceRole.entities.ProductEconomics, { amazon_account_id: accountId }),
          loadAll(base44.asServiceRole.entities.Alert, { amazon_account_id: accountId, alert_type: 'no_impressions', status: 'active' }, '-created_at'),
          loadAll(base44.asServiceRole.entities.Alert, { amazon_account_id: accountId, alert_type: 'no_impressions', status: 'acknowledged' }, '-created_at'),
          base44.asServiceRole.entities.AdsBidChangeLog.filter({ amazon_account_id: accountId }, '-created_at', 5000).catch(() => []),
          Promise.all(dates.map((date) => loadAll(
            base44.asServiceRole.entities.TargetingMetricsDaily,
            { amazon_account_id: accountId, date },
            '-date',
          ))),
        ]);

        const keywordsById = latestBy(keywordRows, (row) => text(row.keyword_id));
        const campaignsById = latestBy(campaignRows, (row) => text(row.campaign_id || row.amazon_campaign_id));
        const productsByAsin = latestBy(productRows, (row) => text(row.asin).toUpperCase());
        const economicsByAsin = latestBy(economicsRows, (row) => text(row.asin).toUpperCase());
        const enabledProductAds = new Set(
          productAdRows
            .filter((row) => lower(row.state || row.status) === 'enabled')
            .map((row) => text(row.campaign_id))
            .filter(Boolean),
        );

        const targetingSignals = new Map<string, { impressions: number; dates: Set<string> }>();
        for (const metric of metricPages.flat()) {
          const keywordId = text(metric.keyword_id);
          if (!keywordId) continue;
          const signal = targetingSignals.get(keywordId) || { impressions: 0, dates: new Set<string>() };
          signal.impressions += Math.max(0, finite(metric.impressions, 0));
          if (metric.date) signal.dates.add(text(metric.date));
          targetingSignals.set(keywordId, signal);
        }

        const lastBidChangeByKeyword = new Map<string, number>();
        for (const log of recentBidLogs) {
          const keywordId = text(log.keyword_id || (log.entity_type === 'keyword' ? log.entity_id : ''));
          if (!keywordId) continue;
          const timestamp = new Date(log.created_at || log.created_date || 0).getTime();
          if (Number.isFinite(timestamp) && timestamp > (lastBidChangeByKeyword.get(keywordId) || 0)) {
            lastBidChangeByKeyword.set(keywordId, timestamp);
          }
        }

        const activeAlertGroups = new Map<string, any[]>();
        for (const alert of [...activeAlerts, ...acknowledgedAlerts]) {
          const key = alertKey(alert);
          if (!activeAlertGroups.has(key)) activeAlertGroups.set(key, []);
          activeAlertGroups.get(key)!.push(alert);
        }
        const keeperAlertByKeyword = new Map<string, any>();
        const alertUpdates = new Map<string, any>();
        for (const [key, alerts] of activeAlertGroups) {
          alerts.sort((left, right) => rowTime(right) - rowTime(left));
          if (key) keeperAlertByKeyword.set(key, alerts[0]);
          for (const duplicate of alerts.slice(1)) {
            alertUpdates.set(duplicate.id, {
              id: duplicate.id,
              status: 'resolved',
              resolved_at: nowIso,
              resolution_reason: 'duplicate_no_impressions_alert',
              updated_at: nowIso,
            });
            summary.duplicate_alerts_resolved++;
          }
        }

        const evaluatedKeywordIds = new Set<string>();
        const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
        const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';

        for (const [keywordId, keyword] of keywordsById) {
          const keywordEnabled = lower(keyword.state || keyword.status) === 'enabled';
          if (!keywordEnabled && !keeperAlertByKeyword.has(keywordId)) continue;
          evaluatedKeywordIds.add(keywordId);
          const keeperAlert = keeperAlertByKeyword.get(keywordId);
          const firstSeenAt = new Date(keyword.first_seen_at || keyword.synced_at || keyword.created_date || 0).getTime();
          if (keywordEnabled && Number.isFinite(firstSeenAt) && firstSeenAt >= cutoff48h) {
            if (keeperAlert) {
              alertUpdates.set(keeperAlert.id, {
                id: keeperAlert.id,
                status: 'stale',
                resolution_reason: 'keyword_age_under_48h',
                data_freshness: 'unknown',
                updated_at: nowIso,
              });
              summary.alerts_staled++;
            }
            continue;
          }

          const campaignId = text(keyword.campaign_id || keeperAlert?.campaign_id);
          const campaign = campaignsById.get(campaignId);
          const asin = text(keyword.asin || campaign?.asin || keeperAlert?.asin).toUpperCase();
          const product = productsByAsin.get(asin);
          const economics = economicsByAsin.get(asin);
          const signal = targetingSignals.get(keywordId);
          const currentBid = finite(keyword.current_bid ?? keyword.bid, MIN_BID);
          const decision = classifyNoImpressionCalibration({
            keywordEnabled,
            campaignKnown: !!campaign,
            campaignState: lower(campaign?.state || campaign?.status || campaign?.amazon_status),
            campaignOperational: campaignIsOperational(campaign),
            productEligibility: productEligibility(product),
            structureReady: campaignStructureReady(campaign, enabledProductAds),
            economicsReady: campaignEconomicsReady(campaign, economics, now.getTime()),
            keywordMetricDays: signal?.dates.size || 0,
            keywordImpressions: signal ? signal.impressions : null,
            recentBidChange: now.getTime() - (lastBidChangeByKeyword.get(keywordId) || 0) < BID_COOLDOWN_MS,
            currentBid,
            maxBid: MAX_BID,
          });
          summary.keywords_analyzed++;

          if (decision.action === 'STALE_NO_DATA') summary.keywords_held_no_data++;
          if (decision.action === 'STALE_GUARDRAIL') summary.keywords_held_guardrail++;
          if (decision.action === 'HOLD_CONFIRMED_ZERO') summary.keywords_held_confirmed_zero++;

          const lifecycleUpdate = decisionToAlertUpdate(keeperAlert, decision, nowIso);
          if (lifecycleUpdate) {
            alertUpdates.set(lifecycleUpdate.id, lifecycleUpdate);
            if (lifecycleUpdate.status === 'resolved') summary.alerts_resolved++;
            if (lifecycleUpdate.status === 'stale') summary.alerts_staled++;
          }
          if (!shouldMaintainActiveNoImpressionAlert(decision.action)) continue;

          let resultingBid = currentBid;
          if (decision.action === 'BOOST_CONFIRMED_ZERO' && !reconcileOnly) {
            if (!refreshToken || !profileId) {
              summary.errors.push(`Boost ${keywordId}: credenciais Amazon Ads ausentes`);
            } else {
              const result = await updateKeywordBid(
                base44,
                account,
                keyword,
                asin,
                Math.min(currentBid + BOOST_AMOUNT, MAX_BID),
                refreshToken,
                profileId,
                now,
              );
              if (result.ok) {
                summary.keywords_boosted++;
                resultingBid = result.new_bid || currentBid;
                await new Promise((resolve) => setTimeout(resolve, 300));
              } else {
                summary.errors.push(`Boost ${keywordId}: ${result.error}`);
              }
            }
          }

          const alertMessage = `Keyword "${keyword.keyword_text || keyword.keyword || keywordId}" (bid atual: R$${resultingBid.toFixed(2)}) teve zero impressoes confirmado por dados diarios de targeting nas ultimas 48h.`;
          if (keeperAlert) {
            alertUpdates.set(keeperAlert.id, {
              id: keeperAlert.id,
              status: 'active',
              severity: 'high',
              message: alertMessage,
              metric_value: 0,
              current_value: 0,
              data_source: 'TargetingMetricsDaily',
              data_freshness: 'fresh',
              last_detected_at: nowIso,
              resolution_reason: decision.reason,
              updated_at: nowIso,
            });
          } else {
            await base44.asServiceRole.entities.Alert.create({
              amazon_account_id: accountId,
              alert_type: 'no_impressions',
              alert_family: 'keyword',
              severity: 'high',
              title: 'Keyword sem impressoes ha 48h (confirmado)',
              message: alertMessage,
              entity_type: 'keyword',
              entity_id: keyword.id,
              keyword_id: keywordId,
              campaign_id: campaignId,
              asin,
              current_value: 0,
              metric_value: 0,
              threshold_value: 1,
              data_window: '48h',
              data_source: 'TargetingMetricsDaily',
              data_freshness: 'fresh',
              status: 'active',
              deduplication_key: `${accountId}::no_impressions::keyword::${keywordId}::48h`,
              source_function: 'calibrateBidsNoImpressions',
              first_detected_at: nowIso,
              last_detected_at: nowIso,
              created_at: nowIso,
            });
            summary.alerts_created++;
          }
        }

        for (const [key, alerts] of activeAlertGroups) {
          if (evaluatedKeywordIds.has(key)) continue;
          const keeper = alerts.sort((left, right) => rowTime(right) - rowTime(left))[0];
          if (!keeper || alertUpdates.has(keeper.id)) continue;
          alertUpdates.set(keeper.id, {
            id: keeper.id,
            status: key ? 'resolved' : 'stale',
            ...(key ? { resolved_at: nowIso } : {}),
            resolution_reason: key ? 'keyword_not_found_or_not_enabled' : 'alert_without_keyword_identity',
            data_freshness: 'unknown',
            updated_at: nowIso,
          });
          if (key) summary.alerts_resolved++;
          else summary.alerts_staled++;
        }

        await applyAlertUpdates(base44, [...alertUpdates.values()]);
        summary.accounts_processed++;
      } catch (accountError: any) {
        summary.errors.push(`Conta ${account.id}: ${accountError.message}`);
      }
    }

    return Response.json({
      ok: true,
      rule: 'calibrate_bids_no_impressions_confirmed_48h_v2',
      reconcile_only: reconcileOnly,
      boost_amount: BOOST_AMOUNT,
      max_bid: MAX_BID,
      summary,
      executed_at: nowIso,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});
