/**
 * enforceCanonicalManualCampaigns v2 — Migração Canônica Transacional
 *
 * REGRA ABSOLUTA: 1 campanha manual = 1 ASIN = 1 Ad Group = 1 Product Ad = 1 keyword EXACT
 *
 * FLUXO TRANSACIONAL:
 * 1. Detectar campanhas com 2+ keywords EXACT (ativas ou pausadas)
 * 2. Para cada keyword extra: verificar idempotência, criar nova campanha, confirmar na Amazon
 * 3. SOMENTE quando TODAS as novas campanhas estiverem confirmadas: arquivar a original
 * 4. Se qualquer criação falhar: manter original ativa, enfileirar retry com backoff 15/30/60min
 * 5. Negativar cada termo na campanha AUTO do mesmo ASIN (fire-and-forget)
 *
 * Chave de idempotência: amazon_account_id + ASIN + normalize(keyword_text) + EXACT
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const INITIAL_BID    = 0.50;
const MIN_BUDGET     = 9.00;
const MAX_PER_RUN    = 10;   // campanhas multi-keyword processadas por execução
const SLEEP_BETWEEN  = 5000; // ms entre criações consecutivas (evitar rate limit)
const MAX_RETRIES    = 3;
const BACKOFF_MINUTES = [15, 30, 60];

const CT_CAMPAIGN = 'application/vnd.spCampaign.v3+json';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Helpers ──────────────────────────────────────────────────────────────────

function normTerm(value: any): string {
  return String(value || '')
    .replace(/\+\d+\s*$/i, '')
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

// Chave canônica de idempotência global
function canonicalKey(accountId: string, asin: string, keyword: string): string {
  return `${accountId}|${asin.toUpperCase()}|${normTerm(keyword)}|exact`;
}

// ── Invoke helper ─────────────────────────────────────────────────────────────

async function invoke(base44: any, fn: string, payload: any): Promise<any> {
  const res = await base44.asServiceRole.functions.invoke(fn, payload);
  return res?.data || res || {};
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
  const key = canonicalKey(accountId, asin, keyword);
  return campaigns.find((c: any) => {
    if (!isManualCampaign(c)) return false;
    if (String(c.asin || '').toUpperCase() !== asin.toUpperCase()) return false;
    if (['archived'].includes(String(c.state || c.status || '').toLowerCase())) return false;
    // Verificar pelo nome canônico SP | MANUAL | EXACT | ASIN | keyword
    const norm = normTerm(kwText({ keyword_text: extractKeywordFromName(c.name || c.campaign_name || '') }));
    return norm === normTerm(keyword);
  }) || null;
}

function extractKeywordFromName(name: string): string {
  // Formato: "SP | MANUAL | EXACT | ASIN | keyword"
  const parts = name.split('|').map((p: string) => p.trim());
  if (parts.length >= 5) return parts.slice(4).join(' | ');
  return '';
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
    // Esgotou retries — alertar
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

  // Verificar se já há retry agendado para esta keyword
  const existing = await base44.asServiceRole.entities.AmazonActionQueue.filter(
    { amazon_account_id: accountId, idempotency_key: idKey, status: 'pending' }, '-created_date', 1
  ).catch(() => []);

  if (existing[0]) {
    // Atualizar tentativa existente
    await base44.asServiceRole.entities.AmazonActionQueue.update(existing[0].id, {
      attempt_count: attemptCount + 1,
      retry_after: retryAfter,
      updated_at: new Date().toISOString(),
    }).catch(() => {});
    return;
  }

  await base44.asServiceRole.entities.AmazonActionQueue.create({
    amazon_account_id: accountId,
    action_type: 'migrate_keyword_canonical',
    status: 'pending',
    priority: 'high',
    payload: JSON.stringify({
      source_campaign_id: sourceCampaignId,
      asin,
      keyword_text: keyword,
      attempt_count: attemptCount,
    }),
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
): Promise<{ ok: boolean; campaign_id?: string; already_exists?: boolean; error?: string }> {
  const result = await invoke(base44, 'createManualCampaignV2', {
    amazon_account_id: accountId,
    asin,
    keyword,
    bid: INITIAL_BID,
    budget: Math.max(MIN_BUDGET, budget),
    sku: sku || undefined,
    _service_role: true,
  });

  if (result.ok || result.already_exists || result.blocked_duplicate) {
    return {
      ok: true,
      already_exists: !!(result.already_exists || result.blocked_duplicate),
      campaign_id: result.campaign_id || result.existing_campaign_id,
    };
  }

  // Bloquear por estoque — não é retry, é skip terminal
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

// ── Processar retries pendentes da fila ───────────────────────────────────────

async function processRetryQueue(
  base44: any,
  accountId: string,
  campaigns: any[],
  report: any,
): Promise<void> {
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

    // Verificar se já existe campanha canônica (retry pode ter sido resolvido externamente)
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

    // Buscar budget da campanha original
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
        await base44.asServiceRole.entities.AmazonActionQueue.update(item.id, { status: 'pending' }).catch(() => {});
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

    // Resolver conta
    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'AmazonAccount conectada não encontrada' }, { status: 404 });

    const accountId = account.id;

    // Carregar dados locais
    const [campaigns, keywords, products] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-created_at', 5000).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-created_at', 15000).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, null, 2000).catch(() => []),
    ]);

    const productByAsin = new Map(products.filter((p: any) => p.asin).map((p: any) => [String(p.asin).toUpperCase(), p]));

    // Mapear keywords por campanha (ativas + pausadas — excluindo archived)
    const kwByCampaign = new Map<string, any[]>();
    for (const kw of keywords) {
      const cid = String(kw.campaign_id || '');
      if (!cid) continue;
      const state = String(kw.state || kw.status || '').toLowerCase();
      if (state === 'archived') continue;
      if (!kwByCampaign.has(cid)) kwByCampaign.set(cid, []);
      kwByCampaign.get(cid)!.push(kw);
    }

    // Encontrar campanhas manuais ativas com 2+ keywords EXACT
    const manualActive = campaigns.filter((c: any) => {
      if (!isManualCampaign(c)) return false;
      const state = String(c.state || c.status || '').toLowerCase();
      if (['archived', 'paused'].includes(state)) return false;
      return true;
    });

    const multiKeywordCampaigns: any[] = [];
    for (const c of manualActive) {
      const cid = campaignIdStr(c);
      const allKws = kwByCampaign.get(cid) || [];
      const exactKws = allKws.filter(isExactKeyword);
      if (exactKws.length >= 2) {
        multiKeywordCampaigns.push({ campaign: c, cid, exactKws, asin: String(c.asin || '').toUpperCase() });
      }
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

    // ── Processar retries pendentes primeiro ──────────────────────────────────
    await processRetryQueue(base44, accountId, campaigns, report);

    // ── Processar campanhas multi-keyword ─────────────────────────────────────
    let processed = 0;
    for (const item of multiKeywordCampaigns) {
      if (processed >= MAX_PER_RUN) break;

      const { campaign, cid, exactKws, asin } = item;
      if (!asin) {
        report.errors.push({ campaign_id: cid, reason: 'missing_asin' });
        continue;
      }

      const product = productByAsin.get(asin);
      if (!product || product.inventory_status === 'out_of_stock' || Number(product.fba_inventory ?? 0) <= 0) {
        report.errors.push({ campaign_id: cid, asin, reason: 'out_of_stock' });
        continue;
      }

      const sourceBudget = Number(campaign.daily_budget || campaign.budget || MIN_BUDGET);
      const sku = campaign.sku || product?.sku || null;

      // Ordenar: manter keyword que melhor corresponde ao nome da campanha (= keyword original/principal)
      // A "keyword raiz" da campanha é a primeira — ela NÃO precisa ser migrada (já está na campanha certa)
      // As demais (extras) precisam ganhar campanhas próprias
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
      if (extraKws.length === 0) continue; // já canônica (só 1)

      const migrationGroup: any = {
        source_campaign_id: cid,
        source_local_id: campaign.id,
        asin,
        root_keyword: kwText(rootKw),
        total_to_migrate: extraKws.length,
        created: [] as any[],
        already_existed: [] as any[],
        failed: [] as any[],
      };

      // Migrar cada keyword extra
      for (const kw of extraKws) {
        const term = kwText(kw);
        if (!term) continue;

        // Verificar idempotência local
        const existing = findExistingCanonical(campaigns, accountId, asin, term);
        if (existing) {
          migrationGroup.already_existed.push({ keyword: term, campaign_id: campaignIdStr(existing) });
          report.keywords_skipped_already_exists.push({ asin, keyword: term, existing_campaign_id: campaignIdStr(existing) });
          continue;
        }

        const result = await createCanonicalCampaign(base44, accountId, asin, term, sourceBudget, sku);
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
            // Enfileirar retry — tentativa 0
            await enqueueRetry(base44, accountId, cid, asin, term, 0);
          }
        }
      }

      const allMigrated = migrationGroup.failed.length === 0;
      const allAccountedFor = migrationGroup.created.length + migrationGroup.already_existed.length === migrationGroup.total_to_migrate;

      if (allMigrated && allAccountedFor) {
        // ── ARQUIVAR campanha original ──────────────────────────────────────
        const amazonCampaignId = cid; // campaign_id é o amazon_campaign_id
        const archived = await archiveCampaignOnAmazon(base44, accountId, amazonCampaignId);

        if (archived) {
          await base44.asServiceRole.entities.Campaign.update(campaign.id, {
            state: 'archived',
            status: 'archived',
            archived: true,
            archived_at: new Date().toISOString(),
            archive_reason: 'canonical_migration_v2',
            updated_at: new Date().toISOString(),
          }).catch(() => {});
          report.campaigns_migrated.push({
            source_campaign_id: cid,
            asin,
            root_keyword: kwText(rootKw),
            keywords_migrated: migrationGroup.created.length,
            keywords_already_existed: migrationGroup.already_existed.length,
          });
        } else {
          report.errors.push({ campaign_id: cid, step: 'archive_source', reason: 'Amazon archive failed — source kept active' });
        }
      } else {
        // Manter original ativa — retries pendentes
        report.campaigns_pending_retry.push({
          source_campaign_id: cid,
          asin,
          failed_keywords: migrationGroup.failed.map((f: any) => f.keyword),
          retry_scheduled: true,
        });
      }

      processed++;
    }

    // ── Verificar migrações incompletas de execuções anteriores ───────────────
    // Campanhas que estavam em migração mas a original ainda está ativa
    const pendingRetries = await base44.asServiceRole.entities.AmazonActionQueue.filter(
      { amazon_account_id: accountId, action_type: 'migrate_keyword_canonical', status: 'pending' },
      null, 100,
    ).catch(() => []);

    report.total_pending_retries = pendingRetries.length;
    report.continuation_required = pendingRetries.length > 0 || report.keywords_failed.length > 0;
    report.completed_at = new Date().toISOString();

    // Registrar execução
    const logStatus = report.errors.length > 0
      ? 'warning'
      : report.continuation_required
        ? 'pending'
        : 'success';

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'canonical_migration_v2',
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