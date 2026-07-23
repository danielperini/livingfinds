/**
 * runMotorImediato — Pipeline completo do Motor v8
 * Sequência: sync → motor determinístico → camada IA → execução → confirmação
 * Retorna imediatamente com correlation_id; progresso via SyncExecutionLog polling.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

function uuid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ── Guardrails canônicos para decisões IA ──────────────────────────────────────
function validateAiDecision(dec, settings, campaignMetrics) {
  if (!dec || typeof dec !== 'object') return { valid: false, reason: 'not_object' };

  const validDecisionTypes = [
    'bid_adjustment', 'budget_adjustment', 'pause', 'reactivate',
    'keyword_add', 'keyword_negate', 'strategy_change', 'target_change',
    'placement_change', 'campaign_create', 'campaign_archive',
    'bid_change', 'increase_bid_profitable_growth', 'reduce_waste',
    'increase_budget_constrained', 'experimental_growth'
  ];
  if (!validDecisionTypes.includes(dec.decision_type)) {
    return { valid: false, reason: `invalid_decision_type: ${dec.decision_type}` };
  }

  // bid range check
  const minBid = settings?.min_bid || 0.40;
  const maxBid = settings?.max_bid || 5.00;
  if (dec.value_after !== undefined && dec.value_after !== null) {
    if (typeof dec.value_after !== 'number') return { valid: false, reason: 'value_after_not_number' };
    if (dec.decision_type.includes('bid') || dec.decision_type.includes('increase') || dec.decision_type.includes('reduce')) {
      if (dec.value_after < minBid || dec.value_after > maxBid) {
        return { valid: false, reason: `value_after ${dec.value_after} fora do range [${minBid}, ${maxBid}]` };
      }
    }
  }

  // winner protection: nunca pausar keyword com orders_14d > 0 e acos_14d <= target
  if (dec.decision_type === 'pause' || dec.action === 'pause_keyword' || dec.action === 'pause_campaign') {
    const targetAcos = settings?.target_acos || 15;
    const metrics = campaignMetrics?.[dec.campaign_id] || campaignMetrics?.[dec.entity_id];
    if (metrics) {
      const orders14d = metrics.orders_14d || 0;
      const acos14d = metrics.acos_14d;
      if (orders14d > 0 && acos14d !== null && acos14d <= targetAcos) {
        return { valid: false, reason: `winner_protection: ${orders14d} orders, ACoS ${acos14d}% <= target ${targetAcos}%` };
      }
    }
  }

  return { valid: true };
}

Deno.serve(async (req) => {
  const correlationId = uuid();
  const startedAt = new Date().toISOString();
  let base44;
  let aid;
  let syncLogId = null;

  try {
    base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const force = body.force === true;

    // ── Resolver conta ──────────────────────────────────────────────────────
    let account = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({}, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada.' });
    aid = account.id;

    // ── Verificar lock ativo ────────────────────────────────────────────────
    if (!force) {
      const locks = await base44.asServiceRole.entities.AmazonSchedulerLock.filter(
        { amazon_account_id: aid }, '-created_date', 1
      ).catch(() => []);
      if (locks.length > 0) {
        const lock = locks[0];
        const lockAge = (Date.now() - new Date(lock.created_date || lock.started_at || 0).getTime()) / 60000;
        if (lockAge < 30 && lock.status === 'locked') {
          return Response.json({
            ok: false,
            locked: true,
            correlation_id: lock.correlation_id || lock.id,
            message: `Motor em execução (lock ativo há ${Math.round(lockAge)}min). Use force=true para forçar.`,
          });
        }
      }
    }

    // ── PRIMEIRA OP: criar SyncExecutionLog com status=started ─────────────
    const syncLogData = await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'motor_v8_pipeline',
      trigger_type: force ? 'manual_force' : 'manual',
      status: 'started',
      execution_date: new Date().toISOString().slice(0, 10),
      started_at: startedAt,
      result_summary: JSON.stringify({
        correlation_id: correlationId,
        force,
        phase1: { status: 'pending' },
        phase2: { status: 'pending' },
        phase3: { status: 'pending' },
        phase4: { status: 'pending' },
        phase5: { status: 'pending' },
      }),
    });
    syncLogId = syncLogData?.id;

    // Responder imediatamente — pipeline roda em background via Deno
    // Usar EdgeRuntime.waitUntil se disponível, senão fire-and-forget
    const pipelinePromise = runPipeline({ base44, aid, account, correlationId, syncLogId, force, startedAt });

    // Tentar waitUntil para garantir execução em background
    try {
      // @ts-ignore
      if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(pipelinePromise);
      } else {
        pipelinePromise.catch(console.error);
      }
    } catch {
      pipelinePromise.catch(console.error);
    }

    return Response.json({
      ok: true,
      started: true,
      correlation_id: correlationId,
      sync_log_id: syncLogId,
      message: 'Pipeline Motor v8 iniciado. Acompanhe o progresso via polling do SyncExecutionLog.',
    });

  } catch (error) {
    console.error('[runMotorImediato] erro inicial:', error.message);

    if (syncLogId) {
      base44?.asServiceRole?.entities?.SyncExecutionLog?.update(syncLogId, {
        status: 'error',
        error_message: error.message,
        completed_at: new Date().toISOString(),
      }).catch(() => {});
    }

    return Response.json({ ok: false, error: error.message, correlation_id: correlationId }, { status: 500 });
  }
});

// ── Pipeline assíncrono ────────────────────────────────────────────────────────
async function runPipeline({ base44, aid, account, correlationId, syncLogId, force, startedAt }) {
  const now = () => new Date().toISOString();
  const summary = {
    correlation_id: correlationId,
    force,
    phase1: { status: 'pending' },
    phase2: { status: 'pending' },
    phase3: { status: 'pending' },
    phase4: { status: 'pending' },
    phase5: { status: 'pending' },
  };

  const updateLog = async (status, extra = {}) => {
    if (!syncLogId) return;
    await base44.asServiceRole.entities.SyncExecutionLog.update(syncLogId, {
      status,
      result_summary: JSON.stringify(summary),
      ...extra,
    }).catch(() => {});
  };

  // ── FASE 1: Sync de Dados ─────────────────────────────────────────────────
  const p1Start = Date.now();
  summary.phase1 = { status: 'running', started_at: now() };
  await updateLog('processing');

  try {
    const syncRes = await base44.asServiceRole.functions.invoke('syncAdsCampaignStatesV2', {
      amazon_account_id: aid,
      _service_role: true,
    });
    const syncData = syncRes?.data || syncRes;

    if (syncData?.ok === false) {
      const isTokenError = syncData?.amazon_status === 401 || syncData?.amazon_status === 403
        || (syncData?.amazon_error || '').includes('invalid_grant')
        || (syncData?.message || '').toLowerCase().includes('token');

      summary.phase1 = {
        status: 'error',
        duration_ms: Date.now() - p1Start,
        error: syncData?.message || syncData?.error || 'Sync falhou',
        amazon_status: syncData?.amazon_status,
        amazon_error: syncData?.amazon_error,
        refresh_token_present: !!account.ads_refresh_token,
        token_source: account.ads_access_token ? 'AmazonAccount' : 'ENV_FALLBACK',
        retryable: !isTokenError,
        link: isTokenError ? '/amazon-oauth-setup' : null,
      };
      await updateLog('error', {
        completed_at: now(),
        error_message: summary.phase1.error,
      });
      return;
    }

    summary.phase1 = {
      status: 'success',
      duration_ms: Date.now() - p1Start,
      records: syncData?.campaigns_synced || syncData?.records_processed || 0,
      token_source: syncData?.token_source || 'AmazonAccount',
      token_reused: syncData?.token_reused || false,
    };
    await updateLog('processing');
  } catch (e) {
    summary.phase1 = {
      status: 'error',
      duration_ms: Date.now() - p1Start,
      error: e.message,
      retryable: true,
    };
    await updateLog('error', { completed_at: now(), error_message: e.message });
    return;
  }

  // ── FASE 2: Motor Determinístico ──────────────────────────────────────────
  const p2Start = Date.now();
  summary.phase2 = { status: 'running', started_at: now() };
  await updateLog('processing');

  let motorResult = null;
  try {
    const motorRes = await base44.asServiceRole.functions.invoke('runDeterministicDecisionEngine', {
      amazon_account_id: aid,
      _service_role: true,
      force,
    });
    motorResult = motorRes?.data || motorRes;

    if (motorResult?.ok === false) {
      summary.phase2 = {
        status: 'error',
        duration_ms: Date.now() - p2Start,
        error: motorResult?.error || 'Motor falhou',
      };
      await updateLog('error', { completed_at: now(), error_message: summary.phase2.error });
      return;
    }

    summary.phase2 = {
      status: 'success',
      duration_ms: Date.now() - p2Start,
      decisions_generated: motorResult?.decisions_generated || motorResult?.decisions_saved || 0,
      stats: motorResult?.stats || {},
      account_acos_zone: motorResult?.account_acos_control_loop?.zone,
    };
    await updateLog('processing');
  } catch (e) {
    summary.phase2 = {
      status: 'error',
      duration_ms: Date.now() - p2Start,
      error: e.message,
    };
    await updateLog('error', { completed_at: now(), error_message: e.message });
    return;
  }

  // ── FASE 3: Camada IA (aditiva — nunca bloqueante) ─────────────────────────
  const p3Start = Date.now();
  summary.phase3 = { status: 'running', started_at: now() };
  await updateLog('processing');

  let aiDecisionsAdded = 0;
  try {
    const openaiKey = Deno.env.get('OPENAI_API_KEY');
    const modelName = Deno.env.get('AI_WEEKLY_REVIEW_MODEL') || 'gpt-4o-mini';

    if (!openaiKey) {
      summary.phase3 = { status: 'skipped', duration_ms: Date.now() - p3Start, reason: 'OPENAI_API_KEY not set', ai_decisions_added: 0 };
    } else {
      // Buscar dados para contexto IA
      const cutoff14d = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
      const [metrics14d, salesDaily, winners, productEcon, performSettings] = await Promise.all([
        base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 200).catch(() => []),
        base44.asServiceRole.entities.SalesDaily.filter({ amazon_account_id: aid }, '-date', 100).catch(() => []),
        base44.asServiceRole.entities.KeywordBank.filter({ amazon_account_id: aid, winner_tier: 'STRONG_WINNER' }, null, 50).catch(() => []),
        base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, null, 50).catch(() => []),
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1).catch(() => []),
      ]);

      const settings = performSettings[0] || {};
      const targetAcos = settings.target_acos || 15;
      const totalSpend = metrics14d.reduce((s, m) => s + (m.spend || 0), 0);
      const totalSales = metrics14d.reduce((s, m) => s + (m.sales || 0), 0);
      const accountAcos14d = totalSales > 0 ? Math.round((totalSpend / totalSales) * 10000) / 100 : null;

      // Agrupar métricas por campanha
      const campMetricsMap = {};
      for (const m of metrics14d) {
        if (!m.campaign_id || m.date < cutoff14d) continue;
        if (!campMetricsMap[m.campaign_id]) campMetricsMap[m.campaign_id] = { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 };
        campMetricsMap[m.campaign_id].spend += m.spend || 0;
        campMetricsMap[m.campaign_id].sales += m.sales || 0;
        campMetricsMap[m.campaign_id].orders += m.orders || 0;
        campMetricsMap[m.campaign_id].clicks += m.clicks || 0;
        campMetricsMap[m.campaign_id].impressions += m.impressions || 0;
      }

      const campaignSummaries = Object.entries(campMetricsMap)
        .filter(([, m]) => m.spend > 1)
        .map(([id, m]) => ({
          campaign_id: id,
          spend: Math.round(m.spend * 100) / 100,
          sales: Math.round(m.sales * 100) / 100,
          orders: m.orders,
          acos_14d: m.sales > 0 ? Math.round((m.spend / m.sales) * 10000) / 100 : null,
          orders_14d: m.orders,
        }))
        .sort((a, b) => (b.spend || 0) - (a.spend || 0))
        .slice(0, 20);

      // Construir payload IA
      const aiPayload = {
        account_acos_14d: accountAcos14d,
        target_acos: targetAcos,
        break_even_por_asin: productEcon.slice(0, 10).map(e => ({
          asin: e.asin,
          break_even_acos: e.break_even_acos || e.contribution_margin_percent,
          margin: e.contribution_margin_amount,
        })),
        campanhas_com_dados_14d: campaignSummaries,
        keywords_vencedoras: winners.slice(0, 10).map(k => ({
          keyword: k.keyword,
          asin: k.asin,
          acos: k.acos,
          orders: k.orders,
          winner_tier: k.winner_tier,
        })),
        produtos_com_estoque: [],
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      let aiRespBody = null;
      try {
        const aiResp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openaiKey}`,
          },
          body: JSON.stringify({
            model: modelName,
            max_tokens: 2000,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: 'Você é um otimizador de campanhas Amazon Ads. Analise os dados e retorne SOMENTE um JSON válido com a chave "decisions" contendo um array de decisões de otimização. Nunca invente dados. Nunca sugira pausa de campanha com vendas recentes (orders_14d > 0 e acos <= target_acos). Cada decisão deve ter: asin?, campaign_id?, keyword?, decision_type (enum: bid_adjustment|budget_adjustment|pause|reactivate|campaign_create), action (string), rationale (string), risk (low|medium|high), value_before? (number), value_after? (number).',
              },
              {
                role: 'user',
                content: JSON.stringify(aiPayload),
              },
            ],
          }),
        });
        clearTimeout(timeout);

        if (aiResp.ok) {
          const aiJson = await aiResp.json();
          const content = aiJson?.choices?.[0]?.message?.content;
          if (content) {
            try {
              aiRespBody = JSON.parse(content);
            } catch {
              aiRespBody = null;
            }
          }
        }
      } catch (fetchErr) {
        clearTimeout(timeout);
        const isTimeout = fetchErr.name === 'AbortError';
        summary.phase3 = {
          status: 'warning',
          duration_ms: Date.now() - p3Start,
          ai_error: isTimeout ? 'timeout_30s' : fetchErr.message,
          ai_decisions_added: 0,
        };
        await updateLog('processing');
      }

      if (aiRespBody) {
        const rawDecisions = Array.isArray(aiRespBody) ? aiRespBody : (aiRespBody.decisions || []);
        const now2 = new Date().toISOString();

        // Construir índice de métricas por campanha para winner protection
        const campaignMetricsForGuard = {};
        for (const c of campaignSummaries) {
          campaignMetricsForGuard[c.campaign_id] = { orders_14d: c.orders_14d, acos_14d: c.acos_14d };
        }

        const validDecisions = [];
        for (const dec of rawDecisions) {
          const check = validateAiDecision(dec, settings, campaignMetricsForGuard);
          if (!check.valid) {
            console.log(`[IA] Decisão rejeitada: ${check.reason}`);
            continue;
          }
          validDecisions.push({
            amazon_account_id: aid,
            run_id: correlationId,
            decision_type: dec.decision_type || 'bid_adjustment',
            entity_type: dec.campaign_id ? 'campaign' : (dec.keyword ? 'keyword' : 'account'),
            entity_id: dec.campaign_id || dec.keyword_id || dec.asin,
            campaign_id: dec.campaign_id,
            asin: dec.asin,
            action: dec.action,
            rationale: dec.rationale?.slice(0, 500),
            risk: dec.risk || 'medium',
            confidence: 70,
            value_before: dec.value_before,
            value_after: dec.value_after,
            status: 'approved',
            source_function: 'motor_v8_ai_layer',
            created_at: now2,
          });
        }

        if (validDecisions.length > 0) {
          await base44.asServiceRole.entities.OptimizationDecision.bulkCreate(validDecisions).catch(() => {});
          aiDecisionsAdded = validDecisions.length;
        }

        summary.phase3 = {
          status: 'success',
          duration_ms: Date.now() - p3Start,
          ai_decisions_added: aiDecisionsAdded,
          raw_suggestions: rawDecisions.length,
          rejected: rawDecisions.length - aiDecisionsAdded,
        };
      } else if (!summary.phase3.status || summary.phase3.status === 'running') {
        summary.phase3 = {
          status: 'warning',
          duration_ms: Date.now() - p3Start,
          ai_error: 'no_valid_response',
          ai_decisions_added: 0,
        };
      }
    }
  } catch (e) {
    console.error('[runMotorImediato] fase 3 erro (não bloqueante):', e.message);
    summary.phase3 = {
      status: 'warning',
      duration_ms: Date.now() - p3Start,
      ai_error: e.message,
      ai_decisions_added: 0,
    };
  }
  await updateLog('processing');

  // ── FASE 4: Execução na Amazon Ads ─────────────────────────────────────────
  const p4Start = Date.now();
  summary.phase4 = { status: 'running', started_at: now() };
  await updateLog('processing');

  try {
    const execRes = await base44.asServiceRole.functions.invoke('executeApprovedDecisionQueue', {
      amazon_account_id: aid,
      run_id: correlationId,
      _service_role: true,
    });
    const execData = execRes?.data || execRes;

    summary.phase4 = {
      status: execData?.ok === false ? 'error' : 'success',
      duration_ms: Date.now() - p4Start,
      executed: execData?.executed || execData?.decisions_executed || 0,
      failed: execData?.failed || execData?.decisions_failed || 0,
      by_type: execData?.by_type || execData?.breakdown || {},
      error: execData?.ok === false ? (execData?.error || 'Execução falhou') : undefined,
    };
  } catch (e) {
    summary.phase4 = {
      status: 'error',
      duration_ms: Date.now() - p4Start,
      error: e.message,
    };
  }
  await updateLog('processing');

  // ── FASE 5: Confirmação e Reconciliação ─────────────────────────────────────
  const p5Start = Date.now();
  summary.phase5 = { status: 'running', started_at: now() };
  await updateLog('processing');

  try {
    const confirmRes = await base44.asServiceRole.functions.invoke('confirmExecutedDecisions', {
      amazon_account_id: aid,
      _service_role: true,
    });
    const confirmData = confirmRes?.data || confirmRes;

    summary.phase5 = {
      status: 'success',
      duration_ms: Date.now() - p5Start,
      reconciled: confirmData?.reconciled || 0,
    };
  } catch (e) {
    summary.phase5 = {
      status: 'warning',
      duration_ms: Date.now() - p5Start,
      error: e.message,
    };
  }

  // ── Liberar lock (fire-and-forget) ─────────────────────────────────────────
  base44.asServiceRole.functions.invoke('acquireAmazonSchedulerLock', {
    amazon_account_id: aid,
    action: 'release',
    _service_role: true,
  }).catch(() => {});

  // ── Status final ───────────────────────────────────────────────────────────
  const hasError = ['phase1', 'phase2'].some(p => summary[p].status === 'error');
  const hasWarning = ['phase3', 'phase4', 'phase5'].some(p => summary[p].status === 'error' || summary[p].status === 'warning');
  const finalStatus = hasError ? 'error' : hasWarning ? 'warning' : 'success';

  const totalExecuted = summary.phase4.executed || 0;
  const totalDecisions = (summary.phase2.decisions_generated || 0) + (summary.phase3.ai_decisions_added || 0);

  summary.final = {
    status: finalStatus,
    total_decisions: totalDecisions,
    motor_decisions: summary.phase2.decisions_generated || 0,
    ai_decisions: summary.phase3.ai_decisions_added || 0,
    executed: totalExecuted,
    failed: summary.phase4.failed || 0,
    completed_at: now(),
    duration_total_ms: Date.now() - new Date(startedAt).getTime(),
  };

  await updateLog(finalStatus, {
    completed_at: now(),
    records_processed: totalExecuted,
    duration_ms: summary.final.duration_total_ms,
  });
}