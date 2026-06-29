/**
 * runFullSync — Orquestra o ciclo completo Amazon Ads em 2 fases:
 *
 * action="request" (padrão):
 *   1. Renova access token via refresh token da conta
 *   2. Importa campanhas SP
 *   3. Solicita 3 relatórios 30d (campanhas, produtos, search terms)
 *   → Retorna reportIds imediatamente (relatórios ficam prontos em 5-15 min na Amazon)
 *
 * action="download":
 *   4. Verifica status dos relatórios
 *   5. Se prontos: baixa, descomprime, popula Campaign, Product, Keyword, CampaignMetricsDaily
 *   6. Gera decisões IA
 *   7. Atualiza AmazonAccount + SyncRun
 *   → Retorna { ready: false } se ainda não prontos (frontend faz polling a cada 30s)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

let _tokenCache = null;

async function getAdsToken(refreshToken) {
  if (_tokenCache && _tokenCache.expires_at > Date.now() + 5000) return _tokenCache.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: Deno.env.get('ADS_CLIENT_ID'),
    client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Token refresh failed: ${data.error_description || data.error}`);
  _tokenCache = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBase() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsGet(path, token, profileId) {
  const res = await fetch(`${getAdsBase()}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(profileId),
      'Accept': 'application/json',
    },
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`ADS GET ${path} → ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function adsPost(path, token, profileId, body, contentType = 'application/json') {
  const res = await fetch(`${getAdsBase()}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': contentType,
      'Accept': contentType,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    if (res.status === 425) {
      const match = JSON.stringify(data).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
      if (match) return { reportId: match[0], _duplicate: true };
    }
    throw new Error(`ADS POST ${path} → ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

async function decompress(arrayBuffer) {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(new Uint8Array(arrayBuffer));
  writer.close();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  return JSON.parse(text);
}

async function bulkReplace(base44, entity, amazonAccountId, records) {
  if (!records.length) return 0;
  await base44.asServiceRole.entities[entity].deleteMany({ amazon_account_id: amazonAccountId });
  for (let i = 0; i < records.length; i += 500) {
    await base44.asServiceRole.entities[entity].bulkCreate(records.slice(i, i + 500));
  }
  return records.length;
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const action = body.action || 'request';
    let amazonAccountId = body.amazon_account_id;

    // Resolver conta
    let account = null;
    if (amazonAccountId) {
      account = await base44.asServiceRole.entities.AmazonAccount.get(amazonAccountId).catch(() => null);
    }
    if (!account) {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: user.id });
      account = accounts[0] || (await base44.asServiceRole.entities.AmazonAccount.list())[0] || null;
    }
    if (!account) return Response.json({ error: 'Nenhuma AmazonAccount encontrada' }, { status: 404 });
    amazonAccountId = account.id;

    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    if (!refreshToken) return Response.json({ error: 'Nenhum refresh_token. Conecte o Amazon Ads primeiro.' }, { status: 400 });
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!profileId) return Response.json({ error: 'ads_profile_id não configurado' }, { status: 400 });

    // ══════════════════════════════════════════════════════════════════
    // FASE 1: request — importar campanhas + solicitar relatórios
    // ══════════════════════════════════════════════════════════════════
    if (action === 'request') {
      // Renovar token
      const token = await getAdsToken(refreshToken);

      // Importar campanhas
      const campData = await adsPost('/sp/campaigns/list', token, profileId,
        { stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] }, maxResults: 500 },
        'application/vnd.spCampaign.v3+json'
      );
      const campaigns = campData?.campaigns || [];
      const campaignRecords = campaigns.map(c => ({
        amazon_account_id: amazonAccountId,
        campaign_id: String(c.campaignId),
        name: c.name,
        campaign_type: 'SP',
        targeting_type: c.targetingType,
        state: (c.state || 'ENABLED').toLowerCase(),
        daily_budget: c.budget?.budget || c.dailyBudget || 0,
        start_date: c.startDate,
        end_date: c.endDate || null,
        bidding_strategy: c.dynamicBidding?.strategy || null,
        synced_at: new Date().toISOString(),
      }));

      await base44.asServiceRole.entities.Campaign.deleteMany({ amazon_account_id: amazonAccountId });
      for (let i = 0; i < campaignRecords.length; i += 500) {
        await base44.asServiceRole.entities.Campaign.bulkCreate(campaignRecords.slice(i, i + 500));
      }

      // Solicitar 3 relatórios 30d
      const endDate = new Date();
      const startDate = new Date(Date.now() - 30 * 86400000);
      const fmt = (d) => d.toISOString().slice(0, 10);
      const ts = Date.now();

      const [rCampaigns, rProducts, rKeywords] = await Promise.all([
        adsPost('/reporting/reports', token, profileId, {
          name: `SP_campaigns_30d_${ts}`,
          startDate: fmt(startDate), endDate: fmt(endDate),
          configuration: {
            adProduct: 'SPONSORED_PRODUCTS', groupBy: ['campaign'],
            columns: ['campaignId', 'campaignName', 'impressions', 'clicks', 'cost', 'purchases30d', 'sales30d', 'unitsSoldClicks30d'],
            reportTypeId: 'spCampaigns', timeUnit: 'SUMMARY', format: 'GZIP_JSON',
          },
        }),
        adsPost('/reporting/reports', token, profileId, {
          name: `SP_products_30d_${ts}`,
          startDate: fmt(startDate), endDate: fmt(endDate),
          configuration: {
            adProduct: 'SPONSORED_PRODUCTS', groupBy: ['advertiser'],
            columns: ['advertisedAsin', 'advertisedSku', 'campaignId', 'adGroupId', 'impressions', 'clicks', 'cost', 'purchases30d', 'sales30d', 'unitsSoldClicks30d'],
            reportTypeId: 'spAdvertisedProduct', timeUnit: 'SUMMARY', format: 'GZIP_JSON',
          },
        }),
        adsPost('/reporting/reports', token, profileId, {
          name: `SP_searchterms_30d_${ts}`,
          startDate: fmt(startDate), endDate: fmt(endDate),
          configuration: {
            adProduct: 'SPONSORED_PRODUCTS', groupBy: ['searchTerm'],
            columns: ['searchTerm', 'campaignId', 'adGroupId', 'keywordId', 'matchType', 'impressions', 'clicks', 'cost', 'purchases14d', 'sales14d'],
            reportTypeId: 'spSearchTerm', timeUnit: 'SUMMARY', format: 'GZIP_JSON',
          },
        }),
      ]);

      const reportIds = {
        campaigns: rCampaigns.reportId,
        products: rProducts.reportId,
        keywords: rKeywords.reportId,
      };

      // Cancelar SyncRuns running antigos
      await base44.asServiceRole.entities.SyncRun.updateMany(
        { amazon_account_id: amazonAccountId, status: 'running' },
        { $set: { status: 'error', error_message: 'Cancelado por novo ciclo', completed_at: new Date().toISOString() } }
      );

      const syncRun = await base44.asServiceRole.entities.SyncRun.create({
        amazon_account_id: amazonAccountId,
        operation: 'runFullSync:request',
        status: 'running',
        started_at: new Date().toISOString(),
      });

      await base44.asServiceRole.entities.AmazonAccount.update(amazonAccountId, {
        last_sync_at: new Date().toISOString(),
        status: 'connected',
        error_message: null,
      });

      return Response.json({
        ok: true,
        campaigns_imported: campaigns.length,
        reportIds,
        syncRunId: syncRun.id,
        message: `${campaigns.length} campanhas importadas. Aguarde 5-15 min e chame action=download.`,
      });
    }

    // ══════════════════════════════════════════════════════════════════
    // FASE 2: download — verificar + baixar + popular tabelas
    // ══════════════════════════════════════════════════════════════════
    if (action === 'download') {
      const { reportIds, syncRunId } = body;
      if (!reportIds) return Response.json({ error: 'reportIds required for action=download' }, { status: 400 });

      const token = await getAdsToken(refreshToken);

      // Verificar status dos 3 relatórios
      const [sCampaigns, sProducts, sKeywords] = await Promise.all([
        adsGet(`/reporting/reports/${reportIds.campaigns}`, token, profileId),
        adsGet(`/reporting/reports/${reportIds.products}`, token, profileId),
        adsGet(`/reporting/reports/${reportIds.keywords}`, token, profileId),
      ]);

      const pending = {
        campaigns: sCampaigns.status,
        products: sProducts.status,
        keywords: sKeywords.status,
      };

      const allReady = [sCampaigns, sProducts, sKeywords].every(s => s.status === 'COMPLETED' && s.url);
      if (!allReady) {
        const anyFailed = [sCampaigns, sProducts, sKeywords].some(s => s.status === 'FAILED');
        if (anyFailed) return Response.json({ ok: false, error: 'Um ou mais relatórios falharam', pending }, { status: 500 });
        return Response.json({ ok: true, ready: false, pending });
      }

      // Baixar os 3
      const [dataCampaigns, dataProducts, dataKeywords] = await Promise.all([
        fetch(sCampaigns.url).then(r => r.arrayBuffer()).then(decompress),
        fetch(sProducts.url).then(r => r.arrayBuffer()).then(decompress),
        fetch(sKeywords.url).then(r => r.arrayBuffer()).then(decompress),
      ]);

      // Métricas de campanhas
      const fmt = (d) => d.toISOString().slice(0, 10);
      const today = fmt(new Date());
      let totalSpend = 0, totalSales = 0, totalClicks = 0, totalImpressions = 0, totalOrders = 0;
      const metricsByCAMP = {};
      const metricsRecords = [];

      for (const row of dataCampaigns) {
        const campaignId = String(row.campaignId);
        const spend = Number(row.cost) || 0;
        const sales = Number(row.sales30d) || 0;
        const clicks = Number(row.clicks) || 0;
        const impressions = Number(row.impressions) || 0;
        const orders = Number(row.purchases30d) || 0;
        const acos = sales > 0 ? spend / sales * 100 : 0;
        const roas = spend > 0 ? sales / spend : 0;
        const ctr = impressions > 0 ? clicks / impressions * 100 : 0;
        const cpc = clicks > 0 ? spend / clicks : 0;
        totalSpend += spend; totalSales += sales; totalClicks += clicks; totalImpressions += impressions; totalOrders += orders;
        metricsByCAMP[campaignId] = { spend, sales, clicks, impressions, orders, acos, roas, ctr, cpc };
        metricsRecords.push({ amazon_account_id: amazonAccountId, campaign_id: campaignId, date: today, spend, sales, clicks, impressions, orders, acos, roas, ctr, cpc });
      }

      // Enriquecer campanhas já importadas com métricas e re-salvar
      const existingCampaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId }, '-created_date', 2000);
      for (const c of existingCampaigns) {
        const m = metricsByCAMP[c.campaign_id];
        if (m) {
          await base44.asServiceRole.entities.Campaign.update(c.id, { ...m, synced_at: new Date().toISOString() });
        }
      }

      // Métricas diárias
      await base44.asServiceRole.entities.CampaignMetricsDaily.deleteMany({ amazon_account_id: amazonAccountId, date: today });
      for (let i = 0; i < metricsRecords.length; i += 500) {
        await base44.asServiceRole.entities.CampaignMetricsDaily.bulkCreate(metricsRecords.slice(i, i + 500));
      }

      // Produtos
      const asinMap = {};
      for (const row of dataProducts) {
        const asin = row.advertisedAsin;
        if (!asin) continue;
        if (!asinMap[asin]) asinMap[asin] = { spend: 0, sales: 0, units: 0, sku: row.advertisedSku };
        asinMap[asin].spend += Number(row.cost) || 0;
        asinMap[asin].sales += Number(row.sales30d) || 0;
        asinMap[asin].units += Number(row.unitsSoldClicks30d) || 0;
      }
      const productRecords = Object.entries(asinMap).map(([asin, m]) => ({
        amazon_account_id: amazonAccountId, asin, sku: m.sku || null, status: 'active',
        total_revenue_30d: m.sales, units_sold_30d: m.units, total_spend_30d: m.spend,
        acos: m.sales > 0 ? m.spend / m.sales * 100 : 0,
        roas: m.spend > 0 ? m.sales / m.spend : 0,
        synced_at: new Date().toISOString(),
      }));
      const prodCount = await bulkReplace(base44, 'Product', amazonAccountId, productRecords);

      // Keywords / Search Terms
      const kwRecords = [];
      for (const row of dataKeywords) {
        if (!row.searchTerm && !row.keywordId) continue;
        const kwId = String(row.keywordId || `st_${row.searchTerm}`);
        const spend = Number(row.cost) || 0;
        const sales = Number(row.sales14d) || 0;
        const clicks = Number(row.clicks) || 0;
        kwRecords.push({
          amazon_account_id: amazonAccountId,
          campaign_id: String(row.campaignId || ''),
          ad_group_id: String(row.adGroupId || ''),
          keyword_id: kwId,
          keyword_text: row.searchTerm || '',
          match_type: (row.matchType || 'broad').toLowerCase(),
          state: 'enabled',
          spend, sales, clicks,
          impressions: Number(row.impressions) || 0,
          acos: sales > 0 ? spend / sales * 100 : 0,
          cpc: clicks > 0 ? spend / clicks : 0,
          synced_at: new Date().toISOString(),
        });
      }
      const kwCount = await bulkReplace(base44, 'Keyword', amazonAccountId, kwRecords);

      // IA → Decisões
      let decisionsCreated = 0;
      try {
        const topCampaigns = existingCampaigns
          .filter(c => (metricsByCAMP[c.campaign_id]?.impressions || 0) > 100)
          .sort((a, b) => (metricsByCAMP[b.campaign_id]?.spend || 0) - (metricsByCAMP[a.campaign_id]?.spend || 0))
          .slice(0, 15)
          .map(c => { const m = metricsByCAMP[c.campaign_id] || {}; return { id: c.campaign_id, name: c.name, spend: (m.spend||0).toFixed(2), sales: (m.sales||0).toFixed(2), acos: (m.acos||0).toFixed(1) }; });

        const aiResult = await base44.asServiceRole.integrations.Core.InvokeLLM({
          prompt: `Analise Amazon Ads (30d). Spend: $${totalSpend.toFixed(2)}, Vendas: $${totalSales.toFixed(2)}, ACoS: ${totalSales > 0 ? (totalSpend/totalSales*100).toFixed(1) : 'N/A'}%, ROAS: ${totalSpend > 0 ? (totalSales/totalSpend).toFixed(2) : 'N/A'}x. Top campanhas: ${JSON.stringify(topCampaigns)}. Gere 5-8 recomendações accionáveis com campaign_id específico.`,
          response_json_schema: {
            type: 'object',
            properties: {
              decisions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    decision_type: { type: 'string', enum: ['bid_adjust', 'budget_change', 'pause_campaign', 'enable_campaign', 'negate_keyword'] },
                    entity_type: { type: 'string', enum: ['campaign', 'keyword'] },
                    entity_id: { type: 'string' }, entity_name: { type: 'string' },
                    rationale: { type: 'string' }, current_value: { type: 'number' },
                    proposed_value: { type: 'number' }, change_pct: { type: 'number' },
                    confidence: { type: 'number' }, priority: { type: 'string', enum: ['high', 'medium', 'low'] },
                  },
                },
              },
            },
          },
        });

        const decisionRecords = (aiResult?.decisions || []).map(d => ({
          amazon_account_id: amazonAccountId,
          decision_type: d.decision_type || 'bid_adjust',
          entity_type: d.entity_type || 'campaign',
          entity_id: d.entity_id || '', entity_name: d.entity_name || '',
          rationale: d.rationale || '', current_value: d.current_value || 0,
          proposed_value: d.proposed_value || 0, change_pct: d.change_pct || 0,
          confidence: d.confidence || 0.5, priority: d.priority || 'medium',
          status: 'pending',
        }));
        if (decisionRecords.length > 0) {
          await base44.asServiceRole.entities.Decision.bulkCreate(decisionRecords);
          decisionsCreated = decisionRecords.length;
        }
      } catch (aiErr) {
        console.warn('IA falhou:', aiErr.message);
      }

      const durationMs = Date.now() - startTime;

      await base44.asServiceRole.entities.AmazonAccount.update(amazonAccountId, {
        status: 'connected', last_sync_at: new Date().toISOString(), error_message: null,
      });

      if (syncRunId) {
        await base44.asServiceRole.entities.SyncRun.update(syncRunId, {
          status: 'success',
          records_received: dataCampaigns.length + dataProducts.length + dataKeywords.length,
          records_upserted: existingCampaigns.length + prodCount + kwCount,
          duration_ms: durationMs,
          completed_at: new Date().toISOString(),
        });
      }

      return Response.json({
        ok: true,
        ready: true,
        campaigns_metrics: dataCampaigns.length,
        products: prodCount,
        keywords: kwCount,
        metrics_today: metricsRecords.length,
        decisions_created: decisionsCreated,
        duration_s: (durationMs / 1000).toFixed(1),
        summary: { total_spend: totalSpend, total_sales: totalSales, total_clicks: totalClicks, total_impressions: totalImpressions, total_orders: totalOrders },
      });
    }

    return Response.json({ error: 'action must be "request" or "download"' }, { status: 400 });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});