import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { classifyCampaignDeliveryHealth, nextConservativeBid } from '../../shared/campaignDeliveryHealthPolicy.ts';

const SOURCE = 'reconcileCampaignDeliveryHealth';
const active = (v: unknown) => ['enabled', 'active'].includes(String(v || '').toLowerCase());
const upper = (v: unknown) => String(v || '').trim().toUpperCase();
const n = (v: unknown) => Number.isFinite(Number(v)) ? Number(v) : 0;
const idOf = (c: any) => String(c.amazon_campaign_id || c.campaign_id || c.id || '');

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

    for (const account of accounts) {
      const accountId = String(account.id);
      const [campaigns, keywords, products, metrics, prior, spendControllers] = await Promise.all([
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-created_at', 10000).catch(() => []),
        base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-created_at', 30000).catch(() => []),
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, null, 5000).catch(() => []),
        base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: accountId }, '-date', 5000).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-created_at', 30000).catch(() => []),
        base44.asServiceRole.entities.AccountDailySpendController.filter({ amazon_account_id: accountId }, '-date', 3).catch(() => []),
      ]);
      const productByAsin = new Map(products.filter((p: any) => p.asin).map((p: any) => [upper(p.asin), p]));
      const kwByCampaign = new Map<string, any[]>();
      for (const keyword of keywords) {
        const cid = String(keyword.campaign_id || '');
        if (!kwByCampaign.has(cid)) kwByCampaign.set(cid, []);
        kwByCampaign.get(cid)!.push(keyword);
      }
      const metricsByCampaign = new Map<string, any>();
      for (const row of metrics) {
        const cid = String(row.campaign_id || '');
        const agg = metricsByCampaign.get(cid) || { impressions: 0, clicks: 0, orders: 0, sales: 0, spend: 0 };
        agg.impressions += n(row.impressions); agg.clicks += n(row.clicks); agg.orders += n(row.orders);
        agg.sales += n(row.sales); agg.spend += n(row.spend);
        metricsByCampaign.set(cid, agg);
      }
      const accountOutOfBudget = spendControllers.some((r: any) => r.account_out_of_budget === true || r.hard_cap_reached === true);
      const actions: any[] = [];

      for (const campaign of campaigns) {
        if (!active(campaign.state || campaign.status) || upper(campaign.campaign_type || 'SP') !== 'SP') continue;
        const campaignId = idOf(campaign);
        if (!campaignId) continue;
        const asin = upper(campaign.asin || campaign.advertised_asin);
        const product = productByAsin.get(asin);
        const stock = n(product?.fulfillable_quantity ?? product?.inventory_quantity ?? product?.stock);
        const campaignKeywords = kwByCampaign.get(campaignId) || [];
        const manual = upper(campaign.targeting_type) === 'MANUAL' || upper(campaign.name || campaign.campaign_name).includes('| MANUAL |');
        const complete = manual
          ? campaignKeywords.some((k: any) => active(k.state || k.status) && upper(k.match_type || k.matchType) === 'EXACT')
          : true;
        const createdAt = new Date(campaign.created_at || campaign.created_date || Date.now()).getTime();
        const ageHours = Math.max(0, (Date.now() - createdAt) / 3600000);
        const m = metricsByCampaign.get(campaignId) || { impressions: 0, clicks: 0, orders: 0, sales: 0, spend: 0 };
        const priorEscalations = prior.filter((d: any) => d.source_function === SOURCE && String(d.campaign_id || '') === campaignId && d.action === 'set_bid').length;
        const action = classifyCampaignDeliveryHealth({
          ageHours, ...m, complete, hasProduct: !!product, inStock: stock > 0,
          protectedWinner: campaign.protected_high_performance === true,
          accountOutOfBudget, priorBidEscalations,
        });

        if (action === 'REPAIR_STRUCTURE') {
          actions.push({ campaign_id: campaignId, action, delegated_to: 'enforceCanonicalManualCampaigns' });
          continue;
        }
        if (action === 'ARCHIVE_NO_PRODUCT' || action === 'ARCHIVE_OUT_OF_STOCK') {
          const key = `${SOURCE}|${accountId}|${campaignId}|${action}`;
          if (!prior.some((d: any) => d.idempotency_key === key)) {
            await base44.asServiceRole.entities.OptimizationDecision.create({
              amazon_account_id: accountId, decision_type: 'campaign_delivery_health', entity_type: 'campaign',
              entity_id: campaignId, campaign_id: campaignId, action: 'archive_campaign',
              rationale: action, rule_key: action, reason_code: action, status: 'pending_approval',
              requires_approval: true, approval_status: 'manual_review_required', idempotency_key: key,
              source_function: SOURCE, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            });
          }
          actions.push({ campaign_id: campaignId, action });
          continue;
        }
        if (action === 'INCREASE_BID') {
          const activeExact = campaignKeywords.find((k: any) => active(k.state || k.status) && upper(k.match_type || k.matchType) === 'EXACT');
          if (!activeExact) continue;
          const currentBid = n(activeExact.bid ?? activeExact.current_bid);
          const maxBid = Math.max(currentBid, n(activeExact.max_bid || campaign.max_bid || currentBid * 1.2));
          const targetBid = nextConservativeBid(currentBid, maxBid);
          const key = `${SOURCE}|${accountId}|${campaignId}|${activeExact.keyword_id || activeExact.id}|${priorEscalations}`;
          if (!prior.some((d: any) => d.idempotency_key === key)) {
            await base44.asServiceRole.entities.OptimizationDecision.create({
              amazon_account_id: accountId, decision_type: 'campaign_delivery_health', entity_type: 'keyword',
              entity_id: activeExact.keyword_id || activeExact.id, keyword_id: activeExact.keyword_id || activeExact.id,
              campaign_id: campaignId, action: 'set_bid', value_before: currentBid, value_after: targetBid,
              current_value: currentBid, proposed_value: targetBid, rationale: 'ZERO_DELIVERY_AFTER_72H',
              rule_key: 'ZERO_DELIVERY_BID_ESCALATION', reason_code: 'ZERO_DELIVERY_BID_ESCALATION',
              status: 'approved', queue_status: 'pending', execution_mode: 'STANDARD_QUEUE',
              confirmation_required: true, confirmation_status: 'pending', requires_approval: false,
              approval_status: 'auto_approved', idempotency_key: key,
              conflict_group: `${accountId}|keyword|${activeExact.keyword_id || activeExact.id}`,
              source_function: SOURCE, model_version: 'campaign-delivery-health-v1',
              data_used: JSON.stringify({ age_hours: ageHours, impressions: m.impressions, clicks: m.clicks, prior_escalations: priorEscalations }),
              created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            });
          }
          actions.push({ campaign_id: campaignId, action, current_bid: currentBid, target_bid: targetBid });
          continue;
        }
        if (action === 'PAUSE_AND_REPLACE') {
          const key = `${SOURCE}|${accountId}|${campaignId}|pause_replace`;
          if (!prior.some((d: any) => d.idempotency_key === key)) {
            await base44.asServiceRole.entities.OptimizationDecision.create({
              amazon_account_id: accountId, decision_type: 'campaign_delivery_health', entity_type: 'campaign',
              entity_id: campaignId, campaign_id: campaignId, action: 'pause_campaign',
              rationale: 'ZERO_DELIVERY_AFTER_3_BID_TESTS_REPLACE_TERM', rule_key: 'ZERO_DELIVERY_REPLACE',
              reason_code: 'ZERO_DELIVERY_REPLACE', status: 'pending_approval', requires_approval: true,
              approval_status: 'manual_review_required', idempotency_key: key, source_function: SOURCE,
              created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            });
          }
          actions.push({ campaign_id: campaignId, action });
        }
      }

      const repair = actions.some((a) => a.action === 'REPAIR_STRUCTURE')
        ? await base44.asServiceRole.functions.invoke('enforceCanonicalManualCampaigns', {
            amazon_account_id: accountId, _service_role: true, trigger_type: 'campaign_delivery_health_repair',
          }).catch((error: any) => ({ error: error?.message || String(error) }))
        : null;
      results.push({ amazon_account_id: accountId, account_out_of_budget: accountOutOfBudget, actions, repair: repair?.data || repair || null });
    }

    return Response.json({ ok: true, engine: 'campaign-delivery-health-v1', results });
  } catch (error: any) {
    return Response.json({ ok: false, engine: 'campaign-delivery-health-v1', error: error?.message || 'Falha na reconciliação de entrega' }, { status: 500 });
  }
});
