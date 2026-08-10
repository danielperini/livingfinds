/**
 * Fecha o ciclo do Search Term Report:
 * SearchTerm diÃ¡rio -> TermBank -> campanha MANUAL EXACT -> negativa na origem.
 *
 * Uma venda total/halo nunca Ã© tratada como venda do ASIN anunciado. A criaÃ§Ã£o
 * exige colunas promovidas/same-SKU, ASIN resolvido sem ambiguidade, estoque e
 * CPC econÃ´mico seguro. Todas as chaves sÃ£o ASIN + termo normalizado.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import {
  aggregateSearchTerms,
  calculateSafeHarvestBid,
  evaluateHarvestCandidate,
  normalizeSearchTerm,
  numberValue,
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
  const clean = term.replace(/[^a-z0-9\sÃ¡Ã©Ã­Ã³ÃºÃ¢ÃªÃ´Ã£ÃµÃ§-]/gi, '').trim().slice(0, 48);
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
      if (!authenticated) return Response.json({ ok: false, error: 'NÃ£o autorizado' }, { status: 401 });
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
      const [searchTerms, campaigns, products, economics, assessments, settingsRows, keywords, promotions, termBank] = await Promise.all([
        loadPaged(base44.asServiceRole.entities.SearchTerm, { amazon_account_id: aid }, '-date', 20000),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, '-updated_at', 3000).catch(() => []),
        base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, '-updated_at', 3000).catch(() => []),
        base44.asServiceRole.entities.DailyProductAdsAssessment.filter({ amazon_account_id: aid }, '-assessment_date', 5000).catch(() => []),
        base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1).catch(() => []),
        base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-updated_at', 10000).catch(() => []),
        base44.asServiceRole.entities.SearchTermPromotion.filter({ amazon_account_id: aid }, '-updated_at', 10000).catch(() => []),
        base44.asServiceRole.entities.TermBank.filter({ amazon_account_id: aid }, '-updated_at', 10000).catch(() => []),
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
      const budget = Math.max(5, Math.min(15, numberValue(settings.minimum_campaign_budget, 5)));

      const exactKeys = new Set<string>();
      for (const keyword of keywords) {
        if (String(keyword.state || keyword.status || '').toLowerCase() === 'archived') continue;
        if (String(keyword.match_type || '').toLowerCase() !== 'exact') continue;
        const campaign = campaignById.get(String(keyword.campaign_id || ''));
        const asin = String(keyword.asin || campaign?.asin || '').toUpperCase();
        const term = normalizeSearchTerm(keyword.keyword_text || keyword.keyword);
        if (asin && term) exactKeys.add(`${asin}|${term}`);
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
      // Registros legados SUMMARY podem sobrepor a janela DAILY. Quando jÃ¡ hÃ¡
      // linha com atribuiÃ§Ã£o same-SKU, a linha total-only Ã© excluÃ­da para nÃ£o
      // duplicar gasto/venda nem reduzir artificialmente a confianÃ§a.
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
        // Uma campanha MANUAL EXACT tambÃ©m descobre variaÃ§Ãµes reais. SÃ³ bloqueie
        // a promoÃ§Ã£o quando esta consulta jÃ¡ existir como EXACT para o ASIN;
        // a mera origem MANUAL EXACT nÃ£o transforma uma variaÃ§Ã£o em duplicata.
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
          promotion_status: existingBank?.promotion_status === 'promoted_to_manual'
            ? 'promoted_to_manual'
            : evaluation.eligible ? 'kickoff_candidate' : 'pending',
          confidence: aggregate.attributionVerified && aggregate.skuResolutionVerified ? 95 : 35,
          campaign_id: existingBank?.campaign_id || aggregate.sources[0]?.campaignId || '',
          amazon_campaign_id: existingBank?.amazon_campaign_id || aggregate.sources[0]?.campaignId || '',
          impressions: aggregate.impressions,
          clicks: aggregate.clicks,
          spend: Number(aggregate.spend.toFixed(4)),
          orders: aggregate.totalOrders,
          sales: Number(aggregate.totalSales.toFixed(4)),
          same_sku_orders: aggregate.sameSkuOrders,
          same_sku_sales: Number(aggregate.sameSkuSales.toFßmw¶‰žËkºwµçDôôÑÉÕ”¤ì4(€€€€€€€€€€€€€½¹ÍÐ•ÉÉ½È€ô…µ…é½¹…¥±ÕÉ”¡ÁÉ½‘ÕÑ‘I•ÍÁ½¹Í”°€µ…é½¸»¼½¹™¥Éµ½ÔAÉ½‘ÕÐœ¤ì4(€€€€€€€€€€€€€…Ý…¥Ð‰…Í”ÐÐ¹…ÍM•ÉÙ¥•I½±”¹•¹Ñ¥Ñ¥•Ì¹M•…É¡Q•ÉµAÉ½µ½Ñ¥½¸¹ÕÁ‘…Ñ”¡¥Ñ•´¹ÁÉ½µ½Ñ¥½¸¹¥°ìÁÉ½µ½Ñ¥½¹}ÍÑ…ÑÕÌè€É•Á…¥É}É•ÅÕ¥É•œ°±…ÍÑ}•ÉÉ½Èè•ÉÉ½È°ÕÁ‘…Ñ•‘}…Ðè¹½Üô¤¹…Ñ   ¤€ôø¹Õ±°¤ì4(€€€€€€€€€€€€€™…¥±•¹ÁÕÍ ¡ì…Í¥¸è¥Ñ•´¹…É•…Ñ”¹…Í¥¸°Ñ•É´è¥Ñ•´¹…É•…Ñ”¹Ñ•É´°ÍÑ…”è€ÁÉ½‘ÕÑ}…œ°•ÉÉ½Èô¤ì4(€€€€€€€€€€€€€½¹Ñ¥¹Õ”ì4(€€€€€€€€€€€ô4(€€€€€€€€€€€…Ý…¥Ð‰…Í”ÐÐ¹…ÍM•ÉÙ¥•I½±”¹•¹Ñ¥Ñ¥•Ì¹M•…É¡Q•ÉµAÉ½µ½Ñ¥½¸¹ÕÁ‘…Ñ”¡¥Ñ•´¹ÁÉ½µ½Ñ¥½¸¹¥°ì4(€€€€€€€€€€€€€ÁÉ½µ½Ñ¥½¹}ÍÑ…ÑÕÌè€ÁÉ½‘ÕÑ}…‘}É•…Ñ•œ°‘•ÍÑ¥¹…Ñ¥½¹}…‘}¥èÁÉ½‘ÕÑ‘%ñð¹Õ±°°ÕÁ‘…Ñ•‘}…Ðè¹½Ü°4(€€€€€€€€€€€ô¤¹…Ñ   ¤€ôø¹Õ±°¤ì4(€€€€€€€€€€€Ý¥Ñ¡AÉ½‘ÕÑ¹ÁÕÍ ¡ì€¸¸¹¥Ñ•´°ÁÉ½‘ÕÑ‘%ô¤ì4(€€€€€€€€€ô4(€€€€€€€€€¥˜€ …Ý¥Ñ¡AÉ½‘ÕÑ¹±•¹Ñ ¤½¹Ñ¥¹Õ”ì4(€€€€€€€€€…Ý…¥ÐÝ…¥Ð ÄÔÀÀ¤ì4(4(€€€€€€€€€½¹ÍÐ­•åÝ½É‘I•ÍÁ½¹Í”€ô…Ý…¥Ð…‘Ì¡‰…Í”ÐÐ°…¥°€Í…µ•M­Õ!…ÉÙ•ÍÑÉ•…Ñ•á…Ñ-•åÝ½É‘Ìœ°€œ½ÍÀ½­•åÝ½É‘Ìœ°ì4(€€€€€€€€€€€­•åÝ½É‘ÌèÝ¥Ñ¡AÉ½‘ÕÑ¹µ…À ¡¥Ñ•´¤€ôø€¡ì4(€€€€€€€€€€€€€…µÁ…¥¹%è¥Ñ•´¹…µÁ…¥¹%°4(€€€€€€€€€€€€€…‘É½ÕÁ%è¥Ñ•´¹…‘É½ÕÁ%°4(€€€€€€€€€€€€€­•åÝ½É‘Q•áÐè¥Ñ•´¹…É•…Ñ”¹Ñ•É´°4(€€€€€€€€€€€€€µ…Ñ¡QåÁ”è€aPœ°4(€€€€€€€€€€€€€ÍÑ…Ñ”è€9	1œ°4(€€€€€€€€€€€€€‰¥è¥Ñ•´¹Í…™•	¥°4(€€€€€€€€€€€ô¤¤°4(€€€€€€€€€ô°€…ÁÁ±¥…Ñ¥½¸½Ù¹¹ÍÁ-•åÝ½É¹ØÌ­©Í½¸œ¤¹…Ñ  ¡•ÉÉ½Èè…¹ä¤€ôø€¡ì½¬è™…±Í”°•ÉÉ½Èè•ÉÉ½Èü¹µ•ÍÍ…”ñðMÑÉ¥¹œ¡•ÉÉ½È¤ô¤¤ì4(4(€€€€€€€€€½¹ÍÐÝ¥Ñ¡-•åÝ½Éè…¹åmt€ômtì4(€€€€€€€€€™½È€¡±•Ð¥¹‘•à€ô€Àì¥¹‘•à€ðÝ¥Ñ¡AÉ½‘ÕÑ¹±•¹Ñ ì¥¹‘•à¬¬¤ì4(€€€€€€€€€€€½¹ÍÐ¥Ñ•´€ôÝ¥Ñ¡AÉ½‘ÕÑ‘m¥¹‘•átì4(€€€€€€€€€€€½¹ÍÐÍÕ•ÍÌ€ôÍÕ•ÍÍÐ¡­•åÝ½É‘I•ÍÁ½¹Í”°€­•åÝ½É‘Ìœ°¥¹‘•à¤ì4(€€€€€€€€€€€½¹ÍÐ­•åÝ½É‘%€ôMÑÉ¥¹œ¡ÍÕ•ÍÌü¹­•åÝ½É‘%ñð€œœ¤ì4(€€€€€€€€€€€¥˜€ …­•åÝ½É‘%¤ì4(€€€€€€€€€€€€€½¹ÍÐ•ÉÉ½È€ô…µ…é½¹…¥±ÕÉ”¡­•åÝ½É‘I•ÍÁ½¹Í”°€µ…é½¸»¼É•Ñ½É¹½Ô­•åÝ½É‘%œ¤ì4(€€€€€€€€€€€€€…Ý…¥Ð‰…Í”ÐÐ¹…ÍM•ÉÙ¥•I½±”¹•¹Ñ¥Ñ¥•Ì¹M•…É¡Q•ÉµAÉ½µ½Ñ¥½¸¹ÕÁ‘…Ñ”¡¥Ñ•´¹ÁÉ½µ½Ñ¥½¸¹¥°ìÁÉ½µ½Ñ¥½¹}ÍÑ…ÑÕÌè€É•Á…¥É}É•ÅÕ¥É•œ°±…ÍÑ}•ÉÉ½Èè•ÉÉ½È°ÕÁ‘…Ñ•‘}…Ðè¹½Üô¤¹…Ñ   ¤€ôø¹Õ±°¤ì4(€€€€€€€€€€€€€™…¥±•¹ÁÕÍ ¡ì…Í¥¸è¥Ñ•´¹…É•…Ñ”¹…Í¥¸°Ñ•É´è¥Ñ•´¹…É•…Ñ”¹Ñ•É´°ÍÑ…”è€­•åÝ½Éœ°•ÉÉ½Èô¤ì4(€€€€€€€€€€€€€½¹Ñ¥¹Õ”ì4(€€€€€€€€€€€ô4(€€€€€€€€€€€…Ý…¥Ð‰…Í”ÐÐ¹…ÍM•ÉÙ¥•I½±”¹•¹Ñ¥Ñ¥•Ì¹M•…É¡Q•ÉµAÉ½µ½Ñ¥½¸¹ÕÁ‘…Ñ”¡¥Ñ•´¹ÁÉ½µ½Ñ¥½¸¹¥°ì4(€€€€€€€€€€€€€ÁÉ½µ½Ñ¥½¹}ÍÑ…ÑÕÌè€µ…¹Õ…±}…Ñ¥Ù”œ°‘•ÍÑ¥¹…Ñ¥½¹}­•åÝ½É‘}¥è­•åÝ½É‘%°ÕÁ‘…Ñ•‘}…Ðè¹½Ü°4(€€€€€€€€€€€ô¤¹…Ñ   ¤€ôø¹Õ±°¤ì4(€€€€€€€€€€€Ý¥Ñ¡-•åÝ½É¹ÁÕÍ ¡ì€¸¸¹¥Ñ•´°­•åÝ½É‘%ô¤ì4(€€€€€€€€€ô4(€€€€€€€€€¥˜€ …Ý¥Ñ¡-•åÝ½É¹±•¹Ñ ¤½¹Ñ¥¹Õ”ì4(€€€€€€€€€…Ý…¥ÐÝ…¥Ð ÄÔÀÀ¤ì4(4(€€€€€€€€€½¹ÍÐ¹•…Ñ¥Ù•Ìè…¹åmt€ômtì4(€€€€€€€€€™½È€¡½¹ÍÐ¥Ñ•´½˜Ý¥Ñ¡-•åÝ½É¤ì4(€€€€€€€€€€€½¹ÍÐ‘¥ÍÑ¥¹Ð€ô¹•ÜM•ÐñÍÑÉ¥¹œø ¤ì4(€€€€€€€€€€€™½È€¡½¹ÍÐÍ½ÕÉ”½˜¥Ñ•´¹…É•…Ñ”¹Í½ÕÉ•Ì¹™¥±Ñ•È¡Í½ÕÉ•9••‘Í9•…Ñ¥Ù”¤¤ì4(€€€€€€€€€€€€€½¹ÍÐ­•ä€ô€‘íÍ½ÕÉ”¹…µÁ…¥¹%‘õð‘íÍ½ÕÉ”¹…‘É½ÕÁ%‘õð‘í¥Ñ•´¹…É•…Ñ”¹¹½Éµ…±¥é•‘Q•Éµõ€ì4(€€€€€€€€€€€€€¥˜€¡‘¥ÍÑ¥¹Ð¹¡…Ì¡­•ä¤¤½¹Ñ¥¹Õ”ì4(€€€€€€€€€€€€€‘¥ÍÑ¥¹Ð¹…‘¡­•ä¤ì4(€€€€€€€€€€€€€¹•…Ñ¥Ù•Ì¹ÁÕÍ ¡ì4(€€€€€€€€€€€€€€€¥Ñ•´°4(€€€€€€€€€€€€€€€Á…å±½…èì4(€€€€€€€€€€€€€€€€€…µÁ…¥¹%èÍ½ÕÉ”¹…µÁ…¥¹%°4(€€€€€€€€€€€€€€€€€…‘É½ÕÁ%èÍ½ÕÉ”¹…‘É½ÕÁ%°4(€€€€€€€€€€€€€€€€€­•åÝ½É‘Q•áÐè¥Ñ•´¹…É•…Ñ”¹Ñ•É´°4(€€€€€€€€€€€€€€€€€µ…Ñ¡QåÁ”è€9Q%Y}aPœ°4(€€€€€€€€€€€€€€€€€ÍÑ…Ñ”è€9	1œ°4(€€€€€€€€€€€€€€€ô°4(€€€€€€€€€€€€€ô¤ì4(€€€€€€€€€€€ô4(€€€€€€€€€ô4(€€€€€€€€€±•Ð¹•…Ñ¥Ù•I•ÍÁ½¹Í”è…¹ä€ôì½¬èÑÉÕ”ôì4(€€€€€€€€€¥˜€¡¹•…Ñ¥Ù•Ì¹±•¹Ñ ¤ì4(€€€€€€€€€€€¹•…Ñ¥Ù•I•ÍÁ½¹Í”€ô…Ý…¥Ð…‘Ì¡‰…Í”ÐÐ°…¥°€Í…µ•M­Õ!…ÉÙ•ÍÑÉ•…Ñ•M½ÕÉ•9•…Ñ¥Ù•Ìœ°€œ½ÍÀ½¹•…Ñ¥Ù•-•åÝ½É‘Ìœ°ì4(€€€€€€€€€€€€€¹•…Ñ¥Ù•-•åÝ½É‘Ìè¹•…Ñ¥Ù•Ì¹µ…À ¡•¹ÑÉä¤€ôø•¹ÑÉä¹Á…å±½…¤°4(€€€€€€€€€€€ô°€…ÁÁ±¥…Ñ¥½¸½Ù¹¹ÍÁ9•…Ñ¥Ù•-•åÝ½É¹ØÌ­©Í½¸œ¤¹…Ñ  ¡•ÉÉ½Èè…¹ä¤€ôø€¡ì½¬è™…±Í”°•ÉÉ½Èè•ÉÉ½Èü¹µ•ÍÍ…”ñðMÑÉ¥¹œ¡•ÉÉ½È¤ô¤¤ì4(€€€€€€€€€ô4(4(€€€€€€€€€™½È€¡½¹ÍÐ¥Ñ•´½˜Ý¥Ñ¡-•åÝ½É¤ì4(€€€€€€€€€€€½¹ÍÐ¥Ñ•µ9•…Ñ¥Ù•Ì€ô¹•…Ñ¥Ù•Ì¹µ…À ¡•¹ÑÉä°¥¹‘•à¤€ôø€¡ì€¸¸¹•¹ÑÉä°¥¹‘•àô¤¤¹™¥±Ñ•È ¡•¹ÑÉä¤€ôø•¹ÑÉä¹¥Ñ•´¹ÁÉ½µ½Ñ¥½¸¹¥€ôôô¥Ñ•´¹ÁÉ½µ½Ñ¥½¸¹¥¤ì4(€€€€€€€€€€€½¹ÍÐ¹•…Ñ¥Ù•%‘Ì€ô¥Ñ•µ9•…Ñ¥Ù•Ì¹µ…À ¡•¹ÑÉä¤€ôøì4(€€€€€€€€€€€€€½¹ÍÐÍÕ•ÍÌ€ôÍÕ•ÍÍÐ¡¹•…Ñ¥Ù•I•ÍÁ½¹Í”°€¹•…Ñ¥Ù•-•åÝ½É‘Ìœ°•¹ÑÉä¹¥¹‘•à¤ì4(€€€€€€€€€€€€€É•ÑÕÉ¸MÑÉ¥¹œ¡ÍÕ•ÍÌü¹­•åÝ½É‘%ñðÍÕ•ÍÌü¹¹•…Ñ¥Ù•-•åÝ½É‘%ñð€œœ¤ì4(€€€€€€€€€€€ô¤¹™¥±Ñ•È¡	½½±•…¸¤ì4(€€€€€€€€€€€½¹ÍÐ¹•…Ñ¥Ù•Í½µÁ±•Ñ”€ô¥Ñ•µ9•…Ñ¥Ù•Ì¹±•¹Ñ €ôôô€Àñð¹•…Ñ¥Ù•%‘Ì¹±•¹Ñ €ôôô¥Ñ•µ9•…Ñ¥Ù•Ì¹±•¹Ñ ì4(4(€€€€€€€€€€€…Ý…¥ÐAÉ½µ¥Í”¹…±°¡l4(€€€€€€€€€€€€€‰…Í”ÐÐ¹…ÍM•ÉÙ¥•I½±”¹•¹Ñ¥Ñ¥•Ì¹…µÁ…¥¸¹É•…Ñ”¡ì4(€€€€€€€€€€€€€€€…µ…é½¹}…½Õ¹Ñ}¥è…¥°4(€€€€€€€€€€€€€€€…µÁ…¥¹}¥è¥Ñ•´¹…µÁ…¥¹%°4(€€€€€€€€€€€€€€€…µ…é½¹}…µÁ…¥¹}¥è¥Ñ•´¹…µÁ…¥¹%°4(€€€€€€€€€€€€€€€…Í¥¸è¥Ñ•´¹…É•…Ñ”¹…Í¥¸°4(€€€€€€€€€€€€€€€Í­Ôè¥Ñ•´¹…É•…Ñ”¹Í­Ôñð¥Ñ•´¹ÁÉ½‘ÕÐü¹Í­Ôñð¹Õ±°°4(€€€€€€€€€€€€€€€¹…µ”è…µÁ…¥¹9…µ”¡¥Ñ•´¹…É•…Ñ”¹…Í¥¸°¥Ñ•´¹…É•…Ñ”¹Ñ•É´¤°4(€€€€€€€€€€€€€€€…µÁ…¥¹}¹…µ”è…µÁ…¥¹9…µ”¡¥Ñ•´¹…É•…Ñ”¹…Í¥¸°¥Ñ•´¹…É•…Ñ”¹Ñ•É´¤°4(€€€€€€€€€€€€€€€…µÁ…¥¹}ÑåÁ”è€M@œ°4(€€€€€€€€€€€€€€€Ñ…É•Ñ¥¹}ÑåÁ”è€59U0œ°4(€€€€€€€€€€€€€€€ÍÑ…Ñ”è€•¹…‰±•œ°4(€€€€€€€€€€€€€€€ÍÑ…ÑÕÌè€•¹…‰±•œ°4(€€€€€€€€€€€€€€€‘…¥±å}‰Õ‘•Ðè‰Õ‘•Ð°4(€€€€€€€€€€€€€€€É•…Ñ•‘}‰å}…ÁÀèÑÉÕ”°4(€€€€€€€€€€€€€€€±•…É¹¥¹}•±¥¥‰±”èÑÉÕ”°4(€€€€€€€€€€€€€€€±…Õ¹¡}Á¡…Í”è€¹•Üœ°4(€€€€€€€€€€€€€€€½µÁ±•Ñ¥½¹}ÍÑ…ÑÕÌè€½µÁ±•Ñ”œ°4(€€€€€€€€€€€€€€€¥Í}¥¹½µÁ±•Ñ”è™…±Í”°4(€€€€€€€€€€€€€€€­•åÝ½É‘}½Õ¹Ðè€Ä°4(€€€€€€€€€€€€€€€…‘}É½ÕÁ}¥è¥Ñ•´¹…‘É½ÕÁ%°4(€€€€€€€€€€€€€€€É•…Ñ•‘}…Ðè¹½Ü°4(€€€€€€€€€€€€€€€Íå¹•‘}…Ðè¹½Ü°4(€€€€€€€€€€€€€ô¤¹…Ñ   ¤€ôø¹Õ±°¤°4(€€€€€€€€€€€€€‰…Í”ÐÐ¹…ÍM•ÉÙ¥•I½±”¹•¹Ñ¥Ñ¥•Ì¹-•åÝ½É¹É•…Ñ”¡ì4(€€€€€€€€€€€€€€€…µ…é½¹}…½Õ¹Ñ}¥è…¥°4(€€€€€€€€€€€€€€€…µÁ…¥¹}¥è¥Ñ•´¹…µÁ…¥¹%°4(€€€€€€€€€€€€€€€…‘}É½ÕÁ}¥è¥Ñ•´¹…‘É½ÕÁ%°4(€€€€€€€€€€€€€€€­•åÝ½É‘}¥è¥Ñ•´¹­•åÝ½É‘%°4(€€€€€€€€€€€€€€€…Í¥¸è¥Ñ•´¹…É•…Ñ”¹…Í¥¸°4(€€€€€€€€€€€€€€€­•åÝ½É‘}Ñ•áÐè¥Ñ•´¹…É•…Ñ”¹Ñ•É´°4(€€€€€€€€€€€€€€€­•åÝ½Éè¥Ñ•´¹…É•…Ñ”¹Ñ•É´°4(€€€€€€€€€€€€€€€µ…Ñ¡}ÑåÁ”è€•á…Ðœ°4(€€€€€€€€€€€€€€€ÍÑ…Ñ”è€•¹…‰±•œ°4(€€€€€€€€€€€€€€€ÍÑ…ÑÕÌè€•¹…‰±•œ°4(€€€€€€€€€€€€€€€ÕÉÉ•¹Ñ}‰¥è¥Ñ•´¹Í…™•	¥°4(€€€€€€€€€€€€€€€‰¥è¥Ñ•´¹Í…™•	¥°4(€€€€€€€€€€€€€€€Í½ÕÉ”è€Í…µ•}Í­Õ}Í•…É¡}Ñ•Éµ}¡…ÉÙ•ÍÐœ°4(€€€€€€€€€€€€€€€™¥ÉÍÑ}Í••¹}…Ðè¹½Ü°4(€€€€€€€€€€€€€€€±…ÍÑ}Í••¹}…Ðè¹½Ü°4(€€€€€€€€€€€€€€€Íå¹•‘}…Ðè¹½Ü°4(€€€€€€€€€€€€€ô¤¹…Ñ   ¤€ôø¹Õ±°¤°4(€€€€€€€€€€€€€¥Ñ•´¹ÁÉ½‘ÕÑ‘%€ü‰…Í”ÐÐ¹…ÍM•ÉÙ¥•I½±”¹•¹Ñ¥Ñ¥•Ì¹AÉ½‘ÕÑ¹É•…Ñ”¡ì4(€€€€€€€€€€€€€€€…µ…é½¹}…½Õ¹Ñ}¥è…¥°4(€€€€€€€€€€€€€€€ÁÉ½‘ÕÑ}…‘}¥è¥Ñ•´¹ÁÉ½‘ÕÑ‘%°4(€€€€€€€€€€€€€€€…µÁ…¥¹}¥è¥Ñ•´¹…µÁ…¥¹%°4(€€€€€€€€€€€€€€€…‘}É½ÕÁ}¥è¥Ñ•´¹…‘É½ÕÁ%°4(€€€€€€€€€€€€€€€…Í¥¸è¥Ñ•´¹…É•…Ñ”¹…Í¥¸°4(€€€€€€€€€€€€€€€Í­Ôè¥Ñ•´¹…É•…Ñ”¹Í­Ôñð¥Ñ•´¹ÁÉ½‘ÕÐü¹Í­Ôñð€œœ°4(€€€€€€€€€€€€€€€ÍÑ…Ñ”è€•¹…‰±•œ°4(€€€€€€€€€€€€€€€ÍÑ…ÑÕÌè€•¹…‰±•œ°4(€€€€€€€€€€€€€€€Íå¹•‘}…Ðè¹½Ü°4(€€€€€€€€€€€€€ô¤¹…Ñ   ¤€ôø¹Õ±°¤€èAÉ½µ¥Í”¹É•Í½±Ù”¡¹Õ±°¤°4(€€€€€€€€€€€t¤ì4(4(€€€€€€€€€€€™½È€¡½¹ÍÐÉ½Ü½˜¥Ñ•´¹…É•…Ñ”¹Í½ÕÉ•I½ÝÌ¤ì4(€€€€€€€€€€€€€¥˜€ …É½Ü¹¥¤½¹Ñ¥¹Õ”ì4(€€€€€€€€€€€€€…Ý…¥Ð‰…Í”ÐÐ¹…ÍM•ÉÙ¥•I½±”¹•¹Ñ¥Ñ¥•Ì¹M•…É¡Q•É´¹ÕÁ‘…Ñ”¡É½Ü¹¥°ì4(€€€€€€€€€€€€€€€ÁÉ½µ½Ñ•‘}Ñ½}µ…¹Õ…°èÑÉÕ”°4(€€€€€€€€€€€€€€€ÁÉ½µ½Ñ•‘}…Ðè¹½Ü°4(€€€€€€€€€€€€€€€µ…¹Õ…±}…µÁ…¥¹}¥è¥Ñ•´¹…µÁ…¥¹%°4(€€€€€€€€€€€€€€€µ…¹Õ…±}…‘}É½ÕÁ}¥è¥Ñ•´¹…‘É½ÕÁ%°4(€€€€€€€€€€€€€€€µ…¹Õ…±}­•åÝ½É‘}¥è¥Ñ•´¹­•åÝ½É‘%°4(€€€€€€€€€€€€€€€µ…¹Õ…±}­•åÝ½É‘}ÍÑ…Ñ”è€•¹…‰±•œ°4(€€€€€€€€€€€€€€€¹•…Ñ•‘}¥¹}Í½ÕÉ”è¹•…Ñ¥Ù•Í½µÁ±•Ñ”€˜˜¥Ñ•µ9•…Ñ¥Ù•Ì¹±•¹Ñ €ø€À°4(€€€€€€€€€€€€€€€¹•…Ñ•‘}…Ðè¹•…Ñ¥Ù•Í½µÁ±•Ñ”€˜˜¥Ñ•µ9•…Ñ¥Ù•Ì¹±•¹Ñ €ø€À€ü¹½Ü€è¹Õ±°°4(€€€€€€€€€€€€€€€±…ÍÍ¥™¥…Ñ¥½¸è€AI=5=Q}aPœ°4(€€€€€€€€€€€€€€€‘•¥Í¥½¹}ÍÑ…ÑÕÌè€•á•ÕÑ•œ°4(€€€€€€€€€€€€€€€±…ÍÑ}…Ñ¥½¸è€Í…µ•}Í­Õ}Í…±•}ÁÉ½µ½Ñ•‘}Ñ½}µ…¹Õ…±}•á…Ðœ°4(€€€€€€€€€€€€€€€±…ÍÑ}…Ñ¥½¹}…Ðè¹½Ü°4(€€€€€€€€€€€€€ô¤¹…Ñ   ¤€ôø¹Õ±°¤ì4(€€€€€€€€€€€ô4(4(€€€€€€€€€€€½¹ÍÐ‰…¹­I½Ü€ôÑ•Éµ	…¹­	å-•ä¹•Ð¡¥Ñ•´¹­•ä¤ì4(€€€€€€€€€€€¥˜€¡‰…¹­I½Üü¹¥¤ì4(€€€€€€€€€€€€€…Ý…¥Ð‰…Í”ÐÐ¹…ÍM•ÉÙ¥•I½±”¹•¹Ñ¥Ñ¥•Ì¹Q•Éµ	…¹¬¹ÕÁ‘…Ñ”¡‰…¹­I½Ü¹¥°ì4(€€€€€€€€€€€€€€€ÁÉ½µ½Ñ¥½¹}ÍÑ…ÑÕÌè€ÁÉ½µ½Ñ•‘}Ñ½}µ…¹Õ…°œ°4(€€€€€€€€€€€€€€€±…ÍÍ¥™¥…Ñ¥½¸è€Ý¥¹¹•Èœ°4(€€€€€€€€€€€€€€€…µÁ…¥¹}¥è¥Ñ•´¹…µÁ…¥¹%°4(€€€€€€€€€€€€€€€…µ…é½¹}…µÁ…¥¹}¥è¥Ñ•´¹…µÁ…¥¹%°4(€€€€€€€€€€€€€€€­•åÝ½É‘}¥è¥Ñ•´¹­•åÝ½É‘%°4(€€€€€€€€€€€€€€€‰¥‘}¥¹¥Ñ¥…°è¥Ñ•´¹Í…™•	¥°4(€€€€€€€€€€€€€€€‰¥‘}ÕÉÉ•¹Ðè¥Ñ•´¹Í…™•	¥°4(€€€€€€€€€€€€€€€ÕÁ‘…Ñ•‘}…Ðè¹½Ü°4(€€€€€€€€€€€€€ô¤¹…Ñ   ¤€ôø¹Õ±°¤ì4(€€€€€€€€€€€ô4(4(€€€€€€€€€€€…Ý…¥Ð‰…Í”ÐÐ¹…ÍM•ÉÙ¥•I½±”¹•¹Ñ¥Ñ¥•Ì¹M•…É¡Q•ÉµAÉ½µ½Ñ¥½¸¹ÕÁ‘…Ñ”¡¥Ñ•´¹ÁÉ½µ½Ñ¥½¸¹¥°ì4(€€€€€€€€€€€€€ÁÉ½µ½Ñ¥½¹}ÍÑ…ÑÕÌè¹•…Ñ¥Ù•Í½µÁ±•Ñ”€ü€½µÁ±•Ñ•œ€è€É•Á…¥É}É•ÅÕ¥É•œ°4(€€€€€€€€€€€€€½µÁ±•Ñ¥½¹}ÍÑ…ÑÕÌè¹•…Ñ¥Ù•Í½µÁ±•Ñ”€ü€½µÁ±•Ñ”œ€è€µ…¹Õ…±}…Ñ¥Ù•}¹•…Ñ¥Ù•}Á•¹‘¥¹œœ°4(€€€€€€€€€€€€€‘•ÍÑ¥¹…Ñ¥½¹}…µÁ…¥¹}¥è¥Ñ•´¹…µÁ…¥¹%°4(€€€€€€€€€€€€€‘•ÍÑ¥¹…Ñ¥½¹}…‘}É½ÕÁ}¥è¥Ñ•´¹…‘É½ÕÁ%°4(€€€€€€€€€€€€€‘•ÍÑ¥¹…Ñ¥½¹}…‘}¥è¥Ñ•´¹ÁÉ½‘ÕÑ‘%ñð¹Õ±°°4(€€€€€€€€€€€€€‘•ÍÑ¥¹…Ñ¥½¹}­•åÝ½É‘}¥è¥Ñ•´¹­•åÝ½É‘%°4(€€€€€€€€€€€€€¹•…Ñ¥Ù•}­•åÝ½É‘}¥è¹•…Ñ¥Ù•%‘ÍlÁtñð¹Õ±°°4(€€€€€€€€€€€€€±…ÍÑ}•ÉÉ½Èè¹•…Ñ¥Ù•Í½µÁ±•Ñ”€ü¹Õ±°€è…µ…é½¹…¥±ÕÉ”¡¹•…Ñ¥Ù•I•ÍÁ½¹Í”°€9•…Ñ¥Ù„‘„½É¥•´Á•¹‘•¹Ñ”œ¤°4(€€€€€€€€€€€€€½µÁ±•Ñ•‘}…Ðè¹•…Ñ¥Ù•Í½µÁ±•Ñ”€ü¹½Ü€è¹Õ±°°4(€€€€€€€€€€€€€ÕÁ‘…Ñ•‘}…Ðè¹½Ü°4(€€€€€€€€€€€ô¤¹…Ñ   ¤€ôø¹Õ±°¤ì4(4(€€€€€€€€€€€…Ý…¥Ð‰…Í”ÐÐ¹…ÍM•ÉÙ¥•I½±”¹•¹Ñ¥Ñ¥•Ì¹=ÁÑ¥µ¥é…Ñ¥½¹•¥Í¥½¸¹É•…Ñ”¡ì4(€€€€€€€€€€€€€…µ…é½¹}…½Õ¹Ñ}¥è…¥°4(€€€€€€€€€€€€€‘•¥Í¥½¹}ÑåÁ”è€­•åÝ½É‘}…‘œ°4(€€€€€€€€€€€€€•¹Ñ¥Ñå}ÑåÁ”è€­•åÝ½Éœ°4(€€€€€€€€€€€€€•¹Ñ¥Ñå}¥è¥Ñ•´¹­•åÝ½É‘%°4(€€€€€€€€€€€€€…µÁ…¥¹}¥è¥Ñ•´¹…µÁ…¥¹%°4(€€€€€€€€€€€€€…‘}É½ÕÁ}¥è¥Ñ•´¹…‘É½ÕÁ%°4(€€€€€€€€€€€€€­•åÝ½É‘}¥è¥Ñ•´¹­•åÝ½É‘%°4(€€€€€€€€€€€€€­•åÝ½É‘}Ñ•áÐè¥Ñ•´¹…É•…Ñ”¹Ñ•É´°4(€€€€€€€€€€€€€…Í¥¸è¥Ñ•´¹…É•…Ñ”¹…Í¥¸°4(€€€€€€€€€€€€€Í­Ôè¥Ñ•´¹…É•…Ñ”¹Í­Ôñð¥Ñ•´¹ÁÉ½‘ÕÐü¹Í­Ôñð€œœ°4(€€€€€€€€€€€€€…Ñ¥½¸è€ÁÉ½µ½Ñ•}Í…µ•}Í­Õ}Í•…É¡}Ñ•Éµ}Ñ½}µ…¹Õ…±}•á…Ðœ°4(€€€€€€€€€€€€€É…Ñ¥½¹…±”èŸ¼èÉ¥…ÈaPÁ…É„ƒŠp‘í¥Ñ•´¹…É•…Ñ”¹Ñ•Éµ÷Št¸…ÕÍ„è€‘í¥Ñ•´¹…É•…Ñ”¹Í…µ•M­Õ=É‘•ÉÍôÁ•‘¥‘¼¡Ì¤”H€‘í¥Ñ•´¹…É•…Ñ”¹Í…µ•M­ÕM…±•Ì¹Ñ½¥á• È¥ô‘”Ù•¹‘„‘¼µ•Íµ¼M-T¸½¹Í•Å×©¹¥„è¥Í½±…È±…¹”±ÕÉ…Ñ¥Ù¼”¹•…Ñ¥Ù…È„½É¥•´Í½µ•¹Ñ”…ÃÍÌ„­•åÝ½Éµ…¹Õ…°•á¥ÍÑ¥È¹€°4(€€€€€€€€€€€€€ÉÕ±•}­•äè€M5}M-U}%IMQ}M1}%55%Q}AI=5=Q%=9}XÄœ°4(€€€€€€€€€€€€€‘…Ñ…}ÕÍ•è)M=8¹ÍÑÉ¥¹¥™ä¡ì4(€€€€€€€€€€€€€€€Í…µ•}Í­Õ}½É‘•ÉÌè¥Ñ•´¹…É•…Ñ”¹Í…µ•M­Õ=É‘•ÉÌ°4(€€€€€€€€€€€€€€€Í…µ•}Í­Õ}Í…±•Ìè¥Ñ•´¹…É•…Ñ”¹Í…µ•M­ÕM…±•Ì°4(€€€€€€€€€€€€€€€¡…±½}½É‘•ÉÌè¥Ñ•´¹…É•…Ñ”¹¡…±½=É‘•ÉÌ°4(€€€€€€€€€€€€€€€¡…±½}Í…±•Ìè¥Ñ•´¹…É•…Ñ”¹¡…±½M…±•Ì°4(€€€€€€€€€€€€€€€ÍÁ•¹è¥Ñ•´¹…É•…Ñ”¹ÍÁ•¹°4(€€€€€€€€€€€€€€€Í…µ•}Í­Õ}…½Ìè¥Ñ•´¹•Ù…±Õ…Ñ¥½¸¹Í…µ•M­Õ½Ì°4(€€€€€€€€€€€€€€€Í…™•}ÁŒè¹Õµ‰•ÉY…±Õ”¡¥Ñ•´¹…ÍÍ•ÍÍµ•¹Ðü¹Í…™•}µ…á}ÁŒ€üü¥Ñ•´¹•½¸ü¹Í…™•}µ…á}ÁŒ°€À¤°4(€€€€€€€€€€€€€€€Í½ÕÉ•Ìè¥Ñ•´¹…É•…Ñ”¹Í½ÕÉ•Ì°4(€€€€€€€€€€€€€€€¹•…Ñ¥Ù•Í}½µÁ±•Ñ”è¹•…Ñ¥Ù•Í½µÁ±•Ñ”°4(€€€€€€€€€€€€€ô¤°4(€€€€€€€€€€€€€µ•ÑÉ¥}Ý¥¹‘½Üè€‘íÕÑ½™™õð‘íÑ½‘…åõ€°4(€€€€€€€€€€€€€‘…Ñ…}Í½Á•}Ù…±¥‘…Ñ•èÑÉÕ”°4(€€€€€€€€€€€€€‘…Ñ…}Í½Á•}ÍÑ…ÑÕÌè€Y1%œ°4(€€€€€€€€€€€€€ÁÉ½Á½Í•‘}Ù…±Õ”è¥Ñ•´¹Í…™•	¥°4(€€€€€€€€€€€€€Í…µ•}Í­Õ}½É‘•ÉÌè¥Ñ•´¹…É•…Ñ”¹Í…µ•M­Õ=É‘•ÉÌ°4(€€€€€€€€€€€€€Í…µ•}Í­Õ}Í…±•Ìè¥Ñ•´¹…É•…Ñ”¹Í…µ•M­ÕM…±•Ì°4(€€€€€€€€€€€€€¡…±½}½É‘•ÉÌè¥Ñ•´¹…É•…Ñ”¹¡…±½=É‘•ÉÌ°4(€€€€€€€€€€€€€¡…±½}Í…±•Ìè¥Ñ•´¹…É•…Ñ”¹¡…±½M…±•Ì°4(€€€€€€€€€€€€€…ÑÑÉ¥‰ÕÑ¥½¹}½¹™¥‘•¹”è€Ù•É¥™¥•‘}Í…µ•}Í­Õ}É•Á½ÉÐœ°4(€€€€€€€€€€€€€ÕÉÉ•¹Ñ}ÁŒè¥Ñ•´¹…É•…Ñ”¹±¥­Ì€ø€À€ü¥Ñ•´¹…É•…Ñ”¹ÍÁ•¹€¼¥Ñ•´¹…É•…Ñ”¹±¥­Ì€è€À°4(€€€€€€€€€€€€€Í…™•}ÁŒè¹Õµ‰•ÉY…±Õ”¡¥Ñ•´¹…ÍÍ•ÍÍµ•¹Ðü¹Í…™•}µ…á}ÁŒ€üü¥Ñ•´¹•½¸ü¹Í…™•}µ…á}ÁŒ°€À¤°4(€€€€€€€€€€€€€Ñ…É•Ñ}…½ÌèÑ…É•Ñ½Ì°4(€€€€€€€€€€€€€½¹™¥‘•¹”è€äÔ°4(€€€€€€€€€€€€€É¥Í¬è€±½Üœ°4(€€€€€€€€€€€€€É•ÅÕ¥É•Í}…ÁÁÉ½Ù…°è™…±Í”°4(€€€€€€€€€€€€€ÍÑ…ÑÕÌè€•á•ÕÑ•œ°4(€€€€€€€€€€€€€•á•ÕÑ¥½¹}µ½‘”è€aUQ}9=\œ°4(€€€€€€€€€€€€€½¹™¥Éµ…Ñ¥½¹}É•ÅÕ¥É•èÑÉÕ”°4(€€€€€€€€€€€€€½¹™¥Éµ…Ñ¥½¹}ÍÑ…ÑÕÌè€Á•¹‘¥¹œœ°4(€€€€€€€€€€€€€¥‘•µÁ½Ñ•¹å}­•äè€‘í…¥‘õð‘í¥Ñ•´¹…É•…Ñ”¹…Í¥¹õð‘í¥Ñ•´¹…É•…Ñ”¹¹½Éµ…±¥é•‘Q•ÉµõñÍ…µ•}Í­Õ}•á…Ñ}ØÅ€°4(€€€€€€€€€€€€€Í½ÕÉ•}™Õ¹Ñ¥½¸è€ÉÕ¹%µµ•‘¥…Ñ•M…µ•M­ÕM•…É¡Q•Éµ!…ÉÙ•ÍÐœ°4(€€€€€€€€€€€€€•Ù…±Õ…Ñ•‘}…Ðè¹½Ü°4(€€€€€€€€€€€€€•á•ÕÑ•‘}…Ðè¹½Ü°4(€€€€€€€€€€€€€•Ù…±Õ…Ñ¥½¹}‘Õ•}…Ðè¹•Ü…Ñ”¡…Ñ”¹¹½Ü ¤€¬€ÄÐ€¨€àØÐÀÀÀÀÀ¤¹Ñ½%M=MÑÉ¥¹œ ¤°4(€€€€€€€€€€€€€¹•áÑ}É•Ù¥•Ý}‘…åÌè€ÄÐ°4(€€€€€€€€€€€€€É•…Ñ•‘}…Ðè¹½Ü°4(€€€€€€€€€€€ô¤¹…Ñ   ¤€ôø¹Õ±°¤ì4(4(€€€€€€€€€€€•á…Ñ-•åÌ¹…‘¡¥Ñ•´¹­•ä¤ì4(€€€€€€€€€€€ÁÉ½µ½Ñ•¹ÁÕÍ ¡ì4(€€€€€€€€€€€€€…Í¥¸è¥Ñ•´¹…É•…Ñ”¹…Í¥¸°4(€€€€€€€€€€€€€Í­Ôè¥Ñ•´¹…É•…Ñ”¹Í­Ôñð¥Ñ•´¹ÁÉ½‘ÕÐü¹Í­Ôñð€œœ°4(€€€€€€€€€€€€€Ñ•É´è¥Ñ•´¹…É•…Ñ”¹Ñ•É´°4(€€€€€€€€€€€€€Í…µ•}Í­Õ}½É‘•ÉÌè¥Ñ•´¹…É•…Ñ”¹Í…µ•M­Õ=É‘•ÉÌ°4(€€€€€€€€€€€€€Í…µ•}Í­Õ}Í…±•Ìè9Õµ‰•È¡¥Ñ•´¹…É•…Ñ”¹Í…µ•M­ÕM…±•Ì¹Ñ½¥á• È¤¤°4(€€€€€€€€€€€€€‰¥è¥Ñ•´¹Í…™•	¥°4(€€€€€€€€€€€€€…µÁ…¥¹}¥è¥Ñ•´¹…µÁ…¥¹%°4(€€€€€€€€€€€€€­•åÝ½É‘}¥è¥Ñ•´¹­•åÝ½É‘%°4(€€€€€€€€€€€€€Í½ÕÉ•}¹•…Ñ¥Ù•Ìè¹•…Ñ¥Ù•%‘Ì¹±•¹Ñ °4(€€€€€€€€€€€€€½¹Í•ÅÕ•¹”è¹•…Ñ¥Ù•Í½µÁ±•Ñ”€ü€µ…¹Õ…±}•á…Ñ}…Ñ¥Ù•}Í½ÕÉ•}¹•…Ñ•œ€è€µ…¹Õ…±}•á…Ñ}…Ñ¥Ù•}¹•…Ñ¥Ù•}É•Á…¥É}Á•¹‘¥¹œœ°4(€€€€€€€€€€€ô¤ì4(€€€€€€€€€ô4(€€€€€€€€€…Ý…¥ÐÝ…¥Ð ÄÔÀÀ¤ì4(€€€€€€€ô4(€€€€€ô4(4(€€€€€½¹ÍÐÉ•ÍÕ±Ð€ôì4(€€€€€€€…µ…é½¹}…½Õ¹Ñ}¥è…¥°4(€€€€€€€Ý¥¹‘½Üè€‘íÕÑ½™™õð‘íÑ½‘…åõ€°4(€€€€€€€Í•…É¡}Ñ•Éµ}É½ÝÌèÉ½ÝÍ%¹]¥¹‘½Ü¹±•¹Ñ °4(€€€€€€€Õ¹¥ÅÕ•}…Í¥¹}Ñ•ÉµÌè…É•…Ñ•Ì¹±•¹Ñ °4(€€€€€€€Í…µ•}Í­Õ}…¹‘¥‘…Ñ•Ìè…¹‘¥‘…Ñ•Ì¹±•¹Ñ °4(€€€€€€€Í•±•Ñ•èÍ•±•Ñ•¹±•¹Ñ °4(€€€€€€€ÁÉ½µ½Ñ•èÁÉ½µ½Ñ•¹±•¹Ñ °4(€€€€€€€™…¥±•è™…¥±•¹±•¹Ñ °4(€€€€€€€‰…¹­}É•…Ñ•è‰…¹­É•…Ñ•°4(€€€€€€€‰…¹­}ÕÁ‘…Ñ•è‰…¹­UÁ‘…Ñ•°4(€€€€€€€É•©•Ñ•‘}½Õ¹ÐèÉ•©•Ñ•¹±•¹Ñ °4(€€€€€€€ÁÉ½µ½Ñ•‘}Ñ•ÉµÌèÁÉ½µ½Ñ•°4(€€€€€€€É•©•Ñ•‘}Í…µÁ±”èÉ•©•Ñ•¹Í±¥” À°€ÔÀ¤°4(€€€€€€€™…¥±ÕÉ•Ìè™…¥±•°4(€€€€€ôì4(€€€€€É•Á½ÉÑÌ¹ÁÕÍ ¡É•ÍÕ±Ð¤ì4(4(€€€€€¥˜€ …‘ÉåIÕ¸¤ì4(€€€€€€€…Ý…¥Ð‰…Í”ÐÐ¹…ÍM•ÉÙ¥•I½±”¹•¹Ñ¥Ñ¥•Ì¹Må¹á•ÕÑ¥½¹1½œ¹É•…Ñ”¡ì4(€€€€€€€€€…µ…é½¹}…½Õ¹Ñ}¥è…¥°4(€€€€€€€€€½Á•É…Ñ¥½¸è€¥µµ•‘¥…Ñ•}Í…µ•}Í­Õ}Í•…É¡}Ñ•Éµ}¡…ÉÙ•ÍÑ}ØÄœ°4(€€€€€€€€€ÑÉ¥•É}ÑåÁ”è‰½‘ä¹ÑÉ¥•É}ÑåÁ”ñð€…ÕÑ½µ…Ñ¥Œœ°4(€€€€€€€€€ÍÑ…ÑÕÌè™…¥±•¹±•¹Ñ €ü€¡ÁÉ½µ½Ñ•¹±•¹Ñ €ü€Ý…É¹¥¹œœ€è€•ÉÉ½Èœ¤€è€ÍÕ•ÍÌœ°4(€€€€€€€€€•á•ÕÑ¥½¹}‘…Ñ”èÑ½‘…ä°4(€€€€€€€€€ÍÑ…ÉÑ•‘}…Ðè¹•Ü…Ñ”¡ÍÑ…ÉÑ•‘Ð¤¹Ñ½%M=MÑÉ¥¹œ ¤°4(€€€€€€€€€½µÁ±•Ñ•‘}…Ðè¹•Ü…Ñ” ¤¹Ñ½%M=MÑÉ¥¹œ ¤°4(€€€€€€€€€‘ÕÉ…Ñ¥½¹}µÌè…Ñ”¹¹½Ü ¤€´ÍÑ…ÉÑ•‘Ð°4(€€€€€€€€€É•½É‘Í}ÁÉ½•ÍÍ•èÁÉ½µ½Ñ•¹±•¹Ñ °4(€€€€€€€€€É•½É‘Í}É••¥Ù•èÉ½ÝÍ%¹]¥¹‘½Ü¹±•¹Ñ °4(€€€€€€€€€É•½É‘Í}¥µÁ½ÉÑ•è‰…¹­É•…Ñ•°4(€€€€€€€€€É•ÍÕ±Ñ}ÍÕµµ…Éäè)M=8¹ÍÑÉ¥¹¥™ä¡É•ÍÕ±Ð¤¹Í±¥” À°€ÄÈÀÀÀ¤°4(€€€€€€€€€•ÉÉ½É}µ•ÍÍ…”è™…¥±•¹±•¹Ñ €ü™…¥±•¹Í±¥” À°€Ô¤¹µ…À ¡É½Ü¤€ôø€‘íÉ½Ü¹…Í¥¹õð‘íÉ½Ü¹Ñ•Éµõð‘íÉ½Ü¹ÍÑ…•ôè€‘íÉ½Ü¹•ÉÉ½Éõ€¤¹©½¥¸ œì€œ¤¹Í±¥” À°€ÄÀÀÀ¤€è¹Õ±°°4(€€€€€€€ô¤¹…Ñ   ¤€ôø¹Õ±°¤ì4(€€€€€ô4(€€€ô4(4(€€€É•ÑÕÉ¸I•ÍÁ½¹Í”¹©Í½¸¡ì4(€€€€€½¬èÉ•Á½ÉÑÌ¹•Ù•Éä ¡É•Á½ÉÐ¤€ôøÉ•Á½ÉÐ¹™…¥±•€ôôô€À¤°4(€€€€€‘Éå}ÉÕ¸è‘ÉåIÕ¸°4(€€€€€Á½±¥äè€½¹•}Í…µ•}Í­Õ}Í…±•}Ñ¡•¹}µ…¹Õ…±}•á…Ñ}¥™}ÁÉ½™¥Ñ…‰±•}…¹‘}¹½Ñ}‘ÕÁ±¥…Ñ”œ°4(€€€€€±½½­‰…­}‘…åÌè±½½­‰…­…åÌ°4(€€€€€…½Õ¹ÑÍ}ÁÉ½•ÍÍ•èÉ•Á½ÉÑÌ¹±•¹Ñ °4(€€€€€É•Á½ÉÑÌ°4(€€€€€‘ÕÉ…Ñ¥½¹}µÌè…Ñ”¹¹½Ü ¤€´ÍÑ…ÉÑ•‘Ð°4(€€€ô¤ì4(€ô…Ñ €¡•ÉÉ½Èè…¹ä¤ì4(€€€É•ÑÕÉ¸I•ÍÁ½¹Í”¹©Í½¸¡ì½¬è™…±Í”°•ÉÉ½Èè•ÉÉ½Èü¹µ•ÍÍ…”ñðMÑÉ¥¹œ¡•ÉÉ½È¤°‘ÕÉ…Ñ¥½¹}µÌè…Ñ”¹¹½Ü ¤€´ÍÑ…ÉÑ•‘Ðô°ìÍÑ…ÑÕÌè€ÔÀÀô¤ì4(€ô4)ô¤ì4(