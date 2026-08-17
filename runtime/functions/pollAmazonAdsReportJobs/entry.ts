/**
 * pollAmazonAdsReportJobs — Poller robusto de relatórios Amazon Ads
 *
 * Mudanças v2:
 * - Usa amazonAdsTokenManager para obter token (nunca chama LWA diretamente)
 * - Se token indisponível → retorna {ok:true, skipped:true} — nunca HTTP 5xx ao agendador
 * - Rate limit 429 → cooldown_until +5min, soft-fail (não falha a execução)
 * - Jobs pending com poll_attempts=0 há >2h detectados como orphaned e priorizados
 * - Erros inesperados capturados por job, não afetam o loop geral
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const REQUIRED_DAILY_REPORTS = ['spCampaigns', 'spSearchTerm', 'spAdvertisedProduct'];

function todayBRT() {
  return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
}

async function analyzeFreshDailyReports(db: any, accountIds: string[]) {
  const analyses: any[] = [];
  for (const accountId of [...new Set(accountIds.filter(Boolean))]) {
    const jobs = await db.entities.AmazonAdsReportJob.filter(
      { amazon_account_id: accountId, status: 'processed' }, '-processed_at', 100,
    ).catch(() => []);
    const reportDate = jobs.map((job: any) => String(job.end_date || '')).filter(Boolean).sort().pop();
    if (!reportDate) continue;
    const complete = REQUIRED_DAILY_REPORTS.every((type) =>
      jobs.some((job: any) => job.report_type_id === type && job.end_date === reportDate)
    );
    if (!complete) {
      analyses.push({ amazon_account_id: accountId, report_date: reportDate, analyzed: false, reason: 'required_reports_incomplete' });
      continue;
    }
    const operation = `daily_ai_report_analysis:${reportDate}`;
    const existing = await db.entities.SyncExecutionLog.filter(
      { amazon_account_id: accountId, operation }, '-started_at', 5,
    ).catch(() => []);
    if (existing.some((log: any) => ['processing', 'success', 'completed'].includes(String(log.status)))) {
      analyses.push({ amazon_account_id: accountId, report_date: reportDate, analyzed: false, reason: 'already_analyzed' });
      continue;
    }
    const startedAt = new Date().toISOString();
    const log = await db.entities.SyncExecutionLog.create({
      amazon_account_id: accountId, operation, trigger_type: 'report_completion',
      status: 'processing', execution_date: todayBRT(), started_at: startedAt,
      result_summary: JSON.stringify({ report_date: reportDate, required_reports: REQUIRED_DAILY_REPORTS }),
    });
    try {
      const response = await db.functions.invoke('runDailyAdsOptimization', {
        amazon_account_id: accountId, trigger: 'fresh_daily_reports',
        analysis_only: true, execute_actions: false, report_date: reportDate, _service_role: true,
      });
      const data = response?.data || response || {};
      const ok = data?.ok !== false && data?.skipped !== true;
      const completedAt = new Date().toISOString();
      await db.entities.SyncExecutionLog.update(log.id, {
        status: ok ? 'success' : 'warning', completed_at: completedAt,
        duration_ms: Date.now() - new Date(startedAt).getTime(),
        result_summary: JSON.stringify({ report_date: reportDate, analysis: data }).slice(0, 4000),
        error_message: ok ? null : String(data?.reason || data?.error || 'analysis_skipped').slice(0, 500),
      }).catch(() => {});
      if (ok) await db.entities.AmazonAccount.update(accountId, { last_analysis_at: completedAt }).catch(() => {});
      analyses.push({ amazon_account_id: accountId, report_date: reportDate, analyzed: ok });
    } catch (error: any) {
      await db.entities.SyncExecutionLog.update(log.id, {
        status: 'error', completed_at: new Date().toISOString(),
        error_message: String(error?.message || error).slice(0, 500),
      }).catch(() => {});
      analyses.push({ amazon_account_id: accountId, report_date: reportDate, analyzed: false, error: error?.message });
    }
  }
  return analyses;
}

const MAX_JOB_RETRIES = 1; // tentativas por job neste ciclo (retry adiado para próximo ciclo)

function adsBase(region: string): string {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

function nextPollAt(attempt: number): string {
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

async function pollSingleJob(
  job: any,
  accessToken: string,
  clientId: string,
  profileId: string,
  region: string,
  db: any,
  nowIso: string,
): Promise<{ status: string; downloaded?: boolean; skipped?: boolean; reason?: string; error?: string }> {
  const baseUrl = adsBase(region);

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

    // Rate limit — soft-fail: definir cooldown de 5min, não falhar a execução
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After') || '300');
      const cooldownUntil = new Date(Date.now() + Math.max(retryAfter, 300) * 1000).toISOString();
      await db.entities.AmazonAdsReportJob.update(job.id, {
        poll_in_progress: false,
        poll_attempts: newAttempt,
        last_polled_at: nowIso,
        next_poll_at: cooldownUntil,
        cooldown_until: cooldownUntil,
        status: 'rate_limited',
        error_message: `HTTP 429 — cooldown até ${cooldownUntil}`,
        updated_at: nowIso,
      }).catch(() => {});
      console.warn(`[poll] Job ${job.id} rate limited — cooldown ${Math.round(retryAfter / 60)}min`);
      return { status: 'rate_limited', skipped: true, reason: '429_cooldown' };
    }

    // Erro HTTP temporário (5xx) — agendar retry sem falhar execução
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      const msg = `HTTP ${res.status}: ${errBody.slice(0, 100)}`;
      await db.entities.AmazonAdsReportJob.update(job.id, {
        poll_in_progress: false,
        poll_attempts: newAttempt,
        last_polled_at: nowIso,
        next_poll_at: nextPollAt(newAttempt),
        error_message: msg,
        updated_at: nowIso,
      }).catch(() => {});
      console.warn(`[poll] Job ${job.id} HTTP ${res.status} — retry no próximo ciclo`);
      return { status: 'retry_scheduled', reason: msg };
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
      return { status: 'completed', downloaded: (dlRes as any)?.ok !== false };
    }

    // FAILED / CANCELLED
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
      return { status: internalStatus, reason: statusData.failureReason };
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
    return { status: internalStatus };

  } catch (e: any) {
    const msg = String(e?.message || 'erro inesperado').slice(0, 200);
    console.error(`[poll] Job ${job.id} erro inesperado: ${msg}`);
    const newAttempt = (job.poll_attempts || 0) + 1;
    await db.entities.AmazonAdsReportJob.update(job.id, {
      poll_in_progress: false,
      poll_attempts: newAttempt,
      last_polled_at: nowIso,
      next_poll_at: nextPollAt(newAttempt),
      error_message: msg,
      updated_at: nowIso,
    }).catch(() => {});
    return { status: 'error', error: msg };
  }
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const maxJobs = body.max_jobs || 10;
    const db = base44.asServiceRole;

    // ── 1. Obter token via amazonAdsTokenManager ─────────────────────────────
    // Se token indisponível → skip silencioso (não retornar erro ao agendador)
    const accounts = await db.entities.AmazonAccount.list('-updated_date', 50).catch(() => [] as any[]);
    const eligibleAccounts = accounts.filter((a: any) => {
      const token = String(a.ads_refresh_token || '');
      return token.startsWith('Atzr|') && token.length >= 50;
    });

    if (eligibleAccounts.length === 0) {
      return Response.json({ ok: true, skipped: true, reason: 'no_eligible_accounts', polled: 0 });
    }

    // Obter access tokens via token manager (usa lock, buffer, fallback ENV)
    const tokenMap = new Map<string, string>();
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';

    for (const account of eligibleAccounts) {
      try {
        const tokenRes = await db.functions.invoke('amazonAdsTokenManager', {
          amazon_account_id: account.id,
          _service_role: true,
        });
        const tokenData = (tokenRes as any)?.data || tokenRes || {};
        if (tokenData?.ok === true && tokenData?.access_token) {
          tokenMap.set(account.id, tokenData.access_token);
        } else {
          console.warn(`[poll] Token indisponível para conta ${account.id}: ${tokenData?.message || tokenData?.error_type}`);
        }
      } catch (e: any) {
        console.warn(`[poll] Erro ao obter token para conta ${account.id}: ${e.message}`);
      }
    }

    if (tokenMap.size === 0) {
      console.warn('[poll] Nenhum token disponível — skipping silencioso para não acumular falhas');
      return Response.json({ ok: true, skipped: true, reason: 'no_token_available', polled: 0 });
    }

    // ── 2. Buscar jobs elegíveis ────────────────────────────────────────────
    const now = new Date();
    const nowIso = now.toISOString();
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60000).toISOString();
    const twoHoursAgo   = new Date(now.getTime() - 2 * 3600000).toISOString();

    const POLLABLE_STATUSES = ['requested', 'pending', 'processing', 'rate_limited', 'pending_unknown'];

    const allJobs = await db.entities.AmazonAdsReportJob.filter(
      { status: { $in: POLLABLE_STATUSES } },
      'next_poll_at',
      100
    ).catch(() => [] as any[]);

    // Filtrar elegíveis: next_poll_at vencido OU orphaned (poll_attempts=0 há >2h)
    const eligibleJobs = allJobs.filter((j: any) => {
      // Liberar locks travados (poll_in_progress há >10min)
      if (j.poll_in_progress && j.poll_started_at && j.poll_started_at > tenMinutesAgo) return false;
      // Orphaned: nunca polled, criado há >2h → priorizar
      const createdAt = j.created_date || j.created_at || j.requested_at || '';
      if ((j.poll_attempts || 0) === 0 && createdAt && createdAt <= twoHoursAgo) return true;
      // next_poll_at vencido ou ausente
      if (!j.next_poll_at) return true;
      return j.next_poll_at <= nowIso;
    }).slice(0, maxJobs);

    if (eligibleJobs.length === 0) {
      const dailyAnalysis = await analyzeFreshDailyReports(
        db,
        eligibleAccounts.map((account: any) => String(account.id || '')),
      );
      return Response.json({
        ok: true, polled: 0, daily_analysis: dailyAnalysis,
        message: 'Nenhum job elegível para polling', duration_ms: Date.now() - t0,
      });
    }

    // Liberar locks travados
    for (const job of eligibleJobs) {
      if (job.poll_in_progress) {
        await db.entities.AmazonAdsReportJob.update(job.id, {
          poll_in_progress: false, updated_at: nowIso,
        }).catch(() => {});
      }
    }

    console.log(`[poll] ${eligibleJobs.length} jobs elegíveis (${tokenMap.size} conta(s) com token)`);

    // ── 3. Processar jobs ───────────────────────────────────────────────────
    const results: any[] = [];

    for (const job of eligibleJobs) {
      const accessToken = tokenMap.get(job.amazon_account_id);
      const account = eligibleAccounts.find((a: any) => a.id === job.amazon_account_id);

      if (!accessToken || !account) {
        await db.entities.AmazonAdsReportJob.update(job.id, {
          poll_in_progress: false,
          next_poll_at: nextPollAt((job.poll_attempts || 0) + 1),
          error_message: 'Sem token — retry no próximo ciclo',
          updated_at: nowIso,
        }).catch(() => {});
        results.push({ job_id: job.id, status: 'no_token' });
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

      // Marcar como in_progress
      await db.entities.AmazonAdsReportJob.update(job.id, {
        poll_in_progress: true, poll_started_at: nowIso, updated_at: nowIso,
      }).catch(() => {});

      const profileId = job.profile_id || account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
      const region    = job.region || account.region || Deno.env.get('ADS_REGION') || 'NA';

      const result = await pollSingleJob(job, accessToken, clientId, profileId, region, db, nowIso);
      results.push({ job_id: job.id, ...result });
    }

    const completed    = results.filter(r => r.status === 'completed').length;
    const rateLimited  = results.filter(r => r.status === 'rate_limited').length;
    const errors       = results.filter(r => r.status === 'error').length;

    console.log(`[poll] Concluído em ${Date.now() - t0}ms | ${results.length} jobs | ${completed} completed | ${rateLimited} rate_limited | ${errors} errors`);

    // Sempre retornar ok:true para o agendador não acumular falhas
    const dailyAnalysis = await analyzeFreshDailyReports(
      db,
      eligibleJobs.map((job: any) => String(job.amazon_account_id || '')),
    );

    return Response.json({
      ok: true,
      polled: results.length,
      completed,
      rate_limited: rateLimited,
      errors,
      results,
      daily_analysis: dailyAnalysis,
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    // Capturar erro geral mas retornar ok:true para não pausar a automação
    console.error('[poll] Erro geral:', err.message);
    return Response.json({
      ok: true,
      skipped: true,
      reason: 'internal_error',
      error: String(err.message).slice(0, 200),
      duration_ms: Date.now() - t0,
    });
  }
});
