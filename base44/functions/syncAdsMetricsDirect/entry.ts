/**
 * syncAdsMetricsDirect
 * Fase 1 (se não há relatório pendente): solicita relatório diário à Amazon Ads API.
 * Fase 2 (se há relatório pendente): verifica status, baixa e processa os dados.
 * Popula CampaignMetricsDaily e AdsMetricsHistory.
 * A automação roda a cada 30 min — na primeira rodada cria o relatório,
 * nas rodadas seguintes processa quando estiver pronto.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function adsBase(region?: string): string {
  const r = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAdsToken(account: any): Promise<string> {
  const refresh = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const secret = Deno.env.get('ADS_CLIENT_SECRET') || '';
  if (!refresh) throw new Error('ADS_REFRESH_TOKEN não encontrado');
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId, client_secret: secret }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) throw new Error(data.error_description || data.error || `Token falhou HTTP ${res.status}`);
  return data.access_token;
}

async function gunzip(response: Response): Promise<any[]> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  let text = '';
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } catch {
    text = new TextDecoder().decode(bytes);
  }
  const parsed = JSON.parse(text || '[]');
  return Array.isArray(parsed) ? parsed : (parsed?.rows || parsed?.data || []);
}

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const db = base44.asServiceRole;

    const auth = await base44.auth.isAuthenticated().catch(() => false);
    if (!auth && !body._service_role) return Response.json({ error: 'Não autorizado' }, { status: 401 });

    const accounts = await db.entities.AmazonAccount.filter({ status: 'connected' });
    if (!accounts.length) return Response.json({ ok: true, message: 'Nenhuma conta conectada' });

    const results = [];

    for (const account of accounts) {
      const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
      const region = account.region || Deno.env.get('ADS_REGION') || 'NA';
      const base = adsBase(region);
      const clientId = Deno.env.get('ADS_CLIENT_ID') || '';

      let token: string;
      try { token = await getAdsToken(account); }
      catch (e: any) { results.push({ account_id: account.id, ok: false, error: `Token: ${e.message}` }); continue; }

      // --- Verificar se já há relatório pendente para esta conta ---
      const recentReports = await db.entities.AmazonReportCatalog.filter({
        amazon_account_id: account.id,
        report_key: 'daily_campaign_metrics',
      }, '-created_date', 5).catch(() => []);

      const pendingReport = recentReports.find((r: any) => r.last_status === 'PENDING' && r.report_id);

      // --- FASE 2: processar relatório pendente ---
      if (pendingReport?.report_id) {
        const CT_GET = 'application/vnd.getasyncreportresponse.v3+json';
        const statusRes = await fetch(`${base}/reporting/reports/${pendingReport.report_id}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'Amazon-Advertising-API-ClientId': clientId,
            'Amazon-Advertising-API-Scope': String(profileId),
            Accept: CT_GET,
          },
        });
        const statusData = await statusRes.json().catch(() => ({}));
        const status = String(statusData?.status || '').toUpperCase();
        console.log(`[syncDirect] fase2 report=${pendingReport.report_id} status=${status}`);

        if (status === 'COMPLETED' && statusData?.url) {
          // Baixar e processar
          const download = await fetch(statusData.url);
          if (!download.ok) throw new Error(`Download falhou HTTP ${download.status}`);
          const rows = await gunzip(download);
          console.log(`[syncDirect] rows: ${rows.length}`);

          // Carregar existentes para upsert
          const existingCmd = await db.entities.CampaignMetricsDaily.filter(
            { amazon_account_id: account.id }, '-date', 10000
          ).catch(() => []);
          const existingHist = await db.entities.AdsMetricsHistory.filter(
            { amazon_account_id: account.id }, '-date', 5000
          ).catch(() => []);

          const cmdMap = new Map<string, any>();
          for (const r of existingCmd) {
            const k = `${r.campaign_id}-${String(r.date).slice(0, 10)}`;
            if (!cmdMap.has(k)) cmdMap.set(k, r);
          }
          const histMap = new Map<string, any>();
          for (const r of existingHist) {
            const k = `${r.campaign_id}-${String(r.date).slice(0, 10)}`;
            if (!histMap.has(k)) histMap.set(k, r);
          }

          const toCreateCmd: any[] = [], toUpdateCmd: any[] = [];
          const toCreateHist: any[] = [], toUpdateHist: any[] = [];
          const seen = new Set<string>();
          const now = new Date().toISOString();

          for (const row of rows) {
            const campaignId = String(row.campaignId || row.campaign_id || '');
            const date = String(row.date || row.startDate || '').slice(0, 10);
            if (!campaignId || !date) continue;
            const key = `${campaignId}-${date}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const spend = num(row.cost ?? row.spend);
            const sales = num(row.sales30d ?? row.sales);
            const orders = num(row.purchases30d ?? row.orders);
            const clicks = num(row.clicks);
            const impressions = num(row.impressions);

            const cmdRec = {
              amazon_account_id: account.id, campaign_id: campaignId, date,
              impressions, clicks, spend, sales, orders,
              acos: spend > 0 && sales > 0 ? (spend / sales) * 100 : 0,
              roas: spend > 0 && sales > 0 ? sales / spend : 0,
              ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
              cpc: clicks > 0 ? spend / clicks : 0,
              source: 'amazon_ads_api', synced_at: now,
            };
            const histRec = {
              amazon_account_id: account.id, campaign_id: campaignId,
              campaign_name: row.campaignName || null, date,
              impressions, clicks, spend,
              sales_30d: sales, orders_30d: orders,
              report_type: 'campaigns', synced_at: now,
            };

            const curCmd = cmdMap.get(key);
            curCmd ? toUpdateCmd.push({ id: curCmd.id, ...cmdRec }) : toCreateCmd.push(cmdRec);
            const curHist = histMap.get(key);
            curHist ? toUpdateHist.push({ id: curHist.id, ...histRec }) : toCreateHist.push(histRec);
          }

          const BATCH = 100;
          for (let i = 0; i < toCreateCmd.length; i += BATCH)
            await db.entities.CampaignMetricsDaily.bulkCreate(toCreateCmd.slice(i, i + BATCH));
          for (let i = 0; i < toUpdateCmd.length; i += BATCH)
            await db.entities.CampaignMetricsDaily.bulkUpdate(toUpdateCmd.slice(i, i + BATCH));
          for (let i = 0; i < toCreateHist.length; i += BATCH)
            await db.entities.AdsMetricsHistory.bulkCreate(toCreateHist.slice(i, i + BATCH));
          for (let i = 0; i < toUpdateHist.length; i += BATCH)
            await db.entities.AdsMetricsHistory.bulkUpdate(toUpdateHist.slice(i, i + BATCH));

          // Marcar relatório como processado
          await db.entities.AmazonReportCatalog.update(pendingReport.id, {
            last_status: 'PROCESSED', last_processed_at: now, record_count_last: rows.length,
          }).catch(() => {});
          await db.entities.AmazonAccount.update(account.id, { last_sync_at: now }).catch(() => {});
          await db.entities.SyncExecutionLog.create({
            amazon_account_id: account.id, operation: 'sync_ads_metrics_direct',
            status: 'success', trigger_type: body.trigger_type || 'scheduled',
            started_at: startedAt, completed_at: now, records_processed: seen.size,
            result_summary: JSON.stringify({ rows: rows.length, cmd_created: toCreateCmd.length, cmd_updated: toUpdateCmd.length }).slice(0, 2000),
          }).catch(() => {});

          results.push({ account_id: account.id, ok: true, phase: 'processed', rows: rows.length, cmd_created: toCreateCmd.length, cmd_updated: toUpdateCmd.length, hist_created: toCreateHist.length });
          continue;

        } else if (['FAILURE', 'FAILED', 'CANCELLED'].includes(status)) {
          await db.entities.AmazonReportCatalog.update(pendingReport.id, { last_status: 'FAILED', last_error: statusData?.failureReason || status }).catch(() => {});
          // Vai cair na fase 1 para criar novo relatório
        } else if (status === 'IN_PROGRESS' || status === 'PENDING') {
          results.push({ account_id: account.id, ok: true, phase: 'waiting', report_id: pendingReport.report_id, status });
          continue;
        }
      }

      // --- FASE 1: detectar lacunas e solicitar novo relatório ---
      const today = new Date();
      const yesterday = new Date(today.getTime() - 86400000);
      const windowStart = new Date(today.getTime() - 14 * 86400000);

      const existing = await db.entities.CampaignMetricsDaily.filter(
        { amazon_account_id: account.id }, '-date', 5000
      ).catch(() => []);

      const presentDates = new Set(existing.map((r: any) => String(r.date || '').slice(0, 10)));
      const missingDates: string[] = [];
      const cursor = new Date(windowStart);
      while (cursor <= yesterday) {
        const d = ymd(cursor);
        if (!presentDates.has(d)) missingDates.push(d);
        cursor.setDate(cursor.getDate() + 1);
      }

      if (!missingDates.length) {
        results.push({ account_id: account.id, ok: true, phase: 'up_to_date', message: 'Sem lacunas nos últimos 14 dias' });
        continue;
      }

      const startDate = missingDates[0];
      const endDate = missingDates[missingDates.length - 1];
      console.log(`[syncDirect] fase1 solicitando relatório ${startDate}→${endDate} (${missingDates.length} dias)`);

      const CT_CREATE = 'application/vnd.createasyncreportrequest.v3+json';
      const createRes = await fetch(`${base}/reporting/reports`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Amazon-Advertising-API-ClientId': clientId,
          'Amazon-Advertising-API-Scope': String(profileId),
          'Content-Type': CT_CREATE,
          Accept: CT_CREATE,
        },
        body: JSON.stringify({
          name: `LivingFinds metrics ${startDate} to ${endDate}`,
          startDate,
          endDate,
          configuration: {
            adProduct: 'SPONSORED_PRODUCTS',
            groupBy: ['campaign'],
            columns: ['date', 'campaignId', 'campaignName', 'campaignStatus', 'campaignBudgetAmount', 'impressions', 'clicks', 'cost', 'purchases30d', 'sales30d'],
            reportTypeId: 'spCampaigns',
            timeUnit: 'DAILY',
            format: 'GZIP_JSON',
          },
        }),
      });

      const createData = await createRes.json().catch(() => ({}));
      const reportId = createData?.reportId;
      if (!reportId) {
        const err = createData?.details?.[0]?.message || createData?.message || `HTTP ${createRes.status}`;
        results.push({ account_id: account.id, ok: false, error: `Relatório não criado: ${err}` });
        continue;
      }

      // Salvar na AmazonReportCatalog para o próximo ciclo processar
      const catalogEntry: any = {
        amazon_account_id: account.id,
        report_key: 'daily_campaign_metrics',
        report_type_id: 'spCampaigns',
        report_id: reportId,
        last_status: 'PENDING',
        last_requested_at: new Date().toISOString(),
        api_family: 'ads_v3',
        ad_product: 'SPONSORED_PRODUCTS',
        time_unit: 'DAILY',
        notes: `${startDate} → ${endDate}`,
      };

      // Upsert no catálogo
      const existingCatalog = await db.entities.AmazonReportCatalog.filter({
        amazon_account_id: account.id, report_key: 'daily_campaign_metrics',
      }, '-created_date', 1).catch(() => []);

      if (existingCatalog[0]) {
        await db.entities.AmazonReportCatalog.update(existingCatalog[0].id, catalogEntry).catch(() => {});
      } else {
        await db.entities.AmazonReportCatalog.create(catalogEntry).catch(() => {});
      }

      results.push({ account_id: account.id, ok: true, phase: 'requested', report_id: reportId, missing_days: missingDates.length, start_date: startDate, end_date: endDate });
    }

    return Response.json({ ok: true, results });
  } catch (error: any) {
    console.error('[syncAdsMetricsDirect]', error?.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});