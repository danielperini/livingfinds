/**
 * runScheduledBidAdjustments — Executa alterações programadas de bids por dayparting e keywords
 *
 * Roda a cada hora (via automation). Seleciona ações da AmazonActionQueue cujo
 * scheduled_at caiu na janela horária atual (BRT ±30 min) e as executa na Amazon Ads API.
 *
 * Fluxo:
 *   1. Buscar ações pendentes/aprovadas com scheduled_at <= now + 5 min
 *   2. Filtrar por tipo: daypart_bid_increase, daypart_bid_decrease, daypart_bid_restore,
 *      keyword_bid_update, keyword_bid_restore
 *   3. Para cada ação: chamar Amazon Ads API PUT /sp/keywords com novo bid
 *   4. Registrar resultado em AmazonActionQueue + AdsBidChangeLog
 *   5. Agendar restore do bid base ao final do bloco (se aumento de pico)
 *
 * Guardrails:
 *   - Nunca abaixo de min_bid
 *   - Nunca acima de max_bid
 *   - Rate limit: pausa 300ms entre chamadas
 *   - Max 150 ações por execução
 *   - Idempotência por idempotency_key
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MAX_ACTIONS_PER_RUN = 150;
const API_DELAY_MS = 300;

// ── Amazon Ads API ────────────────────────────────────────────────────────────

const tokenCache: Record<string, { access_token: string; expires_at: number }> = {};

async function getAdsToken(refreshToken: string): Promise<string> {
  const cached = tokenCache['ads'];
  if (cached && cached.expires_at > Date.now() + 5000) return cached.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: Deno.env.get('ADS_CLIENT_ID') || '',
    client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Token failed');
  tokenCache['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBaseUrl(region: string): string {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function updateKeywordBid(
  keywordId: string, bid: number,
  refreshToken: string, profileId: string, region: string
): Promise<{ ok: boolean; status: number; requestId: string; error?: string }> {
  const token = await getAdsToken(refreshToken);
  const baseUrl = getAdsBaseUrl(region);
  const res = await fetch(`${baseUrl}/sp/keywords`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': 'application/vnd.spKeyword.v3+json',
      'Accept': 'application/vnd.spKeyword.v3+json',
    },
    body: JSON.stringify({ keywords: [{ keywordId, bid: Number(bid.toFixed(2)) }] }),
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  const requestId = res.headers.get('x-amzn-requestid') || '';

  // HTTP 207 = multi-status — verificar item a item
  if (res.status === 207) {
    const items = data?.keywords || data?.items || [];
    const item = items[0] || {};
    const code = item.code || item.status || '';
    if (['SUCCESS', 'CREATED', 'UPDATED'].includes(String(code).toUpperCase())) {
      return { ok: true, status: 200, requestId };
    }
    return { ok: false, status: 207, requestId, error: item.description || item.message || JSON.stringify(item) };
  }

  const ok = [200, 201].includes(res.status);
  return { ok, status: res.status, requestId, error: ok ? undefined : (data?.message || data?.error || String(res.status)) };
}

// ── Utilitários ───────────────────────────────────────────────────────────────

function nowIso(): string { return new Date().toISOString(); }

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// Hora BRT atual (UTC-3) como número 0-23
function currentHourBRT(): number {
  const utcH = new Date().getUTCHours();
  return (utcH - 3 + 24) % 24;
}

// Próxima ocorrência de uma hora BRT como ISO timestamp UTC
function nextBRTHourAsUTC(targetHourBRT: number): string {
  const now = new Date();
  const utcH = now.getUTCHours();
  const brtH = (utcH - 3 + 24) % 24;
  let hoursAhead = targetHourBRT - brtH;
  if (hoursAhead < 0) hoursAhead += 24;
  const target = new Date(now.getTime() + hoursAhead * 3600000);
  target.setUTCMinutes(0, 0, 0);
  return target.toISOString();
}

// ── Handler ───────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const startTime = Date.now();
  const base44 = createClientFromRequest(req);

  try {
    // Auth: aceita automação e usuário
    const body = await req.json().catch(() => ({}));
    try { await base44.auth.isAuthenticated(); } catch {}

    // Resolver conta
    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1);
      account = accs[0] || null;
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: true, skipped: true, reason: 'Nenhuma conta conectada' });

    const aid = account.id;
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
    const region = account.region || Deno.env.get('ADS_REGION') || 'NA';

    if (!refreshToken || !profileId) {
      return Response.json({ ok: false, error: 'Credenciais Amazon ausentes (refresh_token ou profile_id)' });
    }

    // Configuração: limites de bid
    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, null, 1);
    const cfg = configs[0] || {};
    if (cfg.dayparting_enabled === false) {
      return Response.json({ ok: true, skipped: true, reason: 'Dayparting desabilitado' });
    }
    const MIN_BID = Number(cfg.min_bid || 0.10);
    const MAX_BID = Number(cfg.max_bid || 5.0);

    // Janela: ações agendadas para até 30 min no futuro (para evitar atraso)
    const windowEnd = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const nowTs = nowIso();

    // ── 1. Buscar ações pendentes/aprovadas na janela ─────────────────────
    const allPending = await base44.asServiceRole.entities.AmazonActionQueue.filter(
      { amazon_account_id: aid, status: 'pending' }, 'scheduled_at', MAX_ACTIONS_PER_RUN
    );
    const allApproved = await base44.asServiceRole.entities.AmazonActionQueue.filter(
      { amazon_account_id: aid, status: 'approved' }, 'scheduled_at', MAX_ACTIONS_PER_RUN
    );

    const DAYPART_OPS = new Set([
      'daypart_bid_increase', 'daypart_bid_decrease', 'daypart_bid_restore',
      'keyword_bid_update', 'keyword_bid_restore',
    ]);

    // Filtrar: tipo dayparting + scheduled_at <= windowEnd + max_attempts não excedido
    const candidateActions = [...allPending, ...allApproved].filter(a => {
      if (!DAYPART_OPS.has(a.operation)) return false;
      if (!a.scheduled_at || a.scheduled_at > windowEnd) return false;
      if ((a.attempt_count || 0) >= (a.max_attempts || 3)) return false;
      return true;
    });

    // Deduplicar por idempotency_key
    const seen = new Set<string>();
    const actions = candidateActions.filter(a => {
      if (seen.has(a.idempotency_key)) return false;
      seen.add(a.idempotency_key);
      return true;
    });

    if (actions.length === 0) {
      return Response.json({ ok: true, skipped: true, reason: 'Sem ações programadas para esta janela horária', hour_brt: currentHourBRT() });
    }

    // ── 2. Carregar keywords para ter bid base (para restore) ────────────
    const keywordIds = [...new Set(actions.map(a => a.keyword_id || a.entity_id).filter(Boolean))];
    const kwByKeywordId = new Map<string, any>();
    if (keywordIds.length > 0) {
      const kwBatch = await base44.asServiceRole.entities.Keyword.filter(
        { amazon_account_id: aid }, null, 500
      );
      for (const kw of kwBatch) {
        if (kw.keyword_id) kwByKeywordId.set(kw.keyword_id, kw);
        if (kw.id) kwByKeywordId.set(kw.id, kw);
      }
    }

    // ── 3. Executar ações ────────────────────────────────────────────────
    const stats = { executed: 0, failed: 0, skipped: 0, restore_scheduled: 0 };
    const results: any[] = [];
    const errors: string[] = [];

    for (const action of actions) {
      const kwId = action.keyword_id || action.entity_id || '';
      if (!kwId) { stats.skipped++; continue; }

      // Ler payload da ação (pode ser objeto ou string serializada)
      let payload: any = {};
      try {
        if (typeof action.payload === 'string') payload = JSON.parse(action.payload);
        else if (action.payload && typeof action.payload === 'object') payload = action.payload;
      } catch { payload = {}; }

      const rawBid = payload.bid ?? payload.new_bid ?? payload.scheduled_bid;
      if (rawBid == null) {
        // Marcar como skipped
        await base44.asServiceRole.entities.AmazonActionQueue.update(action.id, {
          status: 'skipped',
          last_error: 'Payload sem campo bid',
          completed_at: nowTs,
        }).catch(() => {});
        stats.skipped++;
        continue;
      }

      // Aplicar guardrails de bid
      const newBid = Math.min(MAX_BID, Math.max(MIN_BID, Number(rawBid)));
      const baseBid = payload.bid_before ?? payload.base_bid ?? newBid;

      // Marcar como running
      await base44.asServiceRole.entities.AmazonActionQueue.update(action.id, {
        status: 'running',
        started_at: nowTs,
        attempt_count: (action.attempt_count || 0) + 1,
      }).catch(() => {});

      try {
        const apiResult = await updateKeywordBid(kwId, newBid, refreshToken, profileId, region);
        await sleep(API_DELAY_MS);

        if (apiResult.ok) {
          // Sucesso
          await base44.asServiceRole.entities.AmazonActionQueue.update(action.id, {
            status: 'completed',
            completed_at: nowIso(),
            result: JSON.stringify({ bid: newBid, request_id: apiResult.requestId }).slice(0, 500),
          }).catch(() => {});

          // Atualizar bid local na entidade Keyword
          const kw = kwByKeywordId.get(kwId);
          if (kw?.id) {
            await base44.asServiceRole.entities.Keyword.update(kw.id, {
              current_bid: newBid,
              bid: newBid,
            }).catch(() => {});
          }

          // Log de bid change
          await base44.asServiceRole.entities.AdsBidChangeLog.create({
            amazon_account_id: aid,
            keyword_id: kwId,
            campaign_id: action.campaign_id || payload.campaign_id || '',
            old_bid: baseBid,
            new_bid: newBid,
            change_pct: baseBid > 0 ? ((newBid - baseBid) / baseBid * 100) : 0,
            reason: action.operation,
            block_name: payload.block || payload.hour_block || '',
            classification: payload.classification || '',
            source: 'runScheduledBidAdjustments',
            status: 'executed',
            created_at: nowIso(),
          }).catch(() => {});

          // ── Agendar restore do bid base ao final do bloco horário ──────
          // Só para ações de AUMENTO — o bid base deve ser restaurado
          if (['daypart_bid_increase', 'keyword_bid_update'].includes(action.operation) && baseBid > 0) {
            const endHourBRT = payload.end_hour ?? (currentHourBRT() + 1);
            const restoreAt = nextBRTHourAsUTC(endHourBRT % 24);
            const restoreKey = `restore|${aid}|${kwId}|${endHourBRT}|${new Date().toISOString().slice(0, 13)}`;

            // Só criar restore se não existe
            const existingRestore = await base44.asServiceRole.entities.AmazonActionQueue.filter({
              amazon_account_id: aid,
              idempotency_key: restoreKey,
            }, null, 1).catch(() => []);

            if (!existingRestore.length) {
              await base44.asServiceRole.entities.AmazonActionQueue.create({
                amazon_account_id: aid,
                operation: 'daypart_bid_restore',
                entity_type: 'keyword',
                entity_id: kwId,
                keyword_id: kwId,
                campaign_id: action.campaign_id || '',
                payload: JSON.stringify({
                  bid: Number(baseBid.toFixed(2)),
                  bid_before: newBid,
                  base_bid: baseBid,
                  block: payload.block || '',
                  restore: true,
                }),
                idempotency_key: restoreKey,
                scheduled_at: restoreAt,
                priority: 'high',
                confidence: 100,
                status: 'approved',
                source: 'runScheduledBidAdjustments',
                created_at: nowIso(),
                max_attempts: 2,
              }).catch(() => {});
              stats.restore_scheduled++;
            }
          }

          stats.executed++;
          results.push({ kw: kwId, operation: action.operation, bid_before: baseBid, bid_after: newBid, ok: true });

        } else {
          // API retornou erro
          const isRateLimit = String(apiResult.status) === '429' || String(apiResult.error || '').includes('429');
          const newStatus = (action.attempt_count || 0) + 1 >= (action.max_attempts || 3) ? 'failed' : 'pending';

          await base44.asServiceRole.entities.AmazonActionQueue.update(action.id, {
            status: newStatus,
            last_error: apiResult.error || `HTTP ${apiResult.status}`,
            completed_at: newStatus === 'failed' ? nowIso() : undefined,
          }).catch(() => {});

          stats.failed++;
          errors.push(`${kwId}: ${apiResult.error}`);
          if (isRateLimit) await sleep(3000);
        }

      } catch (e: any) {
        await base44.asServiceRole.entities.AmazonActionQueue.update(action.id, {
          status: 'pending', // retentar
          last_error: e.message,
        }).catch(() => {});
        stats.failed++;
        errors.push(`${kwId}: ${e.message}`);
        await sleep(500);
      }
    }

    return Response.json({
      ok: true,
      hour_brt: currentHourBRT(),
      actions_found: actions.length,
      stats,
      errors: errors.slice(0, 10),
      duration_ms: Date.now() - startTime,
    });

  } catch (error: any) {
    console.error('[runScheduledBidAdjustments]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});