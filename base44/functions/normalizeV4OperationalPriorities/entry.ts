import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const CAMPAIGN_DEPENDENT = new Set([
  'repair_campaign', 'pause_campaign', 'budget_change', 'update_budget',
  'increase_budget', 'reduce_budget', 'set_bid', 'update_bid', 'increase_bid',
  'reduce_bid', 'bid_change', 'bid_increase', 'bid_decrease',
]);
const OPEN = ['planned', 'proposed', 'pending', 'approved', 'queued', 'scheduled', 'waiting_retry', 'blocked'];
const campaignId = (row: any) => String(row?.amazon_campaign_id || row?.campaign_id || '').trim();
const asinOf = (row: any) => String(row?.asin || row?.advertised_asin || '').trim().toUpperCase();

Deno.serve(async (request) => {
  try {
    const client = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await client.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const accounts = body.amazon_account_id
      ? await client.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1)
      : await client.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 50);
    const results: any[] = [];

    for (const account of accounts) {
      const aid = String(account.id);
      // Amazon truth primeiro; a resolução abaixo nunca confia apenas no registro antigo.
      await client.asServiceRole.functions.invoke('syncAdsCampaignStatesV2', {
        amazon_account_id: aid, _service_role: true, trigger_type: 'v4_campaign_id_normalization',
      }).catch(() => null);

      const [campaigns, decisions] = await Promise.all([
        client.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-updated_at', 10000).catch(() => []),
        client.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: aid }, '-updated_at', 10000).catch(() => []),
      ]);
      const byAsin = new Map<string, Map<string, any>>();
      for (const campaign of campaigns) {
        const asin = asinOf(campaign);
        const id = campaignId(campaign);
        if (!asin || !id) continue;
        const state = String(campaign.state || campaign.status || '').toLowerCase();
        if (['archived', 'deleted'].includes(state)) continue;
        if (!byAsin.has(asin)) byAsin.set(asin, new Map());
        byAsin.get(asin)!.set(id, campaign);
      }

      let resolved = 0, missing = 0, ambiguous = 0;
      for (const decision of decisions) {
        const status = String(decision.status || decision.queue_status || '').toLowerCase();
        const action = String(decision.action || decision.decision_type || '').toLowerCase();
        if (!OPEN.includes(status) || !CAMPAIGN_DEPENDENT.has(action) || campaignId(decision)) continue;
        const matches = [...(byAsin.get(asinOf(decision))?.keys() || [])];
        const now = new Date().toISOString();
        if (matches.length === 1) {
          await client.asServiceRole.entities.OptimizationDecision.update(decision.id, {
            campaign_id: matches[0], amazon_campaign_id: matches[0], status: 'superseded', queue_status: 'closed',
            approval_status: 'campaign_id_resolved_recalculate_v4', confirmation_status: 'not_applicable',
            confirmation_required: false, reason_code: 'CAMPAIGN_ID_RESOLVED_RECALCULATE',
            error_message: 'Campanha única resolvida pela verdade Amazon; proposta antiga encerrada para recálculo V4.',
            hide_from_live_operational_feed: true, updated_at: now,
          });
          resolved++;
        } else {
          const reason = matches.length === 0 ? 'NO_DECISION_CAMPAIGN_NOT_FOUND' : 'NO_DECISION_CAMPAIGN_ID_AMBIGUOUS';
          await client.asServiceRole.entities.OptimizationDecision.update(decision.id, {
            status: 'cancelled', queue_status: 'closed', approval_status: reason.toLowerCase(),
            confirmation_status: 'not_applicable', confirmation_required: false, reason_code: reason,
            error_message: reason, hide_from_live_operational_feed: true, updated_at: now,
          });
          matches.length === 0 ? missing++ : ambiguous++;
        }
      }
      results.push({ amazon_account_id: aid, resolved, missing, ambiguous });
    }
    return Response.json({ ok: true, engine: 'CANONICAL_PROFIT_ENGINE_V4', results });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});
