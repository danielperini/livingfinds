/**
 * pollAmazonAdsReportJobs
 *
 * Busca jobs com next_poll_at <= now e consulta status na Amazon.
 * Se COMPLETED, enfileira download via downloadAndProcessAmazonAdsReportJob.
 * Máximo de 5 jobs por execução.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function adsBase(region: string): string {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

function nextPollAt(attempt: number, retryAfterSeconds?: number): string {
  if (retryAfterSeconds) {
    const jitter = Math.floor(Math.random() * 60);
    return new Date(Date.now() + (retryAfterSeconds + jitter) * 1000).toISOString();
  }
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
    const maxJobs = body.max_jobs || 5;

    const now = new Date();
    const nowIso = now.toISOString();
    const threeHoursAgo = new Date(now.getTime() - 3 * 3600000).toISOString();
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60000).toISOString();

    // Buscar jobs elegíveis: next_poll_at <= now e status ativo
    const POLLABLE_STATUSES = ['requested', 'pending', 'processing', 'rate_limited', 'pending_unknown'];

    // Buscar todos os jobs com status pollable
    const allJobs = await base44.asServiceRole.entities.AmazonAdsReportJob.filter(
      {},
      'next_poll_at',
      50
    );

    const eligibleJobs = allJobs.filter((j: any) => {
      if (!POLLABLE_STATUSES.includes(j.status)) return false;
      if (!j.next_poll_at) return true; // sem next_poll_at, processar agora
      return j.next_poll_at <= nowIso;
    }).slice(0, maxJobs);

    if (eligibleJobs.length === 0) {
      return Response.json({ ok: true, polled: 0, message: 'Nenhum job elegível para polling' });
    }

    console.log(`[pollReportJobs] ${eligibleJobs.length} jobs para processar`);

    // Agrupar por conta para obter tokens uma vez por conta
    const accountMap = new Map<string, any>();
    const accountTokenMap = new Map<string, string>();

    for (const job of eligibleJobs) {
      if (!accountMap.has(job.amazon_account_id)) {
        const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: job.amazon_account_id }, null, 1);
        if (accs[0]) accountMap.set(job.amazon_account_id, accs[0]);
      }
    }

    // Obter tokens por conta diretamente via LWA (sem invoke para preservar contexto)
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';
    for (const [accountId, account] of accountMap.entries()) {
      const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
      if (!refreshToken || !clientId || !clientSecret) {
        console.error(`[pollReportJobs] Credenciais ausentes para conta ${accountId}`);
        continue;
      }
      const lwaRes = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString(),
      });
      const lwaData = await lwaRes.json().catch(() => ({}));
      if (lwaRes.ok && lwaData.access_token) {
        accountTokenMap.set(accountId, lwaData.access_token);
      } else {
        console.error(`[pollReportJobs] Sem token para conta ${accountId}: ${lwaData.error}`);
      }
    }

    const results: any[] = [];

    for (const job of eligibleJobs) {
      try {
        // Verificar lock de poll em andamento (máx 10 min)
        if (job.poll_in_progress && job.poll_started_at && job.poll_started_at > tenMinutesAgo) {
          console.log(`[pollReportJobs] Job ${job.id} com poll em andamento — skip`);
          results.push({ job_id: job.id, skipped: true, reason: 'poll_in_progress' });
          continue;
        }

        // Verificar se o job é pendente há mais de 3h → stale
        if (['pending', 'processing', 'requested', 'pending_unknown'].includes(job.status)) {
          const createdAt = job.requested_at || job.created_at;
          if (createdAt && createdAt < threeHoursAgo) {
            await base44.asServiceRole.entities.AmazonAdsReportJob.update(job.id, {
              status: 'stale',
              error_message: 'Relatório pendente há mais de 3h — marcado como stale',
              updated_at: nowIso,
            }).catch(() => {});
            console.log(`[pollReportJobs] Job ${job.id} marcado como stale (>3h pendente)`);
            results.push({ job_id: job.id, status: 'stale' });
            continue;
          }
        }

        // Para jobs sem report_id (pending_unknown), tentar recriar
        if (!job.report_id && job.status === 'pending_unknown') {
          console.log(`[pollReportJobs] Job ${job.id} sem report_id (pending_unknown) — tentando recriar`);
          await base44.asServiceRole.entities.AmazonAdsReportJob.update(job.id, {
            status: 'failed',
            error_message: 'Job sem report_id — marcado como failed para permitir recriação',
            updated_at: nowIso,
          }).catch(() => {});
          results.push({ job_id: job.id, status: 'failed', reason: 'no_report_id' });
          continue;
        }

        const account = accountMap.get(job.amazon_account_id);
        const accessToken = accountTokenMap.get(job.amazon_account_id);
        if (!account || !accessToken) {
          results.push({ job_id: job.id, error: 'Sem token ou conta' });
          continue;
        }

        const profileId = job.profile_id || account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
        const region = job.region || account.region || Deno.env.get('ADS_REGION') || 'NA';

        // Adquirir lock de poll
        await base44.asServiceRole.entities.AmazonAdsReportJob.update(job.id, {
          poll_in_progress: true,
          poll_started_at: nowIso,
          updated_at: nowIso,
        }).catch(() => {});

        const pollStart = Date.now();
        const statusRes = await fetch(`${adsBase(region)}/reporting/reports/${job.report_id}`, {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Amazon-Advertising-API-ClientId': clientId,
            'Amazon-Advertising-API-Scope': profileId,
            'Accept': 'application/vnd.getasyncreportresponse.v3+json',
          },
        });

        const pollDuration = Date.now() - pollStart;
        const reqId = statusRes.headers.get('x-amzn-RequestId') || '';
        const rateLimitHdr = statusRes.headers.get('x-amzn-RateLimit-Limit') || '';
        const retryAfterHdr = statusRes.headers.get('Retry-After');
        const newAttempt = (job.poll_attempts || 0) + 1;

        // Log da requisição de poll
        await base44.asServiceRole.entities.AmazonApiRequestLog.create({
          amazon_account_id: job.amazon_account_id,
          api_family: 'ads_v3',
          operation: 'getReportStatus',
          method: 'GET',
          endpoint: `/reporting/reports/${job.report_id}`,
          http_status: statusRes.status,
          success: statusRes.ok,
          request_id: reqId,
          rate_limit_observed: rateLimitHdr,
          retry_after: retryAfterHdr ? Number(retryAfterHdr) : null,
          duration_ms: pollDuration,
          attempt_number: newAttempt,
          created_at: nowIso,
        }).catch(() => {});

        // Tratar 429
        if (statusRes.status === 429) {
          const retryAfter = retryAfterHdr ? Number(retryAfterHdr) : 60;
          const nextPoll = nextPollAt(newAttempt, retryAfter);
          await base44.asServiceRole.entities.AmazonAdsReportJob.update(job.id, {
            status: 'rate_limited',
            poll_in_progress: false,
            poll_attempts: newAttempt,
            last_polled_at: nowIso,
            next_poll_at: nextPoll,
            retry_after_seconds: retryAfter,
            cooldown_until: nextPoll,
            error_message: `HTTP 429 — Retry-After: ${retryAfter}s`,
            updated_at: nowIso,
          }).catch(() => {});
          results.push({ job_id: job.id, status: 'rate_limited', next_poll_at: nextPoll });
          continue;
        }

        if (!statusRes.ok) {
          const errData = await statusRes.json().catch(() => ({}));
          await base44.asServiceRole.entities.AmazonAdsReportJob.update(job.id, {
            poll_in_progress: false,
            poll_attempts: newAttempt,
            last_polled_at: nowIso,
            next_poll_at: nextPollAt(newAttempt),
            error_message: `HTTP ${statusRes.status}: ${errData?.message || ''}`,
            updated_at: nowIso,
          }).catch(() => {});
          results.push({ job_id: job.id, error: `HTTP ${statusRes.status}` });
          continue;
        }

        const statusData = await statusRes.json().catch(() => ({}));
        const amzStatus = statusData.status || 'PENDING';
        const internalStatus = mapAmazonStatus(amzStatus);

        // PENDING ou PROCESSING
        if (['pending', 'processing'].includes(internalStatus)) {
          const nextPoll = nextPollAt(newAttempt);
          await base44.asServiceRole.entities.AmazonAdsReportJob.update(job.id, {
            status: internalStatus,
            amazon_status: amzStatus,
            poll_in_progress: false,
            poll_attempts: newAttempt,
            last_polled_at: nowIso,
            next_poll_at: nextPoll,
            updated_at: nowIso,
          }).catch(() => {});
          const msg = internalStatus === 'pending'
            ? 'Relatório solicitado à Amazon. A geração pode levar alguns minutos.'
            : 'A Amazon ainda está processando o relatório. O app continuará checando automaticamente.';
          results.push({ job_id: job.id, status: internalStatus, next_poll_at: nextPoll, message: msg });
          continue;
        }

        // COMPLETED
        if (internalStatus === 'completed') {
          const url = statusData.url;
          const urlExpiresAt = statusData.urlExpiresAt;
          const generatedAt = statusData.generatedAt;

          await base44.asServiceRole.entities.AmazonAdsReportJob.update(job.id, {
            status: 'completed',
            amazon_status: 'COMPLETED',
            url,
            url_expires_at: urlExpiresAt,
            generated_at_amazon: generatedAt,
            file_size: statusData.fileSize || null,
            poll_in_progress: false,
            poll_attempts: newAttempt,
            last_polled_at: nowIso,
            updated_at: nowIso,
          }).catch(() => {});

          // Enfileirar download e processamento
          console.log(`[pollReportJobs] Job ${job.id} COMPLETED — iniciando download`);
          const downloadRes = await base44.asServiceRole.functions.invoke('downloadAndProcessAmazonAdsReportJob', {
            job_id: job.id,
            _service_role: true,
          });
          results.push({ job_id: job.id, status: 'completed', downloaded: downloadRes?.ok, message: 'Relatório pronto e processado.' });
          continue;
        }

        // FAILED / CANCELLED
        if (['failed', 'cancelled'].includes(internalStatus)) {
          await base44.asServiceRole.entities.AmazonAdsReportJob.update(job.id, {
            status: internalStatus,
            amazon_status: amzStatus,
            failure_reason: statusData.failureReason || null,
            poll_in_progress: false,
            poll_attempts: newAttempt,
            last_polled_at: nowIso,
            error_message: statusData.failureReason || `Relatório ${amzStatus}`,
            updated_at: nowIso,
          }).catch(() => {});
          results.push({ job_id: job.id, status: internalStatus, reason: statusData.failureReason });
          continue;
        }

        // Status desconhecido
        await base44.asServiceRole.entities.AmazonAdsReportJob.update(job.id, {
          amazon_status: amzStatus,
          poll_in_progress: false,
          poll_attempts: newAttempt,
          last_polled_at: nowIso,
          next_poll_at: nextPollAt(newAttempt),
          updated_at: nowIso,
        }).catch(() => {});
        results.push({ job_id: job.id, status: 'unknown', amazon_status: amzStatus });

      } catch (jobErr: any) {
        console.error(`[pollReportJobs] Erro no job ${job.id}: ${jobErr.message}`);
        await base44.asServiceRole.entities.AmazonAdsReportJob.update(job.id, {
          poll_in_progress: false,
          error_message: jobErr.message?.slice(0, 200),
          updated_at: nowIso,
        }).catch(() => {});
        results.push({ job_id: job.id, error: jobErr.message });
      }
    }

    console.log(`[pollReportJobs] Concluído em ${Date.now() - t0}ms | ${results.length} jobs processados`);
    return Response.json({ ok: true, polled: results.length, results, duration_ms: Date.now() - t0 });

  } catch (err: any) {
    console.error('[pollReportJobs] Erro geral:', err.message);
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});