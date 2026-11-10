import { createClientFromRequest } from "npm:@base44/sdk@0.8.40";
import { aggregateDailyMetrics, campaignIdentity, parseEmergencyRun } from "../../shared/emergencyAdsControlPolicy.ts";

const PAGE_SIZE = 100;
const MAX_CAMPAIGN_PAGES = 100;
const MAX_METRIC_ROWS = 30000;
const METRIC_PAGE_SIZE = 500;
const ENTITY_PAGE_SIZE = 500;
const MAX_ENTITY_ROWS = 30000;
const DAY_MS = 86400000;
const LOCK_KEY = "home_emergency_ads_control";

type ProductType = "SP" | "SB" | "SD";
type RemoteCampaign = { campaignId: string; state: string; name?: string; type: ProductType };
type CampaignRef = { id: string; type: ProductType };

const SPECS: Record<ProductType, { listPath: string; writePath: string; contentType: string; listMethod: "POST" | "GET"; updateLimit: number }> = {
  SP: { listPath: "/sp/campaigns/list", writePath: "/sp/campaigns", contentType: "application/vnd.spCampaign.v3+json", listMethod: "POST", updateLimit: 100 },
  SB: { listPath: "/sb/v4/campaigns/list", writePath: "/sb/v4/campaigns", contentType: "application/vnd.sbcampaignresource.v4+json", listMethod: "POST", updateLimit: 10 },
  SD: { listPath: "/sd/campaigns?count=100&stateFilter=enabled,paused", writePath: "/sd/campaigns", contentType: "application/json", listMethod: "GET", updateLimit: 100 },
};

function brtDate(daysAgo = 0): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const date = new Date(today + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function unwrap(value: any) { return value?.data ?? value ?? {}; }
function bodyOf(value: any) { return value?.payload ?? value; }
function listOf(value: any): any[] {
  const payload = bodyOf(value);
  const campaigns = payload?.campaigns;
  if (Array.isArray(campaigns)) return campaigns;
  if (Array.isArray(campaigns?.success)) return campaigns.success.map((row: any) => row.campaign || row);
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}
function responseError(value: any): string | null {
  if (!value || value.ok === false || Number(value.status || 200) >= 400) {
    return String(value?.message || value?.error || value?.errors?.[0]?.message || "Amazon Ads não confirmou a operação").slice(0, 300);
  }
  const payload = bodyOf(value);
  const errors = payload?.campaigns?.error || payload?.errors || [];
  if (Array.isArray(errors) && errors.length) return errors.map((item: any) => item?.message || item?.code || "Erro por item").join("; ").slice(0, 300);
  return null;
}
function responseSuccessIds(value: any): Set<string> {
  const payload = bodyOf(value);
  const rows = payload?.campaigns?.success;
  return new Set(Array.isArray(rows) ? rows.map((row: any) => String(row.campaignId || row.campaign?.campaignId || "")).filter(Boolean) : []);
}
function normalizedState(row: any): string { return String(row?.state || row?.status || "").toLowerCase(); }

async function invokeCommand(base44: any, accountId: string, type: ProductType, path: string, method: string, payload?: unknown) {
  const spec = SPECS[type];
  const raw = await base44.asServiceRole.functions.invoke("amazonAdsCommand", {
    amazon_account_id: accountId, path, method,
    content_type: spec.contentType, accept: spec.contentType,
    // A write timeout is ambiguous; this endpoint reconciles remote state and never retries the write.
    max_attempts: method === "GET" || (method === "POST" && path.endsWith("/list")) ? 3 : 1,
    ...(payload === undefined ? {} : { payload }),
    _service_role: true,
  });
  return unwrap(raw);
}

async function fetchRemoteCampaigns(base44: any, accountId: string, type: ProductType): Promise<{ rows: RemoteCampaign[]; complete: boolean; reason?: string }> {
  const spec = SPECS[type];
  const rows = new Map<string, RemoteCampaign>();
  const seenTokens = new Set<string>();
  let token: string | null = null;
  let sdStartIndex = 0;
  for (let page = 0; page < MAX_CAMPAIGN_PAGES; page++) {
    const path = type === "SD"
      ? "/sd/campaigns?count=" + PAGE_SIZE + "&stateFilter=enabled,paused&startIndex=" + sdStartIndex
      : spec.listPath;
    const listRequest = spec.listMethod === "GET" ? undefined : {
      stateFilter: { include: ["ENABLED", "PAUSED"] },
      maxResults: PAGE_SIZE,
      ...(token ? { nextToken: token } : {}),
    };
    const response = await invokeCommand(base44, accountId, type, path, spec.listMethod, listRequest);
    const error = responseError(response);
    if (error) return { rows: [...rows.values()], complete: false, reason: "READ_" + type + ": " + error };
    const responsePayload: any = bodyOf(response);
    const hasCampaignList = (type === "SD" && Array.isArray(responsePayload))
      || Array.isArray(responsePayload?.campaigns) || Array.isArray(responsePayload?.campaigns?.success) || Array.isArray(responsePayload?.items);
    if (!hasCampaignList) return { rows: [...rows.values()], complete: false, reason: "CAMPAIGN_LIST_SHAPE_INVALID_" + type };
    const pageRows = type === "SD" && Array.isArray(responsePayload) ? responsePayload : listOf(response);
    if (type === "SD" && pageRows.length === 0) return { rows: [...rows.values()], complete: true };
    let addedOnPage = 0;
    for (const item of pageRows) {
      const id = String(item?.campaignId || item?.id || "");
      if (!id) continue;
      const current = { campaignId: id, state: normalizedState(item), name: String(item?.name || ""), type };
      const prior = rows.get(id);
      if (prior && prior.state !== current.state) return { rows: [...rows.values()], complete: false, reason: "CAMPAIGN_STATE_CONFLICT_" + type };
      if (!prior) addedOnPage += 1;
      rows.set(id, current);
    }
    if (type === "SD") {
      if (addedOnPage === 0) return { rows: [...rows.values()], complete: false, reason: "PAGINATION_NO_PROGRESS_SD" };
      if (pageRows.length < PAGE_SIZE) return { rows: [...rows.values()], complete: true };
      sdStartIndex += pageRows.length;
      await sleep(250);
      continue;
    }
    const next = String(bodyOf(response)?.nextToken || bodyOf(response)?.campaigns?.nextToken || "");
    if (next && addedOnPage === 0) return { rows: [...rows.values()], complete: false, reason: "PAGINATION_NO_PROGRESS_" + type };
    if (!next) return { rows: [...rows.values()], complete: true };
    if (seenTokens.has(next)) return { rows: [...rows.values()], complete: false, reason: "PAGINATION_TOKEN_REPEATED_" + type };
    seenTokens.add(next);
    token = next;
    await sleep(250);
  }
  return { rows: [...rows.values()], complete: false, reason: "PAGINATION_PAGE_LIMIT_" + type };
}

async function readAllCampaignTypes(base44: any, accountId: string) {
  const groups = await Promise.all((["SP", "SB", "SD"] as ProductType[]).map((type) => fetchRemoteCampaigns(base44, accountId, type)));
  const incomplete = groups.find((group) => !group.complete);
  return { complete: !incomplete, reason: incomplete?.reason, rows: groups.flatMap((group) => group.rows) };
}

async function readMetrics(base44: any, accountId: string) {
  const endDate = brtDate(1);
  const startDate = brtDate(30);
  const rows: any[] = [];
  for (let offset = 0; offset < MAX_METRIC_ROWS; offset += METRIC_PAGE_SIZE) {
    const page = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: accountId, date: { $gte: startDate, $lte: endDate } },
      "-date", Math.min(METRIC_PAGE_SIZE, MAX_METRIC_ROWS - offset), offset,
    ).catch((error: any) => { throw new Error("LEITURA_METRICAS: " + String(error?.message || error)); });
    if (!Array.isArray(page)) throw new Error("LEITURA_METRICAS: resposta de página inválida.");
    rows.push(...page);
    if (page.length < METRIC_PAGE_SIZE) return { startDate, endDate, rows, complete: true };
    await sleep(100);
  }
  return { startDate, endDate, rows, complete: false };
}

async function readEntityPages(entity: any, filter: Record<string, unknown>, sort: string) {
  const rows: any[] = [];
  for (let offset = 0; offset < MAX_ENTITY_ROWS; offset += ENTITY_PAGE_SIZE) {
    const page = await entity.filter(filter, sort, Math.min(ENTITY_PAGE_SIZE, MAX_ENTITY_ROWS - offset), offset);
    if (!Array.isArray(page)) return { rows, complete: false };
    rows.push(...page);
    if (page.length < ENTITY_PAGE_SIZE) return { rows, complete: true };
    await sleep(50);
  }
  return { rows, complete: false };
}

async function analyzeMetricsOnly(base44: any, accountId: string) {
  const data = await readMetrics(base44, accountId);
  if (!data.complete) return { ok: false, skipped: true, reason: "METRICS_PAGE_LIMIT", window: [data.startDate, data.endDate], rows_read: data.rows.length };
  const summary = aggregateDailyMetrics(data.rows);
  if (summary.conflicting_campaign_days > 0) return {
    ok: false, skipped: true, reason: "CONFLICTING_DAILY_METRICS",
    conflicting_campaign_days: summary.conflicting_campaign_days,
    rows_read: data.rows.length, window: [data.startDate, data.endDate],
  };
  const result = await base44.integrations.Core.InvokeLLM({
    prompt: [
      "Analise somente os indicadores observados de Amazon Ads abaixo, no período informado.",
      "A pausa emergencial já ocorreu. Esta chamada é SOMENTE análise: não execute nem solicite chamadas de API.",
      "Não invente margem, estoque, lucro ou causalidade. Indique dados ausentes e incerteza.",
      "Priorize problemas por risco financeiro e sugira próximos passos revisáveis. Não declare ganho futuro.",
      "Retorne JSON com overall_assessment, risks, opportunities, data_limitations e recommended_reviews.",
      "Período fechado BRT: " + data.startDate + " a " + data.endDate + ".",
      "Linhas campanha-dia lidas: " + summary.unique_campaign_days + "; campanhas com métricas: " + summary.campaigns_with_metrics + ".",
      "Totais: " + JSON.stringify(summary.totals) + ".",
      "ACoS agregado: " + summary.acos + "; ROAS agregado: " + summary.roas + "; CPC: " + summary.cpc + "; CTR: " + summary.ctr + "; conversão por clique: " + summary.conversion_rate + ".",
      "Maiores gastos por campanha (máximo 100 linhas): " + JSON.stringify(summary.top_campaigns_by_spend) + ".",
    ].join("\n"),
    response_json_schema: {
      type: "object",
      properties: {
        overall_assessment: { type: "string" },
        risks: { type: "array", items: { type: "string" } },
        opportunities: { type: "array", items: { type: "string" } },
        data_limitations: { type: "array", items: { type: "string" } },
        recommended_reviews: { type: "array", items: { type: "string" } },
      },
      required: ["overall_assessment", "risks", "opportunities", "data_limitations", "recommended_reviews"],
    },
  });
  if (result?.ok === false) return { ok: false, error: String(result.error || "Falha no provedor de IA").slice(0, 300), window: [data.startDate, data.endDate], rows_read: data.rows.length, metrics: summary };
  return { ok: true, window: [data.startDate, data.endDate], rows_read: data.rows.length, metrics: summary, analysis: result };
}

async function updateBatches(base44: any, accountId: string, target: RemoteCampaign[], state: "PAUSED" | "ENABLED", onProgress?: (value: any) => Promise<void>) {
  const confirmed: CampaignRef[] = [];
  const unknown: CampaignRef[] = [];
  const failed: Array<CampaignRef & { reason: string }> = [];
  const skipped: Array<CampaignRef & { reason: string }> = [];
  const requestIds: string[] = [];
  let stopAfterRateLimit = false;
  for (const type of ["SP", "SB", "SD"] as ProductType[]) {
    if (stopAfterRateLimit) break;
    const group = target.filter((campaign) => campaign.type === type);
    const limit = SPECS[type].updateLimit;
    for (let offset = 0; offset < group.length; offset += limit) {
      const proposedBatch = group.slice(offset, offset + limit);
      const preflight = await fetchRemoteCampaigns(base44, accountId, type);
      if (!preflight.complete) {
        for (const campaign of proposedBatch) failed.push({ type, id: campaign.campaignId, reason: "NOT_SENT_PREFLIGHT_INCOMPLETE: " + String(preflight.reason || "unknown").slice(0, 180) });
        await onProgress?.({ confirmed: [...confirmed], unknown: [...unknown], failed: [...failed], skipped: [...skipped], request_ids: [...requestIds], processed: confirmed.length + unknown.length + failed.length + skipped.length, target_count: target.length });
        if (String(preflight.reason || "").includes("429") || String(preflight.reason || "").toLowerCase().includes("rate limit")) stopAfterRateLimit = true;
        break;
      }
      const currentById = new Map(preflight.rows.map((row) => [row.campaignId, row.state]));
      const expectedPriorState = state === "PAUSED" ? "enabled" : "paused";
      const batch = proposedBatch.filter((campaign) => {
        if (currentById.get(campaign.campaignId) === expectedPriorState) return true;
        skipped.push({ type, id: campaign.campaignId, reason: "remote_state_changed_before_write" });
        return false;
      });
      if (batch.length === 0) {
        await onProgress?.({ confirmed: [...confirmed], unknown: [...unknown], failed: [...failed], skipped: [...skipped], request_ids: [...requestIds], processed: confirmed.length + unknown.length + failed.length + skipped.length, target_count: target.length });
        continue;
      }
      const response = await invokeCommand(base44, accountId, type, SPECS[type].writePath, "PUT", {
        campaigns: batch.map((campaign) => ({ campaignId: campaign.campaignId, state })),
      }).catch((error: any) => ({ ok: false, status: 0, error: String(error?.message || error) }));
      const accepted = responseSuccessIds(response);
      if (response?.request_id) requestIds.push(String(response.request_id));
      const error = responseError(response);
      const check = await fetchRemoteCampaigns(base44, accountId, type);
      if (!check.complete) {
        for (const campaign of batch) unknown.push({ type, id: campaign.campaignId });
      } else {
        const remote = new Map(check.rows.map((row) => [row.campaignId, row.state]));
        for (const campaign of batch) {
          const current = remote.get(campaign.campaignId);
          const desired = state.toLowerCase();
          if (current === desired) confirmed.push({ type, id: campaign.campaignId });
          else if (accepted.has(campaign.campaignId) || Number(response?.status || 0) === 0) {
            unknown.push({ type, id: campaign.campaignId });
          } else failed.push({ type, id: campaign.campaignId, reason: error || "AMAZON_STATE_NOT_CONFIRMED" });
        }
      }
      await onProgress?.({
        confirmed: [...confirmed], unknown: [...unknown], failed: [...failed], skipped: [...skipped], request_ids: [...requestIds],
        processed: confirmed.length + unknown.length + failed.length + skipped.length, target_count: target.length,
      });
      if (response?.rate_limited || Number(response?.status) === 429) { stopAfterRateLimit = true; break; }
      if (offset + limit < group.length) await sleep(350);
    }
  }
  return { confirmed, unknown, failed, skipped, request_ids: requestIds };
}

function asRefList(value: unknown): CampaignRef[] {
  return Array.isArray(value) ? value.filter((item: any) => item && ["SP", "SB", "SD"].includes(item.type) && item.id)
    .map((item: any) => ({ type: item.type, id: String(item.id) })) : [];
}

Deno.serve(async (request) => {
  const startedAt = Date.now();
  let base44: any;
  let accountId = "";
  let lockOwner = "";
  let logId = "";
  try {
    base44 = createClientFromRequest(request);
    const user = await base44.auth.me().catch(() => null);
    if (!user || user.role !== "admin") return Response.json({ ok: false, error: "Somente administradores podem usar o controle emergencial." }, { status: 403 });
    const body = await request.json().catch(() => ({}));
    accountId = String(body.amazon_account_id || "");
    const action = String(body.action || "");
    if (!accountId || !["status", "pause_all", "reactivate_emergency"].includes(action)) return Response.json({ ok: false, error: "Conta e ação válidas são obrigatórias." }, { status: 400 });
    if (action === "status") {
      const runs = await base44.asServiceRole.entities.SyncExecutionLog.filter(
        { amazon_account_id: accountId, operation: "emergency_ads_pause" }, "-started_at", 20,
      );
      const latest = runs.find((row: any) => parseEmergencyRun(row.result_summary)?.batch_id);
      const details = latest ? parseEmergencyRun(latest.result_summary) : null;
      const restoreRuns = await base44.asServiceRole.entities.SyncExecutionLog.filter(
        { amazon_account_id: accountId, operation: "emergency_ads_restore" }, "-started_at", 20,
      );
      const marked = await readEntityPages(base44.asServiceRole.entities.Campaign, { amazon_account_id: accountId }, "-updated_date")
        .catch(() => ({ rows: [], complete: false }));
      const restorableCount = marked.complete
        ? marked.rows.filter((row: any) => Boolean(String(row.emergency_pause_batch_id || ""))).length
        : null;
      const latestRestore = restoreRuns[0] || null;
      const latestRestoreDetails = latestRestore ? parseEmergencyRun(latestRestore.result_summary) : null;
      return Response.json({ ok: true, restorable_count: restorableCount, restorable_count_complete: marked.complete, latest_pause: latest ? {
        id: latest.id, status: latest.status, started_at: latest.started_at, completed_at: latest.completed_at,
        batch_id: details?.batch_id, target_count: details?.target_count || 0, run_state: details?.state || null, confirmed_count: details?.confirmed?.length || 0,
        unknown_count: details?.unknown?.length || 0, failed_count: details?.failed?.length || 0,
        error_message: latest.error_message || null, ai_reanalysis: details?.ai_reanalysis || null,
      } : null, latest_restore: latestRestore ? {
        status: latestRestore.status, started_at: latestRestore.started_at, completed_at: latestRestore.completed_at,
        confirmed_count: latestRestoreDetails?.confirmed?.length || 0, unknown_count: latestRestoreDetails?.unknown?.length || 0,
        failed_count: latestRestoreDetails?.failed?.length || 0, skipped_count: latestRestoreDetails?.skipped?.length || 0,
        error_message: latestRestore.error_message || null,
      } : null });
    }
    const expectedConfirmation = action === "pause_all" ? "PAUSAR TODAS" : "REATIVAR LOTE EMERGENCIAL";
    if (String(body.confirmation || "").trim() !== expectedConfirmation) return Response.json({ ok: false, error: "Confirmação textual não corresponde à operação." }, { status: 400 });
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
    const account = accounts[0];
    if (!account || account.status !== "connected") return Response.json({ ok: false, error: "Conta Amazon conectada não encontrada." }, { status: 404 });
    const profileId = String(account.ads_profile_id || "");
    if (!profileId) return Response.json({ ok: false, error: "Perfil Amazon Ads ausente; nenhuma campanha alterada." }, { status: 409 });

    lockOwner = crypto.randomUUID();
    const lockResponse = unwrap(await base44.asServiceRole.functions.invoke("acquireAmazonSchedulerLock", {
      amazon_account_id: accountId, lock_key: LOCK_KEY, owner_id: lockOwner, ttl_ms: 900000, _service_role: true,
    }));
    if (lockResponse.acquired !== true) return Response.json({ ok: false, conflict: true, error: "Já existe um controle emergencial em execução." }, { status: 409 });

    if (action === "pause_all") {
      const batchId = crypto.randomUUID();
      const log = await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: accountId, operation: "emergency_ads_pause", trigger_type: "admin_dashboard",
        status: "processing", started_at: new Date().toISOString(), records_received: 0,
        result_summary: JSON.stringify({ batch_id: batchId, state: "reading_campaigns" }),
      });
      logId = String(log.id || "");
      const campaigns = await readAllCampaignTypes(base44, accountId);
      if (!campaigns.complete) {
        const reason = campaigns.reason || "Leitura remota incompleta; nenhuma campanha alterada.";
        await base44.asServiceRole.entities.SyncExecutionLog.update(log.id, {
          status: "error", completed_at: new Date().toISOString(), duration_ms: Date.now() - startedAt,
          error_message: reason.slice(0, 500), result_summary: JSON.stringify({ batch_id: batchId, state: "preflight_failed", data_complete: false, reason }),
        });
        return Response.json({ ok: false, error: reason }, { status: 503 });
      }
      const active = campaigns.rows.filter((row) => row.state === "enabled");
      await base44.asServiceRole.entities.SyncExecutionLog.update(log.id, {
        records_received: active.length,
        result_summary: JSON.stringify({ batch_id: batchId, state: "started", target_count: active.length,
          candidates: active.map((row) => ({ type: row.type, id: row.campaignId })) }),
      });
      const execution = await updateBatches(base44, accountId, active, "PAUSED", async (progress) => {
        await base44.asServiceRole.entities.SyncExecutionLog.update(log.id, {
          status: "processing", records_processed: progress.processed,
          result_summary: JSON.stringify({ batch_id: batchId, state: "processing", target_count: progress.target_count,
            confirmed: progress.confirmed, unknown: progress.unknown, failed: progress.failed, skipped: progress.skipped, request_ids: progress.request_ids }),
        });
      });
      const now = new Date().toISOString();
      const localRead = await readEntityPages(base44.asServiceRole.entities.Campaign, { amazon_account_id: accountId }, "-updated_date").catch(() => ({ rows: [], complete: false }));
      const localRows = localRead.rows;
      const localByKey = new Map<string, any>();
      for (const row of localRows) {
        const identity = campaignIdentity(row);
        if (identity) localByKey.set(identity.type + "|" + identity.id, row);
      }
      const localPersistenceFailures: CampaignRef[] = [];
      for (const ref of execution.confirmed) {
        const local = localByKey.get(ref.type + "|" + ref.id);
        if (local?.id) await base44.asServiceRole.entities.Campaign.update(local.id, {
          state: "paused", status: "paused", amazon_status: "paused",
          last_pause_reason: "EMERGENCY_HOME:" + batchId,
          emergency_pause_batch_id: batchId, synced_at: now,
        }).catch(() => { localPersistenceFailures.push(ref); });
        else localPersistenceFailures.push(ref);
      }
      let ai = { ok: false, skipped: true, reason: "NO_CAMPAIGNS_CONFIRMED_PAUSED" } as any;
      if (execution.confirmed.length > 0) {
        await base44.asServiceRole.entities.SyncExecutionLog.update(log.id, {
          status: "processing", records_processed: execution.confirmed.length,
          result_summary: JSON.stringify({ batch_id: batchId, state: "ai_reanalysis", target_count: active.length,
            confirmed: execution.confirmed, unknown: execution.unknown, failed: execution.failed, skipped: execution.skipped, request_ids: execution.request_ids }),
        });
        try { ai = await analyzeMetricsOnly(base44, accountId); }
        catch (error: any) { ai = { ok: false, error: String(error?.message || error).slice(0, 300) }; }
      }
      const result = {
        batch_id: batchId, target_count: active.length,
        confirmed: execution.confirmed, unknown: execution.unknown, failed: execution.failed, skipped: execution.skipped,
        local_state_persistence_failed: localPersistenceFailures,
        local_campaign_snapshot_complete: localRead.complete,
        request_ids: execution.request_ids, ai_reanalysis: ai, confirmed_at: now,
      };
      const status = execution.unknown.length || execution.failed.length || execution.skipped.length || localPersistenceFailures.length || !localRead.complete ? "partial" : "success";
      await base44.asServiceRole.entities.SyncExecutionLog.update(log.id, {
        status, completed_at: new Date().toISOString(), duration_ms: Date.now() - startedAt,
        records_processed: execution.confirmed.length, result_summary: JSON.stringify(result),
        error_message: status === "partial" ? "Pausa parcial: confira estados remotos desconhecidos, rejeitados ou registros locais não persistidos." : null,
      });
      return Response.json({ ok: status === "success", status, ...result });
    }

    const pauseLogs = await base44.asServiceRole.entities.SyncExecutionLog.filter(
      { amazon_account_id: accountId, operation: "emergency_ads_pause" }, "-started_at", 500,
    );
    const restoreLog = await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId, operation: "emergency_ads_restore", trigger_type: "admin_dashboard",
      status: "processing", started_at: new Date().toISOString(), records_received: 0,
      result_summary: JSON.stringify({ state: "preflight", source_batch_ids: [] }),
    });
    logId = String(restoreLog.id || "");
    const markRestoreFailure = async (reason: string, status = 503) => {
      await base44.asServiceRole.entities.SyncExecutionLog.update(restoreLog.id, {
        status: "error", completed_at: new Date().toISOString(), duration_ms: Date.now() - startedAt,
        error_message: reason.slice(0, 500),
        result_summary: JSON.stringify({ state: "preflight_failed", source_batch_ids: [], confirmed: [], unknown: [], failed: [], skipped: [], reason }),
      }).catch(() => {});
      return Response.json({ ok: false, error: reason }, { status });
    };
    const pauseRefsByKey = new Map<string, { ref: CampaignRef; batch_id: string }>();
    for (const row of pauseLogs) {
      const parsed = parseEmergencyRun(row.result_summary);
      if (!parsed?.batch_id || !Array.isArray(parsed.confirmed)) continue;
      for (const ref of asRefList(parsed.confirmed)) {
        const key = ref.type + "|" + ref.id;
        if (!pauseRefsByKey.has(key)) pauseRefsByKey.set(key, { ref, batch_id: String(parsed.batch_id) });
      }
    }
    const sourceRefs = [...pauseRefsByKey.values()];
    if (!sourceRefs.length) return await markRestoreFailure("Nenhum lote de pausa emergencial confirmado para reativar.", 409);

    const remote = await readAllCampaignTypes(base44, accountId);
    if (!remote.complete) return await markRestoreFailure(remote.reason || "Leitura remota incompleta; nenhuma campanha reativada.");
    const remoteByKey = new Map(remote.rows.map((row) => [row.type + "|" + row.campaignId, row]));
    const localRead = await readEntityPages(base44.asServiceRole.entities.Campaign, { amazon_account_id: accountId }, "-updated_date").catch(() => ({ rows: [], complete: false }));
    if (!localRead.complete) return await markRestoreFailure("Snapshot local de campanhas incompleto; nenhuma reativação foi enviada.");
    const localRows = localRead.rows;
    const localByKey = new Map<string, any>();
    for (const row of localRows) {
      const identity = campaignIdentity(row);
      if (identity) localByKey.set(identity.type + "|" + identity.id, row);
    }
    const productRead = await readEntityPages(base44.asServiceRole.entities.Product, { amazon_account_id: accountId }, "-updated_date").catch(() => ({ rows: [], complete: false }));
    if (!productRead.complete) return await markRestoreFailure("Leitura de produtos incompleta; nenhuma campanha reativada.");
    const products = productRead.rows;
    const currentTarget: RemoteCampaign[] = [];
    const targetBatchByKey = new Map<string, string>();
    const skipped: Array<{ type: ProductType; id: string; reason: string }> = [];
    for (const { ref, batch_id } of sourceRefs) {
      const key = ref.type + "|" + ref.id;
      const local = localByKey.get(key);
      const remoteRow = remoteByKey.get(key);
      if (!local || String(local.emergency_pause_batch_id || "") !== batch_id) { skipped.push({ ...ref, reason: "pause_source_not_current" }); continue; }
      if (!remoteRow || remoteRow.state !== "paused") { skipped.push({ ...ref, reason: "remote_not_paused" }); continue; }
      const sku = String(local.sku || "").trim().toUpperCase();
      const asin = String(local.asin || "").trim().toUpperCase();
      const matching = products.filter((product: any) => sku
        ? String(product.sku || "").trim().toUpperCase() === sku
        : asin && String(product.asin || "").trim().toUpperCase() === asin);
      const product = matching.length === 1 ? matching[0] : null;
      const inventorySnapshotAt = Date.parse(String(product?.inventory_snapshot_at || ""));
      const inventoryAge = Date.now() - inventorySnapshotAt;
      const inventoryFresh = Number.isFinite(inventorySnapshotAt) && inventoryAge >= 0 && inventoryAge <= DAY_MS;
      const listingCheckedAt = Date.parse(String(product?.listing_checked_at || ""));
      const listingAge = Date.now() - listingCheckedAt;
      const listingFresh = Number.isFinite(listingCheckedAt) && listingAge >= 0 && listingAge <= DAY_MS;
      const stock = Number(product?.fba_inventory);
      const sellable = product && inventoryFresh && listingFresh && product.listing_buyable === true
        && String(product.listing_status || "").toLowerCase() === "active" && Number.isFinite(stock) && stock > 0
        && !["inactive", "deleted", "archived"].includes(String(product.status || "").toLowerCase());
      if (!sellable) { skipped.push({ ...ref, reason: "stock_or_sellability_not_confirmed" }); continue; }
      currentTarget.push(remoteRow);
      targetBatchByKey.set(key, batch_id);
    }
    const sourceBatchIds = [...new Set(sourceRefs.map((item) => item.batch_id))];
    await base44.asServiceRole.entities.SyncExecutionLog.update(restoreLog.id, {
      status: "processing", records_received: currentTarget.length,
      result_summary: JSON.stringify({ source_batch_ids: sourceBatchIds, state: "started", candidates: currentTarget.map((row) => ({ type: row.type, id: row.campaignId })), skipped }),
    });
    const execution = await updateBatches(base44, accountId, currentTarget, "ENABLED", async (progress) => {
      await base44.asServiceRole.entities.SyncExecutionLog.update(restoreLog.id, {
        status: "processing", records_processed: progress.processed,
        result_summary: JSON.stringify({ source_batch_ids: sourceBatchIds, state: "processing", target_count: progress.target_count,
          confirmed: progress.confirmed, unknown: progress.unknown, failed: progress.failed, skipped: [...skipped, ...progress.skipped], request_ids: progress.request_ids }),
      });
    });
    const now = new Date().toISOString();
    const localPersistenceFailures: CampaignRef[] = [];
    for (const ref of execution.confirmed) {
      const key = ref.type + "|" + ref.id;
      const local = localByKey.get(key);
      const sourceBatch = targetBatchByKey.get(key);
      if (!local?.id || !sourceBatch || String(local.emergency_pause_batch_id || "") !== sourceBatch) {
        localPersistenceFailures.push(ref);
        continue;
      }
      await base44.asServiceRole.entities.Campaign.update(local.id, {
        state: "enabled", status: "enabled", amazon_status: "enabled",
        last_pause_reason: null, emergency_pause_batch_id: null, synced_at: now,
      }).catch(() => { localPersistenceFailures.push(ref); });
    }
    const result = { source_batch_ids: sourceBatchIds, confirmed: execution.confirmed, unknown: execution.unknown, failed: execution.failed, local_state_persistence_failed: localPersistenceFailures, request_ids: execution.request_ids, skipped: [...skipped, ...execution.skipped] };
    const status = execution.unknown.length || execution.failed.length || result.skipped.length || localPersistenceFailures.length ? "partial" : "success";
    await base44.asServiceRole.entities.SyncExecutionLog.update(restoreLog.id, {
      status, completed_at: new Date().toISOString(), duration_ms: Date.now() - startedAt,
      records_processed: execution.confirmed.length, result_summary: JSON.stringify(result),
      error_message: status === "partial" ? "Reativação parcial; estados incertos, rejeitados ou bloqueados foram preservados para revisão." : null,
    });
    return Response.json({ ok: status === "success", status, ...result });
  } catch (error: any) {
    if (base44 && logId) await base44.asServiceRole.entities.SyncExecutionLog.update(logId, {
      status: "error", completed_at: new Date().toISOString(), duration_ms: Date.now() - startedAt,
      error_message: String(error?.message || error).slice(0, 500),
    }).catch(() => {});
    return Response.json({ ok: false, error: String(error?.message || error).slice(0, 400) }, { status: 500 });
  } finally {
    if (base44 && accountId && lockOwner) {
      await base44.asServiceRole.functions.invoke("acquireAmazonSchedulerLock", {
        amazon_account_id: accountId, lock_key: LOCK_KEY, owner_id: lockOwner, action: "release", _service_role: true,
      }).catch(() => {});
    }
  }
});
