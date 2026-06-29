/**
 * runFullSync — Ciclo completo Amazon Ads em 2 fases:
 *
 * action="request":
 *   1. Renova token via refresh token da conta
 *   2. Importa campanhas SP
 *   3. Solicita 3 relatórios 30d
 *   → Retorna reportIds imediatamente
 *
 * action="download":
 *   4. Verifica status dos relatórios
 *   5. Se prontos: baixa, processa, popula tabelas
 *   6. Gera decisões IA
 *   → { ready: false } se ainda pendente; { ready: true, ... } quando concluído
 *
 * Nunca retorna HTTP 500 — erros Amazon vêm como { ok: false, step, amazon_status, amazon_error, message }
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
  if (!res.ok) {
    return { __error: true, step: 'token_refresh', amazon_status: res.status, amazon_error: data.error_description || data.error || JSON.stringify(data) };
  }
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
  if (!res.ok) {
    return { __error: true, step: `GET ${path}`, amazon_status: res.status, amazon_error: JSON.stringify(data).slice(0, 300) };
  }
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
    // 425 = relatório duplicado — extrair reportId existente
    if (res.status === 425) {
      const match = JSON.stringify(data).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
      if (match) return { reportId: match[0], _duplicate: true };
    }
    return { __error: true, step: `POST ${path}`, amazon_status: res.status, amazon_error: JSON.stringify(data).slice(0, 300) };
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
    if (!account) return Response.json({ ok: false, message: 'Nenhuma AmazonAccount encontrada' });
    amazonAccountId = account.id;

    // Resolver credenciais — sempre preferir da conta
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    if (!refreshToken) return Response.json({ ok: false, step: 'auth', message: 'Sem refresh_token. Conecte o Amazon Ads primeiro.' });
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!profileId) return Response.json({ ok: false, step: 'auth', message: 'ads_profile_id não configurado' });

    // ══════════════════════════════════════════════════════════════════
    // FASE 1: request
    // ══════════════════════════════════════════════════════════════════
    if (action === 'request') {
      const token = await getAdsToken(refreshToken);
      if (token?.__error) {
        return Response.json({ ok: false, step: token.step, amazon_status: token.amazon_status, amazon_error: token.amazon_error, message: `Falha ao renovar token: ${token.amazon_error}` });
      }

      // Importar campanhas
      const campData = await adsPost(
        '/sp/campaigns/list', token, profileId,
        { stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] }, maxResults: 500 },
        'application/vnd.spCampaign.v3+json'
      );
      if (campData?.__error) {
        return Response.json({ ok: false, step: campData.step, amazon_status: campData.amazon_status, amazon_error: campData.amazon_error, message: `Falha ao listar campanhas: ${campData.amazon_error}` });
      }

      const campaigns = campData?.campaigns || [];
      const campaignRecords = campaigns.map(c => ({
        amazon_account_id: amazonAccountId,
        campaign_id: String(c.campaignId),
        name: c.name,
        campaign_name: c.name,
        campaign_type: 'SP',
        targeting_type: c.targetingType || 'AUTO',
        state: (c.state || 'ENABLED').toLowerCase(),
        status: (c.state || 'ENABLED').toLowerCase(),
        daily_budget: c.budget?.budget || c.dailyBudget || 0,
        start_date: c.startDate,
        end_date: c.endDate || null,
        bidding_strategy: c.dynamicBidding?.strategy || null,
        synced_at: new Date().toISOString(),
        last_sync_at: new Date().toISOString(),
      }));

      // Cancelar SyncRuns running antigos silenciosamente (marcar como partial, não error)
      await base44.asServiceRole.entities.SyncRun.updateMany(
        { amazon_account_id: amazonAccountId, status: 'running' },
        { $set: { status: 'partial', error_message: 'Substituído por novo ciclo', completed_at: new Date().toISOString() } }
      );

      // Upsert campanhas: atualizar existentes, criar novas — não apagar históricas
      const existingCampsReq = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId }, '-created_date', 2000);
      const existingCampMap = {};
      for (const c of existingCampsReq) existingCampMap[c.campaign_id] = c;
      const toCreate = [], toUpdate = [];
      for (const rec of campaignRecords) {
        if (existingCampMap[rec.campaign_id]) toUpdate.push({ id: existingCampMap[rec.campaign_id].id, ...rec });
        else toCreate.push(rec);
      }
      if (toCreate.length > 0) {
        for (let i = 0; i < toCreate.length; i += 500)
          await base44.asServiceRole.entities.Campaign.bulkCreate(toCreate.slice(i, i + 500));
      }
      if (toUpdate.length > 0) {
        for (let i = 0; i < toUpdate.length; i += 500)
          await base44.asServiceRole.entities.Campaign.bulkUpdate(toUpdate.slice(i, i + 500));
      }

      // Solicitar 3 relatórios 30d em paralelo
      const endDate = new Date();
      const startDate = new Date(Date.now() - 30 * 86400000);
      const fmt = (d) => d.toISOString().slice(0, 10);
      const ts = Date.now();

      const [rCampaigns, rProducts, rKeywords] = await Promise.all([
        adsPost('/reporting/reports', token, profileId, {
          name: `SP_campaigns_30d_${ts}`,
          startDate: fmt(startDate), endDate: fmt(endDate),
          configuration: {
            adProduct: 'SPONSORED_PRODUCTS',
            groupBy: ['campaign'],
            columns: ['campaignId', 'campaignName', 'campaignStatus', 'campaignBudgetAmount', 'impressions', 'clicks', 'cost', 'purchases30d', 'sales30d', 'unitsSoldClicks30d'],
            reportTypeId: 'spCampaigns', timeUnit: 'SUMMARY', format: 'GZIP_JSON',
          },
        }),
        adsPost('/reporting/reports', token, profileId, {
          name: `SP_products_30d_${ts}`,
          startDate: fmt(startDate), endDate: fmt(endDate),
          configuration: {
            adProduct: 'SPONSORED_PRODUCTS',
            groupBy: ['advertiser'],
            columns: ['advertisedAsin', 'advertisedSku', 'campaignId', 'adGroupId', 'impressions', 'clicks', 'cost', 'purchases30d', 'sales30d', 'unitsSoldClicks30d'],
            reportTypeId: 'spAdvertisedProduct', timeUnit: 'SUMMARY', format: 'GZIP_JSON',
          },
        }),
        adsPost('/reporting/reports', token, profileId, {
          name: `SP_searchterms_30d_${ts}`,
          startDate: fmt(startDate), endDate: fmt(endDate),
          configuration: {
            adProduct: 'SPONSORED_PRODUCTS',
            groupBy: ['searchTerm'],
            columns: ['searchTerm', 'campaignId', 'adGroupId', 'keywordId', 'matchType', 'impressions', 'clicks', 'cost', 'purchases14d', 'sales14d', 'unitsSoldClicks14d'],
            reportTypeId: 'spSearchTerm', timeUnit: 'SUMMARY', format: 'GZIP_JSON',
          },
        }),
      ]);

      // Verificar erros nos relatórios (não bloquear por 1 falhar)
      const reportIds = {};
      const reportErrors = [];
      if (rCampaigns?.__error) reportErrors.push(`campaigns: ${rCampaigns.amazon_error}`);
      else reportIds.campaigns = rCampaigns.reportId;
      if (rProducts?.__error) reportErrors.push(`products: ${rProducts.amazon_error}`);
      else reportIds.products = rProducts.reportId;
      if (rKeywords?.__error) reportErrors.push(`keywords: ${rKeywords.amazon_error}`);
      else reportIds.keywords = rKeywords.reportId;

      if (!reportIds.campaigns && !reportIds.products && !reportIds.keywords) {
        return Response.json({ ok: false, step: 'request_reports', message: 'Todos os relatórios falharam', errors: reportErrors });
      }

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
        report_errors: reportErrors,
        message: `${campaigns.length} campanhas importadas. Aguarde 5-15 min e chame action=download.`,
      });
    }

    // ══════════════════════════════════════════════════════════════════
    // FASE 2: download
    // ══════════════════════════════════════════════════════════════════
    if (action === 'download') {
      const { reportIds, syncRunId } = body;
      if (!reportIds || Object.keys(reportIds).length === 0) {
        return Response.json({ ok: false, step: 'download', message: 'reportIds required for action=download' });
      }

      const token = await getAdsToken(refreshToken);
      if (token?.__error) {
        return Response.json({ ok: false, step: token.step, amazon_status: token.amazon_status, amazon_error: token.amazon_error, message: `Falha ao renovar token: ${token.amazon_error}` });
      }

      // Verificar status dos relatórios
      const statusChecks = await Promise.all(
        Object.entries(reportIds).map(async ([key, reportId]) => {
          if (!reportId) return { key, status: 'MISSING' };
          const s = await adsGet(`/reporting/reports/${reportId}`, token, profileId);
          if (s?.__error) return { key, status: 'ERROR', error: s.amazon_error };
          return { key, status: s.status, url: s.url, failureReason: s.failureReason };
        })
      );

      const pending = {};
      const failed = {};
      const ready = {};
      for (const s of statusChecks) {
        if (s.status === 'COMPLETED' && s.url) ready[s.key] = s.url;
        else if (s.status === 'FAILED' || s.status === 'ERROR') failed[s.key] = s.error || s.failureReason || 'FAILED';
        else pending[s.key] = s.status;
      }

      // Se ainda há pendentes, retornar sem processar
      if (Object.keys(pending).length > 0) {
        return Response.json({ ok: true, ready: false, pending, failed });
      }

      // Se tudo falhou
      if (Object.keys(ready).length === 0) {
        return Response.json({ ok: false, step: 'download', message: 'Todos os relatórios falharam', failed });
      }

      // Baixar relatórios prontos
      const data = { campaigns: [], products: [], keywords: [] };
      const downloadErrors = [];
      for (const [key, url] of Object.entries(ready)) {
        try {
          const buf = await fetch(url).then(r => r.arrayBuffer());
          data[key] = await decompress(buf);
        } catch (e) {
          downloadErrors.push(`${key}: ${e.message}`);
        }
      }

      const today = new Date().toISOString().slice(0, 10);
      let totalSpend = 0, totalSales = 0, totalClicks = 0, totalImpressions = 0, totalOrders = 0;

      // ── Processar métricas de campanhas ──
      const metricsByCAMP = {};
      const metricsRecords = [];

      for (const row of data.campaigns) {
        const campaignId = String(row.campaignId);
        const spend = Number(row.cost) || 0;
        const sales = Number(row.sales30d) || Number(row.sales14d) || Number(row.sales1d) || 0;
        const clicks = Number(row.clicks) || 0;
        const impressions = Number(row.impressions) || 0;
        const orders = Number(row.purchases30d) || Number(row.purchases14d) || 0;
        const acos = sales > 0 ? spend / sales * 100 : 0;
        const roas = spend > 0 ? sales / spend : 0;
        const ctr = impressions > 0 ? clicks / impressions * 100 : 0;
        const cpc = clicks > 0 ? spend / clicks : 0;
        totalSpend += spend; totalSales += sales; totalClicks += clicks; totalImpressions += impressions; totalOrders += orders;
        metricsByCAMP[campaignId] = { spend, sales, clicks, impressions, orders, acos, roas, ctr, cpc };
        metricsRecords.push({ amazon_account_id: amazonAccountId, campaign_id: campaignId, date: today, spend, sales, clicks, impressions, orders, acos, roas, ctr, cpc });
      }

      // Atualizar campanhas existentes com métricas (não apagar)
      const existingCampaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId }, '-created_date', 2000);
      for (const c of existingCampaigns) {
        const m = metricsByCAMP[c.campaign_id];
        if (m) {
          await base44.asServiceRole.entities.Campaign.update(c.id, { ...m, synced_at: new Date().toISOString(), last_sync_at: new Date().toISOString() });
        }
      }

      // Métricas diárias — apagar só registros de hoje e reinserir (preserva histórico)
      if (metricsRecords.length > 0) {
        await base44.asServiceRole.entities.CampaignMetricsDaily.deleteMany({ amazon_account_id: amazonAccountId, date: today });
        for (let i = 0; i < metricsRecords.length; i += 500) {
          await base44.asServiceRole.entities.CampaignMetricsDaily.bulkCreate(metricsRecords.slice(i, i + 500));
        }
      }
      // Também registrar métricas diárias dos últimos 30d a partir do relatório SUMMARY
      // (o relatório SUMMARY agrega tudo em 1 linha — guardamos em today para histórico)

      // ── Processar produtos — upsert, nunca apagar ──
      let prodCount = 0;
      if (data.products.length > 0) {
        const asinMap = {};
        for (const row of data.products) {
          const asin = row.advertisedAsin || row.asin;
          if (!asin) continue;
          if (!asinMap[asin]) asinMap[asin] = { spend: 0, sales: 0, units: 0, sku: row.advertisedSku, campaignId: row.campaignId };
          asinMap[asin].spend += Number(row.cost) || 0;
          asinMap[asin].sales += Number(row.sales30d) || Number(row.sales14d) || 0;
          asinMap[asin].units += Number(row.unitsSoldClicks30d) || Number(row.unitsSoldClicks14d) || 0;
        }
        // Buscar produtos existentes para fazer upsert
        const existingProds = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: amazonAccountId }, '-created_date', 2000);
        const existingProdMap = {};
        for (const p of existingProds) existingProdMap[p.asin] = p;

        // Buscar campanhas existentes para linkar ao produto
        const allCampaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId }, '-created_date', 2000);
        const campByAsin = {};
        for (const c of allCampaigns) { if (c.asin) campByAsin[c.asin] = c; }
        const campById = {};
        for (const c of allCampaigns) campById[c.campaign_id] = c;

        const prodToCreate = [], prodToUpdate = [];
        for (const [asin, m] of Object.entries(asinMap)) {
          // Verificar se há campanha ativa para este ASIN
          const linkedCamp = campByAsin[asin] || (m.campaignId ? campById[String(m.campaignId)] : null);
          const hasCampaign = !!linkedCamp;
          const campActive = linkedCamp && (linkedCamp.state === 'enabled');
          const metrics = {
            total_revenue_30d: m.sales,
            total_sales_30d: m.sales,
            units_sold_30d: m.units,
            total_units_30d: m.units,
            total_spend_30d: m.spend,
            acos: m.sales > 0 ? m.spend / m.sales * 100 : 0,
            roas: m.spend > 0 ? m.sales / m.spend : 0,
            has_campaign: hasCampaign,
            campaign_status: hasCampaign ? (campActive ? 'active' : 'paused') : 'none',
            linked_campaign_id: linkedCamp?.campaign_id || null,
            synced_at: new Date().toISOString(),
            last_sync_at: new Date().toISOString(),
          };
          if (existingProdMap[asin]) {
            prodToUpdate.push({ id: existingProdMap[asin].id, ...metrics });
          } else {
            prodToCreate.push({ amazon_account_id: amazonAccountId, asin, sku: m.sku || null, status: 'active', ...metrics });
          }
        }
        if (prodToCreate.length > 0) {
          for (let i = 0; i < prodToCreate.length; i += 500)
            await base44.asServiceRole.entities.Product.bulkCreate(prodToCreate.slice(i, i + 500));
        }
        if (prodToUpdate.length > 0) {
          for (let i = 0; i < prodToUpdate.length; i += 500)
            await base44.asServiceRole.entities.Product.bulkUpdate(prodToUpdate.slice(i, i + 500));
        }
        prodCount = prodToCreate.length + prodToUpdate.length;
      }

      // ── Processar keywords / search terms — upsert por keyword_id ──
      let kwCount = 0;
      if (data.keywords.length > 0) {
        const existingKws = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: amazonAccountId }, '-created_date', 5000);
        const existingKwMap = {};
        for (const kw of existingKws) existingKwMap[kw.keyword_id] = kw;

        const kwToCreate = [], kwToUpdate = [];
        for (const row of data.keywords) {
          if (!row.keywordId && !row.searchTerm) continue;
          const kwId = String(row.keywordId || `st_${row.searchTerm}`);
          const spend = Number(row.cost) || 0;
          const sales = Number(row.sales14d) || Number(row.sales30d) || 0;
          const clicks = Number(row.clicks) || 0;
          const rec = {
            amazon_account_id: amazonAccountId,
            campaign_id: String(row.campaignId || ''),
            ad_group_id: String(row.adGroupId || ''),
            keyword_id: kwId,
            keyword_text: row.searchTerm || row.keyword || '',
            match_type: (row.matchType || 'broad').toLowerCase(),
            state: 'enabled', status: 'enabled',
            spend, sales, clicks,
            impressions: Number(row.impressions) || 0,
            acos: sales > 0 ? spend / sales * 100 : 0,
            cpc: clicks > 0 ? spend / clicks : 0,
            synced_at: new Date().toISOString(),
          };
          if (existingKwMap[kwId]) kwToUpdate.push({ id: existingKwMap[kwId].id, ...rec });
          else kwToCreate.push(rec);
        }
        if (kwToCreate.length > 0) {
          for (let i = 0; i < kwToCreate.length; i += 500)
            await base44.asServiceRole.entities.Keyword.bulkCreate(kwToCreate.slice(i, i + 500));
        }
        if (kwToUpdate.length > 0) {
          for (let i = 0; i < kwToUpdate.length; i += 500)
            await base44.asServiceRole.entities.Keyword.bulkUpdate(kwToUpdate.slice(i, i + 500));
        }
        kwCount = kwToCreate.length + kwToUpdate.length;
      }

      // ── Decisões IA ──
      let decisionsCreated = 0;
      try {
        const topCamps = existingCampaigns
          .filter(c => (metricsByCAMP[c.campaign_id]?.impressions || 0) > 50)
          .sort((a, b) => (metricsByCAMP[b.campaign_id]?.spend || 0) - (metricsByCAMP[a.campaign_id]?.spend || 0))
          .slice(0, 15)
          .map(c => { const m = metricsByCAMP[c.campaign_id] || {}; return { id: c.campaign_id, name: c.name, spend: (m.spend||0).toFixed(2), sales: (m.sales||0).toFixed(2), acos: (m.acos||0).toFixed(1) }; });

        if (topCamps.length > 0) {
          const aiResult = await base44.asServiceRole.integrations.Core.InvokeLLM({
            prompt: `Amazon Ads 30d: Spend $${totalSpend.toFixed(2)}, Vendas $${totalSales.toFixed(2)}, ACoS ${totalSales > 0 ? (totalSpend/totalSales*100).toFixed(1) : 'N/A'}%, ROAS ${totalSpend > 0 ? (totalSales/totalSpend).toFixed(2) : 'N/A'}x. Top campanhas: ${JSON.stringify(topCamps)}. Gere 5-8 recomendações concretas.`,
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
          const recs = (aiResult?.decisions || []).map(d => ({
            amazon_account_id: amazonAccountId,
            decision_type: d.decision_type || 'bid_adjust',
            entity_type: d.entity_type || 'campaign',
            entity_id: d.entity_id || '', entity_name: d.entity_name || '',
            rationale: d.rationale || '', current_value: d.current_value || 0,
            proposed_value: d.proposed_value || 0, change_pct: d.change_pct || 0,
            confidence: d.confidence || 0.5, priority: d.priority || 'medium',
            status: 'pending',
          }));
          if (recs.length > 0) {
            await base44.asServiceRole.entities.Decision.bulkCreate(recs);
            decisionsCreated = recs.length;
          }
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
          records_received: data.campaigns.length + data.products.length + data.keywords.length,
          records_upserted: existingCampaigns.length + prodCount + kwCount,
          duration_ms: durationMs,
          completed_at: new Date().toISOString(),
          error_message: downloadErrors.length > 0 ? downloadErrors.join('; ') : null,
        });
      }

      return Response.json({
        ok: true,
        ready: true,
        campaigns_metrics: data.campaigns.length,
        products: prodCount,
        keywords: kwCount,
        decisions_created: decisionsCreated,
        download_errors: downloadErrors,
        duration_s: (durationMs / 1000).toFixed(1),
        summary: { total_spend: totalSpend, total_sales: totalSales, total_clicks: totalClicks, total_impressions: totalImpressions, total_orders: totalOrders },
      });
    }

    return Response.json({ ok: false, message: 'action deve ser "request" ou "download"' });

  } catch (error) {
    return Response.json({ ok: false, step: 'unknown', message: error.message });
  }
});