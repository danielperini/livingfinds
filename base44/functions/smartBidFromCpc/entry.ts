import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { AMAZON_BID_CEILING_BRL, AMAZON_WINNER_BID_CEILING_BRL } from '../../shared/amazonBidCeiling.ts';

const n = (value: any, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const round2 = (value: number) => Math.round(value * 100) / 100;
const active = (value: unknown) => ['enabled', 'active'].includes(String(value || '').toLowerCase());

function inventoryAvailable(product: any): number {
  return Math.max(0, n(product?.fba_inventory ?? product?.inventory_quantity ?? product?.quantity ?? product?.stock, 0));
}

function gatewayOk(response: any): boolean {
  const data = response?.data || response || {};
  if (data?.ok === true) return true;
  const status = n(data?.status || data?.status_code || data?.http_status, 0);
  return status === 200 || status === 207;
}

Deno.serve(async (req) => {
  const now = new Date();
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !payload._service_role) {
      return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const salesMode = payload.sales_mode === true || /sales_mode/i.test(String(payload.trigger_type || ''));
    const accounts = payload.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: payload.amazon_account_id }, undefined, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 50);

    const summary: any = {
      accounts_processed: 0,
      keywords_analyzed: 0,
      keywords_adjusted: 0,
      increases: 0,
      decreases: 0,
      skipped_cooldown: 0,
      skipped_insufficient_data: 0,
      skipped_within_target: 0,
      skipped_economic_ceiling: 0,
      errors: [],
      adjustments: [],
    };

    for (const account of accounts) {
      try {
        const [settingsRows, legacyRows, keywords, campaigns, products, assessments, economics, recentChanges] = await Promise.all([
          base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: account.id }, '-updated_at', 1).catch(() => []),
          base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: account.id }, '-updated_at', 1).catch(() => []),
          base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: account.id, state: 'enabled' }, '-spend', 2000).catch(() => []),
          base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: account.id }, undefined, 5000).catch(() => []),
          base44.asServiceRole.entities.Product.filter({ amazon_account_id: account.id }, undefined, 5000).catch(() => []),
          base44.asServiceRole.entities.DailyProductAdsAssessment.filter({ amazon_account_id: account.id }, '-assessment_date', 5000).catch(() => []),
          base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: account.id }, '-updated_at', 5000).catch(() => []),
          base44.asServiceRole.entities.AdsBidChangeLog.filter({ amazon_account_id: account.id }, '-created_at', 5000).catch(() => []),
        ]);

        const settings = settingsRows[0] || {};
        const legacy = legacyRows[0] || {};
        const targetAcos = n(settings.target_acos ?? settings.acos_target ?? legacy.target_acos ?? legacy.acos_target, 10);
        const configuredMin = Math.max(0.02, n(settings.min_bid ?? legacy.min_bid, 0.4));
        const configuredMax = Math.max(configuredMin, n(settings.max_bid ?? settings.max_cpc ?? legacy.max_bid, AMAZON_WINNER_BID_CEILING_BRL));
        const minBid = configuredMin;
        const normalCeiling = Math.min(configuredMax, AMAZON_BID_CEILING_BRL);
        const winnerCeiling = Math.min(configuredMax, AMAZON_WINNER_BID_CEILING_BRL);
        const maxIncreasePct = Math.min(25, Math.max(5, n(settings.max_bid_increase_pct, salesMode ? 15 : 10)));
        const maxDecreasePct = Math.min(35, Math.max(10, n(settings.max_bid_decrease_pct, 20)));
        const minDelta = Math.max(0.02, n(settings.bid_increment ?? legacy.bid_increment, 0.05));
        const noSaleSpendThreshold = Math.max(5, n(legacy.min_spend_for_decision, 8));
        const reduceCooldownH = salesMode ? 24 : 72;
        const winnerIncreaseCooldownH = salesMode ? 24 : 72;
        const minClicksReduce = Math.max(5, n(payload.min_clicks_reduce, 10));
        const minClicksWinner = Math.max(1, n(payload.min_clicks_winner, salesMode ? 2 : 3));

        const campaignState = new Map<string, string>();
        for (const campaign of campaigns) {
          const state = String(campaign.state || campaign.status || '').toLowerCase();
          for (const id of [campaign.campaign_id, campaign.amazon_campaign_id, campaign.id].filter(Boolean)) {
            campaignState.set(String(id), state);
          }
        }
        const productByAsin = new Map(products.filter((p: any) => p.asin).map((p: any) => [String(p.asin).toUpperCase(), p]));
        const safeCpcByAsin = new Map<string, number>();
        for (const row of economics) {
          const asin = String(row.asin || '').toUpperCase();
          const safe = n(row.safe_max_cpc ?? row.maximum_economic_cpc, 0);
          if (asin && safe > 0) safeCpcByAsin.set(asin, safe);
        }
        for (const row of assessments) {
          const asin = String(row.asin || '').toUpperCase();
          const safe = n(row.safe_max_cpc ?? row.maximum_economic_cpc, 0);
          if (asin && safe > 0) safeCpcByAsin.set(asin, safe);
        }
        const lastChangedAt = new Map<string, number>();
        for (const row of recentChanges) {
          const id = String(row.keyword_id || '');
          const ts = new Date(row.created_at || row.created_date || 0).getTime();
          if (!id || !Number.isFinite(ts)) continue;
          if (ts > (lastChangedAt.get(id) || 0)) lastChangedAt.set(id, ts);
        }

        summary.keywords_analyzed += keywords.length;
        for (const kw of keywords) {
          const keywordId = String(kw.keyword_id || '');
          if (!keywordId) { summary.skipped_insufficient_data++; continue; }
          const campaignId = String(kw.campaign_id || '');
          const state = campaignState.get(campaignId);
          if (state && !active(state)) { summary.skipped_insufficient_data++; continue; }

          const asin = String(kw.asin || '').toUpperCase();
          const product = asin ? productByAsin.get(asin) : null;
          if (product && (String(product.inventory_status || '').toLowerCase() === 'out_of_stock' || inventoryAvailable(product) <= 0)) {
            summary.skipped_insufficient_data++;
            continue;
          }

          const clicks = n(kw.clicks, 0);
          const orders = n(kw.orders, 0);
          const spend = n(kw.spend, 0);
          const sales = n(kw.sales, 0);
          const cpc = n(kw.cpc, clicks > 0 ? spend / clicks : 0);
          const currentBid = n(kw.current_bid ?? kw.bid, minBid);
          const acos = n(kw.acos, sales > 0 ? (spend / sales) * 100 : 0);
          if (spend <= 0 || cpc <= 0) { summary.skipped_insufficient_data++; continue; }

          const winner = orders >= 1 && sales > 0 && acos > 0 && acos <= targetAcos;
          const clearlyUnprofitable = (orders > 0 && acos > targetAcos * 1.2) || (orders === 0 && spend >= noSaleSpendThreshold);
          const canIncrease = winner && clicks >= minClicksWinner;
          const canReduce = clearlyUnprofitable && clicks >= minClicksReduce;
          if (!canIncrease && !canReduce) { summary.skipped_within_target++; continue; }

          const direction = canIncrease ? 'increase' : 'decrease';
          const lastChange = lastChangedAt.get(keywordId) || 0;
          const cooldownH = direction === 'increase' ? winnerIncreaseCooldownH : reduceCooldownH;
          if (lastChange && (Date.now() - lastChange) / 3600000 < cooldownH) {
            summary.skipped_cooldown++;
            continue;
          }

          const safeCpc = safeCpcByAsin.get(asin) || 0;
          const hardCeiling = direction === 'increase' ? winnerCeiling : normalCeiling;
          const economicCeiling = safeCpc > 0 ? Math.min(hardCeiling, safeCpc) : hardCeiling;
          let targetBid = currentBid;

          if (direction === 'increase') {
            const growth = 1 + maxIncreasePct / 100;
            targetBid = round2(Math.min(currentBid * growth, economicCeiling));
            if (targetBid <= currentBid || targetBid - currentBid < minDelta) {
              summary.skipped_economic_ceiling++;
              continue;
            }
          } else {
            const proportional = orders > 0 && acos > 0
              ? currentBid * Math.max(0.65, Math.min(0.9, targetAcos / acos))
              : currentBid * (1 - maxDecreasePct / 100);
            const maxStepDown = currentBid * (1 - maxDecreasePct / 100);
            targetBid = round2(Math.max(minBid, Math.max(proportional, maxStepDown)));
            if (targetBid >= currentBid || currentBid - targetBid < minDelta) {
              summary.skipped_within_target++;
              continue;
            }
          }

          const gatewayResponse = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
            amazon_account_id: account.id,
            operation: direction === 'increase' ? 'sales_mode_winner_bid_increase' : 'economic_bid_reduction',
            method: 'PUT',
            path: '/sp/keywords',
            payload: { keywords: [{ keywordId, bid: targetBid }] },
            content_type: 'application/vnd.spKeyword.v3+json',
            accept: 'application/vnd.spKeyword.v3+json',
            max_attempts: 3,
            _service_role: true,
          }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));

          if (!gatewayOk(gatewayResponse)) {
            const data = gatewayResponse?.data || gatewayResponse || {};
            summary.errors.push(`kw ${keywordId}: ${data.error || data.message || 'gateway_rejected'}`);
            continue;
          }

          await base44.asServiceRole.entities.Keyword.update(kw.id, {
            current_bid: targetBid,
            bid: targetBid,
            last_seen_at: now.toISOString(),
          }).catch(() => {});
          await base44.asServiceRole.entities.AdsBidChangeLog.create({
            amazon_account_id: account.id,
            keyword_id: keywordId,
            keyword: kw.keyword_text || kw.keyword || '',
            campaign_id: campaignId,
            asin,
            old_bid: currentBid,
            new_bid: targetBid,
            change_amount: round2(targetBid - currentBid),
            change_percent: round2(((targetBid - currentBid) / Math.max(currentBid, 0.01)) * 100),
            direction,
            reason: direction === 'increase'
              ? `Winner: ${orders} venda(s), ACoS ${acos.toFixed(1)}% <= meta ${targetAcos}%; +${maxIncreasePct}% limitado por teto econômico R$${economicCeiling.toFixed(2)}.`
              : `Proteção econômica: ${orders} venda(s), ACoS ${acos.toFixed(1)}%, gasto R$${spend.toFixed(2)}; redução máxima ${maxDecreasePct}%.`,
            evidence: `sales_mode=${salesMode} clicks=${clicks} orders=${orders} spend=${spend.toFixed(2)} sales=${sales.toFixed(2)} cpc=${cpc.toFixed(2)} acos=${acos.toFixed(1)} target_acos=${targetAcos} safe_cpc=${safeCpc || 'n/a'} gateway=amazonAdsCommand`,
            ai_confidence: winner ? 90 : 80,
            risk_level: 'low',
            status: 'executed',
            created_at: now.toISOString(),
          }).catch(() => {});

          summary.keywords_adjusted++;
          if (direction === 'increase') summary.increases++; else summary.decreases++;
          summary.adjustments.push({
            keyword: kw.keyword_text || kw.keyword,
            keyword_id: keywordId,
            asin,
            direction,
            old_bid: currentBid,
            new_bid: targetBid,
            economic_ceiling: economicCeiling,
            acos: round2(acos),
            target_acos: targetAcos,
            orders,
          });
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        summary.accounts_processed++;
      } catch (error: any) {
        summary.errors.push(`Conta ${account.id}: ${error?.message || String(error)}`);
      }
    }

    return Response.json({
      ok: summary.errors.length === 0,
      rule: 'smart_bid_canonical_sales_v2',
      sales_mode: salesMode,
      gateway: 'amazonAdsCommand',
      policy: {
        performance_settings_first: true,
        normal_bid_ceiling_brl: AMAZON_BID_CEILING_BRL,
        winner_bid_ceiling_brl: AMAZON_WINNER_BID_CEILING_BRL,
        winner_requires: 'orders>=1, sales>0, ACoS<=target and minimum clicks',
        economic_ceiling: 'min(configured account cap, canonical winner/normal cap, safe_max_cpc when available)',
        sales_mode_cooldown_hours: 24,
      },
      summary,
      executed_at: now.toISOString(),
    });
  } catch (error: any) {
    return Response.json({ ok: false, rule: 'smart_bid_canonical_sales_v2', error: error?.message || String(error) }, { status: 500 });
  }
});
