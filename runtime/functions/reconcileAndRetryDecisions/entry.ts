/**
 * reconcileAndRetryDecisions
 *
 * Verifica se cada decisão executada pelo motor (bid, pause, budget) foi
 * efetivamente confirmada pela Amazon Ads API. Decisões não confirmadas
 * são colocadas numa lista interna de retry e reexecutadas até ter sucesso,
 * respeitando o time limit de 85s.
 *
 * Fluxo:
 *   1. Busca decisões com status 'executed' das últimas 24h
 *   2. Verifica o estado real na Amazon (keyword bid / campaign state)
 *   3. Se divergente → marca como 'failed' + tenta reexecutar imediatamente
 *   4. Decisões já marcadas 'failed' com < 5 tentativas → reexecuta
 *   5. Grava resultado em SyncExecutionLog
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const ADS_CLIENT_ID = Deno.env.get('ADS_CLIENT_ID') || '';
const ADS_CLIENT_SECRET = Deno.env.get('ADS_CLIENT_SECRET') || '';
const ADS_REGION = Deno.env.get('ADS_REGION') || 'na';
const ENDPOINT_MAP: Record<string, string> = {
  na: 'https://advertising-api.amazon.com',
  eu: 'https://advertising-api-eu.amazon.com',
  fe: 'https://advertising-api-fe.amazon.com',
};
const TIME_LIMIT_MS = 85000;
const MAX_ATTEMPTS = 5;
const RATE_DELAY_MS = 350;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function getAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: ADS_CLIENT_ID,
      client_secret: ADS_CLIENT_SECRET,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Token error ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function adsGet(token: string, profileId: string, path: string, body: any): Promise<any> {
  const endpoint = ENDPOINT_MAP[ADS_REGION] || ENDPOINT_MAP.na;
  // Determinar content-type pelo path
  const ct = path.includes('/sp/campaigns') ? 'application/vnd.spCampaign.v3+json'
    : path.includes('/sp/keywords') ? 'application/vnd.spKeyword.v3+json'
    : 'application/json';
  const res = await fetch(`${endpoint}${path}`, {
    method: 'POST',
    headers: {
      'Amazon-Advertising-API-ClientId': ADS_CLIENT_ID,
      'Amazon-Advertising-API-Scope': profileId,
      'Authorization': `Bearer ${token}`,
      'Content-Type': ct,
      'Accept': ct,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Amazon GET ${path} → ${res.status}`);
  return res.json();
}

async function adsPut(token: string, profileId: string, path: string, body: any): Promise<any> {
  const endpoint = ENDPOINT_MAP[ADS_REGION] || ENDPOINT_MAP.na;
  const ct = path.includes('/sp/campaigns') ? 'application/vnd.spCampaign.v3+json'
    : path.includes('/sp/keywords') ? 'application/vnd.spKeyword.v3+json'
    : 'application/json';
  const res = await fetch(`${endpoint}${path}`, {
    method: 'PUT',
    headers: {
      'Amazon-Advertising-API-ClientId': ADS_CLIENT_ID,
      'Amazon-Advertising-API-Scope': profileId,
      'Authorization': `Bearer ${token}`,
      'Content-Type': ct,
      'Accept': ct,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Verifica estado real de uma keyword na Amazon
async function verifyKeyword(token: string, profileId: string, keywordId: string): Promise<{ bid: number; state: string } | null> {
  try {
    const data = await adsGet(token, profileId, '/sp/keywords/list', {
      keywordIdFilter: { include: [keywordId] },
      maxResults: 1,
    });
    const kw = (data?.keywords || [])[0];
    if (!kw) return null;
    return { bid: kw.bid ?? kw.defaultBid ?? 0, state: kw.state || 'UNKNOWN' };
  } catch { return null; }
}

// Verifica estado real de uma campanha na Amazon
async function verifyCampaign(token: string, profileId: string, campaignId: string): Promise<{ state: string; budget: number } | null> {
  try {
    const data = await adsGet(token, profileId, '/sp/campaigns/list', {
      campaignIdFilter: { include: [campaignId] },
      maxResults: 1,
    });
    const camp = (data?.campaigns || [])[0];
    if (!camp) return null;
    return { state: camp.state || 'UNKNOWN', budget: camp.budget?.budget ?? 0 };
  } catch { return null; }
}

// Reaplicar uma decisão diretamente na Amazon
async function reapply(token: string, profileId: string, decision: any): Promise<{ ok: boolean; response: any }> {
  const action = decision.action;
  let res: any;

  if (['set_bid', 'reduce_bid', 'increase_bid', 'update_bid'].includes(action)) {
    res = await adsPut(token, profileId, '/sp/keywords', {
      keywords: [{ keywordId: String(decision.entity_id || decision.keyword_id), bid: Number(decision.value_after) }],
    });
    const payload = res?.keywords;
    const ok = (payload?.success?.length || 0) > 0 && (payload?.error?.length || 0) === 0;
    return { ok, response: res };

  } else if (['pause_keyword', 'enable_keyword'].includes(action)) {
    const state = action === 'pause_keyword' ? 'PAUSED' : 'ENABLED';
    res = await adsPut(token, profileId, '/sp/keywords', {
      keywords: [{ keywordId: String(decision.entity_id || decision.keyword_id), state }],
    });
    const payload = res?.keywords;
    const ok = (payload?.success?.length || 0) > 0 && (payload?.error?.length || 0) === 0;
    return { ok, response: res };

  } else if (['pause_campaign', 'enable_campaign'].includes(action)) {
    const state = action === 'pause_campaign' ? 'PAUSED' : 'ENABLED';
    res = await adsPut(token, profileId, '/sp/campaigns', {
      campaigns: [{ campaignId: String(decision.campaign_id || decision.entity_id), state }],
    });
    const payload = res?.campaigns;
    const ok = (payload?.success?.length || 0) > 0 && (payload?.error?.length || 0) === 0;
    return { ok, response: res };

  } else if (['set_budget', 'update_budget', 'reduce_budget', 'increase_budget'].includes(action)) {
    res = await adsPut(token, profileId, '/sp/campaigns', {
      campaigns: [{
        campaignId: String(decision.campaign_id || decision.entity_id),
        budget: { budgetType: 'DAILY', budget: Number(decision.value_after) },
      }],
    });
    const payload = res?.campaigns;
    const ok = (payload?.success?.length || 0) > 0 && (payload?.error?.length || 0) === 0;
    return { ok, response: res };
  }

  return { ok: false, response: { error: `action não suportada: ${action}` } };
}

// Verificar se uma decisão está confirmada na Amazon
async function isConfirmed(token: string, profileId: string, decision: any): Promise<boolean> {
  const action = decision.action;
  const tolerance = 0.01; // R$0.01 de tolerância para bids

  if (['set_bid', 'reduce_bid', 'increase_bid', 'update_bid'].includes(action)) {
    const kw = await verifyKeyword(token, profileId, String(decision.entity_id || decision.keyword_id));
    if (!kw) return false;
    return Math.abs(kw.bid - Number(decision.value_after)) <= tolerance;

  } else if (action === 'pause_keyword') {
    const kw = await verifyKeyword(token, profileId, String(decision.entity_id || decision.keyword_id));
    return kw?.state === 'PAUSED';

  } else if (action === 'enable_keyword') {
    const kw = await verifyKeyword(token, profileId, String(decision.entity_id || decision.keyword_id));
    return kw?.state === 'ENABLED';

  } else if (action === 'pause_campaign') {
    const camp = await verifyCampaign(token, profileId, String(decision.campaign_id || decision.entity_id));
    return camp?.state === 'PAUSED';

  } else if (action === 'enable_campaign') {
    const camp = await verifyCampaign(token, profileId, String(decision.campaign_id || decision.entity_id));
    return camp?.state === 'ENABLED';

  } else if (['set_budget', 'update_budget', 'reduce_budget', 'increase_budget'].includes(action)) {
    const camp = await verifyCampaign(token, profileId, String(decision.campaign_id || decision.entity_id));
    if (!camp) return false;
    return Math.abs(camp.budget - Number(decision.value_after)) <= tolerance;
  }

  // Ações não verificáveis (negative_keyword, create_keyword, etc.) → assumir confirmado
  return true;
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  const now = new Date().toISOString();
  const correlationId = `reconcile-${Date.now()}`;

  try {
    const base44 = createClientFromRequest(req);
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    const body = await req.json().catch(() => ({}));
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    // Resolver conta
    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1);
      account = accs[0] || null;
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, null, 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });

    const aid = account.id;
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';

    if (!profileId || !refreshToken) {
      return Response.json({ ok: false, error: 'Credenciais Ads ausentes (profile_id ou refresh_token)' });
    }

    // Obter access token
    let token: string;
    try {
      token = await getAccessToken(refreshToken);
    } catch (e: any) {
      return Response.json({ ok: false, error: `Falha ao obter token: ${e.message}` });
    }

    // Ações verificáveis
    const VERIFIABLE_ACTIONS = [
      'set_bid', 'reduce_bid', 'increase_bid', 'update_bid',
      'pause_keyword', 'enable_keyword',
      'pause_campaign', 'enable_campaign',
      'set_budget', 'update_budget', 'reduce_budget', 'increase_budget',
    ];

    // 1. Buscar decisões 'executed' das últimas 24h para verificação
    const cutoff24h = new Date(Date.now() - 24 * 3600000).toISOString();
    const recentExecuted = await base44.asServiceRole.entities.OptimizationDecision.filter(
      { amazon_account_id: aid, status: 'executed' }, '-executed_at', 200
    ).catch(() => []);
    const toVerify = recentExecuted
      .filter((d: any) => d.executed_at >= cutoff24h && VERIFIABLE_ACTIONS.includes(d.action));

    // 2. Buscar decisões 'failed' com tentativas restantes para retry
    const failedDecisions = await base44.asServiceRole.entities.OptimizationDecision.filter(
      { amazon_account_id: aid, status: 'failed' }, '-updated_at', 100
    ).catch(() => []);
    const toRetry = failedDecisions.filter((d: any) =>
      VERIFIABLE_ACTIONS.includes(d.action) &&
      Number(d.attempt_count || 0) < MAX_ATTEMPTS &&
      d.updated_at >= new Date(Date.now() - 48 * 3600000).toISOString()
    );

    const results = {
      verified: 0,
      confirmed: 0,
      divergent: 0,
      retried: 0,
      retry_success: 0,
      retry_failed: 0,
      skipped_time_limit: 0,
      details: [] as any[],
    };

    // ── Fase 1: Verificar decisões recentes executadas ──────────────────────
    for (const decision of toVerify) {
      if (Date.now() - t0 > TIME_LIMIT_MS) {
        results.skipped_time_limit += toVerify.length - results.verified;
        break;
      }

      results.verified++;
      let confirmed = false;
      try {
        confirmed = await isConfirmed(token, profileId, decision);
      } catch { confirmed = false; }

      if (confirmed) {
        results.confirmed++;
        results.details.push({ id: decision.id, action: decision.action, status: 'confirmed' });
      } else {
        results.divergent++;
        // Marcar como failed para entrar na fila de retry
        await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
          status: 'failed',
          error_message: 'reconcile: estado Amazon diverge do esperado — agendado para retry',
          updated_at: now,
        }).catch(() => {});
        results.details.push({ id: decision.id, action: decision.action, status: 'divergent_marked_for_retry' });
      }

      await sleep(RATE_DELAY_MS);
    }

    // ── Fase 2: Retry de todas as decisões falhadas (verificadas + anteriores) ──
    const allToRetry = [
      ...toRetry,
      // Adicionar as que acabaram de ser marcadas como failed (divergentes)
      ...results.details
        .filter(d => d.status === 'divergent_marked_for_retry')
        .map(d => toVerify.find((v: any) => v.id === d.id))
        .filter(Boolean),
    ];

    for (const decision of allToRetry) {
      if (Date.now() - t0 > TIME_LIMIT_MS) {
        results.skipped_time_limit += allToRetry.length - results.retried;
        break;
      }

      results.retried++;
      const attempts = Number(decision.attempt_count || 0) + 1;

      // Atualizar status para executing
      await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
        status: 'executing',
        attempt_count: attempts,
        last_attempt_at: now,
        updated_at: now,
      }).catch(() => {});

      let ok = false;
      let response: any = {};
      try {
        const result = await reapply(token, profileId, decision);
        ok = result.ok;
        response = result.response;
      } catch (e: any) {
        ok = false;
        response = { error: e.message };
      }

      // Verificar confirmação após retry
      if (ok) {
        await sleep(500); // pequena espera para Amazon propagar
        try {
          ok = await isConfirmed(token, profileId, decision);
        } catch { /* manter ok do PUT */ }
      }

      await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
        status: ok ? 'executed' : (attempts >= MAX_ATTEMPTS ? 'failed' : 'failed'),
        executed_at: ok ? now : null,
        error_message: ok ? null : `retry ${attempts}/${MAX_ATTEMPTS}: ${JSON.stringify(response).slice(0, 300)}`,
        amazon_response: JSON.stringify(response).slice(0, 2000),
        updated_at: now,
      }).catch(() => {});

      if (ok) results.retry_success++; else results.retry_failed++;
      results.details.push({
        id: decision.id,
        action: decision.action,
        attempt: attempts,
        status: ok ? 'retry_success' : 'retry_failed',
      });

      await sleep(RATE_DELAY_MS);
    }

    // ── Log de auditoria ───────────────────────────────────────────────────
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'reconcile_and_retry_decisions',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: results.divergent === 0 && results.retry_failed === 0 ? 'success' : 'warning',
      execution_date: now.slice(0, 10),
      started_at: new Date(t0).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      records_processed: results.verified + results.retried,
      result_summary: `verificadas=${results.verified} confirmadas=${results.confirmed} divergentes=${results.divergent} retries=${results.retried} sucesso=${results.retry_success} falha=${results.retry_failed} puladas=${results.skipped_time_limit}`,
    }).catch(() => {});

    return Response.json({
      ok: true,
      correlationId,
      duration_ms: Date.now() - t0,
      summary: results,
      note: `Verificação e retry automático de decisões do motor. MAX_ATTEMPTS=${MAX_ATTEMPTS}, TIME_LIMIT=85s.`,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});