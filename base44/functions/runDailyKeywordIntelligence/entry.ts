/**
 * Supervisão diária de inteligência de keywords.
 *
 * Este módulo coordena as rotinas existentes; não duplica chamadas Ads nem
 * substitui o motor determinístico. Cada fase é idempotente e os limites de
 * execução continuam no backend/política canônica.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { AUTONOMOUS_ADS_RISK_POLICY } from '../../shared/dailyAiAdsPolicy.ts';

const MIN_CONFIDENCE = AUTONOMOUS_ADS_RISK_POLICY.minCalibratedConfidence;
const MIN_NEGATIVE_CLICKS = 20;
const MIN_NEGATIVE_DAYS = 7;
const MAX_NEGATIVES_PER_RUN = 10;
const MAX_PROMOTIONS_PER_RUN = 10;

function n(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function s(row: any, ...keys: string[]): string {
  for (const key of keys) {
    const value = row?.[key] ?? row?.data?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function isAuto(campaign: any): boolean {
  const type = s(campaign, 'targeting_type', 'amazon_targeting_type').toUpperCase();
  const name = s(campaign, 'name', 'campaign_name').toUpperCase();
  return type.includes('AUTO') || /^AUTO\s*\|/.test(name) || /\|\s*AUTO\s*\|/.test(name);
}

function ageDays(rows: any[]): number {
  const dates = rows.map((row) => s(row, 'date', 'report_date', 'created_at')).filter(Boolean)
    .map((date) => Date.parse(date)).filter(Number.isFinite);
  if (!dates.length) return 0;
  return Math.max(0, (Date.now() - Math.min(...dates)) / 86400000);
}

export type NegativeCandidate = {
  asin: string;
  sku: string;
  keyword_text: string;
  source_campaign_id: string;
  clicks: number;
  spend: number;
  orders: number;
  age_days: number;
};

/**
 * Negative exact só é elegível depois de evidência suficiente. A função é
 * exportada para manter a regra testável sem chamar a Amazon.
 */
export function selectNegativeCandidates(
  searchTerms: any[],
  campaigns: any[],
  products: any[],
): NegativeCandidate[] {
  const autoIds = new Set(campaigns.filter(isAuto).map((row) =>
    s(row, 'campaign_id', 'amazon_campaign_id', 'id')).filter(Boolean));
  const productsByAsin = new Map(products.map((row) => [s(row, 'asin').toUpperCase(), row]));
  const grouped = new Map<string, any[]>();
  for (const row of searchTerms) {
    const campaignId = s(row, 'campaign_id', 'source_campaign_id');
    const term = s(row, 'search_term', 'search_term_original', 'keyword_text', 'term').toLowerCase();
    if (!campaignId || !autoIds.has(campaignId) || !term) continue;
    const key = `${campaignId}|${term}`;
    grouped.set(key, [...(grouped.get(key) || []), row]);
  }

  const result: NegativeCandidate[] = [];
  for (const rows of grouped.values()) {
    const first = rows[0];
    const asin = s(first, 'advertised_asin', 'asin').toUpperCase();
    const product = productsByAsin.get(asin);
    const clicks = rows.reduce((sum, row) => sum + n(row.clicks), 0);
    const spend = rows.reduce((sum, row) => sum + n(row.spend), 0);
    const orders = rows.reduce((sum, row) => sum + n(row.orders_14d || row.orders_7d || row.orders), 0);
    const margin = n(product?.margin_rate || product?.margin_percent);
    const candidate = {
      asin,
      sku: s(first, 'advertised_sku', 'sku') || s(product, 'sku'),
      keyword_text: s(first, 'search_term', 'search_term_original', 'keyword_text', 'term'),
      source_campaign_id: s(first, 'campaign_id', 'source_campaign_id'),
      clicks,
      spend,
      orders,
      age_days: ageDays(rows),
    };
    // Sem venda, >=20 cliques, >=7 dias e margem conhecida: evita
    // negativar termos novos ou sem contexto econômico suficiente.
    if (candidate.asin && candidate.sku && clicks >= MIN_NEGATIVE_CLICKS &&
      orders === 0 && spend > 0 && candidate.age_days >= MIN_NEGATIVE_DAYS && margin > 0) {
      result.push(candidate);
    }
  }
  return result.sort((a, b) => b.spend - a.spend).slice(0, MAX_NEGATIVES_PER_RUN);
}

async function invoke(base44: any, functionName: string, payload: any): Promise<any> {
  try {
    const response = await base44.asServiceRole.functions.invoke(functionName, payload);
    return response?.data || response || {};
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

Deno.serve(async (request) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }
    const accountId = String(body.amazon_account_id || '');
    if (!accountId) return Response.json({ ok: false, error: 'amazon_account_id é obrigatório' }, { status: 400 });
    const common = { amazon_account_id: accountId, _service_role: true };
    const phases: any[] = [];

    // Fase 1/2: sinais econômicos, cauda e calibração determinística.
    for (const functionName of ['buildKeywordLearningSignals', 'runKeywordMLPipeline', 'mineSearchTermOpportunities']) {
      phases.push({ phase: functionName, result: await invoke(base44, functionName, common) });
    }

    phases.push({ phase: 'runDailyAiAdsAnalysis', result: await invoke(base44,
      'runDailyAiAdsAnalysis', { ...common, model: body.model || undefined }) });

    // Fase 3: promoção same-SKU, com teto diário e estoque fresco.
    phases.push({ phase: 'runImmediateSameSkuSearchTermHarvest', result: await invoke(base44,
      'runImmediateSameSkuSearchTermHarvest', { ...common, max_promotions: MAX_PROMOTIONS_PER_RUN, require_fresh_inventory: true }) });
    phases.push({ phase: 'promoteWinningSearchTerms', result: await invoke(base44,
      'promoteWinningSearchTerms', { ...common, max_promotions: MAX_PROMOTIONS_PER_RUN }) });

    // Fase 4: negativação conservadora. A seleção é feita antes da execução e
    // só candidatos com evidência suficiente chegam à rotina que chama a Ads API.
    const [terms, campaigns, products] = await Promise.all([
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: accountId }, '-date', 5000).catch(() => []),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, '-updated_at', 2000).catch(() => []),
    ]);
    const negatives = selectNegativeCandidates(terms, campaigns, products);
    const negativeResults = [];
    for (const candidate of negatives) {
      negativeResults.push(await invoke(base44, 'negateKeywordInAutoCampaign', {
        ...common,
        asin: candidate.asin,
        sku: candidate.sku,
        keyword_text: candidate.keyword_text,
        source_campaign_id: candidate.source_campaign_id,
        triggered_by: 'daily_keyword_intelligence',
      }));
    }
    phases.push({ phase: 'negative_exact', candidates: negatives, results: negativeResults });

    // Fase 5: registrar o ciclo para posterior comparação de vendas, custo,
    // margem, atribuição e sazonalidade sem inventar confiança preditiva.
    const executed = phases.filter((phase) => phase.result?.ok !== false).length;
    const learning = {
      amazon_account_id: accountId,
      event_type: 'daily_keyword_intelligence_cycle',
      entity_type: 'account',
      entity_id: accountId,
      observation: JSON.stringify({
        started_at: startedAt,
        confidence_threshold: MIN_CONFIDENCE,
        phases: phases.map((phase) => phase.phase),
        negative_candidates: negatives.length,
        executed_phases: executed,
        attribution_guard_days: 3,
      }),
      recorded_at: new Date().toISOString(),
    };
    await base44.asServiceRole.entities.LearningEvent.create(learning).catch(() => {});
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'daily_keyword_intelligence',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: 'success',
      execution_date: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()),
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      records_processed: terms.length,
      result_summary: JSON.stringify({ phases: phases.length, negatives: negatives.length, confidence_threshold: MIN_CONFIDENCE }),
    }).catch(() => {});

    return Response.json({ ok: true, cycle: 'daily_keyword_intelligence_v1', confidence_threshold: MIN_CONFIDENCE, phases, negative_candidates: negatives });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});
