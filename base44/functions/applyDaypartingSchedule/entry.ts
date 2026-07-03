/**
 * applyDaypartingSchedule v2 — Aplica dayparting por bid direto em keywords
 *
 * Lê o `dayparting_schedule` gravado no `data_used` da OptimizationDecision e:
 *   1. Para cada keyword da campanha: atualiza o bid direto conforme a hora agendada
 *      (na prática: grava o mapeamento hora→bid em DaypartingRule para o ciclo noturno)
 *   2. Cria Budget Rules nativas da Amazon para aumentar bid nos horários de pico
 *   3. Grava DaypartingRule para cada janela para que o ciclo horário (runHourlyAdsGuardrails)
 *      possa aplicar os bids programaticamente em tempo real
 *
 * Regras de bid:
 *   - peak_high_profit / peak_conversion → bid = recommendedBid (até +130%)
 *   - efficient → bid = baseBid (sem alteração)
 *   - deficit / low_efficiency → bid = R$0,25 (piso)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache: Record<string, any> = {};

async function getAdsToken(refreshToken: string) {
  const cached = tokenCache['ads'];
  if (cached && cached.expires_at > Date.now() + 5000) return cached.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: Deno.env.get('ADS_CLIENT_ID') || '',
    client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Token failed');
  tokenCache['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBaseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsRequest(method: string, path: string, body: any, refreshToken: string, profileId: string, contentType = 'application/json') {
  const token = await getAdsToken(refreshToken);
  const res = await fetch(`${getAdsBaseUrl()}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': contentType,
      'Accept': contentType,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data, requestId: res.headers.get('x-amzn-requestid') || '' };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // Aceita chamadas autenticadas (frontend) e chamadas internas de automação
    const isAuthenticated = await base44.auth.isAuthenticated().catch(() => false);
    const body = await req.json().catch(() => ({}));

    const { opportunity_id, approve = false, auto_apply = false } = body;
    if (!opportunity_id) return Response.json({ ok: false, error: 'opportunity_id required' }, { status: 400 });

    // Carregar decisão
    const opps = await base44.asServiceRole.entities.OptimizationDecision.filter({ id: opportunity_id });
    if (!opps.length) return Response.json({ ok: false, error: 'Decisão não encontrada' }, { status: 404 });
    const opp = opps[0];

    // Autorização: manual approve OU auto_apply com confiança >= 90
    const confidenceScore = opp.confidence || 0;
    const isAutoEligible = auto_apply && confidenceScore >= 90;
    if (!approve && !isAutoEligible) {
      return Response.json({ ok: false, error: `Aprovação necessária (confiança ${confidenceScore}% < 90% para auto-apply)` }, { status: 403 });
    }

    const accountId = opp.amazon_account_id;
    const campaignId = opp.campaign_id || opp.entity_id;

    // Carregar conta
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId });
    if (!accounts.length) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });
    const account = accounts[0];

    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
    if (!refreshToken || !profileId) return Response.json({ ok: false, error: 'Credenciais Amazon ausentes' }, { status: 400 });

    const now = new Date();
    const nowIso = now.toISOString();

    // Ler schedule gravado pelo runDailyDayparting
    let dataUsed: any = {};
    try { dataUsed = JSON.parse(opp.data_used || '{}'); } catch {}
    const schedule: any[] = dataUsed.dayparting_schedule || [];
    const baseBid: number = dataUsed.base_bid || 0.50;
    const BID_FLOOR = dataUsed.bid_floor || 0.25;

    if (schedule.length === 0) {
      return Response.json({ ok: false, error: 'dayparting_schedule vazio na decisão — rode runDailyDayparting novamente' }, { status: 400 });
    }

    // ── Carregar keywords da campanha ─────────────────────────────────────
    const campaignKeywords = await base44.asServiceRole.entities.Keyword.filter(
      { amazon_account_id: accountId, campaign_id: campaignId, state: 'enabled' }, null, 200
    );

    const results = {
      campaign_id: campaignId,
      rules_created: [] as any[],
      keywords_scheduled: 0,
      errors: [] as string[],
      base_bid: baseBid,
      bid_floor: BID_FLOOR,
      peak_windows: schedule.filter(s => ['peak_high_profit', 'peak_conversion'].includes(s.classification)).length,
      deficit_windows: schedule.filter(s => ['deficit', 'low_efficiency'].includes(s.classification)).length,
    };

    // ── Gravar DaypartingRule para CADA JANELA HORÁRIA ─────────────────────
    // O ciclo runHourlyAdsGuardrails lê essas regras e aplica os bids em tempo real
    for (const slot of schedule) {
      const isPeak    = ['peak_high_profit', 'peak_conversion'].includes(slot.classification);
      const isDeficit = ['deficit', 'low_efficiency'].includes(slot.classification);

      if (!isPeak && !isDeficit) continue; // 'efficient' e 'discovery' não alteram bid

      const adjustmentValue = isPeak
        ? Math.round(slot.bidChangePct)   // ex: +130
        : -100; // déficit → bid vai para o piso (sinalizador)

      try {
        await base44.asServiceRole.entities.DaypartingRule.create({
          amazon_account_id: accountId,
          campaign_id: campaignId,
          asin: opp.asin,
          rule_type: 'bid_schedule',
          days_of_week: [0, 1, 2, 3, 4, 5, 6], // todos os dias (análise horária geral)
          start_hour: slot.hour,
          end_hour: slot.hour,  // janela de 1 hora
          adjustment_type: isDeficit ? 'floor' : 'percentage',
          adjustment_value: adjustmentValue,
          bid_base_before: baseBid,
          bid_floor: BID_FLOOR,
          recommended_bid: slot.recommendedBid,
          status: 'active',
          confidence: confidenceScore,
          classification: slot.classification,
          roas_at_creation: slot.roas,
          rationale: isPeak
            ? `Pico ${slot.hour}h: ROAS ${slot.roas}x (índice ${slot.roasIndex}x) → bid R$${slot.recommendedBid} (+${slot.bidChangePct.toFixed(0)}%)`
            : `Baixa ${slot.hour}h: sem retorno → bid piso R$${BID_FLOOR}`,
          created_by: 'ai',
          approved_by: isAuthenticated ? 'user' : 'autopilot',
          approved_at: nowIso,
          executed_at: nowIso,
          created_at: nowIso,
          updated_at: nowIso,
        });

        results.rules_created.push({
          hour: slot.hour,
          classification: slot.classification,
          base_bid: baseBid,
          recommended_bid: slot.recommendedBid,
          bid_change_pct: slot.bidChangePct,
        });
      } catch (e) {
        results.errors.push(`Erro ao gravar regra hora ${slot.hour}: ${e.message}`);
      }
    }

    // ── Tentar criar Budget Rules nativas da Amazon para os picos ──────────
    // (Bid Adjustment Rules via /sp/bidAdjustments — melhor suporte nativo)
    const peakSlots = schedule.filter(s => ['peak_high_profit', 'peak_conversion'].includes(s.classification));
    for (const slot of peakSlots.slice(0, 10)) { // máx 10 regras
      const increasePct = Math.min(130, Math.max(10, Math.round(slot.bidChangePct)));
      if (increasePct <= 0) continue;

      try {
        // Regra nativa via /sp/rules (Schedule Bid Adjustments)
        const rulePayload = {
          name: `DP-${campaignId.slice(-6)}-H${slot.hour}-+${increasePct}PCT`,
          campaignId,
          rules: [{
            conditions: [{ timeRange: { start: `${String(slot.hour).padStart(2, '0')}:00`, end: `${String(slot.hour).padStart(2, '0')}:59` } }],
            bidMultiplier: increasePct,
          }],
          timeZone: 'America/Sao_Paulo',
        };
        const resp = await adsRequest('POST', '/sp/rules', rulePayload, refreshToken, profileId, 'application/vnd.spRule.v1+json');
        if ([200, 201, 207].includes(resp.status)) {
          const ruleId = resp.data?.ruleId || resp.data?.[0]?.ruleId || 'ok';
          // Atualizar a DaypartingRule com o amazon_rule_id
          results.rules_created.filter(r => r.hour === slot.hour).forEach(r => r.amazon_rule_id = ruleId);
        }
        // Rate limit
        await new Promise(r => setTimeout(r, 300));
      } catch {
        // Falha na regra nativa não é crítica — regra local já foi gravada
      }
    }

    // ── Salvar bid original para rollback ────────────────────────────────
    try {
      const existing = await base44.asServiceRole.entities.BidHistory.filter({
        amazon_account_id: accountId,
        entity_type: 'campaign',
        entity_id: campaignId,
        reason: 'Dayparting original bid capture',
      });
      if (!existing.length) {
        await base44.asServiceRole.entities.BidHistory.create({
          amazon_account_id: accountId,
          entity_type: 'campaign',
          entity_id: campaignId,
          entity_name: campaignId,
          old_bid: baseBid,
          new_bid: baseBid,
          change_pct: 0,
          reason: 'Dayparting original bid capture',
          status: 'executed',
          applied_by: 'dayparting',
          decision_id: opp.id,
          created_at: nowIso,
          executed_at: nowIso,
        });
      }
    } catch {}

    results.keywords_scheduled = campaignKeywords.length;

    // Finalizar decisão
    await base44.asServiceRole.entities.OptimizationDecision.update(opp.id, {
      status: 'executed',
      executed_at: nowIso,
      amazon_response: JSON.stringify({
        rules_created: results.rules_created.length,
        peak_windows: results.peak_windows,
        deficit_windows: results.deficit_windows,
        keywords_in_campaign: results.keywords_scheduled,
        errors: results.errors,
      }).slice(0, 2000),
    });

    return Response.json({
      ok: true,
      results,
      schedule_summary: {
        total_windows: schedule.length,
        peak_windows: results.peak_windows,
        deficit_windows: results.deficit_windows,
        base_bid: baseBid,
        bid_floor: BID_FLOOR,
        max_bid: Math.max(...schedule.map(s => s.recommendedBid || baseBid)),
      },
      executed_at: nowIso,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});