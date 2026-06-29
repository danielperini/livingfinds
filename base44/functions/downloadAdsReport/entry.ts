/**
 * downloadAdsReport — Verifica, baixa e processa os 3 relatórios de 30 dias.
 * Usa bulkCreate/bulkUpdate para evitar rate limits.
 * Payload: { amazon_account_id, report_ids?: {campaigns, products, keywords} }
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
  return await res.json();
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

// Bulk upsert helper: deletes existing records for the account+key and bulk inserts new ones
async function bulkUpsert(base44, entityName, amazonAccountId, records) {
  if (!records.length) return 0;
  // Delete all existing for this account then bulk insert
  await base44.asServiceRole.entities[entityName].deleteMany({ amazon_account_id: amazonAccountId });
  // Insert in batches of 500
  let total = 0;
  for (let i = 0; i < records.length; i += 500) {
    const batch = records.slice(i, i + 500);
    await base44.asServiceRole.entities[entityName].bulkCreate(batch);
    total += batch.length;
  }
  return total;
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const amazonAccountId = body.amazon_account_id;
    if (!amazonAccountId) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    // Resolver reportIds — do payload ou do último SyncRun running
    let reportIds = body.report_ids || null;
    let syncRunId = body.sync_run_id || null;

    if (!reportIds || !syncRunId) {
      const runs = await base44.asServiceRole.entities.SyncRun.filter(
        { amazon_account_id: amazonAccountId, status: 'running' }, '-started_at', 5
      );
      const pending = runs.find(r => r.operation?.startsWith('adsReports:'));
      if (!pending) return Response.json({ ok: false, error: 'Nenhum relatório pendente. Execute requestAdsReport primeiro.' }, { status: 404 });
      const match = pending.operation.match(/adsReports:[^:]+:(.+)/);
      if (!reportIds) reportIds = match ? JSON.parse(match[1]) : {};
      if (!syncRunId) syncRunId = pending.id;
    }

    // Verificar status de cada relatório
    const pending = {};
    const failed = {};
    const data = { campaigns: [], products: [], keywords: [] };

    for (const [key, reportId] of Object.entries(reportIds)) {
      if (!reportId) continue;
      const status = await checkReport(reportId);
      if (status.status === 'COMPLETED' && status.url) {
        data[key] = await downloadAndParse(status.url);
      } else if (status.status === 'FAILED') {
        failed[key] = status.failureReason || 'FAILED';
      } else {
        pending[key] = status.status;
      }
    }

    // Se ainda há relatórios pendentes e nenhum está pronto, retornar estado
    if (Object.keys(pending).length > 0 && data.campaigns.length === 0 && data.products.length === 0 && data.keywords.length === 0) {
      return Response.json({ ok: true, ready: false, pending, message: 'Relatórios ainda a processar. Tente novamente em 5 minutos.' });
    }

    const today = new Date().toISOString().slice(0, 10);

    // ── Processar Campanhas ──
    let totalSpend = 0, totalSales = 0, totalClicks = 0, totalImpressions = 0, totalOrders = 0;
    const campaignRecords = [];
    const metricsRecords = [];

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

      campaignRecords.push({
        amazon_account_id: amazonAccountId,
        campaign_id: campaignId,
        name: row.campaignName || '',
        campaign_type: 'SP',
        state: (row.campaignStatus || 'enabled').toLowerCase(),
        daily_budget: Number(row.campaignBudgetAmount) || 0,
        spend, sales, clicks, impressions, orders, acos, roas, ctr, cpc,
        synced_at: new Date().toISOString(),
      });

      metricsRecords.push({
        amazon_account_id: amazonAccountId,
        campaign_id: campaignId,
        date: today,
        spend, sales, clicks, impressions, orders, acos, roas, ctr, cpc,
      });
    }

    // Bulk upsert campaigns (delete + insert)
    await bulkUpsert(base44, 'Campaign', amazonAccountId, campaignRecords);

    // Bulk upsert daily metrics for today
    await base44.asServiceRole.entities.CampaignMetricsDaily.deleteMany({ amazon_account_id: amazonAccountId, date: today });
    for (let i = 0; i < metricsRecords.length; i += 500) {
      await base44.asServiceRole.entities.CampaignMetricsDaily.bulkCreate(metricsRecords.slice(i, i + 500));
    }

    // ── Processar Produtos Anunciados ──
    const asinMap = {};
    for (const row of data.products) {
      const asin = row.advertisedAsin || row.asin;
      if (!asin) continue;
      if (!asinMap[asin]) asinMap[asin] = { spend: 0, sales: 0, units: 0, clicks: 0, sku: row.advertisedSku };
      asinMap[asin].spend += Number(row.cost) || 0;
      asinMap[asin].sales += Number(row.sales30d) || Number(row.sales14d) || Number(row.sales1d) || 0;
      asinMap[asin].units += Number(row.unitsSoldClicks30d) || Number(row.unitsSoldClicks14d) || Number(row.unitsSoldClicks1d) || 0;
      asinMap[asin].clicks += Number(row.clicks) || 0;
    }

    const productRecords = Object.entries(asinMap).map(([asin, m]) => ({
      amazon_account_id: amazonAccountId,
      asin,
      sku: m.sku || null,
      status: 'active',
      total_revenue_30d: m.sales,
      units_sold_30d: m.units,
      synced_at: new Date().toISOString(),
    }));

    await bulkUpsert(base44, 'Product', amazonAccountId, productRecords);

    // ── Processar Keywords / Search Terms ──
    const keywordRecords = [];
    for (const row of data.keywords) {
      if (!row.keywordId && !row.searchTerm) continue;
      const kwId = String(row.keywordId || `st_${row.searchTerm}`);
      const spend = Number(row.cost) || 0;
      const sales = Number(row.sales14d) || Number(row.sales1d) || 0;
      const clicks = Number(row.clicks) || 0;
      const impressions = Number(row.impressions) || 0;
      keywordRecords.push({
        amazon_account_id: amazonAccountId,
        campaign_id: String(row.campaignId || ''),
        ad_group_id: String(row.adGroupId || ''),
        keyword_id: kwId,
        keyword_text: row.searchTerm || row.keyword || '',
        match_type: (row.matchType || 'broad').toLowerCase(),
        state: 'enabled',
        spend, sales, clicks, impressions,
        acos: sales > 0 ? (spend / sales * 100) : 0,
        cpc: clicks > 0 ? (spend / clicks) : 0,
        synced_at: new Date().toISOString(),
      });
    }

    await bulkUpsert(base44, 'Keyword', amazonAccountId, keywordRecords);

    // ── Análise IA → Decisões ──
    let decisionsCreated = 0;
    try {
      const topCampaigns = campaignRecords
        .filter(c => c.impressions > 100)
        .sort((a, b) => b.spend - a.spend)
        .slice(0, 20)
        .map(c => ({ id: c.campaign_id, name: c.name, spend: c.spend.toFixed(2), sales: c.sales.toFixed(2), acos: c.acos.toFixed(1), roas: c.roas.toFixed(2) }));

      const topKeywords = keywordRecords
        .filter(k => k.clicks > 5)
        .sort((a, b) => b.spend - a.spend)
        .slice(0, 20)
        .map(k => ({ term: k.keyword_text, matchType: k.match_type, spend: k.spend.toFixed(2), sales: k.sales.toFixed(2), clicks: k.clicks, acos: k.acos.toFixed(1) }));

      const prompt = `Você é um especialista em Amazon Ads. Analise os dados dos últimos 30 dias e gere recomendações de optimização accionáveis.

RESUMO (30 dias):
- Spend: $${totalSpend.toFixed(2)} | Vendas: $${totalSales.toFixed(2)} | ACoS: ${totalSales > 0 ? (totalSpend/totalSales*100).toFixed(1) : 'N/A'}% | ROAS: ${totalSpend > 0 ? (totalSales/totalSpend).toFixed(2) : 'N/A'}x
- Cliques: ${totalClicks} | Impressões: ${totalImpressions} | Pedidos: ${totalOrders}

TOP CAMPANHAS: ${JSON.stringify(topCampaigns)}
TOP KEYWORDS: ${JSON.stringify(topKeywords)}

Gere 5-10 recomendações concretas com campanhas/keywords específicas, problema com dados, acção exacta e impacto esperado.`;

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
          },
        },
      });

      const aiDecisions = aiResult?.decisions || [];
      const decisionRecords = aiDecisions.map(d => ({
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
      }));

      if (decisionRecords.length > 0) {
        await base44.asServiceRole.entities.Decision.bulkCreate(decisionRecords);
        decisionsCreated = decisionRecords.length;
      }
    } catch (aiErr) {
      console.error('AI analysis failed:', aiErr.message);
    }

    // Atualizar last_sync_at na conta
    await base44.asServiceRole.entities.AmazonAccount.update(amazonAccountId, {
      last_sync_at: new Date().toISOString(),
      status: 'connected',
    });

    // Marcar SyncRun como concluído
    if (syncRunId) {
      await base44.asServiceRole.entities.SyncRun.update(syncRunId, {
        status: 'success',
        records_received: data.campaigns.length + data.products.length + data.keywords.length,
        records_upserted: campaignRecords.length + productRecords.length + keywordRecords.length,
        duration_ms: Date.now() - startTime,
        completed_at: new Date().toISOString(),
      });
    }

    return Response.json({
      ok: true,
      ready: true,
      pending,
      campaigns_upserted: campaignRecords.length,
      keywords_upserted: keywordRecords.length,
      products_upserted: productRecords.length,
      decisions_created: decisionsCreated,
      summary: { total_spend: totalSpend, total_sales: totalSales, acos: totalSales > 0 ? totalSpend/totalSales*100 : 0 },
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});