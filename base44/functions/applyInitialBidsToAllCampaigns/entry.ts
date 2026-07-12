/**
 * applyInitialBidsToAllCampaigns
 *
 * Para TODAS as keywords em status launch_0_48h ou waiting_48h_review:
 *   1. Consulta sugestão Amazon → usa rangeLower
 *   2. Aplica min(rangeLower, safe_max_cpc) — mínimo R$0,60 se sem sugestão
 *   3. Atualiza ManualCampaignBidLifecycle → status amazon_bid_applied / no_amazon_suggestion
 *   4. Entrega ao motor de decisão (status = unified_engine_management)
 *
 * Processa UMA keyword por vez com 600ms de pausa para não dar rate limit.
 * Aceita parâmetro "batch_size" para controlar quantas keywords por chamada (default 10).
 * O orquestrador pode chamar múltiplas vezes até não restar mais keywords.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const FALLBACK_BID = 0.60;
const MIN_BID = 0.40;
const CALL_DELAY_MS = 600; // pausa entre chamadas Amazon

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function round2(v: number) { return Math.round(v * 100) / 100; }
function num(v: unknown): number { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; }
function nowIso() { return new Date().toISOString(); }

async function getToken(account: any): Promise<string | null> {
  const rt = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
  const cid = Deno.env.get('ADS_CLIENT_ID') || '';
  const csec = Deno.env.get('ADS_CLIENT_SECRET') || '';
  if (!rt || !cid) return null;
  try {
    const r = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: cid, client_secret: csec }).toString(),
    });
    if (!r.ok) return null;
    return (await r.json()).access_token || null;
  } catch { return null; }
}

function getEndpoint(account: any): string {
  const region = account.region || Deno.env.get('ADS_REGION') || 'na';
  return { na: 'https://advertising-api.amazon.com', eu: 'https://advertising-api-eu.amazon.com', fe: 'https://advertising-api-fe.amazon.com' }[region] || 'https://advertising-api.amazon.com';
}

async function fetchSuggestion(endpoint: string, token: string, profileId: string, kwId: string, agId: string, campId: string): Promise<{ lower: number | null; suggested: number | null; valid: boolean }> {
  try {
    const r = await fetch(`${endpoint}/sp/targets/bid/recommendations`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
        'Amazon-Advertising-API-Scope': profileId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ targetingExpressionRequests: [{ type: 'KEYWORD_BID', adGroupId: agId, campaignId: campId, keywordId: kwId }] }),
    });
    if (!r.ok) return { lower: null, suggested: null, valid: false };
    const data = await r.json();
    const rec = (data?.recommendations || [])[0];
    const sugg = rec?.suggestedBid?.suggested;
    const lower = rec?.suggestedBid?.rangeLower;
    if (sugg == null) return { lower: null, suggested: null, valid: false };
    return { lower: lower != null ? round2(num(lower)) : null, suggested: round2(num(sugg)), valid: true };
  } catch { return { lower: null, suggested: null, valid: false }; }
}

async function applyKeywordBid(endpoint: string, token: string, profileId: string, kwId: string, bid: number): Promise<{ success: boolean; requestId: string }> {
  try {
    const r = await fetch(`${endpoint}/sp/keywords`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
        'Amazon-Advertising-API-Scope': profileId,
        'Content-Type': 'application/vnd.spKeyword.v3+json',
        'Accept': 'application/vnd.spKeyword.v3+json',
      },
      body: JSON.stringify({ keywords: [{ keywordId: kwId, bid }] }),
    });
    const requestId = r.headers.get('x-amzn-requestid') || '';
    if (!r.ok) return { success: false, requestId };
    const data = await r.json();
    const ok = (data?.keywords?.success || []).some((s: any) => s.keywordId === kwId);
    return { success: ok, requestId };
  } catch { return { success: false, requestId: '' }; }
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  const now = nowIso();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const isAuth = await base44.auth.isAuthenticated().catch(() => false);
    if (!isAuth && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const batchSize = Number(body.batch_size || 10);
    const dryRun = body.dry_run === true;

    // ── Resolver conta ───────────────────────────────────────────────────
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });
    const aid = account.id;
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';

    // ── Carregar configurações ────────────────────────────────────────────
    const perfList = await base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, null, 1).catch(() => []);
    const settings = perfList[0] || {};
    const globalMaxBid = num(settings.max_bid || 5.0);
    const globalMaxCpc = num(settings.max_cpc || 0);
    const globalMinBid = num(settings.min_bid || MIN_BID);

    // Dados econômicos por ASIN para safe_max_cpc
    const econList = await base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, null, 200).catch(() => []);
    const econByAsin: Record<string, any> = {};
    for (const e of econList) { if (e.asin) econByAsin[e.asin] = e; }

    // ── Buscar lifecycles pendentes ────────────────────────────────────────
    const pendingStatuses = ['launch_0_48h', 'waiting_48h_review', 'no_amazon_suggestion'];
    let pending: any[] = [];
    for (const st of pendingStatuses) {
      const rows = await base44.asServiceRole.entities.ManualCampaignBidLifecycle.filter(
        { amazon_account_id: aid, status: st }, 'created_at', batchSize
      ).catch(() => []);
      pending.push(...rows);
      if (pending.length >= batchSize) break;
    }
    pending = pending.slice(0, batchSize);

    if (pending.length === 0) {
      return Response.json({ ok: true, processed: 0, message: 'Nenhum lifecycle pendente', duration_ms: Date.now() - t0 });
    }

    // ── Token Amazon ─────────────────────────────────────────────────────
    const token = await getToken(account);
    const endpoint = getEndpoint(account);
    const hasAccess = !!token && !!profileId;

    const results: any[] = [];
    let applied = 0, failed = 0, skipped = 0;

    for (const lc of pending) {
      const kwId = lc.keyword_id;
      const agId = lc.ad_group_id;
      const campId = lc.campaign_id;
      if (!kwId || !agId || !campId) { skipped++; continue; }

      const econ = econByAsin[lc.asin || ''] || null;
      const safeMaxCpc = econ?.safe_max_cpc || globalMaxCpc || 0;

      // Consultar sugestão Amazon
      let newBid = FALLBACK_BID;
      let bidSource = 'fallback_0.60';
      let suggestionData: any = null;

      if (hasAccess) {
        const sugg = await fetchSuggestion(endpoint, token!, profileId, kwId, agId, campId);
        suggestionData = sugg;

        if (sugg.valid && sugg.lower !== null) {
          // Usar rangeLower — o lance mínimo para aparecer
          const candidateBid = sugg.lower;
          const limits = [candidateBid];
          if (safeMaxCpc > 0) limits.push(safeMaxCpc);
          if (globalMaxCpc > 0) limits.push(globalMaxCpc);
          if (globalMaxBid > 0) limits.push(globalMaxBid);
          newBid = round2(Math.max(globalMinBid, Math.min(...limits)));
          bidSource = newBid < candidateBid ? 'amazon_lower_limited_by_guardrail' : 'amazon_lower_range';
        } else if (sugg.valid && sugg.suggested !== null) {
          newBid = round2(Math.max(globalMinBid, Math.min(sugg.suggested, safeMaxCpc > 0 ? safeMaxCpc : sugg.suggested)));
          bidSource = 'amazon_suggested';
        }
        // else: sem sugestão → mantém FALLBACK_BID
      }

      // Aplicar na Amazon
      let success = false;
      let requestId = '';
      if (!dryRun && hasAccess) {
        const res = await applyKeywordBid(endpoint, token!, profileId, kwId, newBid);
        success = res.success;
        requestId = res.requestId;
      } else if (dryRun) {
        success = true; // simular sucesso no dry_run
      }

      // Atualizar lifecycle
      const nextStatus = success ? 'unified_engine_management' : 'pending_confirmation';
      const lcUpdate: any = {
        post_48h_bid: newBid,
        post_48h_bid_source: bidSource,
        current_keyword_bid: success ? newBid : lc.current_keyword_bid,
        amazon_suggested_bid: suggestionData?.suggested ?? null,
        amazon_suggested_bid_lower: suggestionData?.lower ?? null,
        amazon_suggestion_valid: suggestionData?.valid ?? false,
        amazon_suggestion_fetched_at: hasAccess ? now : null,
        amazon_suggestion_limited_by_guardrail: bidSource.includes('limited'),
        post_48h_adjusted_at: success ? now : null,
        amazon_confirmed_at: success ? now : null,
        amazon_request_id: requestId || null,
        status: nextStatus,
        management_source: 'unified_decision_engine',
        last_action: `initial_bid_applied_R$${newBid}_source_${bidSource}`,
        last_action_at: now,
        updated_at: now,
      };

      await base44.asServiceRole.entities.ManualCampaignBidLifecycle.update(lc.id, lcUpdate).catch(() => {});

      // Registrar na fila de decisões para auditoria
      if (success && !dryRun) {
        await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id: aid,
          decision_type: 'bid_change',
          entity_type: 'keyword',
          entity_id: kwId,
          campaign_id: campId,
          keyword_id: kwId,
          keyword_text: lc.keyword_text || '',
          asin: lc.asin || '',
          action: 'set_bid',
          value_before: lc.current_keyword_bid || lc.initial_bid || 0.5,
          value_after: newBid,
          rationale: `🚀 BID INICIAL: ${bidSource === 'fallback_0.60' ? 'Sem sugestão Amazon — fallback R$0,60.' : `Mínimo sugerido Amazon R$${suggestionData?.lower} aplicado.`} Fonte: ${bidSource}. Entregue ao motor de decisão.`,
          status: 'executed',
          idempotency_key: `initial_bid|${aid}|${kwId}|${now.slice(0, 10)}`,
          source_function: 'applyInitialBidsToAllCampaigns',
          created_at: now,
        }).catch(() => {});
        applied++;
      } else if (!success) {
        failed++;
      }

      results.push({
        keyword_id: kwId,
        keyword_text: lc.keyword_text,
        asin: lc.asin,
        old_bid: lc.current_keyword_bid || lc.initial_bid,
        new_bid: newBid,
        bid_source: bidSource,
        success,
        status: nextStatus,
      });

      // Pausa entre keywords para respeitar rate limit Amazon
      await sleep(CALL_DELAY_MS);
    }

    // Log de execução
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'apply_initial_bids_to_all_campaigns',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: failed > 0 && applied === 0 ? 'error' : 'success',
      execution_date: now.slice(0, 10),
      started_at: new Date(t0).toISOString(),
      completed_at: nowIso(),
      duration_ms: Date.now() - t0,
      records_processed: applied,
      result_summary: `${applied} bids aplicados, ${failed} erros, ${skipped} ignorados. dry_run=${dryRun}`,
    }).catch(() => {});

    return Response.json({
      ok: true,
      dry_run: dryRun,
      processed: pending.length,
      applied,
      failed,
      skipped,
      has_amazon_access: hasAccess,
      fallback_bid: FALLBACK_BID,
      duration_ms: Date.now() - t0,
      results,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});