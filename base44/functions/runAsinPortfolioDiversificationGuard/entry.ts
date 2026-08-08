import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const SOURCE = 'runAsinPortfolioDiversificationGuard';
const finite = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const upper = (value: unknown) => String(value || '').trim().toUpperCase();
const lower = (value: unknown) => String(value || '').trim().toLowerCase();
const active = (value: unknown) => ['enabled', 'active'].includes(lower(value));
const campaignIdOf = (row: any) => String(row.amazon_campaign_id || row.campaign_id || row.id || '');
const roundMoney = (value: number) => Math.round(value * 100) / 100;

function brtDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

function asinOf(campaign: any, productAds: any[]): string {
  const direct = upper(campaign.asin || campaign.advertised_asin);
  if (direct) return direct;
  const campaignId = campaignIdOf(campaign);
  const ad = productAds.find((row: any) => String(row.campaign_id || '') === campaignId);
  return upper(ad?.asin);
}

function latestByCampaign(rows: any[]): Map<string, any> {
  const sorted = [...rows].sort((a, b) => new Date(String(b.observed_at || b.created_at || 0)).getTime() - new Date(String(a.observed_at || a.created_at || 0)).getTime());
  const map = new Map<string, any>();
  for (const row of sorted) {
    const id = String(row.campaign_id || '');
    if (id && !map.has(id)) map.set(id, row);
  }
  return map;
}

Deno.serve(async (request) => {
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
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 50);
    const results: any[] = [];
    const today = brtDate();

    for (const account of accounts) {
      const accountId = String(account.id);
      const [settingsRows, campaigns, productAds, products, intradayRows, priorDecisions] = await Promise.all([
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.ProductAd.filter({ amazon_account_id: accountId }, '-updated_at', 10000).catch(() => []),
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.IntradaySpendSnapshot.filter({ amazon_account_id: accountId, spend_date: today }, '-observed_at', 10000).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-created_at', 10000).catch(() => []),
      ]);

      const settings = settingsRows[0] || {};
      const targetAcos = finite(settings.target_acos || settings.acos_target, 15);
      const accountBudget = Math.max(1, finite(settings.account_daily_budget_limit || settings.daily_budget_global || settings.daily_budget, 80));
      const explorationPoolShare = Math.min(0.30, Math.max(0.15, finite(settings.asin_exploration_pool_share, 0.25)));
      const maxAsinShare = Math.min(0.40, Math.max(0.20, finite(settings.max_asin_spend_share, 0.30)));
      const maxWinnerShare = Math.min(0.45, Math.max(maxAsinShare, finite(settings.max_winner_asin_spend_share, 0.35)));
      const minCampaignBudget = Math.max(5, finite(settings.minimum_campaign_budget, 5));
      const maxCampaignBudget = Math.max(minCampaignBudget, finite(settings.maximum_campaign_budget, 100));
      const latest = latestByCampaign(intradayRows);
      const productByAsin = new Map(products.filter((p: any) => p.asin).map((p: any) => [upper(p.asin), p]));

      const campaignRows = campaigns.filter((campaign: any) => active(campaign.state || campaign.status) && upper(campaign.campaign_type || 'SP') === 'SP');
      const portfolio = new Map<string, any>();
      for (const campaign of campaignRows) {
        const asin = asinOf(campaign, productAds);
        if (!asin) continue;
        const product = productByAsin.get(asin);
        const stock = finite(product?.available_quantity ?? product?.fba_inventory ?? product?.fulfillable_quantity, 0);
        if (!product || stock <= 0 || product.listing_suppressed === true || product.listing_buyable === false) continue;
        const id = campaignIdOf(campaign);
        const metrics = latest.get(id) || campaign;
        const row = portfolio.get(asin) || { asin, product, campaigns: [], spend: 0, sales: 0, orders: 0, clicks: 0 };
        row.campaigns.push(campaign);
        row.spend += finite(metrics.spend ?? campaign.current_spend ?? campaign.spend);
        row.sales += finite(metrics.sales ?? campaign.sales);
        row.orders += finite(metrics.orders ?? campaign.orders);
        row.clicks += finite(metrics.clicks ?? campaign.clicks);
        portfolio.set(asin, row);
      }

      const rows = [...portfolio.values()];
      const totalSpend = rows.reduce((sum, row) => sum + row.spend, 0);
      const eligibleForExploration = rows.filter((row) => {
        const profitAfterAds = finite(row.product.profit_after_ads, 0);
        const breakEvenAcos = finite(row.product.break_even_acos_pct, 0);
        const observedAcos = row.sales > 0 ? row.spend / row.sales * 100 : null;
        const lossWithoutSale = row.sales <= 0 && row.spend >= Math.max(5, finite(row.product.maximum_ad_spend_per_order, 0));
        const economicallyUnsafe = row.product.cost_confirmed === false || row.product.ads_eligibility_status === 'out_of_stock' || lossWithoutSale || (observedAcos !== null && breakEvenAcos > 0 && observedAcos >= breakEvenAcos);
        return !economicallyUnsafe && (profitAfterAds >= 0 || row.spend <= 2 || row.orders > 0);
      });
      const floorShare = eligibleForExploration.length > 0
        ? Math.min(0.05, explorationPoolShare / eligibleForExploration.length)
        : 0;

      const decisions: any[] = [];
      const observations: any[] = [];
      for (const row of rows) {
        const currentShare = totalSpend > 0 ? row.spend / totalSpend : 0;
        const acos = row.sales > 0 ? row.spend / row.sales * 100 : null;
        const profitableWinner = row.orders >= 2 && row.sales > 0 && finite(row.product.profit_after_ads, 0) > 0 && acos !== null && acos <= targetAcos;
        const shareCap = profitableWinner ? maxWinnerShare : maxAsinShare;
        const underExposed = eligibleForExploration.includes(row) && currentShare < floorShare && row.orders === 0;
        const overConcentrated = currentShare > shareCap && (!profitableWinner || (acos !== null && acos > targetAcos));

        observations.push({ asin: row.asin, spend: roundMoney(row.spend), sales: roundMoney(row.sales), orders: row.orders, acos, current_share: currentShare, floor_share: floorShare, cap_share: shareCap, under_exposed: underExposed, over_concentrated: overConcentrated });

        if (!underExposed && !overConcentrated) continue;
        const candidateCampaigns = [...row.campaigns].sort((a, b) => finite(a.daily_budget || a.budget) - finite(b.daily_budget || b.budget));
        const campaign = underExposed ? candidateCampaigns[0] : candidateCampaigns[candidateCampaigns.length - 1];
        if (!campaign) continue;
        const campaignId = campaignIdOf(campaign);
        const currentBudget = finite(campaign.daily_budget || campaign.budget);
        if (currentBudget <= 0) continue;

        let targetBudget = currentBudget;
        let action = '';
        let reasonCode = '';
        if (underExposed) {
          const desiredAsinBudget = Math.max(minCampaignBudget, accountBudget * floorShare);
          const maxStep = currentBudget * 1.10;
          targetBudget = roundMoney(Math.min(maxCampaignBudget, maxStep, Math.max(currentBudget, desiredAsinBudget)));
          if (targetBudget <= currentBudget + 0.01) continue;
          action = 'increase_budget';
          reasonCode = 'ASIN_EXPLORATION_FLOOR';
        } else {
          const reduction = currentShare >= shareCap * 1.5 ? 0.20 : 0.10;
          targetBudget = roundMoney(Math.max(minCampaignBudget, currentBudget * (1 - reduction)));
          if (targetBudget >= currentBudget - 0.01) continue;
          action = 'reduce_budget';
          reasonCode = 'ASIN_PORTFOLIO_CONCENTRATION';
        }

        const key = `ASIN_DIVERSIFY|${accountId}|${row.asin}|${campaignId}|${action}|${today}|${targetBudget.toFixed(2)}`;
        if (priorDecisions.some((decision: any) => decision.idempotency_key === key && !['failed', 'cancelled', 'rejected', 'skipped'].includes(String(decision.status || '')))) continue;
        if (body.dry_run === true) {
          decisions.push({ asin: row.asin, campaign_id: campaignId, action, current_budget: currentBudget, target_budget: targetBudget, dry_run: true });
          continue;
        }

        const decision = await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id: accountId,
          decision_type: 'budget_optimization',
          entity_type: 'campaign',
          entity_id: campaignId,
          campaign_id: campaignId,
          campaign_name: campaign.name || campaign.campaign_name || null,
          action,
          canonical_action_type: 'CAMPAIGN_BUDGET_CHANGE',
          rationale: underExposed
            ? `ASIN ${row.asin} elegível recebeu ${(currentShare * 100).toFixed(1)}% do gasto, abaixo do piso exploratório ${(floorShare * 100).toFixed(1)}%. Aumento limitado a 10% para gerar oportunidade de aprendizado sem romper ACoS/MER.`
            : `ASIN ${row.asin} concentrou ${(currentShare * 100).toFixed(1)}% do gasto, acima do teto ${(shareCap * 100).toFixed(1)}%, sem proteção econômica suficiente. Redução libera capital para outros ASINs elegíveis.`,
          rule_key: reasonCode,
          reason_code: reasonCode,
          value_before: currentBudget,
          value_after: targetBudget,
          confidence: underExposed ? 0.82 : 0.94,
          risk: underExposed ? 'low' : 'medium',
          requires_approval: false,
          approval_status: 'auto_approved_deterministic',
          status: 'approved',
          queue_status: 'pending',
          priority_class: overConcentrated ? 'P1' : 'P2',
          execution_mode: 'STANDARD_QUEUE',
          confirmation_required: true,
          confirmation_status: 'pending',
          requires_fresh_data: true,
          maximum_data_age_minutes: 45,
          idempotency_key: key,
          conflict_group: `${accountId}|campaign|${campaignId}`,
          source_function: SOURCE,
          data_used: JSON.stringify({ asin: row.asin, total_spend: totalSpend, asin_spend: row.spend, asin_sales: row.sales, asin_orders: row.orders, asin_acos: acos, current_share: currentShare, floor_share: floorShare, cap_share: shareCap, exploration_pool_share: explorationPoolShare, target_acos: targetAcos }),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        decisions.push({ asin: row.asin, campaign_id: campaignId, action, current_budget: currentBudget, target_budget: targetBudget, decision_id: decision.id });
      }

      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: accountId,
        sync_type: 'asin_portfolio_diversification',
        status: 'completed',
        source_function: SOURCE,
        records_processed: rows.length,
        records_imported: decisions.length,
        message: `Diversificação automática: ${eligibleForExploration.length} ASIN(s) elegíveis, piso ${(floorShare * 100).toFixed(1)}% por ASIN, teto ${(maxAsinShare * 100).toFixed(1)}% e ${decisions.length} decisão(ões).`,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      }).catch(() => null);

      results.push({ amazon_account_id: accountId, total_spend: roundMoney(totalSpend), eligible_asins: eligibleForExploration.length, exploration_pool_share: explorationPoolShare, floor_share_per_asin: floorShare, max_asin_share: maxAsinShare, max_winner_share: maxWinnerShare, observations, decisions });
    }

    return Response.json({ ok: true, engine: 'ASIN_PORTFOLIO_DIVERSIFICATION_V1', automatic: true, ui_required: false, results });
  } catch (error: any) {
    return Response.json({ ok: false, engine: 'ASIN_PORTFOLIO_DIVERSIFICATION_V1', error: error?.message || String(error) }, { status: 500 });
  }
});
