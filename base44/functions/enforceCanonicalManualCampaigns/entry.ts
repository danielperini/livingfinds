/**
 * enforceCanonicalManualCampaigns v3 — Migração Canônica Transacional
 *
 * REGRA ABSOLUTA: 1 campanha manual = 1 ASIN = 1 Ad Group = 1 Product Ad = 1 keyword EXACT
 *
 * Detecção ampliada:
 * - Campanhas com 2+ keywords EXACT no banco local
 * - Campanhas cujo nome contém padrão '+N' (ex: '+3', '+5') indicando múltiplas keywords
 * - Auditoria via Amazon Ads API quando keywords_count > 1 ou nome suspeito
 *
 * FLUXO TRANSACIONAL:
 * 1. Detectar campanhas multi-keyword (banco local + API Amazon + padrão nome)
 * 2. Para cada keyword extra: verificar idempotência, criar nova campanha, confirmar
 * 3. SOMENTE quando TODAS confirmadas: arquivar a original
 * 4. Se qualquer falha: manter original ativa, enfileirar retry 15/30/60min
 * 5. Negativar cada termo na campanha AUTO do mesmo ASIN (fire-and-forget)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const INITIAL_BID    = 0.50;
const MIN_BUDGET     = 9.00;
const MAX_PER_RUN    = 10;
const SLEEP_BETWEEN  = 5000;
const MAX_RETRIES    = 3;
const BACKOFF_MINUTES = [15, 30, 60];

const CT_CAMPAIGN = 'application/vnd.spCampaign.v3+json';
const CT_KEYWORD  = 'application/vnd.spKeyword.v3+json';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Helpers ──────────────────────────────────────────────────────────────────

function normTerm(value: any): string {
  return String(value || '')
    .replace(/\+\d+\s*$/i, '') // remover sufixo +N
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isActive(v: any): boolean {
  return ['active', 'enabled'].includes(String(v || '').toLowerCase());
}

function isManualCampaign(c: any): boolean {
  const type = String(c.targeting_type || c.targetingType || '').toLowerCase();
  const name = String(c.name || c.campaign_name || '').toLowerCase();
  return type === 'manual' || name.includes('| manual |');
}

function isExactKeyword(k: any): boolean {
  return String(k.match_type || k.matchType || '').toLowerCase() === 'exact';
}

function kwText(k: any): string {
  return String(k.keyword_text || k.keyword || '').trim();
}

function campaignIdStr(c: any): string {
  return String(c.campaign_id || c.amazon_campaign_id || '');
}

/** Detectar padrão +N no nome da campanha */
function hasMultiKeywordSuffix(name: string): boolean {
  return /\+\d+\s*$/i.test(String(name || '').trim());
}

function canonicalKey(accountId: string, asin: string, keyword: string): string {
  return `${accountId}|${asin.toUpperCase()}|${normTerm(keyword)}|exact`;
}

function extractKeywordFromName(name: string): string {
  const parts = name.split('|').map((p: string) => p.trim());
  if (parts.length >= 5) return parts.slice(4).join(' | ');
  return '';
}

// ── Invoke helper ─────────────────────────────────────────────────────────────

async function invoke(base44: any, fn: string, payload: any): Promise<any> {
  const res = await base44.asServiceRole.functions.invoke(fn, payload);
  return res?.data || res || {};
}

// ── Buscar keywords da Amazon API para uma campanha ───────────────────────────

async function fetchKeywordsFromAmazon(base44: any, accountId: string, campaignId: string): Promise<any[]> {
  try {
    const res = await invoke(base44, 'amazonAdsCommand', {
      amazon_account_id: accountId,
      operation: 'listKeywordsForAudit',
      method: 'POST',
      path: '/sp/keywords/list',
      payload: {
        campaignIdFilter: { include: [campaignId] },
        stateFilter: { include: ['ENABLED', 'PAUSED'] },
        maxResults: 100,
      },
      content_type: CT_KEYWORD,
      accept: CT_KEYWORD,
      _service_role: true,
    });
    const payload = res?.payload || res?.data || res || {};
    return payload?.keywords || [];
  } catch {
    return [];
  }
}

// ── Arquivar campanha na Amazon ───────────────────────────────────────────────

async function archiveCampaignOnAmazon(base44: any, accountId: string, amazonCampaignId: string): Promise<boolean> {
  try {
    await invoke(base44, 'amazonAdsCommand', {
      amazon_account_id: accountId,
      operation: 'archiveCanonicalMigration',
      method: 'PUT',
      path: '/sp/campaigns',
      payload: { campaigns: [{ campaignId: amazonCampaignId, state: 'ARCHIVED' }] },
      content_type: CT_CAMPAIGN,
      accept: CT_CAMPAIGN,
      max_attempts: 3,
      _service_role: true,
    });
    return true;
  } catch {
    return false;
  }
}

// ── Verificar se já existe campanha canônica ──────────────────────────────────

function findExistingCanonical(campaigns: any[], accountId: string, asin: string, keyword: string): any | null {
  return campaigns.find((c: any) => {
    if (!isManualCampaign(c)) return false;
    if (String(c.asin || '').toUpperCase() !== asin.toUpperCase()) return false;
    if (['archived'].includes(String(c.state || c.status || '').toLowerCase())) return false;
    const norm = normTerm(kwText({ keyword_text: extractKeywordFromName(c.name || c.campaign_name || '') }));
    return norm === normTerm(keyword);
  }) || null;
}

// ── Enfileirar retry ──────────────────────────────────────────────────────────

async function enqueueRetry(
  base44: any,
  accountId: string,
  sourceCampaignId: string,
  asin: string,
  keyword: string,
  attemptCount: number,
): Promise<void> {
  if (attemptCount >= MAX_RETRIES) {
    await invoke(base44, 'upsertOperationalAlert', {
      amazon_account_id: accountId,
      alert_type: 'sync_error',
      severity: 'high',
      title: `Migração canônica falhou após ${MAX_RETRIES} tentativas`,
      message: `ASIN ${asin} · keyword "${keyword}" · campanha origem ${sourceCampaignId}`,
      source_function: 'enforceCanonicalManualCampaigns',
      _service_role: true,
    }).catch(() => {});
    return;
  }

  const backoffMinutes = BACKOFF_MINUTES[attemptCount] || 60;
  const retryAfter = new Date(Date.now() + backoffMinutes * 60000).toISOString();
  const idKey = `canonical_retry|${accountId}|${asin.toUpperCase()}|${normTerm(keyword)}`;

  const existing = await base44.asServiceRole.entities.AmazonActionQueue.filter(
    { amazon_account_id: accountId, idempotency_key: idKey, status: 'pending' }, '-created_date', 1
  ).catch(() => []);

  if (existing[0]) {
    await base44.asServiceRole.entities.AmazonActionQueue.update(existing[0].id, {
      attempt_count: attemptCount + 1,
      retry_after: retryAfter,
    }).catch(() => {});
    return;
  }

  await base44.asServiceRole.entities.AmazonActionQueue.create({
    amazon_account_id: accountId,
    action_type: 'migrate_keyword_canonical',
    status: 'pending',
    priority: 'high',
    payload: JSON.stringify({ source_campaign_id: sourceCampaignId, asin, keyword_text: keyword, attempt_count: attemptCount }),
    retry_after: retryAfter,
    attempt_count: attemptCount,
    max_attempts: MAX_RETRIES,
    idempotency_key: idKey,
    source_function: 'enforceCanonicalManualCampaigns',
    created_at: new Date().toISOString(),
  }).catch(() => {});
}

// ── Criar campanha canônica para uma keyword ──────────────────────────────────

async function createCanonicalCampaign(
  base44: any,
  accountId: string,
  asin: string,
  keyword: string,
  budget: number,
  sku: string | null,
  initialState: 'enabled' | 'paused' = 'enabled',
): Promise<{ ok: boolean; campaign_id?: string; already_exists?: boolean; error?: string }> {
  const result = await invoke(base44, 'createManualCampaignV2', {
    amazon_account_id: accountId,
    asin,
    keyword,
    bid: INITIAL_BID,
    budget: Math.max(MIN_BUDGET, budget),
    sku: sku || undefined,
    initial_state: initialState,
    _service_role: true,
  });

  if (result.ok || result.already_exists || result.blocked_duplicate) {
    return {
      ok: true,
      already_exists: !!(result.already_exists || result.blocked_duplicate),
      campaign_id: result.campaign_id || result.existing_campaign_id,
    };
  }

  if (result.blocked && result.reason === 'out_of_stock') {
    return { ok: false, error: 'out_of_stock_terminal' };
  }

  return { ok: false, error: result.error || 'Falha na criação' };
}

// ── Negativar na AUTO (fire-and-forget) ──────────────────────────────────────

function negateInAuto(base44: any, accountId: string, asin: string, keyword: string): void {
  invoke(base44, 'negateKeywordInAutoCampaign', {
    amazon_account_id: accountId,
    asin,
    keyword_text: keyword,
    match_type: 'NEGATIVE_EXACT',
    _service_role: true,
  }).catch(() => {});
}

// ── Processar retries pendentes ───────────────────────────────────────────────

async function processRetryQueue(base44: any, accountId: string, campaigns: any[], report: any): Promise<void> {
  const now = new Date().toISOString();
  const pending = await base44.asServiceRole.entities.AmazonActionQueue.filter(
    { amazon_account_id: accountId, action_type: 'migrate_keyword_canonical', status: 'pending' },
    'retry_after', 100,
  ).catch(() => []);

  const due = pending.filter((item: any) => !item.retry_after || item.retry_after <= now);
  if (due.length === 0) return;

  for (const item of due.slice(0, 5)) {
    let payload: any = {};
    try { payload = JSON.parse(item.payload || '{}'); } catch { continue; }

    const { source_campaign_id, asin, keyword_text, attempt_count = 0 } = payload;
    if (!asin || !keyword_text) continue;

    const alreadyExists = findExistingCanonical(campaigns, accountId, asin, keyword_text);
    if (alreadyExists) {
      await base44.asServiceRole.entities.AmazonActionQueue.update(item.id, {
        status: 'completed',
        completed_at: now,
        result: JSON.stringify({ resolved_externally: true }),
      }).catch(() => {});
      report.retry_resolved.push({ asin, keyword: keyword_text, by: 'external' });
      continue;
    }

    const srcCampaigns = campaigns.filter((c: any) => campaignIdStr(c) === source_campaign_id);
    const budget = Number(srcCampaigns[0]?.daily_budget || MIN_BUDGET);
    const sku = srcCampaigns[0]?.sku || null;

    const result = await createCanonicalCampaign(base44, accountId, asin, keyword_text, budget, sku);

    if (result.ok) {
      negateInAuto(base44, accountId, asin, keyword_text);
      await base44.asServiceRole.entities.AmazonActionQueue.update(item.id, {
        status: 'completed',
        completed_at: now,
        result: JSON.stringify({ campaign_id: result.campaign_id }),
      }).catch(() => {});
      report.retry_resolved.push({ asin, keyword: keyword_text, campaign_id: result.campaign_id });
    } else {
      if (result.error === 'out_of_stock_terminal') {
        await base44.asServiceRole.entities.AmazonActionQueue.update(item.id, {
          status: 'failed',
          result: JSON.stringify({ reason: 'out_of_stock_terminal' }),
        }).catch(() => {});
      } else {
        await enqueueRetry(base44, accountId, source_campaign_id, asin, keyword_text, attempt_count + 1);
        report.retry_failed.push({ asin, keyword: keyword_text, attempt: attempt_count + 1, error: result.error });
      }
    }
    await sleep(3000);
  }
}

// ── MAIN ─────────────────────────────────────────────────────────────────────

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();

  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'AmazonAccount conectada não encontrada' }, { status: 404 });

    const accountId = account.id;

    const [campaigns, keywords, products] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-created_at', 5000).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-created_at', 15000).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, null, 2000).catch(() => []),
    ]);

    const productByAsin = new Map(products.filter((p: any) => p.asin).map((p: any) => [String(p.asin).toUpperCase(), p]));

    const kwByCampaign = new Map<string, any[]>();
    for (const kw of keywords) {
      const cid = String(kw.campaign_id || '');
      if (!cid) continue;
      const state = String(kw.state || kw.status || '').toLowerCase();
      if (state === 'archived') continue;
      if (!kwByCampaign.has(cid)) kwByCampaign.set(cid, []);
      kwByCampaign.get(cid)!.push(kw);
    }

    // ── Detecção ampliada: banco local + padrão nome +N ───────────────────────
    // Inclui campanhas PAUSADAS com múltiplas keywords ou sufixo +N (PRD v4)
    const manualActive = campaigns.filter((c: any) => {
      if (!isManualCampaign(c)) return false;
      const state = String(c.state || c.status || '').toLowerCase();
      if (state === 'archived') return false;
      // Pausadas só entram se tiverem múltiplas keywords (verificado abaixo)
      return true;
    });

    const multiKeywordCampaigns: any[] = [];
    const auditViaApi: any[] = []; // campanhas suspeitas que precisam verificação na Amazon API

    for (const c of manualActive) {
      const cid = campaignIdStr(c);
      const allKws = kwByCampaign.get(cid) || [];
      const exactKws = allKws.filter(isExactKeyword);
      const campaignName = String(c.name || c.campaign_name || '');
      const state = String(c.state || c.status || '').toLowerCase();
      const isPaused = state === 'paused';

      // Campanhas PAUSADAS só entram se tiverem evidência de múltiplas keywords
      // (padrão +N no nome OU keyword_count > 1 OU 2+ keywords no banco)
      const hasMkEvidence = exactKws.length >= 2 || hasMultiKeywordSuffix(campaignName) || (c.keyword_count || 0) > 1;
      if (isPaused && !hasMkEvidence) continue;

      // Detecção 1: banco local tem 2+ keywords EXACT
      if (exactKws.length >= 2) {
        multiKeywordCampaigns.push({ campaign: c, cid, exactKws, asin: String(c.asin || '').toUpperCase(), source: 'local_db', was_paused: isPaused });
        continue;
      }

      // Detecção 2: nome contém padrão +N (ex: "SP | MANUAL | EXACT | ASIN | termo +3")
      if (hasMultiKeywordSuffix(campaignName)) {
        auditViaApi.push({ campaign: c, cid, localKws: exactKws, asin: String(c.asin || '').toUpperCase(), was_paused: isPaused });
        continue;
      }

      // Detecção 3: campo keywords_count > 1 se disponível
      if ((c.keyword_count || 0) > 1) {
        auditViaApi.push({ campaign: c, cid, localKws: exactKws, asin: String(c.asin || '').toUpperCase(), was_paused: isPaused });
      }
    }

    // ── Auditar via Amazon API campanhas suspeitas ────────────────────────────
    for (const item of auditViaApi.slice(0, 5)) {
      const apiKws = await fetchKeywordsFromAmazon(base44, accountId, item.cid);
      const exactApiKws = apiKws.filter((k: any) =>
        String(k.matchType || k.match_type || '').toLowerCase() === 'exact' &&
        String(k.state || '').toUpperCase() !== 'ARCHIVED'
      );
      if (exactApiKws.length >= 2) {
        // Converter keywords da API para formato local
        const mappedKws = exactApiKws.map((k: any) => ({
          keyword_text: k.keywordText || k.keyword_text || '',
          keyword: k.keywordText || k.keyword_text || '',
          match_type: 'exact',
          orders: 0,
          keyword_id: k.keywordId,
        }));
        multiKeywordCampaigns.push({
          campaign: item.campaign,
          cid: item.cid,
          exactKws: mappedKws,
          asin: item.asin,
          source: 'amazon_api',
        });
      }
      await sleep(1000);
    }

    const report: any = {
      ok: true,
      campaigns_scanned: manualActive.length,
      campaigns_already_canonical: manualActive.length - multiKeywordCampaigns.length,
      campaigns_multi_keyword_found: multiKeywordCampaigns.length,
      campaigns_migrated: [],
      campaigns_pending_retry: [],
      keywords_created: [],
      keywords_skipped_already_exists: [],
      keywords_failed: [],
      retry_resolved: [],
      retry_failed: [],
      errors: [],
      started_at: startedAt,
      canonical_rule: '1_campaign_1_asin_1_adgroup_1_productad_1_exact_keyword',
    };

    await processRetryQueue(base44, accountId, campaigns, report);

    let processed = 0;
    for (const item of multiKeywordCampaigns) {
      if (processed >= MAX_PER_RUN) break;

      const { campaign, cid, exactKws, asin, was_paused } = item;
      if (!asin) {
        report.errors.push({ campaign_id: cid, reason: 'missing_asin' });
        continue;
      }

      const product = productByAsin.get(asin);
      if (!product || product.inventory_status === 'out_of_stock' || Number(product.fba_inventory ?? 0) <= 0) {
        report.errors.push({ campaign_id: cid, asin, reason: 'out_of_stock' });
        continue;
      }

      const keywordsFound = exactKws.length;
      const sourceBudget = Number(campaign.daily_budget || campaign.budget || MIN_BUDGET);
      // Budget proporcional: distribuir entre as novas campanhas
      const budgetPerCampaign = Math.max(MIN_BUDGET, Math.round((sourceBudget / keywordsFound) * 100) / 100);
      const sku = campaign.sku || product?.sku || null;

      // Identificar keyword raiz (corresponde ao nome da campanha)
      const normalizedCampaignName = normTerm(campaign.name || campaign.campaign_name || '');
      const sorted = [...exactKws].sort((a: any, b: any) => {
        const aNorm = normTerm(kwText(a));
        const bNorm = normTerm(kwText(b));
        const aMatch = normalizedCampaignName.endsWith(aNorm) ? 1 : 0;
        const bMatch = normalizedCampaignName.endsWith(bNorm) ? 1 : 0;
        if (aMatch !== bMatch) return bMatch - aMatch;
        return Number(b.orders || 0) - Number(a.orders || 0);
      });

      const [rootKw, ...extraKws] = sorted;
      if (extraKws.length === 0) continue;

      const migrationGroup: any = {
        source_campaign_id: cid,
        source_local_id: campaign.id,
        asin,
        root_keyword: kwText(rootKw),
        keywords_found: keywordsFound,
        total_to_migrate: extraKws.length,
        created: [] as any[],
        already_existed: [] as any[],
        failed: [] as any[],
        duplicates_blocked: 0,
      };

      // Deduplicar por normalized_term
      const seenTerms = new Set<string>();
      const uniqueExtraKws: any[] = [];
      for (const kw of extraKws) {
        const t = kwText(kw);
        const norm = normTerm(t);
        if (!norm || seenTerms.has(norm)) {
          migrationGroup.duplicates_blocked++;
          continue;
        }
        seenTerms.add(norm);
        uniqueExtraKws.push(kw);
      }

      // Migrar cada keyword extra como campanha individual
      for (const kw of uniqueExtraKws) {
        const term = kwText(kw);
        if (!term) continue;

        // Verificar idempotência local
        const existing = findExistingCanonical(campaigns, accountId, asin, term);
        if (existing) {
          migrationGroup.already_existed.push({ keyword: term, campaign_id: campaignIdStr(existing) });
          report.keywords_skipped_already_exists.push({ asin, keyword: term, existing_campaign_id: campaignIdStr(existing) });
          continue;
        }

        const result = await createCanonicalCampaign(base44, accountId, asin, term, budgetPerCampaign, sku, was_paused ? 'paused' : 'enabled');
        await sleep(SLEEP_BETWEEN);

        if (result.ok) {
          if (result.already_exists) {
            migrationGroup.already_existed.push({ keyword: term, campaign_id: result.campaign_id });
            report.keywords_skipped_already_exists.push({ asin, keyword: term, existing_campaign_id: result.campaign_id });
          } else {
            migrationGroup.created.push({ keyword: term, new_campaign_id: result.campaign_id });
            report.keywords_created.push({ asin, keyword: term, new_campaign_id: result.campaign_id, source_campaign_id: cid });
            negateInAuto(base44, accountId, asin, term);
          }
        } else {
          if (result.error === 'out_of_stock_terminal') {
            migrationGroup.already_existed.push({ keyword: term, reason: 'out_of_stock_skip' });
          } else {
            migrationGroup.failed.push({ keyword: term, error: result.error });
            report.keywords_failed.push({ asin, keyword: term, error: result.error });
            await enqueueRetry(base44, accountId, cid, asin, term, 0);
          }
        }
      }

      const allMigrated = migrationGroup.failed.length === 0;
      const allAccountedFor = migrationGroup.created.length + migrationGroup.already_existed.length >= migrationGroup.total_to_migrate - migrationGroup.duplicates_blocked;

      if (allMigrated && allAccountedFor) {
        const archived = await archiveCampaignOnAmazon(base44, accountId, cid);

        if (archived) {
          await base44.asServiceRole.entities.Campaign.update(campaign.id, {
            state: 'archived',
            status: 'archived',
            archived: true,
            archived_at: new Date().toISOString(),
            archive_reason: 'canonical_migration_v3',
          }).catch(() => {});
          report.campaigns_migrated.push({
            source_campaign_id: cid,
            asin,
            root_keyword: kwText(rootKw),
            keywords_found: keywordsFound,
            unique_terms: uniqueExtraKws.length,
            duplicates_blocked: migrationGroup.duplicates_blocked,
            campaigns_created: migrationGroup.created.length,
            already_existed: migrationGroup.already_existed.length,
            failed: migrationGroup.failed.length,
            old_campaign_archived: true,
          });
        } else {
          report.errors.push({ campaign_id: cid, step: 'archive_source', reason: 'Amazon archive failed — source kept active' });
        }
      } else {
        report.campaigns_pending_retry.push({
          source_campaign_id: cid,
          asin,
          failed_keywords: migrationGroup.failed.map((f: any) => f.keyword),
          retry_scheduled: true,
        });
      }

      processed++;
    }

    const pendingRetries = await base44.asServiceRole.entities.AmazonActionQueue.filter(
      { amazon_account_id: accountId, action_type: 'migrate_keyword_canonical', status: 'pending' },
      null, 100,
    ).catch(() => []);

    report.total_pending_retries = pendingRetries.length;
    report.continuation_required = pendingRetries.length > 0 || report.keywords_failed.length > 0;
    report.completed_at = new Date().toISOString();

    const logStatus = report.errors.length > 0
      ? 'warning'
      : report.continuation_required ? 'pending' : 'success';

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'canonical_migration_v3',
      trigger_type: body.trigger_type || 'automatic',
      status: logStatus,
      started_at: startedAt,
      completed_at: report.completed_at,
      records_processed: report.campaigns_migrated.length + report.keywords_created.length,
      result_summary: JSON.stringify({
        campaigns_scanned: report.campaigns_scanned,
        multi_keyword_found: report.campaigns_multi_keyword_found,
        campaigns_migrated: report.campaigns_migrated.length,
        campaigns_pending_retry: report.campaigns_pending_retry.length,
        keywords_created: report.keywords_created.length,
        keywords_skipped: report.keywords_skipped_already_exists.length,
        keywords_failed: report.keywords_failed.length,
        total_pending_retries: report.total_pending_retries,
        retry_resolved: report.retry_resolved.length,
        migration_details: report.campaigns_migrated.slice(0, 5),
      }).slice(0, 4000),
      error_message: report.errors.length > 0
        ? `${report.errors.length} erro(s). ${report.keywords_failed.length} keyword(s) com retry pendente.`
        : null,
    }).catch(() => {});

    return Response.json(report);

  } catch (err: any) {
    return Response.json({
      ok: false,
      error: err?.message || 'Falha na migração canônica',
      previous_data_preserved: true,
    }, { status: 500 });
  }
});