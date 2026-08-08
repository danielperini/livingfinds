import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { classifyCampaignDeliveryHealth, nextConservativeBid } from '../../shared/campaignDeliveryHealthPolicy.ts';
import { productAdsEligibility } from '../../shared/productAdsEligibility.ts';

const SOURCE = 'reconcileCampaignDeliveryHealth';
const active = (v: unknown) => ['enabled', 'active'].includes(String(v || '').toLowerCase());
const upper = (v: unknown) => String(v || '').trim().toUpperCase();
const n = (v: unknown) => Number.isFinite(Number(v)) ? Number(v) : 0;
const idOf = (c: any) => String(c.amazon_campaign_id || c.campaign_id || c.id || '');
const entityCampaignId = (row: any) => String(row.campaign_id || row.amazon_campaign_id || '');
const entityId = (row: any) => String(row.keyword_id || row.ad_group_id || row.product_ad_id || row.id || '');
const transitional = (v: unknown) => ['INSERTING', 'INCOMPLETE', 'CREATING', 'PENDING', 'DRAFT', 'PENDING_REVIEW'].includes(upper(v));

function confirmedReplacement(result: any): boolean {
  const data = result?.data || result || {};
  return data.confirmed === true || data.manual_campaign_confirmed === true ||
    n(data.confirmed_campaigns) > 0 || n(data.created_confirmed) > 0 || n(data.promoted_confirmed) > 0;
}

function isConflict(error: any): boolean {
  const status = Number(error?.status || error?.response?.status || error?.response?.data?.status || 0);
  const message = String(error?.response?.data?.error || error?.message || error || '').toLowerCase();
  return status === 409 || message.includes('duplicate key') || message.includes('unique constraint') || message.includes('already exists');
}

function stockEvidenceTime(product: any): number {
  const candidates = [
    product?.inventory_synced_at,
    product?.fba_inventory_synced_at,
    product?.inventory_last_synced_at,
    product?.sp_api_inventory_synced_at,
    product?.ads_last_eligibility_check_at,
    product?.listing_checked_at,
    product?.updated_date,
    product?.updated_at,
  ];
  for (const value of candidates) {
    const ms = new Date(String(value || '')).getTime();
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return 0;
}

function confirmedOutOfStock(product: any, eligibility: ReturnType<typeof productAdsEligibility>): boolean {
  if (!product || eligibility.reason !== 'PRODUCT_OUT_OF_STOCK') return false;
  const explicit = String(product.inventory_status || '').toLowerCase() === 'out_of_stock' ||
    String(product.ads_eligibility_status || '').toLowerCase() === 'out_of_stock';
  const evidenceAt = stockEvidenceTime(product);
  const fresh = evidenceAt > 0 && Date.now() - evidenceAt <= 90 * 60 * 1000;
  return explicit && fresh;
}

async function createDecisionIdempotent(base44: any, payload: any): Promise<{ decision: any; reused: boolean }> {
  try {
    const decision = await base44.asServiceRole.entities.OptimizationDecision.create(payload);
    return { decision, reused: false };
  } catch (error: any) {
    if (!isConflict(error)) throw error;
    const existing = await base44.asServiceRole.entities.OptimizationDecision.filter(
      { idempotency_key: payload.idempotency_key },
      '-created_at',
      1,
    ).catch(() => []);
    if (!existing.length) throw error;
    return { decision: existing[0], reused: true };
  }
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

    const dryRun = body.dry_run === true;
    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 50);
    const results: any[] = [];

    for (const account of accounts) {
      const accountId = String(account.id);
      const [campaigns, keywords, adGroups, productAds, products, metrics, prior, spendControllers, settingsRows] = await Promise.all([
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-created_at', 10000).catch(() => []),
        base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-created_at', 30000).catch(() => []),
        base44.asServiceRole.entities.AdGroup.filter({ amazon_account_id: accountId }, '-created_at', 30000).catch(() => []),
        base44.asServiceRole.entities.ProductAd.filter({ amazon_account_id: accountId }, '-created_at', 30000).catch(() => []),
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, null, 5000).catch(() => []),
        base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: accountId }, '-date', 10000).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-created_at', 30000).catch(() => []),
        base44.asServiceRole.entities.AccountDailySpendController.filter({ amazon_account_id: accountId }, '-date', 3).catch(() => []),
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, '-updated_at', 1).catch(() => []),
      ]);
      const settings = settingsRows[0] || {};
      const minBid = Math.max(0.02, n(settings.min_bid || 0.2));
      const maxBid = Math.max(minBid, n(settings.max_bid || 3));
      const increment = Math.max(0.01, n(settings.bid_increment || settings.allowed_increment || 0.1));
      const targetAcos = n(settings.target_acos || settings.acos_target || 15);

      const productByAsin = new Map(products.filter((p: any) => p.asin).map((p: any) => [upper(p.asin), p]));
      const kwByCampaign = new Map<string, any[]>();
      const adGroupsByCampaign = new Map<string, any[]>();
      const productAdsByCampaign = new Map<string, any[]>();
      for (const row of keywords) {
        const cid = entityCampaignId(row);
        if (!kwByCampaign.has(cid)) kwByCampaign.set(cid, []);
        kwByCampaign.get(cid)!.push(row);
      }
      for (const row of adGroups) {
        const cid = entityCampaignId(row);
        if (!adGroupsByCampaign.has(cid)) adGroupsByCampaign.set(cid, []);
        adGroupsByCampaign.get(cid)!.push(row);
      }
      for (const row of productAds) {
        const cid = entityCampaignId(row);
        if (!productAdsByCampaign.has(cid)) productAdsByCampaign.set(cid, []);
        productAdsByCampaign.get(cid)!.push(row);
      }

      const metricsByCampaign = new Map<string, any>();
      for (const row of metrics) {
        const cid = String(row.campaign_id || '');
        const agg = metricsByCampaign.get(cid) || { impressions: 0, clicks: 0, orders: 0, sales: 0, spend: 0 };
        agg.impressions += n(row.impressions);
        agg.clicks += n(row.clicks);
        agg.orders += n(row.orders);
        agg.sales += n(row.sales);
        agg.spend += n(row.spend);
        metricsByCampaign.set(cid, agg);
      }
      const accountOutOfBudget = spendControllers.some((r: any) => r.account_out_of_budget === true || r.hard_cap_reached === true);
      const actions: any[] = [];
      const repairCampaignIds: string[] = [];
      const queuedDecisionIds = new Set<string>();
      let reusedDecisions = 0;
      let cancelledFalseStockDecisions = 0;

      for (const campaign of campaigns) {
        if (campaign.archived === true || upper(campaign.campaign_type || 'SP') !== 'SP') continue;
        const state = campaign.state || campaign.status || campaign.amazon_status;
        if (!active(state) && !transitional(state)) continue;

        const campaignId = idOf(campaign);
        if (!campaignId) continue;
        const asin = upper(campaign.asin || campaign.advertised_asin || String(campaign.name || '').match(/B0[A-Z0-9]{8}/i)?.[0]);
        const product = productByAsin.get(asin);
        const eligibility = productAdsEligibility(product);
        const campaignKeywords = kwByCampaign.get(campaignId) || [];
        const campaignAdGroups = adGroupsByCampaign.get(campaignId) || [];
        const campaignProductAds = productAdsByCampaign.get(campaignId) || [];
        const manual = upper(campaign.targeting_type) === 'MANUAL' || upper(campaign.name || campaign.campaign_name).includes('| MANUAL |');
        const complete = manual
          ? campaignAdGroups.some((row: any) => active(row.state || row.status)) &&
            campaignProductAds.some((row: any) => active(row.state || row.status)) &&
            campaignKeywords.some((row: any) => active(row.state || row.status) && upper(row.match_type || row.matchType) === 'EXACT')
          : campaignAdGroups.length === 0 || campaignAdGroups.some((row: any) => active(row.state || row.status));

        if (eligibility.inStock) {
          const falseStockDecisions = prior.filter((d: any) =>
            d.source_function === SOURCE &&
            String(d.campaign_id || '') === campaignId &&
            String(d.reason_code || d.rule_key || d.rationale || '') === 'ARCHIVE_OUT_OF_STOCK' &&
            ['pending_approval', 'approved', 'waiting_retry'].includes(String(d.status || '').toLowerCase())
          );
          if (!dryRun) {
            for (const decision of falseStockDecisions) {
              await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
                status: 'cancelled',
                queue_status: 'cancelled',
                error_message: `FALSE_OUT_OF_STOCK_REVOKED: SP-API canonical stock=${eligibility.stock}.`,
                updated_at: new Date().toISOString(),
              }).catch(() => {});
              cancelledFalseStockDecisions++;
            }
          }
        }

        const createdAt = new Date(campaign.created_at || campaign.created_date || Date.now()).getTime();
        const ageHours = Math.max(0, (Date.now() - createdAt) / 3600000);
        const m = metricsByCampaign.get(campaignId) || { impressions: 0, clicks: 0, orders: 0, sales: 0, spend: 0 };
        const priorEscalations = prior.filter((d: any) =>
          d.source_function === SOURCE && String(d.campaign_id || '') === campaignId && d.action === 'set_bid' &&
          !['failed', 'rejected', 'cancelled'].includes(String(d.status || ''))
        ).length;
        let action = classifyCampaignDeliveryHealth({
          ageHours,
          ...m,
          complete,
          hasProduct: !!product,
          inStock: eligibility.inStock,
          protectedWinner: campaign.protected_high_performance === true,
          accountOutOfBudget,
          priorBidEscalations: priorEscalations,
          operationalState: state,
        });

        if (action === 'ARCHIVE_OUT_OF_STOCK' && !confirmedOutOfStock(product, eligibility)) {
          actions.push({
            campaign_id: campaignId,
            asin,
            action: 'VERIFY_STOCK',
            reason: 'OUT_OF_STOCK_NOT_CONFIRMED_BY_FRESH_SP_API_EVIDENCE',
            stock: eligibility.stock,
            eligibility_reason: eligibility.reason,
            status_signals: eligibility.statusSignals,
          });
          continue;
        }

        if (action === 'REPAIR_STRUCTURE') {
          repairCampaignIds.push(campaignId);
          actions.push({ campaign_id: campaignId, asin, action, age_hours: ageHours, state: upper(state), complete });
          continue;
        }

        if (action === 'ARCHIVE_NO_PRODUCT' || action === 'ARCHIVE_OUT_OF_STOCK') {
          const key = `${SOURCE}|${accountId}|${campaignId}|${action}`;
          if (!dryRun) {
            const { reused } = await createDecisionIdempotent(base44, {
              amazon_account_id: accountId,
              decision_type: 'campaign_delivery_health',
              entity_type: 'campaign',
              entity_id: campaignId,
              campaign_id: campaignId,
              action: 'archive_campaign',
              rationale: action,
              rule_key: action,
              reason_code: action,
              status: 'pending_approval',
              requires_approval: true,
              approval_status: 'manual_review_required',
              idempotency_key: key,
              source_function: SOURCE,
              data_used: JSON.stringify({
                asin,
                canonical_stock: eligibility.stock,
                eligibility_reason: eligibility.reason,
                status_signals: eligibility.statusSignals,
                inventory_status: product?.inventory_status || null,
                ads_eligibility_status: product?.ads_eligibility_status || null,
                stock_evidence_at: stockEvidenceTime(product) || null,
              }),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
            if (reused) reusedDecisions++;
          }
          actions.push({ campaign_id: campaignId, asin, action, stock: eligibility.stock });
          continue;
        }

        if (action === 'INCREASE_BID') {
          const bidEntities = campaignKeywords.filter((row: any) => active(row.state || row.status));
          if (!bidEntities.length) {
            repairCampaignIds.push(campaignId);
            actions.push({ campaign_id: campaignId, asin, action: 'REPAIR_STRUCTURE', reason: 'NO_ACTIVE_BID_ENTITY' });
            continue;
          }
          for (const bidEntity of bidEntities) {
            const currentBid = n(bidEntity.bid ?? bidEntity.current_bid) || Math.max(minBid, manual ? 0.6 : 0.5);
            const entityMaxBid = n(bidEntity.max_bid || campaign.max_bid || maxBid) || maxBid;
            const targetBid = nextConservativeBid(currentBid, Math.min(maxBid, entityMaxBid), increment, minBid);
            if (targetBid <= currentBid) continue;
            const keywordId = entityId(bidEntity);
            const key = `${SOURCE}|${accountId}|${campaignId}|${keywordId}|${priorEscalations}`;
            if (!dryRun) {
              const { decision, reused } = await createDecisionIdempotent(base44, {
                amazon_account_id: accountId,
                decision_type: 'campaign_delivery_health',
                entity_type: 'keyword',
                entity_id: keywordId,
                keyword_id: keywordId,
                campaign_id: campaignId,
                action: 'set_bid',
                value_before: currentBid,
                value_after: targetBid,
                current_value: currentBid,
                proposed_value: targetBid,
                rationale: 'ZERO_DELIVERY_AFTER_72H',
                rule_key: 'ZERO_DELIVERY_BID_ESCALATION',
                reason_code: 'ZERO_DELIVERY_BID_ESCALATION',
                status: 'approved',
                queue_status: 'pending',
                execution_mode: 'STANDARD_QUEUE',
                confirmation_required: true,
                confirmation_status: 'pending',
                requires_approval: false,
                approval_status: 'auto_approved',
                idempotency_key: key,
                conflict_group: `${accountId}|keyword|${keywordId}`,
                source_function: SOURCE,
                model_version: 'campaign-delivery-health-v2.3-canonical-stock',
                data_used: JSON.stringify({ age_hours: ageHours, impressions: m.impressions, clicks: m.clicks, prior_escalations: priorEscalations, increment, min_bid: minBid, max_bid: maxBid }),
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              });
              if (reused) reusedDecisions++;
              const decisionId = String(decision?.id || '');
              if (decisionId && !['confirmed', 'executed', 'cancelled', 'rejected'].includes(String(decision?.status || '').toLowerCase())) {
                queuedDecisionIds.add(decisionId);
              }
            }
            actions.push({ campaign_id: campaignId, asin, action, keyword_id: keywordId, current_bid: currentBid, target_bid: targetBid });
          }
          continue;
        }

        if (action === 'PAUSE_AND_REPLACE') {
          const currentTerm = campaignKeywords.find((row: any) => active(row.state || row.status));
          const replacement = dryRun ? { ok: true, dry_run: true } : await base44.asServiceRole.functions.invoke('ensureActiveProductCampaignCoverage', {
            amazon_account_id: accountId,
            asin,
            _service_role: true,
            _canonical_orchestrator: 'runUnifiedDecisionEngine',
            force_zero_delivery_replacement: true,
            replace_campaign_id: campaignId,
            exclude_terms: [currentTerm?.keyword_text || currentTerm?.keyword].filter(Boolean),
            maximum_initial_manual_campaigns: 1,
            minimum_term_relevance: 0.9,
            exact_only: true,
            one_term_per_campaign: true,
            require_stock: true,
            term_source_order: ['TermBank', 'AmazonAdsSuggestions'],
            initial_bid: Math.max(minBid, 0.6),
            confirm_on_amazon: true,
            dry_run: false,
          }).catch((error: any) => ({ ok: false, error: error?.message || String(error) }));

          const replacementData = replacement?.data || replacement || {};
          if (!dryRun && confirmedReplacement(replacementData)) {
            const key = `${SOURCE}|${accountId}|${campaignId}|pause_after_confirmed_replacement`;
            const { decision, reused } = await createDecisionIdempotent(base44, {
              amazon_account_id: accountId,
              decision_type: 'campaign_delivery_health',
              entity_type: 'campaign',
              entity_id: campaignId,
              campaign_id: campaignId,
              action: 'pause_campaign',
              rationale: 'ZERO_DELIVERY_REPLACEMENT_CONFIRMED_ON_AMAZON',
              rule_key: 'ZERO_DELIVERY_REPLACE',
              reason_code: 'ZERO_DELIVERY_REPLACE',
              status: 'approved',
              queue_status: 'pending',
              execution_mode: 'STANDARD_QUEUE',
              requires_approval: false,
              approval_status: 'auto_approved',
              confirmation_required: true,
              confirmation_status: 'pending',
              idempotency_key: key,
              conflict_group: `${accountId}|campaign|${campaignId}`,
              source_function: SOURCE,
              model_version: 'campaign-delivery-health-v2.3-canonical-stock',
              data_used: JSON.stringify({ asin, replacement: replacementData }),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
            if (reused) reusedDecisions++;
            const decisionId = String(decision?.id || '');
            if (decisionId && !['confirmed', 'executed', 'cancelled', 'rejected'].includes(String(decision?.status || '').toLowerCase())) {
              queuedDecisionIds.add(decisionId);
            }
          }
          actions.push({
            campaign_id: campaignId,
            asin,
            action,
            replacement_confirmed: confirmedReplacement(replacementData),
            replacement_result: replacementData,
            old_campaign_paused_only_after_confirmation: true,
          });
        }
      }

      const repair = repairCampaignIds.length && !dryRun
        ? await base44.asServiceRole.functions.invoke('enforceCanonicalManualCampaigns', {
            amazon_account_id: accountId,
            campaign_ids: [...new Set(repairCampaignIds)],
            force_repair: true,
            archive_if_unrepairable: true,
            require_product_ad: true,
            require_active_exact_keyword: true,
            confirm_on_amazon: true,
            _service_role: true,
            _canonical_orchestrator: 'runUnifiedDecisionEngine',
            trigger_type: 'campaign_delivery_health_immediate_repair',
          }).catch((error: any) => ({ error: error?.message || String(error) }))
        : null;

      const decisionIds = [...queuedDecisionIds];
      let execution: any = { ok: true, skipped: true };
      let confirmation: any = { ok: true, skipped: true };
      if (decisionIds.length && !dryRun) {
        execution = await base44.asServiceRole.functions.invoke('executeApprovedDecisionQueue', {
          amazon_account_id: accountId,
          decision_ids: decisionIds,
          _service_role: true,
          _canonical_orchestrator: 'runUnifiedDecisionEngine',
          source: SOURCE,
        }).catch((error: any) => ({ ok: false, error: error?.message || String(error) }));
        confirmation = await base44.asServiceRole.functions.invoke('confirmExecutedDecisions', {
          amazon_account_id: accountId,
          decision_ids: decisionIds,
          _service_role: true,
          _canonical_orchestrator: 'runUnifiedDecisionEngine',
          source: SOURCE,
        }).catch((error: any) => ({ ok: false, error: error?.message || String(error) }));
      }

      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: accountId,
        sync_type: 'campaign_delivery_health',
        status: execution?.ok === false || confirmation?.ok === false ? 'partial' : 'completed',
        source_function: SOURCE,
        records_processed: campaigns.length,
        records_imported: actions.length,
        message: `Recuperação imediata: ${repairCampaignIds.length} reparos, ${decisionIds.length} decisões, ${reusedDecisions} reutilizadas, ${cancelledFalseStockDecisions} falsos OOS cancelados e ${actions.filter((a) => a.action === 'PAUSE_AND_REPLACE').length} substituições.`,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      }).catch(() => {});

      results.push({
        amazon_account_id: accountId,
        dry_run: dryRun,
        account_out_of_budget: accountOutOfBudget,
        settings: { target_acos: targetAcos, min_bid: minBid, max_bid: maxBid, increment },
        canonical_stock_policy: {
          source: 'Product/SP-API canonical fields via productAdsEligibility',
          fields: ['fulfillable_quantity', 'available_quantity', 'inventory_quantity', 'stock', 'fba_inventory'],
          archive_requires_fresh_explicit_out_of_stock: true,
          freshness_minutes: 90,
        },
        actions,
        repair: repair?.data || repair || null,
        queued_decision_ids: decisionIds,
        reused_decisions: reusedDecisions,
        cancelled_false_stock_decisions: cancelledFalseStockDecisions,
        execution: execution?.data || execution,
        confirmation: confirmation?.data || confirmation,
      });
    }

    return Response.json({ ok: true, engine: 'campaign-delivery-health-v2.3-canonical-stock', results });
  } catch (error: any) {
    return Response.json({ ok: false, engine: 'campaign-delivery-health-v2.3-canonical-stock', error: error?.message || 'Falha na reconciliação de entrega' }, { status: 500 });
  }
});