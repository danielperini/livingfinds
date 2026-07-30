/**
 * Sincroniza vendas reais por meio do relatório de pedidos da SP-API.
 *
 * Fallback para contas sem a role Finances. Requer a role já aprovada
 * "Inventory and Order Tracking" e nunca apaga o período antes do upsert.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const number = (value: unknown) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

function brtDate(daysAgo = 0) {
  return new Date(Date.now() - 3 * 3600000 - daysAgo * 86400000).toISOString().slice(0, 10);
}

function dateRangeInclusive(startDate: string, endDate: string) {
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T12:00:00-03:00`);
  const end = new Date(`${endDate}T12:00:00-03:00`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

async function getSpApiToken() {
  const refreshToken = Deno.env.get('AMAZON_SP_REFRESH_TOKEN') || Deno.env.get('SP_REFRESH_TOKEN');
  const clientId = Deno.env.get('AMAZON_LWA_CLIENT_ID') || Deno.env.get('SP_CLIENT_ID');
  const clientSecret = Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || Deno.env.get('SP_CLIENT_SECRET');
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error('Credenciais SP-API incompletas para o relatório de pedidos');
  }
  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(`Token SP-API: ${data.error_description || data.error || response.status}`);
  }
  return data.access_token;
}

function spApiBase(region: unknown) {
  const normalized = String(region || 'NA').toUpperCase();
  if (normalized.includes('EU')) return 'https://sellingpartnerapi-eu.amazon.com';
  if (normalized.includes('FE')) return 'https://sellingpartnerapi-fe.amazon.com';
  return 'https://sellingpartnerapi-na.amazon.com';
}

async function upsertSalesDaily(base44: any, record: any) {
  const rows = await base44.asServiceRole.entities.SalesDaily.filter({
    amazon_account_id: record.amazon_account_id,
    date: record.date,
  }, '-updated_date', 500);
  const current = record.asin
    ? rows.find((row: any) => row.asin === record.asin)
    : rows.find((row: any) => !row.asin);
  if (current) return base44.asServiceRole.entities.SalesDaily.update(current.id, record);
  return base44.asServiceRole.entities.SalesDaily.create(record);
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
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-last_sync_at', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon conectada' }, { status: 404 });

    const accountId = account.id;
    const marketplaceId = account.marketplace_id || Deno.env.get('AMAZON_MARKETPLACE_ID') || 'A2Q3Y263D00KWC';
    const baseUrl = spApiBase(account.region);
    const token = await getSpApiToken();
    const lookbackDays = Math.max(1, Math.min(60, Number(body.lookback_days || 7)));
    const endDate = brtDate(1);
    const startDate = brtDate(lookbackDays);

    const createResponse = await fetch(`${baseUrl}/reports/2021-06-30/reports`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-amz-access-token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
        marketplaceIds: [marketplaceId],
        dataStartTime: `${startDate}T00:00:00-03:00`,
        dataEndTime: `${endDate}T23:59:59-03:00`,
      }),
    });
    const createData = await createResponse.json().catch(() => ({}));
    if (!createResponse.ok || !createData.reportId) {
      const detail = createData.errors?.[0]?.message || JSON.stringify(createData).slice(0, 500);
      return Response.json({
        ok: false,
        stage: 'request_orders_report',
        error: `SP-API Orders Report ${createResponse.status}: ${detail}`,
      }, { status: 502 });
    }

    let reportStatus = 'IN_QUEUE';
    let documentId = '';
    for (let attempt = 1; attempt <= 30 && ['IN_QUEUE', 'IN_PROGRESS'].includes(reportStatus); attempt++) {
      await sleep(4000);
      const statusResponse = await fetch(
        `${baseUrl}/reports/2021-06-30/reports/${createData.reportId}`,
        { headers: { Authorization: `Bearer ${token}`, 'x-amz-access-token': token } },
      );
      const statusData = await statusResponse.json().catch(() => ({}));
      if (!statusResponse.ok) {
        return Response.json({
          ok: false,
          stage: 'poll_orders_report',
          error: `SP-API report status ${statusResponse.status}`,
          detail: statusData,
        }, { status: 502 });
      }
      reportStatus = statusData.processingStatus;
      if (reportStatus === 'DONE') documentId = statusData.reportDocumentId || '';
      if (['CANCELLED', 'FATAL'].includes(reportStatus)) {
        return Response.json({
          ok: false,
          stage: 'poll_orders_report',
          error: `Relatório de pedidos ${reportStatus}`,
          detail: statusData,
        }, { status: 502 });
      }
    }
    if (!documentId) {
      return Response.json({
        ok: false,
        stage: 'poll_orders_report',
        error: 'Timeout aguardando relatório de pedidos',
        report_status: reportStatus,
      }, { status: 504 });
    }

    const documentResponse = await fetch(
      `${baseUrl}/reports/2021-06-30/documents/${documentId}`,
      { headers: { Authorization: `Bearer ${token}`, 'x-amz-access-token': token } },
    );
    const document = await documentResponse.json().catch(() => ({}));
    if (!documentResponse.ok || !document.url) {
      return Response.json({
        ok: false,
        stage: 'download_orders_report',
        error: `Documento do relatório indisponível (${documentResponse.status})`,
      }, { status: 502 });
    }

    const contentResponse = await fetch(document.url);
    if (!contentResponse.ok) {
      return Response.json({
        ok: false,
        stage: 'download_orders_report',
        error: `Download do relatório falhou (${contentResponse.status})`,
      }, { status: 502 });
    }
    const text = await contentResponse.text();
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    const headers = (lines[0] || '').split('\t').map((header) => header.trim().toLowerCase());
    const byDateAsin = new Map<string, any>();

    for (let index = 1; index < lines.length; index++) {
      const values = lines[index].split('\t');
      const row: Record<string, string> = {};
      headers.forEach((header, column) => { row[header] = (values[column] || '').trim(); });
      const date = String(row['purchase-date'] || row['order-date'] || row.purchase_date || '').slice(0, 10);
      if (!date || date < startDate || date > endDate) continue;
      const asin = row.asin || '';
      const sku = row.sku || row['seller-sku'] || '';
      if (!asin && !sku) continue;
      const key = `${date}|${asin || sku}`;
      const current = byDateAsin.get(key) || {
        amazon_account_id: accountId,
        asin,
        sku,
        date,
        units_ordered: 0,
        ordered_product_sales: 0,
        orders: 0,
        sessions: 0,
        page_views: 0,
        buy_box_pct: 0,
        conversion_rate: 0,
        source: 'sp_api_orders_report',
        finance_sync_status: 'orders_synced',
        finance_synced_at: new Date().toISOString(),
      };
      const quantity = Math.max(1, number(row.quantity || row['quantity-purchased'] || 1));
      current.units_ordered += quantity;
      current.ordered_product_sales += number(row['item-price'] || row.item_price);
      current.orders += 1;
      byDateAsin.set(key, current);
    }

    const itemRecords = [...byDateAsin.values()].map((record) => ({
      ...record,
      ordered_product_sales: Number(record.ordered_product_sales.toFixed(2)),
    }));
    const totals = new Map(
      dateRangeInclusive(startDate, endDate).map((date) => [date, { revenue: 0, units: 0, orders: 0 }]),
    );
    for (const record of itemRecords) {
      const total = totals.get(record.date);
      if (!total) continue;
      total.revenue += record.ordered_product_sales;
      total.units += record.units_ordered;
      total.orders += record.orders;
    }
    const accountRecords = [...totals.entries()].map(([date, total]) => ({
      amazon_account_id: accountId,
      date,
      units_ordered: total.units,
      ordered_product_sales: Number(total.revenue.toFixed(2)),
      orders: total.orders,
      sessions: 0,
      page_views: 0,
      buy_box_pct: 0,
      conversion_rate: 0,
      source: 'sp_api_orders_report',
      finance_sync_status: total.orders > 0 ? 'orders_synced' : 'no_events',
      finance_synced_at: new Date().toISOString(),
      finance_events_count: 0,
    }));

    let saved = 0;
    for (const record of [...itemRecords, ...accountRecords]) {
      await upsertSalesDaily(base44, record);
      saved++;
    }

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'sync_product_sales_metrics',
      status: 'success',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      records_processed: saved,
      result_summary: JSON.stringify({
        source: 'sp_api_orders_report',
        report_id: createData.reportId,
        period: `${startDate}→${endDate}`,
        item_records: itemRecords.length,
        days_processed: accountRecords.length,
      }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      source: 'sp_api_orders_report',
      amazon_account_id: accountId,
      report_id: createData.reportId,
      period: { start: startDate, end: endDate },
      records_saved: saved,
      item_records: itemRecords.length,
      days_processed: accountRecords.length,
      days_without_orders: accountRecords.filter((row) => row.orders === 0).length,
      latest_synced_date: endDate,
      duration_ms: Date.now() - new Date(startedAt).getTime(),
    });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error?.message || 'Falha ao sincronizar relatório de pedidos SP-API',
    }, { status: 500 });
  }
});
