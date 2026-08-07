import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const DEFAULT_TARGET_MER = 0.05;
const MIN_BID = 0.25;
const MAX_ACTIONS = 10;
const FRESHNESS_MINUTES = 45;
const WILSON_Z_95 = 1.959963984540054;
const MIN_ECONOMIC_CLICKS = 10;

const n = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const text = (value: unknown) => String(value || '').trim();
const lower = (value: unknown) => text(value).toLowerCase();
const enabled = (row: any) => ['enabled', 'active'].includes(lower(row?.state || row?.status));
const roundBid = (value: number) => Math.max(MIN_BID, Math.round(value * 100) / 100);
const floorBid = (value: number) => Math.max(MIN_BID, Math.floor(value * 100) / 100);
const brtDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const ageMinutes = (value: unknown) => {
  const ts = new Date(String(value || 0)).getTime();
  return Number.isFinite(ts) ? Math.max(0, (Date.now() - ts) / 60000) : Infinity;
};

function latestByCampaign(rows: any[]) {
  const out = new Map<string, any>();
  for (const row of [...rows].sort((a, b) => new Date(String(b.observed_at || b.updated_at || 0)).getTime() - new Date(String(a.observed_at || a.updated_at || 0)).getTime())) {
    const id = text(row.campaign_id || row.amazon_campaign_id);
    if (id && !out.has(id)) out.set(id, row);
  }
  return out;
}

function resolveTargetMer(settings: any, body: any) {
  const direct = n(body.target_mer_pct, 0);
  if (direct > 0) return Math.min(0.5, direct > 1 ? direct / 100 : direct);
  const configured = n(settings?.target_mer_pct ?? settings?.target_tacos ?? settings?.tacos_target, 0);
  if (configured > 0) return Math.min(0.5, configured > 1 ? configured / 100 : configured);
  return DEFAULT_TARGET_MER;
}

function resolveTargetAcos(settings: any) {
  const configured = n(settings?.target_acos ?? settings?.acos_target, 15);
  if (configured <= 0) return 15;
  return configured <= 1 ? configured * 100 : configured;
}

function wilsonInterval(successesValue: unknown, trialsValue: unknown) {
  const trials = Math.max(0, Math.floor(n(trialsValue)));
  const successes = Math.min(trials, Math.max(0, Math.floor(n(successesValue))));
  if (trials <= 0) return { lower: 0, upper: 1, observed: 0, trials: 0, successes: 0 };

  const observed = successes / trials;
  const z2 = WILSON_Z_95 * WILSON_Z_95;
  const denominator = 1 + z2 / trials;
  const center = observed + z2 / (2 * trials);
  const margin = WILSON_Z_95 * Math.sqrt((observed * (1 - observed) + z2 / (4 * trials)) / trials);
  return {
    lower: Math.max(0, (center - margin) / denominator),
    upper: Math.min(1, (center + margin) / denominator),
    observed,
    trials,
    successes,
  };
}

function confidenceFromWilson(interval: ReturnType<typeof wilsonInterval>) {
  if (interval.trials <= 0) return 0;
  return Math.max(0.01, Math.min(0.99, 1 - (interval.upper - interval.lower)));
}

Deno.serve(async (request) => {
  const startedAt = Date.now();
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
      const today = brtDate();
      const [settingsRows, salesRows, intradayRows, campaigns, keywords, targets, adGroups, products, priorDecisions] = await Promise.all([
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.SalesDaily.filter({ amazon_account_id: accountId }, '-date', 5000).catch(() => []),
        base44.asServiceRole.entities.IntradaySpendSnapshot.filter({ amazon_account_id: accountId, spend_date: today }, '-observed_at', 10000).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-updated_at', 20000).catch(() => []),
        base44.asServiceRole.entities.ProductTarget.filter({ amazon_account_id: accountId }, '-updated_at', 10000).catch(() => []),
        base44.asServiceRole.entities.AdGroup.filter({ amazon_account_id: accountId }, '-updated_at', 10000).catch(() => []),
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-created_at', 3000).catch(() => []),
      ]);

      const settings = settingsRows[0] || {};
      const targetMer = resolveTargetMer(settings, body);
      const targetAcos = resolveTargetAcos(settings);
      const revenueRows = salesRows.filter((row: any) => text(row.date || row.sale_date).slice(0, 10) === today);
      const totalRevenue = revenueRows.reduce((sum: number, row: any) => sum + n(row.revenue ?? row.sales ?? row.ordered_product_sales ?? row.total_sales), 0);
      const latest = latestByCampaign(intradayRows);
      const campaignMetrics = [...latest.values()].filter((row: any) => ageMinutes(row.observed_at || row.updated_at || row.created_at) <= FRESHNESS_MINUTES);
      const totalSpend = campaignMetrics.reduce((sum: number, row: any) => sum + n(row.spend ?? row.cost), 0);
      const dataValid = totalRevenue > 0 && campaignMetrics.length > 0;
      const mer = dataValid ? totalSpend / totalRevenue : null;
      const overTarget = mer !== null && mer > targetMer;
      const excessSpend = overTarget ? Math.max(0, totalSpend - totalRevenue * targetMer) : 0;

      if (!overTarget) {
        results.push({ account_id: accountId, date: today, target_mer: targetMer, mer, total_spend: totalSpend, total_revenue: totalRevenue, data_valid: dataValid, actions_created: 0, status: dataValid ? 'within_target' : 'insufficient_real_data' });
        continue;
      }

      const productByAsin = new Map(products.map((p: any) => [text(p.asin).toUpperCase(), p]));
      const campaignById = new Map(campaigns.map((c: any) => [text(c.campaign_id || c.amazon_campaign_id || c.id), c]));
      const activeKeys = new Set(priorDecisions.filter((d: any) => !['failed', 'cancelled', 'rejected', 'expired'].includes(lower(d.status))).map((d: any) => text(d.idempotency_key)));

      const candidates: any[] = [];
      for (const metric of campaignMetrics) {
        const campaignId = text(metric.campaign_id || metric.amazon_campaign_id);
        const campaign = campaignById.get(campaignId);
        if (!campaign || !enabled(campaign)) continue;
        const spend = n(metric.spend ?? metric.cost);
        const sales = n(metric.sales ?? metric.sales14d);
        const orders = n(metric.orders ?? metric.purchases ?? metric.purchases14d);
        const clicks = n(metric.clicks);
        if (spend <= 0) continue;
        const acos = sales > 0 ? spend / sales * 100 : null;
        const protectedWinner = orders > 0 && sales > 0 && acos !== null && acos <= targetAcos;
        if (protectedWinner) continue;

        const asin = text(campaign.asin || metric.asin).toUpperCase();
        const product = productByAsin.get(asin);
        const stock = n(product?.fba_inventory ?? product?.available_quantity ?? product?.fulfillable_quantity, -1);
        if (stock === 0) continue;

        const campaignKeywords = keywords.filter((k: any) => text(k.campaign_id) === campaignId && enabled(k));
        const campaignTargets = targets.filter((t: any) => text(t.campaign_id) === campaignId && enabled(t));
        const campaignGroups = adGroups.filter((g: any) => text(g.campaign_id) === campaignId && enabled(g));
        let entity: any = null;
        if (campaignKeywords.length) entity = [...campaignKeywords].sort((a, b) => n(b.spend) - n(a.spend))[0];
        else if (campaignTargets.length) entity = [...campaignTargets].sort((a, b) => n(b.spend) - n(a.spend))[0];
        else if (campaignGroups.length) entity = campaignGroups[0];
        if (!entity) continue;

        const entityType = campaignKeywords.includes(entity) ? 'keyword' : campaignTargets.includes(entity) ? 'product_target' : 'ad_group';
        const entityId = text(entity.keyword_id || entity.target_id || entity.ad_group_id || entity.id);
        const currentBid = n(entity.current_bid ?? entity.bid ?? entity.default_bid);
        if (!entityId || currentBid <= MIN_BID) continue;

        const severity = Math.min(2, mer! / targetMer);
        const reduction = severity >= 1.6 ? 0.20 : severity >= 1.3 ? 0.15 : 0.10;
        const severityBid = roundBid(currentBid * (1 - reduction));

        const wilson = wilsonInterval(orders, clicks);
        const confidence = confidenceFromWilson(wilson);
        const averageOrderValue = orders > 0 && sales > 0 ? sales / orders : null;
        const economicSampleValid = clicks >= MIN_ECONOMIC_CLICKS && orders > 0 && averageOrderValue !== null;
        const economicBidCeiling = economicSampleValid
          ? averageOrderValue! * (targetAcos / 100) * wilson.lower
          : null;
        const nextBid = economicBidCeiling !== null
          ? floorBid(Math.min(severityBid, economicBidCeiling))
          : severityBid;
        if (nextBid >= currentBid) continue;

        const effectiveReduction = Math.max(0, 1 - nextBid / currentBid);
        const key = `blended-mer:${accountId}:${entityType}:${entityId}:${today}:${nextBid.toFixed(2)}`;
        if (activeKeys.has(key)) continue;
        candidates.push({
          campaign, campaignId, metric, entity, entityType, entityId, currentBid, nextBid,
          reduction, effectiveReduction, spend, sales, orders, clicks, acos, key, asin,
          wilson, confidence, averageOrderValue, economicSampleValid, economicBidCeiling,
        });
      }

      candidates.sort((a, b) => (b.sales > 0 ? b.spend / b.sales : b.spend * 100) - (a.sales > 0 ? a.spend / a.sales : a.spend * 100));
      let created = 0;
      for (const item of candidates.slice(0, Math.min(MAX_ACTIONS, n(body.max_actions, MAX_ACTIONS)))) {
        const economicNote = item.economicBidCeiling !== null
          ? ` Teto econômico conservador R$ ${item.economicBidCeiling.toFixed(2)} calculado com CVR Wilson 95% inferior ${(item.wilson.lower * 100).toFixed(2)}% e ACoS alvo ${targetAcos.toFixed(2)}%.`
          : ` Teto econômico não aplicado por amostra insuficiente; mantida somente a redução determinística por MER.`;
        const rationale = `Guardrail blended: gasto Ads R$ ${totalSpend.toFixed(2)} / receita total Amazon R$ ${totalRevenue.toFixed(2)} = MER/TACoS ${(mer! * 100).toFixed(2)}%, acima da meta ${(targetMer * 100).toFixed(2)}%. Bid reduzido ${(item.effectiveReduction * 100).toFixed(0)}% em entidade não protegida.${economicNote}`;
        await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id: accountId,
          entity_type: item.entityType,
          entity_id: item.entityId,
          keyword_id: item.entityType === 'keyword' ? item.entityId : null,
          target_id: item.entityType === 'product_target' ? item.entityId : null,
          ad_group_id: text(item.entity.ad_group_id),
          campaign_id: item.campaignId,
          campaign_name: text(item.campaign.name || item.campaign.campaign_name),
          asin: item.asin || null,
          action: 'reduce_bid',
          canonical_action_type: 'BID_CHANGE',
          decision_type: 'blended_mer_guardrail',
          value_before: item.currentBid,
          value_after: item.nextBid,
          current_value: item.currentBid,
          proposed_value: item.nextBid,
          change_pct: -Math.round(item.effectiveReduction * 100),
          status: body.dry_run === true ? 'suggested' : 'approved',
          queue_status: body.dry_run === true ? 'not_queued' : 'pending',
          execution_mode: 'EXECUTE_NOW',
          priority_class: 'P1',
          confidence: item.confidence,
          requires_approval: false,
          requires_fresh_data: true,
          maximum_data_age_minutes: FRESHNESS_MINUTES,
          data_window_end: new Date().toISOString(),
          idempotency_key: item.key,
          conflict_group: `${item.entityType}_bid:${accountId}:${item.entityId}`,
          rationale,
          reason: rationale,
          reason_code: 'ACCOUNT_MER_ABOVE_TARGET',
          source_function: 'runBlendedMerGuardrail',
          evidence: {
            date_brt: today,
            formula: 'blended_ad_spend / total_marketplace_revenue',
            total_ad_spend: totalSpend,
            total_marketplace_revenue: totalRevenue,
            mer: mer,
            target_mer: targetMer,
            excess_spend: excessSpend,
            campaign_spend: item.spend,
            campaign_sales: item.sales,
            campaign_orders: item.orders,
            campaign_clicks: item.clicks,
            campaign_acos: item.acos,
            target_acos: targetAcos,
            winner_protected: false,
            wilson_confidence_level: 0.95,
            wilson_cvr_observed: item.wilson.observed,
            wilson_cvr_lower: item.wilson.lower,
            wilson_cvr_upper: item.wilson.upper,
            confidence_from_interval_precision: item.confidence,
            average_order_value: item.averageOrderValue,
            economic_sample_min_clicks: MIN_ECONOMIC_CLICKS,
            economic_sample_valid: item.economicSampleValid,
            economic_bid_formula: 'AOV * target_ACoS * Wilson_CVR_lower_95',
            economic_bid_ceiling: item.economicBidCeiling,
            severity_bid_before_economic_cap: roundBid(item.currentBid * (1 - item.reduction)),
            minimum_bid_floor: MIN_BID,
            source_ads: 'IntradaySpendSnapshot',
            source_revenue: 'SalesDaily SP-API',
          },
          max_attempts: 3,
          attempt_count: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        created++;
      }

      results.push({ account_id: accountId, date: today, target_mer: targetMer, target_acos: targetAcos, mer, total_spend: totalSpend, total_revenue: totalRevenue, excess_spend: excessSpend, candidates: candidates.length, actions_created: created, dry_run: body.dry_run === true });
    }

    return Response.json({
      ok: true,
      engine: 'blended-mer-guardrail-v2-wilson-economic-cap',
      definition: 'MER operacional Amazon = gasto Ads / receita total do marketplace no mesmo período; equivalente ao TACoS quando o custo considerado é somente mídia paga.',
      policy: {
        default_target_mer_pct: DEFAULT_TARGET_MER * 100,
        only_real_persisted_data: true,
        no_revenue_attribution_dependency: true,
        protects_profitable_winners: true,
        never_increases_bid: true,
        confidence: 'derivada da precisão do intervalo Wilson 95%; nunca fixa',
        economic_bid_ceiling: 'AOV * target ACoS * limite inferior da CVR Wilson 95%',
        economic_cap_minimum_clicks: MIN_ECONOMIC_CLICKS,
        insufficient_economic_sample: 'mantém somente redução determinística por MER; não inventa CVR',
        reductions: '10% / 15% / 20%, com teto econômico conservador quando há amostra real suficiente',
        maximum_actions_per_cycle: MAX_ACTIONS,
      },
      results,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha no guardrail de MER blended' }, { status: 500 });
  }
});
