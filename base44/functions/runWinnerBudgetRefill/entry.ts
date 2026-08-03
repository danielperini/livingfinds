/**
 * Reposição intradiária de orçamento para campanhas vencedoras.
 *
 * Uma campanha nunca recebe orçamento extra somente por ter gasto rápido.
 * Exige venda, ACoS dentro da meta, consumo de pelo menos 90% do orçamento,
 * métricas intradiárias confirmadas e saldo no teto diário da conta.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const MAX_REFILLS_PER_DAY = 2;
const MAX_REFILLS_PER_RUN = 10;
const MIN_REMAINING_ACCOUNT_BUDGET = 2;
const HISTORICAL_WINNER_DAYS = 14;

const brtDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const number = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const r2 = (value: number) => Math.round(value * 100) / 100;
const enabled = (campaign: any) => ['enabled', 'active'].includes(String(campaign?.state || campaign?.status || '').toLowerCase());

function brtDateOffset(daysAgo: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(date);
}

function buildHistoricalWinners(rows: any[], cutoff: string, today: string) {
  const daily = new Map<string, any>();
  for (const row of rows) {
    const date = String(row.date || '').slice(0, 10);
    const campaignId = String(row.campaign_id || row.amazon_campaign_id || '');
    if (!campaignId || !date || date < cutoff || date >= today) continue;
    const key = `${campaignId}|${date}`;
    const previous = daily.get(key);
    const updated = new Date(row.synced_at || row.updated_at || row.created_at || 0).getTime();
    const previousUpdated = new Date(previous?.synced_at || previous?.updated_at || previous?.created_at || 0).getTime();
    if (!previous || updated >= previousUpdated) daily.set(key, row);
  }
  const winners = new Map<string, any>();
  for (const row of daily.values()) {
    const campaignId = String(row.campaign_id || row.amazon_campaign_id || '');
    const entry = winners.get(campaignId) || { spend: 0, sales: 0, orders: 0, latest_date: '' };
    entry.spend += number(row.spend ?? row.cost, 0);
    entry.sales += number(row.sales ?? row.attributed_sales, 0);
    entry.orders += number(row.orders ?? row.purchases ?? row.attributed_conversions, 0);
    if (String(row.date || '') > entry.latest_date) entry.latest_date = String(row.date || '').slice(0, 10);
    winners.set(campaignId, entry);
  }
  return winners;
}

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
      const [performanceRows, controllerRows, campaigns, priorDecisions, historicalMetrics] = await Promise.all([
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.AccountDailySpendController.filter({ amazon_account_id: accountId, spend_date: today }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, null, 5000).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId, decision_type: 'winner_budget_refill' }, '-created_at', 5000).catch(() => []),
        base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: accountId }, '-date', 15000).catch(() => []),
      ]);
      const performance = performanceRows[0] || {};
      const controller = controllerRows[0] || null;
      const targetAcos = number(performance.target_acos, 15);
      // PerformanceSettings é a fonte canônica: o piso pode ser aplicado a
      // qualquer campanha ativa, mas vencedoras só crescem pelo incremento
      // explicitamente configurado — nunca pelo limite diário da conta.
      const minimumCampaignBudget = Math.max(5, number(performance.minimum_campaign_budget, 15));
      const budgetIncrement = Math.max(0.01, number(performance.campaign_budget_increment, 0.10));
      const maxBudget = Math.max(minimumCampaignBudget, number(performance.maximum_campaign_budget ?? performance.max_budget_per_campaign, 100));
      const remaining = number(controller?.remaining_spend, 0);
      const metricsFresh = ['fresh', 'available', 'complete'].includes(String(controller?.intraday_metrics_status || '').toLowerCase());
      const historicalWinners = buildHistoricalWinners(historicalMetrics, brtDateOffset(HISTORICAL_WINNER_DAYS), today);

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
        const historical = historicalWinners.get(campaignId) || { spend: 0, sales: 0, orders: 0, latest_date: '' };
        const historicalAcos = historical.sales > 0 ? historical.spend / historical.sales * 100 : Infinity;
        const intradayWinner = orders >= 1 && sales > 0 && acos > 0 && acos <= targetAcos;
        const historicalWinner = historical.orders >= 1 && historical.sales > 0 && historicalAcos > 0 && historicalAcos <= targetAcos;
        const exhausted = campaign.budget_exhausted === true || String(campaign.budget_status || '').toLowerCase() === 'exhausted' || (budget > 0 && spend >= budget * 0.90);
        return {
          campaign, campaignId, budget, spend, sales, orders, acos, exhausted,
          historical, historicalAcos, intradayWinner, historicalWinner,
          evidence: intradayWinner ? 'intraday' : historicalWinner ? `historical_${HISTORICAL_WINNER_DAYS}d` : null,
          refills: refillsByCampaign.get(campaignId) || 0,
        };
      }).filter((candidate: any) =>
        enabled(candidate.campaign) && candidate.campaignId && candidate.budget > 0 &&
        (candidate.intradayWinner || candidate.historicalWinner) &&
        candidate.exhausted && candidate.refills < MAX_REFILLS_PER_DAY,
      ).sort((a: any, b: any) => {
        const aProfit = a.intradayWinner ? a.sales - a.spend : a.historical.sales - a.historical.spend;
        const bProfit = b.intradayWinner ? b.sales - b.spend : b.historical.sales - b.historical.spend;
        return bProfit - aProfit;
      }).slice(0, MAX_REFILLS_PER_RUN);

      const applied: any[] = [];
      const skipped: any[] = [];
      let remainingForRefills = remaining;
      for (const candidate of candidates) {
        const newBudget = r2(candidate.budget < minimumCampaignBudget
          ? minimumCampaignBudget
          : Math.min(maxBudget, candidate.budget + budgetIncrement));
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
          rationale: `${candidate.intradayWinner
            ? `Vencedora intradiária: ACoS ${r2(candidate.acos)}% ≤ meta ${targetAcos}%, orçamento ${r2(candidate.spend / candidate.budget * 100)}% consumido, venda R$ ${r2(candidate.sales)}.`
            : `Vencedora histórica (${HISTORICAL_WINNER_DAYS}d): ACoS ${r2(candidate.historicalAcos)}% ≤ meta ${targetAcos}%, ${candidate.historical.orders} pedido(s), venda R$ ${r2(candidate.historical.sales)}; dia parcial sem conversão atribuída.`} Piso R$ ${minimumCampaignBudget}; incremento configurado R$ ${budgetIncrement}.`,
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
          reason: `Reposição de vencedora (${candidate.evidence}); ACoS ${r2(candidate.intradayWinner ? candidate.acos : candidate.historicalAcos)}%.`, applied_at: now, source: 'runWinnerBudgetRefill', created_at: now,
        }).catch(() => {});
        applied.push({ campaign_id: candidate.campaignId, from: candidate.budget, to: newBudget, evidence: candidate.evidence, acos: r2(candidate.intradayWinner ? candidate.acos : candidate.historicalAcos), sales: candidate.intradayWinner ? candidate.sales : candidate.historical.sales });
        // O saldo global protege gasto real; não representa a soma de budgets
        // nominais. Só reserva o incremento quando a Amazon o confirma.
        remainingForRefills = r2(Math.max(0, remainingForRefills - Math.max(0, newBudget - candidate.budget)));
      }
      results.push({ account_id: accountId, ok: true, candidates: candidates.length, applied, skipped, remaining_account_budget: remainingForRefills });
    }
    return Response.json({ ok: true, engine: 'winner-budget-refill-v2', results, duration_ms: Date.now() - startedAt });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha na reposição intradiária de orçamento', duration_ms: Date.now() - startedAt }, { status: 500 });
  }
});
