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
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

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
  'DecisionRule', 'DecisionRuleVersion', 'BiddingRule', 'AutopilotConfig',
  'WeeklyMotorPrelection', 'StrategySession', 'StrategyStateSnapshot',

  // ── Listings ─────────────────────────────────────────────────────────
  'ListingSnapshot', 'ListingEnhancementProposal', 'ListingEnhancementHistory',

  // ── Logs e auditoria ─────────────────────────────────────────────────
  'SyncExecutionLog', 'AmazonAdsReportJob', 'BackupAuditLog',
  'ProductKickoffQueue', 'Alert',
];

async function compress(data: string): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  const encoded = new TextEncoder().encode(data);
  writer.write(encoded);
  writer.close();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return merged;
}

async function findOrCreateFolder(name: string, parentId: string, token: string): Promise<string> {
  // Buscar pasta existente
  const q = encodeURIComponent(`name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`);
  const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (searchRes.ok) {
    const data = await searchRes.json();
    if (data.files && data.files.length > 0) return data.files[0].id;
  }
  // Criar pasta
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  });
  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Erro criando pasta ${name}: HTTP ${createRes.status} — ${err.slice(0, 200)}`);
  }
  const d = await createRes.json();
  return d.id;
}

async function uploadFileToDrive(name: string, content: Uint8Array, folderId: string, token: string): Promise<string> {
  // Verificar se já existe arquivo com o mesmo nome (para update incremental)
  const q = encodeURIComponent(`name='${name}' and '${folderId}' in parents and trashed=false`);
  const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  
  if (searchRes.ok) {
    const existing = await searchRes.json();
    if (existing.files && existing.files.length > 0) {
      // Atualizar arquivo existente (PATCH)
      const fileId = existing.files[0].id;
      const updateRes = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/gzip' },
        body: content,
      });
      if (!updateRes.ok) throw new Error(`Erro atualizando arquivo ${name}: HTTP ${updateRes.status}`);
      return fileId;
    }
  }

  // Criar novo arquivo (multipart upload)
  const boundary = '-------314159265358979323846';
  const metadata = JSON.stringify({ name, parents: [folderId] });
  const metaPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`;
  const dataPart = `--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`;
  const closing = `\r\n--${boundary}--`;

  const metaBytes = new TextEncoder().encode(metaPart);
  const dataLabelBytes = new TextEncoder().encode(dataPart);
  const closingBytes = new TextEncoder().encode(closing);
  const body = new Uint8Array(metaBytes.length + dataLabelBytes.length + content.length + closingBytes.length);
  let off = 0;
  body.set(metaBytes, off); off += metaBytes.length;
  body.set(dataLabelBytes, off); off += dataLabelBytes.length;
  body.set(content, off); off += content.length;
  body.set(closingBytes, off);

  const uploadRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': `multipart/related; boundary="${boundary}"` },
    body,
  });
  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Erro fazendo upload de ${name}: HTTP ${uploadRes.status} — ${err.slice(0, 200)}`);
  }
  const d = await uploadRes.json();
  return d.id;
}

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

    // Criar log de início
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

    // Garantir estrutura de pastas no Drive
    // Estrutura: APP_BACKUPS_LivingFinds / {tipo} / {YYYY-MM-DD}
    const rootFolderId = await findOrCreateFolder('APP_BACKUPS_LivingFinds', 'root', driveToken);
    const typeFolder = isFullBackup
      ? (backup_type === 'monthly_full' ? 'monthly' : backup_type === 'weekly_full' ? 'weekly' : 'manual')
      : 'daily';
    const typeFolderId = await findOrCreateFolder(typeFolder, rootFolderId, driveToken);
    // Subpasta por data — cada dia tem seus próprios arquivos isolados e restauráveis
    const targetFolderId = await findOrCreateFolder(now.slice(0, 10), typeFolderId, driveToken);

    // Exportar entidades
    let totalRecords = 0;
    let totalFiles = 0;
    const errors: string[] = [];

    for (const entityName of ENTITIES_TO_BACKUP) {
      try {
        let records: any[];
        if (since && !isFullBackup) {
          // Incremental: apenas registros atualizados depois do "since"
          records = await base44.asServiceRole.entities[entityName].filter(
            { updated_date: { $gt: since } },
            '-updated_date',
            5000
          ).catch(() => []);
        } else {
          // Full: todos os registros
          records = await base44.asServiceRole.entities[entityName].list('-updated_date', 5000).catch(() => []);
        }

        if (records.length === 0) {
          console.log(`[Backup] ${entityName}: 0 registros (sem delta)`);
          continue;
        }

        // Comprimir e fazer upload — nome sem data (já está na pasta por data)
        const fileName = `${entityName}.json.gz`;
        const compressed = await compress(JSON.stringify({ entity: entityName, since, records, exported_at: now }));
        await uploadFileToDrive(fileName, compressed, targetFolderId, driveToken);

        totalRecords += records.length;
        totalFiles++;
        console.log(`[Backup] ${entityName}: ${records.length} registros`);
        await sleep(100);
      } catch (e: any) {
        errors.push(`${entityName}: ${e.message}`);
        console.error(`[Backup] Erro em ${entityName}:`, e.message);
      }
    }

    // Criar manifesto
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
    await uploadFileToDrive(`manifest_${backupName}.json.gz`, manifestCompressed, logsFolder, driveToken);

    // Atualizar log de conclusão
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