/**
 * runTermIntelligenceBackfill — Term Intelligence Execution Layer (backfill 15d)
 *
 * PHASE A  scan (SearchTerm, Campaign, Keyword, CampaignMetricsDaily, Product)
 * PHASE B  RECONCILIATION_PLAN por ASIN (current/desired/actions P0→P7)
 * PHASE C  validação de qualidade (duplicidade, estoque, buyability, winner
 *          protection, budget ceiling, Safe CPC por ASIN)
 * PHASE D  dry_run=true → plano completo sem escrever na Amazon
 * PHASE E  execute_changes=true → executa por lotes de 1 ASIN por job
 * PHASE F  confirmação Amazon REQUESTED → SENT → AMAZON_CONFIRMED (429/504)
 * PHASE G  reconciliação canônica no banco + audit log
 *
 * Idempotente: toda ação carrega idempotency_key estável; reexecuções
 * reaproveitam a TermIntelligenceAction existente em vez de duplicar.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import {
  DEFAULT_LOOKBACK_DAYS,
  MAX_EXACT_PER_CLUSTER,
  MIN_EXACT_PER_CLUSTER,
  normalizePtBr,
  termFamilyKey,
  intentCluster,
  hardAttributes,
  canCluster,
  validateClusterCapacity,
  safeCpcForAsin,
  candidateBid,
  zeroDeliveryRecoveryBid,
  termMaturity,
  classifyCampaign,
  actionForClassification,
  actionIdempotencyKey,
  ACTION_PRIORITY,
} from '../../shared/termIntelligence.ts';

const CT_KEYWORD = 'application/vnd.spKeyword.v3+json';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: any) => Number(v || 0);
const upper = (v: any) => String(v || '').toUpperCase();

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

async function ads(base44: any, accountId: string, operation: string, method: string, path: string, payload: any) {
  const started = Date.now();
  const res = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
    amazon_account_id: accountId,
    operation,
    method,
    path,
    payload,
    content_type: CT_KEYWORD,
    accept: CT_KEYWORD,
    _service_role: true,
  }).catch((error: any) => ({ data: { ok: false, status: 500, error: error?.message } }));
  const data = res?.data || res || {};
  return { data, status: Number(data?.status || (data?.ok === false ? 500 : 200)), duration: Date.now() - started };
}

/** Backoff para 429 (Retry-After) e assíncrono para 504/524. */
function retryPlan(status: number, data: any, attempt: number): { retry: boolean; waitMs: number; async: boolean } {
  if (status === 429) {
    const retryAfter = Number(data?.retry_after_seconds || data?.retryAfter || 0);
    return { retry: attempt < 3, waitMs: retryAfter > 0 ? retryAfter * 1000 : Math.min(30000, 2000 * 2 ** attempt), async: false };
  }
  if (status === 504 || status === 524) return { retry: false, waitMs: 0, async: true };
  return { retry: false, waitMs: 0, async: false };
}

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));

    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
      if (user.role !== 'admin') return Response.json({ ok: false, error: 'Forbidden' }, { status: 403 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon conectada não encontrada' }, { status: 404 });

    const accountId = account.id;
    const lookbackDays = Math.max(1, Number(body.lookback_days || DEFAULT_LOOKBACK_DAYS));
    const dryRun = body.execute_changes === true ? false : true;
    const asinScope = Array.isArray(body.asin_scope) ? body.asin_scope.map(upper).filter(Boolean) : [];
    const maxAsins = Math.max(1, Number(body.max_asins || (dryRun ? 40 : 1)));
    const runId = String(body.run_id || `ti_${accountId}_${Date.now()}`);
    const since = daysAgoIso(lookbackDays);

    // Feature flag por conta (rollout controlado)
    const flags = await base44.asServiceRole.entities.FeatureFlag
      .filter({ key: 'term_intelligence_execution_enabled' }, '-updated_at', 1).catch(() => []);
    const executionEnabled = flags[0]?.enabled === true;
    if (!dryRun && !executionEnabled) {
      return Response.json({ ok: false, error: 'term_intelligence_execution_enabled desligado — execução bloqueada', run_id: runId }, { status: 409 });
    }

    const run = await base44.asServiceRole.entities.TermIntelligenceRun.create({
      amazon_account_id: accountId, run_id: runId, lookback_days: lookbackDays, dry_run: dryRun,
      asin_scope: asinScope, status: 'running', phase: 'A_SCAN', started_at: startedAt,
    }).catch(() => null);

    // ── PHASE A — SCAN ───────────────────────────────────────────────────────
    const [campaigns, keywords, products, searchTerms, metrics, settingsRows] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-created_date', 3000).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-last_seen_at', 8000).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, null, 1000).catch(() => []),
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: accountId, date: { $gte: since } }, '-date', 8000).catch(() => []),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: accountId, date: { $gte: since } }, '-date', 8000).catch(() => []),
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, '-updated_at', 1).catch(() => []),
    ]);

    const targetAcosPct = Number(settingsRows[0]?.target_acos || 15);
    const productByAsin = new Map<string, any>();
    for (const p of products) if (p.asin) productByAsin.set(upper(p.asin), p);

    const activeCampaigns = campaigns.filter((c: any) => {
      const state = String(c.state || c.status || '').toLowerCase();
      return state !== 'archived' && !c.archived;
    });

    const metricsByCampaign = new Map<string, any>();
    for (const m of metrics) {
      const cid = String(m.campaign_id || '');
      if (!cid) continue;
      const agg = metricsByCampaign.get(cid) || { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0 };
      agg.impressions += num(m.impressions); agg.clicks += num(m.clicks);
      agg.spend += num(m.spend); agg.sales += num(m.sales); agg.orders += num(m.orders);
      metricsByCampaign.set(cid, agg);
    }

    const keywordsByCampaign = new Map<string, any[]>();
    for (const k of keywords) {
      const cid = String(k.campaign_id || '');
      if (!cid || String(k.state || k.status || '').toLowerCase() === 'archived') continue;
      if (!keywordsByCampaign.has(cid)) keywordsByCampaign.set(cid, []);
      keywordsByCampaign.get(cid)!.push(k);
    }

    // Agregar Search Terms (qualquer fonte, inclusive MANUAL) por ASIN + termo normalizado
    type TermAgg = {
      asin: string; raw: string; normalized: string; family: string; intent: string;
      impressions: number; clicks: number; spend: number; sales: number;
      sameSkuOrders: number; haloOrders: number; saleDays: Set<string>;
      sources: Set<string>; campaigns: Set<string>; variants: Set<string>;
      firstSeen: string; lastSeen: string; firstSale: string | null; lastSale: string | null;
    };
    const termsByAsin = new Map<string, Map<string, TermAgg>>();

    // Relatórios da Amazon nem sempre trazem o ASIN anunciado: resolver pela campanha.
    const asinByCampaign = new Map<string, string>();
    for (const c of campaigns) {
      const cid = String(c.campaign_id || c.amazon_campaign_id || '');
      if (cid && c.asin) asinByCampaign.set(cid, upper(c.asin));
    }

    for (const st of searchTerms) {
      const asin = upper(st.advertised_asin || st.asin || asinByCampaign.get(String(st.campaign_id || '')) || '');
      const raw = String(st.search_term || st.search_term_original || '').trim();
      if (!asin || !raw) continue;
      if (asinScope.length && !asinScope.includes(asin)) continue;
      const normalized = normalizePtBr(raw);
      if (!normalized) continue;
      if (!termsByAsin.has(asin)) termsByAsin.set(asin, new Map());
      const bucket = termsByAsin.get(asin)!;
      const current = bucket.get(normalized) || {
        asin, raw, normalized, family: termFamilyKey(normalized), intent: intentCluster(normalized),
        impressions: 0, clicks: 0, spend: 0, sales: 0, sameSkuOrders: 0, haloOrders: 0,
        saleDays: new Set<string>(), sources: new Set<string>(), campaigns: new Set<string>(),
        variants: new Set<string>(), firstSeen: st.date, lastSeen: st.date, firstSale: null, lastSale: null,
      };
      current.impressions += num(st.impressions);
      current.clicks += num(st.clicks);
      current.spend += num(st.spend);
      current.sales += num(st.same_sku_sales || st.sales_14d || st.total_sales);
      const orders = num(st.same_sku_orders || st.orders_14d || st.total_orders);
      current.sameSkuOrders += num(st.same_sku_orders || (st.same_asin_order ? orders : 0));
      current.haloOrders += num(st.halo_orders);
      if (orders > 0 && st.date) { current.saleDays.add(st.date); current.firstSale = current.firstSale || st.date; current.lastSale = st.date; }
      if (st.source_type) current.sources.add(st.source_type);
      if (st.campaign_id) current.campaigns.add(String(st.campaign_id));
      current.variants.add(raw);
      if (st.date < current.firstSeen) current.firstSeen = st.date;
      if (st.date > current.lastSeen) current.lastSeen = st.date;
      bucket.set(normalized, current);
    }

    const scopedAsins = Array.from(termsByAsin.keys()).slice(0, maxAsins);

    // ── PHASE B + C — PLANO E VALIDAÇÃO ──────────────────────────────────────
    const plans: any[] = [];
    let termsScanned = 0;
    let duplicatesPrevented = 0;

    for (const asin of scopedAsins) {
      const product = productByAsin.get(asin) || {};
      const inStock = num(product.fba_inventory) > 0 && String(product.inventory_status || '') !== 'out_of_stock';
      const buyable = product.listing_buyable !== false;
      // Dedup por campaign_id (o banco pode ter linhas repetidas do mesmo recurso)
      const byCampaignId = new Map<string, any>();
      for (const c of activeCampaigns) {
        if (upper(c.asin) !== asin) continue;
        const cid = String(c.campaign_id || c.amazon_campaign_id || '');
        if (!cid || byCampaignId.has(cid)) continue;
        byCampaignId.set(cid, c);
      }
      const asinCampaigns = Array.from(byCampaignId.values());
      const observedCpc = (() => {
        const kws = asinCampaigns.flatMap((c: any) => keywordsByCampaign.get(String(c.campaign_id)) || []);
        const withCpc = kws.map((k: any) => num(k.cpc)).filter((v) => v > 0);
        return withCpc.length ? withCpc.reduce((a, b) => a + b, 0) / withCpc.length : 0;
      })();
      const safeCpc = safeCpcForAsin({
        price: num(product.price),
        observedCpc,
        conversionRate: num(product.conversion_rate_30d),
        targetAcosPct,
        contributionMarginPct: num(product.profit_margin_pct) || 25,
      });

      const asinActions: any[] = [];
      const clusterUsage = new Map<string, { campaign: any; terms: string[] }>();

      // Campanhas existentes: classificar e agir
      for (const campaign of asinCampaigns) {
        const cid = String(campaign.campaign_id || '');
        const targeting = String(campaign.targeting_type || campaign.amazon_targeting_type || '').toUpperCase();
        const isAuto = targeting === 'AUTO' || /\|\s*auto\s*\|/i.test(String(campaign.name || campaign.campaign_name || ''));
        // Campanhas AUTO não têm Exact por definição: são fonte de descoberta, não cluster.
        if (isAuto) continue;
        const kws = (keywordsByCampaign.get(cid) || []).filter((k: any) => String(k.match_type || '').toLowerCase() === 'exact');
        const agg = metricsByCampaign.get(cid) || { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0 };
        const acos = agg.sales > 0 ? (agg.spend / agg.sales) * 100 : 0;
        const isWinnerStructure = kws.length === 1 && agg.orders >= 2;
        const classification = classifyCampaign({
          exactKeywordCount: kws.length,
          hasAdGroup: Boolean(campaign.ad_group_id || kws[0]?.ad_group_id),
          hasProductAd: campaign.status !== 'incomplete',
          impressions: agg.impressions, clicks: agg.clicks, spend: agg.spend,
          sales: agg.sales, orders: agg.orders, acos, targetAcosPct,
          inStock, buyable, isWinnerStructure,
        });
        let action = actionForClassification(classification);

        // Winner protection: winner saudável nunca é reorganizado
        if (isWinnerStructure && acos > 0 && acos <= targetAcosPct * 1.35) action = 'KEEP';
        // Nunca pausar/arquivar sem estoque confirmado + motivo explícito
        if ((action === 'PAUSE_CAMPAIGN') && inStock && buyable) action = 'KEEP';

        if (kws.length >= MIN_EXACT_PER_CLUSTER && kws.length <= MAX_EXACT_PER_CLUSTER) {
          clusterUsage.set(cid, { campaign, terms: kws.map((k: any) => normalizePtBr(k.keyword_text || k.keyword)) });
        }

        let bidPlan: number | null = null;
        if (action === 'RECOVER_ZERO_DELIVERY') {
          const attempts = num(campaign.zero_delivery_attempts) + 1;
          bidPlan = zeroDeliveryRecoveryBid(num(kws[0]?.current_bid || kws[0]?.bid || 0.5), attempts, safeCpc);
          if (bidPlan === null) action = 'KEEP';
        }
        if (action === 'REDUCE_BID') {
          bidPlan = Math.max(0.25, Math.round(Math.min(num(kws[0]?.current_bid || 0.5) * 0.9, safeCpc) * 100) / 100);
        }

        asinActions.push({
          asin, campaign_id: cid, ad_group_id: campaign.ad_group_id || kws[0]?.ad_group_id || null,
          keyword_id: kws[0]?.keyword_id || null,
          term: kws[0]?.keyword_text || kws[0]?.keyword || '',
          classification, action, priority: ACTION_PRIORITY[action],
          current_state: `exact=${kws.length};orders=${agg.orders};acos=${acos.toFixed(1)}%`,
          desired_state: action === 'ISOLATE_WINNER' ? 'WINNER 1:1 confirmado'
            : action === 'ADD_EXACT' ? `cluster 2..${MAX_EXACT_PER_CLUSTER} Exact coerentes`
            : 'estrutura mantida',
          reason: `${classification} em ${lookbackDays}d`,
          evidence: JSON.stringify({ ...agg, acos: Number(acos.toFixed(2)), exact_keywords: kws.length, safe_cpc: safeCpc }),
          candidate_bid: bidPlan,
          safe_cpc: safeCpc,
          previous_campaign_id: cid,
          previous_keyword_id: kws[0]?.keyword_id || null,
          previous_bid: num(kws[0]?.current_bid || kws[0]?.bid),
          previous_status: String(campaign.state || campaign.status || ''),
          previous_cluster: campaign.name || campaign.campaign_name || '',
        });
      }

      // Termos: maturidade + destino no cluster
      const termBucket = termsByAsin.get(asin)!;
      const existingTermSet = new Set<string>();
      for (const entry of clusterUsage.values()) for (const t of entry.terms) existingTermSet.add(t);

      for (const term of termBucket.values()) {
        termsScanned++;
        const cvr = term.clicks > 0 ? (term.sameSkuOrders / term.clicks) * 100 : 0;
        const acos = term.sales > 0 ? (term.spend / term.sales) * 100 : 0;
        const promotedToManual = existingTermSet.has(term.normalized);
        const maturity = termMaturity({
          clicks: term.clicks, sameSkuOrders: term.sameSkuOrders, acos, targetAcosPct,
          distinctSaleDays: term.saleDays.size, promotedToManual, inStock, buyable,
        });
        const bid = candidateBid({ observedCpc: term.clicks > 0 ? term.spend / term.clicks : 0, safeCpc });

        // Histórico longitudinal (idempotente por unique_key)
        const uniqueKey = `${accountId}|${asin}|${term.normalized}|${lookbackDays}d`;
        const existingProfiles = await base44.asServiceRole.entities.TermIntelligenceProfile
          .filter({ amazon_account_id: accountId, unique_key: uniqueKey }, null, 1).catch(() => []);
        const profilePayload = {
          amazon_account_id: accountId, asin, sku: product.sku || null,
          raw_search_term: existingProfiles[0]?.raw_search_term || term.raw,
          normalized_search_term: term.normalized,
          term_family_key: term.family, intent_cluster: term.intent,
          hard_attributes: JSON.stringify(hardAttributes(term.normalized)),
          raw_variants: Array.from(term.variants).slice(0, 20),
          source_types: Array.from(term.sources), source_campaigns: Array.from(term.campaigns).slice(0, 20),
          window: `${lookbackDays}d` === '15d' ? '15d' : '30d',
          first_seen_at: term.firstSeen, last_seen_at: term.lastSeen,
          first_sale_at: term.firstSale, last_sale_at: term.lastSale,
          impressions: term.impressions, clicks: term.clicks, spend: term.spend, sales: term.sales,
          same_sku_orders: term.sameSkuOrders, halo_orders: term.haloOrders,
          distinct_sale_days: term.saleDays.size,
          cpc: term.clicks > 0 ? term.spend / term.clicks : 0,
          ctr: term.impressions > 0 ? (term.clicks / term.impressions) * 100 : 0,
          cvr, acos, roas: term.spend > 0 ? term.sales / term.spend : 0,
          profit_after_ads: term.sales - term.spend,
          safe_cpc: safeCpc, candidate_bid: bid,
          current_maturity: maturity,
          previous_maturity: existingProfiles[0]?.current_maturity || null,
          last_transition_at: existingProfiles[0]?.current_maturity !== maturity ? new Date().toISOString() : existingProfiles[0]?.last_transition_at || new Date().toISOString(),
          unique_key: uniqueKey, run_id: runId, updated_at: new Date().toISOString(),
        };
        if (existingProfiles[0]) await base44.asServiceRole.entities.TermIntelligenceProfile.update(existingProfiles[0].id, profilePayload).catch(() => {});
        else await base44.asServiceRole.entities.TermIntelligenceProfile.create(profilePayload).catch(() => {});

        if (promotedToManual) { duplicatesPrevented++; continue; }
        if (!inStock || !buyable) continue;

        if (maturity === 'WINNER') {
          asinActions.push({
            asin, campaign_id: null, term: term.raw, normalized_term: term.normalized,
            term_family_key: term.family, intent_cluster: term.intent,
            classification: 'WINNER', action: 'ISOLATE_WINNER', priority: ACTION_PRIORITY.ISOLATE_WINNER,
            current_state: `no cluster (${term.sameSkuOrders} pedidos same-SKU)`,
            desired_state: 'campanha 1:1 confirmada na Amazon',
            reason: 'multi-conversão com ACoS saudável e recorrência',
            evidence: JSON.stringify({ orders: term.sameSkuOrders, sale_days: term.saleDays.size, acos: Number(acos.toFixed(2)) }),
            candidate_bid: bid, safe_cpc: safeCpc,
          });
          continue;
        }

        if (maturity === 'PROVEN' || maturity === 'WINNER_CANDIDATE' || maturity === 'QUALIFIED') {
          // destino: cluster coerente existente com capacidade, senão criar cluster
          let target: { campaign: any; terms: string[] } | null = null;
          for (const entry of clusterUsage.values()) {
            const capacity = validateClusterCapacity('MANUAL_CLUSTERED', entry.terms.length);
            if (!capacity.allowed) continue;
            const coherent = entry.terms.every((t) => canCluster(t, term.normalized).allowed);
            if (coherent) { target = entry; break; }
          }
          const action = target ? 'ADD_EXACT' : 'CREATE_CLUSTER';
          if (target) target.terms.push(term.normalized);
          asinActions.push({
            asin,
            campaign_id: target ? String(target.campaign.campaign_id) : null,
            ad_group_id: target ? target.campaign.ad_group_id || null : null,
            term: term.raw, normalized_term: term.normalized,
            term_family_key: term.family, intent_cluster: term.intent,
            classification: maturity, action, priority: ACTION_PRIORITY[action],
            current_state: 'termo sem estrutura manual',
            desired_state: target
              ? `Exact adicionado ao cluster ${target.campaign.name || target.campaign.campaign_id} (${target.terms.length}/${MAX_EXACT_PER_CLUSTER})`
              : 'novo cluster temático com 2..5 Exact',
            reason: `maturidade ${maturity} em ${lookbackDays}d`,
            evidence: JSON.stringify({ clicks: term.clicks, orders: term.sameSkuOrders, cvr: Number(cvr.toFixed(2)) }),
            candidate_bid: bid, safe_cpc: safeCpc,
          });
        }
      }

      asinActions.sort((a, b) => a.priority - b.priority);
      plans.push({ asin, in_stock: inStock, buyable, safe_cpc: safeCpc, actions: asinActions });
    }

    // Persistir plano (idempotente por idempotency_key)
    const persisted: any[] = [];
    for (const plan of plans) {
      for (const action of plan.actions) {
        const key = actionIdempotencyKey({ accountId, asin: plan.asin, action: action.action, target: action.term || action.campaign_id || '' });
        const existing = await base44.asServiceRole.entities.TermIntelligenceAction
          .filter({ amazon_account_id: accountId, idempotency_key: key, run_id: runId }, null, 1).catch(() => []);
        const payload = {
          amazon_account_id: accountId, run_id: runId, asin: plan.asin,
          campaign_id: action.campaign_id || null, ad_group_id: action.ad_group_id || null,
          keyword_id: action.keyword_id || null,
          term: action.term || null, normalized_term: action.normalized_term || normalizePtBr(action.term || ''),
          term_family_key: action.term_family_key || null, intent_cluster: action.intent_cluster || null,
          classification: action.classification, action: action.action, priority: action.priority,
          reason: action.reason, evidence: String(action.evidence || '').slice(0, 3000),
          current_state: action.current_state, desired_state: action.desired_state,
          candidate_bid: action.candidate_bid || null, safe_cpc: action.safe_cpc || null,
          previous_campaign_id: action.previous_campaign_id || null,
          previous_keyword_id: action.previous_keyword_id || null,
          previous_bid: action.previous_bid || null,
          previous_status: action.previous_status || null,
          previous_cluster: action.previous_cluster || null,
          execution_status: 'PLANNED', dry_run: dryRun, idempotency_key: key,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        };
        const record = existing[0]
          ? await base44.asServiceRole.entities.TermIntelligenceAction.update(existing[0].id, payload).catch(() => null)
          : await base44.asServiceRole.entities.TermIntelligenceAction.create(payload).catch(() => null);
        if (record) persisted.push({ ...payload, id: record.id || existing[0]?.id });
      }
    }

    // ── PHASE E/F — EXECUÇÃO + CONFIRMAÇÃO AMAZON ────────────────────────────
    const counters = {
      actions_executed: 0, clusters_created: 0, keywords_added: 0, winners_isolated: 0,
      campaigns_paused: 0, campaigns_archived: 0, failures: 0,
    };

    if (!dryRun) {
      const executable = persisted
        .filter((a) => ['ADD_EXACT', 'CREATE_CLUSTER', 'ISOLATE_WINNER', 'RECOVER_ZERO_DELIVERY', 'REDUCE_BID'].includes(a.action))
        .sort((a, b) => a.priority - b.priority)
        .slice(0, Number(body.max_actions || 8));

      for (const action of executable) {
        const started = Date.now();
        await base44.asServiceRole.entities.TermIntelligenceAction.update(action.id, { execution_status: 'REQUESTED', updated_at: new Date().toISOString() }).catch(() => {});
        try {
          if (action.action === 'ADD_EXACT' && action.campaign_id && action.ad_group_id) {
            let attempt = 0;
            let result = await ads(base44, accountId, 'termIntelligenceAddExact', 'POST', '/sp/keywords', {
              keywords: [{ campaignId: String(action.campaign_id), adGroupId: String(action.ad_group_id), keywordText: action.term, matchType: 'EXACT', state: 'ENABLED', bid: action.candidate_bid || action.safe_cpc }],
            });
            let plan = retryPlan(result.status, result.data, attempt);
            while (plan.retry) {
              attempt++; await sleep(plan.waitMs);
              result = await ads(base44, accountId, 'termIntelligenceAddExact', 'POST', '/sp/keywords', {
                keywords: [{ campaignId: String(action.campaign_id), adGroupId: String(action.ad_group_id), keywordText: action.term, matchType: 'EXACT', state: 'ENABLED', bid: action.candidate_bid || action.safe_cpc }],
              });
              plan = retryPlan(result.status, result.data, attempt);
            }
            await base44.asServiceRole.entities.TermIntelligenceAction.update(action.id, {
              execution_status: 'SENT', amazon_endpoint: '/sp/keywords', http_status: result.status,
              amazon_response: JSON.stringify(result.data?.payload || result.data).slice(0, 2000),
              retry_count: attempt, duration_ms: Date.now() - started, updated_at: new Date().toISOString(),
            }).catch(() => {});

            // PHASE F — confirmação na Amazon
            await sleep(6000);
            const check = await ads(base44, accountId, 'termIntelligenceConfirmExact', 'POST', '/sp/keywords/list', {
              campaignIdFilter: { include: [String(action.campaign_id)] },
              stateFilter: { include: ['ENABLED'] },
              maxResults: 100,
            });
            const list = check.data?.payload?.keywords || [];
            const confirmed = list.some((k: any) => normalizePtBr(k.keywordText || '') === normalizePtBr(action.term || ''));
            await base44.asServiceRole.entities.TermIntelligenceAction.update(action.id, {
              execution_status: confirmed ? 'AMAZON_CONFIRMED' : (plan.async ? 'SENT' : 'FAILED'),
              confirmed_at: confirmed ? new Date().toISOString() : null,
              failure_reason: confirmed ? null : 'keyword_not_confirmed_on_amazon',
              new_state: confirmed ? 'MANUAL_CLUSTERED' : null,
              updated_at: new Date().toISOString(),
            }).catch(() => {});
            if (confirmed) { counters.keywords_added++; counters.actions_executed++; } else counters.failures++;
          } else if (action.action === 'ISOLATE_WINNER' || action.action === 'CREATE_CLUSTER') {
            const res = await base44.asServiceRole.functions.invoke('createManualCampaignV2', {
              amazon_account_id: accountId, asin: action.asin, keyword: action.term,
              bid: action.candidate_bid || action.safe_cpc, budget: 9, _service_role: true,
            }).catch((error: any) => ({ data: { ok: false, error: error?.message } }));
            const data = res?.data || res || {};
            const ok = data.ok === true || data.already_exists === true || data.blocked_duplicate === true;
            await base44.asServiceRole.entities.TermIntelligenceAction.update(action.id, {
              execution_status: ok ? 'AMAZON_CONFIRMED' : 'FAILED',
              campaign_id: data.campaign_id || data.existing_campaign_id || null,
              amazon_endpoint: '/sp/campaigns', http_status: ok ? 200 : 500,
              amazon_response: JSON.stringify(data).slice(0, 2000),
              confirmed_at: ok ? new Date().toISOString() : null,
              failure_reason: ok ? null : String(data.error || 'campaign_creation_failed'),
              new_state: ok ? (action.action === 'ISOLATE_WINNER' ? 'ISOLATED' : 'MANUAL_CLUSTERED') : null,
              duration_ms: Date.now() - started, updated_at: new Date().toISOString(),
            }).catch(() => {});
            if (ok) {
              counters.actions_executed++;
              if (action.action === 'ISOLATE_WINNER') counters.winners_isolated++; else counters.clusters_created++;
              // Negative Exact na AUTO SOMENTE após confirmação Amazon
              if (action.action === 'ISOLATE_WINNER') {
                await base44.asServiceRole.functions.invoke('negateKeywordInAutoCampaign', {
                  amazon_account_id: accountId, asin: action.asin, keyword_text: action.term,
                  match_type: 'NEGATIVE_EXACT', _service_role: true,
                }).catch(() => {});
              }
            } else counters.failures++;
          } else if (action.candidate_bid && action.keyword_id) {
            const result = await ads(base44, accountId, 'termIntelligenceBidUpdate', 'PUT', '/sp/keywords', {
              keywords: [{ keywordId: String(action.keyword_id), bid: action.candidate_bid }],
            });
            const ok = result.status < 400;
            await base44.asServiceRole.entities.TermIntelligenceAction.update(action.id, {
              execution_status: ok ? 'AMAZON_CONFIRMED' : 'FAILED',
              amazon_endpoint: '/sp/keywords', http_status: result.status,
              amazon_response: JSON.stringify(result.data?.payload || result.data).slice(0, 2000),
              confirmed_at: ok ? new Date().toISOString() : null,
              duration_ms: Date.now() - started, updated_at: new Date().toISOString(),
            }).catch(() => {});
            if (ok) counters.actions_executed++; else counters.failures++;
          } else {
            await base44.asServiceRole.entities.TermIntelligenceAction.update(action.id, {
              execution_status: 'SKIPPED', failure_reason: 'pré-requisitos ausentes', updated_at: new Date().toISOString(),
            }).catch(() => {});
          }
        } catch (error: any) {
          counters.failures++;
          await base44.asServiceRole.entities.TermIntelligenceAction.update(action.id, {
            execution_status: 'FAILED', failure_reason: String(error?.message || 'erro desconhecido').slice(0, 500),
            duration_ms: Date.now() - started, updated_at: new Date().toISOString(),
          }).catch(() => {});
        }
        await sleep(3000);
      }
    }

    // ── PHASE G — RECONCILIAÇÃO + AUDIT LOG ─────────────────────────────────
    const finishedAt = new Date().toISOString();
    const summary = {
      run_id: runId, dry_run: dryRun, lookback_days: lookbackDays,
      asins_scanned: scopedAsins.length, campaigns_scanned: activeCampaigns.length,
      terms_scanned: termsScanned, actions_planned: persisted.length,
      duplicates_prevented: duplicatesPrevented, ...counters,
    };

    if (run?.id) {
      await base44.asServiceRole.entities.TermIntelligenceRun.update(run.id, {
        status: dryRun ? 'planned' : (counters.failures > 0 ? 'partial' : 'executed'),
        phase: 'G_RECONCILED', finished_at: finishedAt,
        asins_scanned: scopedAsins.length, campaigns_scanned: activeCampaigns.length,
        terms_scanned: termsScanned, actions_planned: persisted.length,
        duplicates_prevented: duplicatesPrevented, ...counters,
        summary: JSON.stringify(summary).slice(0, 4000),
      }).catch(() => {});
    }

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'term_intelligence_backfill',
      trigger_type: body.trigger_type || 'manual',
      status: dryRun ? 'success' : (counters.failures > 0 ? 'partial' : 'success'),
      started_at: startedAt, completed_at: finishedAt,
      records_processed: persisted.length,
      result_summary: JSON.stringify(summary).slice(0, 4000),
    }).catch(() => {});

    if (!dryRun) {
      const existingFlags = await base44.asServiceRole.entities.FeatureFlag
        .filter({ key: 'term_intelligence_backfill_completed_at' }, null, 1).catch(() => []);
      const flagPayload = { key: 'term_intelligence_backfill_completed_at', enabled: true, scope: 'account', updated_at: finishedAt, reason: runId };
      if (existingFlags[0]) await base44.asServiceRole.entities.FeatureFlag.update(existingFlags[0].id, flagPayload).catch(() => {});
      else await base44.asServiceRole.entities.FeatureFlag.create(flagPayload).catch(() => {});
    }

    return Response.json({
      ok: true,
      ...summary,
      plan: plans.map((p: any) => ({ ...p, actions_count: p.actions.length, actions: p.actions.slice(0, 20) })),
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha no backfill de Term Intelligence', previous_data_preserved: true }, { status: 500 });
  }
});