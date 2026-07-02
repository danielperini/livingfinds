/**
 * calculateEntityMaturity — Motor de maturidade e confiança do Ads Autopilot.
 * Exporta funções reutilizáveis via base44.functions.invoke.
 *
 * Retorna para cada entidade:
 *  maturity: NEW | LEARNING | MATURE | STALE | INSUFFICIENT_DATA
 *  confidence: 0.0 – 1.0 (pontuação composta)
 *  decision: EXECUTE_NOW | SCHEDULE | WAIT_FOR_DATA | RECOMMEND_APPROVAL | BLOCK | ROLLBACK | NO_ACTION
 *  blockers: string[]
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── Constantes ──────────────────────────────────────────────────────────────
const ATTRIBUTION_SAFETY_HOURS = 72;   // padrão; sobrescrito por config
const MIN_COMPLETE_DATA_DAYS    = 3;

// ── Maturidade ───────────────────────────────────────────────────────────────
export function calculateEntityMaturity(params) {
  const {
    createdAt,       // ISO string ou Date
    lastSyncAt,      // ISO string ou Date — se null → STALE
    impressions = 0,
    clicks = 0,
    spend = 0,
    orders = 0,
    minCompleteDays = MIN_COMPLETE_DATA_DAYS,
  } = params;

  const nowMs = Date.now();
  const created = createdAt ? new Date(createdAt).getTime() : nowMs;
  const ageDays = (nowMs - created) / 86400000;

  // STALE: sem sync recente (> 3 dias sem atualização)
  if (lastSyncAt) {
    const syncAge = (nowMs - new Date(lastSyncAt).getTime()) / 86400000;
    if (syncAge > 3) return 'STALE';
  } else {
    return 'STALE';
  }

  // INSUFFICIENT_DATA: sem nenhum dado ainda
  if (impressions === 0 && clicks === 0 && spend === 0) {
    if (ageDays < minCompleteDays) return 'NEW';
    return 'INSUFFICIENT_DATA';
  }

  // NEW: menos de 3 dias
  if (ageDays < 3) return 'NEW';

  // LEARNING: 3–14 dias
  if (ageDays < 14) return 'LEARNING';

  // MATURE: >= 14 dias com amostra mínima
  const hasMinSample = clicks >= 10 || orders >= 1 || spend >= 5;
  if (hasMinSample) return 'MATURE';

  return 'INSUFFICIENT_DATA';
}

// ── Janela de atribuição ─────────────────────────────────────────────────────
// Retorna a data-limite segura (dados anteriores a isso são confiáveis)
export function getSafeDataCutoff(attributionSafetyHours = ATTRIBUTION_SAFETY_HOURS) {
  const cutoffMs = Date.now() - attributionSafetyHours * 3600000;
  return new Date(cutoffMs).toISOString().slice(0, 10); // YYYY-MM-DD
}

// ── Cooldown ─────────────────────────────────────────────────────────────────
// Retorna true se ainda dentro do cooldown (não pode executar)
export function isInCooldown(lastChangedAt, cooldownHours = 24) {
  if (!lastChangedAt) return false;
  const elapsedHours = (Date.now() - new Date(lastChangedAt).getTime()) / 3600000;
  return elapsedHours < cooldownHours;
}

// ── Verificações de produto ──────────────────────────────────────────────────
export function getProductBlockers(product, cfg = {}) {
  const blockers = [];
  if (!product) return ['product_not_found'];
  if (product.inventory_status === 'out_of_stock') blockers.push('OUT_OF_STOCK');
  if (product.inventory_status === 'low_stock') blockers.push('LOW_STOCK');
  if (product.buy_box_status === 'lost') blockers.push('BUY_BOX_LOST');
  if (product.status === 'inactive' || product.status === 'archived') blockers.push('PRODUCT_INACTIVE');
  if (product.stock_days != null && product.stock_days < (cfg.minimum_stock_days || 7)) blockers.push('LOW_STOCK_DAYS');
  return blockers;
}

// ── Confiança composta ───────────────────────────────────────────────────────
export function calculateDecisionConfidence(params) {
  const {
    clicks = 0,
    orders = 0,
    spend = 0,
    impressions = 0,
    lastSyncAt,
    maturity,            // string
    historicalSuccessRate = 0.5, // 0–1 baseado em histórico de decisões
    attributionSafetyHours = ATTRIBUTION_SAFETY_HOURS,
    product = null,
    daysInWindow = 14,   // janela de dados usada
  } = params;

  // sample_size_score (0–1): escala logarítmica até 50 cliques
  const sampleScore = Math.min(1, Math.log10(Math.max(clicks, 1) + 1) / Math.log10(51));

  // data_freshness_score: quão recente é o último sync
  let freshnessScore = 0;
  if (lastSyncAt) {
    const hoursOld = (Date.now() - new Date(lastSyncAt).getTime()) / 3600000;
    freshnessScore = hoursOld <= 24 ? 1.0 : hoursOld <= 48 ? 0.7 : hoursOld <= 72 ? 0.4 : 0.1;
  }

  // attribution_completeness_score: quanto da janela está fora da segurança
  const safeWindowDays = Math.max(0, daysInWindow - attributionSafetyHours / 24);
  const attributionScore = daysInWindow > 0 ? Math.min(1, safeWindowDays / daysInWindow) : 0;

  // consistency_score: baseado em maturidade
  const consistencyMap = { MATURE: 1.0, LEARNING: 0.6, NEW: 0.2, STALE: 0.0, INSUFFICIENT_DATA: 0.1 };
  const consistencyScore = consistencyMap[maturity] ?? 0.3;

  // historical_success_score
  const histScore = Math.min(1, Math.max(0, historicalSuccessRate));

  // product_health_score
  let productHealth = 0.8; // assume saudável por padrão
  if (product) {
    const blockers = getProductBlockers(product);
    if (blockers.includes('OUT_OF_STOCK')) productHealth = 0;
    else if (blockers.includes('BUY_BOX_LOST')) productHealth = 0.3;
    else if (blockers.includes('LOW_STOCK')) productHealth = 0.5;
  }

  const confidence =
    sampleScore        * 0.25 +
    freshnessScore     * 0.15 +
    attributionScore   * 0.20 +
    consistencyScore   * 0.20 +
    histScore          * 0.10 +
    productHealth      * 0.10;

  return Math.round(confidence * 100) / 100; // 0.00–1.00
}

// ── Decisão macro (EXECUTE_NOW / SCHEDULE / WAIT_FOR_DATA / etc.) ────────────
export function resolveDecisionOutcome(confidence, maturity, blockers = [], autonomyLevel = 2, risk = 'low') {
  // Qualquer bloqueio operacional → BLOCK
  if (blockers.length > 0) return 'BLOCK';

  // STALE → aguardar sync
  if (maturity === 'STALE') return 'WAIT_FOR_DATA';

  // NEW → apenas correções de erro
  if (maturity === 'NEW') return 'BLOCK';

  // Dados insuficientes
  if (confidence < 0.60 || maturity === 'INSUFFICIENT_DATA') return 'WAIT_FOR_DATA';

  // Faixa 0.60–0.74 → aprovação humana
  if (confidence < 0.75) return 'RECOMMEND_APPROVAL';

  // 0.75–0.89: executa baixo risco com autonomia >= 2
  if (confidence < 0.90) {
    if (risk === 'low' && autonomyLevel >= 2) return 'EXECUTE_NOW';
    return 'RECOMMEND_APPROVAL';
  }

  // >= 0.90: executa baixo/médio risco conforme autonomia
  if (risk === 'low' && autonomyLevel >= 1) return 'EXECUTE_NOW';
  if (risk === 'medium' && autonomyLevel >= 3) return 'EXECUTE_NOW';
  return 'RECOMMEND_APPROVAL';
}

// ── Endpoint HTTP ────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Pode ser chamado com um array de entidades ou uma única
    const entities = Array.isArray(body.entities) ? body.entities : [body];
    const cfg = body.config || {};

    const results = entities.map(e => {
      const maturity = calculateEntityMaturity({
        createdAt: e.created_at || e.created_date || e.start_date,
        lastSyncAt: e.synced_at || e.last_sync_at,
        impressions: e.impressions,
        clicks: e.clicks,
        spend: e.spend,
        orders: e.orders,
        minCompleteDays: cfg.minimum_complete_data_days || MIN_COMPLETE_DATA_DAYS,
      });

      const blockers = getProductBlockers(e.product, cfg);
      if (isInCooldown(e.last_bid_change_at, cfg.cooldown_hours || 24)) blockers.push('COOLDOWN_ACTIVE');

      const confidence = calculateDecisionConfidence({
        clicks: e.clicks,
        orders: e.orders,
        spend: e.spend,
        impressions: e.impressions,
        lastSyncAt: e.synced_at || e.last_sync_at,
        maturity,
        attributionSafetyHours: cfg.attribution_safety_hours || ATTRIBUTION_SAFETY_HOURS,
        product: e.product,
        daysInWindow: e.data_window_days || 14,
      });

      const outcome = resolveDecisionOutcome(confidence, maturity, blockers, cfg.autonomy_level || 2, e.risk || 'low');

      return {
        entity_id: e.id || e.keyword_id || e.campaign_id,
        maturity,
        confidence,
        outcome,
        blockers,
        safe_cutoff: getSafeDataCutoff(cfg.attribution_safety_hours || ATTRIBUTION_SAFETY_HOURS),
      };
    });

    return Response.json({ ok: true, results });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});