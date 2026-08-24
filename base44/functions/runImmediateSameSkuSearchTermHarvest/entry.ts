/**
 * Fecha o ciclo do Search Term Report:
 * SearchTerm diário -> TermBank -> campanha MANUAL EXACT -> negativa na origem.
 *
 * Uma venda total/halo nunca é tratada como venda do ASIN anunciado. A criação
 * exige colunas promovidas/same-SKU, ASIN resolvido sem ambiguidade, estoque e
 * CPC econômico seguro. Todas as chaves são ASIN + termo normalizado.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import {
  aggregateSearchTerms,
  calculateSafeHarvestBid,
  calculateWinnerExactBudget,
  evaluateHarvestCandidate,
  normalizeSearchTerm,
  numberValue,
  winnerScore,
} from '../../shared/searchTermHarvestPolicy.ts';
import {
  availableInventory,
  economicsAreActionable,
  resolveOperatingAcos,
} from '../../shared/profitGuardPolicy.ts';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const BATCH_SIZE = 10;

function brazilDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function dateOffset(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00-03:00`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function campaignIdOf(campaign: any): string {
  return String(campaign?.campaign_id || campaign?.amazon_campaign_id || '');
}

function sourceCampaignType(row: any, campaignById: Map<string, any>): 'AUTO' | 'MANUAL' | '' {
  const campaign = campaignById.get(String(row?.campaign_id || ''));
  const explicit = String(
    row?.source_campaign_type || campaign?.amazon_targeting_type || campaign?.targeting_type || '',
  ).trim().toUpperCase();
  if (explicit.includes('AUTO')) return 'AUTO';
  if (explicit.includes('MANUAL')) return 'MANUAL';
  const name = String(campaign?.name || campaign?.campaign_name || '').trim().toUpperCase();
  if (/^AUTO\s*\|/.test(name) || /\|\s*AUTO\s*\|/.test(name)) return 'AUTO';
  if (/^SP\s*\|\s*MANUAL\s*\|/.test(name)) return 'MANUAL';
  return '';
}

function campaignName(asin: string, term: string): string {
  const clean = term.replace(/[^a-z0-9\sáéíóúâêôãõç-]/gi, '').trim().slice(0, 48);
  return `SP | MANUAL | EXACT | ${asin} | ${clean}`.slice(0, 128);
}

function unwrap(response: any): any {
  return response?.data || response || {};
}

function payloadOf(response: any): any {
  const data = unwrap(response);
  return data?.payload || data || {};
}

function successItems(response: any, group: string): any[] {
  const payload = payloadOf(response);
  const container = payload?.[group];
  if (Array.isArray(container?.success)) return container.success;
  if (Array.isArray(payload?.success)) return payload.success;
  if (Array.isArray(container)) return container;
  if (Array.isArray(payload)) return payload;
  return [];
}

function successAt(response: any, group: string, index: number): any | null {
  const items = successItems(response, group);
  return items.find((item: any) => Number(item?.index) === index)
    || items[index]
    || null;
}

function amazonFailure(response: any, fallback: string): string {
  const data = unwrap(response);
  return String(data?.errors?.[0]?.message || data?.error || data?.message || fallback).slice(0, 500);
}

async function ads(base44: any, accountId: string, operation: string, path: string, payload: any, contentType: string) {
  const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
    amazon_account_id: accountId,
    operation,
    method: 'POST',
    path,
    payload,
    content_type: contentType,
    accept: contentType,
    max_attempts: 3,
    _service_role: true,
  });
  return unwrap(response);
}

async function loadPaged(entity: any, query: any, sort: string, maximum = 20000): Promise<any[]> {
  const rows: any[] = [];
  for (let skip = 0; skip < maximum; skip += 5000) {
    const page = await entity.filter(query, sort, Math.min(5000, maximum - skip), skip).catch(() => []);
    rows.push(...page);
    if (page.length < 5000) break;
  }
  return rows;
}

function sourceNeedsNegative(source: any): boolean {
  const match = normalizeSearchTerm(source.matchType).replace(/_/g, '-');
  const campaignType = String(source.campaignType || '').toUpperCase();
  return Boolean(source.campaignId && source.adGroupId) &&
    !(campaignType === 'MANUAL' && match === 'exact');
}

Deno.serve(async (request) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      const authenticated = await base44.auth.isAuthenticated().catch(() => false);
      if (!authenticated) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 50);
    if (!accounts.length) return Response.json({ ok: false, error: 'Nenhuma conta Amazon conectada' }, { status: 404 });

    const dryRun = body.dry_run === true;
    const maxPromotions = Math.max(1, Math.min(50, Number(body.max_promotions || 25)));
    const lookbackDays = Math.max(1, Math.min(65, Number(body.lookback_days || 65)));
    const today = brazilDate();
    const cutoff = dateOffset(today, -(lookbackDays - 1));
    const reports: any[] = [];

    for (const account of accounts) {
      const aid = account.id;
      const now = new Date().toISOString();
      const [searchTerms, campaigns, products, economics, assessments, settingsRows, keywords, promotions, termBank, keywordBank] = await Promise.all([
        loadPaged(base44.asServiceRole.entities.SearchTerm, { amazon_account_id: aid }, '-date', 20000),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, '-updated_at', 3000).catch(() => []),
        base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, '-updated_at', 3000).catch(() => []),
        base44.asServiceRole.entities.DailyProductAdsAssessment.filter({ amazon_account_id: aid }, '-assessment_date', 5000).catch(() => []),
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-updated_at', 10000).catch(() => []),
        base44.asServiceRole.entities.SearchTermPromotion.filter({ amazon_account_id: aid }, '-updated_at', 10000).catch(() => []),
        base44.asServiceRole.entities.TermBank.filter({ amazon_account_id: aid }, '-updated_at', 10000).catch(() => []),
        base44.asServiceRole.entities.KeywordBank.filter({ amazon_account_id: aid }, '-last_updated_at', 10000).catch(() => []),
      ]);

      const campaignById = new Map<string, any>();
      for (const campaign of campaigns) {
        for (const id of [campaign.id, campaign.campaign_id, campaign.amazon_campaign_id].filter(Boolean)) {
          campaignById.set(String(id), campaign);
        }
      }
      const productByAsin = new Map(products.filter((row: any) => row.asin).map((row: any) => [String(row.asin).toUpperCase(), row]));
      const economicsByAsin = new Map(economics.filter((row: any) => row.asin).map((row: any) => [String(row.asin).toUpperCase(), row]));
      const assessmentByAsin = new Map<string, any>();
      for (const row of assessments) {
        const asin = String(row.asin || '').toUpperCase();
        if (asin && !assessmentByAsin.has(asin)) assessmentByAsin.set(asin, row);
      }
      const settings = settingsRows[0] || {};
      const minBid = numberValue(settings.min_bid, 0.25);
      const maxBid = numberValue(settings.max_bid, 3);
      const targetAcos = numberValue(settings.target_acos, 15);
      const minimumCampaignBudget = Math.max(1, numberValue(settings.minimum_campaign_budget, 5));
      const maximumCampaignBudget = Math.max(minimumCampaignBudget, Math.min(100, numberValue(settings.maximum_campaign_budget, 30)));

      const exactKeys = new Set<string>();
      const exactDestinationByKey = new Map<string, any>();
      for (const keyword of keywords) {
        if (String(keyword.state || keyword.status || '').toLowerCase() === 'archived') continue;
        if (String(keyword.match_type || '').toLowerCase() !== 'exact') continue;
        const campaign = campaignById.get(String(keyword.campaign_id || ''));
        const asin = String(keyword.asin || campaign?.asin || '').toUpperCase();
        const term = normalizeSearchTerm(keyword.keyword_text || keyword.keyword);
        if (asin && term) {
          const key = `${asin}|${term}`;
          exactKeys.add(key);
          exactDestinationByKey.set(key, {
            campaignId: String(keyword.campaign_id || campaign?.campaign_id || campaign?.amazon_campaign_id || ''),
            keywordId: String(keyword.keyword_id || keyword.id || ''),
          });
        }
      }

      const promotionByKey = new Map<string, any>();
      for (const promotion of promotions) {
        const key = `${String(promotion.asin || '').toUpperCase()}|${normalizeSearchTerm(promotion.normalized_search_term || promotion.source_search_term)}`;
        if (key !== '|') promotionByKey.set(key, promotion);
      }
      const termBankByKey = new Map<string, any>();
      for (const row of termBank) {
        const key = `${String(row.asin || '').toUpperCase()}|${normalizeSearchTerm(row.term_normalized || row.term)}`;
        if (key !== '|') termBankByKey.set(key, row);
      }
      const keywordBankByKey = new Map<string, any>();
      for (const row of keywordBank) {
        const key = `${String(row.asin || '').toUpperCase()}|${normalizeSearchTerm(row.normalized_keyword || row.keyword)}`;
        if (key !== '|') keywordBankByKey.set(key, row);
      }

      const sourceCampaignId = String(body.source_campaign_id || '');
      const sourceSearchTerm = normalizeSearchTerm(body.source_search_term || '');
      const requestedSourceType = String(body.source_campaign_type || '').trim().toUpperCase();
      const targetAsins = new Set((Array.isArray(body.target_asins) ? body.target_asins : [])
        .map((value: unknown) => String(value || '').trim().toUpperCase()).filter(Boolean));
      const excludedAsins = new Set((Array.isArray(body.exclude_asins) ? body.exclude_asins : [])
        .map((value: unknown) => String(value || '').trim().toUpperCase()).filter(Boolean));
      const rawRowsInWindow = searchTerms.filter((row: any) => {
        const asin = String(row.advertised_asin || row.asin || '').trim().toUpperCase();
        return String(row.date || '') >= cutoff && row.search_term &&
          (!sourceCampaignId || String(row.campaign_id || '') === sourceCampaignId) &&
          (!sourceSearchTerm || normalizeSearchTerm(row.search_term) === sourceSearchTerm) &&
          (!targetAsins.size || targetAsins.has(asin)) &&
          !excludedAsins.has(asin) &&
          (!requestedSourceType || sourceCampaignType(row, campaignById) === requestedSourceType);
      });
      const verifiedKeys = new Set(rawRowsInWindow
        .filter((row: any) => row.same_sku_attribution_verified === true)
        .map((row: any) => `${String(row.advertised_asin || '').toUpperCase()}|${normalizeSearchTerm(row.search_term)}`));
      // Registros legados SUMMARY podem sobrepor a janela DAILY. Quando já há
      // linha com atribuição same-SKU, a linha total-only é excluída para não
      // duplicar gasto/venda nem reduzir artificialmente a confiança.
      const rowsInWindow = rawRowsInWindow.filter((row: any) => {
        const key = `${String(row.advertised_asin || '').toUpperCase()}|${normalizeSearchTerm(row.search_term)}`;
        return !verifiedKeys.has(key) || row.same_sku_attribution_verified === true;
      });
      const aggregates = aggregateSearchTerms(rowsInWindow);
      const rejected: any[] = [];
      const candidates: any[] = [];
      let bankCreated = 0;
      let bankUpdated = 0;

      for (const aggregate of aggregates) {
        const key = `${aggregate.asin}|${aggregate.normalizedTerm}`;
        const product = productByAsin.get(aggregate.asin);
        const econ = economicsByAsin.get(aggregate.asin);
        const assessment = assessmentByAsin.get(aggregate.asin);
        const policy = resolveOperatingAcos(econ, targetAcos);
        const observedCpc = aggregate.clicks > 0 ? aggregate.spend / aggregate.clicks : 0;
        const safeCpc = numberValue(assessment?.safe_max_cpc ?? econ?.safe_max_cpc, 0);
        const safeBid = calculateSafeHarvestBid({ observedCpc, safeCpc, minBid, maxBid });
        // Uma campanha MANUAL EXACT também descobre variações reais. Só bloqueie
        // a promoção quando esta consulta já existir como EXACT para o ASIN;
        // a mera origem MANUAL EXACT não transforma uma variação em duplicata.
        const evaluation = evaluateHarvestCandidate({
          aggregate,
          inStock: Boolean(product && availableInventory(product) > 0),
          economicsActionable: economicsAreActionable(econ, assessment),
          breakEvenAcos: numberValue(policy.break_even_acos, 0) || null,
          safeBid,
          alreadyExact: exactKeys.has(key),
          alreadyPromoted: promotionByKey.has(key),
        });
        const roas = aggregate.spend > 0 ? aggregate.sameSkuSales / aggregate.spend : 0;
        const cvr = aggregate.clicks > 0 ? aggregate.sameSkuOrders / aggregate.clicks * 100 : 0;
        const classification = evaluation.eligible ? 'winner'
          : aggregate.sameSkuOrders > 0 ? 'learning'
          : 'new';
        const existingBank = termBankByKey.get(key);
        const existingExact = exactDestinationByKey.get(key);
        const bankRecord = {
          amazon_account_id: aid,
          term: aggregate.term,
          term_normalized: aggregate.normalizedTerm,
          asin: aggregate.asin,
          sku: aggregate.sku || product?.sku || '',
          product_name: product?.product_name || product?.display_name || '',
          match_type: 'exact',
          recommended_match_type: 'EXACT',
          source: 'search_term_report',
          source_detail: JSON.stringify({
            same_sku_verified: aggregate.attributionVerified,
            sku_resolved: aggregate.skuResolutionVerified,
            source_paths: aggregate.sources,
            eligibility: evaluation.reason,
          }).slice(0, 4000),
          created_from: 'runImmediateSameSkuSearchTermHarvest',
          term_type: aggregate.normalizedTerm.split(' ').length >= 3 ? 'long_tail' : 'mid_tail',
          status: 'active',
          promotion_status: existingExact || existingBank?.promotion_status === 'promoted_to_manual'
            ? 'promoted_to_manual'
            : evaluation.eligible ? 'kickoff_candidate' : 'pending',
          confidence: aggregate.attributionVerified && aggregate.skuResolutionVerified ? 95 : 35,
          campaign_id: existingExact?.campaignId || existingBank?.campaign_id || aggregate.sources[0]?.campaignId || '',
          amazon_campaign_id: existingExact?.campaignId || existingBank?.amazon_campaign_id || aggregate.sources[0]?.campaignId || '',
          keyword_id: existingExact?.keywordId || existingBank?.keyword_id || '',
          impressions: aggregate.impressions,
          clicks: aggregate.clicks,
          spend: Number(aggregate.spend.toFixed(4)),
          orders: aggregate.totalOrders,
          sales: Number(aggregate.totalSales.toFixed(4)),
          same_sku_orders: aggregate.sameSkuOrders,
          same_sku_sales: Number(aggregate.sameSkuSales.toFixed(4)),
          halo_orders: aggregate.haloOrders,
          halo_sales: Number(aggregate.haloSales.toFixed(4)),
          same_sku_attribution_verified: aggregate.attributionVerified,
          source_campaign_ids: [...new Set(aggregate.sources.map((source) => source.campaignId).filter(Boolean))],
          source_ad_group_ids: [...new Set(aggregate.sources.map((source) => source.adGroupId).filter(Boolean))],
          last_evidence_date: aggregate.latestDate || today,
          cpc: Number(observedCpc.toFixed(4)),
          ctr: aggregate.impressions > 0 ? Number((aggregate.clicks / aggregate.impressions * 100).toFixed(4)) : 0,
          conversion_rate: Number(cvr.toFixed(4)),
          cvr: Number(cvr.toFixed(4)),
          acos: evaluation.sameSkuAcos == null ? 0 : Number(evaluation.sameSkuAcos.toFixed(4)),
          roas: Number(roas.toFixed(4)),
          bid_initial: safeBid || existingBank?.bid_initial || minBid,
          bid_current: existingBank?.bid_current || safeBid || minBid,
          performance_score: Math.min(100, Math.round(aggregate.sameSkuOrders * 30 + Math.min(30, roas * 3) + Math.min(20, aggregate.clicks))),
          classification,
          first_seen_at: existingBank?.first_seen_at || now,
          last_seen_at: aggregate.latestDate ? `${aggregate.latestDate}T23:59:59-03:00` : now,
          last_performance_update: now,
          updated_at: now,
        };

        if (!dryRun) {
          if (existingBank) {
            await base44.asServiceRole.entities.TermBank.update(existingBank.id, bankRecord).catch(() => null);
            bankUpdated++;
          } else {
            const created = await base44.asServiceRole.entities.TermBank.create({ ...bankRecord, created_at: now }).catch(() => null);
            if (created) {
              termBankByKey.set(key, created);
              bankCreated++;
            }
          }
          // A Manual Exact já confirmada não pode continuar exibida como
          // "No Bank"/Harvest Ready. Atualize somente o vínculo operacional;
          // métricas e histórico do termo permanecem intactos.
          if (existingExact) {
            const keywordBankRow = keywordBankByKey.get(key);
            if (keywordBankRow?.id) {
              await base44.asServiceRole.entities.KeywordBank.update(keywordBankRow.id, {
                lifecycle_status: 'HARVESTED',
                harvest_candidate: false,
                harvest_action: 'CREATE_EXACT',
                harvest_executed_at: now,
                last_decision: 'manual_exact_already_active_reconciled',
                last_decision_at: now,
                last_updated_at: now,
              }).catch(() => null);
            }
          }
        }

        if (evaluation.eligible) {
          const initialBudget = calculateWinnerExactBudget({ observedCpc, safeCpc, sameSkuOrders: aggregate.sameSkuOrders, marginAmount: numberValue(econ?.profit_after_ads ?? econ?.contribution_margin_amount, 0), accountMinimum: minimumCampaignBudget, accountMaximum: maximumCampaignBudget });
          candidates.push({ aggregate, key, product, econ, assessment, policy, safeBid, initialBudget, winnerScore: winnerScore(aggregate), evaluation, bank: existingBank });
        } else {
          rejected.push({ asin: aggregate.asin, term: aggregate.term, reason: evaluation.reason, same_sku_orders: aggregate.sameSkuOrders });
        }
      }

      candidates.sort((a, b) =>
        b.winnerScore - a.winnerScore ||
        b.aggregate.sameSkuOrders - a.aggregate.sameSkuOrders ||
        (a.evaluation.sameSkuAcos ?? 9999) - (b.evaluation.sameSkuAcos ?? 9999)
      );
      const selected = candidates.slice(0, maxPromotions);
      const promoted: any[] = [];
      const failed: any[] = [];

      if (!dryRun) {
        for (let offset = 0; offset < selected.length; offset += BATCH_SIZE) {
          const batch = selected.slice(offset, offset + BATCH_SIZE);
          const prepared: any[] = [];

          for (const candidate of batch) {
            const primarySource = candidate.aggregate.sources[0] || {};
            const idempotencyKey = `${aid}|${candidate.aggregate.asin}|${candidate.aggregate.normalizedTerm}|EXACT|same_sku_v1`;
            try {
              const promotion = await base44.asServiceRole.entities.SearchTermPromotion.create({
                amazon_account_id: aid,
                asin: candidate.aggregate.asin,
                sku: candidate.aggregate.sku || candidate.product?.sku || '',
                source_campaign_id: primarySource.campaignId || '',
                source_ad_group_id: primarySource.adGroupId || '',
                source_search_term: candidate.aggregate.term,
                normalized_search_term: candidate.aggregate.normalizedTerm,
                source_paths: candidate.aggregate.sources,
                orders: candidate.aggregate.totalOrders,
                sales: candidate.aggregate.totalSales,
                same_sku_orders: candidate.aggregate.sameSkuOrders,
                same_sku_sales: candidate.aggregate.sameSkuSales,
                halo_orders: candidate.aggregate.haloOrders,
                halo_sales: candidate.aggregate.haloSales,
                same_sku_attribution_verified: true,
                spend: candidate.aggregate.spend,
                clicks: candidate.aggregate.clicks,
                average_cpc: candidate.aggregate.clicks > 0 ? candidate.aggregate.spend / candidate.aggregate.clicks : 0,
                acos: candidate.evaluation.sameSkuAcos || 0,
                roas: candidate.aggregate.spend > 0 ? candidate.aggregate.sameSkuSales / candidate.aggregate.spend : 0,
                target_bid: candidate.safeBid,
                initial_budget: candidate.initialBudget,
                winner_score: candidate.winnerScore,
                amazon_confirmation_status: 'pending',
                destination_campaign_name: campaignName(candidate.aggregate.asin, candidate.aggregate.term),
                promotion_status: 'campaign_creating',
                completion_status: 'incomplete',
                idempotency_key: idempotencyKey,
                created_at: now,
                updated_at: now,
              });
              promotionByKey.set(candidate.key, promotion);
              prepared.push({ ...candidate, promotion });
            } catch (error: any) {
              failed.push({ asin: candidate.aggregate.asin, term: candidate.aggregate.term, stage: 'promotion_record', error: error?.message || String(error) });
            }
          }
          if (!prepared.length) continue;

          const campaignResponse = await ads(base44, aid, 'sameSkuHarvestCreateCampaigns', '/sp/campaigns', {
            campaigns: prepared.map((item) => ({
              name: campaignName(item.aggregate.asin, item.aggregate.term),
              targetingType: 'MANUAL',
              state: 'ENABLED',
              budget: { budgetType: 'DAILY', budget: item.initialBudget },
              startDate: today,
            })),
          }, 'application/vnd.spCampaign.v3+json').catch((error: any) => ({ ok: false, error: error?.message || String(error) }));

          const withCampaign: any[] = [];
          for (let index = 0; index < prepared.length; index++) {
            const item = prepared[index];
            const success = successAt(campaignResponse, 'campaigns', index);
            const campaignId = String(success?.campaignId || '');
            if (!campaignId) {
              const error = amazonFailure(campaignResponse, 'Amazon não retornou campaignId');
              await base44.asServiceRole.entities.SearchTermPromotion.update(item.promotion.id, { promotion_status: 'repair_required', last_error: error, updated_at: now }).catch(() => null);
              failed.push({ asin: item.aggregate.asin, term: item.aggregate.term, stage: 'campaign', error });
              continue;
            }
            await base44.asServiceRole.entities.SearchTermPromotion.update(item.promotion.id, {
              promotion_status: 'campaign_created', destination_campaign_id: campaignId, updated_at: now,
            }).catch(() => null);
            withCampaign.push({ ...item, campaignId });
          }
          if (!withCampaign.length) continue;
          await wait(1500);

          const adGroupResponse = await ads(base44, aid, 'sameSkuHarvestCreateAdGroups', '/sp/adGroups', {
            adGroups: withCampaign.map((item) => ({
              name: `AG | EXACT | ${item.aggregate.asin}`,
              campaignId: item.campaignId,
              defaultBid: item.safeBid,
              state: 'ENABLED',
            })),
          }, 'application/vnd.spAdGroup.v3+json').catch((error: any) => ({ ok: false, error: error?.message || String(error) }));

          const withAdGroup: any[] = [];
          for (let index = 0; index < withCampaign.length; index++) {
            const item = withCampaign[index];
            const success = successAt(adGroupResponse, 'adGroups', index);
            const adGroupId = String(success?.adGroupId || '');
            if (!adGroupId) {
              const error = amazonFailure(adGroupResponse, 'Amazon não retornou adGroupId');
              await base44.asServiceRole.entities.SearchTermPromotion.update(item.promotion.id, { promotion_status: 'repair_required', last_error: error, updated_at: now }).catch(() => null);
              failed.push({ asin: item.aggregate.asin, term: item.aggregate.term, stage: 'ad_group', error });
              continue;
            }
            await base44.asServiceRole.entities.SearchTermPromotion.update(item.promotion.id, {
              promotion_status: 'ad_group_created', destination_ad_group_id: adGroupId, updated_at: now,
            }).catch(() => null);
            withAdGroup.push({ ...item, adGroupId });
          }
          if (!withAdGroup.length) continue;
          await wait(1500);

          const productAdResponse = await ads(base44, aid, 'sameSkuHarvestCreateProductAds', '/sp/productAds', {
            productAds: withAdGroup.map((item) => ({
              campaignId: item.campaignId,
              adGroupId: item.adGroupId,
              ...(item.aggregate.sku || item.product?.sku ? { sku: item.aggregate.sku || item.product?.sku } : { asin: item.aggregate.asin }),
              state: 'ENABLED',
            })),
          }, 'application/vnd.spProductAd.v3+json').catch((error: any) => ({ ok: false, error: error?.message || String(error) }));

          const withProductAd: any[] = [];
          for (let index = 0; index < withAdGroup.length; index++) {
            const item = withAdGroup[index];
            const success = successAt(productAdResponse, 'productAds', index);
            const productAdId = String(success?.adId || success?.productAdId || '');
            if (!success && unwrap(productAdResponse)?.ok !== true) {
              const error = amazonFailure(productAdResponse, 'Amazon não confirmou Product Ad');
              await base44.asServiceRole.entities.SearchTermPromotion.update(item.promotion.id, { promotion_status: 'repair_required', last_error: error, updated_at: now }).catch(() => null);
              failed.push({ asin: item.aggregate.asin, term: item.aggregate.term, stage: 'product_ad', error });
              continue;
            }
            await base44.asServiceRole.entities.SearchTermPromotion.update(item.promotion.id, {
              promotion_status: 'product_ad_created', destination_ad_id: productAdId || null, updated_at: now,
            }).catch(() => null);
            withProductAd.push({ ...item, productAdId });
          }
          if (!withProductAd.length) continue;
          await wait(1500);

          const keywordResponse = await ads(base44, aid, 'sameSkuHarvestCreateExactKeywords', '/sp/keywords', {
            keywords: withProductAd.map((item) => ({
              campaignId: item.campaignId,
              adGroupId: item.adGroupId,
              keywordText: item.aggregate.term,
              matchType: 'EXACT',
              state: 'ENABLED',
              bid: item.safeBid,
            })),
          }, 'application/vnd.spKeyword.v3+json').catch((error: any) => ({ ok: false, error: error?.message || String(error) }));

          const withKeyword: any[] = [];
          for (let index = 0; index < withProductAd.length; index++) {
            const item = withProductAd[index];
            const success = successAt(keywordResponse, 'keywords', index);
            const keywordId = String(success?.keywordId || '');
            if (!keywordId) {
              const error = amazonFailure(keywordResponse, 'Amazon não retornou keywordId');
              await base44.asServiceRole.entities.SearchTermPromotion.update(item.promotion.id, { promotion_status: 'repair_required', last_error: error, updated_at: now }).catch(() => null);
              failed.push({ asin: item.aggregate.asin, term: item.aggregate.term, stage: 'keyword', error });
              continue;
            }
            await base44.asServiceRole.entities.SearchTermPromotion.update(item.promotion.id, {
              promotion_status: 'manual_active', destination_keyword_id: keywordId, updated_at: now,
            }).catch(() => null);
            withKeyword.push({ ...item, keywordId });
          }
          if (!withKeyword.length) continue;
          await wait(1500);

          const negatives: any[] = [];
          for (const item of withKeyword) {
            const distinct = new Set<string>();
            for (const source of item.aggregate.sources.filter(sourceNeedsNegative)) {
              const key = `${source.campaignId}|${source.adGroupId}|${item.aggregate.normalizedTerm}`;
              if (distinct.has(key)) continue;
              distinct.add(key);
              negatives.push({
                item,
                payload: {
                  campaignId: source.campaignId,
                  adGroupId: source.adGroupId,
                  keywordText: item.aggregate.term,
                  matchType: 'NEGATIVE_EXACT',
                  state: 'ENABLED',
                },
              });
            }
          }
          let negativeResponse: any = { ok: true };
          if (negatives.length) {
            negativeResponse = await ads(base44, aid, 'sameSkuHarvestCreateSourceNegatives', '/sp/negativeKeywords', {
              negativeKeywords: negatives.map((entry) => entry.payload),
            }, 'application/vnd.spNegativeKeyword.v3+json').catch((error: any) => ({ ok: false, error: error?.message || String(error) }));
          }

          for (const item of withKeyword) {
            const itemNegatives = negatives.map((entry, index) => ({ ...entry, index })).filter((entry) => entry.item.promotion.id === item.promotion.id);
            const negativeIds = itemNegatives.map((entry) => {
              const success = successAt(negativeResponse, 'negativeKeywords', entry.index);
              return String(success?.keywordId || success?.negativeKeywordId || '');
            }).filter(Boolean);
            const negativesComplete = itemNegatives.length === 0 || negativeIds.length === itemNegatives.length;

            await Promise.all([
              base44.asServiceRole.entities.Campaign.create({
                amazon_account_id: aid,
                campaign_id: item.campaignId,
                amazon_campaign_id: item.campaignId,
                asin: item.aggregate.asin,
                sku: item.aggregate.sku || item.product?.sku || null,
                name: campaignName(item.aggregate.asin, item.aggregate.term),
                campaign_name: campaignName(item.aggregate.asin, item.aggregate.term),
                campaign_type: 'SP',
                targeting_type: 'MANUAL',
                state: 'enabled',
                status: 'enabled',
                daily_budget: item.initialBudget,
                created_by_app: true,
                learning_eligible: true,
                launch_phase: 'new',
                completion_status: 'complete',
                is_incomplete: false,
                keyword_count: 1,
                ad_group_id: item.adGroupId,
                created_at: now,
                synced_at: now,
              }).catch(() => null),
              base44.asServiceRole.entities.Keyword.create({
                amazon_account_id: aid,
                campaign_id: item.campaignId,
                ad_group_id: item.adGroupId,
                keyword_id: item.keywordId,
                asin: item.aggregate.asin,
                keyword_text: item.aggregate.term,
                keyword: item.aggregate.term,
                match_type: 'exact',
                state: 'enabled',
                status: 'enabled',
                current_bid: item.safeBid,
                bid: item.safeBid,
                source: 'same_sku_search_term_harvest',
                first_seen_at: now,
                last_seen_at: now,
                synced_at: now,
              }).catch(() => null),
              item.productAdId ? base44.asServiceRole.entities.ProductAd.create({
                amazon_account_id: aid,
                product_ad_id: item.productAdId,
                campaign_id: item.campaignId,
                ad_group_id: item.adGroupId,
                asin: item.aggregate.asin,
                sku: item.aggregate.sku || item.product?.sku || '',
                state: 'enabled',
                status: 'enabled',
                synced_at: now,
              }).catch(() => null) : Promise.resolve(null),
            ]);

            for (const row of item.aggregate.sourceRows) {
              if (!row.id) continue;
              await base44.asServiceRole.entities.SearchTerm.update(row.id, {
                promoted_to_manual: true,
                promoted_at: now,
                manual_campaign_id: item.campaignId,
                manual_ad_group_id: item.adGroupId,
                manual_keyword_id: item.keywordId,
                manual_keyword_state: 'enabled',
                negated_in_source: negativesComplete && itemNegatives.length > 0,
                negated_at: negativesComplete && itemNegatives.length > 0 ? now : null,
                classification: 'PROMOTED_EXACT',
                decision_status: 'executed',
                last_action: 'same_sku_sale_promoted_to_manual_exact',
                last_action_at: now,
              }).catch(() => null);
            }

            const bankRow = termBankByKey.get(item.key);
            if (bankRow?.id) {
              await base44.asServiceRole.entities.TermBank.update(bankRow.id, {
                promotion_status: 'promoted_to_manual',
                classification: 'winner',
                campaign_id: item.campaignId,
                amazon_campaign_id: item.campaignId,
                keyword_id: item.keywordId,
                bid_initial: item.safeBid,
                bid_current: item.safeBid,
                updated_at: now,
              }).catch(() => null);
            }

            await base44.asServiceRole.entities.SearchTermPromotion.update(item.promotion.id, {
              promotion_status: negativesComplete ? 'confirming' : 'repair_required',
              amazon_confirmation_status: negativesComplete ? 'amazon_accepted' : 'pending',
              completion_status: negativesComplete ? 'amazon_accepted_awaiting_probe' : 'manual_active_negative_pending',
              destination_campaign_id: item.campaignId,
              destination_ad_group_id: item.adGroupId,
              destination_ad_id: item.productAdId || null,
              destination_keyword_id: item.keywordId,
              negative_keyword_id: negativeIds[0] || null,
              last_error: negativesComplete ? null : amazonFailure(negativeResponse, 'Negativa da origem pendente'),
              completed_at: null,
              updated_at: now,
            }).catch(() => null);

            await base44.asServiceRole.entities.OptimizationDecision.create({
              amazon_account_id: aid,
              decision_type: 'keyword_add',
              entity_type: 'keyword',
              entity_id: item.keywordId,
              campaign_id: item.campaignId,
              ad_group_id: item.adGroupId,
              keyword_id: item.keywordId,
              keyword_text: item.aggregate.term,
              asin: item.aggregate.asin,
              sku: item.aggregate.sku || item.product?.sku || '',
              action: 'promote_same_sku_search_term_to_manual_exact',
              rationale: `Ação: criar EXACT para “${item.aggregate.term}”. Causa: ${item.aggregate.sameSkuOrders} pedido(s) e R$ ${item.aggregate.sameSkuSales.toFixed(2)} de venda do mesmo SKU. Consequência: isolar lance lucrativo e negativar a origem somente após a keyword manual existir.`,
              rule_key: 'SAME_SKU_FIRST_SALE_IMMEDIATE_PROMOTION_V1',
              data_used: JSON.stringify({
                same_sku_orders: item.aggregate.sameSkuOrders,
                same_sku_sales: item.aggregate.sameSkuSales,
                halo_orders: item.aggregate.haloOrders,
                halo_sales: item.aggregate.haloSales,
                spend: item.aggregate.spend,
                same_sku_acos: item.evaluation.sameSkuAcos,
                safe_cpc: numberValue(item.assessment?.safe_max_cpc ?? item.econ?.safe_max_cpc, 0),
                winner_score: item.winnerScore,
                initial_budget: item.initialBudget,
                sources: item.aggregate.sources,
                negatives_complete: negativesComplete,
              }),
              metric_window: `${cutoff}|${today}`,
              data_scope_validated: true,
              data_scope_status: 'VALID',
              proposed_value: item.safeBid,
              same_sku_orders: item.aggregate.sameSkuOrders,
              same_sku_sales: item.aggregate.sameSkuSales,
              halo_orders: item.aggregate.haloOrders,
              halo_sales: item.aggregate.haloSales,
              attribution_confidence: 'verified_same_sku_report',
              current_cpc: item.aggregate.clicks > 0 ? item.aggregate.spend / item.aggregate.clicks : 0,
              safe_cpc: numberValue(item.assessment?.safe_max_cpc ?? item.econ?.safe_max_cpc, 0),
              target_acos: targetAcos,
              confidence: 95,
              risk: 'low',
              requires_approval: false,
              status: 'executed',
              execution_mode: 'EXECUTE_NOW',
              confirmation_required: true,
              confirmation_status: 'pending',
              idempotency_key: `${aid}|${item.aggregate.asin}|${item.aggregate.normalizedTerm}|same_sku_exact_v1`,
              source_function: 'runImmediateSameSkuSearchTermHarvest',
              evaluated_at: now,
              executed_at: now,
              evaluation_due_at: new Date(Date.now() + 14 * 86400000).toISOString(),
              next_review_days: 14,
              created_at: now,
            }).catch(() => null);

            exactKeys.add(item.key);
            promoted.push({
              asin: item.aggregate.asin,
              sku: item.aggregate.sku || item.product?.sku || '',
              term: item.aggregate.term,
              same_sku_orders: item.aggregate.sameSkuOrders,
              same_sku_sales: Number(item.aggregate.sameSkuSales.toFixed(2)),
              bid: item.safeBid,
              initial_budget: item.initialBudget,
              winner_score: item.winnerScore,
              campaign_id: item.campaignId,
              keyword_id: item.keywordId,
              source_negatives: negativeIds.length,
              consequence: negativesComplete ? 'manual_exact_active_source_negated' : 'manual_exact_active_negative_repair_pending',
            });
          }
          await wait(1500);
        }
      }

      const result = {
        amazon_account_id: aid,
        window: `${cutoff}|${today}`,
        search_term_rows: rowsInWindow.length,
        unique_asin_terms: aggregates.length,
        same_sku_candidates: candidates.length,
        selected: selected.length,
        promoted: promoted.length,
        failed: failed.length,
        bank_created: bankCreated,
        bank_updated: bankUpdated,
        rejected_count: rejected.length,
        promoted_terms: promoted,
        rejected_sample: rejected.slice(0, 50),
        failures: failed,
      };
      reports.push(result);

      if (!dryRun) {
        await base44.asServiceRole.entities.SyncExecutionLog.create({
          amazon_account_id: aid,
          operation: 'immediate_same_sku_search_term_harvest_v1',
          trigger_type: body.trigger_type || 'automatic',
          status: failed.length ? (promoted.length ? 'warning' : 'error') : 'success',
          execution_date: today,
          started_at: new Date(startedAt).toISOString(),
          completed_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
          records_processed: promoted.length,
          records_received: rowsInWindow.length,
          records_imported: bankCreated,
          result_summary: JSON.stringify(result).slice(0, 12000),
          error_message: failed.length ? failed.slice(0, 5).map((row) => `${row.asin}|${row.term}|${row.stage}: ${row.error}`).join('; ').slice(0, 1000) : null,
        }).catch(() => null);
      }
    }

    return Response.json({
      ok: reports.every((report) => report.failed === 0),
      dry_run: dryRun,
      policy: 'one_same_sku_sale_then_manual_exact_if_profitable_and_not_duplicate',
      lookback_days: lookbackDays,
      accounts_processed: reports.length,
      reports,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error), duration_ms: Date.now() - startedAt }, { status: 500 });
  }
});
