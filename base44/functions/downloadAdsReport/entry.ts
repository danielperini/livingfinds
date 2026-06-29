/**
 * downloadAdsReport — Verifica, baixa e processa os 3 relatórios de 30 dias.
 * Popula: Campaign (métricas), Product (vendas ads), Keyword (search terms), CampaignMetricsDaily, Decision (via IA).
 * Depois invoca análise IA para gerar decisões automáticas.
 * Payload: { amazon_account_id, report_ids?: {campaigns, products, keywords} }
 *   Se report_ids omitido, busca o último SyncRun pendente automaticamente.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

async function getAdsToken() {
  const cached = tokenCache['ads'];
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: Deno.env.get('ADS_REFRESH_TOKEN'),
    client_id: Deno.env.get('ADS_CLIENT_ID'),
    client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token failed');
  tokenCache['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBaseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function checkReport(reportId) {
  const token = await getAdsToken();
  const res = await fetch(`${getAdsBaseUrl()}/reporting/reports/${reportId}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
    },
  });
  const data = await res.json();
  return data; // { status, url, ... }
}

async function downloadAndParse(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const gzipped = await res.arrayBuffer();
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(new Uint8Array(gzipped));
  writer.close();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  return JSON.parse(text);
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  let base44;

  try {
    base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const amazonAccountId = body.amazon_account_id;
    if (!amazonAccountId) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    // Resolver reportIds — do payload ou do último SyncRun pendente
    let reportIds = body.report_ids || null;
    let syncRunId = null;

    if (!reportIds) {
      const runs = await base44.asServiceRole.entities.SyncRun.filter({
        amazon_account_id: amazonAccountId,
        status: 'running',
      }, '-started_at', 20);
      const pending = runs.find(r => r.operation?.startsWith('adsReports:'));
      if (!pending) return Response.json({ ok: false, error: 'Nenhum relatório pendente. Execute requestAdsReport primeiro.' }, { status: 404 });
      const match = pending.operation.match(/adsReports:[^:]+:(.+)/);
      reportIds = match ? JSON.parse(match[1]) : {};
      syncRunId = pending.id;
    }

    const results = { ready: {}, pending: {}, failed: {} };
    const data = { campaigns: [], products: [], keywords: [] };

    // Verificar e baixar cada relatório
    for (const [key, reportId] of Object.entries(reportIds)) {
      if (!reportId) continue;
      const status = await checkReport(reportId);
      if (status.status === 'COMPLETED' && status.url) {
        try {
          data[key] = await downloadAndParse(status.url);
          results.ready[key] = { reportId, rows: data[key].length };
        } catch (e) {
          results.failed[key] = e.message;
        }
      } else if (status.status === 'FAILED') {
        results.failed[key] = status.failureReason || 'Report FAILED';
      } else {
        results.pending[key] = status.status;
      }
    }

    const pendingCount = Object.keys(results.pending).length;
    if (pendingCount > 0 && Object.keys(results.ready).length === 0) {
      return Response.json({ ok: true, ready: false, pending: results.pending, message: 'Relatórios ainda a processar. Tente novamente em 5 minutos.' });
    }

    // ── Processar Campanhas ──
    let campaignUpserted = 0;
    let totalSpend = 0, totalSales = 0, totalClicks = 0, totalImpressions = 0, totalOrders = 0;

    for (const row of data.campaigns) {
      const campaignId = String(row.campaignId);
      const spend = Number(row.cost) || 0;
      const sales = Number(row.sales30d) || Number(row.sales14d) || Number(row.sales1d) || 0;
      const clicks = Number(row.clicks) || 0;
      const impressions = Number(row.impressions) || 0;
      const orders = Number(row.purchases30d) || Number(row.purchases14d) || Number(row.purchases1d) || 0;
      const acos = sales > 0 ? (spend / sales * 100) : 0;
      const roas = spend > 0 ? (sales / spend) : 0;
      const ctr = impressions > 0 ? (clicks / impressions * 100) : 0;
      const cpc = clicks > 0 ? (spend / clicks) : 0;

      totalSpend += spend;
      totalSales += sales;
      totalClicks += clicks;
      totalImpressions += impressions;
      totalOrders += orders;

      const existing = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId, campaign_id: campaignId });
      const update = {
        spend, sales, clicks, impressions, orders, acos, roas, ctr, cpc,
        // campos extras das colunas expandidas
        synced_at: new Date().toISOString(),
      };
      if (existing.length > 0) {
        await base44.asServiceRole.entities.Campaign.update(existing[0].id, update);
        campaignUpserted++;
      }

      // Gravar métricas diárias (summary = data de hoje)
      const today = new Date().toISOString().slice(0, 10);
      const metricEx = await base44.asServiceRole.entities.CampaignMetricsDaily.filter({
        amazon_account_id: amazonAccountId, campaign_id: campaignId, date: today,
      });
      const metricRecord = { amazon_account_id: amazonAccountId, campaign_id: campaignId, date: today, spend, sales, clicks, impressions, orders, acos, roas, ctr, cpc };
      if (metricEx.length > 0) {
        await base44.asServiceRole.entities.CampaignMetricsDaily.update(metricEx[0].id, metricRecord);
      } else {
        await base44.asServiceRole.entities.CampaignMetricsDaily.create(metricRecord);
      }
    }

    // ── Processar Produtos Anunciados ──
    let productUpserted = 0;
    const asinMetrics = {};
    for (const row of data.products) {
      const asin = row.advertisedAsin || row.asin;
      if (!asin) continue;
      if (!asinMetrics[asin]) {
        asinMetrics[asin] = { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0, units: 0, sku: row.advertisedSku };
      }
      asinMetrics[asin].spend += Number(row.cost) || 0;
      asinMetrics[asin].sales += Number(row.sales30d) || Number(row.sales14d) || Number(row.sales1d) || 0;
      asinMetrics[asin].clicks += Number(row.clicks) || 0;
      asinMetrics[asin].impressions += Number(row.impressions) || 0;
      asinMetrics[asin].orders += Number(row.purchases30d) || Number(row.purchases14d) || Number(row.purchases1d) || 0;
      asinMetrics[asin].units += Number(row.unitsSoldClicks30d) || Number(row.unitsSoldClicks14d) || Number(row.unitsSoldClicks1d) || 0;
    }

    for (const [asin, m] of Object.entries(asinMetrics)) {
      const existing = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: amazonAccountId, asin });
      const update = {
        sku: m.sku || existing[0]?.sku || null,
        total_revenue_30d: m.sales,
        units_sold_30d: m.units,
        synced_at: new Date().toISOString(),
      };
      if (existing.length > 0) {
        await base44.asServiceRole.entities.Product.update(existing[0].id, update);
      } else {
        await base44.asServiceRole.entities.Product.create({
          amazon_account_id: amazonAccountId,
          asin,
          status: 'active',
          ...update,
        });
      }
      productUpserted++;
    }

    // ── Processar Keywords / Search Terms ──
    let keywordUpserted = 0;
    for (const row of data.keywords) {
      if (!row.keywordId && !row.searchTerm) continue;
      const kwId = String(row.keywordId || `st_${row.searchTerm}`);
      const spend = Number(row.cost) || 0;
      const sales = Number(row.sales14d) || Number(row.sales1d) || 0;
      const clicks = Number(row.clicks) || 0;
      const impressions = Number(row.impressions) || 0;

      const existing = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: amazonAccountId, keyword_id: kwId });
      const update = {
        spend, sales, clicks, impressions,
        acos: sales > 0 ? (spend / sales * 100) : 0,
        cpc: clicks > 0 ? (spend / clicks) : 0,
        synced_at: new Date().toISOString(),
      };
      if (existing.length > 0) {
        await base44.asServiceRole.entities.Keyword.update(existing[0].id, update);
        keywordUpserted++;
      }
    }

    // ── Análise IA completa → Decisões automáticas ──
    let decisionsCreated = 0;
    try {
      const topCampaigns = data.campaigns
        .filter(r => Number(r.impressions) > 100)
        .sort((a, b) => Number(b.cost) - Number(a.cost))
        .slice(0, 20)
        .map(r => ({
          id: r.campaignId, name: r.campaignName,
          spend: Number(r.cost).toFixed(2),
          sales: Number(r.sales14d || r.sales1d).toFixed(2),
          acos: Number(r.acosClicks14d || (r.sales14d > 0 ? r.cost / r.sales14d * 100 : 0)).toFixed(1),
          roas: Number(r.roasClicks14d || (r.cost > 0 ? r.sales14d / r.cost : 0)).toFixed(2),
          clicks: r.clicks, impressions: r.impressions,
        }));

      const topProducts = Object.entries(asinMetrics)
        .sort((a, b) => b[1].spend - a[1].spend)
        .slice(0, 15)
        .map(([asin, m]) => ({
          asin, spend: m.spend.toFixed(2), sales: m.sales.toFixed(2),
          acos: m.sales > 0 ? (m.spend / m.sales * 100).toFixed(1) : '∞',
          units: m.units, clicks: m.clicks,
        }));

      const topKeywords = data.keywords
        .filter(r => Number(r.clicks) > 5)
        .sort((a, b) => Number(b.cost) - Number(a.cost))
        .slice(0, 20)
        .map(r => ({
          term: r.searchTerm || r.keyword, matchType: r.matchType,
          spend: Number(r.cost).toFixed(2), sales: Number(r.sales14d || r.sales1d).toFixed(2),
          clicks: r.clicks, acos: Number(r.acosClicks14d || 0).toFixed(1),
        }));

      const prompt = `Você é um especialista em Amazon Ads com 10 anos de experiência. Analise os dados dos últimos 30 dias e gere recomendações de optimização accionáveis.

RESUMO GERAL (30 dias):
- Spend Total: $${totalSpend.toFixed(2)}
- Vendas Ads: $${totalSales.toFixed(2)}
- ACoS geral: ${totalSales > 0 ? (totalSpend / totalSales * 100).toFixed(1) : 'N/A'}%
- ROAS geral: ${totalSpend > 0 ? (totalSales / totalSpend).toFixed(2) : 'N/A'}x
- Cliques: ${totalClicks.toLocaleString()}
- Impressões: ${totalImpressions.toLocaleString()}
- Pedidos: ${totalOrders}

TOP CAMPANHAS (por spend):
${JSON.stringify(topCampaigns, null, 1)}

TOP PRODUTOS ANUNCIADOS (por spend):
${JSON.stringify(topProducts, null, 1)}

TOP SEARCH TERMS (por spend):
${JSON.stringify(topKeywords, null, 1)}

Gere entre 5 e 10 recomendações concretas. Para cada uma:
- Identifique o item específico (campanha/produto/keyword)
- Explique o problema com dados
- Sugira a acção exacta (bid, orçamento, estado)
- Estime o impacto esperado

Foco em: campanhas com ACoS > 40%, campanhas sem conversões mas com gasto, produtos rentáveis para aumentar budget, keywords de alto custo sem retorno.`;

      const aiResult = await base44.asServiceRole.integrations.Core.InvokeLLM({
        prompt,
        response_json_schema: {
          type: 'object',
          properties: {
            decisions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  decision_type: { type: 'string', enum: ['bid_adjust', 'budget_change', 'pause_campaign', 'enable_campaign', 'negate_keyword', 'add_keyword'] },
                  entity_type: { type: 'string', enum: ['campaign', 'keyword', 'product'] },
                  entity_id: { type: 'string' },
                  entity_name: { type: 'string' },
                  rationale: { type: 'string' },
                  current_value: { type: 'number' },
                  proposed_value: { type: 'number' },
                  change_pct: { type: 'number' },
                  confidence: { type: 'number' },
                  priority: { type: 'string', enum: ['high', 'medium', 'low'] },
                },
              },
            },
            summary: { type: 'string' },
            overall_health: { type: 'string', enum: ['excellent', 'good', 'fair', 'poor'] },
          },
        },
      });

      const aiDecisions = aiResult?.decisions || [];
      for (const d of aiDecisions) {
        await base44.asServiceRole.entities.Decision.create({
          amazon_account_id: amazonAccountId,
          decision_type: d.decision_type || 'bid_adjust',
          entity_type: d.entity_type || 'campaign',
          entity_id: d.entity_id || '',
          entity_name: d.entity_name || '',
          rationale: d.rationale || '',
          current_value: d.current_value || 0,
          proposed_value: d.proposed_value || 0,
          change_pct: d.change_pct || 0,
          confidence: d.confidence || 0.5,
          priority: d.priority || 'medium',
          status: 'pending',
        });
        decisionsCreated++;
      }
    } catch (aiErr) {
      // AI failure não bloqueia o sync
      console.error('AI analysis failed:', aiErr.message);
    }

    // Marcar SyncRun como concluído
    if (syncRunId) {
      await base44.asServiceRole.entities.SyncRun.update(syncRunId, {
        status: 'success',
        records_received: data.campaigns.length + data.products.length + data.keywords.length,
        records_upserted: campaignUpserted + productUpserted + keywordUpserted,
        duration_ms: Date.now() - startTime,
        completed_at: new Date().toISOString(),
      });
    }

    return Response.json({
      ok: true,
      ready: true,
      pending: results.pending,
      campaigns: { rows: data.campaigns.length, upserted: campaignUpserted },
      products: { rows: data.products.length, upserted: productUpserted },
      keywords: { rows: data.keywords.length, upserted: keywordUpserted },
      decisions_created: decisionsCreated,
      summary: { total_spend: totalSpend, total_sales: totalSales, acos: totalSales > 0 ? totalSpend / totalSales * 100 : 0 },
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});