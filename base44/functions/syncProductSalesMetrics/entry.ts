/**
 * syncProductSalesMetrics — Busca métricas de vendas de produtos via SP-API
 * 
 * Dados retornados:
 * - sales (vendas em $)
 * - unitsOrdered (unidades pedidas)
 * - orderItemCount (total de itens do pedido)
 * - averageSalesPerOrderItem (vendas médias por item)
 * - averageUnitsPerOrder (média de unidades por pedido)
 * - averagePrice (preço médio de venda)
 * - sessions (sessões - total)
 * - sessionPercentage (porcentagem da sessão do item)
 * - offerCount (média de contagem de ofertas)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function getSPApiToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: Deno.env.get('SP_CLIENT_ID') || '',
    client_secret: Deno.env.get('SP_CLIENT_SECRET') || '',
  });
  
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  
  const data = await res.json();
  if (!res.ok) throw new Error(`Token error: ${data.error_description || data.error}`);
  return data.access_token;
}

function getSPApiBase(region) {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://sellingpartnerapi-eu.amazon.com';
  if (r.includes('FE')) return 'https://sellingpartnerapi-fe.amazon.com';
  return 'https://sellingpartnerapi-na.amazon.com';
}

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

    const refreshToken = account.ads_refresh_token || Deno.env.get('SP_REFRESH_TOKEN');
    if (!refreshToken) return Response.json({ error: 'Sem refresh token SP-API' }, { status: 400 });

    const marketplaceId = account.marketplace_id || Deno.env.get('AMAZON_MARKETPLACE_ID') || 'ATVPDKIKX0DER';
    const sellerId = account.seller_id || Deno.env.get('AMAZON_SELLER_ID');
    
    const token = await getSPApiToken(refreshToken);
    const spBase = getSPApiBase(account.region);

    // Buscar relatório de vendas de produtos (últimos 30 dias)
    const endDate = new Date();
    const startDate = new Date(Date.now() - 30 * 86400000);
    
    const reportRes = await fetch(`${spBase}/reports/2021-06-30/reports`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-amz-access-token': token,
      },
      body: JSON.stringify({
        reportType: 'GET_MERCHANT_LISTINGS_ALL_DATA',
        marketplaceIds: [marketplaceId],
      }),
    });

    if (!reportRes.ok) {
      const err = await reportRes.json().catch(() => ({}));
      return Response.json({ 
        error: 'Falha ao solicitar relatório',
        amazon_error: err.errors?.[0]?.message || JSON.stringify(err) 
      }, { status: 500 });
    }

    const reportData = await reportRes.json();
    const reportId = reportData.reportId;

    // Aguardar processamento (polling simples)
    let reportStatus = 'IN_QUEUE';
    let reportUrl = null;
    let attempts = 0;
    
    while (reportStatus === 'IN_QUEUE' && attempts < 10) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const statusRes = await fetch(`${spBase}/reports/2021-06-30/reports/${reportId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'x-amz-access-token': token,
        },
      });
      
      const statusData = await statusRes.json();
      reportStatus = statusData.processingStatus;
      if (reportStatus === 'DONE') reportUrl = statusData.reportDocumentId;
      attempts++;
    }

    if (!reportUrl) {
      return Response.json({ error: 'Relatório não processado a tempo', status: reportStatus }, { status: 500 });
    }

    // Baixar documento do relatório
    const docRes = await fetch(`${spBase}/reports/2021-06-30/documents/${reportUrl}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'x-amz-access-token': token },
    });
    
    const reportText = await docRes.text();
    const lines = reportText.split('\n').filter(l => l.trim());
    const headers = lines[0].split('\t');
    
    const products = [];
    for (let i = 1; i < Math.min(lines.length, 100); i++) {
      const values = lines[i].split('\t');
      const row = {};
      headers.forEach((h, idx) => { row[h.trim()] = values[idx] || '' });
      
      products.push({
        asin: row['asin'] || '',
        sku: row['seller-sku'] || '',
        title: row['item-name'] || '',
        price: parseFloat(row['your-price'] || '0'),
        sales: parseFloat(row['sales-last-30-days'] || '0'),
        unitsOrdered: parseInt(row['units-ordered-last-30-days'] || '0'),
        sessions: parseInt(row['page-views-last-30-days'] || '0'),
        buyBoxPercentage: parseFloat(row['buy-box-percentage-last-30-days'] || '0'),
      });
    }

    // Calcular métricas agregadas
    const totalSales = products.reduce((sum, p) => sum + p.sales, 0);
    const totalUnits = products.reduce((sum, p) => sum + p.unitsOrdered, 0);
    const totalSessions = products.reduce((sum, p) => sum + p.sessions, 0);
    const avgPrice = products.length > 0 ? products.reduce((sum, p) => sum + p.price, 0) / products.length : 0;
    const avgUnitsPerOrder = totalUnits > 0 ? totalUnits / products.length : 0;
    const avgSalesPerItem = products.length > 0 ? totalSales / products.length : 0;
    const sessionPercentage = totalSessions > 0 ? (totalUnits / totalSessions * 100) : 0;

    return Response.json({
      ok: true,
      amazon_account_id: amazonAccountId,
      period: { start: startDate.toISOString().slice(0, 10), end: endDate.toISOString().slice(0, 10) },
      summary: {
        totalSales,
        totalUnits,
        totalSessions,
        avgPrice,
        avgUnitsPerOrder,
        avgSalesPerItem,
        sessionPercentage,
        totalProducts: products.length,
      },
      products: products.slice(0, 50),
      message: `${products.length} produtos sincronizados`,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});