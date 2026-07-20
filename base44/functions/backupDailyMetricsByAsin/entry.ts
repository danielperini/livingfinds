/**
 * backupDailyMetricsByAsin — Backup diário de métricas operacionais por ASIN
 *
 * Estrutura no Drive:
 *   APP_BACKUPS_LivingFinds/daily/{ASIN}/{YYYY-MM-DD}/metrics.json.gz
 *   APP_BACKUPS_LivingFinds/daily/_manifesto/{YYYY-MM-DD}.json.gz
 *
 * Dados por ASIN (dia anterior em BRT):
 *   - Campanhas + CampaignMetricsDaily
 *   - Keywords + AdsBidChangeLog + KeywordBidOptimizationCycle + ManualCampaignBidLifecycle
 *   - Product + ProductEconomics + DailyProductAdsAssessment
 *   - OptimizationDecision + DaypartingDecision
 *
 * Idempotente: PATCH se o arquivo já existe no Drive.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { sleep, compress, findOrCreateFolder, upsertFileToDrive } from '../../shared/driveHelpers.ts';

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Token Google Drive
    const { accessToken: driveToken } = await base44.asServiceRole.connectors.getConnection('googledrive');
    if (!driveToken) return Response.json({ ok: false, error: 'Google Drive não conectado' }, { status: 400 });

    // Resolver conta
    let account: any;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1);
      account = accs[0];
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon conectada' }, { status: 404 });
    const aid = account.id;

    // Data do dia anterior em BRT
    const nowBRT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const yesterdayBRT = new Date(nowBRT);
    yesterdayBRT.setDate(yesterdayBRT.getDate() - 1);
    const targetDate = yesterdayBRT.toISOString().slice(0, 10);
    const dayStart = `${targetDate}T00:00:00.000Z`;
    const dayEnd = `${targetDate}T23:59:59.999Z`;

    console.log(`[BackupByAsin] Conta: ${aid} | Data alvo: ${targetDate}`);

    // Buscar ASINs ativos
    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 500).catch(() => []);
    const activeProducts = products.filter((p: any) => p.status !== 'archived' && p.asin);
    const asins: string[] = [...new Set(activeProducts.map((p: any) => p.asin as string))];

    if (asins.length === 0) {
      return Response.json({ ok: true, skipped: true, reason: 'Nenhum ASIN ativo encontrado' });
    }

    // Estrutura de pastas no Drive
    const rootFolderId = await findOrCreateFolder('APP_BACKUPS_LivingFinds', 'root', driveToken);
    const dailyFolderId = await findOrCreateFolder('daily', rootFolderId, driveToken);

    // Pré-carregar dados globais da conta uma única vez
    const [
      allCampaigns,
      allMetricsDaily,
      allKeywords,
      allBidChangeLogs,
      allKwOptCycles,
      allManualLifecycles,
      allOptDecisions,
      allDaypartDecisions,
      allAssessments,
      allEconomics,
    ] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 1000).catch(() => []),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 2000).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, null, 2000).catch(() => []),
      base44.asServiceRole.entities.AdsBidChangeLog.filter({ amazon_account_id: aid }, '-created_at', 2000).catch(() => []),
      base44.asServiceRole.entities.KeywordBidOptimizationCycle.filter({ amazon_account_id: aid }, '-created_at', 1000).catch(() => []),
      base44.asServiceRole.entities.ManualCampaignBidLifecycle.filter({ amazon_account_id: aid }, '-created_at', 500).catch(() => []),
      base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: aid }, '-created_at', 1000).catch(() => []),
      base44.asServiceRole.entities.DaypartingDecision.filter({ amazon_account_id: aid }, '-created_at', 1000).catch(() => []),
      base44.asServiceRole.entities.DailyProductAdsAssessment.filter({ amazon_account_id: aid, assessment_date: targetDate }, null, 500).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
    ]);

    // Índices para lookups O(1) por ASIN / campaign_id
    const campaignsByAsin = new Map<string, any[]>();
    for (const c of allCampaigns) {
      if (!c.asin) continue;
      if (!campaignsByAsin.has(c.asin)) campaignsByAsin.set(c.asin, []);
      campaignsByAsin.get(c.asin)!.push(c);
    }

    const metricsByCampaign = new Map<string, any[]>();
    for (const m of allMetricsDaily) {
      if (m.date !== targetDate) continue;
      const key = m.campaign_id || m.amazon_campaign_id;
      if (!key) continue;
      if (!metricsByCampaign.has(key)) metricsByCampaign.set(key, []);
      metricsByCampaign.get(key)!.push(m);
    }

    const keywordsByCampaign = new Map<string, any[]>();
    for (const k of allKeywords) {
      if (!k.campaign_id) continue;
      if (!keywordsByCampaign.has(k.campaign_id)) keywordsByCampaign.set(k.campaign_id, []);
      keywordsByCampaign.get(k.campaign_id)!.push(k);
    }

    function indexByAsin(items: any[], dateField: string, filterDate: boolean = true): Map<string, any[]> {
      const map = new Map<string, any[]>();
      for (const item of items) {
        if (filterDate) {
          const ts = item[dateField] || item.created_date || '';
          if (ts < dayStart || ts > dayEnd) continue;
        }
        if (!item.asin) continue;
        if (!map.has(item.asin)) map.set(item.asin, []);
        map.get(item.asin)!.push(item);
      }
      return map;
    }

    const bidLogsByAsin = indexByAsin(allBidChangeLogs, 'created_at');
    const kwCyclesByAsin = indexByAsin(allKwOptCycles, 'created_at');
    const lifeCyclesByAsin = indexByAsin(allManualLifecycles, 'created_at');
    const optDecisionsByAsin = indexByAsin(allOptDecisions, 'created_at');

    const daypartByAsin = new Map<string, any[]>();
    for (const d of allDaypartDecisions) {
      if (d.cycle_date !== targetDate || !d.asin) continue;
      if (!daypartByAsin.has(d.asin)) daypartByAsin.set(d.asin, []);
      daypartByAsin.get(d.asin)!.push(d);
    }

    const assessmentsByAsin = new Map<string, any>();
    for (const a of allAssessments) { if (a.asin) assessmentsByAsin.set(a.asin, a); }
    const economicsByAsin = new Map<string, any>();
    for (const e of allEconomics) { if (e.asin) economicsByAsin.set(e.asin, e); }
    const productByAsin = new Map<string, any>();
    for (const p of activeProducts) { productByAsin.set(p.asin, p); }

    // Processar cada ASIN
    const results: any[] = [];
    const errors: Record<string, string> = {};
    let totalRecords = 0;

    for (const asin of asins) {
      try {
        const campaigns = campaignsByAsin.get(asin) || [];
        const campaignIds = campaigns.map((c: any) => c.campaign_id || c.amazon_campaign_id).filter(Boolean);

        const metricsDaily: any[] = [];
        const keywords: any[] = [];
        for (const cid of campaignIds) {
          metricsDaily.push(...(metricsByCampaign.get(cid) || []));
          keywords.push(...(keywordsByCampaign.get(cid) || []));
        }

        const bidLogs = bidLogsByAsin.get(asin) || [];
        const kwCycles = kwCyclesByAsin.get(asin) || [];
        const lifeCycles = lifeCyclesByAsin.get(asin) || [];
        const optDecisions = optDecisionsByAsin.get(asin) || [];
        const daypartDecisions = daypartByAsin.get(asin) || [];
        const assessment = assessmentsByAsin.get(asin) || null;
        const economics = economicsByAsin.get(asin) || null;
        const product = productByAsin.get(asin) || null;

        const recordCount =
          campaigns.length + metricsDaily.length + keywords.length +
          bidLogs.length + kwCycles.length + lifeCycles.length +
          optDecisions.length + daypartDecisions.length +
          (assessment ? 1 : 0) + (economics ? 1 : 0);

        // Sem dados operacionais no dia → skip silencioso
        if (recordCount === 0) {
          results.push({ asin, status: 'skipped', reason: 'no_data_for_date' });
          continue;
        }

        const payload = {
          asin,
          amazon_account_id: aid,
          target_date: targetDate,
          exported_at: new Date().toISOString(),
          product,
          economics,
          assessment,
          campaigns,
          metrics_daily: metricsDaily,
          keywords,
          bid_change_logs: bidLogs,
          keyword_optimization_cycles: kwCycles,
          manual_bid_lifecycles: lifeCycles,
          optimization_decisions: optDecisions,
          dayparting_decisions: daypartDecisions,
          record_counts: {
            campaigns: campaigns.length,
            metrics_daily: metricsDaily.length,
            keywords: keywords.length,
            bid_change_logs: bidLogs.length,
            keyword_optimization_cycles: kwCycles.length,
            manual_bid_lifecycles: lifeCycles.length,
            optimization_decisions: optDecisions.length,
            dayparting_decisions: daypartDecisions.length,
          },
        };

        const compressed = await compress(JSON.stringify(payload));

        // Estrutura: daily/{ASIN}/{YYYY-MM-DD}/metrics.json.gz
        const asinFolderId = await findOrCreateFolder(asin, dailyFolderId, driveToken);
        const dateFolderId = await findOrCreateFolder(targetDate, asinFolderId, driveToken);
        await upsertFileToDrive('metrics.json.gz', compressed, dateFolderId, driveToken);

        totalRecords += recordCount;
        results.push({ asin, status: 'ok', records: recordCount });
        console.log(`[BackupByAsin] ${asin}: ${recordCount} registros → Drive`);
        await sleep(200);
      } catch (e: any) {
        errors[asin] = e.message;
        results.push({ asin, status: 'error', error: e.message });
        console.error(`[BackupByAsin] Erro em ${asin}:`, e.message);
      }
    }

    // Manifesto: daily/_manifesto/{YYYY-MM-DD}.json.gz
    const manifest = {
      backup_type: 'daily_metrics_by_asin',
      amazon_account_id: aid,
      target_date: targetDate,
      exported_at: new Date().toISOString(),
      asins_processed: results.filter(r => r.status === 'ok').length,
      asins_skipped: results.filter(r => r.status === 'skipped').length,
      asins_failed: Object.keys(errors).length,
      total_records: totalRecords,
      results,
      errors,
      duration_ms: Date.now() - t0,
    };
    const manifestFolderId = await findOrCreateFolder('_manifesto', dailyFolderId, driveToken);
    await upsertFileToDrive(`${targetDate}.json.gz`, await compress(JSON.stringify(manifest)), manifestFolderId, driveToken);

    // Registrar no BackupAuditLog
    const hasErrors = Object.keys(errors).length > 0;
    const status = hasErrors ? 'completed_with_warnings' : 'completed';
    await base44.asServiceRole.entities.BackupAuditLog.create({
      backup_id: `daily_metrics_${targetDate}_${Date.now().toString(36)}`,
      operation: 'backup',
      backup_type: 'daily_metrics_by_asin',
      status,
      started_at: new Date(t0).toISOString(),
      completed_at: new Date().toISOString(),
      records_processed: totalRecords,
      files_processed: results.filter(r => r.status === 'ok').length,
      errors: Object.entries(errors).map(([asin, msg]) => `${asin}: ${msg}`),
      drive_backup_name: `daily_metrics_${targetDate}`,
    }).catch(() => {});

    return Response.json({
      ok: true,
      target_date: targetDate,
      asins_total: asins.length,
      asins_processed: results.filter(r => r.status === 'ok').length,
      asins_skipped: results.filter(r => r.status === 'skipped').length,
      asins_failed: Object.keys(errors).length,
      total_records: totalRecords,
      status,
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    console.error('[BackupByAsin] Erro fatal:', err.message);
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});