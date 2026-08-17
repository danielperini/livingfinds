import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { classifyAttributionMaturity } from '../../shared/attributionMaturity.ts';

const n = (value: any) => Number(value || 0);
const r2 = (value: any) => Math.round((n(value) + Number.EPSILON) * 100) / 100;
const brtDate = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
const daysAgo = (days: number) => {
  const date = new Date(`${brtDate()}T12:00:00-03:00`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};

function metricKey(row: any) {
  return `${row.date}|${row.hour}|${row.campaign_id}|${row.asin || ''}`;
}

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 20);
    const lookbackDays = Math.max(1, Math.min(Number(body.lookback_days || (body.full ? 30 : 3)), 30));
    const cutoff = daysAgo(lookbackDays);
    const results: any[] = [];

    for (const account of accounts) {
      const aid = account.id;
      const [unifiedRaw, snapshotsRaw, campaigns, productAds, existingHourly] = await Promise.all([
        base44.asServiceRole.entities.UnifiedAdsMetricsHourly.filter({ amazon_account_id: aid }, '-date', 10000).catch(() => []),
        base44.asServiceRole.entities.IntradaySpendSnapshot.filter({ amazon_account_id: aid }, '-observed_at', 10000).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, undefined, 3000).catch(() => []),
        base44.asServiceRole.entities.ProductAd.filter({ amazon_account_id: aid }, '-synced_at', 5000).catch(() => []),
        base44.asServiceRole.entities.HourlyMetric.filter({ amazon_account_id: aid }, '-date', 10000).catch(() => []),
      ]);

      const asinByCampaign = new Map<string, string>();
      for (const ad of productAds) {
        if (ad.campaign_id && ad.asin && !asinByCampaign.has(String(ad.campaign_id))) {
          asinByCampaign.set(String(ad.campaign_id), String(ad.asin).toUpperCase());
        }
      }
      for (const campaign of campaigns) {
        const cid = String(campaign.campaign_id || campaign.amazon_campaign_id || '');
        if (cid && campaign.asin) asinByCampaign.set(cid, String(campaign.asin).toUpperCase());
      }

      const aggregated = new Map<string, any>();
      const add = (row: any) => {
        if (!row.date || n(row.hour) < 0 || n(row.hour) > 23 || !row.campaign_id) return;
        const key = metricKey(row);
        const current = aggregated.get(key) || {
          amazon_account_id: aid,
          marketplace_id: account.marketplace_id || account.marketplace || null,
          campaign_id: String(row.campaign_id),
          asin: row.asin || asinByCampaign.get(String(row.campaign_id)) || '',
          date: String(row.date).slice(0, 10),
          hour: n(row.hour),
          day_of_week: new Date(`${String(row.date).slice(0, 10)}T12:00:00-03:00`).getDay(),
          impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0,
          promoted_orders: 0, promoted_sales: 0, halo_orders: 0, halo_sales: 0,
          attribution_scope: 'total_only',
        };
        current.impressions += n(row.impressions);
        current.clicks += n(row.clicks);
        current.spend += n(row.spend);
        current.sales += n(row.sales);
        current.orders += n(row.orders);
        current.promoted_orders += n(row.promoted_orders);
        current.promoted_sales += n(row.promoted_sales);
        current.halo_orders += n(row.halo_orders);
        current.halo_sales += n(row.halo_sales);
        if (row.attribution_scope === 'same_sku') current.attribution_scope = 'same_sku';
        aggregated.set(key, current);
      };

      // Fonte principal: relatório HOURLY real da Amazon Ads.
      for (const row of unifiedRaw.filter((item: any) => String(item.date || '') >= cutoff)) {
        add({
          date: row.date,
          hour: row.hour,
          campaign_id: row.campaign_id,
          asin: row.advertised_asin || asinByCampaign.get(String(row.campaign_id || '')) || '',
          impressions: row.impressions,
          clicks: row.clicks,
          spend: row.cost,
          sales: row.sales,
          orders: row.purchases,
          promoted_orders: row.promoted_purchases,
          promoted_sales: row.promoted_sales,
          halo_orders: row.halo_purchases,
          halo_sales: row.halo_sales,
          attribution_scope: 'same_sku',
        });
      }

      // Fallback intradiário: diferenças entre snapshots cumulativos reais.
      const groups = new Map<string, any[]>();
      for (const snapshot of snapshotsRaw.filter((item: any) =>
        String(item.spend_date || '') >= cutoff && item.snapshot_kind === 'campaign_cumulative_day'
      )) {
        const key = `${snapshot.spend_date}|${snapshot.campaign_id}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(snapshot);
      }
      for (const rows of groups.values()) {
        rows.sort((a: any, b: any) => String(a.observed_at || '').localeCompare(String(b.observed_at || '')));
        for (let index = 0; index < rows.length; index++) {
          const current = rows[index];
          const previous = rows[index - 1];
          const observedAt = new Date(current.observed_at);
          const fallbackHour = Number(new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Sao_Paulo',
            hour: '2-digit',
            hourCycle: 'h23',
          }).format(observedAt));
          const hour = n(current.hour_brt ?? fallbackHour);
          if (!previous && hour > 2) continue;
          const delta = (field: string) => Math.max(0, n(current[field]) - n(previous?.[field]));
          const candidate = {
            date: current.spend_date,
            hour,
            campaign_id: current.campaign_id,
            asin: current.asin || asinByCampaign.get(String(current.campaign_id || '')) || '',
            impressions: delta('impressions'),
            clicks: delta('clicks'),
            spend: delta('spend'),
            sales: delta('sales'),
            orders: delta('orders'),
          };
          // Não duplicar quando a Amazon já forneceu HOURLY para a mesma chave.
          if (!aggregated.has(metricKey(candidate))) add(candidate);
        }
      }

      const existingByKey = new Map(existingHourly.map((row: any) => [metricKey(row), row]));
      const creates: any[] = [];
      const updates: any[] = [];
      const now = new Date().toISOString();
      for (const row of aggregated.values()) {
        const impressions = n(row.impressions);
        const clicks = n(row.clicks);
        const spend = r2(row.spend);
        const sales = r2(row.sales);
        const orders = n(row.orders);
        const record = {
          ...row,
          impressions,
          clicks,
          spend,
          sales,
          orders,
          promoted_orders: n(row.promoted_orders),
          promoted_sales: r2(row.promoted_sales),
          halo_orders: n(row.halo_orders),
          halo_sales: r2(row.halo_sales),
          attribution_scope: row.attribution_scope,
          units: orders,
          ctr: impressions > 0 ? r2(clicks / impressions * 100) : 0,
          cpc: clicks > 0 ? r2(spend / clicks) : 0,
          acos: sales > 0 ? r2(spend / sales * 100) : 0,
          roas: spend > 0 ? r2(sales / spend) : 0,
          conversion_rate: clicks > 0 ? r2(orders / clicks * 100) : 0,
          data_maturity: classifyAttributionMaturity(row.date, brtDate()),
          sample_size: orders >= 3 || clicks >= 20 ? 'adequate' : clicks >= 5 ? 'low' : 'insufficient',
          classification: orders > 0 && sales > spend ? 'peak_conversion'
            : clicks >= 5 && orders === 0 ? 'low_efficiency'
            : impressions > 0 ? 'neutral' : 'insufficient_data',
          synced_at: now,
        };
        const existing = existingByKey.get(metricKey(record));
        if (existing?.id) updates.push({ id: existing.id, ...record });
        else creates.push(record);
      }

      for (let index = 0; index < creates.length; index += 100) {
        await base44.asServiceRole.entities.HourlyMetric.bulkCreate(creates.slice(index, index + 100));
      }
      for (let index = 0; index < updates.length; index += 100) {
        await base44.asServiceRole.entities.HourlyMetric.bulkUpdate(updates.slice(index, index + 100));
      }

      const patternResponse = await base44.asServiceRole.functions.invoke('snapshotHourlySalesPattern', {
        amazon_account_id: aid,
        force: true,
        _service_role: true,
      }).then((response: any) => response?.data || response || {}).catch((error: any) => ({ ok: false, error: error?.message }));

      const result = {
        amazon_account_id: aid,
        lookback_days: lookbackDays,
        unified_rows: unifiedRaw.filter((row: any) => String(row.date || '') >= cutoff).length,
        intraday_snapshots: snapshotsRaw.filter((row: any) => String(row.spend_date || '') >= cutoff).length,
        hourly_created: creates.length,
        hourly_updated: updates.length,
        hourly_total: aggregated.size,
        campaigns_linked_to_asin: asinByCampaign.size,
        patterns: patternResponse,
      };
      results.push(result);
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: aid,
        operation: 'rebuild_hourly_metrics_from_reports',
        trigger_type: body.full ? 'retroactive' : 'automatic',
        status: 'success',
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        records_processed: aggregated.size,
        result_summary: JSON.stringify(result).slice(0, 4000),
      }).catch(() => {});
    }

    return Response.json({
      ok: true,
      accounts_processed: results.length,
      results,
      completed_at: new Date().toISOString(),
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});
