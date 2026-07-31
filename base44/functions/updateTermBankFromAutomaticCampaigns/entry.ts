import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import {
  availableInventory,
  economicsAreActionable,
  normalizeState,
  numberValue,
  resolveOperatingAcos,
  roundMoney,
} from '../../shared/profitGuardPolicy.ts';

const ATTRIBUTION_SAFETY_HOURS = 72;
const MIN_MEDIUM_TAIL_ORDERS = 3;
const MIN_LONG_TAIL_ORDERS = 2;
const MAX_TERMS_PER_RUN = 5000;

function normalizeTerm(value: unknown): string {
  return String(value || '').toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

function isAutomaticCampaign(campaign: any): boolean {
  const targeting = String(campaign?.targeting_type || '').toUpperCase();
  const name = String(campaign?.name || campaign?.campaign_name || '').toUpperCase();
  return targeting.includes('AUTO') || /^AUTO\s*\|/.test(name) || /\|\s*AUTO\s*\|/.test(name);
}

function isAsinTerm(value: string): boolean {
  return /^B0[A-Z0-9]{8}$/i.test(value.trim());
}

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (!body._service_role) {
      const authenticated = await base44.auth.isAuthenticated().catch(() => false);
      if (!authenticated) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accountRows = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 1);
    const account = accountRows[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon encontrada' }, { status: 404 });
    const aid = account.id;

    const [campaigns, searchTerms, products, economics, settingsRows, existingTerms] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-updated_at', 5000).catch(() => []),
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: aid }, '-date', 15000).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 2000).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, '-updated_at', 2000).catch(() => []),
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1).catch(() => []),
      base44.asServiceRole.entities.TermBank.filter({ amazon_account_id: aid }, null, 10000).catch(() => []),
    ]);

    const settings = settingsRows[0] || {};
    const accountTargetAcos = numberValue(settings.target_acos, 15);
    const safetyCutoff = new Date(Date.now() - ATTRIBUTION_SAFETY_HOURS * 3600000).toISOString().slice(0, 10);

    const autoCampaignById = new Map<string, any>();
    for (const campaign of campaigns) {
      if (!isAutomaticCampaign(campaign) || campaign.archived) continue;
      if (!['enabled', 'paused', 'active'].includes(normalizeState(campaign.state || campaign.status))) continue;
      for (const id of [campaign.id, campaign.campaign_id, campaign.amazon_campaign_id].filter(Boolean)) {
        autoCampaignById.set(String(id), campaign);
      }
    }
    if (!autoCampaignById.size) {
      return Response.json({ ok: true, skipped: true, reason: 'Nenhuma campanha automática canônica encontrada' });
    }

    const productByAsin = new Map(products.filter((p: any) => p.asin).map((p: any) => [String(p.asin), p]));
    const economicsByAsin = new Map(economics.filter((e: any) => e.asin).map((e: any) => [String(e.asin), e]));
    const aggregates = new Map<string, any>();

    for (const row of searchTerms) {
      const campaign = autoCampaignById.get(String(row.campaign_id || ''));
      if (!campaign || !row.search_term) continue;
      if (row.date && String(row.date) >= safetyCutoff) continue;
      const asin = String(row.advertised_asin || campaign.asin || '');
      if (!asin) continue;
      const normalized = normalizeTerm(row.search_term);
      if (!normalized || isAsinTerm(normalized)) continue;
      const words = normalized.split(/\s+/).filter(Boolean).length;
      if (words < 2) continue;
      const key = `${asin}|${normalized}`;
      const aggregate = aggregates.get(key) || {
        amazon_account_id: aid,
        asin,
        sku: row.advertised_sku || campaign.sku || '',
        term: row.search_term,
        normalized,
        words,
        source_campaign_id: String(row.campaign_id || ''),
        impressions: 0,
        clicks: 0,
        spend: 0,
        orders: 0,
        sales: 0,
        last_seen_at: null,
      };
      aggregate.impressions += numberValue(row.impressions);
      aggregate.clicks += numberValue(row.clicks);
      aggregate.spend += numberValue(row.spend);
      aggregate.orders += Math.max(numberValue(row.orders_14d), numberValue(row.orders_30d), numberValue(row.orders));
      aggregate.sales += Math.max(numberValue(row.sales_14d), numberValue(row.sales_30d), numberValue(row.sales));
      if (row.date && (!aggregate.last_seen_at || row.date > aggregate.last_seen_at)) aggregate.last_seen_at = row.date;
      aggregates.set(key, aggregate);
    }

    const eligible: any[] = [];
    const rejected: any[] = [];
    for (const aggregate of aggregates.values()) {
      const product = productByAsin.get(aggregate.asin);
      const econ = economicsByAsin.get(aggregate.asin);
      if (!product || availableInventory(product) <= 0) {
        rejected.push({ asin: aggregate.asin, term: aggregate.term, reason: 'sem_estoque_ou_produto' });
        continue;
      }
      if (!economicsAreActionable(econ)) {
        rejected.push({ asin: aggregate.asin, term: aggregate.term, reason: 'economia_incompleta' });
        continue;
      }
      const minOrders = aggregate.words === 2 ? MIN_MEDIUM_TAIL_ORDERS : MIN_LONG_TAIL_ORDERS;
      if (aggregate.orders < minOrders || aggregate.sales <= 0) {
        rejected.push({ asin: aggregate.asin, term: aggregate.term, reason: `evidencia_insuficiente_${aggregate.orders}_${minOrders}` });
        continue;
      }
      const policy = resolveOperatingAcos(econ, accountTargetAcos);
      const acos = aggregate.sales > 0 ? (aggregate.spend / aggregate.sales) * 100 : null;
      if (acos === null || (policy.break_even_acos && acos >= policy.break_even_acos)) {
        rejected.push({ asin: aggregate.asin, term: aggregate.term, reason: 'acos_acima_break_even', acos: roundMoney(acos || 0) });
        continue;
      }
      const cpc = aggregate.clicks > 0 ? aggregate.spend / aggregate.clicks : 0;
      const cvr = aggregate.clicks > 0 ? aggregate.orders / aggregate.clicks * 100 : 0;
      const classification = acos <= policy.target_acos ? 'winner' : 'profitable_learning';
      eligible.push({ ...aggregate, policy, acos, cpc, cvr, classification });
    }

    const existingIndex = new Map<string, any>();
    for (const item of existingTerms) {
      const key = `${item.asin || ''}|${normalizeTerm(item.term || item.keyword || item.term_normalized || item.normalized_search_term || '')}`;
      existingIndex.set(key, item);
    }

    const now = new Date().toISOString();
    const toCreate: any[] = [];
    const toUpdate: any[] = [];
    for (const item of eligible
      .sort((a, b) => b.orders - a.orders || a.acos - b.acos)
      .slice(0, MAX_TERMS_PER_RUN)) {
      const key = `${item.asin}|${item.normalized}`;
      const confidence = item.orders >= 5 ? 95 : item.words === 2 ? 90 : 85;
      const record = {
        amazon_account_id: aid,
        term: item.term,
        keyword: item.term,
        term_normalized: item.normalized,
        normalized_search_term: item.normalized,
        asin: item.asin,
        sku: item.sku,
        product_name: productByAsin.get(item.asin)?.product_name || productByAsin.get(item.asin)?.display_name || '',
        match_type: 'exact',
        source: 'search_term_auto',
        source_type: 'AUTO_SEARCH_TERM',
        source_detail: `AUTO | ${item.source_campaign_id}`,
        campaign_id: item.source_campaign_id,
        amazon_campaign_id: item.source_campaign_id,
        impressions: item.impressions,
        clicks: item.clicks,
        spend: roundMoney(item.spend),
        orders: item.orders,
        sales: roundMoney(item.sales),
        cpc: roundMoney(item.cpc),
        ctr: item.impressions > 0 ? roundMoney(item.clicks / item.impressions * 100) : 0,
        conversion_rate: roundMoney(item.cvr),
        cvr: roundMoney(item.cvr),
        acos: roundMoney(item.acos),
        roas: item.spend > 0 ? roundMoney(item.sales / item.spend) : 0,
        status: 'active',
        classification: item.classification,
        confidence,
        confidence_score: confidence,
        promotion_status: item.classification === 'winner' ? 'eligible_for_manual_exact' : 'profitable_learning',
        is_winner: item.classification === 'winner',
        winner_tier: item.classification === 'winner' ? (item.orders >= 5 ? 'STRONG_WINNER' : 'WINNER') : 'NONE',
        target_acos: item.policy.target_acos,
        break_even_acos: item.policy.break_even_acos,
        last_seen_at: item.last_seen_at ? `${item.last_seen_at}T23:59:59-03:00` : now,
        updated_at: now,
      };
      const existing = existingIndex.get(key);
      if (existing) toUpdate.push({ id: existing.id, ...record });
      else toCreate.push({ ...record, first_seen_at: now, created_at: now });
    }

    const batchSize = 100;
    for (let i = 0; i < toCreate.length; i += batchSize) {
      await base44.asServiceRole.entities.TermBank.bulkCreate(toCreate.slice(i, i + batchSize));
    }
    for (let i = 0; i < toUpdate.length; i += batchSize) {
      await base44.asServiceRole.entities.TermBank.bulkUpdate(toUpdate.slice(i, i + batchSize));
    }

    const nowCompleted = new Date().toISOString();
    const summary = {
      automatic_campaigns: new Set([...autoCampaignById.values()].map((c: any) => c.id || c.campaign_id)).size,
      search_terms_read: searchTerms.length,
      aggregated_terms: aggregates.size,
      eligible_terms: eligible.length,
      medium_tail_eligible: eligible.filter((item) => item.words === 2).length,
      long_tail_eligible: eligible.filter((item) => item.words >= 3).length,
      terms_created: toCreate.length,
      terms_updated: toUpdate.length,
      rejected: rejected.length,
      attribution_safety_hours: ATTRIBUTION_SAFETY_HOURS,
    };

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'update_term_bank_from_auto_profit_aware',
      trigger_type: body._service_role ? 'scheduler' : 'manual',
      status: 'success',
      execution_date: nowCompleted.slice(0, 10),
      started_at: startedAt,
      completed_at: nowCompleted,
      records_processed: eligible.length,
      result_summary: JSON.stringify(summary),
    }).catch(() => {});

    return Response.json({
      ok: true,
      summary,
      eligible_sample: eligible.slice(0, 50).map((item) => ({
        asin: item.asin,
        term: item.term,
        word_count: item.words,
        orders: item.orders,
        sales: roundMoney(item.sales),
        spend: roundMoney(item.spend),
        acos: roundMoney(item.acos),
        target_acos: item.policy.target_acos,
        break_even_acos: item.policy.break_even_acos,
        classification: item.classification,
      })),
      rejected_sample: rejected.slice(0, 50),
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha ao atualizar TermBank' }, { status: 500 });
  }
});
