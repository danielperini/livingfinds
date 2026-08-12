/**
 * IMMEDIATE_BUDGET_RESCUE — Motor de aumento de orçamento para campanhas SP rentáveis
 * com ≥95% de utilização de budget (Campaign.current_spend via Budget Usage API).
 *
 * Chamado pelo runDeterministicDecisionEngine no bloco 10b.
 * PRD: substituição do Cenário C (budget_increase_constrained).
 */

export interface RescueContext {
  aid: string;
  now: string;
  today: string;
  correlationId: string;
  base44: any;
  campaigns: any[];
  campWindowMetrics: Map<string, any>;
  acosByAsin: Map<string, any>;
  productMap: Map<string, any>;
  campaignAsinMap: Map<string, string>;
  authorizedEligibleAsins: Set<string>;
  settings: any;
  dataFreshness: string;
  usedIdemKeys: Set<string>;
  entityChangedThisCycle: Map<string, string>;
  account: any;
  stats: { budget_increase: number };
}

export interface RescueResult {
  cycleStats: {
    candidates: number;
    approved: number;
    executed: number;
    blocked_reasons: Record<string, number>;
  };
  executedDecisions: any[];
}

export async function runImmediateBudgetRescue(ctx: RescueContext): Promise<RescueResult> {
  const {
    aid, now, today, correlationId, base44,
    campaigns, campWindowMetrics, acosByAsin, productMap, campaignAsinMap,
    authorizedEligibleAsins, settings, dataFreshness,
    usedIdemKeys, entityChangedThisCycle, stats,
  } = ctx;

  const r2 = (v: number) => Math.round(v * 100) / 100;
  const cycleStats = { candidates: 0, approved: 0, executed: 0, blocked_reasons: {} as Record<string, number> };
  const executedDecisions: any[] = [];

  // ── Carregar AutopilotConfig ───────────────────────────────────────────────
  let cfg: any = {};
  try {
    const cfgList = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, null, 1).catch(() => []);
    if (cfgList[0]) cfg = cfgList[0];
  } catch {}

  // ── Carregar AccountDailySpendController ──────────────────────────────────
  let controller: any = {};
  try {
    const ctrlList = await base44.asServiceRole.entities.AccountDailySpendController.filter(
      { amazon_account_id: aid }, '-spend_date', 1
    ).catch(() => []);
    if (ctrlList[0]) controller = ctrlList[0];
  } catch {}

  const effectiveDailyCap = Number(cfg.daily_budget_limit || cfg.total_daily_budget || settings.daily_budget_cap || 70);
  const confirmedSpendToday = Number(controller.confirmed_spend || 0);
  const accountOverpacing = controller.spend_pacing === 'overpacing' || controller.global_kill_switch === true;
  const maxBudgetIncreasePct = Math.min((Number(cfg.max_budget_increase_pct) || 20) / 100, 0.20);
  const maxCampBudget = Number(cfg.maximum_campaign_budget) || Infinity;

  if (accountOverpacing) {
    cycleStats.blocked_reasons['account_overpacing_or_kill_switch'] = campaigns.length;
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'immediate_budget_rescue_cycle',
      trigger_type: 'automatic',
      status: 'skipped',
      execution_date: today,
      started_at: now,
      completed_at: new Date().toISOString(),
      records_processed: 0,
      result_summary: JSON.stringify({ ...cycleStats, account_overpacing: true }),
    }).catch(() => {});
    return { cycleStats, executedDecisions };
  }

  // Autenticação e endpoint são responsabilidade exclusiva do amazonAdsCommand.
  // Nenhuma regra econômica abaixo depende da origem da credencial.

  // ── Cooldown 24h: buscar decisões RESCUE recentes ─────────────────────────
  const cutoff24h = new Date(Date.now() - 24 * 3600000).toISOString();
  const cutoff48h = new Date(Date.now() - 48 * 3600000).toISOString();
  const recentRescue = await base44.asServiceRole.entities.OptimizationDecision.filter(
    { amazon_account_id: aid, rule_key: 'IMMEDIATE_BUDGET_RESCUE' },
    '-created_at', 200
  ).catch(() => []);

  // Índice cooldown: campaign_id → { blocked, confidence_level, orders_at_last }
  const cooldownMap = new Map<string, { blocked: boolean; confidence_level?: string; orders_at_last?: number }>();
  for (const rd of recentRescue) {
    const rdCid = rd.campaign_id;
    if (!rdCid) continue;
    const createdAt = rd.created_at || rd.created_date || '';
    const isRecent = createdAt >= cutoff24h;
    const isActive = ['approved', 'executing', 'executed'].includes(rd.status);
    if (isRecent && isActive) {
      let clevel: string | undefined;
      let ordersAtLast: number | undefined;
      if (rd.data_used) {
        try { const du = JSON.parse(rd.data_used); clevel = du.confidence_level; ordersAtLast = du.orders_at_decision; } catch {}
      }
      cooldownMap.set(rdCid, { blocked: true, confidence_level: clevel, orders_at_last: ordersAtLast });
    }
  }

  // ── Campanhas ociosas (realocação informativa) ─────────────────────────────
  const idleCampaignIds: string[] = [];
  for (const camp of campaigns) {
    const cst = String(camp.state || camp.status || '').toLowerCase();
    if (cst === 'archived') continue;
    const cid2 = camp.campaign_id || camp.amazon_campaign_id;
    if (!cid2) continue;
    const wm2 = campWindowMetrics.get(cid2);
    const asin2 = camp.asin || campaignAsinMap.get(cid2);
    const beAcos2 = asin2 ? (acosByAsin.get(asin2)?.break_even ?? 999) : 999;
    if (!wm2 || wm2.d7?.spend === 0 || wm2.d14?.orders === 0 || (wm2.d14?.acos !== null && wm2.d14?.acos > beAcos2)) {
      idleCampaignIds.push(cid2);
    }
  }

  // ── Loop principal ─────────────────────────────────────────────────────────
  for (const camp of campaigns) {
    const cid = camp.campaign_id || camp.amazon_campaign_id;
    if (!cid) continue;

    // Somente SP ativas
    if ((camp.campaign_type || 'SP').toUpperCase() !== 'SP') continue;
    const campState = String(camp.state || camp.status || '').toLowerCase();
    if (['archived', 'incomplete', 'paused'].includes(campState)) continue;

    // Budget válido
    const currentDailyBudget = Number(camp.daily_budget || 0);
    if (currentDailyBudget <= 0) { cycleStats.blocked_reasons['no_budget'] = (cycleStats.blocked_reasons['no_budget'] || 0) + 1; continue; }

    // Utilization via current_spend (Budget Usage API)
    const currentSpend = Number(camp.current_spend || 0);
    const utilizationPct = (currentSpend / currentDailyBudget) * 100;
    if (utilizationPct < 95) continue;

    cycleStats.candidates++;

    // Escopo e estoque
    const asin = camp.asin || campaignAsinMap.get(cid) || null;
    const product = asin ? productMap.get(asin) : null;

    if (asin && !authorizedEligibleAsins.has(asin)) {
      cycleStats.blocked_reasons['ads_not_authorized'] = (cycleStats.blocked_reasons['ads_not_authorized'] || 0) + 1;
      continue;
    }
    if (Number(product?.fba_inventory || 0) <= 0) {
      cycleStats.blocked_reasons['no_stock'] = (cycleStats.blocked_reasons['no_stock'] || 0) + 1;
      continue;
    }

    // Métricas 14d
    const wm = campWindowMetrics.get(cid);
    if (!wm) { cycleStats.blocked_reasons['no_metrics'] = (cycleStats.blocked_reasons['no_metrics'] || 0) + 1; continue; }
    const d14 = wm.d14;

    if (d14.orders < 1 || d14.sales <= 0 || d14.acos === null) {
      cycleStats.blocked_reasons['no_sales_or_acos_null'] = (cycleStats.blocked_reasons['no_sales_or_acos_null'] || 0) + 1;
      continue;
    }

    const asinMeta = asin ? acosByAsin.get(asin) : null;
    const targetAcos = asinMeta?.target ?? settings.target_acos ?? 15;
    const targetRoas = settings.target_roas ?? 4;
    const breakEvenAcos = asinMeta?.break_even ?? 999;

    if (d14.acos > targetAcos) { cycleStats.blocked_reasons['acos_above_target'] = (cycleStats.blocked_reasons['acos_above_target'] || 0) + 1; continue; }
    if (d14.acos >= breakEvenAcos) { cycleStats.blocked_reasons['acos_above_breakeven'] = (cycleStats.blocked_reasons['acos_above_breakeven'] || 0) + 1; continue; }
    if ((d14.roas || 0) < targetRoas) { cycleStats.blocked_reasons['roas_below_target'] = (cycleStats.blocked_reasons['roas_below_target'] || 0) + 1; continue; }
    if (asinMeta?.profit_protection?.mode === 'paused') { cycleStats.blocked_reasons['profit_paused'] = (cycleStats.blocked_reasons['profit_paused'] || 0) + 1; continue; }
    if (dataFreshness === 'stale') { cycleStats.blocked_reasons['data_stale'] = (cycleStats.blocked_reasons['data_stale'] || 0) + 1; continue; }

    // Cooldown 24h
    const cooldownEntry = cooldownMap.get(cid);
    if (cooldownEntry?.blocked) {
      if (cooldownEntry.confidence_level === 'PROVISIONAL') {
        const ordersAtLast = cooldownEntry.orders_at_last ?? 0;
        if (d14.orders <= ordersAtLast) {
          cycleStats.blocked_reasons['provisional_cooldown_no_new_conversion'] = (cycleStats.blocked_reasons['provisional_cooldown_no_new_conversion'] || 0) + 1;
          continue;
        }
      } else {
        cycleStats.blocked_reasons['cooldown_24h'] = (cycleStats.blocked_reasons['cooldown_24h'] || 0) + 1;
        continue;
      }
    }

    // Confidence level
    const confidenceLevel = (d14.orders >= 2 && d14.acos <= targetAcos) ? 'CONFIRMED_WINNER' : 'PROVISIONAL';

    // PROVISIONAL sem cooldown: verificar histórico 48h sem nova conversão
    if (confidenceLevel === 'PROVISIONAL' && !cooldownEntry) {
      const provisionalRecent = recentRescue.find((rd: any) => {
        if (rd.campaign_id !== cid) return false;
        if ((rd.created_at || '') < cutoff48h) return false;
        try { return JSON.parse(rd.data_used || '{}').confidence_level === 'PROVISIONAL'; } catch { return false; }
      });
      if (provisionalRecent) {
        const ordersAtProvisional = (() => { try { return JSON.parse(provisionalRecent.data_used || '{}').orders_at_decision ?? 0; } catch { return 0; } })();
        if (d14.orders <= ordersAtProvisional) {
          cycleStats.blocked_reasons['provisional_second_without_conversion'] = (cycleStats.blocked_reasons['provisional_second_without_conversion'] || 0) + 1;
          continue;
        }
      }
    }

    // Calcular novo orçamento
    const stepBudget = r2(currentDailyBudget * (1 + maxBudgetIncreasePct));
    const amazonRecommendedBudget = Number(camp.recommended_daily_budget || 0);
    const recommendedCap = amazonRecommendedBudget > currentDailyBudget ? amazonRecommendedBudget : Infinity;
    const accountRemaining = Math.max(0, effectiveDailyCap - confirmedSpendToday);
    const newBudget = r2(Math.min(stepBudget, recommendedCap, maxCampBudget, currentDailyBudget + accountRemaining));

    if (newBudget <= currentDailyBudget + 0.49) {
      cycleStats.blocked_reasons['no_headroom'] = (cycleStats.blocked_reasons['no_headroom'] || 0) + 1;
      continue;
    }

    // Idempotência
    const iKey = `IMMEDIATE_BUDGET_RESCUE|${aid}|${cid}|${today}|${newBudget}`;
    if (usedIdemKeys.has(iKey) || entityChangedThisCycle.has(cid)) {
      cycleStats.blocked_reasons['idempotent_skip'] = (cycleStats.blocked_reasons['idempotent_skip'] || 0) + 1;
      continue;
    }
    const existingInDb = recentRescue.find((rd: any) => rd.campaign_id === cid && rd.idempotency_key === iKey);
    if (existingInDb) {
      cycleStats.blocked_reasons['already_executed'] = (cycleStats.blocked_reasons['already_executed'] || 0) + 1;
      continue;
    }

    cycleStats.approved++;

    // Realocação informativa
    const reallocationSources = idleCampaignIds.filter(id => id !== cid).slice(0, 3);
    const reallocationNote = reallocationSources.length > 0 ? ` Realocação de orçamento ocioso de: [${reallocationSources.join(', ')}].` : '';

    const rationale = `🚨 IMMEDIATE_BUDGET_RESCUE — Campanha SP rentável com ${utilizationPct.toFixed(1)}% de utilização (≥95%). ACoS ${d14.acos?.toFixed(1)}% ≤ meta ${targetAcos}%, ROAS ${(d14.roas || 0).toFixed(2)}x, ${d14.orders}p em 14d. Confidence: ${confidenceLevel}. Budget: R$${currentDailyBudget.toFixed(2)} → R$${newBudget.toFixed(2)} (+${((newBudget / currentDailyBudget - 1) * 100).toFixed(1)}%).${reallocationNote} Saldo conta: R$${accountRemaining.toFixed(2)}.`;

    const dataUsedJson = JSON.stringify({
      confidence_level: confidenceLevel,
      budget_utilization_pct: Math.round(utilizationPct * 10) / 10,
      orders_at_decision: d14.orders,
      sales_at_decision: r2(d14.sales),
      acos_at_decision: d14.acos !== null ? Math.round(d14.acos * 10) / 10 : null,
      roas_at_decision: r2(d14.roas || 0),
      stock_at_decision: Number(product?.fba_inventory || 0),
      budget_previous: currentDailyBudget,
      budget_recommended_amazon: amazonRecommendedBudget || null,
      account_remaining: r2(accountRemaining),
      effective_daily_cap: effectiveDailyCap,
      max_budget_increase_pct: Math.round(maxBudgetIncreasePct * 100),
      reallocation_sources: reallocationSources,
    });

    // Chamada Amazon Ads API via gateway canônico. Mantém exatamente o payload v3.
    const amazonCampaignId = camp.campaign_id || camp.amazon_campaign_id;
    let amazonCallOk = false;
    let amazonRequestId: string | null = null;
    let amazonHttpStatus: number | null = null;
    let amazonError: string | null = null;
    const callStartAt = Date.now();

    if (Math.abs(Number(camp.daily_budget || 0) - newBudget) < 0.01) {
      // Já está no valor desejado — idempotência API
      amazonCallOk = true;
      amazonRequestId = 'idempotent_no_change';
    } else if (amazonCampaignId) {
      try {
        const commandResponse = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
          _service_role: true,
          amazon_account_id: aid,
          path: '/sp/campaigns',
          method: 'PUT',
          operation: 'IMMEDIATE_BUDGET_RESCUE',
          content_type: 'application/vnd.spCampaign.v3+json',
          accept: 'application/vnd.spCampaign.v3+json',
          payload: {
            campaigns: [{
              campaignId: amazonCampaignId,
              budget: { budget: newBudget, budgetType: 'DAILY' },
            }],
          },
        });
        const commandData = commandResponse?.data || commandResponse || {};
        amazonHttpStatus = Number(commandData.status || 0) || (commandData.ok === true ? 200 : null);
        amazonRequestId = commandData.request_id || null;

        if (commandData.ok === true) {
          const successes = commandData.payload?.campaigns?.success;
          if (Array.isArray(successes)) {
            const successIds = successes.map((s: any) => String(s?.campaignId || ''));
            amazonCallOk = successIds.includes(String(amazonCampaignId)) || successes.length > 0;
            if (!amazonCallOk) amazonError = 'sem_sucesso_confirmado';
          } else {
            // O gateway já classificou HTTP + erros por item; payloads sem lista de success
            // são aceitos somente quando ele confirmou ok=true.
            amazonCallOk = true;
          }
        } else if (amazonHttpStatus === 409) {
          amazonCallOk = true; // preserva semântica idempotente anterior
          amazonError = '409_idempotent';
        } else {
          amazonError = String(
            commandData.error_type ||
            commandData.errors?.[0]?.message ||
            commandData.message ||
            (amazonHttpStatus ? `HTTP_${amazonHttpStatus}` : 'amazon_command_failed')
          );
        }
      } catch (err: any) {
        amazonError = err?.message || 'amazon_command_error';
      }
    } else {
      amazonError = 'missing_campaign_id';
    }

    const durationMs = Date.now() - callStartAt;
    const nextReviewAt = new Date(Date.now() + 24 * 3600000).toISOString();

    if (amazonCallOk) {
      // Atualizar Campaign SOMENTE após confirmação Amazon
      base44.asServiceRole.entities.Campaign.update(camp.id, {
        daily_budget: newBudget,
        budget_last_changed_at: now,
        budget_change_reason: 'IMMEDIATE_BUDGET_RESCUE',
        amazon_request_id: amazonRequestId || undefined,
        budget_previous: currentDailyBudget,
      }).catch(() => {});

      base44.asServiceRole.entities.OptimizationDecision.create({
        amazon_account_id: aid,
        run_id: correlationId,
        decision_type: 'immediate_budget_rescue',
        entity_type: 'campaign',
        entity_id: cid,
        campaign_id: cid,
        asin: asin || undefined,
        action: 'set_budget',
        value_before: currentDailyBudget,
        value_after: newBudget,
        rationale,
        rule_key: 'IMMEDIATE_BUDGET_RESCUE',
        risk: 'low',
        confidence: confidenceLevel === 'CONFIRMED_WINNER' ? 90 : 60,
        status: 'executed',
        approval_status: 'auto_approved',
        requires_approval: false,
        idempotency_key: iKey,
        source_function: 'runDeterministicDecisionEngine_v8',
        data_used: dataUsedJson,
        amazon_response_code: amazonHttpStatus || 200,
        amazon_request_id: amazonRequestId || undefined,
        executed_at: now,
        created_at: now,
        evaluation_due_at: nextReviewAt,
      }).catch(() => {});

      entityChangedThisCycle.set(cid, 'IMMEDIATE_BUDGET_RESCUE');
      usedIdemKeys.add(iKey);
      stats.budget_increase++;
      cycleStats.executed++;
      executedDecisions.push({
        campaign_id: cid,
        asin,
        budget_before: currentDailyBudget,
        budget_after: newBudget,
        utilization_pct: Math.round(utilizationPct * 10) / 10,
        orders_14d: d14.orders,
        acos_14d: d14.acos !== null ? Math.round(d14.acos * 10) / 10 : null,
        confidence_level: confidenceLevel,
        amazon_request_id: amazonRequestId,
        duration_ms: durationMs,
        next_review_at: nextReviewAt,
      });
    } else {
      base44.asServiceRole.entities.OptimizationDecision.create({
        amazon_account_id: aid,
        run_id: correlationId,
        decision_type: 'immediate_budget_rescue',
        entity_type: 'campaign',
        entity_id: cid,
        campaign_id: cid,
        asin: asin || undefined,
        action: 'set_budget',
        value_before: currentDailyBudget,
        value_after: newBudget,
        rationale: rationale + ` [FALHA Amazon: ${amazonError}]`,
        rule_key: 'IMMEDIATE_BUDGET_RESCUE',
        risk: 'low',
        confidence: 50,
        status: 'failed',
        idempotency_key: iKey,
        source_function: 'runDeterministicDecisionEngine_v8',
        data_used: dataUsedJson,
        amazon_response_code: amazonHttpStatus || undefined,
        execution_error: amazonError || undefined,
        created_at: now,
      }).catch(() => {});
      cycleStats.blocked_reasons['amazon_api_error'] = (cycleStats.blocked_reasons['amazon_api_error'] || 0) + 1;
    }
  }

  // Log de ciclo
  base44.asServiceRole.entities.SyncExecutionLog.create({
    amazon_account_id: aid,
    operation: 'immediate_budget_rescue_cycle',
    trigger_type: 'automatic',
    status: cycleStats.executed > 0 ? 'success' : 'skipped',
    execution_date: today,
    started_at: now,
    completed_at: new Date().toISOString(),
    records_processed: cycleStats.executed,
    result_summary: JSON.stringify({
      ...cycleStats,
      account_overpacing: accountOverpacing,
      effective_daily_cap: effectiveDailyCap,
      confirmed_spend_today: r2(confirmedSpendToday),
      decisions: executedDecisions,
    }),
  }).catch(() => {});

  return { cycleStats, executedDecisions };
}