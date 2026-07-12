import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const DEFAULT_BID = 0.60;
const DEFAULT_BUDGET = 7;
const MAX_BATCH = 20;
const WAIT_MS = 3000;
const CT_CAMPAIGN = 'application/vnd.spCampaign.v3+json';
const sleep = (ms:number) => new Promise(r => setTimeout(r, ms));

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

function isActive(value:any) {
  return ['active', 'enabled'].includes(String(value || '').toLowerCase());
}

function isManual(c:any) {
  const type = String(c.targeting_type || c.targetingType || c.campaign_type || '').toLowerCase();
  const name = String(c.name || c.campaign_name || '').toLowerCase();
  return type === 'manual' || name.includes('| manual |');
}

function keywordText(k:any) {
  return String(k.keyword_text || k.keyword || '').trim();
}

function keywordId(k:any) {
  return String(k.keyword_id || k.amazon_keyword_id || k.entity_id || '');
}

function isExact(k:any) {
  return String(k.match_type || k.matchType || '').toLowerCase() === 'exact';
}

function metric(v:any) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}

function chooseKeywordToKeep(campaign:any, keywords:any[]) {
  const normalizedName = normalizeTerm(campaign.name || campaign.campaign_name || '');
  return [...keywords].sort((a:any, b:any) => {
    const aText = normalizeTerm(keywordText(a));
    const bText = normalizeTerm(keywordText(b));
    const aName = normalizedName.endsWith(aText) ? 1 : 0;
    const bName = normalizedName.endsWith(bText) ? 1 : 0;
    if (aName !== bName) return bName - aName;
    const aSales = metric(a.sales || a.attributed_sales);
    const bSales = metric(b.sales || b.attributed_sales);
    if (aSales !== bSales) return bSales - aSales;
    const aOrders = metric(a.orders || a.purchases);
    const bOrders = metric(b.orders || b.purchases);
    if (aOrders !== bOrders) return bOrders - aOrders;
    return keywordId(a).localeCompare(keywordId(b));
  })[0];
}

function chooseCampaignWinner(items:any[]) {
  return [...items].sort((a:any, b:any) => {
    const aSales = metric(a.campaign.sales || a.campaign.attributed_sales || a.keyword.sales);
    const bSales = metric(b.campaign.sales || b.campaign.attributed_sales || b.keyword.sales);
    if (aSales !== bSales) return bSales - aSales;
    const aOrders = metric(a.campaign.orders || a.campaign.purchases || a.keyword.orders);
    const bOrders = metric(b.campaign.orders || b.campaign.purchases || b.keyword.orders);
    if (aOrders !== bOrders) return bOrders - aOrders;
    const aAcos = metric(a.campaign.acos || a.keyword.acos);
    const bAcos = metric(b.campaign.acos || b.keyword.acos);
    if (aAcos > 0 && bAcos > 0 && aAcos !== bAcos) return aAcos - bAcos;
    const aDate = new Date(a.campaign.created_at || a.campaign.created_date || 0).getTime();
    const bDate = new Date(b.campaign.created_at || b.campaign.created_date || 0).getTime();
    if (aDate !== bDate) return aDate - bDate;
    return String(a.campaignId).localeCompare(String(b.campaignId));
  })[0];
}

async function invoke(base44:any, name:string, payload:any) {
  const response = await base44.asServiceRole.functions.invoke(name, payload);
  return response?.data || response || {};
}

async function pauseCampaign(base44:any, accountId:string, campaignId:string) {
  return invoke(base44, 'amazonAdsCommand', {
    amazon_account_id: accountId,
    operation: 'pauseCampaign',
    method: 'PUT',
    path: '/sp/campaigns',
    payload: { campaigns: [{ campaignId, state: 'PAUSED' }] },
    content_type: CT_CAMPAIGN,
    accept: CT_CAMPAIGN,
    max_attempts: 3,
    _service_role: true,
  });
}

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok:false, error:'Uso interno' }, { status:403 });

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status:'connected' }, '-created_date', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok:false, error:'AmazonAccount conectada não encontrada' }, { status:404 });

    const accountId = account.id;
    const marketplaceId = String(account.marketplace_id || account.ads_marketplace_id || '');
    const maxPerRun = Math.max(1, Math.min(MAX_BATCH, Number(body.max_per_run || body.batch_size || MAX_BATCH)));

    const [campaigns, keywords, products, suggestions] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-created_at', 5000).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-created_at', 15000).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, null, 5000).catch(() => []),
      base44.asServiceRole.entities.KeywordSuggestion.filter({ amazon_account_id: accountId }, '-created_at', 15000).catch(() => []),
    ]);

    const productByAsin = new Map(products.filter((p:any) => p.asin).map((p:any) => [String(p.asin), p]));
    const keywordsByCampaign = new Map<string, any[]>();
    for (const keyword of keywords) {
      const cid = String(keyword.campaign_id || keyword.amazon_campaign_id || '');
      if (!cid) continue;
      if (!keywordsByCampaign.has(cid)) keywordsByCampaign.set(cid, []);
      keywordsByCampaign.get(cid)!.push(keyword);
    }

    const manual = campaigns.filter(isManual).filter((c:any) => isActive(c.state || c.status));
    const canonicalCandidates:any[] = [];
    const splitCandidates:any[] = [];
    const pauseCandidates:any[] = [];

    for (const campaign of manual) {
      const campaignId = String(campaign.campaign_id || campaign.amazon_campaign_id || '');
      if (!campaignId) continue;
      const active = (keywordsByCampaign.get(campaignId) || []).filter((k:any) => isActive(k.state || k.status));
      const exact = active.filter((k:any) => isExact(k) && normalizeTerm(keywordText(k)));
      const asin = String(campaign.asin || exact[0]?.asin || active[0]?.asin || '');

      if (!asin || active.length === 0 || exact.length === 0) {
        pauseCandidates.push({ campaign, campaignId, asin, reason: !asin ? 'missing_asin' : active.length === 0 ? 'zero_active_keywords' : 'no_exact_keyword' });
        continue;
      }

      const keep = active.length === 1 && exact.length === 1 ? exact[0] : chooseKeywordToKeep(campaign, exact);
      const normalized = normalizeTerm(keywordText(keep));
      const key = `${accountId}|${marketplaceId}|${asin}|${normalized}|exact`;
      canonicalCandidates.push({ campaign, campaignId, asin, keyword: keep, key });

      const extras = active.filter((k:any) => keywordId(k) !== keywordId(keep));
      if (extras.length) splitCandidates.push({ campaign, campaignId, asin, keep, extras });
    }

    const grouped = new Map<string, any[]>();
    for (const item of canonicalCandidates) {
      if (!grouped.has(item.key)) grouped.set(item.key, []);
      grouped.get(item.key)!.push(item);
    }

    const canonicalKeys = new Set<string>();
    const duplicateCampaignIds = new Set<string>();
    for (const [key, items] of grouped) {
      const winner = chooseCampaignWinner(items);
      canonicalKeys.add(key);
      for (const item of items) if (item.campaignId !== winner.campaignId) duplicateCampaignIds.add(item.campaignId);
    }

    for (const item of canonicalCandidates) {
      if (duplicateCampaignIds.has(item.campaignId)) pauseCandidates.push({ ...item, reason:'duplicate_asin_term' });
    }

    const report:any = {
      ok:true,
      scanned_manual_campaigns:manual.length,
      split_campaigns_found:splitCandidates.length,
      duplicate_active_campaigns:duplicateCampaignIds.size,
      keyword_pauses:[],
      campaigns_paused:[],
      recreated:[],
      skipped:[],
      failed:[],
      started_at:startedAt,
      canonical_rule:'one_campaign_one_ad_group_one_product_ad_one_exact_term',
    };

    async function createCampaignForKeyword(sourceCampaign:any, asin:string, keyword:any) {
      const product = productByAsin.get(asin);
      const term = keywordText(keyword);
      const normalized = normalizeTerm(term);
      const key = `${accountId}|${marketplaceId}|${asin}|${normalized}|exact`;
      if (!product || product.inventory_status === 'out_of_stock' || Number(product.fba_inventory || product.stock || 0) <= 0) {
        report.skipped.push({ asin, term, reason:'Produto ausente ou sem estoque' });
        return false;
      }
      if (!normalized || canonicalKeys.has(key)) {
        report.skipped.push({ asin, term, reason:canonicalKeys.has(key) ? 'Termo já possui campanha canônica ativa' : 'Termo inválido' });
        return canonicalKeys.has(key);
      }

      let suggestion = suggestions.find((s:any) => String(s.asin || '') === asin && normalizeTerm(s.keyword) === normalized && !['rejected','blocked','superseded'].includes(String(s.status || '')));
      if (!suggestion) {
        suggestion = await base44.asServiceRole.entities.KeywordSuggestion.create({
          amazon_account_id:accountId,
          product_id:product.id || null,
          asin,
          sku:product.sku || sourceCampaign.sku || keyword.sku || null,
          keyword:term,
          normalized_keyword:normalized,
          match_type:'exact',
          source:'MANUAL_SEARCH_TERM',
          target_type:'keyword',
          confidence:1,
          relevance_score:1,
          reason:`Separação canônica da campanha ${sourceCampaign.campaign_id || sourceCampaign.amazon_campaign_id}`,
          risk_level:'low',
          implementation_priority:'immediate',
          should_create_campaign:true,
          recommended_bid:DEFAULT_BID,
          recommended_budget:Number(sourceCampaign.daily_budget || sourceCampaign.budget || DEFAULT_BUDGET),
          recommended_match_type:'EXACT',
          status:'approved',
          source_campaign_id:String(sourceCampaign.campaign_id || sourceCampaign.amazon_campaign_id || ''),
          approved_at:new Date().toISOString(),
          created_at:new Date().toISOString(),
        });
      }

      const bid = Math.max(DEFAULT_BID, Number(suggestion.suggested_bid_min || suggestion.amazon_suggested_bid_lower || 0));
      const result = await invoke(base44, 'createManualCampaignFromKeywordSuggestion', {
        amazon_account_id:accountId,
        suggestion_ids:[suggestion.id],
        overrides:{ [suggestion.id]:{ bid, budget:Number(sourceCampaign.daily_budget || sourceCampaign.budget || DEFAULT_BUDGET) } },
        _window_execution:true,
        _service_role:true,
      }).catch((error:any) => ({ ok:false, error:error?.message || String(error) }));

      const created = Number(result?.created || 0) > 0 || result?.results?.some((r:any) => r?.ok === true || r?.status === 'executed');
      if (created) {
        canonicalKeys.add(key);
        report.recreated.push({ asin, term, bid, source_campaign_id:String(sourceCampaign.campaign_id || sourceCampaign.amazon_campaign_id || '') });
        return true;
      }
      report.failed.push({ asin, term, step:'create_campaign', error:result?.error || result });
      return false;
    }

    let processed = 0;
    for (const item of splitCandidates) {
      if (processed >= maxPerRun || duplicateCampaignIds.has(item.campaignId)) continue;
      for (const extra of item.extras) {
        if (processed >= maxPerRun) break;
        const id = keywordId(extra);
        const term = keywordText(extra);
        if (!id || !term) {
          report.skipped.push({ campaign_id:item.campaignId, term, reason:'keywordId ou termo ausente' });
          continue;
        }

        const pauseKey = `canonical_pause_keyword|${accountId}|${marketplaceId}|${id}`;
        const existing = await base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id:accountId, idempotency_key:pauseKey }, '-created_at', 1).catch(() => []);
        const decision = existing[0] || await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id:accountId,
          decision_type:'pause',
          entity_type:'keyword',
          entity_id:id,
          keyword_id:id,
          keyword_text:term,
          campaign_id:item.campaignId,
          asin:item.asin,
          action:'pause_keyword',
          objective:'maintenance',
          rationale:`Keyword adicional; mantida apenas "${keywordText(item.keep)}" nesta campanha.`,
          confidence:100,
          risk:'low',
          reversible:true,
          requires_approval:false,
          status:'approved',
          queue_status:'scheduled',
          queue_hour:16,
          queue_window:'16:00-18:00',
          queued_at:new Date().toISOString(),
          idempotency_key:pauseKey,
          trigger:'canonical_manual_keyword_split',
          source_function:'enforceCanonicalManualCampaigns',
          created_at:new Date().toISOString(),
          updated_at:new Date().toISOString(),
        });

        const pauseResult = await invoke(base44, 'executeAutopilotDecision', { decision_id:decision.id, decision_ids:[decision.id], _window_execution:true, _service_role:true }).catch((error:any) => ({ ok:false, error:error?.message || String(error) }));
        const paused = Number(pauseResult?.executed || 0) > 0 || pauseResult?.results?.some((r:any) => r?.ok === true || r?.status === 'executed');
        if (!paused) {
          report.failed.push({ campaign_id:item.campaignId, keyword_id:id, term, step:'pause_keyword', error:pauseResult?.error || pauseResult });
          processed++;
          continue;
        }

        report.keyword_pauses.push({ campaign_id:item.campaignId, keyword_id:id, asin:item.asin, term });
        await sleep(WAIT_MS);
        await createCampaignForKeyword(item.campaign, item.asin, extra);
        await sleep(WAIT_MS);
        processed++;
      }
    }

    for (const item of pauseCandidates) {
      if (processed >= maxPerRun) break;
      try {
        await pauseCampaign(base44, accountId, item.campaignId);
        await base44.asServiceRole.entities.Campaign.update(item.campaign.id, { state:'paused', status:'paused', updated_at:new Date().toISOString() }).catch(() => {});
        report.campaigns_paused.push({ campaign_id:item.campaignId, asin:item.asin, reason:item.reason });
      } catch (error:any) {
        report.failed.push({ campaign_id:item.campaignId, asin:item.asin, step:'pause_campaign', error:error?.message || String(error) });
      }
      processed++;
      await sleep(WAIT_MS);
    }

    const totalPending = splitCandidates.reduce((sum:number, item:any) => sum + item.extras.length, 0) + pauseCandidates.length;
    report.processed_actions = processed;
    report.remaining_invalid = Math.max(0, totalPending - processed);
    report.continuation_required = report.remaining_invalid > 0 || report.failed.length > 0;
    report.completed_at = new Date().toISOString();

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id:accountId,
      operation:'enforce_canonical_manual_campaigns',
      trigger_type:'automatic',
      status:report.failed.length ? 'warning' : report.continuation_required ? 'pending' : 'success',
      started_at:startedAt,
      completed_at:report.completed_at,
      records_processed:report.keyword_pauses.length + report.campaigns_paused.length + report.recreated.length,
      result_summary:JSON.stringify(report).slice(0, 4000),
      error_message:report.failed.length ? `${report.failed.length} etapa(s) falharam` : null,
    }).catch(() => {});

    return Response.json(report);
  } catch (error:any) {
    return Response.json({ ok:false, error:error?.message || 'Falha na migração canônica', previous_data_preserved:true }, { status:500 });
  }
});