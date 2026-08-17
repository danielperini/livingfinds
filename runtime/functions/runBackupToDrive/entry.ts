/**
 * runBackupToDrive — Backup incremental para Google Drive
 *
 * Lógica:
 * - Busca o último backup bem-sucedido para determinar o "since" (data de corte)
 * - Exporta apenas registros criados/atualizados DEPOIS do "since"
 * - Faz upload como JSON comprimido (GZIP) no Google Drive
 * - Registra o resultado no BackupAuditLog
 *
 * Para backup_type="manual" ou "weekly_full" ou "monthly_full": exporta tudo (since=null)
 * Para backup_type="daily_incremental": exporta apenas delta desde o último backup
 *
 * Estrutura: APP_BACKUPS_LivingFinds/{tipo}/{YYYY-MM-DD}/{EntityName}.json.gz
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { sleep, compress, findOrCreateFolder, upsertFileToDrive } from '../../shared/driveHelpers.ts';

// Entidades a incluir no backup — cobre todo o conhecimento de Ads para restauração completa
const ENTITIES_TO_BACKUP = [
  // ── Conta e configuração ─────────────────────────────────────────────
  'AmazonAccount', 'PerformanceSettings', 'AutopilotConfig', 'AppOptimizationConfig',
  'BudgetConfiguration', 'FeatureFlag',

  // ── Campanhas e estrutura ────────────────────────────────────────────
  'Campaign', 'AdGroup', 'Keyword', 'ProductTarget', 'ProductAd',
  'NegativeKeywordSuggestion', 'CampaignLearningState', 'CampaignMaturityEvaluation',

  // ── Métricas e performance ───────────────────────────────────────────
  'CampaignMetricsDaily', 'SalesDaily', 'HourlyMetric', 'UnifiedAdsMetricsDaily',
  'UnifiedAdsMetricsHourly', 'PerformanceTrendSnapshot', 'DailyBudgetLedger',
  'AccountDailySpendController', 'DailyProductAdsAssessment', 'WeeklyAdsPerformanceReport',
  'WeeklyProductPerformance',

  // ── Produtos e inventário ────────────────────────────────────────────
  'Product', 'ProductEconomics', 'ProductEconomicsHistory', 'ProductProfitabilityLearning',

  // ── Keywords e aprendizado ───────────────────────────────────────────
  'KeywordBank', 'ProductFamilyKeywordBank', 'TermBank', 'SearchTerm', 'SearchTermPromotion',
  'KeywordBidOptimizationCycle', 'ManualCampaignBidLifecycle', 'AutoCampaignLearning',
  'KeywordLifecycle', 'KeywordSuggestion',

  // ── Decisões e otimização ────────────────────────────────────────────
  'OptimizationDecision', 'DaypartingDecision', 'CrossAsinTransfer', 'CampaignFactoryPlan',
  'AdsBidChangeLog', 'CampaignBidHistory', 'CampaignChangeHistory',

  // ── Regras e motor ───────────────────────────────────────────────────
  'DecisionRule', 'DecisionRuleVersion', 'BiddingRule',
  'WeeklyMotorPrelection', 'StrategySession', 'StrategyStateSnapshot',

  // ── Listings ─────────────────────────────────────────────────────────
  'ListingSnapshot', 'ListingEnhancementProposal', 'ListingEnhancementHistory',

  // ── Logs e auditoria ─────────────────────────────────────────────────
  'SyncExecutionLog', 'AmazonAdsReportJob', 'BackupAuditLog',
  'ProductKickoffQueue', 'Alert',
];

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);

    const body = await req.json().catch(() => ({}));
    const backup_type: string = body.backup_type || 'daily_incremental';
    const isFullBackup = ['weekly_full', 'monthly_full', 'manual'].includes(backup_type);

    // Obter token do Google Drive
    const { accessToken: driveToken } = await base44.asServiceRole.connectors.getConnection('googledrive');
    if (!driveToken) {
      return Response.json({ ok: false, error: 'Google Drive não conectado' }, { status: 400 });
    }

    // Determinar "since" — data de corte para incremental
    let since: string | null = null;
    if (!isFullBackup) {
      const lastLogs = await base44.asServiceRole.entities.BackupAuditLog.filter(
        { operation: 'backup', status: 'completed' },
        '-completed_at',
        1
      ).catch(() => []);
      if (lastLogs.length > 0 && lastLogs[0].completed_at) {
        since = lastLogs[0].completed_at;
      }
    }

    console.log(`[Backup] Tipo: ${backup_type} | Since: ${since || 'tudo'} | Full: ${isFullBackup}`);

    const now = new Date().toISOString();
    const backupId = `bkp_${Date.now().toString(36)}`;
    const backupName = `backup_${backup_type}_${now.slice(0, 10)}_${backupId}`;

    const auditLog = await base44.asServiceRole.entities.BackupAuditLog.create({
      backup_id: backupId,
      operation: 'backup',
      backup_type,
      status: 'running',
      started_at: now,
      drive_backup_name: backupName,
      entities_included: ENTITIES_TO_BACKUP,
    }).catch(() => null);

    // Estrutura: APP_BACKUPS_LivingFinds/{tipo}/{YYYY-MM-DD}/{Entity}.json.gz
    const rootFolderId = await findOrCreateFolder('APP_BACKUPS_LivingFinds', 'root', driveToken);
    const typeFolder = isFullBackup
      ? (backup_type === 'monthly_full' ? 'monthly' : backup_type === 'weekly_full' ? 'weekly' : 'manual')
      : 'daily';
    const typeFolderId = await findOrCreateFolder(typeFolder, rootFolderId, driveToken);
    const targetFolderId = await findOrCreateFolder(now.slice(0, 10), typeFolderId, driveToken);

    let totalRecords = 0;
    let totalFiles = 0;
    const errors: string[] = [];

    for (const entityName of ENTITIES_TO_BACKUP) {
      try {
        let records: any[];
        if (since && !isFullBackup) {
          records = await base44.asServiceRole.entities[entityName].filter(
            { updated_date: { $gt: since } },
            '-updated_date',
            5000
          ).catch(() => []);
        } else {
          records = await base44.asServiceRole.entities[entityName].list('-updated_date', 5000).catch(() => []);
        }

        if (records.length === 0) {
          console.log(`[Backup] ${entityName}: 0 registros (sem delta)`);
          continue;
        }

        const fileName = `${entityName}.json.gz`;
        const compressed = await compress(JSON.stringify({ entity: entityName, since, records, exported_at: now }));
        await upsertFileToDrive(fileName, compressed, targetFolderId, driveToken);

        totalRecords += records.length;
        totalFiles++;
        console.log(`[Backup] ${entityName}: ${records.length} registros`);
        await sleep(100);
      } catch (e: any) {
        errors.push(`${entityName}: ${e.message}`);
        console.error(`[Backup] Erro em ${entityName}:`, e.message);
      }
    }

    // Manifesto em logs/
    const manifest = {
      backup_id: backupId,
      backup_type,
      backup_name: backupName,
      since,
      is_full: isFullBackup,
      total_records: totalRecords,
      total_files: totalFiles,
      entities: ENTITIES_TO_BACKUP,
      errors,
      exported_at: now,
      duration_ms: Date.now() - t0,
    };
    const manifestCompressed = await compress(JSON.stringify(manifest));
    const logsFolder = await findOrCreateFolder('logs', rootFolderId, driveToken);
    await upsertFileToDrive(`manifest_${backupName}.json.gz`, manifestCompressed, logsFolder, driveToken);

    const status = errors.length === 0 ? 'completed' : 'completed_with_warnings';
    if (auditLog?.id) {
      await base44.asServiceRole.entities.BackupAuditLog.update(auditLog.id, {
        status,
        completed_at: new Date().toISOString(),
        records_processed: totalRecords,
        files_processed: totalFiles,
        errors,
        drive_folder_id: targetFolderId,
      }).catch(() => {});
    }

    return Response.json({
      ok: true,
      backup_id: backupId,
      backup_name: backupName,
      backup_type,
      since,
      total_records: totalRecords,
      total_files: totalFiles,
      errors,
      status,
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    console.error('[Backup] Erro fatal:', err.message);
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});