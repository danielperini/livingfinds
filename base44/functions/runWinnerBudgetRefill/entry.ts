/**
 * Reposição intradiária de orçamento para campanhas vencedoras.
 *
 * Uma campanha nunca recebe orçamento extra somente por ter gasto rápido.
 * Exige venda, ACoS dentro da meta, consumo de pelo menos 90% do orçamento,
 * métricas intradiárias confirmadas e saldo no teto diário da conta.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const REFILL_PCT = 0.20;
const MAX_REFILLS_PER_DAY = 2;
const MAX_REFILLS_PER_RUN = 10;
const MIN_REMAINING_ACCOUNT_BUDGET = 2;

const brtDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const number = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const r2 = (value: number) => Math.round(value * 100) / 100;
const enabled = (campaign: any) => ['enabled', 'active'].includes(String(campaign?.state || campaign?.status || '').toLowerCase());

function commandSucceeded(response: any, campaignId: string) {
  const data = response?.data || response || {};
  if (data.ok === false) return false;
  const payload = data.payload || data;
  const errors = payload?.campaigns?.error || payload?.errors || [];
  if (Array.isArray(errors) && errors.some((item: any) => String(item.campaignId || item.campaign_id) === campaignId)) return false;
  const success = payload?.campaigns?.success || payload?.success || [];
  return !Array.isArray(success) || success.length === 0 || success.some((item: any) => String(item.campaignId || item.campaign_id) === campaignId);
}

Deno.serve(async (request) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 50);
    const today = brtDate();
    const results: any[] = [];

    for (const account of accounts) {
      const accountId = account.id;
      const [performanceRows, controllerRows, campaigns, priorDecisions] = await Promise.all([
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.AccountDailySpendController.filter({ amazon_account_id: accountId, spend_date: today }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, null, 5000).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId, decision_type: 'winner_budget_refill' }, '-created_at', 5000).catch(() => []),
      ]);
      const performance = performanceRows[0] || {};
      const controller = controllerRows[0] || null;
      const targetAcos = number(performance.target_acos, 15);
      const maxBudget = Math.max(5, number(performance.max_budget_per_campaign, 25));
      const remaining = number(controller?.remaining_spend, 0);
      const metricsFresh = ['fresh', 'available', 'complete'].includes(String(controller?.intraday_metrics_status || '').toLowerCase());

      if (!controller || controller.global_kill_switch === true || !metricsFresh || remaining < MIN_REMAINING_ACCOUNT_BUDGET) {
        results.push({ account_id: accountId, ok: true, skipped: true, reason: !controller ? 'controle diário ausente' : controller.global_kill_switch ? 'kill switch ativo' : !metricsFresh ? 'métricas intradiárias não confirmadas' : 'saldo global insuficiente' });
        continue;
      }

      const refillsByCampaign = new Map<string, number>();
      for (const decision of priorDecisions) {
        if (String(decision.created_at || '').slice(0, 10) !== today || String(decision.status || '') !== 'executed') continue;
        const id = String(decision.campaign_id || decision.entity_id || '');
        refillsByCampaign.set(id, (refillsByCampaign.get(id) || 0) + 1);
      }

      const candidates = campaigns.map((campaign: any) => {
        const campaignId = String(campaign.amazon_campaign_id || campaign.campaign_id || '');
        const budget = number(campaign.daily_budget || campaign.budget, 0);
        const spend = number(campaign.current_spend ?? campaign.spend, 0);
        const sales = number(campaign.sales, 0);
        const orders = number(campaign.orders, 0);
        const acos = sales > 0 ? spend / sales * 100 : Infinity;
        const exhausted = campaign.budget_exhausted === true || String(campaign.budget_status || '').toLowerCase() === 'exhausted' || (budget > 0 && spend >= budget * 0.90);
        return { campaign, campaignId, budget, spend, sales, orders, acos, exhausted, refills: refillsByCampaign.get(campaignId) || 0 };
      }).filter((candidate: any) =>
        enabled(candidate.campaign) && candidate.campaignId && candidate.budget > 0 &&
        candidate.orders >= 1 && candidate.sales > 0 && candidate.acos > 0 && candidate.acos <= targetAcos &&
        candidate.exhausted && candidate.refills < MAX_REFILLS_PER_DAY,
      ).sort((a: any, b: any) => (b.sales - b.spend) - (a.sales - a.spend)).slice(0, MAX_REFILLS_PER_RUN);

      const applied: any[] = [];
      const skipped: any[] = [];
      let remainingForRefills = remaining;
      for (const candidate of candidates) {
        const increase = Math.min(candidate.budget * REFILL_PCT, remainingForRefills);
        const newBudget = r2(Math.min(maxBudget, candidate.budget + increase));
        if (newBudget <= candidate.budget + 0.01) {
          skipped.push({ campaign_id: candidate.campaignId, reason: 'teto por campanha ou saldo insuficiente' });
          continue;
        }
        const key = `winner_budget_refill|${accountId}|${candidate.campaignId}|${today}|${candidate.refills + 1}`;
        const existing = await base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId, idempotency_key: key }, '-created_at', 1).catch(() => []);
        if (existing.length) {
          skipped.push({ campaign_id: candidate.campaignId, reason: 'idempotência' });
          continue;
        }
        if (body.dry_run === true) {
          applied.push({ campaign_id: candidate.campaignId, dry_run: true, from: candidate.budget, to: newBudget });
          continue;
        }
        const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
          _service_role: true, amazon_account_id: accountId, operation: 'winner_budget_refill',
          method: 'PUT', path: '/sp/campaigns', content_type: 'application/vnd.spCampaign.v3+json',
          payload: { campaigns: [{ campaignId: candidate.campaignId, budget: { budget: newBudget, budgetType: 'DAILY' } }], idempotencyKey: key },
        }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
        const ok = commandSucceeded(response, candidate.campaignId);
        const now = new Date().toISOString();
        await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id: accountId, decision_type: 'winner_budget_refill', entity_type: 'campaign', entity_id: candidate.campaignId,
          campaign_id: candidate.campaignId, asin: candidate.campaign.asin || null, action: 'increase_daily_budget',
          current_value: candidate.budget, proposed_value: newBudget, value_before: candidate.budget, value_after: newBudget,
          rationale: `Vencedora intradiária: ACoS ${r2(candidate.acos)}% ≤ meta ${targetAcos}%, orçamento ${r2(candidate.spend / candidate.budget * 100)}% consumido, venda R$ ${r2(candidate.sales)}.`,
          risk: 'low', status: ok ? 'executed' : 'failed', queue_status: ok ? 'completed' : 'failed', idempotency_key: key,
          source_function: 'runWinnerBudgetRefill', executed_at: ok ? now : null, created_at: now, updated_at: now,
        }).catch(() => {});
        if (!ok) {
          skipped.push({ campaign_id: candidate.campaignId, reason: 'Amazon não confirmou o novo orçamento' });
          continue;
        }
        await base44.asServiceRole.entities.Campaign.update(candidate.campaign.id, { daily_budget: newBudget, budget: newBudget, budget_exhausted: false, budget_status: 'refilled', last_activity_at: now, synced_at: now }).catch(() => {});
        await base44.asServiceRole.entities.CampaignChangeHistory.create({
          amazon_account_id: accountId, campaign_id: candidate.campaignId, asin: candidate.campaign.asin || null,
          change_type: 'winner_budget_refill', field_changed: 'daily_budget', old_value: String(candidate.budget), new_value: String(newBudget),
          reason: `Reposição intradiária de vencedora; ACoS ${r2(candidate.acos)}%.`, applied_at: now, source: 'runWinnerBudgetRefill', created_at: now,
        }).catch(() => {});
        applied.push({ campaign_id: candidate.campaignId, from: candidate.budget, to: newBudget, acos: r2(candidate.acos), sales: candidate.sales });
        remainingForRefills = r2(Math.max(0, remainingForRefills - (newBudget - candidate.budget)));
      }
      results.push({ account_id: accountId, ok: true, candidates: candidates.length, applied, skipped, remaining_account_budget: remainingForRefills });
    }
    return Response.json({ ok: true, engine: 'winner-intraday-budget-refill-v1', results, duration_ms: Date.now() - startedAt });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha na reposição intradiária de orçamento', duration_ms: Date.now() - startedAt }, { status: 500 });
  }
});
