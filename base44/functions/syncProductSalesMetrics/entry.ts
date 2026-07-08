/**
 * syncProductSalesMetrics — Busca Business Report (GET_SALES_AND_TRAFFIC_REPORT) via SP-API
 * e persiste dados diários na entidade SalesDaily.
 *
 * Fluxo:
 * 1. Solicita relatório à SP-API
 * 2. Aguarda processamento via polling (até 60s)
 * 3. Baixa e parseia o TSV
 * 4. Upsert de registros em SalesDaily por (amazon_account_id, asin, date)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function getSPApiToken() {
  const refreshToken = Deno.env.get('AMAZON_SP_REFRESH_TOKEN') || Deno.env.get('SP_REFRESH_TOKEN');
  if (!refreshToken) throw new Error('Sem SP refresh token configurado (AMAZON_SP_REFRESH_TOKEN)');

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: Deno.env.get('AMAZON_LWA_CLIENT_ID') || Deno.env.get('SP_CLIENT_ID') || '',
    client_secret: Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || Deno.env.get('SP_CLIENT_SECRET') || '',
  });

  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Token SP-API error: ${data.error_description || data.error}`);
  return data.access_token;
}

function getSPApiBase(region) {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://sellingpartnerapi-eu.amazon.com';
  if (r.includes('FE')) return 'https://sellingpartnerapi-fe.amazon.com';
  return 'https://sellingpartnerapi-na.amazon.com';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    let amazonAccountId = body.amazon_account_id;

    if (!amazonAccountId) {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-last_sync_at', 1);
      if (accounts.length === 0) return Response.json({ error: 'Nenhuma conta Amazon encontrada' }, { status: 404 });
      amazonAccountId = accounts[0].id;
    }

    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazonAccountId);
    if (!account) return Response.json({ error: 'Conta não encontrada' }, { status: 404 });

    const marketplaceId = account.marketplace_id || Deno.env.get('AMAZON_MARKETPLACE_ID') || 'A2Q3Y263D00KWC';
    const spBase = getSPApiBase(account.region);

    // Período: últimos 30 dias fechados
    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 1); // ontem
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 29); // 30 dias atrás

    const token = await getSPApiToken();

    // 1. Solicitar relatório
    console.log(`[syncProductSalesMetrics] Solicitando relatório ${startDate.toISOString().slice(0,10)} → ${endDate.toISOString().slice(0,10)}`);
    const reportRes = await fetch(`${spBase}/reports/2021-06-30/reports`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-amz-access-token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
        marketplaceIds: [marketplaceId],
        dataStartTime: startDate.toISOString(),
        dataEndTime: endDate.toISOString(),
        reportOptions: { dateGranularity: 'DAY' },
      }),
    });

    if (!reportRes.ok) {
      const err = await reportRes.json().catch(() => ({}));
      const msg = err.errors?.[0]?.message || JSON.stringify(err);
      console.error(`[syncProductSalesMetrics] Falha ao solicitar: ${msg}`);
      return Response.json({ error: 'Falha ao solicitar relatório SP-API', amazon_error: msg }, { status: 500 });
    }

    const { reportId } = await reportRes.json();
    console.log(`[syncProductSalesMetrics] reportId: ${reportId}`);

    // 2. Polling até DONE (max 60s)
    let reportStatus = 'IN_QUEUE';
    let reportDocumentId = null;
    for (let i = 0; i < 15 && ['IN_QUEUE', 'IN_PROGRESS'].includes(reportStatus); i++) {
      await sleep(4000);
      const statusRes = await fetch(`${spBase}/reports/2021-06-30/reports/${reportId}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'x-amz-access-token': token },
      });
      const statusData = await statusRes.json();
      reportStatus = statusData.processingStatus;
      if (reportStatus === 'DONE') reportDocumentId = statusData.reportDocumentId;
      else if (reportStatus === 'CANCELLED' || reportStatus === 'FATAL') {
        return Response.json({ error: `Relatório ${reportStatus}`, status: reportStatus }, { status: 500 });
      }
      console.log(`[syncProductSalesMetrics] Tentativa ${i+1}/15 — ${reportStatus}`);
    }

    if (!reportDocumentId) {
      return Response.json({ error: 'Relatório não processado a tempo', status: reportStatus }, { status: 500 });
    }

    // 3. Baixar URL do documento
    const docMeta = await (await fetch(`${spBase}/reports/2021-06-30/documents/${reportDocumentId}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'x-amz-access-token': token },
    })).json();

    const downloadUrl = docMeta.url;
    if (!downloadUrl) return Response.json({ error: 'URL do documento não encontrada', docMeta }, { status: 500 });

    // 4. Baixar conteúdo TSV
    const contentRes = await fetch(downloadUrl);
    if (!contentRes.ok) return Response.json({ error: 'Falha ao baixar conteúdo', status: contentRes.status }, { status: 500 });

    const text = await contentRes.text();
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) return Response.json({ ok: true, message: 'Relatório vazio', lines: lines.length });

    // 5. Parsear TSV
    const headers = lines[0].split('\t').map(h => h.trim());
    const num = (val) => {
      if (!val || val === '--' || val === '-' || val === 'N/A') return 0;
      return parseFloat(val.replace(/[^0-9.-]/g, '')) || 0;
    };

    const records = [];
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split('\t');
      const row = {};
      headers.forEach((h, idx) => { row[h] = (values[idx] || '').trim(); });

      // O relatório por DAY tem uma coluna de data
      const date = row['date'] || row['Date'] || row['startDate'] || endDate.toISOString().slice(0, 10);
      const asin = row['parentAsin'] || row['childAsin'] || row['ASIN'] || row['asin'] || '';
      const sku = row['sku'] || row['SKU'] || row['seller-sku'] || '';

      if (!asin && !sku) continue;

      records.push({
        amazon_account_id: amazonAccountId,
        asin,
        sku,
        date: date.slice(0, 10),
        units_ordered: num(row['unitsOrdered']),
        ordered_product_sales: num(row['orderedProductSales'] || row['orderedProductSalesAmount']),
        sessions: num(row['sessionsTotal'] || row['sessions']),
        page_views: num(row['pageViewsTotal'] || row['pageViews']),
        buy_box_pct: num(row['buyBoxPercentage']),
        conversion_rate: num(row['unitSessionRatio'] || row['sessionItemOrderRatio']),
      });
    }

    console.log(`[syncProductSalesMetrics] ${records.length} registros para salvar`);

    // 6. Upsert em SalesDaily — deletar e recriar para o período
    if (records.length > 0) {
      // Deletar registros antigos do período para evitar duplicatas
      await base44.asServiceRole.entities.SalesDaily.deleteMany({
        amazon_account_id: amazonAccountId,
        date: { $gte: startDate.toISOString().slice(0, 10), $lte: endDate.toISOString().slice(0, 10) },
      });

      // Salvar em lotes de 50
      const BATCH = 50;
      let saved = 0;
      for (let i = 0; i < records.length; i += BATCH) {
        const batch = records.slice(i, i + BATCH);
        await base44.asServiceRole.entities.SalesDaily.bulkCreate(batch);
        saved += batch.length;
      }

      console.log(`[syncProductSalesMetrics] ${saved} registros salvos em SalesDaily`);
    }

    return Response.json({
      ok: true,
      amazon_account_id: amazonAccountId,
      period: { start: startDate.toISOString().slice(0, 10), end: endDate.toISOString().slice(0, 10) },
      report_id: reportId,
      records_saved: records.length,
      message: `${records.length} registros salvos em SalesDaily`,
    });
  } catch (error) {
    console.error('[syncProductSalesMetrics] Erro:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});