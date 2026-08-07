import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const MIN_BID = 0.25;
const MAX_ACTIONS = 20;
const FRESHNESS_MINUTES = 45;
const DEFAULT_TARGET_ACOS = 15;
const DEFAULT_TARGET_MER = 0.05;
const Z95 = 1.645;

const n = (v: unknown, f = 0) => Number.isFinite(Number(v)) ? Number(v) : f;
const s = (v: unknown) => String(v || '').trim();
const low = (v: unknown) => s(v).toLowerCase();
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
const bid = (v: number) => Math.max(MIN_BID, r2(v));
const enabled = (row: any) => ['enabled', 'active'].includes(low(row?.state || row?.status));
const todayBrt = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const daysAgo = (d: number) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
const ageMin = (v: unknown) => {
  const ts = new Date(String(v || 0)).getTime();
  return Number.isFinite(ts) ? Math.max(0, (Date.now() - ts) / 60000) : Infinity;
};

function targetMer(settings: any, body: any) {
  const raw = n(body.target_mer_pct || settings?.target_mer_pct || settings?.target_tacos || settings?.tacos_target, 0);
  if (!raw) return DEFAULT_TARGET_MER;
  return clamp(raw > 1 ? raw / 100 : raw, 0.005, 0.50);
}

function abc(rows: Array<{ asin: string; value: number }>) {
  const sorted = rows.filter(x => x.asin && x.value > 0).sort((a, b) => b.value - a.value);
  const total = sorted.reduce((sum, x) => sum + x.value, 0);
  const out = new Map<string, string>();
  if (!total) return out;
  let cum = 0;
  for (const row of sorted) {
    cum += row.value;
    const share = cum / total;
    out.set(row.asin, share <= 0.80 ? 'A' : share <= 0.95 ? 'B' : 'C');
  }
  return out;
}

function state(salesCurve: string, profitCurve: string) {
  const map: Record<string, string> = {
    AA: 'CORE_WINNER', AB: 'CORE', AC: 'REVENUE_TRAP',
    BA: 'GROWTH_OPPORTUNITY', BB: 'GROWTH', BC: 'DEFENSIVE',
    CA: 'NICHE_WINNER', CB: 'TEST', CC: 'LOW_PRIORITY',
  };
  return map[`${salesCurve || 'C'}${profitCurve || 'C'}`] || 'LOW_PRIORITY';
}

function riskFactor(x: string) {
  const map: Record<string, number> = {
    CORE_WINNER: 1.00, CORE: 0.90, GROWTH_OPPORTUNITY: 0.90, GROWTH: 0.75,
    NICHE_WINNER: 0.70, TEST: 0.50, DEFENSIVE: 0.35, REVENUE_TRAP: 0.25, LOW_PRIORITY: 0.20,
  };
  return map[x] ?? 0.35;
}

function priority(x: string) {
  const map: Record<string, number> = {
    LOW_PRIORITY: 9, REVENUE_TRAP: 8, DEFENSIVE: 7, TEST: 6, GROWTH: 5,
    CORE: 4, GROWTH_OPPORTUNITY: 3, NICHE_WINNER: 2, CORE_WINNER: 1,
  };
  return map[x] ?? 5;
}

function posterior(priorClicks: number, priorOrders: number, clicks: number, orders: number, fallbackCvr: number) {
  const pc = Math.max(0, priorClicks);
  const po = clamp(priorOrders, 0, pc);
  const histCvr = pc > 0 ? po / pc : clamp(fallbackCvr, 0.005, 0.50);
  const strength = clamp(pc, 8, 30);
  const a = 1 + histCvr * strength + Math.max(0, orders);
  const b = 1 + (1 - histCvr) * strength + Math.max(0, clicks - orders);
  const mean = a / (a + b);
  const variance = (a * b) / (Math.pow(a + b, 2) * (a + b + 1));
  const sd = Math.sqrt(Math.max(variance, 0));
  return { mean, sd, low95: clamp(mean - Z95 * sd, 0, 1) };
}

function normalCdf(z: number) {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = sign * (1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
  return clamp(0.5 * (1 + erf), 0, 1);
}

function reduction(lossRatio: number, curveState: string, merPressure: boolean) {
  let pct = priority(curveState) >= 8 ? 0.35 : priority(curveState) >= 6 ? 0.30 : priority(curveState) >= 4 ? 0.25 : 0.20;
  if (lossRatio >= 2.5) pct = 0.60;
  else if (lossRatio >= 1.75) pct = Math.max(pct, 0.45);
  else if (lossRatio >= 1.25) pct = Math.max(pct, 0.35);
  if (merPressure) pct = Math.min(0.60, pct + 0.05);
  return pct;
}

Deno.serve(async (request) => {
  const started = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, null, 100);

    const results: any[] = [];
    for (const account of accounts) {
      const accountId = account.id;
      const today = todayBrt();
      const cutoff30 = daysAgo(30);
      const [settingsRows, products, economics, salesRows, intraday, terms, keywords, campaigns, decisions] = await Promise.all([
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.SalesDaily.filter({ amazon_account_id: accountId }, '-date', 10000).catch(() => []),
        base44.asServiceRole.entities.IntradaySpendSnapshot.filter({ amazon_account_id: accountId, spend_date: today }, '-observed_at', 10000).catch(() => []),
        base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: accountId }, '-updated_date', 10000).catch(() => []),
        base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-updated_at', 20000).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-created_at', 5000).catch(() => []),
      ]);

      const settings = settingsRows[0] || {};
      const accountTargetAcos = Math.max(1, n(settings.target_acos ?? settings.acos_target, DEFAULT_TARGET_ACOS));
      const merTarget = targetMer(settings, body);
      const productByAsin = new Map(products.filter((p: any) => s(p.asin)).map((p: any) => [s(p.asin).toUpperCase(), p]));
      const econByAsin = new Map(economics.filter((e: any) => s(e.asin)).map((e: any) => [s(e.asin).toUpperCase(), e]));
      const campaignById = new Map(campaigns.map((c: any) => [s(c.campaign_id || c.amazon_campaign_id || c.id), c]));

      const revenue30 = new Map<string, number>();
      const revenueToday = new Map<string, number>();
      for (const row of salesRows) {
        const asin = s(row.asin).toUpperCase();
        const date = s(row.date || row.sale_date).slice(0, 10);
        if (!asin || !date) continue;
        const revenue = n(row.ordered_product_sales ?? row.revenue ?? row.sales ?? row.total_sales);
        if (date >= cutoff30 && date <= today) revenue30.set(asin, (revenue30.get(asin) || 0) + revenue);
        if (date === today) revenueToday.set(asin, (revenueToday.get(asin) || 0) + revenue);
      }

      const salesRows30: Array<{ asin: string; value: number }> = [];
      const profitRows: Array<{ asin: string; value: number }> = [];
      for (const p of products) {
        const asin = s(p.asin).toUpperCase();
        if (!asin) continue;
        const econ = econByAsin.get(asin);
        salesRows30.push({ asin, value: Math.max(0, revenue30.get(asin) || n(p.total_sales_30d)) });
        const windowProfit = n(econ?.profit_after_ads_14d, NaN);
        const unitProfit = n(econ?.profit_after_ads ?? p.profit_after_ads, 0);
        const profit = Number.isFinite(windowProfit) && windowProfit !== 0 ? windowProfit : unitProfit * Math.max(0, n(p.total_units_30d));
        profitRows.push({ asin, value: Math.max(0, profit) });
      }

      const salesCurve = abc(salesRows30);
      const profitCurve = abc(profitRows);

      const latestCampaign = new Map<string, any>();
      for (const row of [...intraday].sort((a: any, b: any) => new Date(String(b.observed_at || b.updated_at || 0)).getTime() - new Date(String(a.observed_at || a.updated_at || 0)).getTime())) {
        const id = s(row.campaign_id || row.amazon_campaign_id);
        if (id && !latestCampaign.has(id) && ageMin(row.observed_at || row.updated_at || row.created_at) <= FRESHNESS_MINUTES) latestCampaign.set(id, row);
      }
      const totalSpend = [...latestCampaign.values()].reduce((sum, row) => sum + n(row.spend ?? row.cost), 0);
      const totalRevenue = [...revenueToday.values()].reduce((sum, value) => sum + value, 0);
      const mer = totalSpend > 0 && totalRevenue > 0 ? totalSpend / totalRevenue : null;
      const merOver = mer !== null && mer > merTarget;
      const merFactor = merOver ? clamp(merTarget / mer!, 0.50, 1.00) : 1.00;

      const activeKeys = new Set(decisions
        .filter((d: any) => !['failed', 'failed_final', 'cancelled', 'expired', 'superseded', 'rolled_back'].includes(low(d.status)))
        .map((d: any) => s(d.idempotency_key)));
      const activeKeywords = keywords.filter(enabled);
      const candidates: any[] = [];

      for (const term of terms) {
        const rowDate = s(term.date || term.report_date || term.metric_date || term.start_date).slice(0, 10);
        const updated = term.updated_at || term.updated_date || term.synced_at || term.created_at;
        if (rowDate && rowDate !== today) continue;
        if (!rowDate && ageMin(updated) > FRESHNESS_MINUTES) continue;

        const campaignId = s(term.campaign_id || term.amazon_campaign_id);
        const campaign = campaignById.get(campaignId);
        if (!campaign || !enabled(campaign)) continue;
        const asin = s(term.asin || campaign.asin).toUpperCase();
        const product = productByAsin.get(asin);
        const econ = econByAsin.get(asin);
        if (!asin || !product) continue;
        const stock = n(product.fba_inventory ?? product.available_quantity ?? product.fulfillable_quantity, 0);
        if (stock <= 0 || product.listing_buyable === false || product.listing_suppressed === true) continue;

        const spend = n(term.spend);
        const adsSales = n(term.sales_14d ?? term.sales);
        const orders = n(term.orders_14d ?? term.orders);
        const clicks = n(term.clicks);
        if (spend <= 0 || clicks <= 0) continue;
        const cpc = spend / clicks;

        const kwText = s(term.keyword_text || term.keyword || term.search_term).toLocaleLowerCase('pt-BR');
        const kwId = s(term.keyword_id || term.amazon_keyword_id);
        const keyword = activeKeywords.find((k: any) =>
          (kwId && s(k.keyword_id || k.id) === kwId) ||
          (s(k.campaign_id) === campaignId && s(k.ad_group_id) === s(term.ad_group_id) && s(k.keyword_text || k.keyword).toLocaleLowerCase('pt-BR') === kwText)
        );
        if (!keyword) continue;
        const currentBid = n(keyword.current_bid ?? keyword.bid ?? term.bid);
        if (currentBid <= MIN_BID) continue;

        const salesClass = salesCurve.get(asin) || 'C';
        const profitClass = profitCurve.get(asin) || 'C';
        const curveState = state(salesClass, profitClass);
        const breakEven = Math.max(0, n(econ?.break_even_acos ?? product.break_even_acos_pct));
        const targetAcos = Math.max(1, n(econ?.target_acos, accountTargetAcos));
        const safeAcos = breakEven > 0 ? Math.min(targetAcos, breakEven * 0.75) : targetAcos;
        const margin = Math.max(0, n(econ?.contribution_margin_amount ?? econ?.profit_before_ads ?? product.available_profit_per_sale ?? product.contribution_margin));
        const maxSpend = Math.max(0, n(econ?.maximum_profitable_ad_spend ?? product.maximum_ad_spend_per_order, margin));
        const econComplete = low(econ?.economics_status) === 'complete' || econ?.economic_data_complete === true || product.cost_confirmed === true;
        const noCapacity = econComplete && margin <= 0 && maxSpend <= 0;

        const baseLoss = noCapacity ? MIN_BID : clamp((maxSpend || margin || 5) * 0.25, 2.50, 15.00);
        const lossBudget = r2(Math.max(MIN_BID, baseLoss * riskFactor(curveState) * merFactor));
        const allowedSpend = adsSales * safeAcos / 100;
        const loss = Math.max(0, spend - allowedSpend);
        const nextLoss = loss + Math.max(cpc, MIN_BID);
        const lossRatio = lossBudget > 0 ? nextLoss / lossBudget : Infinity;

        const ticket = Math.max(0, n(econ?.average_sale_price ?? econ?.current_price ?? product.price));
        const safeAcosFraction = safeAcos / 100;
        const targetCvr = ticket > 0 && safeAcosFraction > 0 ? clamp(cpc / (ticket * safeAcosFraction), 0.001, 0.95) : 0;
        const statCeiling = targetCvr > 0 && targetCvr < 1 ? Math.ceil(Math.log(0.05) / Math.log(1 - targetCvr)) : Infinity;
        const economicCeiling = cpc > 0 ? Math.max(2, Math.floor(lossBudget / cpc)) : Infinity;
        const dryClickCeiling = Math.max(2, Math.min(statCeiling, economicCeiling));

        const priorClicks = Math.max(0, n(keyword.clicks));
        const priorOrders = Math.max(0, n(keyword.orders ?? keyword.purchases));
        const rawProductCvr = n(product.conversion_rate_30d, 5);
        const fallbackCvr = rawProductCvr > 1 ? rawProductCvr / 100 : rawProductCvr || 0.05;
        const post = posterior(priorClicks, priorOrders, clicks, orders, fallbackCvr);
        const pBelow = post.sd > 0 && targetCvr > 0 ? normalCdf((targetCvr - post.mean) / post.sd) : 0;
        const safeCpc = ticket > 0 ? post.low95 * ticket * safeAcosFraction : 0;
        const currentAcos = adsSales > 0 ? spend / adsSales * 100 : null;

        const winner = keyword.protected_high_performance === true ||
          (orders > 0 && adsSales > 0 && currentAcos !== null && currentAcos <= safeAcos && curveState === 'CORE_WINNER');
        if (winner) continue;

        const economicTrigger = nextLoss >= lossBudget;
        const sequentialTrigger = orders === 0 && Number.isFinite(dryClickCeiling) && clicks >= dryClickCeiling;
        const bayesTrigger = clicks >= 4 && targetCvr > 0 && pBelow >= 0.80 && safeCpc > 0 && currentBid > safeCpc;
        const merCurveTrigger = merOver && priority(curveState) >= 7 && loss > 0;
        if (!economicTrigger && !sequentialTrigger && !bayesTrigger && !merCurveTrigger && !noCapacity) continue;

        const pct = reduction(lossRatio, curveState, merOver);
        const proposed = bid(Math.max(currentBid * 0.40, Math.min(currentBid * (1 - pct), safeCpc > 0 ? safeCpc : currentBid)));
        if (proposed >= currentBid) continue;
        const entityId = s(keyword.keyword_id || keyword.id);
        const key = `economic-curve-guard:${accountId}:${entityId}:${today}:${proposed.toFixed(2)}`;
        if (!entityId || activeKeys.has(key)) continue;

        const reasonCode = noCapacity ? 'ASIN_NO_AD_CAPACITY'
          : economicTrigger ? 'ASIN_DYNAMIC_LOSS_BUDGET'
          : sequentialTrigger ? 'SEQUENTIAL_DRY_CLICK_CEILING'
          : bayesTrigger ? 'BAYESIAN_CVR_DETERIORATION'
          : 'ACCOUNT_MER_CURVE_PRESSURE';

        candidates.push({
          score: priority(curveState) * 100 + Math.min(99, lossRatio * 10) + (merOver ? 20 : 0),
          campaign, keyword, term, campaignId, asin, entityId, currentBid, proposed, pct, spend, adsSales, orders, clicks, cpc,
          salesClass, profitClass, curveState, safeAcos, breakEven, margin, maxSpend, lossBudget, loss, nextLoss,
          post, pBelow, safeCpc, currentAcos, reasonCode, key,
        });
      }

      candidates.sort((a, b) => b.score - a.score || b.loss - a.loss);
      let created = 0;
      for (const item of candidates.slice(0, Math.min(MAX_ACTIONS, Math.max(1, n(body.max_actions, MAX_ACTIONS))))) {
        const rationale = `Guardrail econômico ABC: ASIN ${item.asin} vendas ${item.salesClass}/lucro ${item.profitClass} (${item.curveState}); loss budget R$ ${item.lossBudget.toFixed(2)}, perda R$ ${item.loss.toFixed(2)}, próximo clique R$ ${item.nextLoss.toFixed(2)}; ACoS seguro ${item.safeAcos.toFixed(2)}%; CVR posterior ${(item.post.mean * 100).toFixed(2)}%, limite inferior ${(item.post.low95 * 100).toFixed(2)}%, CPC seguro R$ ${item.safeCpc.toFixed(2)}; MER/TACoS ${mer === null ? 'indisponível' : `${(mer * 100).toFixed(2)}%`} vs meta ${(merTarget * 100).toFixed(2)}%.`;
        await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id: accountId,
          entity_type: 'keyword',
          entity_id: item.entityId,
          keyword_id: item.entityId,
          keyword_text: s(item.keyword.keyword_text || item.keyword.keyword || item.term.search_term),
          campaign_id: item.campaignId,
          campaign_name: s(item.campaign.name || item.campaign.campaign_name),
          ad_group_id: s(item.keyword.ad_group_id || item.term.ad_group_id),
          asin: item.asin,
          sku: s(item.keyword.sku || item.term.sku || productByAsin.get(item.asin)?.sku),
          action: 'reduce_bid',
          decision_type: 'economic_curve_ads_guard',
          rationale,
          reason_code: item.reasonCode,
          current_value: item.currentBid,
          proposed_value: item.proposed,
          value_before: item.currentBid,
          value_after: item.proposed,
          change_pct: -Math.round(item.pct * 100),
          confidence: clamp(0.70 + Math.min(0.25, item.pBelow * 0.25), 0, 0.99),
          risk: item.curveState === 'CORE_WINNER' ? 'medium' : priority(item.curveState) >= 7 ? 'critical' : 'high',
          requires_approval: false,
          status: body.dry_run === true ? 'proposed' : 'approved',
          queue_status: body.dry_run === true ? 'not_queued' : 'pending',
          execution_mode: 'EXECUTE_NOW',
          priority_class: 'P1',
          requires_fresh_data: true,
          maximum_data_age_minutes: FRESHNESS_MINUTES,
          confirmation_required: true,
          confirmation_status: 'pending',
          conflict_group: `keyword_bid:${accountId}:${item.entityId}`,
          idempotency_key: item.key,
          source_function: 'runEconomicCurveAdsGuard',
          model_version: 'economic-curve-bayes-v1',
          economic_state: item.curveState,
          intervention_state: item.reasonCode,
          current_cpc: r2(item.cpc),
          maximum_economic_cpc: r2(item.safeCpc),
          safe_cpc: r2(item.safeCpc),
          current_acos: item.currentAcos == null ? undefined : r2(item.currentAcos),
          target_acos: r2(item.safeAcos),
          expected_clicks_per_order: item.post.mean > 0 ? r2(1 / item.post.mean) : undefined,
          no_conversion_click_multiple: item.orders === 0 && item.post.mean > 0 ? r2(item.clicks / (1 / item.post.mean)) : 0,
          maximum_acquisition_spend: r2(item.maxSpend || item.margin),
          contribution_margin_per_order: r2(item.margin),
          posterior_cvr: item.post.mean,
          posterior_cvr_low_95: item.post.low95,
          probability_below_sustainable: item.pBelow,
          raw_clicks: item.clicks,
          evaluated_at: new Date().toISOString(),
          max_attempts: 3,
          attempt_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        created++;
      }

      results.push({
        account_id: accountId,
        date: today,
        target_acos: accountTargetAcos,
        target_mer: merTarget,
        mer,
        mer_over_target: merOver,
        total_spend_today: r2(totalSpend),
        total_revenue_today: r2(totalRevenue),
        evaluated_terms: terms.length,
        eligible_actions: candidates.length,
        decisions_created: created,
        dry_run: body.dry_run === true,
      });
    }

    return Response.json({
      ok: true,
      engine: 'economic-curve-ads-guard-v1',
      policy: {
        sales_curve: 'ABC 80/15/5 por faturamento real 30d',
        profit_curve: 'ABC 80/15/5 por lucro pós-Ads disponível',
        dynamic_loss_budget: true,
        sequential_zero_sale_ceiling: true,
        bayesian_cvr_guard: true,
        mer_tacos_guardrail: true,
        protects_core_winners: true,
        never_increases_bid: true,
        execution: 'OptimizationDecision EXECUTE_NOW P1',
        amazon_confirmation_required: true,
      },
      results,
      duration_ms: Date.now() - started,
    });
  } catch (error: any) {
    return Response.json({ ok: false, engine: 'economic-curve-ads-guard-v1', error: error?.message || 'Falha no guardrail econômico ABC/MER' }, { status: 500 });
  }
});
