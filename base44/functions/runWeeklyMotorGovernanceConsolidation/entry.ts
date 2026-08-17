import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { productAdsEligibility } from '../../shared/productAdsEligibility.ts';

const MODEL = Deno.env.get('AI_WEEKLY_REVIEW_MODEL') || 'gpt-4o';
const BLOCKED_STATUSES = new Set(['blocked', 'failed', 'failed_final', 'cancelled', 'skipped']);
const HARD_GUARD = /(ACCOUNT_KILL_SWITCH|ACCOUNT_DAILY_CAP|PRODUCT_NOT_ELIGIBLE|OUT_OF_STOCK|NOT_BUYABLE|ECONOMICS_INCOMPLETE|LOW_ECONOMIC_CONFIDENCE|SAFE_CPC|BREAK_EVEN|CONFIRMED_ECONOMIC_LOSS|MARGIN|BATCH_PAUSE_BLOCKED)/i;
const STRUCTURAL_RECOVERABLE = /(STALE_MANUAL_BID_SCOPE|noncanonical_group|campaign_missing|keyword_missing|STRUCTURE_INCOMPLETE|mapping_conflict)/i;
const DATA_RECOVERABLE = /(STALE_DATA|freshness|snapshot|ads_data|sp_api|data_age)/i;
const DELIVERY_RECOVERABLE = /(ZERO_DELIVERY|ZERO_IMPRESSIONS|no_impressions|delivery)/i;
const QUEUE_RECOVERABLE = /(queue|timeout|throttl|429|502|503|504|retry|processing)/i;
const RISK_SIGNAL = /(increase_bid|increase_budget|redistribute_budget|PROFITABLE_GROWTH|growth)/i;

const invoke = async (base44: any, name: string, payload: Record<string, unknown>) => {
  try {
    const response = await base44.asServiceRole.functions.invoke(name, payload);
    return response?.data || response || { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.response?.data?.error || error?.message || String(error) };
  }
};

const norm = (value: unknown) => String(value || '').trim();
const upper = (value: unknown) => norm(value).toUpperCase();
const decisionTimestamp = (row: any) => row?.created_at || row?.created_date || row?.evaluated_at || row?.updated_at || row?.executed_at || null;
const decisionReason = (row: any) => norm(row?.reason_code || row?.rule_key || row?.execution_error || row?.error_message || row?.rationale || row?.status);

function classifyBlocker(row: any) {
  const reason = decisionReason(row);
  if (HARD_GUARD.test(reason)) return 'hard_guardrail';
  if (STRUCTURAL_RECOVERABLE.test(reason)) return 'structural_replan';
  if (DATA_RECOVERABLE.test(reason)) return 'refresh_data';
  if (DELIVERY_RECOVERABLE.test(reason)) return 'delivery_replan';
  if (QUEUE_RECOVERABLE.test(reason)) return 'queue_reconcile';
  return 'review_required';
}

function productKey(asin: unknown) { return upper(asin); }

Deno.serve(async (request) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    let accountId = body.amazon_account_id || null;
    if (!accountId) {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 1).catch(() => []);
      accountId = accounts[0]?.id || null;
    }
    if (!accountId) return Response.json({ ok: false, error: 'AmazonAccount conectada não encontrada' }, { status: 404 });

    // O supervisor semanal existente continua sendo a única fonte de novas regras.
    // Ele cria apenas versões shadow após validação/backtest. Esta função não cria
    // um segundo motor: ela governa bloqueios e aciona alternativas canônicas.
    const weeklyRuleReview = body.skip_rule_review === true
      ? { ok: true, skipped: true }
      : await invoke(base44, 'runWeeklyClaudeRuleReview', { amazon_account_id: accountId, _service_role: true });

    const cutoff = Date.now() - 7 * 86400000;
    const [decisions, products, campaigns] = await Promise.all([
      base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-created_at', 5000).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, '-updated_at', 2000).catch(() => []),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []),
    ]);

    const productsByAsin = new Map(products.filter((p: any) => p.asin).map((p: any) => [productKey(p.asin), p]));
    const recent = decisions.filter((row: any) => {
      const timestamp = new Date(String(decisionTimestamp(row) || 0)).getTime();
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    });
    const blocked = recent.filter((row: any) => BLOCKED_STATUSES.has(norm(row.status).toLowerCase()));
    const executed = recent.filter((row: any) => ['executed', 'confirmed', 'completed'].includes(norm(row.status).toLowerCase()) || row.amazon_confirmed === true || row.confirmed_at);

    const blockerRows = blocked.map((row: any) => {
      const asin = upper(row.asin);
      const product = productsByAsin.get(asin);
      const eligibility = productAdsEligibility(product);
      return {
        id: row.id,
        asin,
        campaign_id: row.campaign_id || null,
        keyword_id: row.keyword_id || row.entity_id || null,
        action: row.action || row.action_type || null,
        status: row.status,
        reason: decisionReason(row),
        blocker_class: classifyBlocker(row),
        product_eligible_now: eligibility.eligible,
        product_reason_now: eligibility.reason,
      };
    });

    const counts = blockerRows.reduce((acc: Record<string, number>, row: any) => {
      acc[row.blocker_class] = (acc[row.blocker_class] || 0) + 1;
      return acc;
    }, {});

    const riskyExecuted = executed.filter((row: any) => {
      const action = norm(row.action || row.action_type);
      const before = Number(row.value_before ?? row.current_value ?? row.previous_bid ?? 0);
      const after = Number(row.value_after ?? row.proposed_value ?? row.new_bid ?? 0);
      const increasePct = before > 0 && after > before ? (after - before) / before : 0;
      return RISK_SIGNAL.test(`${action} ${decisionReason(row)}`) && increasePct > 0.10;
    });

    let aiAssessment: any = { available: false, blocker_policy: [], warnings: [] };
    const openaiKey = Deno.env.get('OPENAI_API_KEY');
    if (openaiKey && blockerRows.length) {
      const prompt = `Você supervisiona o motor unificado Amazon Ads Living Finds. Analise os impedimentos da última semana e classifique SOMENTE em JSON.\n\nREGRAS INVIOLÁVEIS:\n- Nunca recomendar remover guardrails de estoque, buyability, break-even, CPC seguro, margem, teto diário ou kill switch.\n- Quando um bloqueio for estrutural, prefira canonicalização/reparo e nova avaliação no mesmo motor.\n- Quando dados estiverem vencidos, prefira refresh antes de qualquer decisão.\n- Zero delivery pode receber no máximo recuperação economicamente segura; nunca aumento ilimitado.\n- Não criar outro motor, fila ou executor.\n- Mudanças de regra só podem entrar em shadow/backtest pelo runWeeklyClaudeRuleReview.\n\nAÇÕES OPERACIONAIS AUTORIZADAS PARA SUA RECOMENDAÇÃO: canonicalize_manual_structure, refresh_data, repair_zero_delivery, reconcile_queues, harvest_winners, hold_hard_guardrail, tighten_risk, no_action.\n\nDADOS: ${JSON.stringify({ counts, blocked_sample: blockerRows.slice(0, 200), risky_executed_sample: riskyExecuted.slice(0, 50) })}\n\nRetorne: {\"blocker_policy\":[{\"blocker_class\":\"\",\"recommended_action\":\"\",\"reason\":\"\",\"rigidity_assessment\":\"appropriate|too_rigid|too_loose|conflicting\"}],\"warnings\":[],\"risk_recalibration_needed\":true|false}`;
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, temperature: 0.1, max_tokens: 1800, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }),
      }).catch(() => null);
      if (response?.ok) {
        const payload = await response.json().catch(() => ({}));
        try {
          aiAssessment = { available: true, ...JSON.parse(payload?.choices?.[0]?.message?.content || '{}') };
        } catch {
          aiAssessment = { available: false, blocker_policy: [], warnings: ['AI_JSON_INVALID'] };
        }
      }
    }

    const requestedActions = new Set((aiAssessment.blocker_policy || []).map((item: any) => norm(item.recommended_action)));
    // Deterministic fallback: repeated recoverable blockers are treated even if GPT
    // is unavailable. Hard financial protection is never weakened automatically.
    if ((counts.structural_replan || 0) > 0) requestedActions.add('canonicalize_manual_structure');
    if ((counts.refresh_data || 0) > 0) requestedActions.add('refresh_data');
    if ((counts.delivery_replan || 0) > 0) requestedActions.add('repair_zero_delivery');
    if ((counts.queue_reconcile || 0) > 0) requestedActions.add('reconcile_queues');

    const common = { amazon_account_id: accountId, _service_role: true, _canonical_orchestrator: 'runUnifiedDecisionEngine' };
    const actions: Record<string, any> = {};

    if (requestedActions.has('canonicalize_manual_structure')) {
      actions.manual_structure = await invoke(base44, 'enforceCanonicalManualCampaigns', { ...common, trigger_type: 'weekly_governance_replan' });
      actions.manual_scope = await invoke(base44, 'reconcileManualBidCycleScope', { ...common, skip_sync: true });
    }
    if (requestedActions.has('refresh_data')) {
      actions.report_refresh = await invoke(base44, 'ensureDailyReportsCurrent', { ...common, force: true });
      actions.snapshot_refresh = await invoke(base44, 'buildCanonicalMarketplaceSnapshots', { ...common, mode: 'incremental', persist: true, window_minutes: 15 });
    }
    if (requestedActions.has('repair_zero_delivery')) {
      actions.delivery_repair = await invoke(base44, 'reconcileCampaignDeliveryHealth', {
        ...common, prioritize_zero_delivery_rotation: true, delivery_lookback_days: 7,
        max_replacements_per_run: 10, max_structure_repairs_per_run: 5, max_bid_recoveries_per_run: 3,
        trigger_type: 'weekly_governance_zero_delivery',
      });
    }
    if (requestedActions.has('reconcile_queues')) {
      actions.queue_reconciliation = await invoke(base44, 'reconcileOperationalQueues', { ...common, dry_run: false, trigger_type: 'weekly_governance_queue' });
    }
    if (requestedActions.has('harvest_winners')) {
      actions.harvest_growth = await invoke(base44, 'runServingCampaignGrowthObjective', {
        ...common, max_new_exact_per_run: 5, max_auto_budget_expansions: 2, delivery_lookback_days: 7,
        trigger_type: 'weekly_governance_harvest',
      });
    }

    // Toda correção termina no mesmo orquestrador. Nenhuma ação acima executa um
    // motor paralelo; o Unified Engine reavalia o estado consolidado.
    actions.unified_recheck = await invoke(base44, 'runUnifiedDecisionEngine', {
      ...common, dry_run: false, skip_sync: true, force_campaign_lifecycle: true,
      trigger_type: 'weekly_governance_consolidation',
    });

    const resultSummary = `7d=${recent.length}; blocked=${blocked.length}; executed=${executed.length}; hard=${counts.hard_guardrail || 0}; structural=${counts.structural_replan || 0}; data=${counts.refresh_data || 0}; delivery=${counts.delivery_replan || 0}; queue=${counts.queue_reconcile || 0}; risky_growth=${riskyExecuted.length}`;
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'weekly_motor_governance_consolidation',
      trigger_type: body.trigger_type || 'weekly_scheduler',
      status: Object.values(actions).some((value: any) => value?.ok === false) ? 'warning' : 'success',
      started_at: new Date(startedAt).toISOString(), completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt, records_processed: recent.length,
      result_summary: resultSummary,
    }).catch(() => {});

    return Response.json({
      ok: true,
      amazon_account_id: accountId,
      weekly_rule_review: weeklyRuleReview,
      decisions_7d: { total: recent.length, blocked: blocked.length, executed: executed.length, risky_growth: riskyExecuted.length },
      blocker_counts: counts,
      ai_assessment: aiAssessment,
      requested_actions: [...requestedActions],
      actions,
      policy: {
        single_motor_owner: 'runUnifiedDecisionEngine',
        hard_financial_guardrails_never_weakened_automatically: true,
        new_rules_only_via_shadow_backtest: 'runWeeklyClaudeRuleReview',
        blocked_recoverable_actions_replanned: true,
      },
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});
