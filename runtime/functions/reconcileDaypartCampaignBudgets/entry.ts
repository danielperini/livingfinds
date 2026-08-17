import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { campaignMatchesRule, ruleMatchesNow } from '../../shared/persistedDaypartRulePolicy.ts';
import { decideDaypartBudgetRestore } from '../../shared/daypartBudgetRestorePolicy.ts';

const SOURCE = 'reconcileDaypartCampaignBudgets';
const n = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const lower = (value: unknown) => String(value || '').toLowerCase();
const upper = (value: unknown) => String(value || '').toUpperCase();
const campaignIdOf = (row: any) => String(row.amazon_campaign_id || row.campaign_id || row.id || '');
const active = (row: any) => ['enabled', 'active'].includes(lower(row.state || row.status || row.amazon_status));
const brtDate = (now = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now);

function isBudgetAction(row: any): boolean {
  return ['budget_change', 'update_budget', 'reduce_budget', 'increase_budget', 'set_budget']
    .includes(lower(row.action || row.canonical_action_type || row.decision_type));
}

function isConfirmed(row: any): boolean {
  return ['confirmed', 'executed', 'completed'].includes(lower(row.status)) ||
    lower(row.confirmation_status) === 'confirmed';
}

function isAppBudgetReduction(row: any): boolean {
  const source = lower(row.source_function);
  return isBudgetAction(row) && n(row.value_before ?? row.current_value) > n(row.value_after ?? row.proposed_value) &&
    isConfirmed(row) && ['runeconomicbudgetbalancer', 'portfolio_budget_pacing', 'reconcileaccountbudgetpacing',
      'rununifieddecisionengine', 'reconciledaypartcampaignbudgets'].some((name) => source.includes(name));
}

async function createIdempotent(base44: any, payload: any) {
  const existing = await base44.asServiceRole.entities.OptimizationDecision.filter(
    { idempotency_key: payload.idempotency_key }, '-created_at', 1,
  ).catch(() => []);
  if (existing.length) return { row: existing[0], reused: true };
  try {
    return { row: await base44.asServiceRole.entities.OptimizationDecision.create(payload), reused: false };
  } catch (error: any) {
    const message = String(error?.message || error || '').toLowerCase();
    if (!message.includes('duplicate') && Number(error?.status || error?.response?.status || 0) !== 409) throw error;
    const rows = await base44.asServiceRole.entities.OptimizationDecision.filter(
      { idempotency_key: payload.idempotency_key }, '-created_at', 1,
    ).catch(() => []);
    if (!rows.length) throw error;
    return { row: rows[0], reused: true };
  }
}

Deno.serve(async (request) => {
  const startedAt = new Date();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    if (body._canonical_orchestrator !== 'runUnifiedDecisionEngine') {
      return Response.json({ ok: false, error: 'Uso exclusivo pelo motor canônico' }, { status: 403 });
    }

    const now = body.now ? new Date(body.now) : new Date();
    const dryRun = body.dry_run === true;
    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 50);
    const results: any[] = [];

    for (const account of accounts) {
      const accountId = String(account.id);
      const syncCampaigns = await base44.asServiceRole.functions.invoke('syncAmazonCampaigns', {
        amazon_account_id: accountId, _service_role: true, trigger_type: SOURCE,
      }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
      const syncMetrics = await base44.asServiceRole.functions.invoke('syncAmazonIntradayCampaignMetrics', {
        amazon_account_id: accountId, _service_role: true, force: true, trigger_type: SOURCE,
      }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));

      const today = brtDate(now);
      const [rules, campaigns, products, decisions, controllers, settingsRows, intraday] = await Promise.all([
        base44.asServiceRole.entities.AmazonScheduledRule.filter({ amazon_account_id: accountId, status: 'enabled' }, '-updated_at', 500).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-updated_at', 10000).catch(() => []),
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, '-updated_at', 10000).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-created_at', 30000).catch(() => []),
        base44.asServiceRole.entities.AccountDailySpendController.filter({ amazon_account_id: accountId, date: today }, '-updated_at', 5).catch(() => []),
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.IntradaySpendSnapshot.filter({ amazon_account_id: accountId, spend_date: today }, '-observed_at', 20000).catch(() => []),
      ]);

      const bidRules = rules.filter((rule: any) => upper(rule.action_type) === 'BID_PERCENT' && ruleMatchesNow(rule, now));
      const pauseRules = rules.filter((rule: any) => upper(rule.action_type) === 'PAUSE_CAMPAIGN' && ruleMatchesNow(rule, now));
      const settings = settingsRows[0] || {};
      const minimumCampaignBudget = Math.max(0, n(settings.minimum_campaign_budget || settings.min_campaign_budget || 15));
      const globalBudget = Math.max(0, n(settings.daily_budget || settings.account_daily_budget_limit || settings.global_daily_budget || 0));
      const latestController = controllers[0] || {};
      const hardCap = latestController.hard_cap_reached === true || latestController.account_out_of_budget === true;
      const latestSpend = new Map<string, number>();
      for (const row of intraday) {
        const id = String(row.campaign_id || '');
        if (id && !latestSpend.has(id)) latestSpend.set(id, n(row.spend));
      }
      const accountSpend = [...latestSpend.values()].reduce((sum, value) => sum + value, 0);
      let remaining = globalBudget > 0 ? Math.max(0, globalBudget - accountSpend) : Number.POSITIVE_INFINITY;
      const productByAsin = new Map(products.filter((row: any) => row.asin).map((row: any) => [upper(row.asin), row]));
      const queuedIds: string[] = [];
      const actions: any[] = [];

      for (const campaign of campaigns) {
        if (campaign.archived === true || upper(campaign.campaign_type || 'SP') !== 'SP') continue;
        const campaignId = campaignIdOf(campaign);
        if (!campaignId || !active(campaign)) continue;
        const matchingBidRule = bidRules.find((rule: any) => campaignMatchesRule(rule, campaign));
        if (!matchingBidRule) continue;
        const pauseWindow = pauseRules.some((rule: any) => campaignMatchesRule(rule, campaign));
        const asin = upper(campaign.asin || campaign.advertised_asin || String(campaign.name || campaign.campaign_name || '').match(/B0[A-Z0-9]{8}/i)?.[0]);
        const product = productByAsin.get(asin);
        const stock = n(product?.fulfillable_quantity ?? product?.inventory_quantity ?? product?.stock);
        const currentBudget = n(campaign.daily_budget ?? campaign.budget);
        const campaignSpend = latestSpend.get(campaignId) || 0;
        const reductions = decisions.filter((row: any) => String(row.campaign_id || row.entity_id || '') === campaignId && isAppBudgetReduction(row));
        const baselineFromDecision = reductions.reduce((max, row) => Math.max(max, n(row.value_before ?? row.current_value)), 0);
        const persistedBaseline = n(campaign.baseline_daily_budget || campaign.configured_daily_budget || campaign.original_daily_budget || campaign.budget_before_pacing);
        const baselineBudget = Math.max(currentBudget, baselineFromDecision, persistedBaseline);
        const policy = decideDaypartBudgetRestore({
          currentBudget,
          baselineBudget,
          currentSpend: campaignSpend,
          minimumCampaignBudget,
          remainingAccountBudget: remaining,
          accountHardCap: hardCap,
          bidOnlyWindow: true,
          pauseWindow,
          active: true,
          inStock: !!product && stock > 0,
          appReducedBudget: reductions.length > 0 || persistedBaseline > currentBudget,
        });

        if (!policy.eligible) {
          actions.push({ campaign_id: campaignId, action: 'NO_CHANGE', reason: policy.reason, current_budget: currentBudget });
          continue;
        }
        const delta = Math.max(0, policy.targetBudget - currentBudget);
        const key = `${SOURCE}|${accountId}|${campaignId}|${today}|${policy.targetBudget.toFixed(2)}`;
        if (!dryRun) {
          const { row, reused } = await createIdempotent(base44, {
            amazon_account_id: accountId,
            decision_type: 'daypart_budget_restore',
            entity_type: 'campaign',
            entity_id: campaignId,
            campaign_id: campaignId,
            action: 'update_budget',
            canonical_action_type: 'update_budget',
            value_before: currentBudget,
            value_after: policy.targetBudget,
            current_value: currentBudget,
            proposed_value: policy.targetBudget,
            expected_impact_value: delta,
            rationale: 'Restaurar budget reduzido pelo pacing antes de aplicar apenas redução de bids do Dayparting.',
            rule_key: 'DAYPART_BID_ONLY_BUDGET_RESTORE',
            reason_code: 'DAYPART_BID_ONLY_BUDGET_RESTORE',
            status: 'approved',
            queue_status: 'pending',
            execution_mode: 'EXECUTE_NOW',
            priority_class: 'P1',
            requires_approval: false,
            approval_status: 'auto_approved',
            confirmation_required: true,
            confirmation_status: 'pending',
            idempotency_key: key,
            conflict_group: `${accountId}|campaign_budget|${campaignId}`,
            lock_key: `${accountId}|campaign_budget|${campaignId}`,
            source_function: SOURCE,
            model_version: 'daypart-budget-restore-v1',
            account_daily_budget_limit: globalBudget,
            account_daily_spend: accountSpend,
            data_used: JSON.stringify({ rule_id: matchingBidRule.id, current_spend: campaignSpend, baseline_budget: baselineBudget, remaining_account_budget: remaining }),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          if (!reused && row?.id) queuedIds.push(String(row.id));
        }
        remaining = Math.max(0, remaining - delta);
        actions.push({ campaign_id: campaignId, action: 'RESTORE_BUDGET', current_budget: currentBudget, target_budget: policy.targetBudget, dry_run: dryRun });
      }

      // O motor unificado é o único dono da execução. Esta etapa apenas cria
      // decisões idempotentes; o executor/confirmador canônicos dos minutos
      // seguintes aplicam e verificam a alteração na Amazon.
      const deferToCanonicalExecutor = body._canonical_orchestrator === 'runUnifiedDecisionEngine';
      let execution: any = { skipped: true, reason: dryRun ? 'DRY_RUN' : deferToCanonicalExecutor ? 'CANONICAL_EXECUTOR_OWNS_EXECUTION' : 'NO_NEW_DECISIONS' };
      let confirmation: any = { skipped: true, reason: deferToCanonicalExecutor ? 'CANONICAL_CONFIRMATION_OWNS_CONFIRMATION' : 'NO_NEW_DECISIONS' };
      if (!dryRun && queuedIds.length && !deferToCanonicalExecutor) {
        const executed = await base44.asServiceRole.functions.invoke('executeApprovedDecisionQueue', {
          amazon_account_id: accountId, _service_role: true,
        }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
        execution = executed?.data || executed || {};
        const confirmed = await base44.asServiceRole.functions.invoke('confirmExecutedDecisions', {
          amazon_account_id: accountId, _service_role: true, decision_ids: queuedIds,
        }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
        confirmation = confirmed?.data || confirmed || {};
      }

      const result = {
        amazon_account_id: accountId,
        date_brt: today,
        active_bid_rules: bidRules.length,
        active_pause_rules: pauseRules.length,
        account_hard_cap: hardCap,
        account_spend: accountSpend,
        global_budget: globalBudget,
        queued: queuedIds.length,
        actions,
        sync_campaigns: syncCampaigns?.data || syncCampaigns,
        sync_metrics: syncMetrics?.data || syncMetrics,
        execution,
        confirmation,
      };
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: accountId,
        operation: SOURCE,
        status: execution?.ok === false || confirmation?.ok === false ? 'warning' : 'success',
        started_at: startedAt.toISOString(),
        completed_at: new Date().toISOString(),
        records_processed: actions.length,
        records_success: actions.filter((row: any) => row.action === 'RESTORE_BUDGET').length,
        records_failed: execution?.ok === false ? 1 : 0,
        result_summary: JSON.stringify({ active_bid_rules: bidRules.length, hard_cap: hardCap, queued: queuedIds.length, execution, confirmation }).slice(0, 2000),
      }).catch(() => {});
      results.push(result);
    }

    return Response.json({ ok: results.every((row) => row.execution?.ok !== false), engine: 'daypart-budget-restore-v1', dry_run: dryRun, accounts: results });
  } catch (error: any) {
    return Response.json({ ok: false, engine: 'daypart-budget-restore-v1', error: error?.message || 'Falha ao reconciliar budgets do Dayparting' }, { status: 500 });
  }
});
