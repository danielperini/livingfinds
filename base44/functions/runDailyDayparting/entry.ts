import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import {
  availableInventory,
  classifyProfitPressure,
  economicsAreActionable,
  normalizeState,
  numberValue,
  resolveOperatingAcos,
  roundMoney,
} from '../../shared/profitGuardPolicy.ts';

const LOOKBACK_DAYS = 30;
const MIN_DAYS_WITH_DATA = 14;
const MIN_TOTAL_CLICKS = 30;
const MIN_TOTAL_ORDERS_FOR_BOOST = 2;
const MIN_HOURLY_CLICKS = 8;
const MAX_INCREASE_PCT = 20;
const MAX_DECREASE_PCT = 15;
const AUTO_APPLY_CONFIDENCE = 90;
const COOLDOWN_HOURS = 23;

const campaignIdOf = (campaign: any) => String(campaign?.amazon_campaign_id || campaign?.campaign_id || '');
const campaignState = (campaign: any) => normalizeState(campaign?.amazon_status || campaign?.state || campaign?.status);
const hoursSince = (value: unknown) => {
  if (!value) return Number.POSITIVE_INFINITY;
  const timestamp = new Date(String(value)).getTime();
  return Number.isFinite(timestamp) ? (Date.now() - timestamp) / 3600000 : Number.POSITIVE_INFINITY;
};

function latestAssessments(rows: any[]): Map<string, any> {
  const map = new Map<string, any>();
  for (const row of rows) {
    if (!row.asin || ['failed', 'stale', 'reconciliation_pending'].includes(normalizeState(row.data_status))) continue;
    const current = map.get(String(row.asin));
    const rowTime = new Date(row.assessment_date || row.updated_at || row.created_at || 0).getTime();
    const currentTime = new Date(current?.assessment_date || current?.updated_at || current?.created_at || 0).getTime();
    if (!current || rowTime >= currentTime) map.set(String(row.asin), row);
  }
  return map;
}

function confidenceScore(params: { days: number; clicks: number; orders: number; activeHours: number; actionableHours: number }): number {
  const dayScore = Math.min(1, params.days / 30);
  const clickScore = Math.min(1, params.clicks / 100);
  const orderScore = Math.min(1, params.orders / 10);
  const hourScore = params.activeHours > 0 ? Math.min(1, params.actionableHours / params.activeHours) : 0;
  return Math.round((dayScore * 0.30 + clickScore * 0.30 + orderScore * 0.30 + hourScore * 0.10) * 100);
}

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (!body._service_role) {
      const authenticated = await base44.auth.isAuthenticated().catch(() => false);
      if (!authenticated) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accountRows = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 1);
    const account = accountRows[0];
    if (!account) return Response.json({ ok: true, skipped: true, reason: 'Nenhuma conta conectada' });
    const aid = account.id;

    const [configRows, settingsRows, campaigns, products, economics, assessments, hourlyRows, keywords, decisions] = await Promise.all([
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, '-updated_at', 1).catch(() => []),
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1).catch(() => []),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-updated_at', 5000).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 2000).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, '-updated_at', 2000).catch(() => []),
      base44.asServiceRole.entities.DailyProductAdsAssessment.filter({ amazon_account_id: aid }, '-assessment_date', 3000).catch(() => []),
      base44.asServiceRole.entities.HourlyMetric.filter({ amazon_account_id: aid }, '-date', 30000).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, null, 10000).catch(() => []),
      base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: aid, decision_type: 'dayparting_rule' }, '-created_at', 2000).catch(() => []),
    ]);
    const config = configRows[0] || {};
    if (config.dayparting_enabled === false) return Response.json({ ok: true, skipped: true, reason: 'Dayparting desabilitado' });
    const settings = settingsRows[0] || {};
    const accountTargetAcos = numberValue(settings.target_acos, 15);
    const minBid = numberValue(config.min_bid, numberValue(settings.min_bid, 0.20));
    const maxBid = numberValue(config.max_bid, numberValue(settings.max_bid, 5.00));
    const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);

    const productByAsin = new Map(products.filter((p: any) => p.asin).map((p: any) => [String(p.asin), p]));
    const economicsByAsin = new Map(economics.filter((e: any) => e.asin).map((e: any) => [String(e.asin), e]));
    const assessmentByAsin = latestAssessments(assessments);
    const hourlyByCampaign = new Map<string, any[]>();
    for (const row of hourlyRows) {
      if (!row.campaign_id || String(row.date || '') < cutoff || normalizeState(row.data_maturity) === 'provisional') continue;
      const id = String(row.campaign_id);
      const list = hourlyByCampaign.get(id) || [];
      list.push(row);
      hourlyByCampaign.set(id, list);
    }
    const bidsByCampaign = new Map<string, number[]>();
    for (const keyword of keywords) {
      if (!['enabled', 'active'].includes(normalizeState(keyword.state || keyword.status))) continue;
      const id = String(keyword.campaign_id || '');
      const bid = numberValue(keyword.current_bid || keyword.bid, 0);
      if (!id || bid <= 0) continue;
      const list = bidsByCampaign.get(id) || [];
      list.push(bid);
      bidsByCampaign.set(id, list);
    }

    const candidates = campaigns.filter((campaign: any) =>
      campaignState(campaign) === 'enabled' &&
      campaign.archived !== true &&
      campaign.ads_protected !== true &&
      campaignIdOf(campaign) &&
      hoursSince(campaign.start_date || campaign.created_at) >= 14 * 24
    );

    const results: any[] = [];
    const stats = { analyzed: 0, decisions_created: 0, auto_applied: 0, pending: 0, skipped: 0, errors: 0 };

    for (const campaign of candidates) {
      const campaignId = campaignIdOf(campaign);
      const recentDecision = decisions.find((decision: any) =>
        String(decision.campaign_id || decision.entity_id || '') === campaignId &&
        ['pending', 'approved', 'executing', 'executed'].includes(String(decision.status || '')) &&
        hoursSince(decision.created_at) < COOLDOWN_HOURS
      );
      if (recentDecision) {
        stats.skipped++;
        continue;
      }
      stats.analyzed++;
      try {
        const asin = String(campaign.asin || '');
        const product = productByAsin.get(asin);
        const econ = economicsByAsin.get(asin);
        const assessment = assessmentByAsin.get(asin);
        if (!product || availableInventory(product) <= 0 || !economicsAreActionable(econ, assessment)) {
          stats.skipped++;
          continue;
        }
        const rows = hourlyByCampaign.get(campaignId) || [];
        const days = new Set(rows.filter((row: any) => numberValue(row.impressions) > 0).map((row: any) => row.date)).size;
        const totalClicks = rows.reduce((sum: number, row: any) => sum + numberValue(row.clicks), 0);
        const totalOrders = rows.reduce((sum: number, row: any) => sum + numberValue(row.orders), 0);
        const totalSpend = rows.reduce((sum: number, row: any) => sum + numberValue(row.spend), 0);
        const totalSales = rows.reduce((sum: number, row: any) => sum + numberValue(row.sales), 0);
        if (days < MIN_DAYS_WITH_DATA || totalClicks < MIN_TOTAL_CLICKS) {
          stats.skipped++;
          continue;
        }

        const policy = resolveOperatingAcos(econ, accountTargetAcos);
        const pressure = classifyProfitPressure(assessment, econ);
        const avgAcos = totalSales > 0 ? totalSpend / totalSales * 100 : null;
        const avgRoas = totalSpend > 0 ? totalSales / totalSpend : 0;
        const bidList = bidsByCampaign.get(campaignId) || [];
        const baseBid = bidList.length ? bidList.reduce((a, b) => a + b, 0) / bidList.length : numberValue(campaign.default_bid, 0.50);
        const maxProfitableCpa = numberValue(assessment?.maximum_profitable_cpa, 0) || numberValue(econ?.profit_before_ads, 0);

        const matrix: Record<number, any> = {};
        for (let hour = 0; hour < 24; hour++) matrix[hour] = { hour, clicks: 0, orders: 0, spend: 0, sales: 0, impressions: 0, days: new Set<string>() };
        for (const row of rows) {
          const hour = Number(row.hour);
          if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
          matrix[hour].clicks += numberValue(row.clicks);
          matrix[hour].orders += numberValue(row.orders);
          matrix[hour].spend += numberValue(row.spend);
          matrix[hour].sales += numberValue(row.sales);
          matrix[hour].impressions += numberValue(row.impressions);
          if (row.date) matrix[hour].days.add(String(row.date));
        }

        const schedule: any[] = [];
        for (const slot of Object.values(matrix) as any[]) {
          const slotAcos = slot.sales > 0 ? slot.spend / slot.sales * 100 : null;
          const slotRoas = slot.spend > 0 ? slot.sales / slot.spend : 0;
          const slotCvr = slot.clicks > 0 ? slot.orders / slot.clicks : 0;
          let classification = 'efficient';
          let adjustmentPct = 0;

          const canBoost = pressure === 'healthy' && totalOrders >= MIN_TOTAL_ORDERS_FOR_BOOST &&
            slot.clicks >= MIN_HOURLY_CLICKS && slot.orders >= 1 && slotAcos !== null && slotAcos <= policy.target_acos;
          if (canBoost) {
            const veryStrong = slot.orders >= 2 && slotAcos <= policy.target_acos * 0.70;
            classification = veryStrong ? 'peak_high_profit' : 'peak_conversion';
            adjustmentPct = veryStrong ? MAX_INCREASE_PCT : 10;
          } else {
            const noSaleThreshold = Math.max(5, maxProfitableCpa > 0 ? maxProfitableCpa / 4 : 5);
            const noSaleWaste = slot.clicks >= 10 && slot.orders === 0 && slot.spend >= noSaleThreshold;
            const inefficient = slot.clicks >= MIN_HOURLY_CLICKS && slot.orders > 0 && slotAcos !== null && slotAcos > policy.target_acos;
            if (noSaleWaste) {
              classification = 'deficit';
              adjustmentPct = -MAX_DECREASE_PCT;
            } else if (inefficient || ['critical', 'defensive'].includes(pressure)) {
              classification = 'low_efficiency';
              adjustmentPct = -10;
            }
          }
          if (adjustmentPct === 0) continue;
          const recommendedBid = roundMoney(Math.min(maxBid, Math.max(minBid, baseBid * (1 + adjustmentPct / 100))));
          schedule.push({
            hour: slot.hour,
            classification,
            baseBid: roundMoney(baseBid),
            recommendedBid,
            bidChangePct: adjustmentPct,
            clicks: slot.clicks,
            orders: slot.orders,
            spend: roundMoney(slot.spend),
            sales: roundMoney(slot.sales),
            acos: slotAcos === null ? null : roundMoney(slotAcos),
            roas: roundMoney(slotRoas),
            cvr: roundMoney(slotCvr * 100),
            sampleDays: slot.days.size,
          });
        }
        if (!schedule.length) {
          stats.skipped++;
          continue;
        }

        const activeHours = Object.values(matrix).filter((slot: any) => slot.clicks > 0).length;
        const confidence = confidenceScore({ days, clicks: totalClicks, orders: totalOrders, activeHours, actionableHours: schedule.length });
        const autoApply = confidence >= AUTO_APPLY_CONFIDENCE;
        const now = new Date().toISOString();
        const decision = await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id: aid,
          decision_type: 'dayparting_rule',
          entity_type: 'campaign',
          entity_id: campaignId,
          campaign_id: campaignId,
          asin,
          action: 'apply_dayparting',
          rationale: `Dayparting econômico: ${schedule.filter((slot) => slot.bidChangePct > 0).length} picos até +${MAX_INCREASE_PCT}% e ${schedule.filter((slot) => slot.bidChangePct < 0).length} reduções até -${MAX_DECREASE_PCT}%. ACoS seguro ${policy.target_acos}%, break-even ${policy.break_even_acos ?? 'indisponível'}%.`,
          data_used: JSON.stringify({
            base_bid: roundMoney(baseBid),
            bid_floor: minBid,
            bid_ceiling: maxBid,
            days_with_data: days,
            total_clicks: totalClicks,
            total_orders: totalOrders,
            total_spend: roundMoney(totalSpend),
            total_sales: roundMoney(totalSales),
            avg_roas: roundMoney(avgRoas),
            avg_acos: avgAcos === null ? null : roundMoney(avgAcos),
            pressure,
            operating_target_acos: policy.target_acos,
            break_even_acos: policy.break_even_acos,
            dayparting_schedule: schedule,
          }),
          confidence,
          risk: autoApply ? 'low' : 'medium',
          requires_approval: !autoApply,
          status: autoApply ? 'approved' : 'pending',
          reversible: true,
          country_code: account.country_code || 'BR',
          currency_code: account.currency_code || 'BRL',
          currency_symbol: account.currency_symbol || 'R$',
          objective: pressure === 'healthy' ? 'maintenance' : 'profit_recovery',
          expected_impact: `Ajustes temporários com restauração em uma hora; limite +${MAX_INCREASE_PCT}%/-${MAX_DECREASE_PCT}%.`,
          evaluation_due_at: new Date(Date.now() + 7 * 86400000).toISOString(),
          source_function: 'runDailyDayparting',
          created_at: now,
        });
        stats.decisions_created++;

        let applyResult: any = null;
        if (autoApply) {
          const response = await base44.asServiceRole.functions.invoke('applyDaypartingSchedule', {
            opportunity_id: decision.id,
            approve: true,
            auto_apply: true,
            _service_role: true,
          }).catch((error: any) => ({ data: { ok: false, error: error.message } }));
          applyResult = response?.data || response || {};
          if (applyResult.ok) stats.auto_applied++;
          else stats.errors++;
        } else stats.pending++;

        results.push({
          campaign_id: campaignId,
          asin,
          campaign_name: campaign.name || campaign.campaign_name,
          confidence,
          auto_applied: autoApply && applyResult?.ok === true,
          pressure,
          target_acos: policy.target_acos,
          break_even_acos: policy.break_even_acos,
          peak_windows: schedule.filter((slot) => slot.bidChangePct > 0).length,
          defensive_windows: schedule.filter((slot) => slot.bidChangePct < 0).length,
          decision_id: decision.id,
          apply_error: autoApply && !applyResult?.ok ? applyResult?.error : null,
        });
      } catch (error: any) {
        stats.errors++;
        results.push({ campaign_id: campaignId, status: 'error', error: error.message });
      }
    }

    return Response.json({
      ok: stats.errors === 0,
      policy: {
        lookback_days: LOOKBACK_DAYS,
        minimum_days: MIN_DAYS_WITH_DATA,
        minimum_clicks: MIN_TOTAL_CLICKS,
        minimum_orders_for_boost: MIN_TOTAL_ORDERS_FOR_BOOST,
        max_increase_pct: MAX_INCREASE_PCT,
        max_decrease_pct: MAX_DECREASE_PCT,
        auto_apply_confidence: AUTO_APPLY_CONFIDENCE,
        product_economics_required: true,
      },
      eligible_campaigns: candidates.length,
      stats,
      results,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha no dayparting diário' }, { status: 500 });
  }
});
