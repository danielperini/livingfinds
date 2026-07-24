/**
 * pollAmazonAdsReportJobs — Robusto com retry automático
 *
 * - Busca jobs elegíveis (next_poll_at <= now, status pollable)
 * - Consulta Amazon; se falhar, aguarda 4min e tenta de novo (até 3x)
 * - Jobs nunca polled com poll_attempts=0 são tratados como elegíveis imediatamente
 * - Jobs stuck (poll_in_progress há >10min) têm o lock liberado automaticamente
 * - NÃO marca como stale antes de tentar poll — tenta 3x antes de desistir
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const MAX_RETRIES = 3;
const RETRY_WAIT_MS = 4 * 60 * 1000; // 4 minutos entre tentativas

function adsBase(region: string): string {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

function nextPollAt(attempt: number, retryAfterSeconds?: number): string {
  if (retryAfterSeconds) {
    return new Date(Date.now() + retryAfterSeconds * 1000 + 30000).toISOString();
  }
  // Escala: 4min, 4min, 8min, 15min, 30min, 45min
  const minutes = [4, 4, 8, 15, 30, 45, 45][Math.min(attempt, 6)];
  return new Date(Date.now() + minutes * 60000).toISOString();
}

function mapAmazonStatus(amzStatus: string): string {
  const map: Record<string, string> = {
    PENDING: 'pending', PROCESSING: 'processing',
    COMPLETED: 'completed', FAILED: 'failed',
    FAILURE: 'failed', CANCELLED: 'cancelled',
  };
  return map[amzStatus] || 'pending';
}

async function getLwaToken(refreshToken: string, clientId: string, clientSecret: string): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.access_token) return data.access_token;
      console.warn(`[poll] LWA tentativa ${attempt + 1} falhou: ${data.error}`);
    } catch (e: any) {
      console.warn(`[poll] LWA tentativa ${attempt + 1} erro: ${e.message}`);
    }
    if (attempt < MAX_RETRIES - 1) await new Promise(r => setTimeout(r, RETRY_WAIT_MS));
  }
  return null;
}

async function pollJobWithRetry(
  job: any,
  accessToken: string,
  clientId: string,
  profileId: string,
  region: string,
  db: any,
  nowIso: string,
): Promise<any> {
  const baseUrl = adsBase(region);
  let lastError = '';

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/reporting/reports/${job.report_id}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Amazon-Advertising-API-ClientId': clientId,
          'Amazon-Advertising-API-Scope': profileId,
          'Accept': 'application/vnd.getasyncreportresponse.v3+json',
        },
      });

      const newAttempt = (job.poll_attempts || 0) + 1;

      // Rate limit — aguardar e re-tentar
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('Retry-After') || '60');
        console.warn(`[poll] Job ${job.id} rate limited — aguardando ${retryAfter}s`);
        const waitMs = Math.min(retryAfter * 1000, RETRY_WAIT_MS);
        await new Promise(r => setTimeout(r, waitMs));
        lastError = `HTTP 429 — attempt ${attempt + 1}`;
        continue;
      }

      // Erro HTTP temporário — re-tentar após 4min
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        lastError = `HTTP ${res.status}: ${errBody.slice(0, 100)}`;
        console.warn(`[poll] Job ${job.id} HTTP ${res.status} tentativa ${attempt + 1} — aguardando 4min`);
        await db.entities.AmazonAdsReportJob.update(job.id, {
          poll_in_progress: false,
          poll_attempts: newAttempt,
          last_polled_at: nowIso,
          next_poll_at: nextPollAt(newAttempt),
          error_message: lastError,
          updated_at: nowIso,
        }).catch(() => {});
        if (attempt < MAX_RETRIES - 1) await new Promise(r => setTimeout(r, RETRY_WAIT_MS));
        continue;
      }

      const statusData = await res.json().catch(() => ({}));
      const amzStatus = statusData.status || 'PENDING';
      const internalStatus = mapAmazonStatus(amzStatus);

      // COMPLETED → baixar imediatamente
      if (internalStatus === 'completed') {
        await db.entities.AmazonAdsReportJob.update(job.id, {
          status: 'completed',
          amazon_status: 'COMPLETED',
          url: statusData.url,
          url_expires_at: statusData.urlExpiresAt,
          generated_at_amazon: statusData.generatedAt,
          file_size: statusData.fileSize || null,
          poll_in_progress: false,
          poll_attempts: newAttempt,
          last_polled_at: nowIso,
          updated_at: nowIso,
        }).catch(() => {});

        console.log(`[poll] Job ${job.id} COMPLETED — disparando download`);
        const dlRes = await db.functions.invoke('downloadAndProcessAmazonAdsReportJob', {
          job_id: job.id, _service_role: true,
        }).catch((e: any) => ({ ok: false, error: e?.message }));
        return { status: 'completed', downloaded: dlRes?.ok !== false };
      }

      // FAILED / CANCELLED → se ainda tem tentativas, aguardar e re-tentar pipeline inteiro
      if (['failed', 'cancelled'].includes(internalStatus)) {
        await db.entities.AmazonAdsReportJob.update(job.id, {
          status: internalStatus,
          amazon_status: amzStatus,
          failure_reason: statusData.failureReason || null,
          poll_in_progress: false,
          poll_attempts: newAttempt,
          last_polled_at: nowIso,
          error_message: statusData.failureReason || `Amazon ${amzStatus}`,
          updated_at: nowIso,
        }).catch(() => {});
        console.warn(`[poll] Job ${job.id} ${amzStatus} na Amazon tentativa ${attempt + 1}`);
        if (attempt < MAX_RETRIES - 1) await new Promise(r => setTimeout(r, RETRY_WAIT_MS));
        lastError = `Amazon ${amzStatus}: ${statusData.failureReason || ''}`;
        continue;
      }

      // PENDING / PROCESSING — ainda aguardando Amazon
      await db.entities.AmazonAdsReportJob.update(job.id, {
        status: internalStatus,
        amazon_status: amzStatus,
        poll_in_progress: false,
        poll_attempts: newAttempt,
        last_polled_at: nowIso,
        next_poll_at: nextPollAt(newAttempt),
        updated_at: nowIso,
      }).catch(() => {});
      return { status: internalStatus, message: 'Amazon ainda processando — próximo poll agendado' };

    } catch (e: any) {
      lastError = e.message;
      console.error(`[poll] Job ${job.id} erro inesperado tentativa ${attempt + 1}: ${e.message}`);
      if (attempt < MAX_RETRIES - 1) await new Promise(r => setTimeout(r, RETRY_WAIT_MS));
    }
  }

  // Esgotou todas as tentativas
  const finalAttempt = (job.poll_attempts || 0) + MAX_RETRIES;
  await db.entities.AmazonAdsReportJob.update(job.id, {
    status: 'failed',
    poll_in_progress: false,
    poll_attempts: finalAttempt,
    last_polled_at: nowIso,
    next_poll_at: nextPollAt(finalAttempt),
    error_message: `Falhou após ${MAX_RETRIES} tentativas: ${lastError}`,
    updated_at: nowIso,
  }).catch(() => {});
  return { status: 'failed', error: lastError, retries: MAX_RETRIES };
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const maxJobs = body.max_jobs || 10;
    const db = base44.asServiceRole;

    const now = new Date();
    const nowIso = now.toISOString();
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60000).toISOString();

    const POLLABLE_STATUSES = ['requested', 'pending', 'processing', 'rate_limited', 'pending_unknown'];

    // Buscar jobs pollable — sem limite de tempo para não descartar jobs nunca tentados
    const allJobs = await db.entities.AmazonAdsReportJob.filter(
      { status: { $in: POLLABLE_STATUSES } },
      'next_poll_at',
      100
    );

    const eligibleJobs = allJobs.filter((j: any) => {
      // Liberar locks travados (poll_in_progress há >10min)
      if (j.poll_in_progress && j.poll_started_at && j.poll_started_at > tenMinutesAgo) return false;
      // Jobs sem next_poll_at são elegíveis imediatamente
      if (!j.next_poll_at) return true;
      // Jobs com next_poll_at no passado
      return j.next_poll_at <= nowIso;
    }).slice(0, maxJobs);

    if (eligibleJobs.length === 0) {
      return Response.json({ ok: true, polled: 0, message: 'Nenhum job elegível para polling' });
    }

    // Liberar locks travados antes de processar
    for (const job of eligibleJobs) {
      if (job.poll_in_progress) {
        await db.entities.AmazonAdsReportJob.update(job.id, {
          poll_in_progress: false, updated_at: nowIso,
        }).catch(() => {});
      }
    }

    console.log(`[poll] ${eligibleJobs.length} jobs elegíveis`);

    // Agrupar contas e obter tokens
    const accountMap = new Map<string, any>();
    const tokenMap = new Map<string, string>();
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';

    for (const job of eligibleJobs) {
      if (!accountMap.has(job.amazon_account_id)) {
        const accs = await db.entities.AmazonAccount.filter({ id: job.amazon_account_id }, null, 1).catch(() => []);
        if (accs[0]) accountMap.set(job.amazon_account_id, accs[0]);
      }
    }

    for (const [accountId, account] of accountMap.entries()) {
      const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
      if (!refreshToken || !clientId || !clientSecret) {
        console.error(`[poll] Credenciais ausentes para conta ${accountId}`);
        continue;
      }
      const token = await getLwaToken(refreshToken, clientId, clientSecret);
      if (token) {
        tokenMap.set(accountId, token);
      } else {
        console.error(`[poll] Falha ao obter token para conta ${accountId} após ${MAX_RETRIES} tentativas`);
      }
    }

    const results: any[] = [];

    for (const job of eligibleJobs) {
      // Adquirir lock
      await db.entities.AmazonAdsReportJob.update(job.id, {
        poll_in_progress: true, poll_started_at: nowIso, updated_at: nowIso,
      }).catch(() => {});

      const account = accountMap.get(job.amazon_account_id);
      const accessToken = tokenMap.get(job.amazon_account_id);

      if (!account || !accessToken) {
        await db.entities.AmazonAdsReportJob.update(job.id, {
          poll_in_progress: false,
          next_poll_at: nextPollAt((job.poll_attempts || 0) + 1),
          error_message: 'Sem token de acesso — será tentado novamente',
          updated_at: nowIso,
        }).catch(() => {});
        results.push({ job_id: job.id, error: 'Sem token — agendado retry' });
        continue;
      }

      if (!job.report_id) {
        await db.entities.AmazonAdsReportJob.update(job.id, {
          status: 'failed', poll_in_progress: false,
          error_message: 'report_id ausente — job inválido',
          updated_at: nowIso,
        }).catch(() => {});
        results.push({ job_id: job.id, status: 'failed', reason: 'no_report_id' });
        continue;
      }

      const profileId = job.profile_id || account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
      const region = job.region || account.region || Deno.env.get('ADS_REGION') || 'NA';

      const result = await pollJobWithRetry(job, accessToken, clientId, profileId, region, db, nowIso);
      results.push({ job_id: job.id, ...result });
    }

    console.log(`[poll] Concluído em ${Date.now() - t0}ms | ${results.length} jobs`);
    return Response.json({ ok: true, polled: results.length, results, duration_ms: Date.now() - t0 });

  } catch (err: any) {
    console.error('[poll] Erro geral:', err.message);
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});