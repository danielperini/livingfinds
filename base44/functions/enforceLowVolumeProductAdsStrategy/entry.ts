import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { availableAdsStock, stockAdsDecision } from '../../shared/stockAdsPolicy.ts';
import { calculateLowVolumeDailyPlan, isPriorityLowVolumeProduct } from '../../shared/lowVolumeAdsPolicy.ts';
import { normalizeState, numberValue, resolveOperatingAcos, roundMoney } from '../../shared/profitGuardPolicy.ts';

const SOURCE = 'enforceLowVolumeProductAdsStrategy';
const CONTENT_CAMPAIGN = 'application/vnd.spCampaign.v3+json';
const CONTENT_AD_GROUP = 'application/vnd.spAdGroup.v3+json';
const upper = (value: unknown) => String(value || '').trim().toUpperCase();
const campaignIdOf = (row: any) => String(row?.amazon_campaign_id || row?.campaign_id || '');
const enabled = (row: any) => ['enabled', 'active'].includes(normalizeState(row?.state || row?.status));
const isAuto = (row: any) => upper(row?.targeting_type) === 'AUTO' || upper(row?.name || row?.campaign_name).includes('AUTO');
const todayBrt = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

async function command(base44: any, accountId: string, operation: string, path: string, payload: any, contentType: string) {
  const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
    _service_role: true,
    amazon_account_id: accountId,
    operation,
    method: 'PUT',
    path,
    payload,
    content_type: contentType,
    accept: contentType,
    max_attempts: 3,
  }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error), retryable: true } }));
  return response?.data || response || {};
}

function productMatchesCampaign(product: any, campaign: any): boolean {
  const asin = upper(product?.asin);
  const sku = upper(product?.sku);
  const name = upper(campaign?.name || campaign?.campaign_name);
  return (asin && (upper(campaign?.asin) === asin || name.includes(asin))) ||
    (sku && upper(campaign?.sku) === sku);
}

function economicsFor(product: any, rows: any[]) {
  return rows.find((row: any) =>
    (product?.asin && upper(row?.asin) === upper(product.asin)) ||
    (product?.sku && upper(row?.sku || row?.normalized_sku) === upper(product.sku))
  ) || null;
}

function aggregate(rows: any[], campaignIds: Set<string>) {
  const result = { sales: 0, spend: 0, orders: 0, dates: new Set<string>() };
  for (const row of rows) {
    if (!campaignIds.has(String(row?.campaign_id || ''))) continue;
    result.sales += numberValue(row?.sales);
    result.spend += numberValue(row?.spend);
    result.orders += numberValue(row?.orders);
    if (row?.date) result.dates.add(String(row.date));
  }
  return result;
}

function selectCanonicalAuto(rows: any[]): any | null {
  return [...rows].sort((a: any, b: any) => {
    const aEnabled = enabled(a) ? 1 : 0;
    const bEnabled = enabled(b) ? 1 : 0;
    const aComplete = a.is_operational === true && normalizeState(a.reconciliation_status) !== 'review_required' ? 1 : 0;
    const bComplete = b.is_operational === true && normalizeState(b.reconciliation_status) !== 'review_required' ? 1 : 0;
    const aScore = numberValue(a.sales) * 100 + numberValue(a.orders) * 10 - numberValue(a.spend);
    const bScore = numberValue(b.sales) * 100 + numberValue(b.orders) * 10 - numberValue(b.spend);
    return bEnabled - aEnabled || bComplete - aComplete || bScore - aScore ||
      new Date(b.synced_at || b.updated_at || 0).getTime() - new Date(a.synced_at || a.updated_at || 0).getTime();
  })[0] || null;
}

async function record(base44: any, payload: any) {
  const existing = await base44.asServiceRole.entities.OptimizationDecision.filter({
    amazon_account_id: payload.amazon_account_id,
    idempotency_key: payload.idempotency_key,
  }, '-created_at', 1).catch(() => []);
  if (existing.length) return existing[0];
  return base44.asServiceRole.entities.OptimizationDecision.create({
    entity_type: payload.entity_type || 'campaign',
    requires_approval: false,
    approval_status: 'auto_approved',
    status: payload.status || 'executed',
    source_function: SOURCE,
    created_at: new Date().toISOString(),
    ...payload,
  }).catch(() => null);
}

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (body._service_role !== true) {
      const user = await base44.auth.me().catch(() => null);
      if (!user || user.role !== 'admin') return Response.json({ ok: false, error: 'Admin only' }, { status: 403 });
    }
    const dryRun = body.dry_run === true;
    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.list('-created_date', 50);
    const results: any[] = [];

    for (const account of accounts.filter((row: any) => row.ads_profile_id)) {
      const accountId = String(account.id);
      const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
      const [products, economics, settingsRows, configRows, metrics] = await Promise.all([
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, '-updated_at', 3000).catch(() => []),
        base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: accountId }, '-updated_at', 3000).catch(() => []),
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: accountId }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: accountId }, '-date', 10000).catch(() => []),
      ]);
      const eligibleProducts = products.filter((product: any) =>
        availableAdsStock(product) > 1 && stockAdsDecision(product) === 'activate' &&
        /^B0[A-Z0-9]{8}$/.test(upper(product.asin)) && product.listing_suppressed !== true
      );
      const settings = settingsRows[0] || {};
      const config = configRows[0] || {};
      const accountDailyLimit = Math.max(1, numberValue(settings.daily_budget_limit || config.daily_budget_limit || account.max_daily_budget_limit, 80));
      const accountShareCap = roundMoney(accountDailyLimit / Math.max(1, eligibleProducts.length));

      // A função de cobertura é idempotente: cria a AUTO ausente ou reativa a existente.
      if (!dryRun) {
        for (const product of eligibleProducts) {
          await base44.asServiceRole.functions.invoke('createAutoCampaignForAsin', {
            _service_role: true,
            amazon_account_id: accountId,
            asin: upper(product.asin),
            sku: String(product.sku || ''),
            product_name: product.product_name || product.title || product.name || '',
          }).catch(() => null);
        }
        await base44.asServiceRole.functions.invoke('syncAdsCampaignStatesV2', {
          _service_role: true, amazon_account_id: accountId,
        }).catch(() => null);
        const dedupResponse = await base44.asServiceRole.functions.invoke('deduplicateAutoCampaignsByAsin', {
          _service_role: true, amazon_account_id: accountId, dry_run: false,
          asins: eligibleProducts.map((product: any) => upper(product.asin)),
        }).catch((error: any) => ({ data: { ok: false, failed: 1, error: error?.message || String(error) } }));
        const dedup = dedupResponse?.data || dedupResponse || {};
        if (dedup.ok === false || numberValue(dedup.failed) > 0) {
          const failedDetails = (dedup.details || []).filter((row: any) => row.error).slice(0, 3);
          throw new Error(`Reconciliação das AUTO duplicadas não confirmada: ${dedup.error || `${dedup.failed} falha(s)`} ${JSON.stringify(failedDetails)}`);
        }
        await base44.asServiceRole.functions.invoke('syncAdsCampaignStatesV2', {
          _service_role: true, amazon_account_id: accountId,
        }).catch(() => null);
      }

      const [campaigns, adGroups] = await Promise.all([
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.AdGroup.filter({ amazon_account_id: accountId }, '-updated_at', 10000).catch(() => []),
      ]);
      const recentMetrics = metrics.filter((row: any) => String(row?.date || '') >= cutoff);

      for (const product of eligibleProducts) {
        const allAutos = campaigns.filter((campaign: any) => campaign.archived !== true && isAuto(campaign) && productMatchesCampaign(product, campaign));
        const canonical = selectCanonicalAuto(allAutos);
        const autos = canonical ? [canonical] : [];
        const campaignIds = new Set(allAutos.map(campaignIdOf).filter(Boolean));
        const performance = aggregate(recentMetrics, campaignIds);
        const priority = isPriorityLowVolumeProduct(product);
        const sampleDays = Math.max(14, performance.dates.size || 0);
        const dailyOrders = performance.orders / sampleDays;
        if (!priority && !(performance.orders > 0 && dailyOrders <= 1)) continue;

        const econ = economicsFor(product, economics);
        const operating = resolveOperatingAcos(econ, numberValue(settings.target_acos || config.target_acos, 10));
        const profitPerUnit = numberValue(econ?.profit_before_ads || econ?.contribution_margin_amount);
        const safeMaxCpc = numberValue(econ?.safe_max_cpc);

        for (const campaign of autos) {
          const campaignId = campaignIdOf(campaign);
          if (!/^\d+$/.test(campaignId)) {
            results.push({ sku: product.sku, asin: product.asin, campaign_id: campaignId, ok: false, action: 'remote_id_missing' });
            continue;
          }
          const plan = calculateLowVolumeDailyPlan({
            ...performance,
            sampleDays,
            targetAcos: operating.target_acos,
            profitBeforeAdsPerUnit: profitPerUnit,
            safeMaxCpc,
            targetCpc: settings.cpc_intraday_override || settings.target_cpc || config.target_cpc,
            accountCampaignShareCap: Math.min(accountShareCap, numberValue(config.maximum_campaign_budget, accountShareCap)),
            currentBudget: campaign.daily_budget,
          });
          const day = todayBrt();
          const actions: any[] = [];

          if (!enabled(campaign)) {
            const key = `${SOURCE}|enable|${accountId}|${campaignId}|${day}`;
            const amazon = dryRun ? { ok: true, dry_run: true } : await command(base44, accountId,
              'enableLowVolumeAutoCampaign', '/sp/campaigns', { campaigns: [{ campaignId, state: 'ENABLED' }] }, CONTENT_CAMPAIGN);
            actions.push({ type: 'enable_campaign', ok: amazon.ok === true, amazon_status: amazon.status || null });
            if (!dryRun && amazon.ok === true) {
              await base44.asServiceRole.entities.Campaign.update(campaign.id, {
                state: 'enabled', status: 'enabled', amazon_status: 'enabled', is_operational: true, synced_at: new Date().toISOString(),
              });
              await record(base44, { amazon_account_id: accountId, campaign_id: campaignId, entity_id: campaignId,
                asin: product.asin, sku: product.sku, decision_type: 'campaign_reactivate', action: 'reactivate_campaign',
                rationale: 'Produto com venda pequena preservado em estratégia AUTO de baixo risco.', rule_key: 'low_volume_auto_presence',
                confidence: 99, risk: 'low', idempotency_key: key, executed_at: new Date().toISOString() });
            }
          }

          const currentBudget = numberValue(campaign.daily_budget);
          if (currentBudget <= 0 || currentBudget > plan.dailyBudget + 0.009) {
            const key = `${SOURCE}|budget|${accountId}|${campaignId}|${day}|${plan.dailyBudget}`;
            const amazon = dryRun ? { ok: true, dry_run: true } : await command(base44, accountId,
              'capLowVolumeDailyBudget', '/sp/campaigns', {
                campaigns: [{ campaignId, budget: { budget: plan.dailyBudget, budgetType: 'DAILY' } }],
              }, CONTENT_CAMPAIGN);
            actions.push({ type: 'cap_daily_budget', from: currentBudget, to: plan.dailyBudget, ok: amazon.ok === true });
            if (!dryRun && amazon.ok === true) {
              await base44.asServiceRole.entities.Campaign.update(campaign.id, { daily_budget: plan.dailyBudget, synced_at: new Date().toISOString() });
              await record(base44, { amazon_account_id: accountId, campaign_id: campaignId, entity_id: campaignId,
                asin: product.asin, sku: product.sku, decision_type: 'budget_change', action: 'reduce_budget',
                rationale: `Teto diário pela venda, ACoS e margem: R$${plan.dailyBudget}.`, rule_key: 'low_volume_daily_profit_cap',
                confidence: 99, risk: 'low', idempotency_key: key, executed_at: new Date().toISOString() });
            }
          }

          const campaignAdGroups = adGroups.filter((row: any) => String(row.campaign_id || '') === campaignId &&
            ['enabled', 'active'].includes(normalizeState(row.state || row.status)));
          for (const adGroup of campaignAdGroups) {
            const adGroupId = String(adGroup.amazon_ad_group_id || adGroup.ad_group_id || '');
            const currentBid = numberValue(adGroup.default_bid || adGroup.bid);
            if (!/^\d+$/.test(adGroupId) || currentBid <= 0 || currentBid <= plan.targetBid + 0.009) continue;
            const key = `${SOURCE}|adgroup_bid|${accountId}|${adGroupId}|${day}|${plan.targetBid}`;
            const amazon = dryRun ? { ok: true, dry_run: true } : await command(base44, accountId,
              'capLowVolumeAutoBid', '/sp/adGroups', {
                adGroups: [{ adGroupId, defaultBid: plan.targetBid }],
              }, CONTENT_AD_GROUP);
            actions.push({ type: 'reduce_auto_bid', ad_group_id: adGroupId, from: currentBid, to: plan.targetBid, ok: amazon.ok === true });
            if (!dryRun && amazon.ok === true) {
              await base44.asServiceRole.entities.AdGroup.update(adGroup.id, { default_bid: plan.targetBid, synced_at: new Date().toISOString() });
              await record(base44, { amazon_account_id: accountId, campaign_id: campaignId, entity_type: 'ad_group', entity_id: adGroupId,
                asin: product.asin, sku: product.sku, decision_type: 'bid_adjustment', action: 'decrease_bid',
                rationale: `Bid AUTO defensivo alinhado ao teto diário R$${plan.dailyBudget}.`, rule_key: 'low_volume_auto_bid_guard',
                confidence: 99, risk: 'low', idempotency_key: key, executed_at: new Date().toISOString() });
            }
          }

          if (!dryRun && campaign.id) {
            await base44.asServiceRole.entities.Campaign.update(campaign.id, {
              motor_daily_spend_cap: plan.calculatedSpendCap,
              motor_daily_loss_limit: plan.maximumDailyLoss,
              motor_daily_strategy: plan.strategy,
              motor_daily_plan_at: new Date().toISOString(),
              delivery_status: 'auto_low_volume_profit_guard',
              delivery_block_reason: `${SOURCE}|budget=${plan.dailyBudget}|bid=${plan.targetBid}|sales_day=${plan.dailySales}|acos=${plan.acos ?? 'n/a'}`,
            }).catch(() => {});
          }
          results.push({ sku: product.sku, asin: product.asin, product: product.product_name || product.title || product.name,
            campaign_id: campaignId, priority_product: priority, plan, actions, ok: actions.every((action) => action.ok !== false) });
        }
      }
    }

    return Response.json({
      ok: results.every((row) => row.ok !== false),
      dry_run: dryRun,
      policy: 'AUTO_LOW_VOLUME_PROFIT_GUARD_V1',
      processed: results.length,
      campaigns_enabled: results.flatMap((row) => row.actions || []).filter((row) => row.type === 'enable_campaign' && row.ok).length,
      budgets_reduced: results.flatMap((row) => row.actions || []).filter((row) => row.type === 'cap_daily_budget' && row.ok).length,
      bids_reduced: results.flatMap((row) => row.actions || []).filter((row) => row.type === 'reduce_auto_bid' && row.ok).length,
      results,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    }, { status: results.every((row) => row.ok !== false) ? 200 : 207 });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error), started_at: startedAt }, { status: 500 });
  }
});
