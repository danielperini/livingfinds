/**
 * confirmExecutedDecisions — Confirmação pós-execução na Amazon Ads API
 *
 * Após decisões serem marcadas como 'executed' localmente, este serviço
 * re-lê os valores reais da Amazon e verifica se foram aplicados.
 *
 * Cobre:
 *   - bids de keywords: GET /sp/keywords/list por keywordId
 *   - estados de campanhas: GET /sp/campaigns/list por campaignId
 *   - budgets de campanhas: mesma chamada de estados
 *
 * Se o valor na Amazon diverge do valor esperado:
 *   - Marca a decisão como 'failed' com motivo
 *   - Atualiza o banco local com o valor real da Amazon
 *   - Agenda retry via OptimizationDecision com status='approved'
 *
 * Janela de confirmação: decisões executadas nas últimas 6h (Amazon pode demorar até 5min para propagar)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function getAdsToken(account: any): Promise<string> {
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const secret   = Deno.env.get('ADS_CLIENT_SECRET') || '';
  const refresh  = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
  if (!refresh || !clientId) throw new Error('Credenciais ADS ausentes');
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId, client_secret: secret }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) throw new Error(d.error_description || `Token HTTP ${res.status}`);
  return d.access_token;
}

function adsBase(region: string) {
  const r = (region || 'na').toLowerCase();
  if (r.includes('eu')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('fe')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsPost(base: string, token: string, clientId: string, profileId: string, path: string, body: any, ct: string): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': ct, 'Accept': ct,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return {};
  return res.json().catch(() => ({}));
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    // Resolver conta
    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1);
      account = accs[0] || null;
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_date', 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });

    const aid = account.id;
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
    if (!profileId) return Response.json({ ok: false, skipped: true, reason: 'ads_profile_id ausente' });

    const token = await getAdsToken(account);
    const base = adsBase(account.region || 'na');
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const now = new Date().toISOString();
    const cutoff6h = new Date(Date.now() - 6 * 3600000).toISOString();

    // Carregar decisões executadas nas últimas 6h
    const executed = await base44.asServiceRole.entities.OptimizationDecision.filter(
      { amazon_account_id: aid, status: 'executed' }, '-executed_at', 100
    ).catch(() => []);

    const recent = executed.filter((d: any) => d.executed_at && d.executed_at >= cutoff6h);

    if (recent.length === 0) {
      return Response.json({ ok: true, confirmed: 0, divergences: 0, retried: 0, message: 'Nenhuma decisão recente para confirmar' });
    }

    // Separar por tipo de entidade
    const bidDecisions = recent.filter((d: any) => ['set_bid', 'reduce_bid', 'increase_bid', 'update_bid'].includes(d.action));
    const campDecisions = recent.filter((d: any) => ['pause_campaign', 'enable_campaign', 'set_budget', 'update_budget', 'reduce_budget', 'increase_budget'].includes(d.action));

    // ── 1. Confirmar bids de keywords ─────────────────────────────────────
    const kwIds = [...new Set(bidDecisions.map((d: any) => String(d.entity_id || d.keyword_id)).filter(Boolean))];
    const amazonKwById = new Map<string, any>();

    for (let i = 0; i < kwIds.length; i += 50) {
      const batch = kwIds.slice(i, i + 50);
      const data = await adsPost(base, token, clientId, profileId, '/sp/keywords/list',
        { keywordIdFilter: { include: batch }, maxResults: 50 },
        'application/vnd.spKeyword.v3+json'
      );
      for (const kw of (data?.keywords || [])) {
        amazonKwById.set(String(kw.keywordId), kw);
      }
      if (i + 50 < kwIds.length) await sleep(300);
    }

    // ── 2. Confirmar estados/budgets de campanhas ──────────────────────────
    const campIds = [...new Set(campDecisions.map((d: any) => String(d.campaign_id || d.entity_id)).filter(Boolean))];
    const amazonCampById = new Map<string, any>();

    for (let i = 0; i < campIds.length; i += 50) {
      const batch = campIds.slice(i, i + 50);
      const data = await adsPost(base, token, clientId, profileId, '/sp/campaigns/list',
        { campaignIdFilter: { include: batch }, maxResults: 50 },
        'application/vnd.spCampaign.v3+json'
      );
      for (const camp of (data?.campaigns || [])) {
        amazonCampById.set(String(camp.campaignId), camp);
      }
      if (i + 50 < campIds.length) await sleep(300);
    }

    // ── 3. Comparar e corrigir divergências ────────────────────────────────
    let confirmed = 0, divergences = 0, retried = 0;
    const divergenceLog: any[] = [];

    for (const d of bidDecisions) {
      const kwId = String(d.entity_id || d.keyword_id || '');
      const amz = amazonKwById.get(kwId);
      if (!amz) continue; // keyword pode estar pausada e não aparecer — ok

      const amzBid = Number(amz.bid?.amount ?? amz.bid ?? 0);
      const expectedBid = Number(d.value_after || 0);
      const diff = Math.abs(amzBid - expectedBid);

      if (diff < 0.01) {
        confirmed++;
        // Garantir que o banco local está atualizado
        const kws = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid, keyword_id: kwId }, null, 1).catch(() => []);
        if (kws[0] && Math.abs(Number(kws[0].bid || 0) - amzBid) > 0.01) {
          await base44.asServiceRole.entities.Keyword.update(kws[0].id, { bid: amzBid, current_bid: amzBid, synced_at: now }).catch(() => {});
        }
      } else {
        divergences++;
        divergenceLog.push({ type: 'bid_mismatch', keyword_id: kwId, expected: expectedBid, amazon: amzBid, diff });

        // Marcar decisão como failed e criar retry
        await base44.asServiceRole.entities.OptimizationDecision.update(d.id, {
          status: 'failed',
          error_message: `Confirmação Amazon divergente: esperado R$${expectedBid.toFixed(2)}, Amazon retornou R$${amzBid.toFixed(2)}`,
          updated_at: now,
        }).catch(() => {});

        // Atualizar banco local com valor real da Amazon
        const kws = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid, keyword_id: kwId }, null, 1).catch(() => []);
        if (kws[0]) {
          await base44.asServiceRole.entities.Keyword.update(kws[0].id, { bid: amzBid, current_bid: amzBid, synced_at: now }).catch(() => {});
        }

        // Criar nova decisão de retry se a diferença for relevante (>5%)
        if (expectedBid > 0 && diff / expectedBid > 0.05) {
          await base44.asServiceRole.entities.OptimizationDecision.create({
            amazon_account_id: aid,
            decision_type: 'bid_change',
            entity_type: d.entity_type || 'keyword',
            entity_id: d.entity_id,
            keyword_id: d.keyword_id,
            campaign_id: d.campaign_id,
            keyword_text: d.keyword_text,
            asin: d.asin,
            action: 'set_bid',
            value_before: amzBid,
            value_after: expectedBid,
            rationale: `RETRY confirmação: bid Amazon (R$${amzBid.toFixed(2)}) diverge do esperado (R$${expectedBid.toFixed(2)}). Re-aplicando.`,
            status: 'approved',
            approval_status: 'auto_approved',
            risk: 'low',
            confidence: 90,
            idempotency_key: `confirm_retry_${d.id}`,
            source_function: 'confirmExecutedDecisions',
            created_at: now,
          }).catch(() => {});
          retried++;
        }
      }
    }

    for (const d of campDecisions) {
      const campId = String(d.campaign_id || d.entity_id || '');
      const amz = amazonCampById.get(campId);
      if (!amz) continue;

      const amzState = (amz.state || '').toLowerCase();
      const amzBudget = Number(amz.budget?.budget ?? amz.dailyBudget ?? 0);
      let hasDivergence = false;

      // Verificar estado
      if (['pause_campaign', 'enable_campaign'].includes(d.action)) {
        const expectedState = d.action === 'pause_campaign' ? 'paused' : 'enabled';
        if (amzState && amzState !== expectedState) {
          hasDivergence = true;
          divergences++;
          divergenceLog.push({ type: 'state_mismatch', campaign_id: campId, expected: expectedState, amazon: amzState });

          await base44.asServiceRole.entities.OptimizationDecision.update(d.id, {
            status: 'failed',
            error_message: `Estado Amazon divergente: esperado ${expectedState}, Amazon retornou ${amzState}`,
            updated_at: now,
          }).catch(() => {});

          // Criar retry
          await base44.asServiceRole.entities.OptimizationDecision.create({
            amazon_account_id: aid,
            decision_type: 'pause', entity_type: 'campaign',
            entity_id: campId, campaign_id: campId, asin: d.asin,
            action: d.action,
            value_before: amzState, value_after: expectedState,
            rationale: `RETRY estado: Amazon retornou ${amzState} em vez de ${expectedState}`,
            status: 'approved', approval_status: 'auto_approved',
            risk: 'low', confidence: 90,
            idempotency_key: `confirm_retry_${d.id}`,
            source_function: 'confirmExecutedDecisions',
            created_at: now,
          }).catch(() => {});
          retried++;
        } else {
          confirmed++;
        }
      }

      // Verificar budget
      if (['set_budget', 'update_budget', 'reduce_budget', 'increase_budget'].includes(d.action)) {
        const expectedBudget = Number(d.value_after || 0);
        const budgetDiff = Math.abs(amzBudget - expectedBudget);
        if (amzBudget > 0 && budgetDiff > 0.10) {
          hasDivergence = true;
          divergences++;
          divergenceLog.push({ type: 'budget_mismatch', campaign_id: campId, expected: expectedBudget, amazon: amzBudget });

          await base44.asServiceRole.entities.OptimizationDecision.update(d.id, {
            status: 'failed',
            error_message: `Budget Amazon divergente: esperado R$${expectedBudget.toFixed(2)}, Amazon retornou R$${amzBudget.toFixed(2)}`,
            updated_at: now,
          }).catch(() => {});

          // Atualizar banco local
          const camps = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid, campaign_id: campId }, null, 1).catch(() => []);
          if (camps[0]) {
            await base44.asServiceRole.entities.Campaign.update(camps[0].id, { daily_budget: amzBudget, budget: amzBudget, updated_at: now }).catch(() => {});
          }
        } else if (!hasDivergence) {
          confirmed++;
        }
      }
    }

    // Log de auditoria
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'confirm_executed_decisions',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: 'success',
      execution_date: now.slice(0, 10),
      started_at: new Date(t0).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      records_processed: recent.length,
      result_summary: JSON.stringify({ confirmed, divergences, retried, kw_checked: kwIds.length, camp_checked: campIds.length }).slice(0, 500),
    }).catch(() => {});

    // Disparar fila se houver retries
    if (retried > 0) {
      base44.asServiceRole.functions.invoke('executeApprovedDecisionQueue', {
        amazon_account_id: aid, _service_role: true,
      }).catch(() => {});
    }

    return Response.json({
      ok: true,
      decisions_checked: recent.length,
      kw_checked: kwIds.length,
      camp_checked: campIds.length,
      confirmed,
      divergences,
      retried,
      divergence_log: divergenceLog.slice(0, 20),
      duration_ms: Date.now() - t0,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});