import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const CAMPAIGN_DEPENDENT = new Set([
  'repair_campaign', 'pause_campaign', 'budget_change', 'update_budget',
  'increase_budget', 'reduce_budget', 'set_bid', 'update_bid', 'increase_bid',
  'reduce_bid', 'bid_change', 'bid_increase', 'bid_decrease',
]);
const OPEN = ['planned', 'proposed', 'pending', 'approved', 'queued', 'scheduled', 'waiting_retry', 'blocked'];
const ACTIVE_MUTATION = new Set([...OPEN, 'executing', 'confirming', 'awaiting_confirmation', 'propagating']);
const BID_ACTIONS = new Set(['set_bid', 'update_bid', 'increase_bid', 'reduce_bid', 'bid_change', 'bid_increase', 'bid_decrease']);
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

      let resolved = 0, missing = 0, ambiguous = 0, duplicatesClosed = 0, failuresClosed = 0;
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

      // Uma única mutação aberta por entidade. Prioriza o que já chegou à
      // Amazon; propostas duplicadas são encerradas antes do executor.
      const rank: Record<string, number> = { confirming: 0, awaiting_confirmation: 0, propagating: 0, executing: 1, approved: 2, pending: 3, queued: 3, scheduled: 4, waiting_retry: 4, proposed: 5, planned: 6, blocked: 7 };
      const groups = new Map<string, any[]>();
      for (const decision of decisions) {
        const status = String(decision.status || decision.queue_status || '').toLowerCase();
        const action = String(decision.action || decision.decision_type || '').toLowerCase();
        if (!ACTIVE_MUTATION.has(status)) continue;
        let key = '';
        if (action === 'pause_campaign') key = `pause|${campaignId(decision) || asinOf(decision)}`;
        else if (BID_ACTIONS.has(action)) {
          const entity = String(decision.keyword_id || decision.target_id || decision.ad_group_id || decision.entity_id || '').trim();
          key = entity ? `bid|${String(decision.entity_type || 'keyword').toLowerCase()}|${entity}` : '';
        }
        if (!key || key.endsWith('|')) continue;
        groups.set(key, [...(groups.get(key) || []), decision]);
      }
      for (const rows of groups.values()) {
        if (rows.length < 2) continue;
        rows.sort((a: any, b: any) => (rank[String(a.status || a.queue_status || '').toLowerCase()] ?? 9)
          - (rank[String(b.status || b.queue_status || '').toLowerCase()] ?? 9)
          || new Date(b.updated_at || b.created_at || 0).getTime() - new Date(a.updated_at || a.created_at || 0).getTime());
        const keeper = rows[0];
        for (const duplicate of rows.slice(1)) {
          await client.asServiceRole.entities.OptimizationDecision.update(duplicate.id, {
            status: 'superseded', queue_status: 'closed', approval_status: 'superseded_duplicate_v4',
            confirmation_status: 'not_applicable', confirmation_required: false,
            reason_code: 'NO_DECISION_DUPLICATE_ACTIVE_MUTATION',
            error_message: `Duplicada; decisão canônica ativa ${keeper.id} preservada.`,
            hide_from_live_operational_feed: true, updated_at: new Date().toISOString(),
          }).catch(() => {});
          duplicatesClosed++;
        }
      }

      // Falhas continuam no histórico, mas não fingem ser atividade atual.
      for (const decision of decisions) {
        const status = String(decision.status || decision.queue_status || '').toLowerCase();
        if (!['failed', 'failed_final', 'error'].includes(status)) continue;
        const message = String(decision.error_message || decision.confirmation_error || '');
        const obsolete = /entity.?not.?found|keyword.*(not found|does not exist)|invalid keywordid|404/i.test(message);
        await client.asServiceRole.entities.OptimizationDecision.update(decision.id, obsolete ? {
          status: 'cancelled', queue_status: 'closed', confirmation_status: 'not_applicable',
          confirmation_required: false, reason_code: 'NO_DECISION_ENTITY_NOT_FOUND',
          hide_from_live_operational_feed: true, updated_at: new Date().toISOString(),
        } : { hide_from_live_operational_feed: true, updated_at: new Date().toISOString() }).catch(() => {});
        failuresClosed++;
      }
      results.push({ amazon_account_id: aid, resolved, missing, ambiguous, duplicates_closed: duplicatesClosed, failures_closed_from_live_feed: failuresClosed });
    }
    return Response.json({ ok: true, engine: 'CANONICAL_PROFIT_ENGINE_V4', results });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});
