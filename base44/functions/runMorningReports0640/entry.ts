import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function brazilTime() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

async function runStep(base44:any, name:string, payload:any, required = true) {
  const started = Date.now();
  try {
    const response = await base44.asServiceRole.functions.invoke(name, payload);
    const data = response?.data || response || {};
    return {
      step: name,
      required,
      ok: data?.ok !== false,
      duration_ms: Date.now() - started,
      summary: data,
    };
  } catch (error) {
    return {
      step: name,
      required,
      ok: false,
      duration_ms: Date.now() - started,
      error: error?.message || String(error),
    };
  }
}

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });
    }

    const time = brazilTime();
    const withinSchedule = Number(time.hour) === 6 && Number(time.minute) >= 40;
    if (!withinSchedule && body.force !== true) {
      return Response.json({
        ok: true,
        skipped: true,
        reason: 'Fora do horário de relatórios das 06:40',
        brazil_time: `${time.hour}:${time.minute}`,
      });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id })
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });

    if (!accounts.length) {
      return Response.json({
        ok: false,
        error: 'Nenhuma AmazonAccount conectada.',
        accounts_processed: 0,
      }, { status: 409 });
    }

    const results = [];

    for (const account of accounts) {
      const payload = {
        amazon_account_id: account.id,
        trigger_type: 'scheduled_0640',
        _service_role: true,
      };

      const steps = [];

      // Solicita relatórios Ads de 30 dias sem executar decisões na Amazon.
      steps.push(await runStep(base44, 'scheduledAdsReportSync', {
        ...payload,
        action: 'request',
      }));

      // Atualiza catálogo e relatórios de produto/SP-API.
      steps.push(await runStep(base44, 'requestProductReportsV2', payload));
      steps.push(await runStep(base44, 'syncProductCatalogV2', payload));

      // Atualiza apenas estados e vínculos necessários para análise.
      steps.push(await runStep(base44, 'syncAdsCampaignStatesV2', payload));
      steps.push(await runStep(base44, 'fixProductCampaignLinks', payload, false));

      // Aprende com resultados anteriores e gera sinais antes da nova análise.
      steps.push(await runStep(base44, 'evaluateBidChangeOutcomesV2', payload, false));
      steps.push(await runStep(base44, 'evaluateAutoVsManualCampaigns', payload, false));
      steps.push(await runStep(base44, 'buildKeywordLearningSignals', payload, false));
      steps.push(await runStep(base44, 'runLearnerCycle', {
        ...payload,
        analysis_only: true,
        execute_actions: false,
      }, false));

      // Gera decisões, mas não as executa; execução permanece nas filas 00-03 e 13h.
      steps.push(await runStep(base44, 'runDailyAdsOptimization', {
        ...payload,
        trigger: 'scheduled_0640',
        analysis_only: true,
        execute_actions: false,
      }));

      steps.push(await runStep(base44, 'auditAmazonDataConsistency', {
        ...payload,
        trigger_type: 'scheduled_0640_post_analysis',
      }, false));

      const requiredSteps = steps.filter((step:any) => step.required);
      const ok = requiredSteps.every((step:any) => step.ok);
      const completedAt = new Date().toISOString();

      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: account.id,
        operation: 'morning_reports_audit_ml_0640',
        status: ok ? 'success' : 'error',
        trigger_type: 'scheduled_0640',
        started_at: startedAt,
        completed_at: completedAt,
        records_processed: steps.filter((step:any) => step.ok).length,
        result_summary: JSON.stringify(steps).slice(0, 4000),
        error_message: ok
          ? null
          : requiredSteps
              .filter((step:any) => !step.ok)
              .map((step:any) => `${step.step}: ${step.error || step.summary?.error || 'falha'}`)
              .join(' | ')
              .slice(0, 1000),
      }).catch(() => {});

      await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
        last_reports_requested_at: completedAt,
        last_analysis_at: completedAt,
      }).catch(() => {});

      results.push({
        amazon_account_id: account.id,
        ok,
        reports_requested: steps.some((step:any) => step.step === 'scheduledAdsReportSync' && step.ok),
        amazon_actions_executed: false,
        steps,
      });
    }

    return Response.json({
      ok: results.every((item:any) => item.ok),
      schedule: '06:40 America/Sao_Paulo',
      accounts_processed: results.length,
      reports_requested: true,
      analysis_executed: true,
      amazon_actions_executed: false,
      execution_windows: ['00:00-04:00', '13:00-14:00'],
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      results,
    });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error?.message || 'Erro no ciclo de relatórios das 06:40',
      started_at: startedAt,
    }, { status: 500 });
  }
});
