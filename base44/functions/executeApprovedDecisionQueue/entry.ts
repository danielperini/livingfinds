import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import {
  priorityRank,
  shouldSupersedeDecision,
  type PriorityClass,
} from '../../shared/decisionExecutionPolicy.ts';
import { validateAmazonAction } from '../../shared/amazonActionRegistry.ts';
import { evaluateDecisionGovernance } from '../../shared/canonicalDecisionPolicy.ts';

const MAX_BATCH = 60;
const API_DELAY_MS = 400;
const EXECUTION_DEADLINE_MS = 180_000;

async function assertSingleKeywordPerCampaign(
  base44: any,
  accountId: string,
  campaignId: string,
  newKeywordText: string,
): Promise<void> {
  if (!campaignId) return;
  const existing = await base44.asServiceRole.entities.Keyword.filter(
    { amazon_account_id: accountId, campaign_id: campaignId },
    null, 10
  ).catch(() => []);
  const activeExact = existing.filter((k: any) => {
    const st = String(k.state || k.status || '').toLowerCase();
    if (st === 'archived') return false;
    return String(k.match_type || '').toLowerCase() === 'exact';
  });
  if (activeExact.length > 0) {
    const existingText = activeExact[0]?.keyword_text || activeExact[0]?.keyword || 'desconhecida';
    throw new Error(
      `CANONICAL_MANUAL_CAMPAIGN_VIOLATION: campanha ${campaignId} já tem keyword ativa "${existingText}". ` +
      `Tentativa de adicionar "${newKeywordText}" bloqueada. Use createManualCampaignV2 para criar uma nova campanha.`
    );
  }
}

function isEntityNotFound(payload: any): boolean {
  const s = JSON.stringify(payload || '').toLowerCase();
  return s.includes('entitynotfounderror') || s.includes('entity_not_found') ||
    s.includes('invalid keywordid') || s.includes('keywordid does not exist') ||
    s.includes('"code":"404"') || s.includes('"httpstatuscode":404') ||
    s.includes('not found') && s.includes('keyword');
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function parseJson(value: any) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch { return {}; }
}
function present(...values: any[]) {
  return values.find((value) => value !== undefined && value !== null);
}

const RECOVERABLE_GOVERNANCE_BLOCKERS = new Set([
  'STALE_DATA','ADS_DATA_STALE','SP_API_DATA_STALE','ECONOMICS_DATA_STALE','ECONOMICS_INCOMPLETE',
  'STRUCTURE_INCOMPLETE','COOLDOWN_ACTIVE','COMPETITION_STALE','PREDICTION_CONFIDENCE',
  'ECONOMIC_CONFIDENCE','SNAPSHOT_REQUIRED','SNAPSHOT_MISSING','LOW_ECONOMIC_CONFIDENCE'
]);
const HARD_GOVERNANCE_BLOCKERS = new Set([
  'ACCOUNT_KILL_SWITCH','ACCOUNT_DAILY_CAP','OUT_OF_STOCK','NOT_BUYABLE','PRODUCT_NOT_ELIGIBLE',
  'LISTING_INACTIVE','OFFER_INACTIVE','SAFE_CPC_CEILING','SAFE_CPC_EXCEEDED','ECONOMIC_CEILING',
  'MARGIN_FLOOR','PARENT_ASIN'
]);
function governanceRetryMinutes(codes: string[], attempt: number): number {
  if (codes.includes('COOLDOWN_ACTIVE')) return 180;
  if (codes.some((c) => c.includes('STRUCTURE'))) return 10;
  if (codes.some((c) => c.includes('ECONOM'))) return 15;
  if (codes.some((c) => c.includes('STALE'))) return 10;
  return Math.min(60, 5 * Math.max(1, 2 ** Math.min(attempt, 3)));
}

function prioritize(decisions: any[]): any[] {
  const order: Record<string, number> = {
    pause_campaign: 0, pause_keyword: 1,
    set_bid: 2, reduce_bid: 2, increase_bid: 3, update_bid: 3,
    budget_change: 4, update_budget: 4, reduce_budget: 4, increase_budget: 4,
  };
  return [...decisions].sort((a, b) => {
    const priorityDelta = priorityRank((a.priority_class || 'P2') as PriorityClass)
      - priorityRank((b.priority_class || 'P2') as PriorityClass);
    if (priorityDelta !== 0) return priorityDelta;
    if (a.execution_mode === 'EXECUTE_NOW' && b.execution_mode !== 'EXECUTE_NOW') return -1;
    if (b.execution_mode === 'EXECUTE_NOW' && a.execution_mode !== 'EXECUTE_NOW') return 1;
    const pa = order[a.action] ?? 9;
    const pb = order[b.action] ?? 9;
    if (pa !== pb) return pa - pb;
    if (a.action === b.action && a.action === 'set_bid') {
      const aReduce = (a.value_after || 0) < (a.value_before || 0) ? 0 : 1;
      const bReduce = (b.value_after || 0) < (b.value_before || 0) ? 0 : 1;
      return aReduce - bReduce;
    }
    return 0;
  });
}

Deno.serve(async (request) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    const body = await request.json().catch(() => ({}));
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1);
      account = accs[0] || null;
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, undefined, 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: true, skipped: true, reason: 'Nenhuma conta conectada' });

    const aid = account.id;
    const [approvedRows, retryRows, skippedRows] = await Promise.all([
      base44.asServiceRole.entities.OptimizationDecision.filter(
        { amazon_account_id: aid, status: 'approved' }, 'created_at', MAX_BATCH + 50
      ),
      base44.asServiceRole.entities.OptimizationDecision.filter(
        { amazon_account_id: aid, status: 'waiting_retry' }, 'next_retry_at', MAX_BATCH + 50
      ).catch(() => []),

      /*
       * SELF-HEAL:
       * decisões de bid válidas criadas por versões anteriores podiam
       * receber EXECUTE_NOW, modo que o AmazonActionRegistry não permite
       * para bid. O executor recupera somente esse erro conhecido.
       */
      base44.asServiceRole.entities.OptimizationDecision.filter(
        { amazon_account_id: aid, status: 'skipped' },
        '-updated_at',
        200
      ).catch(() => []),
    ]);

    const dueRetries = retryRows.filter((decision: any) =>
      !decision.next_retry_at ||
      new Date(decision.next_retry_at).getTime() <= Date.now()
    );

    const legacyBidActions = new Set([
      'set_bid',
      'reduce_bid',
      'increase_bid',
      'update_bid',
    ]);

    const recoverableLegacy = skippedRows.filter((decision: any) => {
      const action = String(decision.action || '');
      const error = String(decision.error_message || '');

      return (
        legacyBidActions.has(action) &&
        (
          error.includes('EXECUTION_MODE_NOT_ALLOWED') ||
          String(decision.execution_mode || '') === 'EXECUTE_NOW'
        )
      );
    });

    const repairedLegacy: any[] = [];

    for (const decision of recoverableLegacy.slice(0, MAX_BATCH + 50)) {
      const repaired = await base44.asServiceRole.entities.OptimizationDecision.update(
        decision.id,
        {
          status: 'approved',
          queue_status: 'pending',

          execution_mode: 'EXPEDITED_QUEUE',
          priority_class: decision.priority_class || 'P1',

          requires_approval: false,
          approval_status: 'auto_approved_deterministic',

          error_message: null,

          attempt_count: 0,
          next_retry_at: null,

          confirmation_required: true,
          confirmation_status: 'pending',

          execute_before:
            !decision.execute_before ||
            new Date(String(decision.execute_before)).getTime() <= Date.now()
              ? new Date(Date.now() + 60 * 60 * 1000).toISOString()
              : decision.execute_before,

          updated_at: new Date().toISOString(),
        }
      ).catch(() => null);

      if (repaired) {
        repaired.execution_mode = 'EXPEDITED_QUEUE';
        repaired.status = 'approved';
        repaired.queue_status = 'pending';
        repaired.error_message = null;

        repairedLegacy.push(repaired);
      }
    }

    const approved = [
      ...approvedRows,
      ...dueRetries,
      ...repairedLegacy,
    ];
    if (approved.length === 0) {
      return Response.json({ ok: true, executed: 0, duration_ms: Date.now() - t0 });
    }

    const decisionKeywordIds = [...new Set(approved.map((decision: any) => String(decision.keyword_id || '')).filter(Boolean))];
    const validKwIds = new Set<string>();
    for (let offset = 0; offset < decisionKeywordIds.length; offset += 100) {
      const ids = decisionKeywordIds.slice(offset, offset + 100);
      const [byAmazonId, byLocalId] = await Promise.all([
        base44.asServiceRole.entities.Keyword.filter(
          { amazon_account_id: aid, keyword_id: { $in: ids } }, '-updated_date', Math.max(500, ids.length * 10),
        ).catch(() => []),
        base44.asServiceRole.entities.Keyword.filter(
          { amazon_account_id: aid, id: { $in: ids } }, '-updated_date', Math.max(500, ids.length * 10),
        ).catch(() => []),
      ]);
      for (const keyword of [...byAmazonId, ...byLocalId]) {
        if (keyword.keyword_id) validKwIds.add(String(keyword.keyword_id));
        if (keyword.id) validKwIds.add(String(keyword.id));
      }
    }

    let preAutoCancel = 0;
    const deferredDecisionIds = new Set<string>();
    const dominantByConflict = new Map<string, any>();
    for (const decision of prioritize(approved)) {
      const nowMs = Date.now();
      if (decision.execution_mode === 'MANUAL_REVIEW') {
        await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
          status: 'pending_approval', requires_approval: true, approval_status: 'manual_review_required',
        }).catch(() => {});
        preAutoCancel++;
        continue;
      }
      if (decision.not_before && new Date(decision.not_before).getTime() > nowMs) {
        deferredDecisionIds.add(String(decision.id));
        continue;
      }
      const expiration = decision.execute_before || decision.expires_at;
      if (expiration && new Date(expiration).getTime() < nowMs) {
        await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
          status: 'superseded',
          approval_status: 'superseded_redecision_required',
          error_message: 'SUPERSEDED_REDECISION: janela operacional expirou; V3 deve recalcular a ação com dados atuais.',
        }).catch(() => {});
        preAutoCancel++;
        continue;
      }
      if (decision.requires_fresh_data === true && decision.data_window_end) {
        const reference = decision.execution_mode === 'EXECUTE_NOW'
          ? decision.created_at
          : `${String(decision.data_window_end).slice(0, 10)}T23:59:59Z`;
        const maximumAge = Number(decision.maximum_data_age_minutes || 36 * 60);
        const ageMinutes = reference ? (nowMs - new Date(reference).getTime()) / 60000 : 0;
        if (ageMinutes > maximumAge) {
          await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
            status: 'waiting_retry',
            approval_status: 'refresh_required',
            next_retry_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
            error_message: `RECOVERABLE_STALE_DATA: evidência com ${Math.round(ageMinutes)} min excede ${maximumAge} min; atualizar métricas e reavaliar.`,
          }).catch(() => {});
          preAutoCancel++;
          continue;
        }
      }
      const conflictGroup = String(decision.conflict_group || '');
      if (!conflictGroup) continue;
      const dominant = dominantByConflict.get(conflictGroup);
      if (dominant && shouldSupersedeDecision(dominant, decision)) {
        await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
          status: 'superseded',
          approval_status: 'superseded_by_higher_priority',
          cancelled_by_decision_id: dominant.id,
          error_message: `SUPERSEDED_BY_HIGHER_PRIORITY: ${dominant.priority_class || 'P2'} venceu no grupo ${conflictGroup}; não é bloqueio operacional.`,
        }).catch(() => {});
        preAutoCancel++;
        continue;
      }
      dominantByConflict.set(conflictGroup, decision);
    }

    const pauseDecisions = approved.filter(d =>
      d.action === 'pause_campaign' || d.action === 'pause_keyword' || d.action === 'archive_campaign'
    );
    if (pauseDecisions.length > 0) {
      const cutoff14d = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
      const staleMetrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
        { amazon_account_id: aid }, '-date', 500
      ).catch(() => []);
      const metrics14d = staleMetrics.filter((m: any) => m.date >= cutoff14d);
      const campaignMetrics14d = new Map<string, { orders: number; spend: number; sales: number }>();
      for (const m of metrics14d) {
        if (!m.campaign_id) continue;
        const ex = campaignMetrics14d.get(m.campaign_id) || { orders: 0, spend: 0, sales: 0 };
        ex.orders += m.orders || 0;
        ex.spend += m.spend || 0;
        ex.sales += m.sales || 0;
        campaignMetrics14d.set(m.campaign_id, ex);
      }
      for (const d of pauseDecisions) {
        const cid = d.campaign_id;
        if (!cid) continue;
        const cm = campaignMetrics14d.get(cid);
        if (!cm) continue;
        const acos14d = cm.sales > 0 ? (cm.spend / cm.sales) * 100 : null;
        if (cm.orders > 0 && acos14d !== null && acos14d <= 15) {
          await base44.asServiceRole.entities.OptimizationDecision.update(d.id, {
            status: 'superseded',
            approval_status: 'winner_revalidation_superseded',
            error_message: `SUPERSEDED_WINNER_REVALIDATION: campanha tem ${cm.orders}p em 14d e ACoS ${acos14d.toFixed(1)}% ≤ 15%; pausa obsoleta removida e V3 recalcula crescimento/HOLD.`,
          }).catch(() => {});
          preAutoCancel++;
        }
      }
    }

    for (const d of approved) {
      if (d.keyword_id && !validKwIds.has(d.keyword_id)) {
        await base44.asServiceRole.entities.OptimizationDecision.update(d.id, {
          status: 'superseded',
          approval_status: 'entity_reconciliation_required',
          error_message: 'SUPERSEDED_ENTITY_CHANGED: keyword_id antigo não existe mais; reconciliar Amazon e recalcular no V3.',
        }).catch(() => {});
        preAutoCancel++;
      }
    }

    const stillApproved = preAutoCancel > 0
      ? [
          ...await base44.asServiceRole.entities.OptimizationDecision.filter(
            { amazon_account_id: aid, status: 'approved' }, 'created_at', MAX_BATCH + 50
          ).catch(() => []),
          ...dueRetries.filter((decision: any) => !['cancelled', 'blocked', 'superseded', 'protected', 'failed_final'].includes(String(decision.status || ''))),
        ]
      : approved;
    if (stillApproved.length === 0) {
      return Response.json({ ok: true, executed: 0, pre_cancelled: preAutoCancel, duration_ms: Date.now() - t0 });
    }

    const toProcess = prioritize(stillApproved)
      .filter(decision => !deferredDecisionIds.has(String(decision.id)))
      .slice(0, MAX_BATCH);
    const results: any[] = [];
    let executed = 0, failed = 0, skipped = 0;

    for (const decision of toProcess) {
      if (Date.now() - t0 > EXECUTION_DEADLINE_MS) break;
      let lockOwnerId: string | null = null;
      try {
        if (Number(decision.attempt_count || 0) >= Number(decision.max_attempts || 3)) {
          await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
            status: 'failed_final', queue_status: 'failed', error_message: 'MAX_ATTEMPTS_EXHAUSTED',
          }).catch(() => {});
          results.push({ id: decision.id, action: decision.action, ok: false, skipped: true, reason: 'MAX_ATTEMPTS_EXHAUSTED' });
          skipped++;
          continue;
        }
        /*
         * Compatibilidade definitiva:
         * bid/budget reversível nunca deve chegar ao registry como
         * EXECUTE_NOW. Corrige in-memory e persiste antes da validação.
         */
        const queuedBidActions = new Set([
          'set_bid',
          'reduce_bid',
          'increase_bid',
          'update_bid',
        ]);

        if (
          queuedBidActions.has(String(decision.action || '')) &&
          String(decision.execution_mode || '') === 'EXECUTE_NOW'
        ) {
          decision.execution_mode = 'EXPEDITED_QUEUE';

          await base44.asServiceRole.entities.OptimizationDecision.update(
            decision.id,
            {
              execution_mode: 'EXPEDITED_QUEUE',
              status: 'approved',
              queue_status: 'pending',
              error_message: null,
              updated_at: new Date().toISOString(),
            }
          ).catch(() => {});
        }

        const capability = validateAmazonAction({
          action: decision.action,
          execution_mode: decision.execution_mode
        });

        if (!capability.valid) {
          await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
            status: 'skipped', error_message: capability.reason,
          }).catch(() => {});
          results.push({ id: decision.id, action: decision.action, ok: false, skipped: true, reason: capability.reason });
          skipped++;
          continue;
        }

        const isCanonical = Boolean(decision.snapshot_id || decision.canonical_action_type || decision.source_function === 'runEconomicBudgetBalancer');
        let snapshot: any = null;
        if (isCanonical && decision.snapshot_id) {
          const rows = await base44.asServiceRole.entities.RepricingSnapshot.filter({ id: decision.snapshot_id }, undefined, 1).catch(() => []);
          snapshot = rows[0] || null;
        }
        if (isCanonical) {
          const evidence = parseJson(decision.data_used);
          const admission = evidence?.admission || {};

          const isV3Decision =
            String(decision.policy_version || '').toUpperCase() ===
              'PROFIT_ENGINE_V3' ||
            String(decision.decision_owner || '').toUpperCase() ===
              'CANONICAL_PROFIT_ENGINE_V3' ||
            String(decision.canonical_engine || '').toUpperCase() ===
              'CANONICAL_PROFIT_ENGINE_V3';

          const trustedSource =
            isV3Decision ||
            [
              'runEconomicBudgetBalancer',
              'runIntradaySalesRecovery'
            ].includes(
              String(decision.source_function || '')
            );

          const observedAt =
            admission.observed_at ||
            evidence?.metrics_observed_at ||
            decision.metrics_observed_at ||
            decision.data_window_end;

          const observedMs =
            observedAt
              ? new Date(String(observedAt)).getTime()
              : NaN;

          const trustedIntradayEvidence =
            trustedSource &&
            (
              admission.verified === true ||
              isV3Decision
            ) &&
            Number.isFinite(observedMs) &&
            Date.now() - observedMs <=
              Number(
                decision.maximum_data_age_minutes ||
                (isV3Decision ? 180 : 45)
              ) * 60000;
          const priorEntityDecisions = await base44.asServiceRole.entities.OptimizationDecision.filter({
            amazon_account_id: aid, entity_id: decision.entity_id,
          }, '-executed_at', 10).catch(() => []);

          const awaitingAmazonConfirmation = priorEntityDecisions.some((prior: any) => {
            if (String(prior.id || '') === String(decision.id || '')) return false;
            const pendingConfirmation = ['pending', 'propagating'].includes(String(prior.confirmation_status || '').toLowerCase()) ||
              ['confirming', 'awaiting_confirmation'].includes(String(prior.status || '').toLowerCase());
            if (!pendingConfirmation) return false;
            const ts = new Date(String(prior.executed_at || prior.last_attempt_at || prior.updated_at || prior.created_at || 0)).getTime();
            return Number.isFinite(ts) && ts >= Date.now() - 2 * 3600000;
          });
          if (awaitingAmazonConfirmation) {
            await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
              status: 'waiting_retry', queue_status: 'scheduled', next_retry_at: new Date(Date.now() + 10 * 60000).toISOString(),
              error_message: 'AWAITING_AMAZON_CONFIRMATION: existe escrita recente da mesma entidade aguardando propagacao.',
            }).catch(() => {});
            results.push({ id: decision.id, action: decision.action, ok: false, scheduled: true, reason: 'AWAITING_AMAZON_CONFIRMATION' });
            skipped++;
            continue;
          }

          const protectiveBidReduction = String(decision.action || '').toLowerCase().includes('reduce') &&
            /(confirmed_economic_loss|early_economic_loss_guard|clicks_no_same_sku_sale|safe_cpc|margin|loss|acos_above)/i
              .test(String(decision.reason_code || decision.rule_key || decision.rationale || ''));
          const cooldownHours = protectiveBidReduction ? 2 : 6;
          const executorCooldownActive = priorEntityDecisions.some((prior: any) => {
            if (String(prior.id || '') === String(decision.id || '')) return false;
            const isBid = /bid/i.test(String(prior.canonical_action_type || prior.action || prior.decision_type || ''));
            const changedAt = new Date(String(prior.executed_at || prior.approved_at || prior.created_at || 0)).getTime();
            const applied = String(prior.status || '') === 'executed' || String(prior.confirmation_status || '') === 'confirmed';
            return isBid && applied && Number.isFinite(changedAt) && changedAt >= Date.now() - cooldownHours * 3600000;
          });
          const confidenceRaw =
            Number(decision.confidence || 0);

          const currentValue =
            decision.value_before ??
            decision.current_value;

          const proposedValue =
            decision.value_after ??
            decision.proposed_value;

          const actionName =
            String(decision.action || '')
              .toLowerCase();

          /*
           * Toda alteração reversível recebe rollback
           * derivado do estado anterior.
           */
          const derivedRollbackPlan =
            decision.rollback_plan ||
            (
              currentValue !== undefined &&
              currentValue !== null &&
              /bid|budget/.test(actionName)
                ? `RESTORE_PREVIOUS_VALUE:${String(currentValue)}`
                : null
            ) ||
            (
              actionName.includes('pause_campaign')
                ? 'RESTORE_CAMPAIGN_STATE:enabled'
                : null
            ) ||
            (
              actionName.includes('pause_keyword')
                ? 'RESTORE_KEYWORD_STATE:enabled'
                : null
            ) ||
            (
              actionName.includes('pause_target')
                ? 'RESTORE_TARGET_STATE:enabled'
                : null
            );

          const governance = evaluateDecisionGovernance({
            actionType: decision.action,
            entityType: decision.entity_type,
            currentValue,
            proposedValue,
            snapshotId: decision.snapshot_id,
            verifiedEvidenceId:
              trustedIntradayEvidence
                ? String(
                    decision.verified_evidence_id ||
                    decision.idempotency_key ||
                    decision.id
                  )
                : null,
            reasonCode: decision.reason_code || decision.rule_key,
            reason: decision.rationale,
            confidence: confidenceRaw > 1 ? confidenceRaw / 100 : confidenceRaw,
            predictionConfidence: present(snapshot?.prediction_confidence, admission.prediction_confidence),
            economicConfidence: present(snapshot?.economic_confidence, admission.economic_confidence),
            dataFresh: snapshot?.data_fresh === true || (trustedIntradayEvidence),
            adsDataFresh: snapshot?.ads_data_fresh_at != null || (trustedIntradayEvidence),
            spApiDataFresh: snapshot?.sp_api_data_fresh_at != null || (trustedIntradayEvidence && admission.sp_api_data_fresh === true),
            economicsDataFresh: snapshot?.economics_data_fresh_at != null || (trustedIntradayEvidence && admission.economics_data_fresh === true),
            productEligible: !['NOT_ELIGIBLE', 'OUT_OF_STOCK', 'NOT_BUYABLE', 'PRODUCT_INACTIVE'].includes(String(present(snapshot?.product_state, admission.product_state) || '')),
            listingActive: !['inactive', 'not_found', 'error'].includes(String(present(snapshot?.listing_status, admission.listing_status) || '').toLowerCase()),
            offerActive: !['inactive', 'closed', 'not_found'].includes(String(present(snapshot?.offer_status, admission.offer_status) || '').toLowerCase()),
            buyable: snapshot?.buyable === true || (trustedIntradayEvidence && admission.buyable === true),
            inStock: Number(present(snapshot?.inventory_available, admission.inventory_available, decision.stock_qty) || 0) > 0,
            stockCoverageDays: present(snapshot?.stock_coverage_days, admission.stock_coverage_days, decision.stock_coverage_days),
            economicsComplete: snapshot?.economic_state !== 'ECONOMICS_PENDING' && (snapshot || trustedIntradayEvidence ? admission.economics_complete !== false : false),
            profitAfterAds: present(snapshot?.profit_after_ads, admission.profit_after_ads, decision.profit_after_ads_total),
            marginRate: present(snapshot?.margin_rate, admission.margin_rate),
            currentAcos: present(snapshot?.current_acos, admission.current_acos, decision.current_acos),
            targetAcos: present(snapshot?.target_acos, admission.target_acos, decision.target_acos),
            safeMaxCpc: present(snapshot?.safe_max_cpc, admission.safe_max_cpc, decision.maximum_economic_cpc),
            economicFloor: present(snapshot?.economic_floor, admission.economic_floor),
            competitionFresh: snapshot?.data_fresh === true || (trustedIntradayEvidence),
            winnerProtected: snapshot?.winner_protected === true || admission.winner_protected === true,
            sameSkuOrders: present(snapshot?.same_sku_orders, admission.same_sku_orders),
            haloOrders: present(snapshot?.halo_orders, admission.halo_orders),
            cooldownActive: executorCooldownActive,
            accountDailyCap: decision.account_daily_budget_limit,
            accountSpend: decision.account_daily_spend,
            proposedSpendImpact: decision.expected_impact_value,
            defensive: snapshot?.risk_state === 'LOSS_CONFIRMED',
            parentAsin: snapshot?.parent_asin === true,
            rollbackPlan: derivedRollbackPlan,
            minEconomicConfidence: protectiveBidReduction ? 0.60 : 0.90,
          });
          if (!governance.allowed) {
            const codes = governance.blockers.map((blocker) => String(blocker.code || '').toUpperCase());
            const __originalHasHardBlocker = codes.some((code) => HARD_GOVERNANCE_BLOCKERS.has(code));

        /*
         * V3_CONTROLLED_IMPRESSION_RECOVERY_EXECUTION
         *
         * Recovery de exposição não é scale agressivo.
         *
         * A decisão pode passar mesmo com blockers
         * recuperáveis, desde que:
         *
         * - seja set_bid;
         * - seja especificamente impression recovery;
         * - não exista nenhum HARD blocker;
         * - aumento permaneça pequeno;
         * - safe CPC / economic ceiling continuem válidos.
         */

        const __isControlledImpressionRecovery =
          (
            String(decision.action || '') === 'set_bid'
            &&
            (
              String(decision.decision_type || '') ===
                'increase_bid_impression_recovery'
              ||
              String(decision.rule_key || '') ===
                'V3_MANUAL_EXACT_IMPRESSION_RECOVERY'
              ||
              String(decision.source_function || '') ===
                'runV3ManualExactImpressionRecovery'
            )
          );

        const __governanceCodes =
          Array.isArray(governance?.blockers)
            ? governance.blockers.map(
                (item:any) =>
                  String(
                    item?.code ||
                    item?.reason_code ||
                    item?.reason ||
                    item ||
                    ''
                  )
              )
            : [];

        /*
         * V3_CURRENT_LIVE_PRODUCT_ELIGIBILITY
         *
         * PRODUCT_NOT_ELIGIBLE pode ter sido produzido
         * por snapshot antigo/incompleto.
         *
         * Somente para controlled impression recovery:
         * revalidar produto ao vivo antes de classificá-lo
         * como hard blocker.
         */
        let __effectiveGovernanceCodes =
          [...__governanceCodes];

        let __liveProductEligibility:any = null;

        if (
          __isControlledImpressionRecovery
          &&
          __effectiveGovernanceCodes.includes(
            'PRODUCT_NOT_ELIGIBLE'
          )
          &&
          decision.asin
        ) {

          const __products =
            await base44.asServiceRole.entities.Product.filter(
              {
                amazon_account_id: aid,
                asin:
                  String(
                    decision.asin ||
                    ''
                  ).toUpperCase(),
              },
              '-updated_date',
              20
            ).catch(() => []);

          const __product =
            __products.find((row:any) =>
              String(row.asin || '').toUpperCase()
              ===
              String(decision.asin || '').toUpperCase()
            )
            ||
            __products[0]
            ||
            null;

          if (__product) {

            const __stockCandidates = [
              __product.fulfillable_quantity,
              __product.stock_available,
              __product.inventory_available,
              __product.available_quantity,
              __product.fba_available_quantity,
              __product.quantity,
              __product.stock,
            ];

            let __knownStock:number|null =
              null;

            for (
              const __value
              of __stockCandidates
            ) {

              if (
                __value === undefined
                ||
                __value === null
                ||
                __value === ''
              )
                continue;

              const __parsed =
                Number(__value);

              if (
                Number.isFinite(
                  __parsed
                )
              ) {
                __knownStock =
                  __parsed;

                break;
              }
            }

            const __listingState =
              String(
                __product.listing_status ||
                __product.amazon_listing_status ||
                __product.status ||
                ''
              ).toUpperCase();

            const __offerState =
              String(
                __product.offer_status ||
                __product.buyability_status ||
                ''
              ).toUpperCase();

            const __explicitOutOfStock =
              (
                __knownStock !== null
                &&
                __knownStock <= 0
              );

            const __explicitNotBuyable =
              (
                __product.buyable === false
                ||
                __product.is_buyable === false
                ||
                __product.offer_active === false
                ||
                [
                  'NOT_BUYABLE',
                  'SUPPRESSED',
                  'BLOCKED',
                  'CLOSED',
                  'ARCHIVED'
                ].includes(
                  __listingState
                )
                ||
                [
                  'NOT_BUYABLE',
                  'SUPPRESSED',
                  'BLOCKED'
                ].includes(
                  __offerState
                )
              );

            /*
             * Regra importante:
             *
             * status genérico INACTIVE não é suficiente
             * sozinho para declarar listing inelegível,
             * pois o campo Product.status pode representar
             * lifecycle interno e não a buyability Amazon.
             */

            const __positiveStockEvidence =
              (
                __knownStock !== null
                &&
                __knownStock > 0
              );

            const __liveEligible =
              (
                __positiveStockEvidence
                &&
                !__explicitOutOfStock
                &&
                !__explicitNotBuyable
              );

            __liveProductEligibility = {
              asin:
                String(
                  decision.asin ||
                  ''
                ),

              stock:
                __knownStock,

              listing_state:
                __listingState ||
                null,

              offer_state:
                __offerState ||
                null,

              explicitly_out_of_stock:
                __explicitOutOfStock,

              explicitly_not_buyable:
                __explicitNotBuyable,

              positive_stock_evidence:
                __positiveStockEvidence,

              live_eligible:
                __liveEligible,
            };

            if (__liveEligible) {

              __effectiveGovernanceCodes =
                __effectiveGovernanceCodes.filter(
                  (code:string) =>
                    code !==
                    'PRODUCT_NOT_ELIGIBLE'
                );

              decision.metadata = {
                ...(decision.metadata || {}),

                live_product_eligibility_revalidated:
                  true,

                live_product_eligibility:
                  __liveProductEligibility,

                relaxed_obsolete_product_eligibility:
                  true,
              };
            }
          }
        }

        /*
         * HARD blockers são calculados APÓS
         * a revalidação ao vivo.
         */
        const __hardRecoveryBlockers =
          __effectiveGovernanceCodes.filter(
            (code:string) =>
              HARD_GOVERNANCE_BLOCKERS.has(code)
          );

        const __recoverableRecoveryBlockers =
          __effectiveGovernanceCodes.filter(
            (code:string) =>
              RECOVERABLE_GOVERNANCE_BLOCKERS.has(code)
          );

        const __oldBid =
          Number(
            decision.value_before ??
            decision.old_bid ??
            0
          );

        const __newBid =
          Number(
            decision.value_after ??
            decision.new_bid ??
            0
          );

        const __increasePct =
          (
            __oldBid > 0
            &&
            __newBid > __oldBid
          )
            ? (
                (__newBid / __oldBid - 1)
                * 100
              )
            : 0;

        const __phase =
          String(
            decision.metadata?.phase ||
            ''
          ).toUpperCase();

        const __maxRecoveryIncreasePct =
          (
            __phase === 'NEW'
            ||
            __phase === 'YOUNG'
          )
            ? 15
            : 10;

        const __smallRecoveryAdjustment =
          (
            __increasePct > 0
            &&
            __increasePct <=
              __maxRecoveryIncreasePct + 0.01
          );

        const __controlledRecoveryAllowed =
          (
            __isControlledImpressionRecovery
            &&
            __smallRecoveryAdjustment
            &&
            __hardRecoveryBlockers.length === 0
          );

        const hasHardBlocker =
          __controlledRecoveryAllowed
            ? false
            : __originalHasHardBlocker;

        if(__controlledRecoveryAllowed) {

          decision.metadata = {
            ...(decision.metadata || {}),

            controlled_impression_recovery:
              true,

            original_governance_hard_block:
              __originalHasHardBlocker,

            relaxed_recoverable_blockers:
              __recoverableRecoveryBlockers,

            retained_hard_blockers:
              __hardRecoveryBlockers,

            recovery_increase_pct:
              __increasePct,

            recovery_max_increase_pct:
              __maxRecoveryIncreasePct,
          };
        }


            const recoverable = !hasHardBlocker && codes.some((code) =>
              RECOVERABLE_GOVERNANCE_BLOCKERS.has(code) || code.includes('STALE') || code.includes('INCOMPLETE') || code.includes('COOLDOWN')
            );
            if (recoverable) {
              const retryMinutes = governanceRetryMinutes(codes, Number(decision.attempt_count || 0));
              await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
                status: 'waiting_retry', queue_status: 'scheduled',
                next_retry_at: new Date(Date.now() + retryMinutes * 60000).toISOString(),
                error_message: `FAST_TRACK_WAITING_REFRESH: ${codes.join(',')} | retry=${retryMinutes}m`.slice(0, 500),
              }).catch(() => {});
              results.push({ id: decision.id, action: decision.action, ok: false, scheduled: true, fast_track: true, reason: 'WAITING_REFRESH', retry_minutes: retryMinutes, governance });
              skipped++;
              continue;
            }
            await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
              status: 'blocked', queue_status: 'completed', error_message: `GOVERNANCE_HARD_BLOCK: ${codes.join(',')}`.slice(0, 500),
            }).catch(() => {});
            results.push({ id: decision.id, action: decision.action, ok: false, skipped: true, hard_block: true, governance });
            skipped++;
            continue;
          }
        }

        if (
          (decision.action === 'create_keyword' || decision.decision_type === 'create_keyword' || decision.decision_type === 'harvest_search_term') &&
          decision.campaign_id
        ) {
          await assertSingleKeywordPerCampaign(base44, aid, decision.campaign_id, decision.keyword_text || decision.action || '');
        }

        if (isCanonical && decision.lock_key) {
          lockOwnerId = crypto.randomUUID();
          const lockResponse = await base44.asServiceRole.functions.invoke('acquireAmazonSchedulerLock', {
            amazon_account_id: aid, lock_key: decision.lock_key, owner_id: lockOwnerId, ttl_ms: 300000, _service_role: true,
          }).catch((error: any) => ({ data: { ok: false, acquired: false, error: error?.message || String(error) } }));
          const lock = lockResponse?.data || lockResponse || {};
          if (lock.acquired !== true) {
            await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
              status: 'waiting_retry', queue_status: 'scheduled', next_retry_at: new Date(Date.now() + 5 * 60000).toISOString(),
              error_message: 'ENTITY_LOCK_BUSY: outra avaliação ou execução detém o lock canônico.',
            }).catch(() => {});
            results.push({ id: decision.id, action: decision.action, ok: false, scheduled: true, reason: 'ENTITY_LOCK_BUSY' });
            skipped++;
            lockOwnerId = null;
            continue;
          }
        }

        if (decision.status === 'waiting_retry') {
          await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
            status: 'approved', queue_status: 'pending', next_retry_at: null,
          }).catch(() => {});
        }

        const res = await base44.asServiceRole.functions.invoke('executeAutopilotDecision', {
          decision_ids: [decision.id], _service_role: true, _window_execution: true,
        });
        const data = res?.data || res || {};
        const ok = data?.executed > 0 || data?.ok === true;

        if (!ok && isEntityNotFound(data)) {
          await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
            status: 'cancelled', error_message: 'CANCELADO: entidade não encontrada na Amazon (ENTITY_NOT_FOUND) — decisão obsoleta',
          }).catch(() => {});
          results.push({ id: decision.id, action: decision.action, ok: false, cancelled: true });
          skipped++;
        } else {
          if (ok && capability.definition?.confirmationRequired) {
            await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
              status: 'confirming', queue_status: 'completed', confirmation_status: 'propagating',
              confirmation_error: null, confirmed_at: null, last_attempt_at: new Date().toISOString(),
            }).catch(() => {});
          }
          results.push({ id: decision.id, action: decision.action, ok });
          if (ok) executed++; else if (data?.scheduled) skipped++; else failed++;
        }
      } catch (e: any) {
        results.push({ id: decision.id, action: decision.action, ok: false, error: e.message });
        failed++;
      } finally {
        if (lockOwnerId && decision.lock_key) {
          await base44.asServiceRole.functions.invoke('acquireAmazonSchedulerLock', {
            amazon_account_id: aid, lock_key: decision.lock_key, owner_id: lockOwnerId, action: 'release', _service_role: true,
          }).catch(() => {});
        }
      }
      if (toProcess.indexOf(decision) < toProcess.length - 1) await sleep(API_DELAY_MS);
    }

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'ads_decision_execution',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: failed === 0 ? 'success' : executed > 0 ? 'warning' : 'error',
      execution_date: new Date().toISOString().slice(0, 10),
      started_at: new Date(t0).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      records_processed: executed,
      error_message: failed > 0 ? `${failed} decisões falharam` : null,
      result_summary: `${executed} executadas, ${failed} com erro, ${skipped} agendadas, ${preAutoCancel} pré-canceladas`,
    }).catch(() => {});

    return Response.json({
      ok: true,
      pre_cancelled: preAutoCancel,
      total_approved: approved.length,
      processed: results.length,
      executed,
      failed,
      skipped,
      remaining: Math.max(0, approved.length - results.length),
      duration_ms: Date.now() - t0,
      results: results.slice(0, 30),
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message }, { status: 500 });
  }
});
