import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { productAdsEligibility } from '../../shared/productAdsEligibility.ts';

const SOURCE = 'runIntradaySalesRecovery';
const MIN_BID = 0.25;
const MAX_BID_STEP = 0.08;
const MAX_BUDGET_STEP = 0.10;
const MAX_ACTIONS = 10;
const FRESHNESS_MINUTES = 45;

const n = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const s = (value: unknown) => String(value || '').trim();
const low = (value: unknown) => s(value).toLowerCase();
const upper = (value: unknown) => s(value).toUpperCase();
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const active = (row: any) => ['enabled', 'active'].includes(low(row?.state || row?.status));
const campaignId = (row: any) => s(row?.amazon_campaign_id || row?.campaign_id || row?.id);
const brtDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(date);
const brtHour = (date = new Date()) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(date)) % 24;
const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

function median(values: number[]) {
  const sorted = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function resolveTargetMer(settings: any) {
  const raw = n(settings?.target_mer_pct || settings?.target_tacos || settings?.tacos_target, 5);
  return clamp(raw > 1 ? raw / 100 : raw, 0.01, 0.40);
}

function asinForCampaign(campaign: any, productAds: any[]) {
  const direct = upper(campaign?.asin || campaign?.advertised_asin);
  if (direct) return direct;
  const id = campaignId(campaign);
  const ad = productAds.find((row: any) => s(row?.campaign_id || row?.amazon_campaign_id) === id);
  return upper(ad?.asin);
}

function latestIntradayByCampaign(rows: any[]) {
  const sorted = [...rows].sort((a, b) => new Date(String(b.observed_at || b.updated_at || b.created_at || 0)).getTime() - new Date(String(a.observed_at || a.updated_at || a.created_at || 0)).getTime());
  const map = new Map<string, any>();
  for (const row of sorted) {
    const id = s(row.campaign_id || row.amazon_campaign_id);
    if (id && !map.has(id)) map.set(id, row);
  }
  return map;
}

Deno.serve(async (request) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    if (body._canonical_orchestrator !== 'runUnifiedDecisionEngine') {
      return Response.json({ ok: false, error: 'Uso exclusivo pelo motor canônico' }, { status: 403 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 20);

    const reports: any[] = [];
    for (const account of accounts) {
      const aid = String(account.id);
      const today = brtDate();
      const hour = brtHour();
      const cutoff14 = daysAgo(14);
      const [settingsRows, products, economics, campaigns, productAds, keywords, dailyMetrics, intradayRows, salesRows, decisions] = await Promise.all([
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.ProductAd.filter({ amazon_account_id: aid }, '-updated_at', 10000).catch(() => []),
        base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-updated_at', 20000).catch(() => []),
        base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 15000).catch(() => []),
        base44.asServiceRole.entities.IntradaySpendSnapshot.filter({ amazon_account_id: aid, spend_date: today }, '-observed_at', 10000).catch(() => []),
        base44.asServiceRole.entities.SalesDaily.filter({ amazon_account_id: aid }, '-date', 10000).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: aid }, '-created_at', 10000).catch(() => []),
      ]);

      const settings = settingsRows[0] || {};
      const targetAcos = Math.max(1, n(settings.target_acos || settings.acos_target, 15));
      const targetMer = resolveTargetMer(settings);
      const minCampaignBudget = Math.max(5, n(settings.minimum_campaign_budget, 5));
      const maxCampaignBudget = Math.max(minCampaignBudget, n(settings.maximum_campaign_budget, 100));
      const maxBid = Math.max(MIN_BID, n(settings.max_bid, 3));
      const productByAsin = new Map(products.filter((p: any) => p.asin).map((p: any) => [upper(p.asin), p]));
      const econByAsin = new Map(economics.filter((e: any) => e.asin).map((e: any) => [upper(e.asin), e]));
      const latestIntraday = latestIntradayByCampaign(intradayRows);

      const revenueByDate = new Map<string, number>();
      let revenueToday = 0;
      for (const row of salesRows) {
        const date = s(row.date || row.sale_date).slice(0, 10);
        if (!date) continue;
        const value = n(row.ordered_product_sales ?? row.revenue ?? row.sales ?? row.total_sales);
        revenueByDate.set(date, (revenueByDate.get(date) || 0) + value);
        if (date === today) revenueToday += value;
      }
      const closedDailyRevenue = [...revenueByDate.entries()]
        .filter(([date]) => date >= cutoff14 && date < today)
        .map(([, value]) => value)
        .filter((value) => value > 0);
      const baselineRevenue = median(closedDailyRevenue);
      const elapsedFraction = clamp((hour + new Date().getMinutes() / 60) / 24, 0, 1);
      const expectedFloor = baselineRevenue * elapsedFraction * 0.60;
      const revenueRatio = expectedFloor > 0 ? revenueToday / expectedFloor : 1;

      const currentCampaigns = campaigns.filter((campaign: any) => active(campaign) && upper(campaign.campaign_type || 'SP') === 'SP');
      let totalSpendToday = 0;
      const todayByCampaign = new Map<string, { spend: number; sales: number; orders: number; clicks: number }>();
      for (const campaign of currentCampaigns) {
        const id = campaignId(campaign);
        const snap = latestIntraday.get(id) || campaign;
        const row = {
          spend: n(snap.spend ?? snap.cost ?? campaign.current_spend ?? campaign.spend),
          sales: n(snap.sales ?? snap.attributed_sales ?? campaign.sales),
          orders: n(snap.orders ?? snap.purchases ?? campaign.orders),
          clicks: n(snap.clicks ?? campaign.clicks),
        };
        todayByCampaign.set(id, row);
        totalSpendToday += row.spend;
      }
      const tacos = revenueToday > 0 ? totalSpendToday / revenueToday : null;
      const recoveryActive = hour >= 10 && hour <= 21 && baselineRevenue > 0 && expectedFloor > 0 && revenueToday < expectedFloor && totalSpendToday > 0;
      const growthAllowed = recoveryActive && revenueToday > 0 && tacos !== null && tacos <= Math.max(0.20, targetMer * 4);

      const historicalByCampaign = new Map<string, { spend: number; sales: number; orders: number; clicks: number }>();
      for (const row of dailyMetrics) {
        const date = s(row.date).slice(0, 10);
        if (!date || date < cutoff14 || date >= today) continue;
        const id = s(row.campaign_id || row.amazon_campaign_id);
        if (!id) continue;
        const agg = historicalByCampaign.get(id) || { spend: 0, sales: 0, orders: 0, clicks: 0 };
        agg.spend += n(row.spend);
        agg.sales += n(row.sales);
        agg.orders += n(row.orders);
        agg.clicks += n(row.clicks);
        historicalByCampaign.set(id, agg);
      }

      const activeDecisionKeys = new Set(decisions
        .filter((d: any) => !['failed', 'failed_final', 'cancelled', 'expired', 'rejected', 'skipped', 'superseded'].includes(low(d.status)))
        .map((d: any) => s(d.idempotency_key)));
      const currentHourKey = `${today}T${String(hour).padStart(2, '0')}`;

      const losers: any[] = [];
      const winners: any[] = [];
      for (const campaign of currentCampaigns) {
        const id = campaignId(campaign);
        const asin = asinForCampaign(campaign, productAds);
        const product = productByAsin.get(asin);
        const eligibility = productAdsEligibility(product);
        if (!id || !asin || !eligibility.eligible) continue;
        const econ = econByAsin.get(asin) || {};
        const todayM = todayByCampaign.get(id) || { spend: 0, sales: 0, orders: 0, clicks: 0 };
        const hist = historicalByCampaign.get(id) || { spend: 0, sales: 0, orders: 0, clicks: 0 };
        const histAcos = hist.sales > 0 ? hist.spend / hist.sales * 100 : null;
        const todayAcos = todayM.sales > 0 ? todayM.spend / todayM.sales * 100 : null;
        const breakEvenAcos = Math.max(0, n(econ.break_even_acos ?? product?.break_even_acos_pct));
        const safeAcos = breakEvenAcos > 0 ? Math.min(targetAcos, breakEvenAcos * 0.75) : targetAcos;
        const profitAfterAds = n(econ.profit_after_ads ?? product?.profit_after_ads, 0);
        const budget = n(campaign.daily_budget || campaign.budget, 0);
        const drySpend = todayM.orders === 0 && todayM.spend >= Math.max(5, n(product?.maximum_ad_spend_per_order, 5));
        const inefficientToday = todayAcos !== null && todayAcos > Math.max(safeAcos * 1.5, safeAcos + 5);
        if (drySpend || inefficientToday) {
          losers.push({ campaign, id, asin, todayM, hist, histAcos, todayAcos, safeAcos, budget, product, econ });
          continue;
        }
        const proven = hist.orders >= 2 && hist.sales > hist.spend && histAcos !== null && histAcos <= safeAcos && profitAfterAds > 0;
        const convertingToday = todayM.orders > 0 && todayM.sales > 0 && (todayAcos === null || todayAcos <= safeAcos * 1.20);
        if (proven && (convertingToday || todayM.spend <= 2 || todayM.orders > 0)) {
          winners.push({ campaign, id, asin, todayM, hist, histAcos, todayAcos, safeAcos, budget, product, econ, convertingToday });
        }
      }

      losers.sort((a, b) => (b.todayM.spend - b.todayM.sales) - (a.todayM.spend - a.todayM.sales));
      winners.sort((a, b) => Number(b.convertingToday) - Number(a.convertingToday) || (b.hist.orders - a.hist.orders) || ((a.histAcos || 999) - (b.histAcos || 999)));

      const queued: any[] = [];
      let freedBudget = 0;
      if (recoveryActive && body.dry_run !== true) {
        for (const loser of losers.slice(0, 5)) {
          if (queued.length >= MAX_ACTIONS) break;
          if (loser.budget <= minCampaignBudget) continue;
          const reduction = loser.todayM.spend >= 10 ? 0.20 : 0.15;
          const targetBudget = round2(Math.max(minCampaignBudget, loser.budget * (1 - reduction)));
          if (targetBudget >= loser.budget - 0.01) continue;
          const key = `SALES_RECOVERY|${aid}|${loser.id}|REDUCE_BUDGET|${currentHourKey}|${targetBudget.toFixed(2)}`;
          if (activeDecisionKeys.has(key)) continue;
          const decision = await base44.asServiceRole.entities.OptimizationDecision.create({
            amazon_account_id: aid,
            decision_type: 'intraday_sales_recovery',
            entity_type: 'campaign',
            entity_id: loser.id,
            campaign_id: loser.id,
            campaign_name: loser.campaign.name || loser.campaign.campaign_name || null,
            asin: loser.asin,
            sku: loser.product?.sku || null,
            action: 'reduce_budget',
            canonical_action_type: 'CAMPAIGN_BUDGET_CHANGE',
            rationale: `Modo recuperação: campanha sem conversão econômica está consumindo capital num dia com receita abaixo da trajetória. Budget reduzido para liberar verba a campanhas comprovadas. Hoje: gasto R$ ${loser.todayM.spend.toFixed(2)}, pedidos ${loser.todayM.orders}, ACoS ${loser.todayAcos == null ? 'sem venda' : `${loser.todayAcos.toFixed(1)}%`}.`,
            rule_key: 'INTRADAY_SALES_RECOVERY_REALLOCATE_FROM_LOSER',
            reason_code: 'INTRADAY_SALES_RECOVERY_REALLOCATE_FROM_LOSER',
            value_before: loser.budget,
            value_after: targetBudget,
            confidence: 0.93,
            risk: 'medium',
            requires_approval: false,
            approval_status: 'auto_approved_deterministic',
            status: 'approved',
            queue_status: 'pending',
            priority_class: 'P1',
            execution_mode: 'EXECUTE_NOW',
            execute_before: new Date(Date.now() + FRESHNESS_MINUTES * 60000).toISOString(),
            requires_fresh_data: true,
            maximum_data_age_minutes: FRESHNESS_MINUTES,
            confirmation_required: true,
            confirmation_status: 'pending',
            idempotency_key: key,
            conflict_group: `${aid}|campaign|${loser.id}`,
            source_function: SOURCE,
            model_version: 'sales-recovery-v1',
            data_used: JSON.stringify({ revenue_today: revenueToday, expected_floor: expectedFloor, baseline_revenue: baselineRevenue, tacos, target_mer: targetMer, spend_today: totalSpendToday, campaign_spend: loser.todayM.spend, campaign_orders: loser.todayM.orders, campaign_sales: loser.todayM.sales }),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          freedBudget += loser.budget - targetBudget;
          queued.push({ decision_id: decision.id, action: 'reduce_budget', campaign_id: loser.id, asin: loser.asin, before: loser.budget, after: targetBudget });
        }

        if (growthAllowed && freedBudget > 0) {
          for (const winner of winners.slice(0, 5)) {
            if (queued.length >= MAX_ACTIONS) break;
            const activeKeywords = keywords.filter((keyword: any) => active(keyword) && s(keyword.campaign_id || keyword.amazon_campaign_id) === winner.id);
            const keywordCandidates = activeKeywords.filter((keyword: any) => {
              const orders = n(keyword.orders ?? keyword.purchases);
              const sales = n(keyword.sales);
              const spend = n(keyword.spend);
              const acos = sales > 0 ? spend / sales * 100 : null;
              return orders >= 1 && sales > spend && (acos == null || acos <= winner.safeAcos);
            }).sort((a: any, b: any) => n(b.orders ?? b.purchases) - n(a.orders ?? a.purchases));

            const keyword = keywordCandidates[0];
            if (keyword) {
              const keywordId = s(keyword.keyword_id || keyword.id);
              const currentBid = n(keyword.current_bid ?? keyword.bid);
              const step = winner.convertingToday ? MAX_BID_STEP : 0.05;
              const targetBid = round2(Math.min(maxBid, Math.max(MIN_BID, currentBid * (1 + step))));
              if (keywordId && currentBid > 0 && targetBid > currentBid + 0.009) {
                const key = `SALES_RECOVERY|${aid}|${keywordId}|INCREASE_BID|${currentHourKey}|${targetBid.toFixed(2)}`;
                if (!activeDecisionKeys.has(key)) {
                  const decision = await base44.asServiceRole.entities.OptimizationDecision.create({
                    amazon_account_id: aid,
                    decision_type: 'intraday_sales_recovery',
                    entity_type: 'keyword',
                    entity_id: keywordId,
                    keyword_id: keywordId,
                    keyword_text: keyword.keyword_text || keyword.keyword || null,
                    campaign_id: winner.id,
                    campaign_name: winner.campaign.name || winner.campaign.campaign_name || null,
                    ad_group_id: keyword.ad_group_id || null,
                    asin: winner.asin,
                    sku: winner.product?.sku || null,
                    action: 'increase_bid',
                    canonical_action_type: 'KEYWORD_BID_CHANGE',
                    rationale: `Modo recuperação: keyword comprovadamente conversora recebeu aumento controlado de ${(step * 100).toFixed(0)}% após verba ser retirada de campanhas improdutivas. Histórico 14d: ${winner.hist.orders} pedidos e ACoS ${winner.histAcos?.toFixed(1)}%; hoje ${winner.todayM.orders} pedido(s).`,
                    rule_key: 'INTRADAY_SALES_RECOVERY_PROMOTE_WINNER',
                    reason_code: 'INTRADAY_SALES_RECOVERY_PROMOTE_WINNER',
                    value_before: currentBid,
                    value_after: targetBid,
                    current_value: currentBid,
                    proposed_value: targetBid,
                    confidence: winner.convertingToday ? 0.94 : 0.86,
                    risk: 'low',
                    requires_approval: false,
                    approval_status: 'auto_approved_deterministic',
                    status: 'approved',
                    queue_status: 'pending',
                    priority_class: 'P1',
                    execution_mode: 'EXECUTE_NOW',
                    execute_before: new Date(Date.now() + FRESHNESS_MINUTES * 60000).toISOString(),
                    requires_fresh_data: true,
                    maximum_data_age_minutes: FRESHNESS_MINUTES,
                    confirmation_required: true,
                    confirmation_status: 'pending',
                    idempotency_key: key,
                    conflict_group: `${aid}|keyword|${keywordId}`,
                    source_function: SOURCE,
                    model_version: 'sales-recovery-v1',
                    target_acos: winner.safeAcos,
                    data_used: JSON.stringify({ revenue_today: revenueToday, expected_floor: expectedFloor, baseline_revenue: baselineRevenue, tacos, target_mer: targetMer, freed_budget: freedBudget, hist_orders: winner.hist.orders, hist_sales: winner.hist.sales, hist_spend: winner.hist.spend, hist_acos: winner.histAcos, today_orders: winner.todayM.orders }),
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                  });
                  queued.push({ decision_id: decision.id, action: 'increase_bid', campaign_id: winner.id, keyword_id: keywordId, asin: winner.asin, before: currentBid, after: targetBid });
                }
              }
            }

            if (queued.length >= MAX_ACTIONS || freedBudget <= 0 || winner.budget <= 0) continue;
            const nearBudgetLimit = winner.todayM.spend >= winner.budget * 0.75;
            if (!nearBudgetLimit) continue;
            const maxIncreaseByStep = winner.budget * MAX_BUDGET_STEP;
            const increase = Math.min(freedBudget, maxIncreaseByStep);
            if (increase < 0.50) continue;
            const targetBudget = round2(Math.min(maxCampaignBudget, winner.budget + increase));
            if (targetBudget <= winner.budget + 0.01) continue;
            const key = `SALES_RECOVERY|${aid}|${winner.id}|INCREASE_BUDGET|${currentHourKey}|${targetBudget.toFixed(2)}`;
            if (activeDecisionKeys.has(key)) continue;
            const decision = await base44.asServiceRole.entities.OptimizationDecision.create({
              amazon_account_id: aid,
              decision_type: 'intraday_sales_recovery',
              entity_type: 'campaign',
              entity_id: winner.id,
              campaign_id: winner.id,
              campaign_name: winner.campaign.name || winner.campaign.campaign_name || null,
              asin: winner.asin,
              sku: winner.product?.sku || null,
              action: 'increase_budget',
              canonical_action_type: 'CAMPAIGN_BUDGET_CHANGE',
              rationale: `Modo recuperação: budget transferido de campanhas improdutivas para campanha vencedora, sem aumentar o orçamento agregado planejado. Histórico 14d: ${winner.hist.orders} pedidos, ACoS ${winner.histAcos?.toFixed(1)}%.`,
              rule_key: 'INTRADAY_SALES_RECOVERY_TRANSFER_TO_WINNER',
              reason_code: 'INTRADAY_SALES_RECOVERY_TRANSFER_TO_WINNER',
              value_before: winner.budget,
              value_after: targetBudget,
              confidence: 0.91,
              risk: 'low',
              requires_approval: false,
              approval_status: 'auto_approved_deterministic',
              status: 'approved',
              queue_status: 'pending',
              priority_class: 'P1',
              execution_mode: 'EXECUTE_NOW',
              execute_before: new Date(Date.now() + FRESHNESS_MINUTES * 60000).toISOString(),
              requires_fresh_data: true,
              maximum_data_age_minutes: FRESHNESS_MINUTES,
              confirmation_required: true,
              confirmation_status: 'pending',
              idempotency_key: key,
              conflict_group: `${aid}|campaign|${winner.id}`,
              source_function: SOURCE,
              model_version: 'sales-recovery-v1',
              data_used: JSON.stringify({ freed_budget_before: freedBudget, transfer_amount: targetBudget - winner.budget, revenue_today: revenueToday, expected_floor: expectedFloor, tacos, hist_orders: winner.hist.orders, hist_acos: winner.histAcos }),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
            freedBudget = Math.max(0, freedBudget - (targetBudget - winner.budget));
            queued.push({ decision_id: decision.id, action: 'increase_budget', campaign_id: winner.id, asin: winner.asin, before: winner.budget, after: targetBudget });
          }
        }
      }

      let manualGrowth: any = { ok: true, skipped: true };
      if (growthAllowed && revenueRatio < 0.40 && body.dry_run !== true) {
        manualGrowth = await base44.asServiceRole.functions.invoke('runManualProfitableGrowthObjective', {
          amazon_account_id: aid,
          _service_role: true,
          dry_run: false,
          trigger_type: 'intraday_sales_recovery',
        }).then((result: any) => result?.data || result || { ok: true }).catch((error: any) => ({ ok: false, error: error?.message || String(error) }));
      }

      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: aid,
        sync_type: 'intraday_sales_recovery',
        status: 'completed',
        source_function: SOURCE,
        records_processed: currentCampaigns.length,
        records_imported: queued.length,
        message: recoveryActive
          ? `RECOVERY ativo: receita R$ ${round2(revenueToday)} vs piso R$ ${round2(expectedFloor)}; TACoS ${tacos == null ? 'n/a' : `${(tacos * 100).toFixed(1)}%`}; ${losers.length} perdedor(es), ${winners.length} vencedor(es), ${queued.length} decisão(ões).`
          : `RECOVERY inativo: receita R$ ${round2(revenueToday)}; piso R$ ${round2(expectedFloor)}; baseline mediana R$ ${round2(baselineRevenue)}.`,
        started_at: new Date(startedAt).toISOString(),
        completed_at: new Date().toISOString(),
      }).catch(() => null);

      reports.push({
        amazon_account_id: aid,
        date: today,
        hour_brt: hour,
        recovery_active: recoveryActive,
        growth_allowed: growthAllowed,
        revenue_today: round2(revenueToday),
        baseline_daily_revenue_median_14d: round2(baselineRevenue),
        expected_revenue_floor_now: round2(expectedFloor),
        revenue_ratio_to_floor: round2(revenueRatio),
        spend_today: round2(totalSpendToday),
        tacos: tacos == null ? null : round2(tacos * 100),
        target_tacos: round2(targetMer * 100),
        losers: losers.map((row) => ({ campaign_id: row.id, asin: row.asin, spend: round2(row.todayM.spend), orders: row.todayM.orders, sales: round2(row.todayM.sales), acos: row.todayAcos == null ? null : round2(row.todayAcos) })),
        winners: winners.map((row) => ({ campaign_id: row.id, asin: row.asin, orders_14d: row.hist.orders, acos_14d: row.histAcos == null ? null : round2(row.histAcos), orders_today: row.todayM.orders })),
        queued,
        manual_growth: manualGrowth,
        policy: {
          no_global_spend_increase: true,
          reallocate_from_losers_to_winners: true,
          bid_step_max_pct: MAX_BID_STEP * 100,
          budget_step_max_pct: MAX_BUDGET_STEP * 100,
          top_of_search_change: false,
          top_of_search_reason: 'Não alterar placement sem ação canônica validada no executor e evidência de conversão específica por placement.',
          amazon_confirmation_required: true,
        },
      });
    }

    return Response.json({ ok: true, engine: 'INTRADAY_SALES_RECOVERY_V1', reports, duration_ms: Date.now() - startedAt });
  } catch (error: any) {
    return Response.json({ ok: false, engine: 'INTRADAY_SALES_RECOVERY_V1', error: error?.message || String(error) }, { status: 500 });
  }
});
