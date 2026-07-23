/**
 * runAcosViolationChecker v3 — Protect-Then-Pause (3 fases)
 *
 * FASE 1 (ACoS > target × 1.05):
 *   → Dispara runDeterministicDecisionEngine (conservador, fire-and-forget)
 *   → Status: optimizing_phase1, phase: phase1
 *   → Define optimization_cooldown_until = now + 48h
 *   → NÃO pausa
 *
 * ESPERA 48h: nas execuções dentro do cooldown, campanha é ignorada
 *
 * FASE 2 (cooldown passou E ACoS ainda > target × 1.10):
 *   → Dispara runDeterministicDecisionEngine novamente (conservador)
 *   → Chama GPT-4o para classificar: bid_adjustment_sufficient / dayparting_recommended / pause_recommended
 *   → Status: optimizing_phase2, phase: phase2
 *   → NÃO pausa (exceto se GPT=pause_recommended E threshold Fase 3 já atingido)
 *
 * FASE 3 (após Fase 2 E ACoS > target × 1.15):
 *   → MANUAL: pausa diretamente
 *   → AUTO: pausa apenas se zero conversões OU GPT recomendou pausa
 *   → Pausa via Amazon API usando amazonAdsTokenManager
 *
 * RESET: qualquer fase, se ACoS < target × 1.05 → recovered
 * Métricas: CampaignMetricsDaily (não SearchTerm)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function adsBase(region: string | undefined) {
  const v = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (v.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (v.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

/** Obtém access token via amazonAdsTokenManager (fonte canônica) */
async function getAccessToken(base44: any, accountId: string): Promise<string> {
  const res = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
    amazon_account_id: accountId,
    _service_role: true,
  });
  const data = res?.data || res;
  if (!data?.ok || !data?.access_token) {
    throw new Error(data?.message || data?.error || 'Falha ao obter access token');
  }
  return String(data.access_token);
}

/** Chama GPT-4o para classificar situação da campanha */
async function callGptPhase2(campaign: any, metrics: any, targetAcos: number): Promise<{ recommendation: string; rationale: string }> {
  const model = Deno.env.get('AI_WEEKLY_REVIEW_MODEL') || 'gpt-4o';
  const apiKey = Deno.env.get('OPENAI_API_KEY') || '';
  if (!apiKey) return { recommendation: 'bid_adjustment_sufficient', rationale: 'OPENAI_API_KEY não configurada — decisão conservadora padrão' };

  const prompt = `Você é um especialista em Amazon Ads. Analise a situação abaixo e classifique a ação recomendada.

Campanha: ${campaign.name || campaign.campaign_name || campaign.campaign_id}
Tipo: ${campaign.targeting_type?.toUpperCase() === 'AUTO' ? 'AUTO' : 'MANUAL'}
ASIN: ${campaign.asin || 'N/A'}
Target ACoS: ${targetAcos.toFixed(1)}%
ACoS Fase 1: ${metrics.phase1_acos?.toFixed(1) || 'N/A'}%
ACoS Fase 2 (atual): ${metrics.weekAcos.toFixed(1)}%
Spend semana: R$${metrics.spend.toFixed(2)}
Pedidos semana: ${metrics.orders}
Cliques semana: ${metrics.clicks}

Contexto: O motor já aplicou otimização de bids na Fase 1 (48h atrás). O ACoS continua acima do threshold de ×1.10.

Responda APENAS com JSON válido no formato:
{"recommendation": "bid_adjustment_sufficient" | "dayparting_recommended" | "pause_recommended", "rationale": "<justificativa em 1-2 frases>"}

- bid_adjustment_sufficient: bids foram ajustados e precisam de mais tempo para surtir efeito
- dayparting_recommended: padrão de horário suspeito, dayparting pode resolver sem pausar
- pause_recommended: campanha claramente ineficiente, pausa é o caminho correto`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 200,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) return { recommendation: 'bid_adjustment_sufficient', rationale: `GPT HTTP ${res.status} — decisão conservadora` };
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    const validRecs = ['bid_adjustment_sufficient', 'dayparting_recommended', 'pause_recommended'];
    return {
      recommendation: validRecs.includes(parsed.recommendation) ? parsed.recommendation : 'bid_adjustment_sufficient',
      rationale: String(parsed.rationale || '').slice(0, 500),
    };
  } catch {
    return { recommendation: 'bid_adjustment_sufficient', rationale: 'Erro ao consultar GPT — decisão conservadora' };
  }
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user || user.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
    }

    const accountId = body.amazon_account_id;
    if (!accountId) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });

    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: accountId }, null, 1);
    const config = configs[0] || {};

    const TARGET_ACOS   = config.target_acos || config.acos_target || 25;
    const MIN_SPEND     = config.min_spend_for_decision || 5;
    const COOLDOWN_DAYS = 2;

    // Thresholds escalonados sobre target_acos
    const THRESHOLD_PHASE1 = TARGET_ACOS * 1.05;
    const THRESHOLD_PHASE2 = TARGET_ACOS * 1.10;
    const THRESHOLD_PAUSE  = TARGET_ACOS * 1.15;

    const now    = new Date().toISOString();
    const nowMs  = Date.now();

    // ── 1. Métricas via CampaignMetricsDaily ─────────────────────────────
    const weekStart        = new Date(nowMs - 10 * 86400000).toISOString().slice(0, 10);
    const attributionCutoff = new Date(nowMs - 3 * 86400000).toISOString().slice(0, 10);

    const dailyMetrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: accountId }, '-date', 5000
    );

    const weekMetrics = new Map<string, { spend: number; sales: number; orders: number; clicks: number }>();
    for (const row of dailyMetrics) {
      if (!row.campaign_id || !row.date) continue;
      if (row.date > attributionCutoff || row.date < weekStart) continue;
      if (!weekMetrics.has(row.campaign_id)) weekMetrics.set(row.campaign_id, { spend: 0, sales: 0, orders: 0, clicks: 0 });
      const m = weekMetrics.get(row.campaign_id)!;
      m.spend  += row.spend  || 0;
      m.sales  += row.sales  || 0;
      m.orders += row.orders || 0;
      m.clicks += row.clicks || 0;
    }

    // ── 2. Carregar campanhas e violations ───────────────────────────────
    const [allCampaigns, existingViolations] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, null, 2000),
      base44.asServiceRole.entities.CampaignAcosViolation.filter({ amazon_account_id: accountId }, null, 2000),
    ]);

    const violationMap = new Map<string, any>(existingViolations.map((v: any) => [v.campaign_id, v]));

    const activeCampaigns = allCampaigns.filter((c: any) => {
      const st = (c.state || c.status || '').toLowerCase();
      return st === 'enabled' && !c.archived;
    });

    const stats = {
      campaigns_evaluated: activeCampaigns.length,
      violations_reset: 0,
      phase1_triggered: 0,
      phase2_triggered: 0,
      cooldown_skipped: 0,
      winner_protected: 0,
      campaigns_paused: 0,
      amazon_calls: 0,
      errors: 0,
    };

    const phase1List: any[] = [];
    const phase2List: any[] = [];
    const pausedList: any[] = [];
    const campaignsToPause: string[] = [];
    const pauseReasons = new Map<string, string>();

    for (const camp of activeCampaigns) {
      const cid = String(camp.campaign_id || camp.id || '');
      if (!cid) continue;

      const metrics = weekMetrics.get(cid) || weekMetrics.get(String(camp.id || ''));
      if (!metrics || metrics.spend < MIN_SPEND) continue;

      const weekAcos = metrics.sales > 0
        ? (metrics.spend / metrics.sales) * 100
        : (metrics.spend > 0 ? 999 : 0);

      const isAuto = String(camp.targeting_type || '').toUpperCase().includes('AUTO');
      const existing = violationMap.get(cid);
      const currentPhase = existing?.phase;

      // ── Proteção winner: conversões E ACoS ≤ target ─────────────────
      const orders14d = camp.orders || 0;
      const acos14d   = camp.acos   || 0;
      if (orders14d > 0 && acos14d > 0 && acos14d <= TARGET_ACOS) {
        if (existing && existing.status !== 'exempt') {
          await base44.asServiceRole.entities.CampaignAcosViolation.update(existing.id, {
            status: 'exempt', phase: null,
            notes: `Winner: ${orders14d} pedidos, ACoS ${acos14d.toFixed(1)}% ≤ target ${TARGET_ACOS}%`,
          }).catch(() => {});
        }
        stats.winner_protected++;
        continue;
      }

      // ── RESET: ACoS abaixo de threshold_phase1 ───────────────────────
      if (weekAcos < THRESHOLD_PHASE1) {
        if (existing && (existing.consecutive_violations || 0) > 0) {
          await base44.asServiceRole.entities.CampaignAcosViolation.update(existing.id, {
            consecutive_violations: 0,
            phase: 'recovered',
            status: 'recovered',
            reset_at: now,
            bids_reduced: false,
            dayparting_evaluated: false,
            optimization_cooldown_until: null,
            gpt_phase2_recommendation: null,
            gpt_phase2_rationale: null,
            notes: `ACoS ${weekAcos.toFixed(1)}% voltou abaixo de ${THRESHOLD_PHASE1.toFixed(1)}% em ${now.slice(0, 10)}`,
          });
          stats.violations_reset++;
        }
        continue;
      }

      // ── Campanha acima de threshold_phase1 ──────────────────────────

      // Campanha já em pausa pelo checker — pular
      if (currentPhase === 'paused') continue;

      // FASE 2 → FASE 3: cooldown passou E ACoS > threshold_pause
      if (currentPhase === 'phase2') {
        const cooldownUntil = existing?.optimization_cooldown_until;
        const cooldownPassed = !cooldownUntil || new Date(cooldownUntil).getTime() <= nowMs;

        if (!cooldownPassed) { stats.cooldown_skipped++; continue; }

        if (weekAcos <= THRESHOLD_PAUSE) {
          // ACoS entre phase2 e pause thresholds — aguardar mais
          await base44.asServiceRole.entities.CampaignAcosViolation.update(existing.id, {
            last_violation_at: now,
            phase2_acos: weekAcos,
            notes: `Fase 2 concluída: ACoS ${weekAcos.toFixed(1)}% abaixo do threshold de pausa (${THRESHOLD_PAUSE.toFixed(1)}%). Aguardando.`,
          }).catch(() => {});
          stats.cooldown_skipped++;
          continue;
        }

        // ACoS > THRESHOLD_PAUSE → avaliar pausa
        const gptRec = existing?.gpt_phase2_recommendation || 'bid_adjustment_sufficient';
        let shouldPause = false;
        let pauseReason = '';

        if (isAuto) {
          if (metrics.orders === 0 || gptRec === 'pause_recommended') {
            shouldPause = true;
            pauseReason = `AUTO Fase 3: ACoS ${weekAcos.toFixed(0)}% > ${THRESHOLD_PAUSE.toFixed(0)}% após 2 rodadas de otimização. Orders: ${metrics.orders}, GPT: ${gptRec}`;
          }
        } else {
          shouldPause = true;
          pauseReason = `MANUAL Fase 3: ACoS ${weekAcos.toFixed(0)}% > ${THRESHOLD_PAUSE.toFixed(0)}% após otimização de bids (Fase 1 + Fase 2). GPT: ${gptRec} — ${existing?.gpt_phase2_rationale || ''}`;
        }

        if (shouldPause) {
          campaignsToPause.push(cid);
          pauseReasons.set(cid, pauseReason);
          pausedList.push({ campaign_id: cid, name: camp.name || camp.campaign_name, type: isAuto ? 'AUTO' : 'MANUAL', acos: weekAcos, reason: pauseReason });
          await base44.asServiceRole.entities.CampaignAcosViolation.update(existing.id, {
            phase: 'paused', status: 'paused',
            paused_at: now,
            pause_reason: pauseReason,
            phase2_acos: weekAcos,
            last_violation_at: now,
          }).catch(() => {});
        }
        continue;
      }

      // FASE 1 → FASE 2: cooldown passou E ACoS > threshold_phase2
      if (currentPhase === 'phase1') {
        const cooldownUntil = existing?.optimization_cooldown_until;
        const cooldownPassed = !cooldownUntil || new Date(cooldownUntil).getTime() <= nowMs;

        if (!cooldownPassed) { stats.cooldown_skipped++; continue; }
        if (weekAcos <= THRESHOLD_PHASE2) {
          // ACoS melhorou para entre phase1 e phase2 — manter fase1 aguardando
          await base44.asServiceRole.entities.CampaignAcosViolation.update(existing.id, {
            last_violation_at: now,
            notes: `Pós-Fase 1: ACoS ${weekAcos.toFixed(1)}% ainda acima de ${THRESHOLD_PHASE1.toFixed(1)}% mas abaixo de ${THRESHOLD_PHASE2.toFixed(1)}%. Aguardando.`,
          }).catch(() => {});
          stats.cooldown_skipped++;
          continue;
        }

        // Avançar para Fase 2
        const newCooldown = new Date(nowMs + COOLDOWN_DAYS * 86400000).toISOString();

        // Fire-and-forget: segunda rodada determinística
        base44.asServiceRole.functions.invoke('runDeterministicDecisionEngine', {
          amazon_account_id: accountId,
          campaign_id: cid,
          mode: 'conservative',
          _service_role: true,
        }).catch(() => {});

        // Consultar GPT-4o
        const gptResult = await callGptPhase2(camp, { ...metrics, weekAcos, phase1_acos: existing?.phase1_acos || existing?.acos_cycle_1 || 0 }, TARGET_ACOS);

        const phase2Fields: any = {
          phase: 'phase2',
          status: 'optimizing_phase2',
          phase2_triggered_at: now,
          phase2_acos: weekAcos,
          acos_cycle_2: weekAcos,
          spend_cycle_2: metrics.spend,
          last_violation_at: now,
          consecutive_violations: (existing?.consecutive_violations || 1) + 1,
          optimization_cooldown_until: newCooldown,
          gpt_phase2_recommendation: gptResult.recommendation,
          gpt_phase2_rationale: gptResult.rationale,
          notes: `Fase 2 iniciada: ACoS ${weekAcos.toFixed(1)}%, GPT: ${gptResult.recommendation}. Cooldown até ${newCooldown.slice(0, 10)}.`,
        };
        await base44.asServiceRole.entities.CampaignAcosViolation.update(existing.id, phase2Fields).catch(() => {});

        phase2List.push({ campaign_id: cid, name: camp.name || camp.campaign_name, type: isAuto ? 'AUTO' : 'MANUAL', acos: weekAcos, gpt: gptResult.recommendation, cooldown_until: newCooldown });
        stats.phase2_triggered++;
        continue;
      }

      // SEM FASE ANTERIOR — iniciar Fase 1 (threshold_phase1 já validado acima)
      if (weekAcos > THRESHOLD_PHASE1) {
        const newCooldown = new Date(nowMs + COOLDOWN_DAYS * 86400000).toISOString();

        // Fire-and-forget: primeira rodada conservadora de bids
        base44.asServiceRole.functions.invoke('runDeterministicDecisionEngine', {
          amazon_account_id: accountId,
          campaign_id: cid,
          mode: 'conservative',
          _service_role: true,
        }).catch(() => {});

        const phase1Fields: any = {
          amazon_account_id: accountId,
          campaign_id: cid,
          campaign_name: camp.name || camp.campaign_name || cid,
          campaign_type: isAuto ? 'AUTO' : 'MANUAL',
          asin: camp.asin || '',
          phase: 'phase1',
          status: 'optimizing_phase1',
          phase1_triggered_at: now,
          phase1_acos: weekAcos,
          acos_cycle_1: weekAcos,
          spend_cycle_1: metrics.spend,
          first_violation_at: now,
          last_violation_at: now,
          consecutive_violations: 1,
          target_acos: TARGET_ACOS,
          maximum_acos: TARGET_ACOS * 1.15,
          optimization_attempted_at: now,
          optimization_cooldown_until: newCooldown,
          bids_reduced: true,
          dayparting_evaluated: false,
          gpt_phase2_recommendation: null,
          gpt_phase2_rationale: null,
          notes: `Fase 1 iniciada: ACoS ${weekAcos.toFixed(1)}% > ${THRESHOLD_PHASE1.toFixed(1)}%. Cooldown até ${newCooldown.slice(0, 10)}.`,
        };

        if (existing) {
          await base44.asServiceRole.entities.CampaignAcosViolation.update(existing.id, phase1Fields).catch(() => {});
        } else {
          await base44.asServiceRole.entities.CampaignAcosViolation.create(phase1Fields).catch(() => {});
        }

        phase1List.push({ campaign_id: cid, name: camp.name || camp.campaign_name, type: isAuto ? 'AUTO' : 'MANUAL', acos: weekAcos, cooldown_until: newCooldown });
        stats.phase1_triggered++;
      }
    }

    // ── 3. Batch guard: não pausar > 30% das campanhas ativas de uma vez ─
    const maxPauseAllowed = Math.max(1, Math.floor(activeCampaigns.length * 0.30));
    if (campaignsToPause.length > maxPauseAllowed) {
      campaignsToPause.splice(maxPauseAllowed);
    }

    // ── 4. Pausar na Amazon via tokenManager ─────────────────────────────
    if (campaignsToPause.length > 0) {
      const accessToken = await getAccessToken(base44, accountId);
      const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
      const baseUrl = adsBase(account.region);
      const authHeaders = {
        Authorization: `Bearer ${accessToken}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
        'Amazon-Advertising-API-Scope': String(profileId),
        'Content-Type': 'application/vnd.spCampaign.v3+json',
        Accept: 'application/vnd.spCampaign.v3+json',
      };

      for (let i = 0; i < campaignsToPause.length; i += 50) {
        const batch = campaignsToPause.slice(i, i + 50);
        const res = await fetch(`${baseUrl}/sp/campaigns`, {
          method: 'PUT',
          headers: authHeaders,
          body: JSON.stringify({ campaigns: batch.map(cid => ({ campaignId: cid, state: 'PAUSED' })) }),
        });
        stats.amazon_calls++;
        const ok = res.status >= 200 && res.status < 300 || res.status === 207;

        for (const cid of batch) {
          if (ok) {
            await base44.asServiceRole.entities.Campaign.updateMany(
              { amazon_account_id: accountId, campaign_id: cid },
              { $set: { state: 'PAUSED', status: 'paused', paused_by_acos_violation: true, pause_reason: pauseReasons.get(cid) || '', paused_at: now } }
            ).catch(() => {});
            stats.campaigns_paused++;
          } else {
            stats.errors++;
          }
        }
        await wait(2000);
      }
    }

    // ── 5. Log de execução ───────────────────────────────────────────────
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'runAcosViolationChecker',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: 'completed',
      started_at: now,
      completed_at: new Date().toISOString(),
      result_summary: JSON.stringify({
        evaluated: stats.campaigns_evaluated,
        winner_protected: stats.winner_protected,
        violations_reset: stats.violations_reset,
        phase1_triggered: stats.phase1_triggered,
        phase2_triggered: stats.phase2_triggered,
        cooldown_skipped: stats.cooldown_skipped,
        paused: stats.campaigns_paused,
        errors: stats.errors,
        thresholds: { phase1: THRESHOLD_PHASE1.toFixed(1), phase2: THRESHOLD_PHASE2.toFixed(1), pause: THRESHOLD_PAUSE.toFixed(1) },
      }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      stats,
      phase1: phase1List,
      phase2: phase2List,
      paused: pausedList,
      thresholds: { phase1: THRESHOLD_PHASE1, phase2: THRESHOLD_PHASE2, pause: THRESHOLD_PAUSE, target: TARGET_ACOS },
      ran_at: now,
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err?.message || 'Erro inesperado' }, { status: 500 });
  }
});