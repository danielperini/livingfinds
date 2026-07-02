/**
 * checkAndRequestDailyReport
 *
 * Executado diariamente às 08h (automação scheduled).
 *
 * Fluxo completo:
 *   1. Verifica se já existe relatório atualizado hoje (AdsMetricsHistory com date = hoje ou ontem)
 *   2. Se NÃO existe relatório fresco → solicita relatórios à Amazon (requestAdsReportsFull)
 *   3. Aguarda os relatórios ficarem prontos (poll até 15min)
 *   4. Baixa e processa os relatórios (downloadAdsReport)
 *   5. Chama dailyReportReconciliation para Claude ler, corrigir e sugerir budget
 *   6. Registra o resultado em SyncExecutionLog
 *
 * Se já existe relatório atualizado (< 8h) → pula a solicitação e vai direto ao Claude.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MAX_POLL_ATTEMPTS = 18;   // 18 × 50s = 15 minutos
const POLL_INTERVAL_MS  = 50000; // 50 segundos entre polls

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hoursAgo(h: number) {
  return new Date(Date.now() - h * 3600000).toISOString();
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  try {
    const base44 = createClientFromRequest(req);

    // Autorização: automação usa service role diretamente
    let isAuthorized = false;
    try { const u = await base44.auth.me(); if (u) isAuthorized = true; } catch {}
    if (!isAuthorized) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));

    // ── 1. Resolver conta ─────────────────────────────────────────────────
    let account = null;
    const accs = await base44.asServiceRole.entities.AmazonAccount.filter(
      { status: 'connected' }, '-created_date', 1
    );
    account = accs[0] || null;
    if (!account) {
      return Response.json({ ok: false, skipped: true, reason: 'Nenhuma conta Amazon conectada.' });
    }
    const aid = account.id;

    // ── 2. Verificar se já existe relatório recente (< 8h) ────────────────
    const freshCutoff = hoursAgo(8);
    const recentReports = await base44.asServiceRole.entities.AdsMetricsHistory.filter(
      { amazon_account_id: aid, report_type: 'campaigns' }, '-date', 5
    );

    const hasFreshReport = recentReports.some(r => {
      // Relatório de hoje ou ontem, sincronizado nas últimas 8h
      const isRecentDate = r.date === today || r.date === yesterday;
      const isFresh = r.synced_at && r.synced_at >= freshCutoff;
      return isRecentDate && isFresh;
    });

    // ── 3. Log de início ──────────────────────────────────────────────────
    const logRecord = await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'full_sync',
      trigger_type: 'automatic',
      status: 'started',
      execution_date: today,
      started_at: now,
    });

    if (hasFreshReport) {
      // Relatório já existe e está fresco → pular solicitação, ir direto ao Claude
      console.log(`[checkAndRequestDailyReport] Relatório já fresco. Chamando reconciliação diretamente.`);

      const reconRes = await base44.asServiceRole.functions.invoke('dailyReportReconciliation', {
        amazon_account_id: aid,
      });

      await base44.asServiceRole.entities.SyncExecutionLog.update(logRecord.id, {
        status: 'success',
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
        records_processed: reconRes?.corrections_applied || 0,
      });

      return Response.json({
        ok: true,
        step: 'reconciliation_only',
        reason: 'Relatório já estava atualizado (< 8h)',
        reconciliation: reconRes,
        duration_ms: Date.now() - startTime,
      });
    }

    // ── 4. Solicitar relatórios à Amazon ──────────────────────────────────
    console.log(`[checkAndRequestDailyReport] Sem relatório fresco. Solicitando à Amazon...`);

    let reportIds: Record<string, string> = {};
    let syncRunId = '';

    try {
      const requestRes = await base44.asServiceRole.functions.invoke('runFullSync', {
        amazon_account_id: aid,
        action: 'request',
      });

      if (!requestRes?.ok) {
        throw new Error(requestRes?.message || requestRes?.amazon_error || 'Falha ao solicitar relatórios');
      }

      reportIds = requestRes?.reportIds || {};
      syncRunId = requestRes?.syncRunId || '';
      console.log(`[checkAndRequestDailyReport] Relatórios solicitados: ${Object.keys(reportIds).join(', ')}`);
    } catch (reqErr) {
      await base44.asServiceRole.entities.SyncExecutionLog.update(logRecord.id, {
        status: 'error',
        completed_at: new Date().toISOString(),
        error_message: `Erro ao solicitar: ${reqErr.message}`,
        duration_ms: Date.now() - startTime,
      });
      return Response.json({ ok: false, step: 'request_failed', error: reqErr.message }, { status: 500 });
    }

    if (!Object.keys(reportIds).length) {
      await base44.asServiceRole.entities.SyncExecutionLog.update(logRecord.id, {
        status: 'error',
        completed_at: new Date().toISOString(),
        error_message: 'Nenhum report ID retornado pela solicitação.',
        duration_ms: Date.now() - startTime,
      });
      return Response.json({ ok: false, step: 'no_report_ids', error: 'Nenhum report ID retornado.' });
    }

    // ── 5. Poll aguardando relatórios ficarem prontos ─────────────────────
    let downloadResult: any = null;
    let pollAttempts = 0;
    let ready = false;

    while (pollAttempts < MAX_POLL_ATTEMPTS && !ready) {
      await sleep(POLL_INTERVAL_MS);
      pollAttempts++;

      console.log(`[checkAndRequestDailyReport] Poll ${pollAttempts}/${MAX_POLL_ATTEMPTS}...`);

      try {
        const pollRes = await base44.asServiceRole.functions.invoke('runFullSync', {
          amazon_account_id: aid,
          action: 'download',
          reportIds,
          syncRunId,
        });

        if (pollRes?.ready === true) {
          ready = true;
          downloadResult = pollRes;
          console.log(`[checkAndRequestDailyReport] Relatórios prontos após ${pollAttempts} tentativas.`);
        } else if (!pollRes?.ok && !pollRes?.ready) {
          // Erro definitivo durante o poll
          throw new Error(pollRes?.message || 'Erro durante o download dos relatórios');
        }
        // else: still pending, continue polling
      } catch (pollErr) {
        console.error(`[checkAndRequestDailyReport] Erro no poll ${pollAttempts}: ${pollErr.message}`);
        // Continuar tentando até o limite
        if (pollAttempts >= MAX_POLL_ATTEMPTS) {
          await base44.asServiceRole.entities.SyncExecutionLog.update(logRecord.id, {
            status: 'error',
            completed_at: new Date().toISOString(),
            error_message: `Poll expirou após ${pollAttempts} tentativas: ${pollErr.message}`,
            duration_ms: Date.now() - startTime,
          });
          return Response.json({
            ok: false,
            step: 'poll_timeout',
            error: `Timeout após ${pollAttempts} tentativas. Relatórios não ficaram prontos.`,
            poll_attempts: pollAttempts,
          }, { status: 500 });
        }
      }
    }

    if (!ready) {
      await base44.asServiceRole.entities.SyncExecutionLog.update(logRecord.id, {
        status: 'error',
        completed_at: new Date().toISOString(),
        error_message: `Relatórios não ficaram prontos após ${MAX_POLL_ATTEMPTS} tentativas (${Math.round(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 60000)} min).`,
        duration_ms: Date.now() - startTime,
      });
      return Response.json({
        ok: false,
        step: 'poll_timeout',
        error: `Relatórios Amazon não ficaram prontos em ${Math.round(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS / 60000)} minutos.`,
        poll_attempts: pollAttempts,
      });
    }

    // ── 6. Chamar Claude para reconciliação e sugestão de budget ──────────
    console.log(`[checkAndRequestDailyReport] Relatórios baixados. Iniciando reconciliação com Claude...`);

    let reconciliationResult: any = null;
    try {
      reconciliationResult = await base44.asServiceRole.functions.invoke('dailyReportReconciliation', {
        amazon_account_id: aid,
      });
      console.log(`[checkAndRequestDailyReport] Reconciliação concluída: ${reconciliationResult?.corrections_applied || 0} correções.`);
    } catch (reconErr) {
      console.error(`[checkAndRequestDailyReport] Erro na reconciliação: ${reconErr.message}`);
      // Não falhar o run inteiro — os relatórios foram baixados com sucesso
    }

    // ── 7. Finalizar log ──────────────────────────────────────────────────
    await base44.asServiceRole.entities.SyncExecutionLog.update(logRecord.id, {
      status: 'success',
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      records_processed: (downloadResult?.campaigns_metrics || 0) + (downloadResult?.keywords || 0),
    });

    return Response.json({
      ok: true,
      step: 'full_pipeline',
      poll_attempts: pollAttempts,
      download_summary: {
        campaigns: downloadResult?.campaigns_metrics || 0,
        products: downloadResult?.products || 0,
        keywords: downloadResult?.keywords || 0,
        spend: downloadResult?.summary?.total_spend || 0,
        sales: downloadResult?.summary?.total_sales || 0,
      },
      reconciliation: reconciliationResult
        ? {
            corrections_applied: reconciliationResult.corrections_applied || 0,
            divergences_detected: reconciliationResult.divergences_detected || 0,
            budget_suggestion: reconciliationResult.budget_suggestion?.suggested_daily_budget || null,
            budget_confidence: reconciliationResult.budget_suggestion?.confidence || null,
          }
        : null,
      duration_ms: Date.now() - startTime,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});