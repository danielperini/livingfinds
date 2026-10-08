import { economicsAreActionable, resolveOperatingAcos, resolveSafeMaxCpc } from '../../shared/profitGuardPolicy.ts';
import { availableAdsStock, hasFreshAdsInventory } from '../../shared/stockAdsPolicy.ts';
import { isProductEligibleForCampaignActivation } from '../../shared/productCampaignPauseGuard.ts';
import { verifiedBidEvidence } from '../../shared/verifiedBidEvidence.ts';
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { AMAZON_BID_CEILING_BRL, AMAZON_WINNER_BID_CEILING_BRL } from '../../shared/amazonBidCeiling.ts';

const n = (value: any, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const round2 = (value: number) => Math.round(value * 100) / 100;
const active = (value: unknown) => ['enabled', 'active'].includes(String(value || '').toLowerCase());

Deno.serve(async (req) => {
  const now = new Date();
  try {
    const base44 = createClientFromRequest(req);
    const payload = await req.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !payload._service_role) {
      return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const dryRun = payload.dry_run === true;
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
        const [settingsRows, legacyRows, keywords, campaigns, products, economics, recentChanges, searchTerms] = await Promise.all([
          base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: account.id }, '-updated_at', 1).catch(() => []),
          base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: account.id }, '-updated_at', 1).catch(() => []),
          base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: account.id, state: 'enabled' }, '-spend', 2000).catch(() => []),
          base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: account.id }, undefined, 5000).catch(() => []),
          base44.asServiceRole.entities.Product.filter({ amazon_account_id: account.id }, undefined, 5000).catch(() => []),
          base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: account.id }, '-updated_at', 5000).catch(() => []),
          base44.asServiceRole.entities.AdsBidChangeLog.filter({ amazon_account_id: account.id }, '-created_at', 5000).catch(() => []),
          base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: account.id }, '-date', 20000),
        ]);

        const settings = settingsRows[0] || {};
        const legacy = legacyRows[0] || {};
        const accountTargetAcos = n(settings.target_acos ?? settings.acos_target ?? legacy.target_acos ?? legacy.acos_target, 10);
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
        const evidence = verifiedBidEvidence(searchTerms);
        const lastChangedAt = new Map<string, number>();
        for (const row of recentChanges) {
          const id = String(row.keyword_id || '');
          const ts = new Date(row.created_at || row.created_date || 0).getTime();
          if (!id || !Number.isFinite(ts)) continue;
          if (ts > (lastChangedAt.get(id) || 0)) lastChangedAt.set(id, ts);
        }

        const seenKeywordIds = new Set<string>();
        summary.keywords_analyzed += keywords.length;
        for (const kw of keywords) {
          const keywordId = String(kw.keyword_id || '');
          if (!keywordId || seenKeywordIds.has(keywordId)) { summary.skipped_insufficient_data++; continue; }
          seenKeywordIds.add(keywordId);
          if (summary.adjustments.length >= Math.max(1, Math.min(50, n(payload.max_actions,20)))) break;
          const campaignId = String(kw.campaign_id || '');
          const state = campaignState.get(campaignId);
          if (!state || !active(state)) { summary.skipped_insufficient_data++; continue; }

          const evidenceMatches = evidence.filter(row => row.keywordId === keywordId && row.campaignId === campaignId);
          if (evidenceMatches.length !== 1) { summary.skipped_insufficient_data++; continue; }
          const metrics = evidenceMatches[0];
          const asin = metrics.asin;
          const matches = (row:any) => String(row.asin || '').toUpperCase() === asin && String(row.sku || '').trim().toUpperCase() === metrics.sku;
          const productMatches = products.filter((p:any) => p.status !== 'archived' && p.catalog_sync_status !== 'duplicate' && matches(p));
          const econMatches = economics.filter(matches);
          const product = productMatches.length === 1 ? productMatches[0] : null;
          const econ = econMatches.length === 1 ? econMatches[0] : null;
          if (!product || !econ || !hasFreshAdsInventory(product) || availableAdsStock(product) <= 0 || !isProductEligibleForCampaignActivation(product) || !economicsAreActionable(econ)) {
            summary.skipped_insufficient_data++; continue;
          }
          const feeAge = Date.now() - Date.parse(econ.fees_verified_at || '');
          if (econ.fees_source !== 'sp_api_product_fees' || !Number.isFinite(feeAge) || feeAge < 0 || feeAge > 24*3600000) { summary.skipped_insufficient_data++; continue; }
          const targetAcos = resolveOperatingAcos(econ, accountTargetAcos).target_acos;
          const {clicks,orders,spend,sales} = metrics;
          const cpc = clicks > 0 ? spend / clicks : 0;
          const acos = sales > 0 ? spend / sales * 100 : null;
          if (spend <= 0 || cpc <= 0) { summary.skipped_insufficient_data++; continue; }
          const winner = orders >= 1 && acos !== null && acos <= targetAcos;
          const matureAcos = metrics.matureSales > 0 ? metrics.matureSpend / metrics.matureSales * 100 : null;
          const clearlyUnprofitable = (metrics.matureOrders > 0 && matureAcos !== null && matureAcos > targetAcos * 1.2)
            || (metrics.matureOrders === 0 && metrics.matureSpend >= noSaleSpendThreshold);
          const canIncrease = winner && clicks >= minClicksWinner;
          const canReduce = !winner && clearlyUnprofitable && metrics.matureClicks >= minClicksReduce;
          if (!canIncrease && !canReduce) { summary.skipped_within_target++; continue; }
          // Read the actual bid and parent state before any write; stale local values are not a baseline.
          const read = async (path:string, data:any, type:string) => {
            const result = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
              amazon_account_id: account.id, operation:'verify_economic_bid_state', method:'POST',path,payload:data,
              content_type:`application/vnd.${type}.v3+json`,accept:`application/vnd.${type}.v3+json`,_service_role:true,
            });
            const response = result?.data || result;
            if (response?.ok !== true) throw new Error('Amazon bid state unavailable');
            return response.payload;
          };
          const campaignRemote = await read('/sp/campaigns/list',{campaignIdFilter:{include:[campaignId]},maxResults:100},'spCampaign');
          if (!active(campaignRemote?.campaigns?.find((c:any)=>String(c.campaignId)===campaignId)?.state)) continue;
          const keywordRemote = await read('/sp/keywords/list',{keywordIdFilter:{include:[keywordId]},maxResults:100},'spKeyword');
          const remote = keywordRemote?.keywords?.find((k:any)=>String(k.keywordId)===keywordId && String(k.campaignId)===campaignId);
          if (!active(remote?.state) || !(Number(remote.bid)>0)) continue;
          const currentBid = Number(remote.bid);
          const direction = canIncrease ? 'increase' : 'decrease';
          const lastChange = lastChangedAt.get(keywordId) || 0;
          const cooldownH = direction === 'increase' ? winnerIncreaseCooldownH : reduceCooldownH;
          if (lastChange && (Date.now() - lastChange) / 3600000 < cooldownH) {
            summary.skipped_cooldown++;
            continue;
          }

          const safeCpc = resolveSafeMaxCpc({economics:econ,observedCvr:clicks>0?orders/clicks:0,observedAov:orders>0?sales/orders:0,operatingAcos:targetAcos});
          if (direction === 'increase' && !(safeCpc && safeCpc > 0)) { summary.skipped_economic_ceiling++; continue; }
          const hardCeiling = direction === 'increase' ? winnerCeiling : normalCeiling;
          const economicCeiling = safeCpc !== null ? Math.min(hardCeiling, safeCpc) : hardCeiling;
          let targetBid = currentBid;

          if (direction === 'increase') {
            const growth = 1 + maxIncreasePct / 100;
            targetBid = Math.floor(Math.min(currentBid * growth, economicCeiling) * 100) / 100;
            if (targetBid <= currentBid || targetBid - currentBid < minDelta) {
              summary.skipped_economic_ceiling++;
              continue;
            }
          } else {
            const proportional = orders > 0 && (acos ?? 0) > 0
              ? currentBid * Math.max(0.65, Math.min(0.9, targetAcos / (acos || 1)))
              : currentBid * (1 - maxDecreasePct / 100);
            const maxStepDown = currentBid * (1 - maxDecreasePct / 100);
            targetBid = round2(Math.max(minBid, Math.max(proportional, maxStepDown)));
            if (targetBid >= currentBid || currentBid - targetBid < minDelta) {
              summary.skipped_within_target++;
              continue;
            }
          }

          if (dryRun) { summary.adjustments.push({keyword_id:keywordId,sku:metrics.sku,asin,old_bid:currentBid,new_bid:targetBid,status:'proposed'}); continue; }
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

          if ((gatewayResponse?.data || gatewayResponse)?.ok !== true) {
            const data = gatewayResponse?.data || gatewayResponse || {};
            summary.errors.push(`kw ${keywordId}: ${data.error || data.message || 'gateway_rejected'}`);
            continue;
          }

          // Log acceptance before readback, so a transient GET failure cannot trigger another adjustment.
          const acceptedLog = await base44.asServiceRole.entities.AdsBidChangeLog.create({amazon_account_id:account.id,keyword_id:keywordId,campaign_id:campaignId,asin,sku:metrics.sku,old_bid:currentBid,new_bid:targetBid,status:'confirming',amazon_confirmed:false,created_at:now.toISOString()});
          const confirmedPayload = await read('/sp/keywords/list',{keywordIdFilter:{include:[keywordId]},maxResults:100},'spKeyword');
          const confirmed = confirmedPayload?.keywords?.find((k:any)=>String(k.keywordId)===keywordId);
          if (Number(confirmed?.bid) !== targetBid) { summary.errors.push(`kw ${keywordId}: readback mismatch`); continue; }
          await base44.asServiceRole.entities.Keyword.update(kw.id, {
            current_bid: targetBid,
            bid: targetBid,
            last_seen_at: now.toISOString(),
          }).catch(() => {});
          await base44.asServiceRole.entities.AdsBidChangeLog.update(acceptedLog.id, {
            amazon_confirmed: true,
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
              ? `Winner: ${orders} venda(s), ACoS ${(acos ?? 0).toFixed(1)}% <= meta ${targetAcos}%; +${maxIncreasePct}% limitado por teto econômico R$${economicCeiling.toFixed(2)}.`
              : `Proteção econômica: ${orders} venda(s), ACoS ${(acos ?? 0).toFixed(1)}%, gasto R$${spend.toFixed(2)}; redução máxima ${maxDecreasePct}%.`,
            evidence: `sales_mode=${salesMode} clicks=${clicks} orders=${orders} spend=${spend.toFixed(2)} sales=${sales.toFixed(2)} cpc=${cpc.toFixed(2)} acos=${(acos ?? 0).toFixed(1)} target_acos=${targetAcos} safe_cpc=${safeCpc || 'n/a'} gateway=amazonAdsCommand`,
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
            acos: acos === null ? null : round2(acos),
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
