import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function ymd(date: Date) {
  return date.toISOString().slice(0, 10);
}

function numberValue(value: unknown) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

async function gunzipJson(response: Response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  let text = '';
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } catch {
    text = new TextDecoder().decode(bytes);
  }
  const parsed = JSON.parse(text || '[]');
  return Array.isArray(parsed) ? parsed : parsed?.rows || parsed?.data || [];
}

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const auth = await base44.auth.isAuthenticated().catch(() => false);
    if (!auth && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accountId = body.amazon_account_id;
    if (!accountId) {
      return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });
    }

    const end = body.end_date ? new Date(body.end_date) : new Date();
    const start = body.start_date ? new Date(body.start_date) : new Date(end.getTime() - 29 * 86400000);

    const createResponse = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
      amazon_account_id: accountId,
      operation: 'createSponsoredProductsCampaignReport30d',
      method: 'POST',
      path: '/reporting/reports',
      content_type: 'application/vnd.createasyncreportrequest.v3+json',
      accept: 'application/vnd.createasyncreportrequest.v3+json',
      queue_type: 'REPORT',
      payload: {
        name: `Living Finds SP campaigns ${ymd(start)} ${ymd(end)}`,
        startDate: ymd(start),
        endDate: ymd(end),
        configuration: {
          adProduct: 'SPONSORED_PRODUCTS',
          groupBy: ['campaign'],
          columns: [
            'date',
            'campaignId',
            'campaignName',
            'campaignStatus',
            'campaignBudgetAmount',
            'impressions',
            'clicks',
            'cost',
            'purchases30d',
            'sales30d'
          ],
          reportTypeId: 'spCampaigns',
          timeUnit: 'DAILY',
          format: 'GZIP_JSON'
        }
      },
      _service_role: true
    });

    const created = createResponse?.data || createResponse || {};
    if (!created?.ok) {
      throw new Error(created?.errors?.[0]?.message || created?.error || 'Falha ao solicitar relatório de performance Ads');
    }

    const reportId = created?.payload?.reportId || created?.reportId;
    if (!reportId) throw new Error('Amazon Ads não retornou reportId');

    let reportPayload: any = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (attempt > 0) await wait(10000);
      const statusResponse = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        amazon_account_id: accountId,
        operation: 'getSponsoredProductsCampaignReport30d',
        method: 'GET',
        path: `/reporting/reports/${reportId}`,
        accept: 'application/vnd.getasyncreportresponse.v3+json',
        queue_type: 'REPORT',
        _service_role: true
      });
      const statusData = statusResponse?.data || statusResponse || {};
      if (!statusData?.ok) continue;
      reportPayload = statusData?.payload || statusData;
      const status = String(reportPayload?.status || '').toUpperCase();
      if (status === 'COMPLETED') break;
      if (['FAILURE', 'FAILED', 'CANCELLED'].includes(status)) {
        throw new Error(reportPayload?.failureReason || `Relatório Amazon Ads terminou como ${status}`);
      }
    }

    const location = reportPayload?.url || reportPayload?.location;
    if (!location) {
      const now = new Date().toISOString();
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: accountId,
        operation: 'sync_ads_performance_metrics_v2',
        status: 'pending',
        trigger_type: body.trigger_type || 'scheduled',
        started_at: startedAt,
        completed_at: now,
        records_processed: 0,
        result_summary: JSON.stringify({ reportId, status: reportPayload?.status || 'PENDING' }).slice(0, 4000)
      }).catch(() => {});
      return Response.json({ ok: true, pending: true, report_id: reportId, status: reportPayload?.status || 'PENDING' });
    }

    const download = await fetch(location);
    if (!download.ok) throw new Error(`Falha ao baixar relatório Ads: HTTP ${download.status}`);
    const rows = await gunzipJson(download);

    const existing = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: accountId },
      '-date',
      10000
    ).catch(() => []);

    const existingByKey = new Map<string, any>();
    for (const row of existing) {
      const key = `${String(row.campaign_id || '')}-${String(row.date || '')}`;
      if (!existingByKey.has(key)) existingByKey.set(key, row);
    }

    const toCreate: any[] = [];
    const toUpdate: any[] = [];
    const seen = new Set<string>();
    const now2 = new Date().toISOString();

    for (const row of rows) {
      const campaignId = String(row.campaignId || row.campaign_id || '');
      const date = String(row.date || row.startDate || '').slice(0, 10);
      if (!campaignId || !date) continue;
      const key = `${campaignId}-${date}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const record: any = {
        amazon_account_id: accountId,
        campaign_id: campaignId,
        campaign_name: row.campaignName || row.campaign_name || null,
        date,
        spend: numberValue(row.cost ?? row.spend),
        sales: numberValue(row.sales30d ?? row.sales14d ?? row.sales7d ?? row.sales),
        orders: numberValue(row.purchases30d ?? row.purchases14d ?? row.purchases7d ?? row.orders),
        clicks: numberValue(row.clicks),
        impressions: numberValue(row.impressions),
        daily_budget: numberValue(row.campaignBudgetAmount ?? row.budget),
        campaign_status: String(row.campaignStatus || '').toLowerCase() || null,
        source: 'amazon_ads_api',
        synced_at: now2,
        updated_at: now2,
      };

      const current = existingByKey.get(key);
      if (current) {
        toUpdate.push({ id: current.id, ...record });
      } else {
        toCreate.push(record);
      }
    }

    const BATCH = 100;
    for (let i = 0; i < toCreate.length; i += BATCH) {
      await base44.asServiceRole.entities.CampaignMetricsDaily.bulkCreate(toCreate.slice(i, i + BATCH));
    }
    for (let i = 0; i < toUpdate.length; i += BATCH) {
      await base44.asServiceRole.entities.CampaignMetricsDaily.bulkUpdate(toUpdate.slice(i, i + BATCH));
    }

    const createdCount = toCreate.length;
    const updatedCount = toUpdate.length;

    const now = new Date().toISOString();
    const summary = {
      ok: true,
      report_id: reportId,
      rows_received: rows.length,
      unique_rows: seen.size,
      created: createdCount,
      updated: updatedCount,
      source: 'amazon_ads_api',
      start_date: ymd(start),
      end_date: ymd(end)
    };

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'sync_ads_performance_metrics_v2',
      status: 'success',
      trigger_type: body.trigger_type || 'scheduled',
      started_at: startedAt,
      completed_at: now,
      records_processed: seen.size,
      result_summary: JSON.stringify(summary).slice(0, 4000),
      error_message: null
    }).catch(() => {});

    await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
      last_sync_at: now,
      ads_metrics_last_sync_at: now
    }).catch(() => {});

    return Response.json(summary);
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao sincronizar métricas Amazon Ads' }, { status: 500 });
  }
});