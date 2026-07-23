import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const BID_ACTIONS = new Set(['reduce_bid', 'increase_bid', 'update_bid', 'set_bid']);
const OPEN_DECISION_STATUSES = new Set(['pending', 'approved', 'scheduled', 'executing', 'failed']);
const ACTIVE_STATES = new Set(['enabled', 'active']);

function norm(value: any) {
  return String(value || '').toLowerCase().trim();
}

function isActive(value: any) {
  return ACTIVE_STATES.has(norm(value));
}

function qty(product: any) {
  return Number(
    product?.fba_inventory
    ?? product?.available_quantity
    ?? product?.fulfillable_quantity
    ?? product?.stock
    ?? 0
  );
}

function campaignId(row: any) {
  return String(row?.campaign_id || row?.amazon_campaign_id || '');
}

function keywordId(row: any) {
  return String(row?.keyword_id || row?.amazon_keyword_id || row?.id || '');
}

function isManual(campaign: any) {
  const targeting = norm(campaign?.targeting_type || campaign?.targetingType);
  const name = norm(campaign?.name || campaign?.campaign_name);
  return targeting === 'manual' || name.includes('| manual |');
}

function productBlockReason(product: any) {
  if (!product) return 'product_missing';
  const status = norm(product.status || product.product_status || product.listing_status);
  if (['inactive', 'archived', 'deleted', 'suppressed'].includes(status)) return `product_${status}`;
  if (norm(product.inventory_status) === 'out_of_stock' || qty(product) <= 0) return 'out_of_stock';
  const scope = norm(product.ads_scope_status);
  if (scope && scope !== 'authorized') return `ads_scope_${scope}`;
  const eligibility = norm(product.ads_eligibility_status);
  if (eligibility && eligibility !== 'eligible') return `ads_eligibility_${eligibility}`;
  return null;
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    let accountId = body.amazon_account_id || null;
    if (!accountId) {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 1).catch(() => []);
      accountId = accounts[0]?.id || null;
    }
    if (!accountId) return Response.json({ ok: false, error: 'AmazonAccount conectada não encontrada' }, { status: 404 });

    // Atualiza primeiro os estados persistidos. Falha de sync não apaga nem invalida dados anteriores;
    // apenas faz a auditoria com o último estado persistido disponível.
    let syncResult: any = null;
    if (body.skip_sync !== true) {
      syncResult = await base44.asServiceRole.functions.invoke('syncAdsCampaignStatesV2', {
        amazon_account_id: accountId,
        _service_role: true,
      }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
    }

    const [campaigns, products, keywords, lifecycles, decisions] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-updated_at', 20000).catch(() => []),
      base44.asServiceRole.entities.ManualCampaignBidLifecycle.filter({ amazon_account_id: accountId }, '-updated_at', 10000).catch(() => []),
      base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-created_at', 5000).catch(() => []),
    ]);

    const campaignById = new Map<string, any>();
    for (const campaign of campaigns) {
      const id = campaignId(campaign);
      if (id) campaignById.set(id, campaign);
    }
    const productByAsin = new Map(products.filter((p: any) => p.asin).map((p: any) => [String(p.asin), p]));
    const keywordById = new Map<string, any>();
    const enabledKeywordsByGroup = new Map<string, any[]>();
    for (const keyword of keywords) {
      const id = keywordId(keyword);
      if (id) keywordById.set(id, keyword);
      if (!isActive(keyword.state || keyword.status)) continue;
      const groupId = String(keyword.ad_group_id || '');
      if (!groupId) continue;
      if (!enabledKeywordsByGroup.has(groupId)) enabledKeywordsByGroup.set(groupId, []);
      enabledKeywordsByGroup.get(groupId)!.push(keyword);
    }

    function scopeReason(campaign: any, keyword: any, asinHint?: string | null) {
      if (!campaign) return 'campaign_missing';
      if (!isActive(campaign.state || campaign.status)) return `campaign_${norm(campaign.state || campaign.status) || 'inactive'}`;
      if (!isManual(campaign)) return 'campaign_not_manual';
      const asin = String(asinHint || keyword?.asin || campaign.asin || '');
      if (!asin) return 'asin_missing';
      const productReason = productBlockReason(productByAsin.get(asin));
      if (productReason) return productReason;
      if (!keyword) return 'keyword_missing';
      if (!isActive(keyword.state || keyword.status)) return `keyword_${norm(keyword.state || keyword.status) || 'inactive'}`;
      if (norm(keyword.match_type || keyword.matchType) !== 'exact') return 'keyword_not_exact';
      const groupId = String(keyword.ad_group_id || '');
      const groupKeywords = groupId ? (enabledKeywordsByGroup.get(groupId) || []) : [];
      if (groupKeywords.length !== 1) return `noncanonical_group_${groupKeywords.length}_active_keywords`;
      return null;
    }

    const now = new Date().toISOString();
    const lifecycleResults: any[] = [];
    let lifecyclesRemoved = 0;
    let lifecycleEligible = 0;

    for (const lifecycle of lifecycles) {
      const campaign = campaignById.get(String(lifecycle.campaign_id || '')) || null;
      const keyword = keywordById.get(String(lifecycle.keyword_id || '')) || null;
      const reason = scopeReason(campaign, keyword, lifecycle.asin || null);
      if (!reason) {
        lifecycleEligible++;
        lifecycleResults.push({ id: lifecycle.id, campaign_id: lifecycle.campaign_id, keyword_id: lifecycle.keyword_id, eligible: true });
        continue;
      }

      const nextStatus = reason === 'out_of_stock' ? 'paused_no_stock' : 'paused_external';
      if (lifecycle.status !== nextStatus || lifecycle.last_action !== 'removed_from_manual_bid_cycle') {
        await base44.asServiceRole.entities.ManualCampaignBidLifecycle.update(lifecycle.id, {
          status: nextStatus,
          management_source: 'unified_decision_engine',
          last_action: 'removed_from_manual_bid_cycle',
          last_action_at: now,
          last_action_result: `Excluído do ciclo de bids: ${reason}`,
          updated_at: now,
        }).catch(() => {});
      }
      lifecyclesRemoved++;
      lifecycleResults.push({ id: lifecycle.id, campaign_id: lifecycle.campaign_id, keyword_id: lifecycle.keyword_id, eligible: false, reason, status: nextStatus });
    }

    let decisionsCancelled = 0;
    const decisionResults: any[] = [];
    for (const decision of decisions) {
      if (!BID_ACTIONS.has(String(decision.action || ''))) continue;
      if (!OPEN_DECISION_STATUSES.has(String(decision.status || ''))) continue;
      if (String(decision.queue_status || '') === 'completed' || String(decision.queue_status || '') === 'cancelled') continue;

      const keyword = keywordById.get(String(decision.keyword_id || decision.entity_id || '')) || null;
      const cid = String(decision.campaign_id || keyword?.campaign_id || '');
      const campaign = campaignById.get(cid) || null;
      // Esta limpeza é específica do ciclo MANUAL. Decisões de outras entidades continuam intactas.
      if (campaign && !isManual(campaign)) continue;
      const reason = scopeReason(campaign, keyword, decision.asin || null);
      if (!reason) continue;

      await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
        status: 'skipped',
        queue_status: 'cancelled',
        error_message: `STALE_MANUAL_BID_SCOPE: ${reason}`,
        updated_at: now,
      }).catch(() => {});
      decisionsCancelled++;
      decisionResults.push({ id: decision.id, campaign_id: cid || null, keyword_id: keywordId(keyword), reason });
    }

    return Response.json({
      ok: true,
      amazon_account_id: accountId,
      sync: syncResult?.data || syncResult || null,
      scanned: {
        campaigns: campaigns.length,
        products: products.length,
        keywords: keywords.length,
        lifecycles: lifecycles.length,
        decisions: decisions.length,
      },
      eligible_manual_bid_lifecycles: lifecycleEligible,
      lifecycles_removed_from_cycle: lifecyclesRemoved,
      stale_bid_decisions_cancelled: decisionsCancelled,
      lifecycle_results: lifecycleResults.slice(0, 500),
      cancelled_decisions: decisionResults.slice(0, 500),
      policy: 'manual_bid_cycle_active_campaign_active_product_in_stock_exact_single_keyword_only',
      history_preserved: true,
      executed_at: now,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha ao reconciliar escopo do ciclo manual de bids', history_preserved: true }, { status: 500 });
  }
});
