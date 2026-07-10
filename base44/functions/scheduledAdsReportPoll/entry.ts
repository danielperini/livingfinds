/**
 * scheduledAdsReportPoll
 *
 * Fase 2 do pipeline de relatórios Amazon Ads:
 * 1. Lê o SyncRun mais recente com status "running" para obter os reportIds
 * 2. Verifica status de cada relatório na API Amazon
 * 3. Se todos prontos: baixa, descomprime, grava no banco (AdsMetricsHistory,
 *    CampaignMetricsDaily, SearchTerm, Campaign) e marca SyncRun como "success"
 * 4. Se ainda pendente: retorna { ready: false } para a automação tentar novamente
 *
 * Design: execução < 5 min, sem loops de polling interno.
 * Chamado pela automação "Download Relatórios" às 06:40, 07:00, 07:20 BRT.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function getAdsBase(region: string) {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

function fmt(d: Date) { return d.toISOString().slice(0, 10); }

async function decompress(buf: ArrayBuffer): Promise<any[]> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(new Uint8Array(buf));
  writer.close();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return JSON.parse(new TextDecoder().decode(merged));
}

const BATCH = 100;          // registros por lote de DB
const BATCH_PAUSE = 150;    // ms entre lotes para evitar rate limit

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function bulkInsertBatched(entity: any, records: any[]) {
  for (let i = 0; i < records.length; i += BATCH) {
    await entity.bulkCreate(records.slice(i, i + BATCH));
    if (i + BATCH < records.length) await sleep(BATCH_PAUSE);
  }
}

async function bulkUpdateBatched(entity: any, records: any[]) {
  for (let i = 0; i < records.length; i += BATCH) {
    await entity.bulkUpdate(records.slice(i, i + BATCH));
    if (i + BATCH < records.length) await sleep(BATCH_PAUSE);
  }
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Resolver conta
    const accounts = await base44.asServiceRole.entities.AmazonAccount.list('-created_date', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon encontrada' });

    const aid = account.id;
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';

    if (!refreshToken || !profileId || !clientId || !clientSecret) {
      return Response.json({ ok: false, error: 'Credenciais não configuradas' });
    }

    // Buscar SyncRun pendente mais recente
    let syncRunId = body.syncRunId;
    let reportIds: Record<string, string> = body.reportIds || {};
    let endDateStr = '';

    if (!syncRunId || Object.keys(reportIds).length === 0) {
      // Auto-descobrir o SyncRun "running" mais recente
      const runs = await base44.asServiceRole.entities.SyncRun.filter(
        { amazon_account_id: aid, status: 'running' }, '-started_at', 5
      );
      const run = runs.find((r: any) => r.operation?.startsWith('adsReports:'));
      if (!run) return Response.json({ ok: false, error: 'Nenhum SyncRun pendente encontrado. Execute autoRequestAndDownloadReports primeiro.' });
      syncRunId = run.id;
      const match = run.operation.match(/^adsReports:([^:]+):(.+)$/);
      if (match) { endDateStr = match[1]; reportIds = JSON.parse(match[2]); }
    }

    if (Object.keys(reportIds).length === 0) {
      return Response.json({ ok: false, error: 'reportIds não encontrados no SyncRun' });
    }

    // Obter token LWA
    const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString(),
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData.access_token) {
      return Response.json({ ok: false, error: `Token falhou: ${tokenData.error_description || tokenRes.status}` });
    }
    const token = tokenData.access_token;
    const adsBase = getAdsBase(account.region || Deno.env.get('ADS_REGION') || 'NA');

    const adsHeaders: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': profileId,
      'Accept': 'application/json',
    };

    // Verificar status de cada relatório (única chamada — automação faz retry periodicamente)
    console.log(`[adsReportPoll] Verificando ${Object.keys(reportIds).length} relatórios...`);
    const statuses = await Promise.all(
      Object.entries(reportIds).map(async ([key, rid]) => {
        const r = await fetch(`${adsBase}/reporting/reports/${rid}`, { headers: adsHeaders });
        const d = await r.json().catch(() => ({}));
        return { key, status: d.status, url: d.url, reason: d.failureReason };
      })
    );

    const ready = statuses.filter(s => s.status === 'COMPLETED' && s.url);
    const pending = statuses.filter(s => !['COMPLETED', 'FAILED', 'EXPIRED'].includes(s.status));
    const failed = statuses.filter(s => ['FAILED', 'EXPIRED'].includes(s.status));

    console.log(`[adsReportPoll] ready=${ready.length} pending=${pending.length} failed=${failed.length}`);

    // Se ainda há pendentes e nenhum pronto — automação retentará no próximo ciclo
    if (pending.length > 0 && ready.length === 0) {
      return Response.json({ ok: true, ready: false, pending: pending.map(s => s.key), message: 'Relatórios ainda sendo gerados. Tente novamente em 15-20 min.' });
    }

    if (ready.length === 0) {
      await base44.asServiceRole.entities.SyncRun.update(syncRunId, {
        status: 'error',
        error_message: `Todos falharam: ${failed.map(s => `${s.key}:${s.reason}`).join(', ')}`,
        completed_at: new Date().toISOString(),
      }).catch(() => {});
      return Response.json({ ok: false, error: 'Todos os relatórios falharam ou expiraram', failed: failed.map(s => s.key) });
    }

    // ── Baixar e processar relatórios prontos ──
    const data: Record<string, any[]> = {};
    for (const s of ready) {
      try {
        const r = await fetch(s.url!);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = await r.arrayBuffer();
        data[s.key] = await decompress(buf);
        console.log(`[adsReportPoll] ${s.key}: ${data[s.key].length} linhas`);
      } catch (e: any) {
        console.error(`[adsReportPoll] download ${s.key}: ${e.message}`);
      }
    }

    if (Object.keys(data).length === 0) {
      return Response.json({ ok: false, error: 'Falha ao baixar todos os relatórios' });
    }

    const now = new Date().toISOString();
    const endDate = endDateStr || fmt(new Date(Date.now() - 86400000));

    // ── Limpar dados antigos (sequencial para evitar rate limit) ──
    console.log('[adsReportPoll] Limpando dados antigos...');
    await base44.asServiceRole.entities.AdsMetricsHistory.deleteMany({ amazon_account_id: aid }).catch(() => {});
    await sleep(BATCH_PAUSE);
    await base44.asServiceRole.entities.SearchTerm.deleteMany({ amazon_account_id: aid }).catch(() => {});
    await sleep(BATCH_PAUSE);
    await base44.asServiceRole.entities.CampaignMetricsDaily.deleteMany({ amazon_account_id: aid }).catch(() => {});

    // ── Construir AdsMetricsHistory ──
    const historyRecords: any[] = [];
    const seen = new Set<string>();

    for (const [key, rows] of Object.entries(data)) {
      for (const row of rows) {
        const date = row.date || endDate;
        const campaignId = String(row.campaignId || '');
        const adGroupId = String(row.adGroupId || '');
        const searchTerm = row.searchTerm || '';
        const keywordId = String(row.keywordId || '');
        const asin = row.advertisedAsin || '';
        const uniqueKey = `${date}|${key}|${campaignId}|${adGroupId}|${searchTerm}|${keywordId}|${asin}`;
        if (seen.has(uniqueKey)) continue;
        seen.add(uniqueKey);

        historyRecords.push({
          amazon_account_id: aid,
          date,
          campaign_id: campaignId,
          campaign_name: row.campaignName || '',
          ad_group_id: adGroupId,
          ad_group_name: row.adGroupName || '',
          keyword_id: keywordId,
          keyword_text: row.keyword || '',
          search_term: searchTerm,
          match_type: (row.matchType || '').toLowerCase(),
          advertised_asin: asin,
          advertised_sku: row.advertisedSku || '',
          report_type: key,
          impressions: Number(row.impressions) || 0,
          clicks: Number(row.clicks) || 0,
          spend: Number(row.cost) || 0,
          orders_1d: Number(row.purchases1d) || 0,
          orders_7d: Number(row.purchases7d) || 0,
          orders_14d: Number(row.purchases14d) || 0,
          orders_30d: Number(row.purchases30d) || 0,
          sales_1d: Number(row.sales1d) || 0,
          sales_7d: Number(row.sales7d) || 0,
          sales_14d: Number(row.sales14d) || 0,
          sales_30d: Number(row.sales30d) || 0,
          acos_14d: Number(row.acosClicks14d) || 0,
          roas_14d: Number(row.roasClicks14d) || 0,
          unique_key: uniqueKey,
          synced_at: now,
        });
      }
    }

    await bulkInsertBatched(base44.asServiceRole.entities.AdsMetricsHistory, historyRecords);
    console.log(`[adsReportPoll] AdsMetricsHistory: ${historyRecords.length}`);

    // ── SearchTerm ──
    const stRecords = historyRecords
      .filter(r => r.report_type === 'searchTerms')
      .map(r => ({
        amazon_account_id: aid,
        date: r.date, campaign_id: r.campaign_id, campaign_name: r.campaign_name,
        ad_group_id: r.ad_group_id, ad_group_name: r.ad_group_name,
        keyword_id: r.keyword_id, keyword_text: r.keyword_text, keyword_type: '',
        match_type: r.match_type, search_term: r.search_term,
        advertised_asin: r.advertised_asin, advertised_sku: r.advertised_sku,
        impressions: r.impressions, clicks: r.clicks,
        ctr: r.impressions > 0 ? (r.clicks / r.impressions * 100) : 0,
        cpc: r.clicks > 0 ? (r.spend / r.clicks) : 0,
        spend: r.spend,
        orders_7d: r.orders_7d, orders_14d: r.orders_14d, orders_30d: r.orders_30d,
        sales_7d: r.sales_7d, sales_14d: r.sales_14d, sales_30d: r.sales_30d,
        acos_14d: r.acos_14d, roas_14d: r.roas_14d,
        conversion_rate: r.clicks > 0 ? (r.orders_14d / r.clicks * 100) : 0,
        unique_key: r.unique_key, synced_at: now,
      }));

    await bulkInsertBatched(base44.asServiceRole.entities.SearchTerm, stRecords);
    console.log(`[adsReportPoll] SearchTerm: ${stRecords.length}`);

    // ── CampaignMetricsDaily (priorizar relatório "campaigns") ──
    const metricsMap = new Map<string, any>();
    for (const r of historyRecords) {
      if (!r.campaign_id) continue;
      const k = `${r.campaign_id}|${r.date}`;
      if (!metricsMap.has(k)) {
        metricsMap.set(k, { amazon_account_id: aid, campaign_id: r.campaign_id, campaign_name: r.campaign_name, date: r.date, spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0, _prio: false });
      }
      const m = metricsMap.get(k)!;
      if (r.report_type === 'campaigns') {
        m.spend = r.spend; m.sales = r.sales_14d; m.clicks = r.clicks; m.impressions = r.impressions; m.orders = r.orders_14d; m._prio = true;
      } else if (!m._prio) {
        m.spend += r.spend; m.sales += r.sales_14d; m.clicks += r.clicks; m.impressions += r.impressions; m.orders += r.orders_14d;
      }
    }

    const metricsRecords = Array.from(metricsMap.values()).map(({ _prio, ...m }) => ({
      ...m,
      acos: m.sales > 0 ? (m.spend / m.sales * 100) : 0,
      roas: m.spend > 0 ? (m.sales / m.spend) : 0,
      ctr: m.impressions > 0 ? (m.clicks / m.impressions * 100) : 0,
      cpc: m.clicks > 0 ? (m.spend / m.clicks) : 0,
      synced_at: now,
    }));

    await bulkInsertBatched(base44.asServiceRole.entities.CampaignMetricsDaily, metricsRecords);
    console.log(`[adsReportPoll] CampaignMetricsDaily: ${metricsRecords.length}`);

    // ── Atualizar métricas agregadas nas entidades Campaign ──
    const campAgg = new Map<string, any>();
    for (const r of historyRecords) {
      if (!r.campaign_id) continue;
      if (!campAgg.has(r.campaign_id)) campAgg.set(r.campaign_id, { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0 });
      const c = campAgg.get(r.campaign_id)!;
      c.spend += r.spend; c.sales += r.sales_14d; c.clicks += r.clicks; c.impressions += r.impressions; c.orders += r.orders_14d;
    }

    const existingCamps = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 5000).catch(() => []);
    const campMap = new Map((existingCamps as any[]).map(c => [c.campaign_id, c]));
    const campUpdates = Array.from(campAgg.entries())
      .filter(([id]) => campMap.has(id))
      .map(([id, agg]) => {
        const existing = campMap.get(id) as any;
        return {
          id: existing.id,
          spend: agg.spend, sales: agg.sales, clicks: agg.clicks, impressions: agg.impressions, orders: agg.orders,
          acos: agg.sales > 0 ? (agg.spend / agg.sales * 100) : 0,
          roas: agg.spend > 0 ? (agg.sales / agg.spend) : 0,
          ctr: agg.impressions > 0 ? (agg.clicks / agg.impressions * 100) : 0,
          cpc: agg.clicks > 0 ? (agg.spend / agg.clicks) : 0,
          synced_at: now,
        };
      });

    await bulkUpdateBatched(base44.asServiceRole.entities.Campaign, campUpdates).catch(() => {});
    console.log(`[adsReportPoll] Campaign: ${campUpdates.length} atualizadas`);

    // ── Finalizar ──
    await base44.asServiceRole.entities.AmazonAccount.update(aid, { last_sync_at: now, status: 'connected' }).catch(() => {});
    await base44.asServiceRole.entities.SyncRun.update(syncRunId, {
      status: 'success',
      records_upserted: historyRecords.length,
      completed_at: now,
      duration_ms: Date.now() - startTime,
    }).catch(() => {});

    const summary = {
      ok: true,
      ready: true,
      history_records: historyRecords.length,
      campaign_metrics: metricsRecords.length,
      search_terms: stRecords.length,
      campaigns_updated: campUpdates.length,
      duration_s: ((Date.now() - startTime) / 1000).toFixed(1),
    };
    console.log('[adsReportPoll] ✅ Concluído:', JSON.stringify(summary));
    return Response.json(summary);

  } catch (err: any) {
    console.error('[adsReportPoll] Erro:', err.message);
    return Response.json({ ok: false, error: err.message });
  }
});