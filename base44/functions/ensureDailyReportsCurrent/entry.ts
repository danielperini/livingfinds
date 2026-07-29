import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const REQUIRED_REPORT_TYPES = [
  'spCampaigns',
  'spSearchTerm',
  'spAdvertisedProduct',
];

function brazilDateOffset(days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const reference = new Date(`${today}T12:00:00-03:00`);
  reference.setUTCDate(reference.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(reference);
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });
    }

    const targetDate = brazilDateOffset(-1);
    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id })
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });

    let triggeredCount = 0;
    let completeCount = 0;
    const details: Array<Record<string, unknown>> = [];

    for (const account of accounts) {
      const recentJobs = await base44.asServiceRole.entities.AmazonAdsReportJob.filter(
        { amazon_account_id: account.id },
        '-created_date',
        250,
      ).catch(() => []);

      const targetJobs = recentJobs.filter((job: any) => job.end_date === targetDate);
      const presentTypes = new Set(targetJobs.map((job: any) => job.report_type_id).filter(Boolean));
      const missingTypes = REQUIRED_REPORT_TYPES.filter((type) => !presentTypes.has(type));

      if (missingTypes.length > 0) {
        const response = await base44.asServiceRole.functions.invoke('runDailyFullReportPipeline', {
          amazon_account_id: account.id,
          force: true,
          trigger_type: 'daily_report_freshness_self_heal',
          _service_role: true,
        });
        const result = response?.data ?? response ?? {};
        const triggered = result?.ok !== false;
        if (triggered) triggeredCount += 1;
        details.push({
          target_date: targetDate,
          triggered,
          missing_before: missingTypes,
          requested_jobs: result?.summary?.phases?.request?.count ?? 0,
          error: result?.error ?? null,
        });
      } else {
        completeCount += 1;
        details.push({
          target_date: targetDate,
          triggered: false,
          missing_before: [],
          jobs_found: targetJobs.length,
        });
      }

      await base44.asServiceRole.functions.invoke('pollAmazonAdsReportJobs', {
        amazon_account_id: account.id,
        max_jobs: 20,
        _service_role: true,
      }).catch(() => null);
    }

    return Response.json({
      ok: true,
      target_date: targetDate,
      accounts_checked: accounts.length,
      triggered_count: triggeredCount,
      already_complete_count: completeCount,
      details,
    });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error?.message || 'Falha ao verificar relatórios diários',
    }, { status: 500 });
  }
});
