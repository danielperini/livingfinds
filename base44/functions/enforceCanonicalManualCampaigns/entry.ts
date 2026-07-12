import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const WAIT_MS = 3000;
const DEFAULT_BID = 0.60;
const MAX_PER_RUN = 10;
const wait = (ms:number) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeTerm(value:any) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
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
    const maxPerRun = Math.max(1, Math.min(50, Number(body.max_per_run || MAX_PER_RUN)));
    const [campaigns, keywords, products, suggestions] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-created_at', 3000).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-created_at', 10000).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, null, 3000).catch(() => []),
      base44.asServiceRole.entities.KeywordSuggestion.filter({ amazon_account_id: accountId }, '-created_at', 10000).catch(() => []),
    ]);

    const productByAsin = new Map(products.filter((p:any) => p.asin).map((p:any) => [String(p.asin), p]));
    const keywordsByCampaign = new Map<string, any[]>();
    for (const keyword of keywords) {
      const campaignId = String(keyword.campaign_id || '');
      if (!campaignId) continue;
      if (!keywordsByCampaign.has(campaignId)) keywordsByCampaign.set(campaignId, []);
      keywordsByCampaign.get(campaignId)!.push(keyword);
    }

    const manualCampaigns = campaigns.filter(isManualCampaign);
    const canonicalKeys = new Set<string>();
    const invalid:any[] = [];

    for (const campaign of manualCampaigns) {
      const campaignId = String(campaign.campaign_id || campaign.amazon_campaign_id || '');
      if (!campaignId || !isActive(campaign.state || campaign.status)) continue;
      const activeExact = (keywordsByCampaign.get(campaignId) || []).filter((keyword:any) =>
        isActive(keyword.state || keyword.status) && isExactKeyword(keyword) && normalizeTerm(keyword.keyword_text || keyword.keyword)
      );
      const asin = String(campaign.asin || activeExact[0]?.asin || '');
      if (activeExact.length === 1 && asin) {
        canonicalKeys.add(`${asin}|${normalizeTerm(activeExact[0].keyword_text || activeExact[0].keyword)}`);
      } else {
        invalid.push({ campaign, campaignId, asin, activeExact });
      }
    }

    const existingSuggestionKeys = new Set(
      suggestions
        .filter((s:any) => !['rejected', 'blocked', 'archived_by_policy', 'superseded'].includes(String(s.status || '')))
        .map((s:any) => `${String(s.asin || '')}|${normalizeTerm(s.keyword)}`),
    );

    const report:any = {
      ok: true,
      amazon_account_id: accountId,
      scanned_manual_campaigns: manualCampaigns.length,
      canonical_active_campaigns: canonicalKeys.size,
      invalid_active_campaigns: invalid.length,
      paused: [],
      recreated: [],
      skipped: [],
      failed: [],
      continuation_required: invalid.length > maxPerRun,
      canonical_rule: 'one_exact_term_per_manual_campaign',
      initial_bid: DEFAULT_BID,
      started_at: startedAt,
    };

    for (const item of invalid.slice(0, maxPerRun)) {
      const { campaign, campaignId, asin, activeExact } = item;
      if (!asin) {
        report.skipped.push({ campaign_id: campaignId, reason: 'ASIN ausente; reconciliação obrigatória' });
        continue;
      }

      const product = productByAsin.get(asin);
      if (!product || product.inventory_status === 'out_of_stock' || Number(product.fba_inventory || 0) <= 0) {
        report.skipped.push({ campaign_id: campaignId, asin, reason: 'Produto ausente ou sem estoque' });
        continue;
      }

      const pauseKey = `canonical_manual_pause|${accountId}|${campaignId}`;
      let pauseDecisionRows = await base44.asServiceRole.entities.OptimizationDecision.filter({
        amazon_account_id: accountId,
        idempotency_key: pauseKey,
      }, '-created_at', 1).catch(() => []);
      let pauseDecision = pauseDecisionRows[0];

      if (!pauseDecision) {
        pauseDecision = await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id: accountId,
          decision_type: 'pause',
          entity_type: 'campaign',
          entity_id: campaignId,
          campaign_id: campaignId,
          asin,
          action: 'pause_campaign',
          objective: 'maintenance',
          rationale: `Campanha manual fora da regra canônica: ${activeExact.length} keywords exact ativas. Regra: uma campanha por termo.`,
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
      }

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

      report.paused.push({ campaign_id: campaignId, asin, terms: activeExact.length });
      await wait(WAIT_MS);

      const uniqueTerms = new Map<string, any>();
      for (const keyword of activeExact) {
        const term = String(keyword.keyword_text || keyword.keyword || '').trim();
        const normalized = normalizeTerm(term);
        if (!normalized) continue;
        uniqueTerms.set(normalized, { term, keyword });
      }

      for (const [normalized, termData] of uniqueTerms) {
        const canonicalKey = `${asin}|${normalized}`;
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
            reason: `Migração canônica da campanha ${campaignId}: uma campanha manual exact por termo.`,
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
              bid: DEFAULT_BID,
              budget: Number(campaign.daily_budget || 5),
            },
          },
          _window_execution: true,
          _service_role: true,
        }).catch((error:any) => ({ ok: false, error: error?.message || String(error) }));

        const created = Number(createResult?.created || 0) > 0 || createResult?.results?.some((row:any) => row?.ok === true);
        if (created) {
          canonicalKeys.add(canonicalKey);
          report.recreated.push({ asin, term: termData.term, bid: DEFAULT_BID, source_campaign_id: campaignId });
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
