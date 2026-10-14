import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const token = (value: unknown) => String(value ?? '').trim().toUpperCase();
const campaignId = (row: any) => String(row?.amazon_campaign_id || row?.campaign_id || row?.id || '');
const metricTime = (row: any) => new Date(String(row?.observed_at || row?.synced_at || row?.updated_at || row?.created_at || 0)).getTime();

function nowBRT() { return new Date(Date.now() - 3 * 3600000); }
function dateStrBRT(daysAgo = 0) {
  const date = nowBRT();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

/** Learn an hourly profile per exact seller SKU; never pool sibling ASIN variants or account-wide traffic. */
export default async function(req: Request) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const targetAccountId = body.amazon_account_id || null;
    const accounts = targetAccountId
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: targetAccountId })
      : await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: user.id });
    if (!accounts.length) return Response.json({ ok: false, error: 'No accounts found' });

    const results: any[] = [];
    for (const account of accounts) {
      const accountId = String(account.id);
      const endDate = dateStrBRT(2);
      const startDate = dateStrBRT(90);
      const [metrics, campaigns, productAds, products] = await Promise.all([
        base44.asServiceRole.entities.UnifiedAdsMetricsHourly.filter({ amazon_account_id: accountId }, '-date', 10000).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, null, 10000).catch(() => []),
        base44.asServiceRole.entities.ProductAd.filter({ amazon_account_id: accountId }, null, 10000).catch(() => []),
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, null, 10000).catch(() => []),
      ]);
      if (!metrics.length) {
        results.push({ account_id: accountId, skipped: true, reason: 'no_hourly_metrics' });
        continue;
      }

      const campaignSkus = new Map<string, Set<string>>();
      for (const ad of productAds) {
        const id = String(ad.campaign_id || '');
        const sku = token(ad.sku);
        if (!id || !sku) continue;
        if (!campaignSkus.has(id)) campaignSkus.set(id, new Set());
        campaignSkus.get(id)!.add(sku);
      }
      const campaignToSku = new Map<string, string>();
      for (const campaign of campaigns) {
        const id = campaignId(campaign);
        const linked = campaignSkus.get(id) || new Set<string>();
        const explicit = token(campaign.sku);
        if (explicit) campaignToSku.set(id, explicit);
        else if (linked.size === 1) campaignToSku.set(id, [...linked][0]);
      }
      const productBySku = new Map<string, any>();
      const skuCounts = new Map<string, number>();
      for (const product of products) {
        const sku = token(product.sku);
        if (!sku) continue;
        skuCounts.set(sku, (skuCounts.get(sku) || 0) + 1);
        productBySku.set(sku, product);
      }

      const filtered = metrics.filter((row: any) => String(row.date || '') >= startDate && String(row.date || '') <= endDate);
      // Hourly endpoints can return revised snapshots. Keep the newest row for each campaign/SKU/date/hour.
      const latest = new Map<string, any>();
      for (const row of [...filtered].sort((a: any, b: any) => metricTime(b) - metricTime(a))) {
        const id = String(row.campaign_id || '');
        const sku = token(row.advertised_sku) || campaignToSku.get(id) || '';
        const hour = Number(row.hour);
        const date = String(row.date || '');
        if (!sku || !id || !date || !Number.isInteger(hour) || hour < 0 || hour > 23 || productCountBySku.get(sku) !== 1) continue;
        // advertised_sku is a SKU from the Ads report; campaign fallback is allowed only for a single exact linked SKU.
        if (!token(row.advertised_sku) && !campaignToSku.has(id)) continue;
        const key = [id, sku, date, hour].join('|');
        if (!latest.has(key)) latest.set(key, { ...row, __resolved_sku: sku });
      }

      const skuHourData = new Map<string, Map<number, any>>();
      for (const row of latest.values()) {
        const sku = row.__resolved_sku;
        if ((skuCounts.get(sku) || 0) > 1) continue;
        if (!skuHourData.has(sku)) skuHourData.set(sku, new Map());
        const hours = skuHourData.get(sku)!;
        const hour = Number(row.hour);
        if (!hours.has(hour)) hours.set(hour, { clicks: 0, sales: 0, orders: 0, spend: 0, impressions: 0, dates: new Set<string>() });
        const slot = hours.get(hour)!;
        slot.clicks += Number(row.clicks || 0);
        slot.sales += Number(row.sales || 0);
        slot.orders += Number(row.purchases ?? row.orders ?? 0);
        slot.spend += Number(row.cost ?? row.spend ?? 0);
        slot.impressions += Number(row.impressions || 0);
        slot.dates.add(String(row.date));
      }

      let skusProcessed = 0, skusMature = 0, skusInsufficient = 0, ambiguousMetrics = 0;
      for (const [sku, hourMap] of skuHourData) {
        skusProcessed++;
        const allDates = new Set<string>();
        let totalClicks = 0;
        for (const slot of hourMap.values()) {
          slot.dates.forEach((date: string) => allDates.add(date));
          totalClicks += slot.clicks;
        }
        const daysOfData = allDates.size;
        const hoursWithData = hourMap.size;
        const mature = daysOfData >= 30 && hoursWithData >= 12 && totalClicks / Math.max(hoursWithData, 1) >= 20;
        if (!mature) {
          skusInsufficient++;
          await upsertSkuProfile(base44, accountId, sku, productBySku.get(sku)?.asin || '', {
            asin_data_maturity: 'insufficient',
            asin_days_of_data: daysOfData,
            asin_total_clicks: totalClicks,
            asin_profile_updated_at: new Date().toISOString(),
            asin_peak_hours_json: null,
            asin_low_hours_json: null,
            asin_neutral_hours_json: null,
            asin_peak_score_threshold: 0,
            asin_peak_diverges_from_account: false,
          });
          continue;
        }

        skusMature++;
        const scores: Record<number, number> = {};
        for (const [hour, slot] of hourMap) {
          // Rate is computed from totals, not averaged across rows.
          const cvr = slot.clicks > 0 ? slot.orders / slot.clicks : 0;
          const clickShare = slot.clicks / Math.max(totalClicks, 1);
          const efficiency = slot.spend > 0 && slot.sales > 0 ? Math.min(slot.sales / slot.spend, 5) / 5 : 0;
          scores[hour] = (cvr * 0.4 + clickShare * 0.4 + efficiency * 0.2) * 100;
        }
        const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
        const peakCount = Math.max(1, Math.round(ranked.length * 0.2));
        const lowCount = Math.max(1, Math.round(ranked.length * 0.3));
        const peaks = ranked.slice(0, peakCount).map(([hour]) => Number(hour));
        const lows = ranked.slice(-lowCount).map(([hour]) => Number(hour));
        const neutral = ranked.slice(peakCount, Math.max(peakCount, ranked.length - lowCount)).map(([hour]) => Number(hour));
        const threshold = peaks.length ? scores[peaks[peaks.length - 1]] : 0;
        await upsertSkuProfile(base44, accountId, sku, productBySku.get(sku)?.asin || '', {
          asin_data_maturity: 'sufficient',
          asin_days_of_data: daysOfData,
          asin_total_clicks: totalClicks,
          asin_profile_updated_at: new Date().toISOString(),
          asin_peak_hours_json: JSON.stringify(peaks),
          asin_low_hours_json: JSON.stringify(lows),
          asin_neutral_hours_json: JSON.stringify(neutral),
          asin_peak_score_threshold: Math.round(threshold * 100) / 100,
          asin_peak_diverges_from_account: false,
        });
      }

      const skippedAmbiguous = filtered.filter((row: any) => {
        const id = String(row.campaign_id || '');
        const reportedSku = token(row.advertised_sku) || campaignToSku.get(id) || '';
        return !reportedSku || productCountBySku.get(reportedSku) !== 1;
      }).length;
      ambiguousMetrics += skippedAmbiguous;
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: accountId,
        operation: 'runAsinPeakProfileLearning',
        trigger_type: body.trigger || 'scheduled',
        status: 'success',
        records_processed: skusProcessed,
        result_summary: `${skusMature} SKUs maduros, ${skusInsufficient} insuficientes; ${ambiguousMetrics} linhas sem identidade SKU inequívoca ignoradas`,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      }).catch(() => {});
      results.push({
        account_id: accountId,
        skus_processed: skusProcessed,
        skus_mature: skusMature,
        skus_insufficient: skusInsufficient,
        ambiguous_metric_rows_ignored: ambiguousMetrics,
      });
    }
    return Response.json({ ok: true, results });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
}

async function upsertSkuProfile(base44: any, accountId: string, sku: string, asin: string, profileFields: Record<string, unknown>) {
  const existing = await base44.asServiceRole.entities.HourlySalesPattern.filter(
    { amazon_account_id: accountId, sku, day_of_week: 0, hour: 0 },
    null, 10
  ).catch(() => []);
  const payload = {
    amazon_account_id: accountId,
    sku,
    asin: asin || null,
    day_of_week: 0,
    hour: 0,
    slot_label: 'SKU_PROFILE_ANCHOR',
    classification: 'INSUFFICIENT_DATA',
    occurrences: 0,
    ...profileFields,
  };
  if (existing.length) {
    await base44.asServiceRole.entities.HourlySalesPattern.update(existing[0].id, payload);
  } else {
    await base44.asServiceRole.entities.HourlySalesPattern.create(payload);
  }
}
