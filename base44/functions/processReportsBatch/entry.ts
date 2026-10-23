/**
 * Legacy Amazon Ads batch importer disabled intentionally.
 *
 * The former implementation deleted every AdsMetricsHistory, SearchTerm,
 * CampaignMetricsDaily and AdsReportRaw row for an account before a replacement
 * import had completed. There are no callers for this function in the current
 * repository. New report ingestion must use requestAdsReport and
 * downloadAndProcessAmazonAdsReportJob, which scope writes by report/date.
 */
Deno.serve(() => Response.json({
  ok: false,
  error: 'legacy_report_batch_disabled',
  message: 'Este importador legado foi desativado porque substituía o histórico integral da conta. Use a fila canônica de relatórios Amazon Ads.',
  canonical_flow: ['requestAdsReport', 'pollAmazonAdsReportJobs', 'downloadAndProcessAmazonAdsReportJob'],
}, { status: 410 }));
