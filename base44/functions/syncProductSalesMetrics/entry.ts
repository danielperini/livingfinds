/**
 * syncProductSalesMetrics — Busca métricas completas de vendas e tráfego via SP-API
 * 
 * Relatório: GET_SALES_AND_TRAFFIC_REPORT (Business Reports)
 * 
 * Métricas retornadas:
 * Vendas:
 * - orderedProductSales (vendas de produtos pedidos)
 * - unitsOrdered (unidades pedidas)
 * - orderItemCount (total de itens do pedido)
 * - averageSalesPerOrderItem (vendas médias por item)
 * - averageUnitsPerOrder (média de unidades por pedido)
 * - averagePrice (preço médio de venda)
 * 
 * Tráfego:
 * - pageViewsMobile (visualizações mobile)
 * - pageViewsDesktop (visualizações desktop)
 * - pageViewsTotal (visualizações total)
 * - sessionsMobile (sessões mobile)
 * - sessionsDesktop (sessões desktop)
 * - sessionsTotal (sessões total)
 * 
 * Conversão:
 * - buyBoxPercentage (porcentagem buy box)
 * - sessionItemOrderRatio (porcentagem sessão do item do pedido)
 * - unitSessionRatio (porcentagem sessão de unidade)
 * - offerCount (média de ofertas)
 * - parentItemCount (média de produtos parent)
 * 
 * Reembolsos:
 * - unitsRefunded (unidades reembolsadas)
 * - refundRate (tarifa de reembolso)
 * 
 * Avaliações:
 * - reviewsReceived (avaliações recebidas)
 * - negativeReviewsReceived (avaliações negativas)
 * - negativeReviewRate (índice negativas)
 * 
 * Reclamações:
 * - claimsGranted (reivindicações A-Z)
 * - claimsAmount (valor das reivindicações)
 * 
 * Envios:
 * - shippedProductSales (vendas de produtos enviados)
 * - unitsShipped (unidades enviadas)
 * - ordersShipped (pedidos enviados)
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

    // Solicitar relatório GET_SALES_AND_TRAFFIC_REPORT (últimos 30 dias)
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
        reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
        marketplaceIds: [marketplaceId],
        dataStartTime: startDate.toISOString(),
        dataEndTime: endDate.toISOString(),
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
    console.log(`[syncProductSalesMetrics] Relatório solicitado: ${reportId}`);

    // Aguardar processamento (polling)
    let reportStatus = 'IN_QUEUE';
    let reportDocumentId = null;
    let attempts = 0;
    
    while (['IN_QUEUE', 'IN_PROGRESS'].includes(reportStatus) && attempts < 15) {
      await new Promise(resolve => setTimeout(resolve, 4000));
      
      const statusRes = await fetch(`${spBase}/reports/2021-06-30/reports/${reportId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'x-amz-access-token': token,
        },
      });
      
      const statusData = await statusRes.json();
      reportStatus = statusData.processingStatus;
      if (reportStatus === 'DONE') reportDocumentId = statusData.reportDocumentId;
      else if (reportStatus === 'CANCELLED' || reportStatus === 'FATAL') {
        return Response.json({ error: 'Relatório falhou', status: reportStatus }, { status: 500 });
      }
      attempts++;
      console.log(`[syncProductSalesMetrics] Aguardando... ${attempts}/15 - Status: ${reportStatus}`);
    }

    if (!reportDocumentId) {
      return Response.json({ error: 'Relatório não processado a tempo', status: reportStatus }, { status: 500 });
    }

    // Baixar documento do relatório
    const docRes = await fetch(`${spBase}/reports/2021-06-30/documents/${reportDocumentId}`, {
      headers: { 
        'Authorization': `Bearer ${token}`, 
        'x-amz-access-token': token,
        'Accept': 'text/tab-separated-values',
      },
    });
    
    if (!docRes.ok) {
      return Response.json({ error: 'Falha ao baixar relatório', status: docRes.status }, { status: 500 });
    }
    
    const reportText = await docRes.text();
    const lines = reportText.split('\n').filter(l => l.trim());
    
    if (lines.length < 2) {
      return Response.json({ error: 'Relatório vazio', lines: lines.length }, { status: 400 });
    }

    // Parse TSV
    const headers = lines[0].split('\t').map(h => h.trim());
    console.log(`[syncProductSalesMetrics] Headers: ${headers.length} colunas`);
    
    const products = [];
    for (let i = 1; i < Math.min(lines.length, 200); i++) {
      const values = lines[i].split('\t');
      const row = {};
      headers.forEach((h, idx) => { row[h] = (values[idx] || '').trim() });
      
      // Mapear colunas do relatório
      const asin = row['ASIN'] || row['asin'] || '';
      const sku = row['SKU'] || row['seller-sku'] || '';
      const title = row['title'] || row['item-name'] || '';
      
      // Helper para parsear números
      const num = (val) => {
        if (!val || val === '--' || val === '-') return 0;
        return parseFloat(val.replace(/[^0-9.-]/g, '')) || 0;
      };
      
      products.push({
        asin,
        sku,
        title,
        // Vendas
        orderedProductSales: num(row['orderedProductSales']),
        unitsOrdered: num(row['unitsOrdered']),
        orderItemCount: num(row['orderItemCount']),
        averageSalesPerOrderItem: num(row['averageSalesPerOrderItem']),
        averageUnitsPerOrder: num(row['averageUnitsPerOrder']),
        averagePrice: num(row['averagePrice']),
        
        // Tráfego
        pageViewsMobile: num(row['pageViewsMobile']),
        pageViewsDesktop: num(row['pageViewsDesktop']),
        pageViewsTotal: num(row['pageViewsTotal']),
        sessionsMobile: num(row['sessionsMobile']),
        sessionsDesktop: num(row['sessionsDesktop']),
        sessionsTotal: num(row['sessionsTotal']),
        
        // Conversão
        buyBoxPercentage: num(row['buyBoxPercentage']),
        sessionItemOrderRatio: num(row['sessionItemOrderRatio']),
        unitSessionRatio: num(row['unitSessionRatio']),
        offerCount: num(row['offerCount']),
        parentItemCount: num(row['parentItemCount']),
        
        // Reembolsos
        unitsRefunded: num(row['unitsRefunded']),
        refundRate: num(row['refundRate']),
        
        // Avaliações
        reviewsReceived: num(row['reviewsReceived']),
        negativeReviewsReceived: num(row['negativeReviewsReceived']),
        negativeReviewRate: num(row['negativeReviewRate']),
        
        // Reclamações
        claimsGranted: num(row['claimsGranted']),
        claimsAmount: num(row['claimsAmount']),
        
        // Envios
        shippedProductSales: num(row['shippedProductSales']),
        unitsShipped: num(row['unitsShipped']),
        ordersShipped: num(row['ordersShipped']),
      });
    }

    // Calcular totais agregados
    const summary = {
      totalOrderedProductSales: products.reduce((sum, p) => sum + p.orderedProductSales, 0),
      totalUnitsOrdered: products.reduce((sum, p) => sum + p.unitsOrdered, 0),
      totalPageViews: products.reduce((sum, p) => sum + p.pageViewsTotal, 0),
      totalSessions: products.reduce((sum, p) => sum + p.sessionsTotal, 0),
      totalReviews: products.reduce((sum, p) => sum + p.reviewsReceived, 0),
      totalNegativeReviews: products.reduce((sum, p) => sum + p.negativeReviewsReceived, 0),
      totalUnitsShipped: products.reduce((sum, p) => sum + p.unitsShipped, 0),
      avgBuyBoxPercentage: products.length > 0 ? products.reduce((sum, p) => sum + p.buyBoxPercentage, 0) / products.length : 0,
      avgRefundRate: products.length > 0 ? products.reduce((sum, p) => sum + p.refundRate, 0) / products.length : 0,
      totalProducts: products.length,
    };

    console.log(`[syncProductSalesMetrics] ${products.length} produtos processados`);

    return Response.json({
      ok: true,
      amazon_account_id: amazonAccountId,
      period: { start: startDate.toISOString().slice(0, 10), end: endDate.toISOString().slice(0, 10) },
      report_id: reportId,
      summary,
      products: products.slice(0, 100),
      total_products: products.length,
      message: `${products.length} produtos sincronizados com métricas completas`,
    });
  } catch (error) {
    console.error('[syncProductSalesMetrics] Erro:', error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});