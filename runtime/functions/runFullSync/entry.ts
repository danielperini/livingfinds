/**
 * runFullSync — Pipeline completo Amazon Ads
 *
 * action="request":
 *   1. Renova access token
 *   2. Importa campanhas SP via API v3
 *   3. Solicita 4 relatórios: campanhas DAILY, campanhas SUMMARY, produtos, search terms
 *   → Retorna { ok, reportIds, syncRunId, campaigns_imported }
 *
 * action="download":
 *   4. Verifica status de cada reportId
 *   5. Se algum ainda PENDING → { ready: false, pending }
 *   6. Quando todos COMPLETED → baixa, descompacta, normaliza, persiste
 *   7. Atualiza Campaign, Product, Keyword, CampaignMetricsDaily, AmazonAccount, SyncRun
 *   8. Gera decisões IA
 *   → { ready: true, campaigns_metrics, products, keywords, decisions_created, summary }
 *
 * Nunca retorna HTTP 500. Erros Amazon: { ok: false, step, amazon_status, amazon_error, message }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── Token cache (module-level para reuse entre calls rápidas) ──
let _tokenCache = null;

async function getAdsToken(refreshToken) {
  if (_tokenCache && _tokenCache.expires_at > Date.now() + 5000) return _tokenCache.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: Deno.env.get('ADS_CLIENT_ID') || '',
    client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    return { __error: true, step: 'token_refresh', amazon_status: res.status, amazon_error: data.error_description || data.error || JSON.stringify(data) };
  }
  _tokenCache = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBase(region) {
  const r = (region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsGet(base, path, token, profileId) {
  const res = await fetch(`${base}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  if (!res.ok) return { __error: true, step: `GET ${path}`, amazon_status: res.status, amazon_error: JSON.stringify(data).slice(0, 400) };
  return data;
}

async function adsPost(base, path, token, profileId, body, contentType = 'application/json') {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': contentType,
      Accept: contentType,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  if (!res.ok) {
    // 425 = report duplicado — extrair reportId existente do body de erro
    if (res.status === 425) {
      const match = JSON.stringify(data).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (match) return { reportId: match[0], _duplicate: true };
    }
    return { __error: true, step: `POST ${path}`, amazon_status: res.status, amazon_error: JSON.stringify(data).slice(0, 400) };
  }
  return data;
}

async function decompress(arrayBuffer) {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(new Uint8Array(arrayBuffer));
  writer.close();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(merged));
}

function fmt(d) { return d.toISOString().slice(0, 10); }

// ── Solicitar um relatório, suprimir erros não-críticos ──
async function requestReport(base, token, profileId, payload) {
  const r = await adsPost(base, '/reporting/reports', token, profileId, payload);
  if (r?.__error) return { __error: true, ...r };
  return { reportId: r.reportId, _duplicate: r._duplicate || false };
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  let syncLog = null;
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const action = body.action || 'request';
    let amazonAccountId = body.amazon_account_id;

    // ── Resolver conta (suporta scheduler sem user_id) ──
    let account = null;
    if (amazonAccountId) {
      account = await base44.asServiceRole.entities.AmazonAccount.get(amazonAccountId).catch(() => null);
    }
    if (!account && user) {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: user.id });
      account = accounts[0] || null;
    }
    if (!account) {
      // Fallback: primeira conta conectada (usado por schedulers)
      const all = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = all[0] || (await base44.asServiceRole.entities.AmazonAccount.list('-created_date', 1))[0] || null;
    }
    if (!account) return Response.json({ ok: false, message: 'Nenhuma AmazonAccount encontrada' });
    amazonAccountId = account.id;

    // ── Limite de 6 syncs automáticos por dia ──
    const today = new Date().toISOString().slice(0, 10);
    const triggerType = body.trigger_type || 'automatic'; // 'automatic' ou 'manual'
    
    // Verificar se já existe sync em andamento
    const runningSyncs = await base44.asServiceRole.entities.SyncExecutionLog.filter({
      amazon_account_id: amazonAccountId,
      execution_date: today,
      status: 'started',
    });
    
    if (runningSyncs.length > 0 && triggerType === 'automatic') {
      console.log(`[runFullSync] Sync já em andamento, ignorando`);
      return Response.json({
        ok: false,
        skipped: true,
        reason: 'Sync já em andamento',
        running_count: runningSyncs.length,
      });
    }
    
    if (triggerType === 'automatic') {
      const todaySyncs = await base44.asServiceRole.entities.SyncExecutionLog.filter({
        amazon_account_id: amazonAccountId,
        execution_date: today,
        status: 'success',
      });
      
      if (todaySyncs.length >= 6) {
        console.log(`[runFullSync] Limite diário atingido: ${todaySyncs.length}/6 syncs automáticos`);
        return Response.json({
          ok: false,
          skipped: true,
          reason: 'Limite diário de 6 sincronizações automáticas atingido',
          daily_count: todaySyncs.length,
          max_daily: 6,
        });
      }
    }

    // ── Credenciais — prioridade: conta > env ──
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    if (!refreshToken) return Response.json({ ok: false, step: 'auth', message: 'Sem refresh_token. Configure AmazonAccount.ads_refresh_token ou ADS_REFRESH_TOKEN.' });
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!profileId) return Response.json({ ok: false, step: 'auth', message: 'ads_profile_id não configurado na conta ou ADS_PROFILE_ID.' });
    const adsBase = getAdsBase(account.region);

    // ══════════════════════════════════════════════════════════════════
    // FASE 1: request — importa campanhas + solicita 4 relatórios
    // ══════════════════════════════════════════════════════════════════
    if (action === 'request') {
      // 1. Renovar token
      const token = await getAdsToken(refreshToken);
      if (token?.__error) {
        return Response.json({ ok: false, step: token.step, amazon_status: token.amazon_status, amazon_error: token.amazon_error, message: `Falha ao renovar token: ${token.amazon_error}` });
      }

      await base44.asServiceRole.entities.AmazonAccount.update(amazonAccountId, {
        last_sync_at: new Date().toISOString(),
        status: 'connected',
        error_message: null,
      });

      // 2. Listar campanhas SP via v3
      const campData = await adsPost(
        adsBase, '/sp/campaigns/list', token, profileId,
        { stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] }, maxResults: 500 },
        'application/vnd.spCampaign.v3+json'
      );
      if (campData?.__error) {
        return Response.json({ ok: false, step: campData.step, amazon_status: campData.amazon_status, amazon_error: campData.amazon_error, message: `Falha ao listar campanhas: ${campData.amazon_error}` });
      }

      const campaigns = campData?.campaigns || [];
      const now = new Date().toISOString();

      // Cancelar SyncRuns running antigos
      await base44.asServiceRole.entities.SyncRun.updateMany(
        { amazon_account_id: amazonAccountId, status: 'running' },
        { $set: { status: 'partial', error_message: 'Substituído por novo ciclo', completed_at: now } }
      ).catch(() => {});

      // 3. Upsert campanhas no banco
      const existingCamps = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId }, '-created_date', 2000);
      const existingCampMap = {};
      for (const c of existingCamps) existingCampMap[c.campaign_id] = c;

      const toCreate = [], toUpdate = [];
      for (const c of campaigns) {
        const rec = {
          amazon_account_id: amazonAccountId,
          campaign_id: String(c.campaignId),
          name: c.name,
          campaign_name: c.name,
          campaign_type: 'SP',
          targeting_type: c.targetingType || 'AUTO',
          state: (c.state || 'ENABLED').toLowerCase(),
          status: (c.state || 'ENABLED').toLowerCase(),
          daily_budget: c.budget?.budget || c.dailyBudget || 0,
          start_date: c.startDate || null,
          end_date: c.endDate || null,
          bidding_strategy: c.dynamicBidding?.strategy || null,
          synced_at: now,
          last_sync_at: now,
        };
        if (existingCampMap[rec.campaign_id]) toUpdate.push({ id: existingCampMap[rec.campaign_id].id, ...rec });
        else toCreate.push(rec);
      }
      for (let i = 0; i < toCreate.length; i += 500) await base44.asServiceRole.entities.Campaign.bulkCreate(toCreate.slice(i, i + 500));
      for (let i = 0; i < toUpdate.length; i += 500) await base44.asServiceRole.entities.Campaign.bulkUpdate(toUpdate.slice(i, i + 500));

      // 4. Solicitar 4 relatórios em paralelo (API Amazon limita a 31 dias)
      const endDate = new Date();
      const startDate30 = new Date(Date.now() - 30 * 86400000); // 30 dias (limite Amazon)
      const ts = Date.now();

      const [rCampDaily, rCampSummary, rProducts, rSearchTerms] = await Promise.all([
        // Relatório DAILY — 30 dias
        requestReport(adsBase, token, profileId, {
          name: `SP_camp_daily_${ts}`,
          startDate: fmt(startDate30), endDate: fmt(endDate),
          configuration: {
            adProduct: 'SPONSORED_PRODUCTS',
            groupBy: ['campaign'],
            columns: ['date', 'campaignId', 'campaignName', 'campaignStatus', 'impressions', 'clicks', 'cost', 'purchases30d', 'sales30d', 'unitsSoldClicks30d'],
            reportTypeId: 'spCampaigns', timeUnit: 'DAILY', format: 'GZIP_JSON',
          },
        }),
        // Relatório SUMMARY — 30 dias
        requestReport(adsBase, token, profileId, {
          name: `SP_camp_summary_${ts}`,
          startDate: fmt(startDate30), endDate: fmt(endDate),
          configuration: {
            adProduct: 'SPONSORED_PRODUCTS',
            groupBy: ['campaign'],
            columns: ['campaignId', 'campaignName', 'campaignStatus', 'campaignBudgetAmount', 'impressions', 'clicks', 'cost', 'purchases30d', 'sales30d', 'unitsSoldClicks30d'],
            reportTypeId: 'spCampaigns', timeUnit: 'SUMMARY', format: 'GZIP_JSON',
          },
        }),
        // Relatório produtos — 30 dias
        requestReport(adsBase, token, profileId, {
          name: `SP_products_${ts}`,
          startDate: fmt(startDate30), endDate: fmt(endDate),
          configuration: {
            adProduct: 'SPONSORED_PRODUCTS',
            groupBy: ['advertiser'],
            columns: ['advertisedAsin', 'advertisedSku', 'campaignId', 'adGroupId', 'impressions', 'clicks', 'cost', 'purchases30d', 'sales30d', 'unitsSoldClicks30d'],
            reportTypeId: 'spAdvertisedProduct', timeUnit: 'SUMMARY', format: 'GZIP_JSON',
          },
        }),
        // Search Terms — 30 dias
        requestReport(adsBase, token, profileId, {
          name: `SP_searchterms_${ts}`,
          startDate: fmt(startDate30), endDate: fmt(endDate),
          configuration: {
            adProduct: 'SPONSORED_PRODUCTS',
            groupBy: ['searchTerm'],
            columns: ['searchTerm', 'campaignId', 'adGroupId', 'keywordId', 'matchType', 'impressions', 'clicks', 'cost', 'purchases30d', 'sales30d', 'unitsSoldClicks30d'],
            reportTypeId: 'spSearchTerm', timeUnit: 'SUMMARY', format: 'GZIP_JSON',
          },
        }),
      ]);

      // Coletar reportIds — relatórios com erro são ignorados (não bloqueia)
      const reportIds = {};
      const reportErrors = [];
      const reportMap = { campDaily: rCampDaily, campSummary: rCampSummary, products: rProducts, keywords: rSearchTerms };
      for (const [key, r] of Object.entries(reportMap)) {
        if (r?.__error) reportErrors.push(`${key}: ${r.amazon_error}`);
        else if (r?.reportId) reportIds[key] = r.reportId;
      }

      if (Object.keys(reportIds).length === 0) {
        return Response.json({ ok: false, step: 'request_reports', message: 'Todos os relatórios falharam', errors: reportErrors });
      }

      // Registrar início da execução
      const syncLog = await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: amazonAccountId,
        operation: 'full_sync',
        trigger_type: triggerType,
        status: 'started',
        execution_date: today,
        started_at: new Date().toISOString(),
        daily_count_at_execution: triggerType === 'automatic' ? (await base44.asServiceRole.entities.SyncExecutionLog.filter({
          amazon_account_id: amazonAccountId,
          execution_date: today,
          status: { $in: ['success', 'started'] },
        })).length : 0,
      });

      const syncRun = await base44.asServiceRole.entities.SyncRun.create({
        amazon_account_id: amazonAccountId,
        operation: 'runFullSync:request',
        status: 'running',
        started_at: new Date().toISOString(),
      });

      return Response.json({
        ok: true,
        campaigns_imported: campaigns.length,
        reportIds,
        syncRunId: syncRun.id,
        report_errors: reportErrors,
        message: `${campaigns.length} campanhas importadas. ${Object.keys(reportIds).length} relatórios solicitados. Aguarde 5-15 min.`,
      });
    }

    // ══════════════════════════════════════════════════════════════════
    // FASE 2: download — verifica, baixa, normaliza, persiste
    // ══════════════════════════════════════════════════════════════════
    if (action === 'download') {
      const { reportIds, syncRunId } = body;
      if (!reportIds || Object.keys(reportIds).length === 0) {
        return Response.json({ ok: false, step: 'download', message: 'reportIds required' });
      }

      const token = await getAdsToken(refreshToken);
      if (token?.__error) {
        return Response.json({ ok: false, step: token.step, amazon_status: token.amazon_status, amazon_error: token.amazon_error, message: `Falha ao renovar token: ${token.amazon_error}` });
      }

      // Verificar status de todos os reports
      const statusChecks = await Promise.all(
        Object.entries(reportIds).map(async ([key, reportId]) => {
          if (!reportId) return { key, status: 'MISSING' };
          const s = await adsGet(adsBase, `/reporting/reports/${reportId}`, token, profileId);
          if (s?.__error) return { key, status: 'ERROR', error: s.amazon_error };
          return { key, status: s.status || 'PENDING', url: s.url, failureReason: s.failureReason };
        })
      );

      const pending = {}, failed = {}, ready = {};
      for (const s of statusChecks) {
        if (s.status === 'COMPLETED' && s.url) ready[s.key] = s.url;
        else if (['FAILED', 'ERROR', 'MISSING'].includes(s.status)) failed[s.key] = s.error || s.failureReason || s.status;
        else pending[s.key] = s.status;
      }

      // Ainda há pendentes → retornar para o cliente continuar polling
      if (Object.keys(pending).length > 0) {
        return Response.json({ ok: true, ready: false, pending, failed, message: `Aguardando ${Object.keys(pending).length} report(s): ${Object.keys(pending).join(', ')}` });
      }

      // Nenhum pronto → falha total
      if (Object.keys(ready).length === 0) {
        return Response.json({ ok: false, step: 'download', message: 'Todos os relatórios falharam', failed });
      }

      // Baixar e descompactar relatórios prontos
      const data = { campDaily: [], campSummary: [], products: [], keywords: [] };
      const downloadErrors = [];
      for (const [key, url] of Object.entries(ready)) {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar ${key}`);
          const buf = await res.arrayBuffer();
          data[key] = await decompress(buf);
          console.log(`[runFullSync] ${key}: ${data[key].length} linhas baixadas`);
        } catch (e) {
          downloadErrors.push(`${key}: ${e.message}`);
          console.error(`[runFullSync] Erro download ${key}:`, e.message);
        }
      }

      const today = fmt(new Date());
      let totalSpend = 0, totalSales = 0, totalClicks = 0, totalImpressions = 0, totalOrders = 0;

      // ── 1. Processar DAILY campaigns — popular CampaignMetricsDaily ──
      const dailyMetricsMap = {}; // campId -> [{ date, metrics }]
      for (const row of data.campDaily) {
        const campaignId = String(row.campaignId || row.campaign_id || '');
        const date = row.date || today;
        const spend = Number(row.cost) || 0;
        const sales = Number(row.sales30d) || Number(row.sales14d) || Number(row.sales1d) || 0;
        const clicks = Number(row.clicks) || 0;
        const impressions = Number(row.impressions) || 0;
        const orders = Number(row.purchases30d) || Number(row.purchases14d) || 0;
        const acos = sales > 0 ? spend / sales * 100 : 0;
        const roas = spend > 0 ? sales / spend : 0;
        const ctr = impressions > 0 ? clicks / impressions * 100 : 0;
        const cpc = clicks > 0 ? spend / clicks : 0;

        if (!dailyMetricsMap[campaignId]) dailyMetricsMap[campaignId] = [];
        dailyMetricsMap[campaignId].push({ date, spend, sales, clicks, impressions, orders, acos, roas, ctr, cpc });
      }

      // Upsert CampaignMetricsDaily por (campaign_id, date)
      const allDailyRecords = [];
      for (const [campaignId, rows] of Object.entries(dailyMetricsMap)) {
        for (const r of rows) {
          allDailyRecords.push({ amazon_account_id: amazonAccountId, campaign_id: campaignId, ...r });
        }
      }

      if (allDailyRecords.length > 0) {
        // Upsert incremental: preservar 180 dias para IA
        const cutoff180 = new Date(Date.now() - 180 * 86400000);
        const cutoff180Str = cutoff180.toISOString().slice(0, 10);

        // 1. Apagar apenas registros >180 dias (preservar histórico para IA)
        const oldRecords = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
          { amazon_account_id: amazonAccountId },
          'date',
          5000
        );
        const toDelete = oldRecords.filter(r => r.date && r.date < cutoff180Str);
        for (let i = 0; i < toDelete.length; i += 500) {
          const ids = toDelete.slice(i, i + 500).map(r => r.id);
          await Promise.all(ids.map(id => base44.asServiceRole.entities.CampaignMetricsDaily.delete(id))).catch(() => {});
        }
        if (toDelete.length > 0) console.log(`[runFullSync] CampaignMetricsDaily: ${toDelete.length} registros removidos (>180d)`);

        // 2. Buscar registros existentes (180 dias) para upsert
        const startDate180Str = cutoff180Str;
        const existing = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
          { amazon_account_id: amazonAccountId },
          '-date',
          10000
        );
        // Mapa: "campaignId|date" -> id do registro existente
        const existingMap = {};
        for (const r of existing) {
          if (r.date >= startDate180Str) {
            existingMap[`${r.campaign_id}|${r.date}`] = r.id;
          }
        }

        // 3. Separar em criar vs atualizar
        const dailyToCreate = [], dailyToUpdate = [];
        for (const rec of allDailyRecords) {
          const key = `${rec.campaign_id}|${rec.date}`;
          if (existingMap[key]) {
            dailyToUpdate.push({ id: existingMap[key], ...rec });
          } else {
            dailyToCreate.push(rec);
          }
        }

        for (let i = 0; i < dailyToCreate.length; i += 500) {
          await base44.asServiceRole.entities.CampaignMetricsDaily.bulkCreate(dailyToCreate.slice(i, i + 500));
        }
        for (let i = 0; i < dailyToUpdate.length; i += 500) {
          await base44.asServiceRole.entities.CampaignMetricsDaily.bulkUpdate(dailyToUpdate.slice(i, i + 500));
        }
        console.log(`[runFullSync] CampaignMetricsDaily: ${dailyToCreate.length} criados, ${dailyToUpdate.length} atualizados, histórico 120d preservado`);
      }

      // ── 2. Processar SUMMARY campaigns — atualizar métricas nas campanhas ──
      const metricsByCAMP = {};
      for (const row of data.campSummary) {
        const campaignId = String(row.campaignId || row.campaign_id || '');
        const spend = Number(row.cost) || 0;
        const sales = Number(row.sales30d) || Number(row.sales14d) || Number(row.sales1d) || 0;
        const clicks = Number(row.clicks) || 0;
        const impressions = Number(row.impressions) || 0;
        const orders = Number(row.purchases30d) || Number(row.purchases14d) || 0;
        const acos = sales > 0 ? spend / sales * 100 : 0;
        const roas = spend > 0 ? sales / spend : 0;
        const ctr = impressions > 0 ? clicks / impressions * 100 : 0;
        const cpc = clicks > 0 ? spend / clicks : 0;

        totalSpend += spend; totalSales += sales;
        totalClicks += clicks; totalImpressions += impressions; totalOrders += orders;
        metricsByCAMP[campaignId] = { spend, sales, clicks, impressions, orders, acos, roas, ctr, cpc };
      }

      // Se não há summary (falhou), calcular a partir do daily
      if (Object.keys(metricsByCAMP).length === 0 && allDailyRecords.length > 0) {
        for (const r of allDailyRecords) {
          const cid = r.campaign_id;
          if (!metricsByCAMP[cid]) metricsByCAMP[cid] = { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0, acos: 0, roas: 0, ctr: 0, cpc: 0 };
          metricsByCAMP[cid].spend += r.spend || 0;
          metricsByCAMP[cid].sales += r.sales || 0;
          metricsByCAMP[cid].clicks += r.clicks || 0;
          metricsByCAMP[cid].impressions += r.impressions || 0;
          metricsByCAMP[cid].orders += r.orders || 0;
        }
        for (const [cid, m] of Object.entries(metricsByCAMP)) {
          m.acos = m.sales > 0 ? m.spend / m.sales * 100 : 0;
          m.roas = m.spend > 0 ? m.sales / m.spend : 0;
          m.ctr = m.impressions > 0 ? m.clicks / m.impressions * 100 : 0;
          m.cpc = m.clicks > 0 ? m.spend / m.clicks : 0;
          totalSpend += m.spend; totalSales += m.sales;
          totalClicks += m.clicks; totalImpressions += m.impressions; totalOrders += m.orders;
        }
      }

      // Atualizar métricas nas campanhas existentes
      const existingCampaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId }, '-created_date', 2000);
      const campUpdates = [];
      for (const c of existingCampaigns) {
        const m = metricsByCAMP[c.campaign_id];
        if (m) campUpdates.push({ id: c.id, ...m, synced_at: new Date().toISOString(), last_sync_at: new Date().toISOString() });
      }
      for (let i = 0; i < campUpdates.length; i += 500) {
        await base44.asServiceRole.entities.Campaign.bulkUpdate(campUpdates.slice(i, i + 500));
      }
      console.log(`[runFullSync] Campanhas atualizadas com métricas: ${campUpdates.length}`);

      // ── 3. Processar produtos — upsert por ASIN ──
      let prodCount = 0;
      if (data.products.length > 0) {
        // Agregar por ASIN (pode ter múltiplas linhas por asin de campanhas diferentes)
        const asinMap = {};
        for (const row of data.products) {
          const asin = row.advertisedAsin || row.asin || row.ASIN || '';
          if (!asin) continue;
          if (!asinMap[asin]) {
            asinMap[asin] = { spend: 0, sales: 0, units: 0, clicks: 0, impressions: 0, sku: row.advertisedSku || row.sku || null, campaignId: row.campaignId };
          }
          asinMap[asin].spend += Number(row.cost) || 0;
          asinMap[asin].sales += Number(row.sales30d) || Number(row.sales14d) || Number(row.sales1d) || 0;
          asinMap[asin].units += Number(row.unitsSoldClicks30d) || Number(row.unitsSoldClicks14d) || Number(row.unitsSoldClicks1d) || 0;
          asinMap[asin].clicks += Number(row.clicks) || 0;
          asinMap[asin].impressions += Number(row.impressions) || 0;
          if (row.advertisedSku && !asinMap[asin].sku) asinMap[asin].sku = row.advertisedSku;
        }

        console.log(`[runFullSync] ASINs únicos no relatório: ${Object.keys(asinMap).length}`);

        const existingProds = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: amazonAccountId }, '-created_date', 2000);
        const existingProdMap = {};
        for (const p of existingProds) existingProdMap[p.asin] = p;

        // Mapa campId → campanha para linkar produto
        const campById = {};
        for (const c of existingCampaigns) campById[c.campaign_id] = c;

        const prodToCreate = [], prodToUpdate = [];
        for (const [asin, m] of Object.entries(asinMap)) {
          const linkedCamp = m.campaignId ? campById[String(m.campaignId)] : null;
          const hasCampaign = !!linkedCamp;
          const campActive = linkedCamp && linkedCamp.state === 'enabled';
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
            prodToUpdate.push({ id: existingProdMap[asin].id, sku: m.sku || existingProdMap[asin].sku, ...metrics });
          } else {
            prodToCreate.push({ amazon_account_id: amazonAccountId, asin, sku: m.sku || null, status: 'active', inventory_status: 'in_stock', ...metrics });
          }
        }

        for (let i = 0; i < prodToCreate.length; i += 500) await base44.asServiceRole.entities.Product.bulkCreate(prodToCreate.slice(i, i + 500));
        for (let i = 0; i < prodToUpdate.length; i += 500) await base44.asServiceRole.entities.Product.bulkUpdate(prodToUpdate.slice(i, i + 500));
        prodCount = prodToCreate.length + prodToUpdate.length;
        console.log(`[runFullSync] Produtos: ${prodToCreate.length} criados, ${prodToUpdate.length} atualizados`);
      }

      // ── 4. Processar search terms / keywords ──
      let kwCount = 0;
      if (data.keywords.length > 0) {
        const existingKws = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: amazonAccountId }, '-created_date', 5000);
        const existingKwMap = {};
        for (const kw of existingKws) existingKwMap[kw.keyword_id] = kw;

        const kwToCreate = [], kwToUpdate = [];
        for (const row of data.keywords) {
          if (!row.keywordId && !row.searchTerm) continue;
          const kwId = String(row.keywordId || `st_${(row.searchTerm || '').replace(/\s+/g, '_').slice(0, 80)}`);
          const spend = Number(row.cost) || 0;
          const sales = Number(row.sales14d) || Number(row.sales30d) || 0;
          const clicks = Number(row.clicks) || 0;
          const impressions = Number(row.impressions) || 0;
          const rec = {
            amazon_account_id: amazonAccountId,
            campaign_id: String(row.campaignId || ''),
            ad_group_id: String(row.adGroupId || ''),
            keyword_id: kwId,
            keyword_text: row.searchTerm || row.keyword || '',
            match_type: (row.matchType || 'broad').toLowerCase(),
            state: 'enabled', status: 'enabled',
            spend, sales, clicks, impressions,
            acos: sales > 0 ? spend / sales * 100 : 0,
            cpc: clicks > 0 ? spend / clicks : 0,
            ctr: impressions > 0 ? clicks / impressions * 100 : 0,
            source: 'search_term',
            synced_at: new Date().toISOString(),
          };
          if (existingKwMap[kwId]) kwToUpdate.push({ id: existingKwMap[kwId].id, ...rec });
          else kwToCreate.push(rec);
        }
        for (let i = 0; i < kwToCreate.length; i += 500) await base44.asServiceRole.entities.Keyword.bulkCreate(kwToCreate.slice(i, i + 500));
        for (let i = 0; i < kwToUpdate.length; i += 500) await base44.asServiceRole.entities.Keyword.bulkUpdate(kwToUpdate.slice(i, i + 500));
        kwCount = kwToCreate.length + kwToUpdate.length;
        console.log(`[runFullSync] Keywords/SearchTerms: ${kwToCreate.length} criados, ${kwToUpdate.length} atualizados`);
      }

      // ── 5. Decisões IA ──
      let decisionsCreated = 0;
      try {
        const topCamps = existingCampaigns
          .filter(c => (metricsByCAMP[c.campaign_id]?.impressions || 0) > 50)
          .sort((a, b) => (metricsByCAMP[b.campaign_id]?.spend || 0) - (metricsByCAMP[a.campaign_id]?.spend || 0))
          .slice(0, 15)
          .map(c => {
            const m = metricsByCAMP[c.campaign_id] || {};
            return { id: c.campaign_id, name: c.name, spend: (m.spend || 0).toFixed(2), sales: (m.sales || 0).toFixed(2), acos: (m.acos || 0).toFixed(1), clicks: m.clicks || 0 };
          });

        if (topCamps.length > 0) {
          const aiResult = await base44.asServiceRole.integrations.Core.InvokeLLM({
            prompt: `Amazon Ads últimos 30 dias: Spend total $${totalSpend.toFixed(2)}, Vendas $${totalSales.toFixed(2)}, ACoS ${totalSales > 0 ? (totalSpend / totalSales * 100).toFixed(1) : 'N/A'}%, ROAS ${totalSpend > 0 ? (totalSales / totalSpend).toFixed(2) : 'N/A'}x. Top campanhas: ${JSON.stringify(topCamps)}. Gere 5-8 recomendações concretas de otimização de bid, budget ou keywords.`,
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
        console.warn('[runFullSync] IA falhou (não crítico):', aiErr.message);
      }

      // ── 6. Finalizar ──
      const durationMs = Date.now() - startTime;
      const now2 = new Date().toISOString();

      await base44.asServiceRole.entities.AmazonAccount.update(amazonAccountId, {
        status: 'connected', last_sync_at: now2, error_message: null,
      });

      if (syncRunId) {
        await base44.asServiceRole.entities.SyncRun.update(syncRunId, {
          status: 'success',
          records_received: data.campSummary.length + data.products.length + data.keywords.length,
          records_upserted: campUpdates.length + prodCount + kwCount,
          duration_ms: durationMs,
          completed_at: now2,
          error_message: downloadErrors.length > 0 ? downloadErrors.join('; ') : null,
        }).catch(() => {});
      }

      // Atualizar log de execução
      if (syncLog) {
        await base44.asServiceRole.entities.SyncExecutionLog.update(syncLog.id, {
          status: 'success',
          completed_at: now2,
          duration_ms: durationMs,
          records_processed: campUpdates.length + prodCount + kwCount,
        }).catch(() => {});
      }

      console.log(`[runFullSync] Concluído em ${(durationMs / 1000).toFixed(1)}s. Camps:${campUpdates.length} Prods:${prodCount} KWs:${kwCount} IA:${decisionsCreated}`);

      return Response.json({
        ok: true,
        ready: true,
        campaigns_metrics: data.campSummary.length,
        daily_metrics: allDailyRecords.length,
        products: prodCount,
        keywords: kwCount,
        decisions_created: decisionsCreated,
        download_errors: downloadErrors,
        duration_s: (durationMs / 1000).toFixed(1),
        summary: {
          total_spend: totalSpend,
          total_sales: totalSales,
          total_clicks: totalClicks,
          total_impressions: totalImpressions,
          total_orders: totalOrders,
          acos: totalSales > 0 ? totalSpend / totalSales * 100 : 0,
          roas: totalSpend > 0 ? totalSales / totalSpend : 0,
        },
      });
    }

    return Response.json({ ok: false, message: 'action deve ser "request" ou "download"' });

  } catch (error) {
    console.error('[runFullSync] Erro inesperado:', error.message, error.stack?.slice(0, 500));
    
    // Atualizar AmazonAccount com erro
    await base44.asServiceRole.entities.AmazonAccount.update(amazonAccountId, {
      status: 'error',
      error_message: error.message,
    }).catch(() => {});
    
    // Atualizar SyncExecutionLog com erro (se existir)
    if (typeof syncLog !== 'undefined' && syncLog) {
      await base44.asServiceRole.entities.SyncExecutionLog.update(syncLog.id, {
        status: 'error',
        completed_at: new Date().toISOString(),
        error_message: error.message,
        duration_ms: Date.now() - startTime,
      }).catch(() => {});
    }
    
    return Response.json({ ok: false, step: 'unknown', message: error.message, stack: error.stack?.slice(0, 300) });
  }
});