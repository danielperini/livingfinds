/**
 * backfillCampaignMetricsFromReports
 * Busca métricas de campanha diretamente via Amazon Ads Reporting API v3
 * para preencher lacunas no CampaignMetricsDaily.
 * Detecta automaticamente quais datas estão faltando e faz backfill.
 * Roda como automação diária no backend.
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

async function getAdsToken(account: any): Promise<string> {
  const refresh = Deno.env.get('ADS_REFRESH_TOKEN') || account.ads_refresh_token;
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const secret = Deno.env.get('ADS_CLIENT_SECRET') || '';
  if (!refresh || !clientId || !secret) throw new Error('Credenciais Ads incompletas');
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId, client_secret: secret }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) throw new Error(data.error_description || `Token falhou HTTP ${res.status}`);
  return data.access_token;
}

function adsBase(region?: string): string {
  const r = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
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
  return Array.isArray(parsed) ? parsed : parsed?.rows || parsed?.data || [];
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Aceita chamada autenticada ou service role (automação)
    const auth = await base44.auth.isAuthenticated().catch(() => false);
    if (!auth && !body._service_role) return Response.json({ error: 'Não autorizado' }, { status: 401 });

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });
    if (!accounts.length) return Response.json({ ok: true, message: 'Nenhuma conta conectada' });

    const results = [];

    for (const account of accounts) {
      const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
      const base = adsBase(account.region);
      const clientId = Deno.env.get('ADS_CLIENT_ID') || '';

      // Detectar quais datas estão faltando (últimos 62 dias — cobre mês atual + mês anterior completo)
      const today = new Date();
      const thirtyDaysAgo = new Date(today.getTime() - 62 * 86400000);

      // Pegar datas já presentes no banco
      const existing = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
        { amazon_account_id: account.id }, '-date', 5000
      ).catch(() => []);

      const presentDates = new Set(existing.map((r: any) => String(r.date || '').slice(0, 10)));

      // Calcular datas faltando (excluir hoje — dados incompletos)
      const yesterday = new Date(today.getTime() - 86400000);
      const missingDates: string[] = [];
      const cursor = new Date(thirtyDaysAgo);
      while (cursor <= yesterday) {
        const d = ymd(cursor);
        if (!presentDates.has(d)) missingDates.push(d);
        cursor.setDate(cursor.getDate() + 1);
      }

      if (!missingDates.length) {
        results.push({ account_id: account.id, ok: true, message: 'Sem lacunas — tudo atualizado', missing: 0 });
        continue;
      }

      console.log(`[backfill] account=${account.id} missing=${missingDates.length} dates: ${missingDates.join(', ')}`);

      // Obter token Ads
      let token: string;
      try {
        token = await getAdsToken(account);
      } catch (e: any) {
        results.push({ account_id: account.id, ok: false, error: `Token: ${e.message}`, missing: missingDates.length });
        continue;
      }

      // Solicitar relatório cobrindo todas as datas faltando de uma vez
      const startDate = missingDates[0];
      const endDate = missingDates[missingDates.length - 1];

      const CT = 'application/vnd.createasyncreportrequest.v3+json';
      const createRes = await fetch(`${base}/reporting/reports`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Amazon-Advertising-API-ClientId': clientId,
          'Amazon-Advertising-API-Scope': String(profileId),
          'Content-Type': CT,
          'Accept': CT,
        },
        body: JSON.stringify({
          name: `LivingFinds backfill ${startDate} to ${endDate}`,
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
        const errMsg = createData?.details?.[0]?.message || createData?.message || `HTTP ${createRes.status}`;
        results.push({ account_id: account.id, ok: false, error: `Relatório não criado: ${errMsg}`, missing: missingDates.length });
        continue;
      }

      // Polling — aguardar relatório ficar pronto (até ~2 min)
      const ACCEPT = 'application/vnd.getasyncreportresponse.v3+json';
      let reportPayload: any = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        if (attempt > 0) await wait(12000);
        const statusRes = await fetch(`${base}/reporting/reports/${reportId}`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Amazon-Advertising-API-ClientId': clientId,
            'Amazon-Advertising-API-Scope': String(profileId),
            'Accept': ACCEPT,
          },
        });
        const statusData = await statusRes.json().catch(() => ({}));
        const status = String(statusData?.status || '').toUpperCase();
        if (status === 'COMPLETED') { reportPayload = statusData; break; }
        if (['FAILURE', 'FAILED', 'CANCELLED'].includes(status)) {
          throw new Error(statusData?.failureReason || `Relatório terminou como ${status}`);
        }
      }

      if (!reportPayload?.url) {
        results.push({ account_id: account.id, ok: false, error: 'Relatório não ficou pronto no tempo limite', report_id: reportId, missing: missingDates.length });
        continue;
      }

      // Baixar e processar
      const download = await fetch(reportPayload.url);
      if (!download.ok) throw new Error(`Download falhou: HTTP ${download.status}`);
      const rows = await gunzip(download);

      // Upsert no CampaignMetricsDaily
      const existingByKey = new Map<string, any>();
      for (const row of existing) {
        const key = `${String(row.campaign_id || '')}-${String(row.date || '').slice(0, 10)}`;
        if (!existingByKey.has(key)) existingByKey.set(key, row);
      }

      const toCreate: any[] = [];
      const toUpdate: any[] = [];
      const seen = new Set<string>();
      const now = new Date().toISOString();

      for (const row of rows) {
        const campaignId = String(row.campaignId || row.campaign_id || '');
        const date = String(row.date || row.startDate || '').slice(0, 10);
        if (!campaignId || !date) continue;
        const key = `${campaignId}-${date}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const record: any = {
          amazon_account_id: account.id,
          campaign_id: campaignId,
          campaign_name: row.campaignName || null,
          date,
          spend: num(row.cost ?? row.spend),
          sales: num(row.sales30d ?? row.sales),
          orders: num(row.purchases30d ?? row.orders),
          clicks: num(row.clicks),
          impressions: num(row.impressions),
          daily_budget: num(row.campaignBudgetAmount),
          campaign_status: String(row.campaignStatus || '').toLowerCase() || null,
          acos: num(row.cost) > 0 && num(row.sales30d ?? row.sales) > 0
            ? (num(row.cost) / num(row.sales30d ?? row.sales)) * 100 : 0,
          cpc: num(row.clicks) > 0 ? num(row.cost) / num(row.clicks) : 0,
          ctr: num(row.impressions) > 0 ? (num(row.clicks) / num(row.impressions)) * 100 : 0,
          source: 'amazon_ads_api',
          synced_at: now,
        };

        const cur = existingByKey.get(key);
        cur ? toUpdate.push({ id: cur.id, ...record }) : toCreate.push(record);
      }

      const BATCH = 100;
      for (let i = 0; i < toCreate.length; i += BATCH) {
        await base44.asServiceRole.entities.CampaignMetricsDaily.bulkCreate(toCreate.slice(i, i + BATCH));
      }
      for (let i = 0; i < toUpdate.length; i += BATCH) {
        await base44.asServiceRole.entities.CampaignMetricsDaily.bulkUpdate(toUpdate.slice(i, i + BATCH));
      }

      // Atualizar last_sync_at da conta
      await base44.asServiceRole.entities.AmazonAccount.update(account.id, { last_sync_at: now }).catch(() => {});

      results.push({
        account_id: account.id,
        ok: true,
        missing_dates: missingDates.length,
        rows_received: rows.length,
        created: toCreate.length,
        updated: toUpdate.length,
        start_date: startDate,
        end_date: endDate,
      });
    }

    return Response.json({ ok: true, results });
  } catch (error: any) {
    console.error('[backfillCampaignMetrics]', error?.message);
    return Response.json({ error: error.message }, { status: 500 });
  }
});