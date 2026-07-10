/**
 * requestAmazonAdsReportV3
 *
 * Cria ou reutiliza um job de relatório Amazon Ads v3.
 * NÃO tenta baixar o relatório — apenas solicita e registra.
 *
 * Retorna: { ok, job_id, report_id, status, next_poll_at, reused }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function adsBase(region: string): string {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

function calcIdempotencyKey(params: {
  amazon_account_id: string;
  profile_id: string;
  report_type_id: string;
  ad_product: string;
  time_unit: string;
  group_by: string[];
  columns: string[];
  filters: string;
  start_date: string;
  end_date: string;
}): string {
  const colHash = params.columns.slice().sort().join(',');
  const gbHash = params.group_by.slice().sort().join(',');
  const fHash = params.filters || 'none';
  return [
    params.report_type_id,
    params.ad_product,
    params.time_unit,
    gbHash,
    params.start_date,
    params.end_date,
    colHash,
    fHash,
  ].join('|');
}

function nextPollAt(attempt: number): string {
  // Backoff: 5, 10, 15, 30, 45+ minutos + jitter 0-120s
  const minutes = [5, 10, 15, 30, 45, 45, 45][Math.min(attempt, 6)];
  const jitter = Math.floor(Math.random() * 120);
  return new Date(Date.now() + minutes * 60000 + jitter * 1000).toISOString();
}

function mapAmazonStatus(amzStatus: string): string {
  const map: Record<string, string> = {
    PENDING: 'pending',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    FAILED: 'failed',
    FAILURE: 'failed',
    CANCELLED: 'cancelled',
  };
  return map[amzStatus] || 'pending';
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const {
      amazon_account_id,
      report_type_id = 'spCampaigns',
      ad_product = 'SPONSORED_PRODUCTS',
      time_unit = 'DAILY',
      group_by = ['campaign'],
      columns = ['campaignId', 'impressions', 'clicks', 'cost', 'purchases7d', 'purchases14d', 'purchases30d', 'sales7d', 'sales14d', 'sales30d', 'date'],
      filters = null,
      start_date,
      end_date,
      report_name = null,
      source_function = 'requestAmazonAdsReportV3',
    } = body;

    if (!amazon_account_id || !start_date || !end_date) {
      return Response.json({ ok: false, error: 'amazon_account_id, start_date e end_date são obrigatórios' }, { status: 400 });
    }

    // Carregar conta
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });

    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
    const region = account.region || Deno.env.get('ADS_REGION') || 'NA';
    const filtersStr = filters ? JSON.stringify(filters) : 'none';

    // Calcular idempotency key
    const idempotencyKey = calcIdempotencyKey({
      amazon_account_id,
      profile_id: profileId,
      report_type_id,
      ad_product,
      time_unit,
      group_by,
      columns,
      filters: filtersStr,
      start_date,
      end_date,
    });

    const now = new Date();
    const threeHoursAgo = new Date(now.getTime() - 3 * 3600000).toISOString();

    // Buscar job equivalente existente
    const existingJobs = await base44.asServiceRole.entities.AmazonAdsReportJob.filter(
      { amazon_account_id, idempotency_key: idempotencyKey },
      '-created_at',
      5
    );

    // Verificar se há job reutilizável
    const REUSABLE_STATUSES = new Set(['requested', 'pending', 'processing', 'pending_unknown', 'rate_limited', 'completed', 'downloaded', 'processed']);
    const reusable = existingJobs.find((j: any) => {
      if (!REUSABLE_STATUSES.has(j.status)) return false;
      if (['processed', 'downloaded', 'completed'].includes(j.status)) return true; // sempre reutilizar se já processado
      // Para pending/processing, só reutilizar se criado há menos de 3h
      return j.created_at && j.created_at > threeHoursAgo;
    });

    if (reusable) {
      console.log(`[requestReportV3] Reutilizando job ${reusable.id} status=${reusable.status} report_id=${reusable.report_id}`);

      // Se pending há mais de 3h, marcar como stale
      if (['pending', 'processing', 'requested', 'pending_unknown'].includes(reusable.status) && reusable.created_at <= threeHoursAgo) {
        await base44.asServiceRole.entities.AmazonAdsReportJob.update(reusable.id, {
          status: 'stale',
          updated_at: now.toISOString(),
          error_message: 'Relatório pendente há mais de 3h — marcado como stale',
        }).catch(() => {});
        console.log(`[requestReportV3] Job ${reusable.id} marcado como stale`);
        // Continuará para criar novo relatório abaixo
      } else {
        return Response.json({
          ok: true,
          reused: true,
          job_id: reusable.id,
          report_id: reusable.report_id,
          status: reusable.status,
          next_poll_at: reusable.next_poll_at,
          message: `Job reutilizado (status: ${reusable.status})`,
        });
      }
    }

    // Obter access token via tokenManager
    const tokenRes = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
      amazon_account_id,
      _service_role: true,
    });
    if (!tokenRes?.ok) {
      return Response.json({
        ok: false,
        error: tokenRes?.message || 'Falha ao obter token Amazon Ads',
        requires_reauthorization: tokenRes?.requires_reauthorization,
      });
    }
    const accessToken = tokenRes.access_token;

    // Montar payload v3
    const reportPayload: Record<string, any> = {
      name: report_name || `${report_type_id} ${start_date} to ${end_date}`,
      startDate: start_date,
      endDate: end_date,
      configuration: {
        adProduct: ad_product,
        groupBy: group_by,
        columns,
        reportTypeId: report_type_id,
        timeUnit: time_unit,
        format: 'GZIP_JSON',
      },
    };
    if (filters) reportPayload.configuration.filters = filters;

    const adsBaseUrl = adsBase(region);
    const reqStart = Date.now();

    // Chamar POST /reporting/reports
    const postRes = await fetch(`${adsBaseUrl}/reporting/reports`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Amazon-Advertising-API-ClientId': clientId,
        'Amazon-Advertising-API-Scope': profileId,
        'Content-Type': 'application/vnd.createasyncreportrequest.v3+json',
        'Accept': 'application/vnd.createasyncreportresponse.v3+json',
      },
      body: JSON.stringify(reportPayload),
    });

    const duration = Date.now() - reqStart;
    const requestId = postRes.headers.get('x-amzn-RequestId') || '';
    const rateLimitHeader = postRes.headers.get('x-amzn-RateLimit-Limit') || '';
    const retryAfterHeader = postRes.headers.get('Retry-After');

    // Log da requisição
    await base44.asServiceRole.entities.AmazonApiRequestLog.create({
      amazon_account_id,
      api_family: 'ads_v3',
      operation: 'createReport',
      method: 'POST',
      endpoint: '/reporting/reports',
      http_status: postRes.status,
      success: postRes.status === 200,
      request_id: requestId,
      rate_limit_observed: rateLimitHeader,
      retry_after: retryAfterHeader ? Number(retryAfterHeader) : null,
      duration_ms: duration,
      attempt_number: 1,
      created_at: now.toISOString(),
    }).catch(() => {});

    // Tratar HTTP 425 — relatório duplicado em andamento
    if (postRes.status === 425) {
      console.log('[requestReportV3] HTTP 425 — relatório equivalente já solicitado recentemente');

      // Buscar job mais recente com qualquer status ativo
      const anyJob = existingJobs[0];
      if (anyJob) {
        // Garantir que next_poll_at está definido
        if (!anyJob.next_poll_at) {
          await base44.asServiceRole.entities.AmazonAdsReportJob.update(anyJob.id, {
            next_poll_at: nextPollAt(anyJob.poll_attempts || 0),
            updated_at: now.toISOString(),
          }).catch(() => {});
        }
        return Response.json({
          ok: true,
          reused: true,
          status_425: true,
          job_id: anyJob.id,
          report_id: anyJob.report_id,
          status: anyJob.status,
          next_poll_at: anyJob.next_poll_at,
          message: 'Já existe um relatório equivalente em processamento. Reutilizando job existente.',
        });
      }

      // Criar job local sem report_id (não temos o id da Amazon)
      const newPollAt = new Date(Date.now() + 10 * 60000).toISOString();
      const newJob = await base44.asServiceRole.entities.AmazonAdsReportJob.create({
        amazon_account_id,
        profile_id: profileId,
        region,
        report_type_id,
        ad_product,
        time_unit,
        format: 'GZIP_JSON',
        group_by,
        columns,
        filters: filtersStr !== 'none' ? filtersStr : null,
        start_date,
        end_date,
        idempotency_key: idempotencyKey,
        status: 'pending_unknown',
        requested_at: now.toISOString(),
        next_poll_at: newPollAt,
        poll_attempts: 0,
        source_function,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      });
      return Response.json({
        ok: true,
        status_425: true,
        job_id: newJob.id,
        status: 'pending_unknown',
        next_poll_at: newPollAt,
        message: 'Relatório equivalente já foi solicitado recentemente. Aguardando conclusão.',
      });
    }

    // Tratar HTTP 429
    if (postRes.status === 429) {
      const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : 60;
      const jitter = Math.floor(Math.random() * 60);
      const cooldownUntil = new Date(Date.now() + (retryAfter + jitter) * 1000).toISOString();

      // Criar job rate_limited
      const job429 = await base44.asServiceRole.entities.AmazonAdsReportJob.create({
        amazon_account_id,
        profile_id: profileId,
        region,
        report_type_id,
        ad_product,
        time_unit,
        format: 'GZIP_JSON',
        group_by,
        columns,
        filters: filtersStr !== 'none' ? filtersStr : null,
        start_date,
        end_date,
        idempotency_key: idempotencyKey,
        status: 'rate_limited',
        requested_at: now.toISOString(),
        next_poll_at: cooldownUntil,
        cooldown_until: cooldownUntil,
        retry_after_seconds: retryAfter,
        poll_attempts: 0,
        source_function,
        error_message: `HTTP 429 ao criar relatório. Retry-After: ${retryAfter}s`,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      });

      return Response.json({
        ok: false,
        rate_limited: true,
        job_id: job429.id,
        status: 'rate_limited',
        retry_after: retryAfter,
        next_poll_at: cooldownUntil,
        message: 'A Amazon limitou temporariamente as consultas. Nova tentativa será feita automaticamente.',
      });
    }

    // Outros erros
    if (!postRes.ok) {
      const errData = await postRes.json().catch(() => ({}));
      return Response.json({
        ok: false,
        error: `HTTP ${postRes.status}: ${errData?.message || postRes.statusText}`,
        http_status: postRes.status,
      });
    }

    // Sucesso — salvar job
    const reportData = await postRes.json().catch(() => ({}));
    const reportId = reportData.reportId;
    const amzStatus = reportData.status || 'PENDING';
    const internalStatus = mapAmazonStatus(amzStatus);
    const pollAt = nextPollAt(0);

    const newJob = await base44.asServiceRole.entities.AmazonAdsReportJob.create({
      amazon_account_id,
      profile_id: profileId,
      region,
      report_id: reportId,
      report_name: reportData.name || reportPayload.name,
      report_type_id,
      ad_product,
      time_unit,
      format: 'GZIP_JSON',
      group_by,
      columns,
      filters: filtersStr !== 'none' ? filtersStr : null,
      start_date,
      end_date,
      idempotency_key: idempotencyKey,
      status: internalStatus,
      amazon_status: amzStatus,
      created_at_amazon: reportData.createdAt || now.toISOString(),
      requested_at: now.toISOString(),
      next_poll_at: pollAt,
      poll_attempts: 0,
      source_function,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });

    console.log(`[requestReportV3] ✓ Relatório criado: ${reportId} status=${internalStatus} next_poll=${pollAt}`);

    return Response.json({
      ok: true,
      reused: false,
      job_id: newJob.id,
      report_id: reportId,
      status: internalStatus,
      next_poll_at: pollAt,
      message: 'Relatório solicitado à Amazon. A geração pode levar alguns minutos. Próxima checagem programada.',
    });

  } catch (err: any) {
    console.error('[requestReportV3] Erro:', err.message);
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});