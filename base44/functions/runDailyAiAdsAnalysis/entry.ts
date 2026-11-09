import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import {
  buildDailyAdsCandidates,
  calculateAcos,
  DEFAULT_DAILY_AI_SETTINGS,
  AUTONOMOUS_ADS_RISK_POLICY,
  normalizeConfidence,
  rebalanceBudgetPlan,
  validateRecommendation,
  type AiAdsRecommendation,
  type DailyAdsCandidate,
  type DailyAdsSettings,
} from '../../shared/dailyAiAdsPolicy.ts';
import { runAmazonAdsTokenPrecheck } from '../../shared/amazonAdsTokenPrecheck.ts';

const ACCOUNT_ID = 'amazon_account_id';
const MAX_ROWS = 2500;
const PAGE_SIZE = 400;
const PAGE_PAUSE_MS = 250;
const EXECUTION_BATCH_SIZE = 5;
const EXECUTION_PAUSE_MS = 800;

function value(row: any, key: string, fallback: unknown = undefined): unknown {
  return row?.[key] ?? row?.data?.[key] ?? fallback;
}

function text(row: any, key: string): string {
  return String(value(row, key, '') || '');
}

function number(row: any, key: string): number {
  const parsed = Number(value(row, key, 0));
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalNumber(row: any, key: string): number | undefined {
  const raw = value(row, key, undefined);
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function todayBrt(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function nowIso(): string { return new Date().toISOString(); }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pagedFilter(
  base44: any,
  entity: any,
  query: Record<string, unknown>,
  sort: string,
  maxRows: number,
): Promise<any[]> {
  const rows: any[] = [];
  for (let offset = 0; offset < maxRows; offset += PAGE_SIZE) {
    const page = await entity.filter(query, sort, Math.min(PAGE_SIZE, maxRows - offset), offset).catch(() => []);
    if (!Array.isArray(page) || page.length === 0) break;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    await sleep(PAGE_PAUSE_MS);
  }
  return rows;
}

function safeJson(valueToParse: unknown): any {
  if (typeof valueToParse !== 'string') return valueToParse || {};
  const cleaned = valueToParse.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { return {}; }
}

function productValue(row: any, key: string, fallback: unknown = undefined): unknown {
  return row?.[key] ?? row?.data?.[key] ?? fallback;
}

function productText(row: any, key: string): string {
  return String(productValue(row, key, '') || '').trim();
}

function productNumber(row: any, ...keys: string[]): number {
  for (const key of keys) {
    const parsed = Number(productValue(row, key, undefined));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function productHasStock(row: any): boolean {
  return productNumber(row, 'fba_inventory', 'available_quantity', 'total_quantity', 'fba_quantity') > 0;
}

function productIsInactive(row: any): boolean {
  const status = productText(row, 'status').toLowerCase();
  const lifecycle = productText(row, 'lifecycle_status').toLowerCase();
  return ['inactive', 'archived', 'deleted', 'removed', 'not_found'].includes(status)
    || ['inactive', 'archived', 'deleted', 'removed', 'not_found'].includes(lifecycle)
    || productValue(row, 'offer_active', undefined) === false
    || productValue(row, 'listing_buyable', undefined) === false
    || productValue(row, 'listing_suppressed', undefined) === true;
}

function productIsActiveAndSellable(row: any): boolean {
  const status = productText(row, 'status').toLowerCase();
  return !productIsInactive(row) && !['draft', 'deleted', 'removed'].includes(status) && productHasStock(row);
}

function campaignKey(row: any): string {
  return `${productText(row, 'asin').toUpperCase()}|${productText(row, 'sku').toUpperCase()}`;
}

function campaignIsAuto(row: any): boolean {
  const type = productText(row, 'targeting_type').toUpperCase();
  const name = (productText(row, 'name') || productText(row, 'campaign_name')).toUpperCase();
  return type === 'AUTO' || (name.includes('AUTO') && !name.includes('MANUAL'));
}

function campaignCoverage(products: any[], campaigns: any[]) {
  const byKey = new Map<string, any[]>();
  const uniqueProducts = [...new Map(products.map((row) => {
    const asin = productText(row, 'asin').toUpperCase();
    const sku = productText(row, 'sku').toUpperCase();
    return [`${asin}|${sku}`, row];
  })).values()];
  for (const campaign of campaigns) {
    const key = campaignKey(campaign);
    byKey.set(key, [...(byKey.get(key) || []), campaign]);
  }
  return uniqueProducts.map((product) => {
    const asin = productText(product, 'asin').toUpperCase();
    const sku = productText(product, 'sku').toUpperCase();
    const linked = byKey.get(`${asin}|${sku}`) || campaigns.filter((row) => productText(row, 'asin').toUpperCase() === asin);
    const live = linked.filter((row) => !row.archived && !['archived', 'removed'].includes(productText(row, 'state').toLowerCase()));
    return {
      asin,
      sku,
      title: productText(product, 'product_name') || productText(product, 'title') || productText(product, 'name'),
      product_status: productText(product, 'status'),
      stock: productNumber(product, 'fba_inventory', 'available_quantity', 'total_quantity', 'fba_quantity'),
      active_sellable: productIsActiveAndSellable(product),
      campaigns_total: live.length,
      campaigns_enabled: live.filter((row) => ['enabled', 'active'].includes(productText(row, 'state').toLowerCase() || productText(row, 'status').toLowerCase())).length,
      auto_campaigns: live.filter(campaignIsAuto).length,
      manual_campaigns: live.filter((row) => !campaignIsAuto(row)).length,
      paused_campaigns: live.filter((row) => ['paused', 'incomplete'].includes(productText(row, 'state').toLowerCase() || productText(row, 'status').toLowerCase())).length,
    };
  });
}

function mapSettings(row: any): DailyAdsSettings {
  const base = DEFAULT_DAILY_AI_SETTINGS;
  return {
    minBid: Math.max(0.05, number(row, 'min_bid') || base.minBid),
    maxBid: Math.max(0.20, number(row, 'max_bid') || base.maxBid),
    maxAcos: number(row, 'max_acos') || number(row, 'target_acos_max') || base.maxAcos,
    targetAcos: number(row, 'target_acos') || base.targetAcos,
    dailyBudgetCap: number(row, 'daily_budget_limit') || number(row, 'daily_budget_cap') || base.dailyBudgetCap,
    maxBidStepPct: Math.min(30, Math.max(5, number(row, 'max_bid_reduction_pct') || base.maxBidStepPct)),
    maxBudgetStepPct: Math.min(15, Math.max(5, number(row, 'max_budget_change_pct') || base.maxBudgetStepPct)),
    maxProposals: base.maxProposals,
    aiConfidenceThreshold: Math.max(0.80, Math.min(0.99,
      number(row, 'ai_confidence_threshold') || number(row, 'minimum_ai_confidence') || base.aiConfidenceThreshold)),
    minReductionEvidenceDays: Math.max(2, Math.min(7,
      number(row, 'min_bid_reduction_evidence_days') || base.minReductionEvidenceDays)),
  };
}

function summarizeMetrics(candidates: DailyAdsCandidate[], budgetPlan: ReturnType<typeof rebalanceBudgetPlan>, settings: DailyAdsSettings) {
  const totals = candidates.reduce((sum, row) => ({
    spend: sum.spend + Math.max(0, row.spend),
    sales: sum.sales + Math.max(0, row.sales),
    orders: sum.orders + Math.max(0, row.orders),
    clicks: sum.clicks + Math.max(0, row.clicks),
    impressions: sum.impressions + Math.max(0, row.impressions),
  }), { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 });
  const acos = calculateAcos(totals.spend, totals.sales);
  const campaigns = candidates.filter((row) => row.entity_type === 'campaign');
  const terms = candidates.filter((row) => row.entity_type !== 'campaign');
  const highAcos = candidates.filter((row) => row.acos != null && row.acos > settings.maxAcos).length;
  const noSaleSpend = candidates.filter((row) => row.spend > 0 && row.sales <= 0).length;
  const zeroSpend = candidates.filter((row) => row.spend <= 0).length;
  const converters = candidates.filter((row) => row.orders > 0).length;
  return {
    totals: {
      ...totals,
      acos,
      roas: totals.spend > 0 ? totals.sales / totals.spend : 0,
      cpc: totals.clicks > 0 ? totals.spend / totals.clicks : 0,
      cvr_pct: totals.clicks > 0 ? (totals.orders / totals.clicks) * 100 : 0,
    },
    coverage: {
      campaigns: campaigns.length,
      terms: terms.length,
      converters,
      high_acos: highAcos,
      spend_without_sales: noSaleSpend,
      zero_spend: zeroSpend,
    },
    budget: {
      ...budgetPlan,
      cap: settings.dailyBudgetCap,
      utilization_pct: settings.dailyBudgetCap > 0
        ? (budgetPlan.totalBudget / settings.dailyBudgetCap) * 100
        : 0,
    },
  };
}

function summarizeLearning(decisions: any[], executionLogs: any[]) {
  const byStatus: Record<string, number> = {};
  const byAction: Record<string, number> = {};
  for (const row of decisions) {
    const status = String(value(row, 'status', 'unknown'));
    const action = String(value(row, 'action', value(row, 'decision_type', 'unknown')));
    byStatus[status] = (byStatus[status] || 0) + 1;
    byAction[action] = (byAction[action] || 0) + 1;
  }
  return {
    decisions_sample: decisions.length,
    decisions_by_status: byStatus,
    decisions_by_action: byAction,
    recent_failures: executionLogs.filter((row) => ['failed', 'error', 'exhausted'].includes(String(value(row, 'status', '')).toLowerCase()))
      .slice(0, 10)
      .map((row) => ({ operation: value(row, 'operation'), error: value(row, 'error_message') })),
    last_execution: executionLogs[0]
      ? { status: value(executionLogs[0], 'status'), completed_at: value(executionLogs[0], 'completed_at') }
      : null,
  };
}

function metricMap(rows: any[]): Map<string, any> {
  const result = new Map<string, any>();
  for (const row of rows) {
    const id = text(row, 'campaign_id');
    if (!id) continue;
    const current = result.get(id) || { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0, days: 0 };
    current.spend += number(row, 'spend');
    current.sales += number(row, 'sales');
    current.orders += number(row, 'orders') || number(row, 'purchases');
    current.clicks += number(row, 'clicks');
    current.impressions += number(row, 'impressions');
    current.days += 1;
    result.set(id, current);
  }
  return result;
}

function buildCandidates(campaigns: any[], keywords: any[], searchTerms: any[], metrics: any[], economics: any[]): DailyAdsCandidate[] {
  const byCampaign = metricMap(metrics);
  const economicsByAsin = new Map(economics.filter((row) => text(row, 'asin')).map((row) => [text(row, 'asin'), row]));
  const campaignsById = new Map<string, DailyAdsCandidate>();

  for (const row of campaigns) {
    const id = text(row, 'campaign_id') || text(row, 'amazon_campaign_id') || text(row, 'id');
    if (!id || campaignsById.has(id)) continue;
    const aggregated = byCampaign.get(id) || {};
    const spend = number(row, 'spend') || aggregated.spend || 0;
    const sales = number(row, 'sales') || aggregated.sales || 0;
    const asin = text(row, 'asin');
    const economicsRow = economicsByAsin.get(asin);
    campaignsById.set(id, {
      entity_id: id,
      entity_type: 'campaign',
      campaign_id: id,
      asin,
      sku: text(row, 'sku'),
      state: text(row, 'state') || text(row, 'status'),
      spend,
      sales,
      orders: number(row, 'orders') || aggregated.orders || 0,
      clicks: number(row, 'clicks') || aggregated.clicks || 0,
      impressions: number(row, 'impressions') || aggregated.impressions || 0,
      acos: number(row, 'acos') || calculateAcos(spend, sales),
      daily_budget: number(row, 'daily_budget') || number(row, 'budget'),
      // Preserve zero: an out-of-stock campaign must not receive a budget or bid proposal.
      stock: optionalNumber(row, 'stock') ?? optionalNumber(row, 'available_quantity'),
      safe_max_cpc: number(row, 'safe_max_cpc') || number(economicsRow, 'safe_max_cpc'),
      target_acos: number(economicsRow, 'target_acos'),
      margin_rate: optionalNumber(economicsRow, 'margin_rate') ?? optionalNumber(economicsRow, 'margin_percent'),
      profit_after_ads: optionalNumber(economicsRow, 'profit_after_ads'),
      evidence_days: aggregated.days || 0,
    });
  }

  const candidates: DailyAdsCandidate[] = [...campaignsById.values()];
  for (const row of keywords) {
    const campaignId = text(row, 'campaign_id');
    if (!campaignId || !campaignsById.has(campaignId)) continue;
    const spend = number(row, 'spend');
    const sales = number(row, 'sales');
    const keywordId = text(row, 'keyword_id') || text(row, 'id');
    if (!keywordId) continue;
    candidates.push({
      entity_id: keywordId,
      entity_type: 'keyword',
      campaign_id: campaignId,
      keyword_id: keywordId,
      asin: text(row, 'asin') || campaignsById.get(campaignId)?.asin,
      sku: text(row, 'sku') || campaignsById.get(campaignId)?.sku,
      term: text(row, 'keyword_text') || text(row, 'keyword'),
      state: text(row, 'state') || text(row, 'status'),
      spend, sales, orders: number(row, 'orders'), clicks: number(row, 'clicks'),
      impressions: number(row, 'impressions'), acos: number(row, 'acos') || calculateAcos(spend, sales),
      current_bid: number(row, 'current_bid') || number(row, 'bid'),
      evidence_days: number(row, 'evidence_days') || number(row, 'days') || number(row, 'window_days'),
      stock: campaignsById.get(campaignId)?.stock,
      safe_max_cpc: campaignsById.get(campaignId)?.safe_max_cpc,
      target_acos: campaignsById.get(campaignId)?.target_acos,
      margin_rate: campaignsById.get(campaignId)?.margin_rate,
      profit_after_ads: campaignsById.get(campaignId)?.profit_after_ads,
    });
  }

  for (const row of searchTerms) {
    const campaignId = text(row, 'campaign_id');
    const term = text(row, 'search_term') || text(row, 'search_term_original') || text(row, 'raw_term');
    if (!campaignId || !term || !campaignsById.has(campaignId)) continue;
    const spend = number(row, 'spend');
    const sales = number(row, 'sales_14d') || number(row, 'sales_7d') || number(row, 'total_sales');
    const id = text(row, 'keyword_id') || `${campaignId}:${term.toLowerCase()}`;
    candidates.push({
      entity_id: id,
      entity_type: 'search_term',
      campaign_id: campaignId,
      keyword_id: text(row, 'keyword_id'),
      asin: text(row, 'advertised_asin') || campaignsById.get(campaignId)?.asin,
      sku: text(row, 'advertised_sku') || campaignsById.get(campaignId)?.sku,
      term,
      state: 'enabled',
      spend, sales,
      orders: number(row, 'orders_14d') || number(row, 'orders_7d') || number(row, 'total_orders'),
      clicks: number(row, 'clicks'),
      impressions: number(row, 'impressions'),
      acos: number(row, 'acos_14d') || calculateAcos(spend, sales),
      current_bid: number(row, 'recommended_bid'),
      evidence_days: number(row, 'evidence_days') || number(row, 'days') || number(row, 'window_days'),
      stock: campaignsById.get(campaignId)?.stock,
      safe_max_cpc: number(row, 'maximum_profitable_cpc') || campaignsById.get(campaignId)?.safe_max_cpc,
      target_acos: campaignsById.get(campaignId)?.target_acos,
      margin_rate: campaignsById.get(campaignId)?.margin_rate,
      profit_after_ads: campaignsById.get(campaignId)?.profit_after_ads,
    });
  }
  return candidates;
}

async function callOpenAi(apiKey: string, model: string, evidence: any): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Você é o analista econômico de Amazon Ads. Responda somente JSON válido.' },
          { role: 'user', content: JSON.stringify({
            objective: 'propor alterações econômicas com baixo risco',
            rules: [
              'verifique todos os indicadores recebidos: gasto, vendas, pedidos, impressões, cliques, CTR, CPC, CVR, ACoS, ROAS, orçamento, participação do budget, estoque, margem, lucro pós-Ads, idade e qualidade da evidência',
              'analise todos os active_sku_coverage e active_sku_campaigns: todo SKU ativo com estoque deve ter cobertura AUTO; campanha ativa sem entrega deve ser diagnosticada antes de alterar bid; campanha ligada a produto inativo deve permanecer pausada e fora da gestão econômica',
              'compare campanha, keyword e search term; compare também com o próprio histórico, com o SKU e com campanhas equivalentes',
              'reduza bids de termos com gasto sem venda, ACoS acima do máximo, CPC acima do econômico ou prejuízo, sempre respeitando o bid mínimo e o teto econômico',
              'nunca reduza bid apenas por comparar ontem com hoje; para redução, exija evidência de pelo menos dois dias',
              'impulsione vencedores somente com conversões, ACoS dentro da meta, estoque e margem positiva, respeitando o passo máximo configurado',
              'não aumente o orçamento total diário; redistribuição deve ser neutra e considerar a participação e o desempenho de cada campanha',
              'campanha sem gasto deve receber aumento somente se houver impressões, estoque, elegibilidade e oportunidade mensurável; caso contrário propor investigação',
              'crie campanha manual apenas para termo vencedor com conversão do mesmo SKU; use a API Amazon e nunca invente IDs',
              'termos irrelevantes, caros ou sem venda podem ser negative_keyword somente com evidência suficiente e correspondência segura',
              'não pausar campanhas econômicas por falta de venda; o ciclo determinístico já pausa campanhas de produto inativo e só reativa produto ativo com histórico de venda',
              'métricas são somente leitura; altere apenas bid, budget dentro do teto, keyword/negative keyword e campanha pelos IDs fornecidos',
              'nunca altere a política de risco; no máximo 5 campanhas novas por dia, sem criação em massa e com budget máximo de R$20 por campanha',
            ],
            output_schema: { recommendations: [{ entity_id: 'string', action: 'update_bid|negative_keyword|update_budget|create_manual_campaign|pause_campaign', proposed_value: 'number', confidence: '0..1', rationale: 'string', evidence: ['string'], last_resort: 'boolean' }] },
            evidence,
          }) },
        ],
      }),
    });
    if (!response.ok) throw new Error(`OPENAI_HTTP_${response.status}`);
    const payload = await response.json();
    return safeJson(payload?.choices?.[0]?.message?.content);
  } finally {
    clearTimeout(timeout);
  }
}

async function persistProposal(base44: any, accountId: string, candidate: DailyAdsCandidate, recommendation: AiAdsRecommendation, autoApprove: boolean, date: string): Promise<any> {
  const action = ['increase_bid', 'reduce_bid'].includes(recommendation.action) ? 'update_bid' : recommendation.action;
  const record = {
    [ACCOUNT_ID]: accountId,
    entity_id: candidate.entity_id,
    entity_type: candidate.entity_type,
    campaign_id: candidate.campaign_id,
    keyword_id: candidate.keyword_id,
    keyword_text: candidate.term,
    asin: candidate.asin,
    sku: candidate.sku,
    action,
    decision_type: action,
    status: autoApprove ? 'approved' : 'pending_approval',
    approval_status: autoApprove ? 'auto_approved_low_risk' : 'pending_manual_review',
    requires_approval: !autoApprove,
    execution_mode: autoApprove ? 'EXECUTE_NOW' : 'MANUAL_REVIEW',
    current_value: candidate.current_bid ?? candidate.daily_budget ?? null,
    value_before: candidate.current_bid ?? candidate.daily_budget ?? null,
    proposed_value: recommendation.proposed_value ?? null,
    value_after: recommendation.proposed_value ?? null,
    confidence: normalizeConfidence(recommendation.confidence),
    rationale: recommendation.rationale || 'Recomendação da análise diária de IA.',
    evidence: JSON.stringify(recommendation.evidence || []).slice(0, 2000),
    rule_key: 'daily_ai_ads_analysis',
    source_function: 'runDailyAiAdsAnalysis',
    priority_class: action === 'update_bid' ? 'P1' : 'P2',
    conflict_group: `daily-ai:${candidate.entity_id}:${action}`,
    requires_fresh_data: true,
    maximum_data_age_minutes: 36 * 60,
    data_window_end: date,
    created_at: nowIso(),
  };
  const existing = await base44.asServiceRole.entities.OptimizationDecision.filter({
    amazon_account_id: accountId,
    entity_id: candidate.entity_id,
    rule_key: 'daily_ai_ads_analysis',
    data_window_end: date,
  }, '-created_at', 1).catch(() => []);
  if (existing.length) return { id: existing[0].id, duplicate: true, status: existing[0].status };
  const created = await base44.asServiceRole.entities.OptimizationDecision.create(record);
  return { id: created?.id || null, duplicate: false, status: record.status };
}

Deno.serve(async (request) => {
  const startedAt = nowIso();
  const startedMs = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: String(body.amazon_account_id) }, undefined, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon conectada' }, { status: 400 });
    const accountId = String(account.id);
    const date = todayBrt();

    const prior = await base44.asServiceRole.entities.SyncExecutionLog.filter({
      [ACCOUNT_ID]: accountId, operation: 'daily_ai_ads_analysis', execution_date: date, status: 'success',
    }, '-started_at', 1).catch(() => []);
    if (prior.length && body.force !== true) return Response.json({ ok: true, skipped: true, reason: 'already_completed_today', date });

    const precheck = await runAmazonAdsTokenPrecheck(base44, accountId, 'runDailyAiAdsAnalysis');
    if (!precheck.ok) return Response.json({ ok: false, error: precheck.error, token_precheck: precheck.details }, { status: precheck.httpStatus });

    // A análise diária só pode propor mudanças com os relatórios fechados e a
    // sincronização intradiária atualizados. Se a atualização falhar, não cria
    // decisões com evidência antiga.
    const reportSyncRaw = await base44.asServiceRole.functions.invoke('ensureDailyReportsCurrent', {
      [ACCOUNT_ID]: accountId,
      _service_role: true,
      trigger_type: 'daily_ai_ads_analysis',
      daily_close: true,
    }).catch((error: any) => ({ ok: false, error: error?.response?.data?.error || error?.message || String(error) }));
    const reportSync = reportSyncRaw?.data || reportSyncRaw || {};
    if (reportSync.ok === false) {
      return Response.json({ ok: false, error: 'RELATORIOS_NAO_ATUALIZADOS', report_sync: reportSync }, { status: 503 });
    }

    // Ciclo único de cobertura dos SKUs ativos. O orquestrador pode já ter
    // executado esta etapa; o log diário evita chamadas duplicadas quando a IA
    // é disparada manualmente ou por retry.
    const lifecycleAlreadyRun = await base44.asServiceRole.entities.SyncExecutionLog.filter({
      [ACCOUNT_ID]: accountId,
      operation: 'daily_active_sku_ads_lifecycle',
      execution_date: date,
      status: 'success',
    }, '-started_at', 1).catch(() => []);
    const lifecycle = lifecycleAlreadyRun.length
      ? { ok: true, skipped: true, reason: 'already_completed_today' }
      : await base44.asServiceRole.functions.invoke('reconcileDailyActiveSkuAds', {
          _service_role: true,
          [ACCOUNT_ID]: accountId,
          pause_inactive: true,
          dry_run: false,
          trigger_type: 'daily_ai_ads_analysis',
        }).then((result: any) => result?.data || result || {})
        .catch((error: any) => ({ ok: false, error: error?.response?.data?.error || error?.message || String(error) }));

    // Leitura faseada: evita seis consultas grandes simultâneas no PostgreSQL.
    const settingsRows = await base44.asServiceRole.entities.PerformanceSettings
      .filter({ [ACCOUNT_ID]: accountId }, '-updated_at', 1).catch(() => []);
    const products = await pagedFilter(base44, base44.asServiceRole.entities.Product,
      { [ACCOUNT_ID]: accountId }, '-updated_at', MAX_ROWS);
    const campaigns = await pagedFilter(base44, base44.asServiceRole.entities.Campaign,
      { [ACCOUNT_ID]: accountId }, '-updated_at', MAX_ROWS);
    const keywords = await pagedFilter(base44, base44.asServiceRole.entities.Keyword,
      { [ACCOUNT_ID]: accountId }, '-updated_at', MAX_ROWS);
    const searchTerms = await pagedFilter(base44, base44.asServiceRole.entities.SearchTerm,
      { [ACCOUNT_ID]: accountId }, '-updated_at', MAX_ROWS);
    const metrics = await pagedFilter(base44, base44.asServiceRole.entities.CampaignMetricsDaily,
      { [ACCOUNT_ID]: accountId }, '-date', MAX_ROWS);
    const economics = await pagedFilter(base44, base44.asServiceRole.entities.ProductEconomics,
      { [ACCOUNT_ID]: accountId }, '-updated_at', 1000);
    const recentDecisions = await base44.asServiceRole.entities.OptimizationDecision.filter(
      { [ACCOUNT_ID]: accountId, rule_key: 'daily_ai_ads_analysis' }, '-created_at', 100,
    ).catch(() => []);
    const recentExecutionLogs = await base44.asServiceRole.entities.SyncExecutionLog.filter(
      { [ACCOUNT_ID]: accountId, operation: 'daily_ai_ads_analysis' }, '-started_at', 20,
    ).catch(() => []);
    const recentBidDecisions = await base44.asServiceRole.entities.OptimizationDecision.filter(
      { [ACCOUNT_ID]: accountId }, '-created_at', 250,
    ).catch(() => []);
    const settings = mapSettings(settingsRows[0] || {});
    const rawCandidates = buildCandidates(campaigns, keywords, searchTerms, metrics, economics);
    const activeSkuCoverage = campaignCoverage(products, campaigns);
    const activeAsins = new Set(activeSkuCoverage.filter((row) => row.active_sellable).map((row) => row.asin));
    const analysisCandidates = rawCandidates.filter((row) => !row.asin || activeAsins.has(row.asin));
    const allCampaigns = analysisCandidates.filter((row) => {
      const state = String(row.state || '').toLowerCase();
      return row.entity_type === 'campaign'
        && !['archived', 'paused', 'inactive'].includes(state)
        && row.stock !== 0;
    });
    const candidates = buildDailyAdsCandidates(analysisCandidates, settings);
    const budgetPlan = rebalanceBudgetPlan(allCampaigns, settings);
    const metricSummary = summarizeMetrics(analysisCandidates, budgetPlan, settings);
    const learning = summarizeLearning(recentDecisions, recentExecutionLogs);
    const activeSkuCampaigns = analysisCandidates
      .filter((row) => row.entity_type === 'campaign')
      .filter((row) => row.asin && activeSkuCoverage.some((sku) => sku.asin === row.asin && sku.active_sellable))
      .map((row) => ({
        entity_id: row.entity_id,
        campaign_id: row.campaign_id,
        asin: row.asin,
        sku: row.sku,
        state: row.state,
        spend: row.spend,
        sales: row.sales,
        orders: row.orders,
        clicks: row.clicks,
        impressions: row.impressions,
        acos: row.acos,
        daily_budget: row.daily_budget,
        stock: row.stock,
        evidence_days: row.evidence_days,
      }));
    const evidence = {
      date,
      generated_at: startedAt,
      settings,
      risk_policy: AUTONOMOUS_ADS_RISK_POLICY,
      lifecycle,
      active_sku_coverage: activeSkuCoverage,
      active_sku_campaigns: activeSkuCampaigns,
      inactive_entities_excluded_from_ai: rawCandidates.length - analysisCandidates.length,
      budget_plan: budgetPlan,
      metric_summary: metricSummary,
      learning,
      candidates: candidates.slice(0, 100),
    };

    const apiKey = Deno.env.get('OPENAI_API_KEY') || '';
    if (!apiKey) return Response.json({ ok: false, error: 'OPENAI_API_KEY ausente', ai_unavailable: true }, { status: 503 });
    const model = Deno.env.get('OPENAI_MODEL') || String(body.model || 'gpt-4o-mini');
    const ai = await callOpenAi(apiKey, model, evidence);
    const recommendations = Array.isArray(ai?.recommendations) ? ai.recommendations : [];
    const byEntity = new Map(candidates.map((candidate) => [candidate.entity_id, candidate]));
    const seen = new Set<string>();
    const persisted: any[] = [];
    const rejected: any[] = [];
    let plannedBudgetIncrease = 0;
    let newCampaignsProposed = recentDecisions.filter((row: any) =>
      String(value(row, 'action', value(row, 'decision_type', ''))) === 'create_manual_campaign'
      && Date.now() - new Date(String(value(row, 'created_at', 0))).getTime() <= 24 * 3600000,
    ).length;
    const recentBidEntities = new Set(recentBidDecisions.filter((row: any) => {
      const action = String(value(row, 'action', value(row, 'decision_type', ''))).toLowerCase();
      const createdAt = new Date(String(value(row, 'created_at', 0))).getTime();
      return action.includes('bid') && Date.now() - createdAt <= 24 * 3600000 &&
        !['cancelled', 'failed', 'blocked', 'skipped'].includes(String(value(row, 'status', '')).toLowerCase());
    }).map((row: any) => String(value(row, 'entity_id', ''))).filter(Boolean));

    for (const recommendation of recommendations.slice(0, settings.maxProposals * 2)) {
      const candidate = byEntity.get(String(recommendation?.entity_id || ''));
      const checked = validateRecommendation(recommendation, candidate, settings);
      if (!checked.valid || !checked.normalized || !candidate) {
        rejected.push({ entity_id: recommendation?.entity_id, reason: checked.reason });
        continue;
      }
      const dedupe = `${candidate.entity_id}:${checked.normalized.action}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      if (['increase_bid', 'reduce_bid', 'update_bid'].includes(checked.normalized.action)
        && recentBidEntities.has(candidate.entity_id)) {
        rejected.push({ entity_id: candidate.entity_id, reason: 'BID_CHANGE_ALREADY_APPLIED_IN_24H' });
        continue;
      }
      if (['increase_bid', 'update_bid'].includes(checked.normalized.action)
        && metricSummary.totals.spend >= settings.dailyBudgetCap) {
        rejected.push({ entity_id: candidate.entity_id, reason: 'ACCOUNT_SPEND_CAP_REACHED' });
        continue;
      }
      if (checked.normalized.action === 'create_manual_campaign') {
        if (newCampaignsProposed >= AUTONOMOUS_ADS_RISK_POLICY.maxNewCampaignsPerDay) {
          rejected.push({ entity_id: candidate.entity_id, reason: 'NEW_CAMPAIGN_DAILY_LIMIT_REACHED' });
          continue;
        }
        newCampaignsProposed += 1;
      }
      if (['increase_budget', 'update_budget'].includes(checked.normalized.action)) {
        const current = Number(candidate.daily_budget || 0);
        const proposed = Number(checked.normalized.proposed_value || 0);
        const delta = Math.max(0, proposed - current);
        if (budgetPlan.totalBudget + plannedBudgetIncrease + delta > settings.dailyBudgetCap) {
          rejected.push({ entity_id: candidate.entity_id, reason: 'DAILY_BUDGET_CAP_REACHED' });
          continue;
        }
        plannedBudgetIncrease += delta;
      }
      const outcome = await persistProposal(base44, accountId, candidate, checked.normalized, checked.autoApprove, date);
      persisted.push({ ...outcome, entity_id: candidate.entity_id, action: checked.normalized.action, auto_approved: checked.autoApprove });
      if (persisted.length >= settings.maxProposals) break;
    }

    const autoDecisionIds = persisted
      .filter((item) => item.auto_approved && item.id && !item.duplicate)
      .map((item) => item.id);
    const executionBatches: any[] = [];
    for (let offset = 0; offset < autoDecisionIds.length; offset += EXECUTION_BATCH_SIZE) {
      const decisionIds = autoDecisionIds.slice(offset, offset + EXECUTION_BATCH_SIZE);
      const result = await base44.asServiceRole.functions.invoke('executeAutopilotDecisionV2', {
        _service_role: true,
        [ACCOUNT_ID]: accountId,
        decision_ids: decisionIds,
        trigger_type: 'daily_ai_ads_analysis_executor',
      }).then((response: any) => response?.data || response || {})
        .catch((error: any) => ({ ok: false, error: error?.response?.data?.error || error?.message || String(error) }));
      executionBatches.push({ count: decisionIds.length, result });
      if (offset + EXECUTION_BATCH_SIZE < autoDecisionIds.length) await sleep(EXECUTION_PAUSE_MS);
    }
    const execution = {
      ok: executionBatches.every((batch) => batch.result?.ok !== false),
      batches: executionBatches.length,
      decisions: autoDecisionIds.length,
      results: executionBatches,
    };
    const confirmation = execution?.ok === false
      ? { ok: false, skipped: true, reason: 'execution_failed' }
      : await base44.asServiceRole.functions.invoke('confirmExecutedDecisions', {
          _service_role: true,
          [ACCOUNT_ID]: accountId,
          trigger_type: 'daily_ai_ads_analysis_confirmation',
        }).then((result: any) => result?.data || result || {})
          .catch((error: any) => ({ ok: false, error: error?.response?.data?.error || error?.message || String(error) }));

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      [ACCOUNT_ID]: accountId,
      operation: 'daily_ai_ads_analysis',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: 'success',
      execution_date: date,
      started_at: startedAt,
      completed_at: nowIso(),
      duration_ms: Date.now() - startedMs,
      records_processed: persisted.length,
      result_summary: JSON.stringify({ model, report_sync: reportSync, candidates: candidates.length, recommendations: recommendations.length, persisted: persisted.length, rejected: rejected.length, execution, confirmation, budget_plan: budgetPlan }).slice(0, 4000),
    }).catch(() => {});

    return Response.json({
      ok: true,
      date,
      model,
      report_sync: reportSync,
      lifecycle,
      active_sku_coverage: activeSkuCoverage,
      metric_summary: metricSummary,
      learning,
      candidates_evaluated: candidates.length,
      recommendations_received: recommendations.length,
      proposals_persisted: persisted.length,
      auto_approved_low_risk: persisted.filter((item) => item.auto_approved).length,
      manual_review: persisted.filter((item) => !item.auto_approved).length,
      rejected: rejected.slice(0, 30),
      budget_plan: budgetPlan,
      execution,
      confirmation,
      policy: {
        mode: 'AUTONOMOUS_SUPERVISOR',
        confidence_minimum: settings.aiConfidenceThreshold,
        human_approval_for_eligible: false,
        max_new_campaigns_per_day: AUTONOMOUS_ADS_RISK_POLICY.maxNewCampaignsPerDay,
        max_new_campaign_budget: AUTONOMOUS_ADS_RISK_POLICY.maxNewCampaignBudget,
        daily_once: true,
        scheduled_brt: '10:00',
        pause_only_last_resort: true,
        total_budget_increase: false,
        same_sku_conversion_required_for_manual_campaign: true,
        execution_owner: 'executeApprovedDecisionQueue',
        reduction_requires_multi_day_evidence: true,
      },
      proposals: persisted,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha na análise diária de IA' }, { status: 500 });
  }
});
