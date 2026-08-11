import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';
import {
  priorityRank,
  shouldSupersedeDecision,
  type PriorityClass,
} from '../../shared/decisionExecutionPolicy.ts';
import { validateAmazonAction } from '../../shared/amazonActionRegistry.ts';
import { evaluateDecisionGovernance } from '../../shared/canonicalDecisionPolicy.ts';

const MAX_BATCH = 30;
const API_DELAY_MS = 400;

/**
 * HARD GUARD — assertSingleKeywordPerCampaign
 *
 * Verifica no banco local se a campanha já tem keyword ativa (EXACT).
 * Se sim, lança erro CANONICAL_MANUAL_CAMPAIGN_VIOLATION antes de qualquer chamada Amazon.
 * Garante a regra: 1 campanha manual = 1 keyword EXACT.
 */
async function assertSingleKeywordPerCampaign(
  base44: any,
  accountId: string,
  campaignId: string,
  newKeywordText: string,
): Promise<void> {
  if (!campaignId) return; // sem campaignId = nova campanha, sem conflito possível

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
    const [approvedRows, retryRows] = await Promise.all([
      base44.asServiceRole.entities.OptimizationDecision.filter(
        { amazon_account_id: aid, status: 'approved' }, 'created_at', MAX_BATCH + 50
      ),
      base44.asServiceRole.entities.OptimizationDecision.filter(
        { amazon_account_id: aid, status: 'waiting_retry' }, 'next_retry_at', MAX_BATCH + 50
      ).catch(() => []),
    ]);
    const dueRetries = retryRows.filter((decision: any) =>
      !decision.next_retry_at || new Date(decision.next_retry_at).getTime() <= Date.now()
    );
    const approved = [...approvedRows, ...dueRetries];

    if (approved.length === 0) {
      const parity = await base44.asServiceRole.functions.invoke('reconcileManualBidParity', {
        amazon_account_id: aid,
        _service_role: true,
      }).catch(() => null);
      return Response.json({ ok: true, executed: 0, bid_parity: parity?.data || parity || null, duration_ms: Date.now() - t0 });
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

    // ── Revalidação de decisões obsoletas (STALE_DECISION_REVALIDATION) ──────
    // Antes de executar: verificar se decisões de pausa ainda são válidas.
    // Se campanha tem vendas recentes (orders_14d>0) E ACoS<=15% → cancelar decisão.
    let preAutoCancel = 0;
    const deferredDecisionIds = new Set<string>();
    const dominantByConflict = new Map<string, any>();
    for (const decision of prioritize(approved)) {
      const nowMs = Date.now();
      if (decision.execution_mode === 'MANUAL_REVIEW') {
        await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
          status: 'pending_approval',
          requires_approval: true,
          approval_status: 'manual_review_required',
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
          status: 'expired',
          error_message: 'DECISION_WINDOW_EXPIRED: a janela operacional terminou antes da execução.',
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
            status: 'expired',
            error_message: `STALE_DATA_EXPIRED: evidência com ${Math.round(ageMinutes)} min excede ${maximumAge} min.`,
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
          status: 'cancelled',
          cancelled_by_decision_id: dominant.id,
          error_message: `SUPERSEDED_BY_HIGHER_PRIORITY: ${dominant.priority_class || 'P2'} venceu no grupo ${conflictGroup}.`,
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
      // Buscar métricas recentes para revalidação
      const cutoff14d = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
      const staleMetrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
        { amazon_account_id: aid }, '-date', 500
      ).catch(() => []);
      const metrics14d = staleMetrics.filter((m: any) => m.date >= cutoff14d);

      // Agregar orders e acos por campaign_id
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
        // Cancelar se campanha tem vendas recentes e ACoS sustentável
        if (cm.orders > 0 && acos14d !== null && acos14d <= 15) {
          await base44.asServiceRole.entities.OptimizationDecision.update(d.id, {
            status: 'cancelled',
            error_message: `STALE_DECISION_REVALIDATION: campanha tem ${cm.orders}p em 14d e ACoS ${acos14d.toFixed(1)}% ≤ 15% — decisão de pausa obsoleta cancelada.`,
          }).catch(() => {});
          preAutoCancel++;
        }
      }
    }

    // ── Cancelar decisões com keyword_id ausente no banco ────────────────────
    for (const d of approved) {
      if (d.keyword_id && !validKwIds.has(d.keyword_id)) {
        await base44.asServiceRole.entities.OptimizationDecision.update(d.id, {
          status: 'cancelled',
          error_message: 'CANCELADO: keyword_id não encontrado no banco — entidade removida da Amazon',
        }).catch(() => {});
        preAutoCancel++;
      }
    }

    const stillApproved = preAutoCancel > 0
      ? [
          ...await base44.asServiceRole.entities.OptimizationDecision.filter(
            { amazon_account_id: aid, status: 'approved' }, 'created_at', MAX_BATCH + 50
          ).catch(() => []),
          ...dueRetries.filter((decision: any) => !['cancelled', 'blocked', 'failed_final'].includes(String(decision.status || ''))),
        ]
      : approved;

    if (stillApproved.length === 0) {
      const parity = await base44.asServiceRole.functions.invoke('reconcileManualBidParity', {
        amazon_account_id: aid,
        _service_role: true,
      }).catch(() => null);
      return Response.json({ ok: true, executed: 0, pre_cancelled: preAutoCancel, bid_parity: parity?.data || parity || null, duration_ms: Date.now() - t0 });
    }

    const toProcess = prioritize(stillApproved)
      .filter(decision => !deferredDecisionIds.has(String(decision.id)))
      .slice(0, MAX_BATCH);
    const results: any[] = [];
    let executed = 0, failed = 0, skipped = 0;

    for (const decision of toProcess) {
      if (Date.now() - t0 > 90000) break;

      let lockOwnerId: string | null = null;
      try {
        if (Number(decision.attempt_count || 0) >= Number(decision.max_attempts || 3)) {
          await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
            status: 'failed_final',
            queue_status: 'failed',
            error_message: 'MAX_ATTEMPTS_EXHAUSTED',
          }).catch(() => {});
          results.push({ id: decision.id, action: decision.action, ok: false, skipped: true, reason: 'MAX_ATTEMPTS_EXHAUSTED' });
          skipped++;
          continue;
        }
        const capability = validateAmazonAction({
          action: decision.action,
          execution_mode: decision.execution_mode,
        });
        if (!capability.valid) {
          await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
            status: 'skipped',
            error_message: capability.reason,
          }).catch(() => {});
          results.push({
            id: decision.id,
            action: decision.action,
            ok: false,
            skipped: true,
            reason: capability.reason,
          });
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
          const priorEntityDecisions = await base44.asServiceRole.entities.OptimizationDecision.filter({
            amazon_account_id: aid,
            entity_id: decision.entity_id,
          }, '-executed_at', 10).catch(() => []);
          const executorCooldownActive = priorEntityDecisions.some((prior: any) => {
            if (String(prior.id || '') === String(decision.id || '')) return false;
            const isBid = /bid/i.test(String(prior.canonical_action_type || prior.action || prior.decision_type || ''));
            const changedAt = new Date(String(prior.executed_at || prior.approved_at || prior.created_at || 0)).getTime();
            return isBid && Number.isFinite(changedAt) && changedAt >= Date.now() - 48 * 3600000 &&
              !['failed', 'cancelled', 'rejected', 'skipped', 'blocked'].includes(String(prior.status || ''));
          });
          const confidenceRaw = Number(decision.confidence || 0);
          const governance = evaluateDecisionGovernance({
            actionType: decision.action,
            entityType: decision.entity_type,
            currentValue: decision.value_before ?? decision.current_value,
            proposedValue: decision.value_after ?? decision.proposed_value,
            snapshotId: decision.snapshot_id,
            reasonCode: decision.reason_code || decision.rule_key,
            reason: decision.rationale,
            confidence: confidenceRaw > 1 ? confidenceRaw / 100 : confidenceRaw,
            predictionConfidence: snapshot?.prediction_confidence,
            economicConfidence: snapshot?.economic_confidence,
            dataFresh: snapshot?.data_fresh === true,
            adsDataFresh: snapshot?.ads_data_fresh_at != null,
            spApiDataFresh: snapshot?.sp_api_data_fresh_at != null,
            economicsDataFresh: snapshot?.economics_data_fresh_at != null,
            productEligible: !['NOT_ELIGIBLE', 'OUT_OF_STOCK', 'NOT_BUYABLE', 'PRODUCT_INACTIVE'].includes(String(snapshot?.product_state || '')),
            listingActive: !['inactive', 'not_found', 'error'].includes(String(snapshot?.listing_status || '').toLowerCase()),
            offerActive: !['inactive', 'closed', 'not_found'].includes(String(snapshot?.offer_status || '').toLowerCase()),
            buyable: snapshot?.buyable === true,
            inStock: Number(snapshot?.inventory_available || 0) > 0,
            stockCoverageDays: snapshot?.stock_coverage_days,
            economicsComplete: snapshot?.economic_state !== 'ECONOMICS_PENDING',
            profitAfterAds: snapshot?.profit_after_ads,
            marginRate: snapshot?.margin_rate,
            currentAcos: snapshot?.current_acos,
            targetAcos: snapshot?.target_acos,
            safeMaxCpc: snapshot?.safe_max_cpc,
            economicFloor: snapshot?.economic_floor,
            competitionFresh: snapshot?.data_fresh === true,
            winnerProtected: snapshot?.winner_protected === true,
            sameSkuOrders: snapshot?.same_sku_orders,
            haloOrders: snapshot?.halo_orders,
            cooldownActive: executorCooldownActive,
            accountDailyCap: decision.account_daily_budget_limit,
            accountSpend: decision.account_daily_spend,
            proposedSpendImpact: decision.expected_impact_value,
            defensive: snapshot?.risk_state === 'LOSS_CONFIRMED',
            parentAsin: snapshot?.parent_asin === true,
            rollbackPlan: decision.rollback_plan,
          });
          if (!governance.allowed) {
            await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
              status: 'blocked',
              queue_status: 'completed',
              error_message: `GOVERNANCE_BLOCK: ${governance.blockers.map((blocker) => blocker.code).join(',')}`.slice(0, 500),
            }).catch(() => {});
            results.push({ id: decision.id, action: decision.action, ok: false, skipped: true, governance });
            skipped++;
            continue;
          }
        }

        // HARD GUARD: bloquear create_keyword se campanha já tem keyword ativa
        // Regra canônica: 1 campanha manual = 1 keyword EXACT
        if (
          (decision.action === 'create_keyword' || decision.decision_type === 'create_keyword' || decision.decision_type === 'harvest_search_term') &&
          decision.campaign_id
        ) {
          await assertSingleKeywordPerCampaign(
            base44,
            aid,
            decision.campaign_id,
            decision.keyword_text || decision.action || ''
          );
        }

        if (isCanonical && decision.lock_key) {
          lockOwnerId = crypto.randomUUID();
          const lockResponse = await base44.asServiceRole.functions.invoke('acquireAmazonSchedulerLock', {
            amazon_account_id: aid,
            lock_key: decision.lock_key,
            owner_id: lockOwnerId,
            ttl_ms: 300000,
            _service_role: true,
          }).catch((error: any) => ({ data: { ok: false, acquired: false, error: error?.message || String(error) } }));
          const lock = lockResponse?.data || lockResponse || {};
          if (lock.acquired !== true) {
            await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
              status: 'waiting_retry',
              queue_status: 'scheduled',
              next_retry_at: new Date(Date.now() + 5 * 60000).toISOString(),
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
            status: 'approved',
            queue_status: 'pending',
            next_retry_at: null,
          }).catch(() => {});
        }

        // Usa o roteador canônico: ajustes de bid são enviados para atualização pareada
        // de keyword e ad group; as demais ações seguem para o executor V2.
        const res = await base44.asServiceRole.functions.invoke('executeAutopilotDecision', {
          decision_ids: [decision.id],
          _service_role: true,
          _window_execution: true,
        });
        const data = res?.data || res || {};
        const ok = data?.executed > 0 || data?.ok === true;

        if (!ok && isEntityNotFound(data)) {
          await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
            status: 'cancelled',
            error_message: 'CANCELADO: entidade não encontrada na Amazon (ENTITY_NOT_FOUND) — decisão obsoleta',
          }).catch(() => {});
          results.push({ id: decision.id, action: decision.action, ok: false, cancelled: true });
          skipped++;
        } else {
          if (ok && capability.definition?.confirmationRequired) {
            await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
              confirmation_status: 'pending',
              confirmation_error: null,
              confirmed_at: null,
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
            amazon_account_id: aid,
            lock_key: decision.lock_key,
            owner_id: lockOwnerId,
            action: 'release',
            _service_role: true,
          }).catch(() => {});
        }
      }

      if (toProcess.indexOf(decision) < toProcess.length - 1) await sleep(API_DELAY_MS);
    }

    // Corrige também divergências históricas existentes em todas as campanhas manuais.
    const parityResponse = await base44.asServiceRole.functions.invoke('reconcileManualBidParity', {
      amazon_account_id: aid,
      _service_role: true,
    }).catch((e: any) => ({ data: { ok: false, error: e?.message } }));
    const parity = parityResponse?.data || parityResponse || {};

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'ads_decision_execution',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: failed === 0 && parity?.ok !== false ? 'success' : executed > 0 ? 'warning' : 'error',
      execution_date: new Date().toISOString().slice(0, 10),
      started_at: new Date(t0).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      records_processed: executed,
      error_message: failed > 0 ? `${failed} decisões falharam` : parity?.ok === false ? `Falha na reconciliação de bids: ${parity?.error || 'erro desconhecido'}` : null,
      result_summary: `${executed} executadas, ${failed} com erro, ${skipped} agendadas, ${preAutoCancel} pré-canceladas; ${Number(parity?.corrected || 0)} divergências de bid corrigidas`,
    }).catch(() => {});

    return Response.json({
      ok: true,
      pre_cancelled: preAutoCancel,
      total_approved: approved.length,
      processed: toProcess.length,
      executed,
      failed,
      skipped,
      remaining: Math.max(0, approved.length - MAX_BATCH),
      bid_parity: parity,
      duration_ms: Date.now() - t0,
      results: results.slice(0, 30),
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message }, { status: 500 });
  }
});
