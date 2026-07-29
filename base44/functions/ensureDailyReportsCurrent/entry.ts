import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const REPORTS = [
  {
    key: 'campaigns', reportTypeId: 'spCampaigns', groupBy: ['campaign'],
    columns: ['date','campaignId','campaignName','campaignStatus','campaignBudgetAmount','impressions','clicks','cost','purchases1d','purchases7d','purchases14d','purchases30d','sales1d','sales7d','sales14d','sales30d','acosClicks14d','roasClicks14d'],
  },
  {
    key: 'searchTerms', reportTypeId: 'spSearchTerm', groupBy: ['searchTerm'],
    columns: ['date','campaignId','campaignName','adGroupId','adGroupName','keywordId','keyword','matchType','searchTerm','impressions','clicks','cost','purchases7d','purchases14d','purchases30d','sales7d','sales14d','sales30d','acosClicks14d','roasClicks14d'],
  },
  {
    key: 'products', reportTypeId: 'spAdvertisedProduct', groupBy: ['advertiser'],
    columns: ['date','campaignId','campaignName','adGroupId','adGroupName','advertisedAsin','advertisedSku','impressions','clicks','cost','purchases14d','purchases30d','sales14d','sales30d'],
  },
];

const ACTIVE = new Set(['pending','requested','in_progress','processing','completed']);
const RETRY_AFTER_MS = 2 * 60 * 60 * 1000;

function brazilDateOffset(days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const reference = new Date(`${today}T12:00:00-03:00`);
  reference.setUTCDate(reference.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(reference);
}

function dateOffset(date: string, days: number): string {
  const reference = new Date(`${date}T12:00:00-03:00`);
  reference.setUTCDate(reference.getUTCDate() + days);
  return reference.toISOString().slice(0, 10);
}

function jobAge(job: any): number {
  const value = job.updated_date || job.created_date || job.requested_at;
  const time = value ? new Date(value).getTime() : 0;
  return time ? Date.now() - time : Number.POSITIVE_INFINITY;
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    const targetDate = brazilDateOffset(-1);
    const startDate = dateOffset(targetDate, -29);
    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id })
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });

    let triggeredCount = 0;
    let completeCount = 0;
    let futureJobsBlocked = 0;
    const details: Array<Record<string, unknown>> = [];

    for (const account of accounts) {
      let recentJobs = await base44.asServiceRole.entities.AmazonAdsReportJob.filter(
        { amazon_account_id: account.id }, '-created_date', 300,
      ).catch(() => []);

      const futureJobs = recentJobs.filter((job: any) => job.end_date > targetDate && ACTIVE.has(job.status));
      for (const job of futureJobs) {
        await base44.asServiceRole.entities.AmazonAdsReportJob.update(job.id, {
          status: 'stale',
          error_message: `Bloqueado: ${job.end_date} ainda não é um dia fechado no fuso America/Sao_Paulo`,
          poll_in_progress: false,
        }).catch(() => null);
        futureJobsBlocked += 1;
      }

      // Primeiro baixa/processa tudo que a Amazon já concluiu.
      await base44.asServiceRole.functions.invoke('pollAmazonAdsReportJobs', {
        amazon_account_id: account.id, max_jobs: 50, _service_role: true,
      }).catch(() => null);

      recentJobs = await base44.asServiceRole.entities.AmazonAdsReportJob.filter(
        { amazon_account_id: account.id }, '-created_date', 300,
      ).catch(() => []);
      const targetJobs = recentJobs.filter((job: any) => job.end_date === targetDate);

      // Um job só conta como concluído quando foi realmente processado.
      const processedTypes = new Set(targetJobs.filter((job: any) => job.status === 'processed').map((job: any) => job.report_type_id));
      const requested: Array<Record<string, unknown>> = [];

      for (const report of REPORTS) {
        if (processedTypes.has(report.reportTypeId)) continue;
        const jobsOfType = targetJobs.filter((job: any) => job.report_type_id === report.reportTypeId);
        const active = jobsOfType.filter((job: any) => ACTIVE.has(job.status));
        const timedOut = active.filter((job: any) => jobAge(job) >= RETRY_AFTER_MS);

        // Evita duplicar requests normais, mas recupera automaticamente jobs travados.
        if (active.length && timedOut.length === 0) continue;
        for (const job of timedOut) {
          await base44.asServiceRole.entities.AmazonAdsReportJob.update(job.id, {
            status: 'stale', poll_in_progress: false,
            error_message: 'Recriado automaticamente após 2h sem conclusão pela Amazon',
          }).catch(() => null);
        }

        const response = await base44.asServiceRole.functions.invoke('requestAmazonAdsReportV3', {
          amazon_account_id: account.id,
          report_type_id: report.reportTypeId,
          ad_product: 'SPONSORED_PRODUCTS',
          time_unit: 'DAILY',
          group_by: report.groupBy,
          columns: report.columns,
          filters: null,
          start_date: startDate,
          end_date: targetDate,
          report_name: `LivingFinds_${report.key}_${targetDate}_${Date.now()}`,
          source_function: 'ensureDailyReportsCurrent',
          _service_role: true,
        });
        const result = response?.data ?? response ?? {};
        requested.push({ report_type_id: report.reportTypeId, ok: result?.ok !== false, status: result?.status ?? null, error: result?.error ?? null });
      }

      if (requested.length) {
        triggeredCount += 1;
        await base44.asServiceRole.entities.AmazonAccount.update(account.id, { last_reports_requested_at: new Date().toISOString() }).catch(() => null);
      }

      // Segunda passagem captura requests que concluíram rapidamente.
      await base44.asServiceRole.functions.invoke('pollAmazonAdsReportJobs', {
        amazon_account_id: account.id, max_jobs: 50, _service_role: true,
      }).catch(() => null);

      const finalJobs = await base44.asServiceRole.entities.AmazonAdsReportJob.filter(
        { amazon_account_id: account.id }, '-created_date', 300,
      ).catch(() => []);
      const finalTargetJobs = finalJobs.filter((job: any) => job.end_date === targetDate);
      const finalProcessed = REPORTS.filter((report) => finalTargetJobs.some((job: any) => job.report_type_id === report.reportTypeId && job.status === 'processed'));
      const completionPercent = Math.round(finalProcessed.length / REPORTS.length * 100);
      if (completionPercent === 100) completeCount += 1;

      details.push({
        target_date: targetDate,
        completion_percent: completionPercent,
        processed_types: finalProcessed.map((report) => report.reportTypeId),
        pending_types: REPORTS.filter((report) => !finalProcessed.includes(report)).map((report) => report.reportTypeId),
        requested,
      });
    }

    return Response.json({ ok: true, target_date: targetDate, accounts_checked: accounts.length, triggered_count: triggeredCount, complete_count: completeCount, future_jobs_blocked: futureJobsBlocked, details });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Falha ao verificar relatórios diários' }, { status: 500 });
  }
});
