import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const MIN_ACTIVE_MANUAL = 6;
const FIRST_REVIEW_HOURS = 72;
const SECOND_REVIEW_HOURS = 72;
const MAX_RECOVERY_ATTEMPTS = 2;
const MAX_BID_INCREASE_PCT = 0.20;
const DEFAULT_MAX_BID = 0.70;

function normalize(value: unknown) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function campaignState(value: unknown) {
  return normalize(value).toUpperCase();
}

function isEnabled(value: unknown) {
  return ['ENABLED', 'ACTIVE', 'EM INSERÇÃO'].includes(campaignState(value));
}

function hoursSince(value: unknown) {
  const timestamp = new Date(String(value || 0)).getTime();
  if (!Number.isFinite(timestamp) || timestamp <= 0) return Number.POSITIVE_INFINITY;
  return (Date.now() - timestamp) / 3600000;
}

function asNumber(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function unwrap(result: any) {
  return result?.data || result || {};
}

async function invokeFirst(base44: any, names: string[], payload: Record<string, unknown>) {
  let lastError: any = null;
  for (const name of names) {
    try {
      const response = unwrap(await base44.asServiceRole.functions.invoke(name, payload));
      if (response?.ok === false) {
        lastError = new Error(response?.error || response?.message || `${name} falhou`);
        continue;
      }
      return { function_name: name, response };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`Nenhuma função disponível: ${names.join(', ')}`);
}

async function listEntity(entity: any, filters: Record<string, unknown>, sort = '-created_date', limit = 1000) {
  return entity?.filter ? entity.filter(filters, sort, limit).catch(() => []) : [];
}

async function logDecision(base44: any, data: Record<string, unknown>) {
  const key = String(data.idempotency_key || '');
  if (key) {
    const existing = await listEntity(base44.asServiceRole.entities.OptimizationDecision, {
      amazon_account_id: data.amazon_account_id,
      idempotency_key: key,
    }, '-created_at', 1);
    if (existing.length) return existing[0];
  }
  return base44.asServiceRole.entities.OptimizationDecision.create(data).catch(() => null);
}

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  const base44 = createClientFromRequest(req);
  const body = await req.json().catch(() => ({}));

  if (!body._service_role) {
    const user = await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const accounts = body.amazon_account_id
    ? await listEntity(base44.asServiceRole.entities.AmazonAccount, { id: body.amazon_account_id }, '-created_date', 1)
    : await listEntity(base44.asServiceRole.entities.AmazonAccount, { status: 'connected' }, '-created_date', 50);

  const summary: any = {
    ok: true,
    started_at: startedAt,
    accounts: 0,
    active_skus: 0,
    campaigns_checked: 0,
    bids_adjusted: 0,
    campaigns_replaced: 0,
    deficits_requested: 0,
    skipped_no_stock: 0,
    errors: [],
  };

  for (const account of accounts) {
    const aid = account.id;
    summary.accounts += 1;

    try {
      const [products, campaigns, keywords, metrics, settingsRows, priorDecisions] = await Promise.all([
        listEntity(base44.asServiceRole.entities.Product, { amazon_account_id: aid }, '-updated_date', 2000),
        listEntity(base44.asServiceRole.entities.AdsCampaign, { amazon_account_id: aid }, '-updated_date', 3000),
        listEntity(base44.asServiceRole.entities.AdsKeyword, { amazon_account_id: aid }, '-updated_date', 5000),
        listEntity(base44.asServiceRole.entities.CampaignMetricsDaily, { amazon_account_id: aid }, '-date', 10000),
        listEntity(base44.asServiceRole.entities.PerformanceSettings, { amazon_account_id: aid }, '-updated_at', 1),
        listEntity(base44.asServiceRole.entities.OptimizationDecision, { amazon_account_id: aid, source_function: 'recoverZeroClickManualCampaigns' }, '-created_at', 5000),
      ]);

      const settings = settingsRows[0] || {};
      const maxBid = Math.max(0.10, asNumber(settings.max_bid, DEFAULT_MAX_BID));
      const maxIncreasePct = Math.min(MAX_BID_INCREASE_PCT, Math.max(0.01, asNumber(settings.max_bid_increase_pct, MAX_BID_INCREASE_PCT)));
      const priorByCampaign = new Map<string, any[]>();
      for (const item of priorDecisions) {
        const campaignId = String(item.campaign_id || item.entity_id || '');
        if (!campaignId) continue;
        const list = priorByCampaign.get(campaignId) || [];
        list.push(item);
        priorByCampaign.set(campaignId, list);
      }

      const metricByCampaign = new Map<string, { clicks: number; impressions: number; orders: number; spend: number; sales: number }>();
      for (const row of metrics) {
        const campaignId = String(row.campaign_id || '');
        if (!campaignId) continue;
        const current = metricByCampaign.get(campaignId) || { clicks: 0, impressions: 0, orders: 0, spend: 0, sales: 0 };
        current.clicks += asNumber(row.clicks);
        current.impressions += asNumber(row.impressions);
        current.orders += asNumber(row.orders || row.purchases);
        current.spend += asNumber(row.spend || row.cost);
        current.sales += asNumber(row.sales || row.attributed_sales);
        metricByCampaign.set(campaignId, current);
      }

      const keywordsByCampaign = new Map<string, any[]>();
      for (const keyword of keywords) {
        const campaignId = String(keyword.campaign_id || '');
        if (!campaignId) continue;
        const list = keywordsByCampaign.get(campaignId) || [];
        list.push(keyword);
        keywordsByCampaign.set(campaignId, list);
      }

      const eligibleProducts = products.filter((product: any) => {
        const status = normalize(product.status || product.listing_status || product.offer_status);
        const stock = asNumber(product.fba_inventory ?? product.stock_quantity ?? product.fulfillable_quantity ?? product.inventory);
        const asin = String(product.asin || '').trim();
        const active = !['inactive', 'closed', 'deleted', 'suppressed', 'out_of_stock'].includes(status);
        if (!active || stock <= 0 || !asin) {
          if (stock <= 0) summary.skipped_no_stock += 1;
          return false;
        }
        return true;
      });

      summary.active_skus += eligibleProducts.length;

      for (const product of eligibleProducts) {
        const asin = String(product.asin || '').trim();
        const sku = String(product.sku || '').trim();
        const manualCampaigns = campaigns.filter((campaign: any) => {
          const campaignAsin = String(campaign.asin || campaign.advertised_asin || campaign.product_asin || '').trim();
          const campaignSku = String(campaign.sku || campaign.product_sku || '').trim();
          const targeting = normalize(campaign.targeting_type || campaign.targetingType);
          const matchType = normalize(campaign.match_type || campaign.matchType || 'exact');
          return (campaignAsin === asin || (!!sku && campaignSku === sku))
            && targeting === 'manual'
            && (!matchType || matchType === 'exact')
            && isEnabled(campaign.state || campaign.status);
        });

        const completeManual = manualCampaigns.filter((campaign: any) => {
          const campaignKeywords = keywordsByCampaign.get(String(campaign.campaign_id || campaign.id)) || [];
          const hasExactKeyword = campaignKeywords.some((keyword: any) => {
            const matchType = normalize(keyword.match_type || keyword.matchType);
            return isEnabled(keyword.state || keyword.status) && matchType === 'exact';
          });
          const confirmed = campaign.amazon_confirmed === true
            || campaign.structure_complete === true
            || campaign.completion_status === 'complete'
            || campaign.lifecycle_state === 'complete';
          return confirmed && hasExactKeyword;
        });

        for (const campaign of completeManual) {
          summary.campaigns_checked += 1;
          const campaignId = String(campaign.campaign_id || campaign.id || '');
          const aggregate = metricByCampaign.get(campaignId) || { clicks: 0, impressions: 0, orders: 0, spend: 0, sales: 0 };
          if (aggregate.clicks > 0 || aggregate.orders > 0 || aggregate.sales > 0) continue;

          const ageHours = hoursSince(campaign.start_date || campaign.created_at || campaign.created_date);
          if (ageHours < FIRST_REVIEW_HOURS) continue;

          const campaignDecisions = (priorByCampaign.get(campaignId) || [])
            .filter((decision: any) => ['confirmed', 'completed', 'executed', 'approved'].includes(normalize(decision.status)));
          const recoveryAttempts = campaignDecisions.filter((decision: any) => normalize(decision.decision_type) === 'zero_click_bid_recovery').length;
          const lastAttempt = campaignDecisions
            .filter((decision: any) => normalize(decision.decision_type) === 'zero_click_bid_recovery')
            .sort((a: any, b: any) => new Date(b.created_at || b.created_date || 0).getTime() - new Date(a.created_at || a.created_date || 0).getTime())[0];

          if (recoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
            if (lastAttempt && hoursSince(lastAttempt.created_at || lastAttempt.created_date) < SECOND_REVIEW_HOURS) continue;

            const campaignKeywords = keywordsByCampaign.get(campaignId) || [];
            const exactKeyword = campaignKeywords.find((keyword: any) => isEnabled(keyword.state || keyword.status) && normalize(keyword.match_type || keyword.matchType) === 'exact');
            if (!exactKeyword) continue;

            const currentBid = Math.max(0.02, asNumber(exactKeyword.bid ?? campaign.default_bid ?? campaign.bid, 0.25));
            const suggestedLow = asNumber(exactKeyword.suggested_bid_low ?? exactKeyword.suggestedBidLow);
            const suggested = asNumber(exactKeyword.suggested_bid ?? exactKeyword.suggestedBid);
            const boundedIncrease = currentBid * (1 + maxIncreasePct);
            const targetBid = Math.min(maxBid, Math.max(currentBid + 0.02, Math.min(boundedIncrease, suggestedLow || suggested || boundedIncrease)));
            const idempotencyKey = ['zero_click_bid_recovery', aid, campaignId, recoveryAttempts + 1].join('|');

            const existing = await listEntity(base44.asServiceRole.entities.OptimizationDecision, { amazon_account_id: aid, idempotency_key: idempotencyKey }, '-created_at', 1);
            if (existing.length) continue;

            const action = await invokeFirst(base44, ['updateKeywordBidV3', 'updateKeywordBid', 'applyKeywordBidChange'], {
              amazon_account_id: aid,
              campaign_id: campaignId,
              keyword_id: exactKeyword.keyword_id || exactKeyword.id,
              bid: Math.round(targetBid * 100) / 100,
              idempotency_key: idempotencyKey,
              reason: 'Campanha manual EXACT ativa sem cliques após janela mínima; recuperação limitada de bid.',
              _service_role: true,
            });

            await logDecision(base44, {
              amazon_account_id: aid,
              campaign_id: campaignId,
              keyword_id: exactKeyword.keyword_id || exactKeyword.id,
              asin,
              sku,
              decision_type: 'zero_click_bid_recovery',
              action: 'increase_bid',
              status: action.response?.confirmed === false ? 'pending_confirmation' : 'confirmed',
              value_before: currentBid,
              value_after: Math.round(targetBid * 100) / 100,
              reason: `Sem cliques após ${Math.floor(ageHours / 24)} dias; tentativa ${recoveryAttempts + 1}/${MAX_RECOVERY_ATTEMPTS}.`,
              source_function: 'recoverZeroClickManualCampaigns',
              idempotency_key: idempotencyKey,
              next_evaluation_at: new Date(Date.now() + SECOND_REVIEW_HOURS * 3600000).toISOString(),
              created_at: new Date().toISOString(),
              amazon_response: JSON.stringify(action.response || {}),
            });
            summary.bids_adjusted += 1;
            continue;
          }

          if (lastAttempt && hoursSince(lastAttempt.created_at || lastAttempt.created_date) < SECOND_REVIEW_HOURS) continue;

          const campaignKeywords = keywordsByCampaign.get(campaignId) || [];
          const exactKeyword = campaignKeywords.find((keyword: any) => isEnabled(keyword.state || keyword.status) && normalize(keyword.match_type || keyword.matchType) === 'exact');
          const oldTerm = normalize(exactKeyword?.keyword_text || exactKeyword?.keyword || exactKeyword?.targeting_expression);
          const replacementKey = ['zero_click_replace', aid, asin, campaignId, oldTerm].join('|');
          const existingReplacement = await listEntity(base44.asServiceRole.entities.OptimizationDecision, { amazon_account_id: aid, idempotency_key: replacementKey }, '-created_at', 1);
          if (existingReplacement.length) continue;

          const replacement = await invokeFirst(base44, ['replaceManualExactCampaignTerm', 'replaceUnderperformingKickoffTerm', 'ensureManualCampaignCoverage'], {
            amazon_account_id: aid,
            asin,
            sku,
            campaign_id: campaignId,
            old_keyword_id: exactKeyword?.keyword_id || exactKeyword?.id,
            old_term: oldTerm,
            minimum_active_manual_campaigns: MIN_ACTIVE_MANUAL,
            source_priority: ['TermBank', 'AmazonAdsSuggestions'],
            match_type: 'exact',
            one_term_per_campaign: true,
            pause_old_only_after_new_confirmed: true,
            exact_negative_in_auto_after_confirmation: true,
            require_stock: true,
            require_amazon_confirmation: true,
            idempotency_key: replacementKey,
            _service_role: true,
          });

          await logDecision(base44, {
            amazon_account_id: aid,
            campaign_id: campaignId,
            asin,
            sku,
            decision_type: 'zero_click_replace',
            action: 'replace_manual_exact_campaign',
            status: replacement.response?.confirmed === false ? 'pending_confirmation' : 'confirmed',
            old_term: oldTerm,
            new_term: replacement.response?.new_term || replacement.response?.term || null,
            reason: `Sem cliques após ${MAX_RECOVERY_ATTEMPTS} recuperações limitadas e cooldown completo.`,
            source_function: 'recoverZeroClickManualCampaigns',
            idempotency_key: replacementKey,
            created_at: new Date().toISOString(),
            amazon_response: JSON.stringify(replacement.response || {}),
          });
          summary.campaigns_replaced += 1;
        }

        const deficit = Math.max(0, MIN_ACTIVE_MANUAL - completeManual.length);
        if (deficit > 0) {
          const coverageKey = ['manual_exact_floor', aid, asin, MIN_ACTIVE_MANUAL].join('|');
          const pendingCoverage = await listEntity(base44.asServiceRole.entities.OptimizationDecision, {
            amazon_account_id: aid,
            idempotency_key: coverageKey,
          }, '-created_at', 1);

          if (!pendingCoverage.length || ['error', 'failed', 'cancelled'].includes(normalize(pendingCoverage[0]?.status))) {
            const coverage = await invokeFirst(base44, ['ensureManualCampaignCoverage', 'maintainKickoffCampaignFloor', 'autoKickoffProductV2'], {
              amazon_account_id: aid,
              asin,
              sku,
              product_id: product.id,
              required_active_manual_campaigns: MIN_ACTIVE_MANUAL,
              campaigns_to_create: deficit,
              targeting_type: 'manual',
              match_type: 'exact',
              one_term_per_campaign: true,
              source_priority: ['TermBank', 'AmazonAdsSuggestions'],
              require_stock: true,
              require_active_product: true,
              require_amazon_confirmation: true,
              exact_negative_in_auto_after_confirmation: true,
              idempotency_key: coverageKey,
              _service_role: true,
            });

            await logDecision(base44, {
              amazon_account_id: aid,
              asin,
              sku,
              decision_type: 'manual_exact_floor',
              action: 'create_manual_exact_campaigns',
              status: coverage.response?.confirmed === false ? 'pending_confirmation' : 'confirmed',
              value_before: completeManual.length,
              value_after: MIN_ACTIVE_MANUAL,
              reason: `SKU ativo e com estoque abaixo do piso de ${MIN_ACTIVE_MANUAL} campanhas manuais EXACT completas.`,
              source_function: 'recoverZeroClickManualCampaigns',
              idempotency_key: coverageKey,
              created_at: new Date().toISOString(),
              amazon_response: JSON.stringify(coverage.response || {}),
            });
            summary.deficits_requested += deficit;
          }
        }
      }
    } catch (error) {
      summary.ok = false;
      summary.errors.push({ amazon_account_id: aid, error: error?.message || String(error) });
    }
  }

  summary.completed_at = new Date().toISOString();
  await base44.asServiceRole.entities.SyncExecutionLog.create({
    operation: 'recover_zero_click_manual_campaigns',
    trigger_type: body._service_role ? 'scheduler' : 'manual',
    status: summary.ok ? 'completed' : 'warning',
    started_at: startedAt,
    completed_at: summary.completed_at,
    records_processed: summary.campaigns_checked,
    result_summary: JSON.stringify(summary),
  }).catch(() => {});

  return Response.json(summary, { status: summary.ok ? 200 : 207 });
});
