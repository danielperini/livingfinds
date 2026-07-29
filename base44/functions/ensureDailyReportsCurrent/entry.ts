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

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });
    }

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
      const recentJobs = await base44.asServiceRole.entities.AmazonAdsReportJob.filter(
        { amazon_account_id: account.id }, '-created_date', 250,
      ).catch(() => []);

      // Impede que a virada UTC solicite/processe o dia ainda aberto no Brasil.
      const futureJobs = recentJobs.filter((job: any) =>
        job.end_date > targetDate && ['pending','requested','in_progress','processing','completed'].includes(job.status)
      );
      for (const job of futureJobs) {
        await base44.asServiceRole.entities.AmazonAdsReportJob.update(job.id, {
          status: 'stale',
          error_message: `Bloqueado: ${job.end_date} ainda não é um dia fechado no fuso America/Sao_Paulo`,
          poll_in_progress: false,
        }).catch(() => null);
        futureJobsBlocked += 1;
      }

      const targetJobs = recentJobs.filter((job: any) => job.end_date === targetDate);
      const presentTypes = new Set(targetJobs.map((job: any) => job.report_type_id).filter(Boolean));
      const missingReports = REPORTS.filter((report) => !presentTypes.has(report.reportTypeId));
      const requested: Array<Record<string, unknown>> = [];

      for (const report of missingReports) {
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
          report_name: `LivingFinds_${report.key}_${targetDate}`,
          source_function: 'ensureDailyReportsCurrent',
          _service_role: true,
        });
        const result = response?.data ?? response ?? {};
        requested.push({
          report_type_id: report.reportTypeId,
          ok: result?.ok !== false,
          reused: result?.reused ?? false,
          status: result?.status ?? null,
          error: result?.error ?? null,
        });
      }

      if (missingReports.length > 0) {
        triggeredCount += 1;
        await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
          last_reports_requested_at: new Date().toISOString(),
        }).catch(() => null);
      } else {
        completeCount += 1;
      }

      await base44.asServiceRole.functions.invoke('pollAmazonAdsReportJobs', {
        amazon_account_id: account.id,
        max_jobs: 20,
        _service_role: true,
      }).catch(() => null);

      details.push({
        target_date: targetDate,
        triggered: missingReports.length > 0,
        missing_before: missingReports.map((report) => report.reportTypeId),
        requested,
        jobs_found_before: targetJobs.length,
      });
    }

    return Response.json({
      ok: true,
      target_date: targetDate,
      accounts_checked: accounts.length,
      triggered_count: triggeredCount,
      already_complete_count: completeCount,
      future_jobs_blocked: futureJobsBlocked,
      details,
    });
  } catch (error) {
    return Response.json({
      ok: false,
      error: error?.message || 'Falha ao verificar relatórios diários',
    }, { status: 500 });
  }
});
