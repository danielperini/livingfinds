import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

/**
 * Pipeline assíncrono de métricas intradiárias de Sponsored Products.
 *
 * Cada execução avança exatamente uma etapa:
 * request -> poll -> download -> persist
 *
 * Não há polling bloqueante. Os snapshots persistidos são cumulativos do dia por
 * campanha e constituem a única fonte autorizada para o pacing intradiário.
 */

const MIN_NEW_REPORT_INTERVAL_MINUTES = 150;
const MAX_ATTEMPTS = 3;
const r2 = (value: number) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function brtClock(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return {
    iso: now.toISOString(),
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour') || 0) % 24,
    minute: Number(get('minute') || 0),
  };
}

function adsBase(region: any) {
  const value = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (value.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (value.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

function safeJson(text: string) {
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 1000) }; }
}

function retryAfterIso(response: Response, fallbackMinutes = 15) {
  const raw = response.headers.get('retry-after');
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return new Date(Date.now() + seconds * 1000).toISOString();
  if (raw) {
    const parsed = new Date(raw).getTime();
    if (Number.isFinite(parsed) && parsed > Date.now()) return new Date(parsed).toISOString();
  }
  return new Date(Date.now() + fallbackMinutes * 60_000).toISOString();
}

async function token(base44: any, accountId: string) {
  const response = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
    amazon_account_id: accountId,
    triggered_by: 'syncAmazonIntradayCampaignMetrics',
    _service_role: true,
  });
  const data = response?.data || response || {};
  if (data?.ok !== true || !data?.access_token) {
    throw new Error(data?.message || data?.error || 'Não foi possível obter access token Amazon Ads');
  }
  return String(data.access_token);
}

function headers(accessToken: string, profileId: string, contentType?: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Amazon-Advertising-API-ClientId': String(Deno.env.get('ADS_CLIENT_ID') || ''),
    'Amazon-Advertising-API-Scope': profileId,
    Accept: 'application/json',
    ...(contentType ? { 'Content-Type': contentType } : {}),
  };
}

async function decodeReport(buffer: ArrayBuffer, contentEncoding = '') {
  const bytes = new Uint8Array(buffer);
  const isGzip = contentEncoding.toLowerCase().includes('gzip') || (bytes[0] === 0x1f && bytes[1] === 0x8b);
  if (!isGzip) return safeJson(new TextDecoder().decode(bytes));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const decoded = await new Response(stream).text();
  return safeJson(decoded);
}

function reportRows(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function reportStatus(payload: any) {
  return String(payload?.status || payload?.processingStatus || '').toUpperCase();
}

function reportUrl(payload: any) {
  return String(payload?.url || payload?.location || payload?.downloadUrl || '');
}

function jobReadyForRetry(job: any) {
  if (!job?.next_retry_at) return true;
  return new Date(job.next_retry_at).getTime() <= Date.now();
}

async function log(base44: any, data: any) {
  await base44.asServiceRole.entities.SyncExecutionLog.create({
    amazon_account_id: data.accountId,
    operation: `intraday_ads_report:${data.stage}`,
    trigger_type: data.trigger || 'scheduler',
    status: data.status,
    started_at: data.startedAt,
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - new Date(data.startedAt).getTime(),
    records_processed: Number(data.records || 0),
    result_summary: JSON.stringify(data.summary || {}).slice(0, 4000),
    error_message: data.error ? String(data.error).slice(0, 1000) : null,
  }).catch(() => {});
}

async function updateJobFailure(base44: any, job: any, error: any, stage: string, statusCode = 0, nextRetryAt: string | null = null) {
  const attempts = Number(job?.attempts || 0) + 1;
  const terminal = attempts >= MAX_ATTEMPTS;
  const status = terminal ? 'failed' : statusCode === 429 ? 'rate_limited' : job?.status || 'requested';
  await base44.asServiceRole.entities.IntradayReportJob.update(job.id, {
    status,
    stage,
    attempts,
    last_http_status: statusCode || null,
    last_error: String(error?.message || error || 'Falha').slice(0, 1000),
    next_retry_at: terminal ? null : nextRetryAt || new Date(Date.now() + Math.min(60, 5 * Math.pow(2, attempts - 1)) * 60_000).toISOString(),
    updated_at: new Date().toISOString(),
  }).catch(() => {});
  return { ok: false, status, attempts, retryable: !terminal, next_retry_at: terminal ? null : nextRetryAt };
}

async function latestJob(base44: any, accountId: string, date: string) {
  const jobs = await base44.asServiceRole.entities.IntradayReportJob.filter(
    { amazon_account_id: accountId, report_date: date },
    '-created_at',
    20,
  ).catch(() => []);
  const active = jobs.find((job: any) => ['requested', 'polling', 'ready', 'downloaded', 'rate_limited'].includes(String(job?.status || '')));
  return { active: active || null, jobs };
}

async function requestStage(base44: any, account: any, clock: ReturnType<typeof brtClock>, trigger: string) {
  const accountId = String(account.id);
  const profileId = String(account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '');
  if (!profileId) return { ok: false, stage: 'request', error: 'ads_profile_id não configurado' };

  const accessToken = await token(base44, accountId);
  const requestBody = {
    name: `LivingFinds intraday SP campaigns ${clock.date} ${clock.hour}:${String(clock.minute).padStart(2, '0')}`,
    startDate: clock.date,
    endDate: clock.date,
    configuration: {
      adProduct: 'SPONSORED_PRODUCTS',
      groupBy: ['campaign'],
      columns: [
        'date', 'campaignId', 'campaignName', 'campaignStatus', 'campaignBudgetAmount',
        'impressions', 'clicks', 'cost', 'purchases14d', 'sales14d',
      ],
      reportTypeId: 'spCampaigns',
      timeUnit: 'DAILY',
      format: 'GZIP_JSON',
    },
  };

  const response = await fetch(`${adsBase(account.region)}/reporting/reports`, {
    method: 'POST',
    headers: headers(accessToken, profileId, 'application/vnd.createasyncreportrequest.v3+json'),
    body: JSON.stringify(requestBody),
  });
  const text = await response.text();
  const data = safeJson(text);
  const requestId = response.headers.get('amazon-request-id') || response.headers.get('x-amzn-requestid') || '';

  if (!response.ok && response.status === 425) {
    const duplicateReportId = JSON.stringify(data).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] || '';
    if (duplicateReportId) {
      const existing = await base44.asServiceRole.entities.IntradayReportJob.filter(
        { amazon_account_id: accountId, report_id: duplicateReportId }, '-created_at', 1,
      ).catch(() => []);
      if (existing[0]) return { ok: true, stage: 'request', report_id: duplicateReportId, job_id: existing[0].id, status: existing[0].status, duplicate: true };
      const duplicateJob = await base44.asServiceRole.entities.IntradayReportJob.create({
        amazon_account_id: accountId,
        ads_profile_id: profileId,
        marketplace_id: account.marketplace_id || account.marketplace || null,
        report_date: clock.date,
        report_type: 'spCampaigns',
        report_id: duplicateReportId,
        status: 'requested',
        stage: 'request',
        attempts: 0,
        amazon_request_id: requestId || null,
        request_payload: requestBody,
        requested_at: clock.iso,
        next_retry_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        created_at: clock.iso,
        updated_at: clock.iso,
      });
      return { ok: true, stage: 'request', report_id: duplicateReportId, job_id: duplicateJob.id, status: 'requested', duplicate: true };
    }
  }

  if (!response.ok) {
    const retryable = response.status === 429 || [500, 502, 503, 504, 524].includes(response.status);
    const pseudoJob = await base44.asServiceRole.entities.IntradayReportJob.create({
      amazon_account_id: accountId,
      ads_profile_id: profileId,
      marketplace_id: account.marketplace_id || account.marketplace || null,
      report_date: clock.date,
      report_type: 'spCampaigns',
      status: response.status === 429 ? 'rate_limited' : 'failed',
      stage: 'request',
      attempts: 1,
      last_http_status: response.status,
      amazon_request_id: requestId || null,
      last_error: JSON.stringify(data).slice(0, 1000),
      next_retry_at: retryable ? (response.status === 429 ? retryAfterIso(response) : new Date(Date.now() + 15 * 60_000).toISOString()) : null,
      created_at: clock.iso,
      updated_at: clock.iso,
    });
    await log(base44, { accountId, stage: 'request', trigger, status: 'error', startedAt: clock.iso, error: pseudoJob.last_error, summary: { http_status: response.status, request_id: requestId, retryable } });
    return { ok: false, stage: 'request', status: response.status, error: pseudoJob.last_error, retryable };
  }

  const reportId = String(data?.reportId || data?.report_id || '');
  if (!reportId) return { ok: false, stage: 'request', error: 'Amazon não retornou reportId' };
  const job = await base44.asServiceRole.entities.IntradayReportJob.create({
    amazon_account_id: accountId,
    ads_profile_id: profileId,
    marketplace_id: account.marketplace_id || account.marketplace || null,
    report_date: clock.date,
    report_type: 'spCampaigns',
    report_id: reportId,
    status: 'requested',
    stage: 'request',
    attempts: 0,
    amazon_request_id: requestId || null,
    request_payload: requestBody,
    requested_at: clock.iso,
    next_retry_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    created_at: clock.iso,
    updated_at: clock.iso,
  });
  await log(base44, { accountId, stage: 'request', trigger, status: 'success', startedAt: clock.iso, records: 1, summary: { report_id: reportId, job_id: job.id, request_id: requestId } });
  return { ok: true, stage: 'request', report_id: reportId, job_id: job.id, status: 'requested' };
}

async function pollStage(base44: any, account: any, job: any, clock: ReturnType<typeof brtClock>, trigger: string) {
  if (!jobReadyForRetry(job)) return { ok: true, stage: 'poll', skipped: true, reason: 'Aguardando próxima tentativa', next_retry_at: job.next_retry_at };
  const accountId = String(account.id);
  const profileId = String(job.ads_profile_id || account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '');
  const accessToken = await token(base44, accountId);
  const response = await fetch(`${adsBase(account.region)}/reporting/reports/${encodeURIComponent(String(job.report_id))}`, {
    headers: headers(accessToken, profileId),
  });
  const text = await response.text();
  const data = safeJson(text);
  const requestId = response.headers.get('amazon-request-id') || response.headers.get('x-amzn-requestid') || '';
  if (!response.ok) {
    const result = await updateJobFailure(base44, job, JSON.stringify(data), 'poll', response.status, response.status === 429 ? retryAfterIso(response) : null);
    await log(base44, { accountId, stage: 'poll', trigger, status: 'error', startedAt: clock.iso, error: JSON.stringify(data), summary: { report_id: job.report_id, http_status: response.status, request_id: requestId } });
    return { ...result, stage: 'poll', report_id: job.report_id };
  }

  const status = reportStatus(data);
  if (['COMPLETED', 'SUCCESS', 'DONE'].includes(status)) {
    const url = reportUrl(data);
    if (!url) return await updateJobFailure(base44, job, 'Relatório concluído sem URL', 'poll', 502);
    await base44.asServiceRole.entities.IntradayReportJob.update(job.id, {
      status: 'ready',
      stage: 'poll',
      download_url: url,
      amazon_request_id: requestId || job.amazon_request_id || null,
      last_http_status: response.status,
      last_error: null,
      next_retry_at: null,
      polled_at: clock.iso,
      ready_at: clock.iso,
      updated_at: clock.iso,
    });
    await log(base44, { accountId, stage: 'poll', trigger, status: 'success', startedAt: clock.iso, records: 1, summary: { report_id: job.report_id, amazon_status: status, ready: true } });
    return { ok: true, stage: 'poll', status: 'ready', report_id: job.report_id };
  }

  if (['FAILURE', 'FAILED', 'CANCELLED'].includes(status)) {
    await base44.asServiceRole.entities.IntradayReportJob.update(job.id, {
      status: 'failed',
      stage: 'poll',
      last_error: `Amazon report status ${status}`,
      last_http_status: response.status,
      polled_at: clock.iso,
      updated_at: clock.iso,
    });
    await log(base44, { accountId, stage: 'poll', trigger, status: 'error', startedAt: clock.iso, error: `Amazon report status ${status}`, summary: { report_id: job.report_id } });
    return { ok: false, stage: 'poll', status: 'failed', report_id: job.report_id, error: `Amazon report status ${status}` };
  }

  await base44.asServiceRole.entities.IntradayReportJob.update(job.id, {
    status: 'polling',
    stage: 'poll',
    polled_at: clock.iso,
    next_retry_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    last_http_status: response.status,
    amazon_request_id: requestId || job.amazon_request_id || null,
    updated_at: clock.iso,
  });
  return { ok: true, stage: 'poll', status: 'polling', amazon_status: status || 'PENDING', report_id: job.report_id };
}

async function downloadStage(base44: any, account: any, job: any, clock: ReturnType<typeof brtClock>, trigger: string) {
  if (!job.download_url) return await updateJobFailure(base44, job, 'download_url ausente', 'download', 400);
  const response = await fetch(String(job.download_url));
  if (!response.ok) {
    const result = await updateJobFailure(base44, job, `Download HTTP ${response.status}`, 'download', response.status, response.status === 429 ? retryAfterIso(response) : null);
    await log(base44, { accountId: account.id, stage: 'download', trigger, status: 'error', startedAt: clock.iso, error: `HTTP ${response.status}`, summary: { report_id: job.report_id } });
    return { ...result, stage: 'download', report_id: job.report_id };
  }
  const payload = await decodeReport(await response.arrayBuffer(), response.headers.get('content-encoding') || '');
  const rows = reportRows(payload);
  await base44.asServiceRole.entities.IntradayReportJob.update(job.id, {
    status: 'downloaded',
    stage: 'download',
    raw_payload: rows,
    row_count: rows.length,
    downloaded_at: clock.iso,
    last_error: null,
    updated_at: clock.iso,
  });
  await log(base44, { accountId: account.id, stage: 'download', trigger, status: 'success', startedAt: clock.iso, records: rows.length, summary: { report_id: job.report_id, rows: rows.length } });
  return { ok: true, stage: 'download', status: 'downloaded', rows: rows.length, report_id: job.report_id };
}

async function persistStage(base44: any, account: any, job: any, clock: ReturnType<typeof brtClock>, trigger: string) {
  const rows = reportRows(job.raw_payload || []);
  const existing = await base44.asServiceRole.entities.IntradaySpendSnapshot.filter(
    { amazon_account_id: account.id, report_id: String(job.report_id) }, null, 5,
  ).catch(() => []);
  if (existing.length > 0) {
    await base44.asServiceRole.entities.IntradayReportJob.update(job.id, {
      status: 'persisted',
      stage: 'persist',
      persisted_at: clock.iso,
      records_persisted: existing.length,
      raw_payload: null,
      updated_at: clock.iso,
    });
    return { ok: true, stage: 'persist', status: 'persisted', idempotent: true, report_id: job.report_id, records: existing.length };
  }

  const snapshots = rows.map((row: any) => {
    const campaignId = String(row?.campaignId || row?.campaign_id || '');
    const spend = Number(row?.cost ?? row?.spend ?? 0);
    const sales = Number(row?.sales14d ?? row?.sales_14d ?? row?.sales ?? 0);
    const orders = Number(row?.purchases14d ?? row?.orders_14d ?? row?.orders ?? 0);
    const clicks = Number(row?.clicks || 0);
    const impressions = Number(row?.impressions || 0);
    return {
      amazon_account_id: account.id,
      ads_profile_id: job.ads_profile_id || account.ads_profile_id || null,
      marketplace_id: job.marketplace_id || account.marketplace_id || account.marketplace || null,
      campaign_id: campaignId,
      campaign_name: String(row?.campaignName || row?.campaign_name || ''),
      campaign_status: String(row?.campaignStatus || row?.campaign_status || ''),
      campaign_budget: Number(row?.campaignBudgetAmount ?? row?.campaign_budget ?? 0),
      spend_date: clock.date,
      report_id: String(job.report_id),
      snapshot_batch_id: String(job.id),
      snapshot_kind: 'campaign_cumulative_day',
      aggregation_mode: 'cumulative',
      impressions,
      clicks,
      spend: r2(spend),
      sales: r2(sales),
      orders,
      acos: sales > 0 ? r2((spend / sales) * 100) : null,
      roas: spend > 0 ? r2(sales / spend) : 0,
      source: 'AMAZON_ADS_SAME_DAY_REPORT',
      source_event_id: `${job.report_id}:${campaignId}`,
      idempotency_key: `${account.id}|${clock.date}|${job.report_id}|${campaignId}`,
      observed_at: clock.iso,
      created_at: clock.iso,
    };
  }).filter((row: any) => row.campaign_id);

  if (snapshots.length) await base44.asServiceRole.entities.IntradaySpendSnapshot.bulkCreate(snapshots);

  // Atualiza somente métricas do dia; o histórico agregado de 30 dias é preservado.
  const campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: account.id }, null, 3000).catch(() => []);
  const campaignMap = new Map<string, any>(campaigns.map((campaign: any) => [String(campaign.amazon_campaign_id || campaign.campaign_id || ''), campaign]));
  const updates = snapshots
    .map((snapshot: any) => {
      const campaign = campaignMap.get(snapshot.campaign_id);
      if (!campaign?.id) return null;
      return {
        id: campaign.id,
        current_spend: snapshot.spend,
        current_day_sales: snapshot.sales,
        current_day_orders: snapshot.orders,
        current_day_clicks: snapshot.clicks,
        current_day_impressions: snapshot.impressions,
        current_day_metrics_at: clock.iso,
      };
    })
    .filter(Boolean);
  if (updates.length) await base44.asServiceRole.entities.Campaign.bulkUpdate(updates).catch(() => {});

  await base44.asServiceRole.entities.IntradayReportJob.update(job.id, {
    status: 'persisted',
    stage: 'persist',
    persisted_at: clock.iso,
    records_persisted: snapshots.length,
    raw_payload: null,
    last_error: null,
    updated_at: clock.iso,
  });
  await log(base44, { accountId: account.id, stage: 'persist', trigger, status: 'success', startedAt: clock.iso, records: snapshots.length, summary: { report_id: job.report_id, snapshots: snapshots.length, campaigns_updated: updates.length } });
  return { ok: true, stage: 'persist', status: 'persisted', report_id: job.report_id, records: snapshots.length, campaigns_updated: updates.length };
}

async function runForAccount(base44: any, account: any, body: any) {
  const clock = brtClock();
  const trigger = String(body.trigger_type || (body._service_role ? 'scheduler' : 'manual'));
  const { active, jobs } = await latestJob(base44, account.id, clock.date);
  const requestedAction = String(body.action || 'auto').toLowerCase();
  const lastPersisted = jobs.find((job: any) => job.status === 'persisted' && job.persisted_at);
  const minutesSinceLastPersist = lastPersisted
    ? (Date.now() - new Date(lastPersisted.persisted_at).getTime()) / 60_000
    : Infinity;

  let action = requestedAction;
  if (action === 'auto') {
    if (active) {
      if (['requested', 'polling', 'rate_limited'].includes(active.status)) action = 'poll';
      else if (active.status === 'ready') action = 'download';
      else if (active.status === 'downloaded') action = 'persist';
    } else if (minutesSinceLastPersist >= Number(body.min_new_report_interval_minutes || MIN_NEW_REPORT_INTERVAL_MINUTES)) {
      action = 'request';
    } else {
      return {
        ok: true,
        skipped: true,
        reason: 'Snapshot intradiário recente ainda válido',
        last_persisted_at: lastPersisted?.persisted_at || null,
        age_minutes: r2(minutesSinceLastPersist),
        next_request_in_minutes: r2(Math.max(0, MIN_NEW_REPORT_INTERVAL_MINUTES - minutesSinceLastPersist)),
      };
    }
  }

  if (action === 'request') return await requestStage(base44, account, clock, trigger);
  const job = body.job_id
    ? (await base44.asServiceRole.entities.IntradayReportJob.filter({ id: body.job_id }, null, 1).catch(() => []))[0]
    : active;
  if (!job) return { ok: false, error: `Nenhum job disponível para action=${action}` };
  if (action === 'poll') return await pollStage(base44, account, job, clock, trigger);
  if (action === 'download') return await downloadStage(base44, account, job, clock, trigger);
  if (action === 'persist') return await persistStage(base44, account, job, clock, trigger);
  return { ok: false, error: `Ação inválida: ${action}` };
}

Deno.serve(async (request) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 20);
    if (!accounts.length) return Response.json({ ok: false, error: 'Nenhuma AmazonAccount conectada' }, { status: 404 });

    const results = [];
    for (const account of accounts) {
      results.push({ amazon_account_id: account.id, ...(await runForAccount(base44, account, body)) });
      await wait(250);
    }
    return Response.json({
      ok: results.every((result: any) => result.ok !== false),
      pipeline: 'intraday-sp-campaign-report-v1',
      accounts_processed: results.length,
      results,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error: any) {
    return Response.json({
      ok: false,
      pipeline: 'intraday-sp-campaign-report-v1',
      error: error?.message || 'Falha no pipeline intradiário Amazon Ads',
      duration_ms: Date.now() - startedAt,
    }, { status: 500 });
  }
});
