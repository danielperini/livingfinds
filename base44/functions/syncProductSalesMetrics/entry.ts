/**
 * syncProductSalesMetrics — Busca dados de vendas via SP-API Reports
 *
 * Usa GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL
 * Role necessária: "Inventory and Order Tracking" (Inventário e rastreamento de pedidos)
 * — já aprovada na conta.
 *
 * Agrega pedidos por dia e ASIN, salva em SalesDaily.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function getSPApiToken() {
  const refreshToken = Deno.env.get('AMAZON_SP_REFRESH_TOKEN') || Deno.env.get('SP_REFRESH_TOKEN');
  if (!refreshToken) throw new Error('Sem SP refresh token (AMAZON_SP_REFRESH_TOKEN)');
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
  if (!res.ok) throw new Error(`Token SP-API: ${data.error_description || data.error}`);
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
      if (accounts.length === 0) return Response.json({ error: 'Nenhuma conta Amazon conectada' }, { status: 404 });
      amazonAccountId = accounts[0].id;
    }

    const account = await base44.asServiceRole.entities.AmazonAccount.get(amazonAccountId);
    if (!account) return Response.json({ error: 'Conta não encontrada' }, { status: 404 });

    const marketplaceId = account.marketplace_id || Deno.env.get('AMAZON_MARKETPLACE_ID') || 'A2Q3Y263D00KWC';
    const spBase = getSPApiBase(account.region);
    const token = await getSPApiToken();

    // Período: últimos 30 dias fechados
    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 1);
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 29);

    const startISO = startDate.toISOString().slice(0, 10);
    const endISO = endDate.toISOString().slice(0, 10);

    console.log(`[syncProductSalesMetrics] Solicitando relatório de pedidos ${startISO} → ${endISO}`);

    // 1. Solicitar relatório de pedidos (role: Inventory and Order Tracking)
    const reportRes = await fetch(`${spBase}/reports/2021-06-30/reports`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-amz-access-token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
        marketplaceIds: [marketplaceId],
        dataStartTime: startDate.toISOString(),
        dataEndTime: endDate.toISOString(),
      }),
    });

    if (!reportRes.ok) {
      const err = await reportRes.json().catch(() => ({}));
      const msg = err.errors?.[0]?.message || JSON.stringify(err);
      console.error(`[syncProductSalesMetrics] Erro ao solicitar: ${msg}`);
      return Response.json({ error: 'Falha ao solicitar relatório SP-API', amazon_error: msg }, { status: 500 });
    }

    const { reportId } = await reportRes.json();
    console.log(`[syncProductSalesMetrics] reportId: ${reportId}`);

    // 2. Polling até DONE (max ~60s)
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
        return Response.json({ error: `Relatório ${reportStatus}`, detail: statusData }, { status: 500 });
      }
      console.log(`[syncProductSalesMetrics] Tentativa ${i + 1}/15 — ${reportStatus}`);
    }

    if (!reportDocumentId) {
      return Response.json({ error: 'Timeout aguardando relatório', status: reportStatus }, { status: 500 });
    }

    // 3. Baixar URL do documento
    const docRes = await fetch(`${spBase}/reports/2021-06-30/documents/${reportDocumentId}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'x-amz-access-token': token },
    });
    const docMeta = await docRes.json();
    const downloadUrl = docMeta.url;
    if (!downloadUrl) return Response.json({ error: 'URL do documento ausente', docMeta }, { status: 500 });

    // 4. Baixar TSV
    const contentRes = await fetch(downloadUrl);
    if (!contentRes.ok) return Response.json({ error: 'Falha ao baixar conteúdo', status: contentRes.status }, { status: 500 });

    const text = await contentRes.text();
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) return Response.json({ ok: true, message: 'Relatório vazio', records_saved: 0 });

    // 5. Parsear TSV — colunas do relatório de pedidos flat file
    const headers = lines[0].split('\t').map(h => h.trim().toLowerCase());
    const num = (val) => {
      if (!val || val === '--' || val === '-') return 0;
      return parseFloat(String(val).replace(/[^0-9.-]/g, '')) || 0;
    };

    // Agregar por (date, asin)
    const byDateAsin = new Map();

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split('\t');
      const row = {};
      headers.forEach((h, idx) => { row[h] = (values[idx] || '').trim(); });

      // Extrair data do pedido (purchase-date ou order-date)
      const rawDate = row['purchase-date'] || row['order-date'] || row['purchase_date'] || '';
      if (!rawDate) continue;
      const date = rawDate.slice(0, 10); // YYYY-MM-DD
      if (date < startISO || date > endISO) continue;

      const asin = row['asin'] || '';
      const sku = row['sku'] || row['seller-sku'] || '';
      const qty = num(row['quantity'] || row['quantity-purchased'] || '1');
      const price = num(row['item-price'] || row['item_price'] || '0');

      const key = `${date}|${asin || sku}`;
      if (!byDateAsin.has(key)) {
        byDateAsin.set(key, {
          amazon_account_id: amazonAccountId,
          asin,
          sku,
          date,
          units_ordered: 0,
          ordered_product_sales: 0,
          sessions: 0,
          page_views: 0,
          buy_box_pct: 0,
          conversion_rate: 0,
        });
      }
      const entry = byDateAsin.get(key);
      entry.units_ordered += qty;
      entry.ordered_product_sales += price;
    }

    const records = Array.from(byDateAsin.values());
    console.log(`[syncProductSalesMetrics] ${records.length} registros (date×asin) extraídos`);

    if (records.length === 0) {
      return Response.json({ ok: true, message: 'Nenhum pedido encontrado no período', records_saved: 0 });
    }

    // 6. Deletar registros antigos do período e salvar novos
    await base44.asServiceRole.entities.SalesDaily.deleteMany({
      amazon_account_id: amazonAccountId,
      date: { $gte: startISO, $lte: endISO },
    });

    const BATCH = 50;
    let saved = 0;
    for (let i = 0; i < records.length; i += BATCH) {
      await base44.asServiceRole.entities.SalesDaily.bulkCreate(records.slice(i, i + BATCH));
      saved += Math.min(BATCH, records.length - i);
    }

    console.log(`[syncProductSalesMetrics] ${saved} registros salvos em SalesDaily`);

    return Response.json({
      ok: true,
      amazon_account_id: amazonAccountId,
      period: { start: startISO, end: endISO },
      report_id: reportId,
      records_saved: saved,
      message: `${saved} registros diários salvos em SalesDaily`,
    });

  } catch (error) {
    console.error('[syncProductSalesMetrics] Erro:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});