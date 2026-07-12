import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const WAIT_MS = 3000;
const DEFAULT_BID = 0.60;
const MAX_PER_RUN = 20;
const wait = (ms:number) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeTerm(value:any) {
  return String(value || '')
    .replace(/\+\d+\s*$/i, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function isManualCampaign(campaign:any) {
  const targeting = String(campaign?.targeting_type || campaign?.targetingType || '').toLowerCase();
  const name = String(campaign?.name || campaign?.campaign_name || '').toLowerCase();
  return targeting === 'manual' || name.includes('| manual |');
}

function isActive(value:any) {
  return ['enabled', 'active'].includes(String(value || '').toLowerCase());
}

function isExactKeyword(keyword:any) {
  return String(keyword?.match_type || keyword?.matchType || '').toLowerCase() === 'exact';
}

function metricNumber(value:any) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function chooseWinner(items:any[]) {
  return [...items].sort((a:any, b:any) => {
    const aSales = metricNumber(a.campaign.sales || a.campaign.attributed_sales || a.keyword.sales);
    const bSales = metricNumber(b.campaign.sales || b.campaign.attributed_sales || b.keyword.sales);
    if (aSales !== bSales) return bSales - aSales;

    const aOrders = metricNumber(a.campaign.orders || a.campaign.purchases || a.keyword.orders);
    const bOrders = metricNumber(b.campaign.orders || b.campaign.purchases || b.keyword.orders);
    if (aOrders !== bOrders) return bOrders - aOrders;

    const aAcos = metricNumber(a.campaign.acos || a.keyword.acos);
    const bAcos = metricNumber(b.campaign.acos || b.keyword.acos);
    if (aAcos > 0 && bAcos > 0 && aAcos !== bAcos) return aAcos - bAcos;
    if (aAcos > 0 && bAcos === 0) return -1;
    if (bAcos > 0 && aAcos === 0) return 1;

    const aDate = new Date(a.campaign.created_at || a.campaign.created_date || 0).getTime();
    const bDate = new Date(b.campaign.created_at || b.campaign.created_date || 0).getTime();
    if (aDate !== bDate) return aDate - bDate;

    return String(a.campaignId).localeCompare(String(b.campaignId));
  })[0];
}

async function invoke(base44:any, fn:string, payload:any) {
  const response = await base44.asServiceRole.functions.invoke(fn, payload);
  return response?.data || response || {};
}

async function resolveAccount(base44:any, requestedId?:string|null) {
  if (requestedId) {
    const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ id: requestedId }, null, 1);
    return rows[0] || null;
  }
  const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
  return rows[0] || null;
}

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    const account = await resolveAccount(base44, body.amazon_account_id || null);
    if (!account) return Response.json({ ok: false, error: 'AmazonAccount conectada não encontrada' }, { status: 404 });

    const accountId = account.id;
    const marketplaceId = String(account.marketplace_id || account.ads_marketplace_id || '');
    const maxPerRun = Math.max(1, Math.min(50, Number(body.max_per_run || MAX_PER_RUN)));

    const [campaigns, keywords, products, suggestions] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-created_at', 5000).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-created_at', 15000).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, null, 5000).catch(() => []),
      base44.asServiceRole.entities.KeywordSuggestion.filter({ amazon_account_id: accountId }, '-created_at', 15000).catch(() => []),
    ]);

    const productByAsin = new Map(products.filter((p:any) => p.asin).map((p:any) => [String(p.asin), p]));
    const keywordsByCampaign = new Map<string, any[]>();
    for (const keyword of keywords) {
      const campaignId = String(keyword.campaign_id || keyword.amazon_campaign_id || '');
      if (!campaignId) continue;
      if (!keywordsByCampaign.has(campaignId)) keywordsByCampaign.set(campaignId, []);
      keywordsByCampaign.get(campaignId)!.push(keyword);
    }

    const manualCampaigns = campaigns.filter(isManualCampaign).filter((campaign:any) => isActive(campaign.state || campaign.status));
    const candidates:any[] = [];
    const invalid:any[] = [];

    for (const campaign of manualCampaigns) {
      const campaignId = String(campaign.campaign_id || campaign.amazon_campaign_id || '');
      if (!campaignId) continue;

      const allActive = (keywordsByCampaign.get(campaignId) || []).filter((keyword:any) => isActive(keyword.state || keyword.status));
      const activeExact = allActive.filter((keyword:any) => isExactKeyword(keyword) && normalizeTerm(keyword.keyword_text || keyword.keyword));
      const activeNonExact = allActive.filter((keyword:any) => !isExactKeyword(keyword));
      const asin = String(campaign.asin || activeExact[0]?.asin || '');
      const adGroupIds = new Set(allActive.map((keyword:any) => String(keyword.ad_group_id || keyword.amazon_ad_group_id || '')).filter(Boolean));
      if (campaign.ad_group_id || campaign.amazon_ad_group_id) adGroupIds.add(String(campaign.ad_group_id || campaign.amazon_ad_group_id));

      if (asin && activeExact.length === 1 && activeNonExact.length === 0 && adGroupIds.size <= 1) {
        const keyword = activeExact[0];
        const normalized = normalizeTerm(keyword.keyword_text || keyword.keyword);
        const canonicalKey = `${accountId}|${marketplaceId}|${asin}|${normalized}|exact`;
        candidates.push({ campaign, campaignId, asin, keyword, normalized, canonicalKey });
      } else {
        invalid.push({
          campaign,
          campaignId,
          asin,
          activeExact,
          activeNonExact,
          reason: !asin
            ? 'missing_asin'
            : activeExact.length !== 1
              ? `invalid_exact_count_${activeExact.length}`
              : activeNonExact.length > 0
                ? 'non_exact_keyword_present'
                : 'multiple_ad_groups',
        });
      }
    }

    const grouped = new Map<string, any[]>();
    for (const item of candidates) {
      if (!grouped.has(item.canonicalKey)) grouped.set(item.canonicalKey, []);
      grouped.get(item.canonicalKey)!.push(item);
    }

    const canonicalKeys = new Set<string>();
    const duplicateCampaignIds = new Set<string>();
    for (const [key, items] of grouped) {
      const winner = chooseWinner(items);
      canonicalKeys.add(key);
      for (const item of items) {
        if (item.campaignId !== winner.campaignId) duplicateCampaignIds.add(item.campaignId);
      }
    }

    for (const item of candidates) {
      if (duplicateCampaignIds.has(item.campaignId)) {
        invalid.push({
          campaign: item.campaign,
          campaignId: item.campaignId,
          asin: item.asin,
          activeExact: [item.keyword],
          activeNonExact: [],
          reason: 'duplicate_asin_term',
          skipRecreate: true,
        });
      }
    }

    const existingSuggestionKeys = new Set(
      suggestions
        .filter((s:any) => !['rejected', 'blocked', 'archived_by_policy', 'superseded'].includes(String(s.status || '')))
        .map((s:any) => `${accountId}|${marketplaceId}|${String(s.asin || '')}|${normalizeTerm(s.keyword)}|exact`),
    );

    const report:any = {
      ok: true,
      amazon_account_id: accountId,
      scanned_manual_campaigns: manualCampaigns.length,
      canonical_active_campaigns: canonicalKeys.size,
      invalid_active_campaigns: invalid.length,
      duplicate_active_campaigns: duplicateCampaignIds.size,
      paused: [],
      recreated: [],
      skipped: [],
      failed: [],
      continuation_required: invalid.length > maxPerRun,
      canonical_rule: 'one_campaign_one_ad_group_one_product_ad_one_exact_term',
      initial_bid: DEFAULT_BID,
      started_at: startedAt,
    };

    for (const item of invalid.slice(0, maxPerRun)) {
      const { campaign, campaignId, asin, activeExact, reason, skipRecreate } = item;
      if (!asin) {
        report.skipped.push({ campaign_id: campaignId, reason: 'ASIN ausente; reconciliação obrigatória' });
        continue;
      }

      const product = productByAsin.get(asin);
      if (!product || product.inventory_status === 'out_of_stock' || Number(product.fba_inventory || product.stock || 0) <= 0) {
        report.skipped.push({ campaign_id: campaignId, asin, reason: 'Produto ausente ou sem estoque' });
        continue;
      }

      const pauseKey = `canonical_manual_pause|${accountId}|${marketplaceId}|${campaignId}|${reason}`;
      const existingPause = await base44.asServiceRole.entities.OptimizationDecision.filter({
        amazon_account_id: accountId,
        idempotency_key: pauseKey,
      }, '-created_at', 1).catch(() => []);

      const pauseDecision = existingPause[0] || await base44.asServiceRole.entities.OptimizationDecision.create({
        amazon_account_id: accountId,
        decision_type: 'pause',
        entity_type: 'campaign',
        entity_id: campaignId,
        campaign_id: campaignId,
        asin,
        action: 'pause_campaign',
        objective: 'maintenance',
        rationale: `Campanha manual fora da regra canônica (${reason}). Regra: uma campanha, um ad group, um Product Ad e uma keyword EXACT por termo.`,
        confidence: 100,
        risk: 'low',
        reversible: true,
        requires_approval: false,
        status: 'approved',
        queue_status: 'scheduled',
        queue_hour: 16,
        queue_window: '16:00-18:00',
        queued_at: new Date().toISOString(),
        idempotency_key: pauseKey,
        trigger: 'canonical_manual_campaign_migration',
        source_function: 'enforceCanonicalManualCampaigns',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const pauseResult = await invoke(base44, 'executeAutopilotDecision', {
        decision_id: pauseDecision.id,
        decision_ids: [pauseDecision.id],
        _window_execution: true,
        _service_role: true,
      }).catch((error:any) => ({ ok: false, error: error?.message || String(error) }));

      const pauseOk = Number(pauseResult?.executed || 0) > 0
        || pauseResult?.results?.some((row:any) => row?.ok === true || row?.status === 'executed');
      if (!pauseOk) {
        report.failed.push({ campaign_id: campaignId, asin, step: 'pause', error: pauseResult?.error || pauseResult });
        continue;
      }

      report.paused.push({ campaign_id: campaignId, asin, reason, terms: activeExact.length });
      await wait(WAIT_MS);

      if (skipRecreate) continue;

      const uniqueTerms = new Map<string, any>();
      for (const keyword of activeExact) {
        const term = String(keyword.keyword_text || keyword.keyword || '').trim();
        const normalized = normalizeTerm(term);
        if (normalized) uniqueTerms.set(normalized, { term, keyword });
      }

      for (const [normalized, termData] of uniqueTerms) {
        const canonicalKey = `${accountId}|${marketplaceId}|${asin}|${normalized}|exact`;
        if (canonicalKeys.has(canonicalKey)) {
          report.skipped.push({ campaign_id: campaignId, asin, term: termData.term, reason: 'Termo já possui campanha canônica ativa' });
          continue;
        }

        let suggestion = suggestions.find((s:any) =>
          String(s.asin || '') === asin && normalizeTerm(s.keyword) === normalized && ['suggested', 'approved', 'failed'].includes(String(s.status || ''))
        );

        if (!suggestion) {
          if (existingSuggestionKeys.has(canonicalKey)) {
            report.skipped.push({ campaign_id: campaignId, asin, term: termData.term, reason: 'Sugestão equivalente já está em processamento' });
            continue;
          }
          suggestion = await base44.asServiceRole.entities.KeywordSuggestion.create({
            amazon_account_id: accountId,
            product_id: product.id || null,
            asin,
            sku: product.sku || campaign.sku || null,
            keyword: termData.term,
            normalized_keyword: normalized,
            match_type: 'exact',
            source: 'MANUAL_SEARCH_TERM',
            target_type: 'keyword',
            confidence: 1,
            relevance_score: 1,
            reason: `Migração canônica da campanha ${campaignId}: uma campanha manual EXACT por termo.`,
            risk_level: 'low',
            implementation_priority: 'immediate',
            should_create_campaign: true,
            recommended_bid: DEFAULT_BID,
            recommended_budget: Number(campaign.daily_budget || 5),
            recommended_match_type: 'EXACT',
            status: 'approved',
            source_campaign_id: campaignId,
            approved_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          });
          existingSuggestionKeys.add(canonicalKey);
        }

        const createResult = await invoke(base44, 'createManualCampaignFromKeywordSuggestion', {
          amazon_account_id: accountId,
          suggestion_ids: [suggestion.id],
          overrides: {
            [suggestion.id]: {
              bid: Math.max(DEFAULT_BID, Number(suggestion.suggested_bid_min || suggestion.amazon_suggested_bid_lower || 0)),
              budget: Number(campaign.daily_budget || 5),
            },
          },
          _window_execution: true,
          _service_role: true,
        }).catch((error:any) => ({ ok: false, error: error?.message || String(error) }));

        const created = Number(createResult?.created || 0) > 0 || createResult?.results?.some((row:any) => row?.ok === true);
        if (created) {
          canonicalKeys.add(canonicalKey);
          report.recreated.push({ asin, term: termData.term, bid: Math.max(DEFAULT_BID, Number(suggestion.suggested_bid_min || suggestion.amazon_suggested_bid_lower || 0)), source_campaign_id: campaignId });
        } else {
          report.failed.push({ campaign_id: campaignId, asin, term: termData.term, step: 'recreate', error: createResult?.error || createResult });
        }
        await wait(WAIT_MS);
      }
    }

    report.completed_at = new Date().toISOString();
    report.remaining_invalid = Math.max(0, invalid.length - Math.min(invalid.length, maxPerRun));
    report.continuation_required = report.remaining_invalid > 0 || report.failed.length > 0;

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'enforce_canonical_manual_campaigns',
      trigger_type: 'automatic',
      status: report.failed.length ? 'warning' : report.continuation_required ? 'pending' : 'success',
      started_at: startedAt,
      completed_at: report.completed_at,
      records_processed: report.paused.length + report.recreated.length,
      result_summary: JSON.stringify(report).slice(0, 4000),
      error_message: report.failed.length ? `${report.failed.length} etapa(s) falharam; nova tentativa necessária.` : null,
    }).catch(() => {});

    return Response.json(report);
  } catch (error:any) {
    return Response.json({
      ok: false,
      error: error?.message || 'Falha na migração canônica de campanhas manuais',
      previous_data_preserved: true,
    }, { status: 500 });
  }
});