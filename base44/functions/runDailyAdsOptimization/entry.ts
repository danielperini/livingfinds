/**
 * runDailyAdsOptimization v3 — Motor de Inteligência Decisória do Ads Autopilot
 *
 * A IA não apenas indica uma ação — ela:
 *   1. Responde 20 perguntas de pré-condição antes de decidir
 *   2. Identifica o objetivo da campanha
 *   3. Verifica maturidade e suficiência de dados
 *   4. Compara alternativas e justifica a escolha
 *   5. Seleciona a menor alteração capaz de produzir o resultado
 *   6. Define momento de execução, critério de sucesso e de rollback
 *   7. Impede decisões contraditórias, duplicadas ou prematuras
 *
 * Tipos de resposta: EXECUTE_NOW | RECOMMEND_APPROVAL | SCHEDULE | WAIT_FOR_DATA | BLOCK | NO_ACTION | ROLLBACK
 *
 * Prioridade de variáveis (uma por ciclo por campanha):
 *   1. Estoque/oferta  2. Erros  3. Search term harvest  4. Termos irrelevantes
 *   5. Desperdício     6. Bid    7. Orçamento             8. Placement
 *   9. Dayparting      10. Estratégia de lance
 *
 * Regras financeiras:
 *   - Moeda sempre da conta (BRL/R$), jamais $
 *   - Janela de atribuição: 72h por padrão (dados dentro desta janela = parciais)
 *   - Cooldown: 24h para reduções, 72h para aumentos
 *   - Nunca negativar termo com venda histórica automaticamente
 *   - Nunca executar sem confirmação Amazon API
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITÁRIOS
// ═══════════════════════════════════════════════════════════════════════════════
const DEFAULT_ATTRIBUTION_HOURS = 72;
const DEFAULT_MIN_COMPLETE_DAYS = 3;

function makeKey(...parts) { return parts.filter(Boolean).join('|'); }
function daysAgo(days) { return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10); }
function daysFromNow(days) { return new Date(Date.now() + days * 86400000).toISOString(); }
function hoursFromNow(h) { return new Date(Date.now() + h * 3600000).toISOString(); }

function inCooldown(lastChangedAt, hours) {
  if (!lastChangedAt) return false;
  return (Date.now() - new Date(lastChangedAt).getTime()) < hours * 3600000;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MATURIDADE — NEW | LEARNING | MATURE | STALE | INSUFFICIENT_DATA
// ═══════════════════════════════════════════════════════════════════════════════
function calcMaturity({ createdAt, lastSyncAt, impressions = 0, clicks = 0, spend = 0, minDays = 3 }) {
  if (!lastSyncAt) return 'STALE';
  const syncAgeDays = (Date.now() - new Date(lastSyncAt).getTime()) / 86400000;
  if (syncAgeDays > 3) return 'STALE';
  const ageDays = createdAt ? (Date.now() - new Date(createdAt).getTime()) / 86400000 : 0;
  if (ageDays < minDays) return 'NEW';
  if (impressions === 0 && clicks === 0 && spend === 0) return 'INSUFFICIENT_DATA';
  if (ageDays < 14) return 'LEARNING';
  return (clicks >= 10 || spend >= 5) ? 'MATURE' : 'INSUFFICIENT_DATA';
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIANÇA COMPOSTA (0–1)
// sample×0.25 + freshness×0.15 + attribution×0.20 + consistency×0.20 + historical×0.10 + product_health×0.10
// ═══════════════════════════════════════════════════════════════════════════════
function calcConfidence({ clicks = 0, orders = 0, lastSyncAt, maturity, attrSafetyHours = 72,
  product = null, daysWindow = 14, historicalSuccessRate = 0.5, evalCount = 0 }) {

  // sample_size_score: logarítmica baseada em cliques + pedidos
  const sampleBase = Math.max(clicks, 1);
  const sampleScore = Math.min(1, Math.log10(sampleBase + 1) / Math.log10(51));

  // data_freshness_score
  let freshnessScore = 0;
  if (lastSyncAt) {
    const h = (Date.now() - new Date(lastSyncAt).getTime()) / 3600000;
    freshnessScore = h <= 24 ? 1.0 : h <= 48 ? 0.7 : h <= 72 ? 0.4 : 0.1;
  }

  // attribution_score: quanto da janela de análise está fora do período de atribuição
  const safeWindow = Math.max(0, daysWindow - attrSafetyHours / 24);
  const attributionScore = daysWindow > 0 ? Math.min(1, safeWindow / daysWindow) : 0;

  // consistency_score: baseado em maturidade + histórico de avaliações
  const maturityScores = { MATURE: 1.0, LEARNING: 0.6, NEW: 0.2, STALE: 0, INSUFFICIENT_DATA: 0.1 };
  const consistencyScore = (maturityScores[maturity] ?? 0.3) * (evalCount > 0 ? Math.min(1, 0.8 + evalCount * 0.05) : 0.8);

  // historical_success_rate: passada como parâmetro (de CampaignChangeHistory)
  const historicalScore = Math.max(0, Math.min(1, historicalSuccessRate));

  // product_health_score
  let productHealthScore = 0.8;
  if (product) {
    if (product.inventory_status === 'out_of_stock') productHealthScore = 0;
    else if (product.buy_box_status === 'lost') productHealthScore = 0.2;
    else if (product.inventory_status === 'low_stock') productHealthScore = 0.5;
    else if (product.status === 'inactive' || product.status === 'archived') productHealthScore = 0;
    else productHealthScore = 1.0;
  }

  const confidence = (
    sampleScore    * 0.25 +
    freshnessScore * 0.15 +
    attributionScore * 0.20 +
    consistencyScore * 0.20 +
    historicalScore  * 0.10 +
    productHealthScore * 0.10
  );

  return Math.round(Math.min(0.99, Math.max(0, confidence)) * 100) / 100;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESOLUÇÃO DE OUTCOME
// Regra principal: confidence >= 0.90 → EXECUTE_NOW (qualquer risco, exceto very_high)
//                  confidence < 0.90  → RECOMMEND_APPROVAL (revisão humana)
// Retorna: EXECUTE_NOW | RECOMMEND_APPROVAL | WAIT_FOR_DATA | BLOCK
// ═══════════════════════════════════════════════════════════════════════════════
function resolveOutcome(confidence, maturity, blockers, autonomyLevel, risk, hasCooldown = false) {
  // BLOCK tem prioridade máxima
  if (blockers.length > 0) return 'BLOCK';
  if (maturity === 'STALE' || maturity === 'NEW') return 'BLOCK';

  // WAIT_FOR_DATA — dados insuficientes
  if (confidence < 0.60 || maturity === 'INSUFFICIENT_DATA') return 'WAIT_FOR_DATA';

  // Autopilot desabilitado (nível 0 ou 1) → sempre recomendação
  if (autonomyLevel < 2) return 'RECOMMEND_APPROVAL';

  // Risco muito alto → sempre exige aprovação humana independente de confiança
  if (risk === 'very_high') return 'RECOMMEND_APPROVAL';

  // REGRA CENTRAL: confidence >= 90% → executa automaticamente
  if (confidence >= 0.90) return 'EXECUTE_NOW';

  // confidence < 90% → fica para aprovação humana
  return 'RECOMMEND_APPROVAL';
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOQUEIOS DE PRODUTO
// ═══════════════════════════════════════════════════════════════════════════════
function getProductBlockers(product) {
  if (!product) return ['PRODUCT_NOT_FOUND'];
  const b = [];
  if (product.inventory_status === 'out_of_stock') b.push('OUT_OF_STOCK');
  else if (product.inventory_status === 'low_stock') b.push('LOW_STOCK');
  if (product.buy_box_status === 'lost') b.push('BUY_BOX_LOST');
  if (['inactive', 'archived'].includes(product.status)) b.push('PRODUCT_INACTIVE');
  return b;
}

// ═══════════════════════════════════════════════════════════════════════════════
// OBJETIVO DA CAMPANHA — mapeia targeting_type, nome, e estado para objetivo
// ═══════════════════════════════════════════════════════════════════════════════
function inferCampaignObjective(campaign, cfg) {
  // Prioridade: campo explícito > inferência
  if (campaign.campaign_objective) return campaign.campaign_objective;
  const name = (campaign.name || campaign.campaign_name || '').toUpperCase();
  if (name.includes('DEFENSE') || name.includes('BRAND')) return 'BRAND_DEFENSE';
  if (name.includes('LAUNCH') || name.includes('LANÇAMENTO')) return 'LAUNCH';
  if (name.includes('CLEARANCE') || name.includes('LIQUIDA')) return 'INVENTORY_CLEARANCE';
  if (name.includes('GROWTH') || name.includes('CRESCIMENTO')) return 'GROWTH';
  if (name.includes('PROFIT') || name.includes('LUCRO')) return 'PROFITABILITY';
  const daysRunning = campaign.days_running || 0;
  const launchPhase = campaign.launch_phase;
  if (launchPhase === 'new' || daysRunning < 7) return 'LAUNCH';
  if (launchPhase === 'learning' || daysRunning < 21) return 'DISCOVERY';
  return cfg.objective || 'PROFITABILITY';
}

// ═══════════════════════════════════════════════════════════════════════════════
// ARGUMENTAÇÃO COMPLETA — Seção 17 do spec
// ═══════════════════════════════════════════════════════════════════════════════
function buildFullRationale({
  objective, diagnosis, evidence, action, executeAt, whyThisAction,
  whyNotAlternatives, risk, confidence, expectedResult, evaluationAt,
  successCriteria, rollbackCriteria, sym,
}) {
  return [
    `Objetivo:\n${objective}`,
    `\nDiagnóstico:\n${diagnosis}`,
    `\nEvidências:\n${evidence}`,
    `\nAção recomendada:\n${action}`,
    `\nMomento:\n${executeAt}`,
    `\nPor que essa ação:\n${whyThisAction}`,
    `\nPor que não outra ação:\n${whyNotAlternatives}`,
    `\nRisco:\n${risk}`,
    `\nConfiança:\n${Math.round(confidence * 100)}%`,
    `\nResultado esperado:\n${expectedResult}`,
    `\nAvaliação:\n${evaluationAt}`,
    `\nCritério de sucesso:\n${successCriteria}`,
    `\nCritério de rollback:\n${rollbackCriteria}`,
  ].join('');
}

// ═══════════════════════════════════════════════════════════════════════════════
// HISTÓRICO DE SUCESSO — busca taxa de sucesso de decisões similares anteriores
// ═══════════════════════════════════════════════════════════════════════════════
function calcHistoricalSuccessRate(recentDecisions, campaignId, decisionType) {
  const relevant = recentDecisions.filter(d =>
    d.campaign_id === campaignId &&
    d.decision_type === decisionType &&
    ['executed', 'failed', 'rolled_back'].includes(d.status)
  );
  if (!relevant.length) return 0.5; // neutro se sem histórico
  const positives = relevant.filter(d => d.outcome === 'positive' || d.status === 'executed').length;
  return positives / relevant.length;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICAÇÃO DE ROLLBACK — decisões executadas que passaram da janela de avaliação
// ═══════════════════════════════════════════════════════════════════════════════
function checkRollbackCandidates(recentDecisions) {
  const now = Date.now();
  return recentDecisions.filter(d => {
    if (d.status !== 'executed') return false;
    if (!d.evaluation_due_at) return false;
    if (!d.rollback_payload) return false;
    if (d.outcome === 'positive') return false;
    // Passou da janela de avaliação e tem outcome negativo ou sem dados
    const evalDate = new Date(d.evaluation_due_at).getTime();
    return evalDate < now && (d.outcome === 'negative' || d.outcome === 'neutral');
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════════
Deno.serve(async (req) => {
  const startTime = Date.now();
  const base44 = createClientFromRequest(req);
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  let runRecord = null;
  let amazonAccountId = null;

  try {
    const body = await req.json().catch(() => ({}));
    amazonAccountId = body.amazon_account_id;

    // ── 1. Resolver conta ──────────────────────────────────────────────────
    let account = null;
    if (amazonAccountId) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazonAccountId });
      account = accs[0] || null;
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
      if (account) amazonAccountId = account.id;
    }
    if (!account) return Response.json({ ok: false, message: 'Nenhuma conta Amazon conectada.' });

    const sym  = account.currency_symbol || 'R$';
    const code = account.currency_code   || 'BRL';
    const cc   = account.country_code    || 'BR';

    // ── 2. Verificar locks de execução ────────────────────────────────────
    const activeRuns = await base44.asServiceRole.entities.AutopilotRun.filter(
      { amazon_account_id: amazonAccountId, status: 'running' }, '-started_at', 5
    );
    for (const ar of activeRuns) {
      const ageMin = (Date.now() - new Date(ar.started_at).getTime()) / 60000;
      if (ageMin < 60) return Response.json({ ok: false, skipped: true, reason: 'Autopilot já em execução', age_minutes: Math.round(ageMin) });
      await base44.asServiceRole.entities.AutopilotRun.update(ar.id, {
        status: 'failed', completed_at: now, error_message: `Lock liberado após ${Math.round(ageMin)} min`,
      });
    }

    // Verificar se sync está rodando (dados parciais = decisões inválidas)
    const activeSyncs = await base44.asServiceRole.entities.SyncExecutionLog.filter(
      { amazon_account_id: amazonAccountId, status: 'started', operation: 'full_sync' }, '-started_at', 3
    );
    for (const s of activeSyncs) {
      const ageMin = (Date.now() - new Date(s.started_at).getTime()) / 60000;
      if (ageMin < 30) return Response.json({ ok: false, skipped: true, reason: 'Sync em andamento — dados parciais, aguarde completar', age_minutes: Math.round(ageMin) });
      await base44.asServiceRole.entities.SyncExecutionLog.update(s.id, { status: 'error', completed_at: now, error_message: 'Lock antigo liberado' });
    }

    // ── 3. Carregar configuração ──────────────────────────────────────────
    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: amazonAccountId });
    const cfg = configs[0] || {};
    const autonomyLevel = cfg.autonomy_level ?? 3; // padrão: Autopilot Completo
    if (cfg.enabled === false) return Response.json({ ok: true, skipped: true, reason: 'Autopilot desabilitado' });

    const ATTR_HOURS   = cfg.attribution_safety_hours   || DEFAULT_ATTRIBUTION_HOURS;
    const MIN_DAYS     = cfg.minimum_complete_data_days || DEFAULT_MIN_COMPLETE_DAYS;
    const TARGET_ACOS  = cfg.target_acos  || cfg.acos_target || 25;
    const MAX_ACOS     = cfg.maximum_acos || 40;
    const TARGET_ROAS  = cfg.target_roas  || cfg.roas_target || 4;
    const MIN_BID      = cfg.min_bid      || 0.10;
    const MAX_BID      = cfg.max_bid      || 5.0;
    const MIN_CLICKS   = cfg.min_clicks_for_decision || 8;
    const MIN_SPEND    = cfg.min_spend_for_decision  || 5;
    const MIN_ORDERS   = cfg.min_orders_for_scale    || 2;
    const COOLDOWN_H   = cfg.cooldown_hours          || 24;
    const COOLDOWN_INC = cfg.cooldown_increase_hours || 72;
    const MAX_INC_PCT  = (cfg.max_bid_increase_pct   || 15) / 100;
    const MAX_DEC_PCT  = (cfg.max_bid_decrease_pct   || 20) / 100;
    const MAX_BUD_INC  = (cfg.max_budget_increase_pct || 20) / 100;
    const MAX_BUD_DEC  = (cfg.max_budget_decrease_pct || 20) / 100;
    const AUTO_APPLY   = cfg.auto_apply_low_risk !== false;
    const safeCutoff   = daysAgo(Math.ceil(ATTR_HOURS / 24));

    // ── 4. Criar registro do run ──────────────────────────────────────────
    runRecord = await base44.asServiceRole.entities.AutopilotRun.create({
      amazon_account_id: amazonAccountId,
      status: 'running',
      trigger: body.trigger || 'scheduled',
      started_at: now,
    });

    // ── 5. Carregar dados com paginação real ──────────────────────────────
    async function loadAllCampaigns() {
      const all = []; let offset = 0; const PAGE = 200;
      while (true) {
        const page = await base44.asServiceRole.entities.Campaign.filter(
          { amazon_account_id: amazonAccountId }, '-created_date', PAGE, offset
        );
        all.push(...page);
        if (page.length < PAGE) break;
        offset += PAGE;
      }
      // Considera ativa: state enabled/paused, OU (state archived mas status enabled — inconsistência de sync)
      return all.filter(c => {
        if (c.archived === true) return false;
        const st = (c.state || '').toLowerCase();
        const su = (c.status || '').toLowerCase();
        if (st === 'archived' && su !== 'enabled') return false; // arquivada de verdade
        return true; // enabled, paused, ou state-archived com status-enabled (inconsistente mas ativa)
      });
    }

    const [campaigns, keywords, products, searchTerms, recentDecisions] = await Promise.all([
      loadAllCampaigns(),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: amazonAccountId }, '-spend', 500),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: amazonAccountId }, null, 300),
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: amazonAccountId }, '-orders_14d', 800),
      base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: amazonAccountId }, '-created_at', 300),
    ]);

    const productMap  = new Map(products.map(p  => [p.asin, p]));
    const campaignMap = new Map(campaigns.map(c => [c.campaign_id, c]));

    // Índice idempotência
    const existingKeys = new Set(recentDecisions.filter(d => d.idempotency_key).map(d => d.idempotency_key));

    // Controle de uma variável por campanha por ciclo
    const campaignChangedThisCycle = new Map(); // campaign_id → tipo alterado

    // Keywords manuais exact já existentes (para evitar duplicatas no harvest)
    const manualExactIndex = new Set(
      keywords
        .filter(k => k.match_type === 'exact' && k.source === 'manual' && k.state !== 'archived')
        .map(k => `${k.campaign_id}|${(k.keyword_text || '').toLowerCase().trim()}`)
    );

    const decisionsToCreate = [];
    const blocked = [];
    const rollbackCandidates = [];
    const waitForData = [];
    const stats = {
      harvest: 0, harvest_blocked: 0,
      bid_decrease: 0, bid_increase: 0,
      budget_decrease: 0, budget_increase: 0,
      pause_campaign: 0, negative: 0,
      wait_for_data: 0, skipped_dup: 0,
      skipped_cooldown: 0, rollback: 0, no_action: 0,
    };

    // ── 6. Verificar candidatos a ROLLBACK ───────────────────────────────
    const rollbacks = checkRollbackCandidates(recentDecisions);
    for (const rd of rollbacks) {
      const iKey = makeKey(amazonAccountId, 'rollback', rd.id, today);
      if (existingKeys.has(iKey)) continue;
      let payload = {};
      try { payload = JSON.parse(rd.rollback_payload || '{}'); } catch {}
      if (!payload.action || !payload.value) continue;

      decisionsToCreate.push({
        amazon_account_id: amazonAccountId,
        decision_type: rd.decision_type,
        entity_type: rd.entity_type,
        entity_id: rd.entity_id,
        campaign_id: rd.campaign_id,
        keyword_id: rd.keyword_id,
        keyword_text: rd.keyword_text,
        asin: rd.asin,
        action: payload.action,
        value_before: rd.value_after,
        value_after: payload.value,
        rationale: buildFullRationale({
          objective: 'Reverter alteração anterior com resultado negativo ou neutro.',
          diagnosis: `Decisão ${rd.id} (${rd.decision_type} / ${rd.action}) foi avaliada com resultado "${rd.outcome}" após janela de ${(rd.evaluation_due_at ? Math.round((Date.now() - new Date(rd.evaluation_due_at).getTime()) / 86400000) : '?')} dias.`,
          evidence: `Métricas antes: ${rd.metrics_before || 'n/d'}. Métricas após: ${rd.metrics_after || 'n/d'}.`,
          action: `Reverter ${rd.action} de ${sym}${rd.value_after} para ${sym}${payload.value}.`,
          executeAt: 'Imediatamente (dentro da janela segura de reversão).',
          whyThisAction: 'O resultado da alteração foi negativo ou neutro. A reversão restaura o estado anterior sem risco adicional.',
          whyNotAlternatives: 'Manter a alteração aumentaria o risco financeiro sem evidência de melhoria futura.',
          risk: 'low',
          confidence: 0.85,
          expectedResult: 'Restaurar performance ao nível anterior.',
          evaluationAt: 'Em 7 dias.',
          successCriteria: 'Métricas retornam ao nível pré-alteração.',
          rollbackCriteria: 'N/A — este é o próprio rollback.',
          sym,
        }),
        risk: 'low',
        requires_approval: false,
        status: autonomyLevel >= 2 ? 'approved' : 'pending',
        confidence: 85,
        objective: rd.objective || 'maintenance',
        country_code: cc, currency_code: code, currency_symbol: sym,
        idempotency_key: iKey,
        source_function: 'runDailyAdsOptimization',
        evaluation_due_at: daysFromNow(7),
        rollback_status: 'rollback_triggered',
        created_at: now,
      });
      stats.rollback++;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // BLOCO A — PRIORIDADE 1: Estoque zero → pausar campanhas imediatamente
    // ═══════════════════════════════════════════════════════════════════════
    if (cfg.auto_pause_zero_stock !== false) {
      for (const c of campaigns) {
        if (c.state !== 'enabled' && c.status !== 'enabled') continue;
        const product = c.asin ? productMap.get(c.asin) : null;
        if (!product || product.inventory_status !== 'out_of_stock') continue;

        const iKey = makeKey(amazonAccountId, 'pause', c.campaign_id, 'pause_zero_stock', today);
        if (existingKeys.has(iKey)) { stats.skipped_dup++; continue; }

        const rationale = buildFullRationale({
          objective: 'Evitar gasto de orçamento sem capacidade de entregar pedidos.',
          diagnosis: `Campanha "${c.name || c.campaign_name}" está ativa, mas o produto ${c.asin} tem estoque zero no FBA.`,
          evidence: `inventory_status = out_of_stock. FBA inventory = ${product.fba_inventory || 0} unidades.`,
          action: 'Pausar campanha imediatamente.',
          executeAt: 'Agora (prioridade máxima — não respeita cooldown).',
          whyThisAction: 'Manter anúncios ativos sem estoque gera cliques pagos que não podem converter em vendas, desperdiçando orçamento.',
          whyNotAlternatives: 'Reduzir bid não resolve: o problema é ausência de produto, não de eficiência de lance. Reduzir budget também não: a exposição manteria gasto desnecessário.',
          risk: 'Baixo. A pausa é reversível quando o estoque retornar.',
          confidence: 0.98,
          expectedResult: 'Eliminar gasto sem conversão durante período sem estoque.',
          evaluationAt: 'Automático: reativação quando inventory_status retornar a in_stock (verificação horária).',
          successCriteria: 'Campanha reativada automaticamente com estoque disponível.',
          rollbackCriteria: 'N/A — reativação é o próprio rollback, executado quando estoque retornar.',
          sym,
        });

        decisionsToCreate.push({
          amazon_account_id: amazonAccountId,
          decision_type: 'pause',
          entity_type: 'campaign',
          entity_id: c.campaign_id,
          campaign_id: c.campaign_id,
          asin: c.asin,
          action: 'pause_campaign',
          rationale,
          data_used: JSON.stringify({ inventory_status: 'out_of_stock', asin: c.asin, fba_inventory: product.fba_inventory || 0 }),
          risk: 'low',
          requires_approval: autonomyLevel < 2,
          status: autonomyLevel >= 2 ? 'approved' : 'pending',
          confidence: 98,
          objective: 'maintenance',
          country_code: cc, currency_code: code, currency_symbol: sym,
          idempotency_key: iKey,
          source_function: 'runDailyAdsOptimization',
          evaluation_due_at: null,
          rollback_payload: JSON.stringify({ action: 'enable_campaign', campaign_id: c.campaign_id }),
          created_at: now,
        });
        campaignChangedThisCycle.set(c.campaign_id, 'pause');
        stats.pause_campaign++;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // BLOCO B — PRIORIDADE 3: Search Term Harvest (dados fora da janela de atribuição)
    // ═══════════════════════════════════════════════════════════════════════
    if (cfg.search_term_optimization_enabled !== false && cfg.harvest_enabled !== false) {
      // Deduplicar por (term, asin) mantendo o registro mais rico
      const stMap = new Map();
      for (const st of searchTerms) {
        if (st.date && st.date >= safeCutoff) continue; // dados dentro da janela = parciais
        const term = (st.search_term || st.keyword_text || '').toLowerCase().trim();
        if (!term || !st.advertised_asin) continue;
        const key = `${term}|${st.advertised_asin}`;
        const existing = stMap.get(key);
        if (!existing || (st.orders_14d || 0) > (existing.orders_14d || 0)) stMap.set(key, st);
      }

      for (const st of stMap.values()) {
        const term      = (st.search_term || st.keyword_text || '').toLowerCase().trim();
        const orders14  = st.orders_14d || 0;
        const sales14   = st.sales_14d  || 0;
        const acos14    = st.acos_14d   || 0;
        const clicks    = st.clicks     || 0;
        const spend     = st.spend      || 0;
        const cpc       = st.cpc        || 0;
        const product   = productMap.get(st.advertised_asin);
        const campaign  = campaignMap.get(st.campaign_id);
        const objective = campaign ? inferCampaignObjective(campaign, cfg) : 'PROFITABILITY';

        // ── B1. HARVEST: primeira venda confirmada fora da janela de atribuição ──
        if (orders14 >= 1 && sales14 > 0 && !st.promoted_to_manual && st.relevance_status !== 'irrelevant') {
          const productBlockers = getProductBlockers(product);

          if (productBlockers.includes('OUT_OF_STOCK') || productBlockers.includes('PRODUCT_INACTIVE')) {
            stats.harvest_blocked++;
            blocked.push({ term, reason: productBlockers.join(','), type: 'harvest_blocked' });
            continue;
          }

          if (manualExactIndex.has(`${st.campaign_id}|${term}`)) { stats.skipped_dup++; continue; }

          const iKey = makeKey(amazonAccountId, 'harvest_search_term', st.id, 'create_keyword', today);
          if (existingKeys.has(iKey)) { stats.skipped_dup++; continue; }

          const suggestedBid = cpc > 0
            ? Math.min(Math.max(cpc * 1.10, MIN_BID, 0.30), MAX_BID)
            : Math.max(MIN_BID, 0.30);

          const confidence = Math.min(0.95, 0.65 + (orders14 * 0.08));
          const outcome = resolveOutcome(confidence, 'MATURE', [], autonomyLevel, 'low');

          const rationale = buildFullRationale({
            objective: `${objective}: capturar tráfego qualificado via keyword manual exact.`,
            diagnosis: `O termo de pesquisa "${term}" gerou ${orders14} pedido(s) com ${sym}${sales14.toFixed(2)} em vendas (dados anteriores à janela de ${ATTR_HOURS}h de atribuição). O termo ainda não foi promovido a keyword manual.`,
            evidence: `orders_14d=${orders14}, sales_14d=${sym}${sales14.toFixed(2)}, acos_14d=${acos14.toFixed(1)}%, cpc=${sym}${cpc.toFixed(2)}, safe_cutoff=${safeCutoff}`,
            action: `Criar keyword exact "${term}" com bid inicial de ${sym}${suggestedBid.toFixed(2)}.`,
            executeAt: 'Início do próximo dia (após aprovação automática de baixo risco).',
            whyThisAction: 'O termo já demonstrou intenção de compra confirmada. Criar em correspondência exata permite controlar bid, orçamento e performance de forma isolada, sem competir com outros termos na campanha automática.',
            whyNotAlternatives: `Não aumentar o bid do grupo: afetaria todos os termos, não apenas este. Não aguardar mais vendas: uma venda confirmada fora da janela de atribuição é evidência suficiente.`,
            risk: 'Baixo. A keyword pode ser pausada ou arquivada se não performar após 14 dias.',
            confidence,
            expectedResult: `Capturar tráfego do termo "${term}" de forma controlada, mantendo ACoS < ${TARGET_ACOS}%.`,
            evaluationAt: 'Em 3 dias (delivery) e 7 dias (performance).',
            successCriteria: `Keyword com ACoS < ${TARGET_ACOS}% após 14 dias.`,
            rollbackCriteria: `Pausar se ACoS > ${MAX_ACOS}% com mais de ${MIN_CLICKS} cliques após 14 dias, ou se não houver impressões após 7 dias.`,
            sym,
          });

          decisionsToCreate.push({
            amazon_account_id: amazonAccountId,
            decision_type: 'harvest_search_term',
            entity_type: 'search_term',
            entity_id: st.id,
            campaign_id: st.campaign_id,
            ad_group_id: st.ad_group_id,
            asin: st.advertised_asin,
            keyword_text: term,
            action: 'create_keyword',
            value_before: null,
            value_after: Number(suggestedBid.toFixed(2)),
            rationale,
            data_used: JSON.stringify({ orders_14d: orders14, sales_14d: sales14, acos_14d: acos14, cpc, bid_suggested: suggestedBid, safe_cutoff: safeCutoff }),
            risk: 'low',
            requires_approval: autonomyLevel < 2,
            status: outcome === 'EXECUTE_NOW' ? 'approved' : 'pending',
            confidence: Math.round(confidence * 100),
            objective: objective.toLowerCase(),
            reversible: true,
            country_code: cc, currency_code: code, currency_symbol: sym,
            idempotency_key: iKey,
            source_search_term_id: st.id,
            source_campaign_id: st.campaign_id,
            source_function: 'runDailyAdsOptimization',
            evaluation_due_at: daysFromNow(3),
            review_date: daysFromNow(7),
            period_analyzed: `até ${safeCutoff}`,
            expected_impact: `Capturar tráfego do termo "${term}" via keyword exact manual.`,
            success_criteria: `ACoS < ${TARGET_ACOS}% após 14 dias.`,
            rollback_payload: JSON.stringify({ action: 'pause_keyword', keyword_text: term }),
            created_at: now,
          });

          await base44.asServiceRole.entities.SearchTerm.update(st.id, {
            classification: 'FIRST_SALE',
            first_sale_at: st.first_sale_at || now,
            last_evaluated_at: now,
            evaluation_count: (st.evaluation_count || 0) + 1,
          });
          stats.harvest++;
        }

        // ── B2. Termo com venda e ACoS alto → reduzir bid via fórmula ──
        else if (orders14 >= 1 && acos14 > TARGET_ACOS && cpc > 0) {
          await base44.asServiceRole.entities.SearchTerm.update(st.id, { classification: 'HIGH_ACOS', last_evaluated_at: now });
        }

        // ── B3. WINNER ──
        else if (orders14 >= MIN_ORDERS && acos14 > 0 && acos14 <= TARGET_ACOS) {
          await base44.asServiceRole.entities.SearchTerm.update(st.id, { classification: 'WINNER', last_evaluated_at: now });
        }

        // ── B4. WASTING: sem venda, com gasto significativo ──
        else if (orders14 === 0 && clicks >= MIN_CLICKS && spend >= MIN_SPEND && st.relevance_status !== 'relevant') {
          const evalCount = st.evaluation_count || 0;
          const hasHistoricalSales = (st.sales_30d || st.sales_14d || st.sales_7d || 0) > 0;

          if (evalCount >= 2) {
            if (hasHistoricalSales) {
              // Termo com venda histórica: exige aprovação humana
              const iKey = makeKey(amazonAccountId, 'negative_keyword', st.id, 'negative_recommend', today);
              if (!existingKeys.has(iKey)) {
                decisionsToCreate.push({
                  amazon_account_id: amazonAccountId,
                  decision_type: 'negative_keyword',
                  entity_type: 'search_term',
                  entity_id: st.id,
                  campaign_id: st.campaign_id,
                  keyword_text: term,
                  action: 'negative_exact',
                  rationale: buildFullRationale({
                    objective: 'Reduzir gasto em termo sem conversões recentes.',
                    diagnosis: `"${term}" acumulou ${clicks} cliques e ${sym}${spend.toFixed(2)} sem pedidos nos últimos 14 dias, mas possui venda histórica.`,
                    evidence: `clicks=${clicks}, spend=${sym}${spend.toFixed(2)}, orders_14d=0, avaliações=${evalCount}, venda_histórica=sim`,
                    action: 'Negativação EXACT (requer aprovação humana obrigatória).',
                    executeAt: 'Somente após aprovação manual.',
                    whyThisAction: 'O termo demonstra ineficiência recente, mas o histórico de vendas impede negativação automática.',
                    whyNotAlternatives: 'Negativar automaticamente seria irreversível e poderia eliminar um termo sazonalmente valioso.',
                    risk: 'Alto — requer análise humana do contexto sazonal.',
                    confidence: 0.55,
                    expectedResult: 'Reduzir desperdício de orçamento se aprovada.',
                    evaluationAt: 'Imediato após aprovação.',
                    successCriteria: 'Redução de spend sem queda de vendas.',
                    rollbackCriteria: 'Remover negativa se vendas caírem após negativação.',
                    sym,
                  }),
                  data_used: JSON.stringify({ clicks, spend, orders_14d: 0, evaluations: evalCount, has_historical_sales: true }),
                  risk: 'high',
                  requires_approval: true,
                  status: 'pending',
                  confidence: 55,
                  country_code: cc, currency_code: code, currency_symbol: sym,
                  idempotency_key: iKey,
                  source_function: 'runDailyAdsOptimization',
                  created_at: now,
                });
                stats.negative++;
              }
            } else {
              // Sem nenhuma venda jamais → negativar com risco médio após 2+ avaliações
              const iKey = makeKey(amazonAccountId, 'negative_keyword', st.id, 'negative_exact', today);
              if (!existingKeys.has(iKey)) {
                const confidence = Math.min(0.88, 0.60 + evalCount * 0.08);
                decisionsToCreate.push({
                  amazon_account_id: amazonAccountId,
                  decision_type: 'negative_keyword',
                  entity_type: 'search_term',
                  entity_id: st.id,
                  campaign_id: st.campaign_id,
                  keyword_text: term,
                  action: 'negative_exact',
                  rationale: buildFullRationale({
                    objective: 'Eliminar gasto em termo irrelevante confirmado.',
                    diagnosis: `"${term}" acumulou ${clicks} cliques e ${sym}${spend.toFixed(2)} em ${evalCount} avaliações sem nenhuma conversão. Nenhuma venda histórica registrada.`,
                    evidence: `clicks=${clicks}, spend=${sym}${spend.toFixed(2)}, orders_14d=0, avaliações=${evalCount}, venda_histórica=não`,
                    action: 'Criar negative exact para este termo.',
                    executeAt: 'Início do próximo dia.',
                    whyThisAction: 'O termo não possui relação comercial com o produto. Após múltiplas avaliações, a ausência de conversão é confirmada. A negativação elimina gasto sem risco de perda de vendas.',
                    whyNotAlternatives: 'Reduzir bid manteria o gasto, apenas menor. Pausar keyword pai afetaria outros termos. A negativa exact é cirúrgica.',
                    risk: 'Médio — sempre requer aprovação (ação irreversível sem confirmação).',
                    confidence,
                    expectedResult: `Eliminar ${sym}${(spend / Math.max(evalCount, 1)).toFixed(2)}/período de gasto sem retorno.`,
                    evaluationAt: 'Em 14 dias (verificar se outras keywords do grupo não foram afetadas).',
                    successCriteria: 'Redução de spend sem queda nas vendas do ad group.',
                    rollbackCriteria: 'Remover negativa se vendas do produto caírem mais de 20% após 14 dias.',
                    sym,
                  }),
                  data_used: JSON.stringify({ clicks, spend, orders_14d: 0, evaluations: evalCount }),
                  risk: 'medium',
                  requires_approval: true,
                  status: 'pending',
                  confidence: Math.round(confidence * 100),
                  country_code: cc, currency_code: code, currency_symbol: sym,
                  idempotency_key: iKey,
                  source_function: 'runDailyAdsOptimization',
                  evaluation_due_at: daysFromNow(14),
                  created_at: now,
                });
                stats.negative++;
              }
            }
          }

          await base44.asServiceRole.entities.SearchTerm.update(st.id, {
            classification: 'WASTING',
            evaluation_count: (st.evaluation_count || 0) + 1,
            last_evaluated_at: now,
          });
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // BLOCO C — PRIORIDADE 6: Análise de Bids de Keywords
    // ═══════════════════════════════════════════════════════════════════════
    if (cfg.bid_optimization_enabled !== false) {
      for (const kw of keywords) {
        const state = kw.state || kw.status;
        if (state === 'archived') continue;

        const currentBid  = kw.current_bid || kw.bid || 0.25;
        const acos        = kw.acos     || 0;
        const clicks      = kw.clicks   || 0;
        const spend       = kw.spend    || 0;
        const sales       = kw.sales    || 0;
        const orders      = kw.orders   || 0;
        const impressions = kw.impressions || 0;
        const convRate    = clicks > 0 ? orders / clicks : 0;
        const evalCount   = kw.evaluation_count || 0;

        const product  = kw.asin ? productMap.get(kw.asin) : null;
        const campaign = campaignMap.get(kw.campaign_id);
        const objective = campaign ? inferCampaignObjective(campaign, cfg) : 'PROFITABILITY';

        // Pré-condição 1: produto elegível
        const productBlockerList = getProductBlockers(product);

        // Pré-condição 2: maturidade
        // Usar account.last_sync_at como referência de freshness no calcMaturity também,
        // evitando que keywords com synced_at antigo (>3d) sejam marcadas como STALE
        // quando a conta foi sincronizada recentemente.
        const maturity = calcMaturity({
          createdAt: kw.first_seen_at || new Date(Date.now() - 60 * 86400000).toISOString(),
          lastSyncAt: account.last_sync_at || kw.synced_at,
          impressions, clicks, spend,
          minDays: MIN_DAYS,
        });

        // Pré-condição 3: histórico de sucesso para este tipo de decisão
        const histRate = calcHistoricalSuccessRate(recentDecisions, kw.campaign_id, 'bid_change');

        // Pré-condição 4: confiança composta
        // Usar account.last_sync_at como referência de freshness — é a data do último sync real da conta,
        // independente de quando o registro da keyword foi atualizado no banco.
        const confidence = calcConfidence({
          clicks, orders,
          lastSyncAt: account.last_sync_at || kw.synced_at,
          maturity, attrSafetyHours: ATTR_HOURS,
          product: kw.asin ? product : null,
          daysWindow: 14,
          historicalSuccessRate: histRate, evalCount,
        });

        // Pré-condição 5: cooldowns
        const lastChange = kw.last_bid_change_at || null;
        const inDecCooldown = inCooldown(lastChange, COOLDOWN_H);
        const inIncCooldown = inCooldown(lastChange, COOLDOWN_INC);

        // Pré-condição 6: campanha já alterada neste ciclo
        const campAlreadyChanged = campaignChangedThisCycle.has(kw.campaign_id);

        // ── C0. BUY BOX AUSENTE → BLOCK (não aumentar bid) ──────────────
        if (productBlockerList.includes('BUY_BOX_LOST')) {
          blocked.push({ entity: kw.keyword_id, reason: 'BUY_BOX_LOST', text: kw.keyword_text, campaign_id: kw.campaign_id });
          stats.wait_for_data++;
          continue;
        }

        // ── C1. Keyword sem impressões ───────────────────────────────────
        if (impressions === 0 && state === 'enabled' && maturity !== 'NEW' && !productBlockerList.includes('OUT_OF_STOCK')) {
          const bidChangeCount = kw.bid_change_count_30d || 0;
          if (bidChangeCount >= 2) {
            blocked.push({ entity: kw.keyword_id, reason: 'NO_IMPRESSIONS_MAX_ATTEMPTS', text: kw.keyword_text });
            stats.wait_for_data++;
            continue;
          }
          if (inIncCooldown) { stats.skipped_cooldown++; continue; }

          const newBid = Math.min(currentBid * 1.07, MAX_BID);
          const iKey = makeKey(amazonAccountId, 'bid_change', kw.keyword_id, 'no_impressions_boost', today);
          if (!existingKeys.has(iKey)) {
            decisionsToCreate.push({
              amazon_account_id: amazonAccountId,
              decision_type: 'bid_change', entity_type: 'keyword',
              entity_id: kw.keyword_id, campaign_id: kw.campaign_id, ad_group_id: kw.ad_group_id,
              keyword_id: kw.keyword_id, keyword_text: kw.keyword_text || kw.keyword, asin: kw.asin,
              action: 'increase_bid',
              value_before: currentBid, value_after: Number(newBid.toFixed(2)),
              change_pct: Number(((newBid / currentBid - 1) * 100).toFixed(1)),
              rationale: buildFullRationale({
                objective: `${objective}: obter delivery mínimo para avaliação.`,
                diagnosis: `Keyword "${kw.keyword_text}" (${maturity}) está ativa há mais de ${MIN_DAYS} dias sem impressões. Tentativa ${bidChangeCount + 1}/2 de ajuste.`,
                evidence: `impressions=0, bid_atual=${sym}${currentBid.toFixed(2)}, bid_change_count=${bidChangeCount}, maturity=${maturity}`,
                action: `Aumentar bid +7%: de ${sym}${currentBid.toFixed(2)} para ${sym}${newBid.toFixed(2)}.`,
                executeAt: 'Início do próximo dia.',
                whyThisAction: 'Sem impressões, não há dados para avaliar. O bid pode estar abaixo do mínimo competitivo do leilão. Um aumento controlado é necessário para obter delivery e iniciar o aprendizado.',
                whyNotAlternatives: 'Aumentar mais de 10% seria prematuro sem dados de performance. Pausar a keyword eliminaria a oportunidade de descoberta.',
                risk: 'Baixo. O aumento é de apenas 7% com limite de 2 tentativas.',
                confidence,
                expectedResult: 'Obter impressões e cliques para iniciar análise de performance.',
                evaluationAt: 'Em 3 dias.',
                successCriteria: 'Pelo menos 10 impressões após 3 dias.',
                rollbackCriteria: `Pausar após 2ª tentativa sem impressões. Reverter se ACoS > ${MAX_ACOS}% após primeiros cliques.`,
                sym,
              }),
              data_used: JSON.stringify({ impressions: 0, bid_change_count: bidChangeCount, maturity, confidence }),
              risk: 'low', requires_approval: false,
              status: autonomyLevel >= 2 && AUTO_APPLY ? 'approved' : 'pending',
              confidence: Math.round(confidence * 100),
              objective: objective.toLowerCase(),
              country_code: cc, currency_code: code, currency_symbol: sym,
              idempotency_key: iKey, source_function: 'runDailyAdsOptimization',
              evaluation_due_at: daysFromNow(3),
              rollback_payload: JSON.stringify({ action: 'update_bid', value: currentBid }),
              created_at: now,
            });
            stats.bid_increase++;
          } else { stats.skipped_dup++; }
          continue;
        }

        // ── C2. Bloqueadores impedem qualquer otimização de bid ───────────
        // PRODUCT_NOT_FOUND (sem asin) não bloqueia — keyword ainda pode ser otimizada
        if (productBlockerList.includes('OUT_OF_STOCK') || productBlockerList.includes('PRODUCT_INACTIVE')) continue;

        // ── C3. Dados insuficientes ───────────────────────────────────────
        if (['STALE', 'NEW', 'INSUFFICIENT_DATA'].includes(maturity)) {
          waitForData.push({ entity: kw.keyword_id, reason: maturity, text: kw.keyword_text });
          stats.wait_for_data++;
          continue;
        }

        if (confidence < 0.60) {
          waitForData.push({ entity: kw.keyword_id, reason: `confidence=${confidence}`, text: kw.keyword_text });
          stats.wait_for_data++;
          continue;
        }

        if (campAlreadyChanged) continue; // uma variável por ciclo

        // ── C4. WASTING: zero vendas com dados maduros ───────────────────
        if (orders === 0 && clicks >= MIN_CLICKS && spend >= MIN_SPEND && maturity === 'MATURE') {
          if (inDecCooldown) { stats.skipped_cooldown++; continue; }

          const reducePct = evalCount >= 2 ? Math.min(MAX_DEC_PCT, 0.20) : Math.min(MAX_DEC_PCT, 0.15);
          const newBid = Math.max(currentBid * (1 - reducePct), MIN_BID);
          if (newBid < currentBid - 0.005) {
            const riskLevel = evalCount >= 2 && spend >= MIN_SPEND * 3 ? 'medium' : 'low';
            const iKey = makeKey(amazonAccountId, 'bid_change', kw.keyword_id, 'reduce_wasting', today);
            if (!existingKeys.has(iKey)) {
              const outcome = resolveOutcome(confidence, maturity, [], autonomyLevel, riskLevel, false);
              decisionsToCreate.push({
                amazon_account_id: amazonAccountId,
                decision_type: 'bid_change', entity_type: 'keyword',
                entity_id: kw.keyword_id, campaign_id: kw.campaign_id, ad_group_id: kw.ad_group_id,
                keyword_id: kw.keyword_id, keyword_text: kw.keyword_text || kw.keyword, asin: kw.asin,
                action: 'reduce_bid',
                value_before: currentBid, value_after: Number(newBid.toFixed(2)),
                change_pct: Number(((newBid / currentBid - 1) * 100).toFixed(1)),
                rationale: buildFullRationale({
                  objective: `${objective}: reduzir desperdício mantendo a keyword ativa para aprendizado.`,
                  diagnosis: `"${kw.keyword_text}" acumulou ${clicks} cliques e ${sym}${spend.toFixed(2)} sem nenhum pedido. Avaliação ${evalCount + 1}. Dados anteriores à janela de ${ATTR_HOURS}h de atribuição.`,
                  evidence: `clicks=${clicks}, spend=${sym}${spend.toFixed(2)}, orders=0, maturity=${maturity}, confidence=${Math.round(confidence * 100)}%`,
                  action: `Reduzir bid ${Math.round(reducePct * 100)}%: de ${sym}${currentBid.toFixed(2)} para ${sym}${newBid.toFixed(2)}.`,
                  executeAt: 'Início do próximo dia.',
                  whyThisAction: 'A redução é preferível à pausa porque preserva a possibilidade de conversão a custo menor. A keyword pode ter relevância em pesquisas de menor concorrência.',
                  whyNotAlternatives: 'Negativar neste estágio seria prematuro — pode haver conversões sazonais. Pausar elimina dados futuros. Manter bid atual aumenta o desperdício.',
                  risk: riskLevel === 'medium' ? 'Médio (gasto acumulado elevado).' : 'Baixo.',
                  confidence,
                  expectedResult: 'Manter impressões e cliques a custo reduzido, possibilitando avaliação futura.',
                  evaluationAt: 'Em 7 dias.',
                  successCriteria: 'ACoS abaixo de 60% após a redução, ou primeiros pedidos surgindo.',
                  rollbackCriteria: `Reverter se impressões caírem > 80% (indicando bid abaixo do mínimo competitivo).`,
                  sym,
                }),
                data_used: JSON.stringify({ clicks, spend, orders: 0, evaluations: evalCount, maturity, confidence }),
                risk: riskLevel,
                requires_approval: riskLevel !== 'low' || autonomyLevel < 2,
                status: outcome === 'EXECUTE_NOW' ? 'approved' : 'pending',
                confidence: Math.round(confidence * 100),
                objective: objective.toLowerCase(),
                country_code: cc, currency_code: code, currency_symbol: sym,
                idempotency_key: iKey, source_function: 'runDailyAdsOptimization',
                evaluation_due_at: daysFromNow(7),
                period_analyzed: `até ${safeCutoff}`,
                rollback_payload: JSON.stringify({ action: 'update_bid', value: currentBid }),
                created_at: now,
              });
              campaignChangedThisCycle.set(kw.campaign_id, 'bid');
              stats.bid_decrease++;
            } else { stats.skipped_dup++; }
          }
        }

        // ── C5. HIGH ACoS: venda presente mas ACoS acima da meta ─────────
        else if (acos > TARGET_ACOS && orders >= 1 && clicks >= 5 && maturity !== 'LEARNING') {
          if (inDecCooldown) { stats.skipped_cooldown++; continue; }

          // Fórmula: novo_bid = bid_atual × target_acos ÷ acos_atual
          const proposedBid = currentBid * (TARGET_ACOS / acos);
          const maxAllowedReduction = currentBid * (1 - MAX_DEC_PCT);
          const minReduction = currentBid * 0.95; // redução mínima de 5%
          const newBid = Math.max(Math.min(proposedBid, minReduction), maxAllowedReduction, MIN_BID);
          const changePct = (newBid / currentBid - 1) * 100;

          if (changePct < -5 && newBid < currentBid - 0.005) {
            const iKey = makeKey(amazonAccountId, 'bid_change', kw.keyword_id, 'reduce_high_acos', today);
            if (!existingKeys.has(iKey)) {
              const outcome = resolveOutcome(confidence, maturity, [], autonomyLevel, 'medium', false);
              decisionsToCreate.push({
                amazon_account_id: amazonAccountId,
                decision_type: 'bid_change', entity_type: 'keyword',
                entity_id: kw.keyword_id, campaign_id: kw.campaign_id, ad_group_id: kw.ad_group_id,
                keyword_id: kw.keyword_id, keyword_text: kw.keyword_text || kw.keyword, asin: kw.asin,
                action: 'reduce_bid',
                value_before: currentBid, value_after: Number(newBid.toFixed(2)),
                change_pct: Number(changePct.toFixed(1)),
                rationale: buildFullRationale({
                  objective: `${objective}: aproximar ACoS da meta de ${TARGET_ACOS}% sem eliminar conversões.`,
                  diagnosis: `"${kw.keyword_text}" possui ACoS de ${acos.toFixed(1)}% com ${orders} pedidos. ACoS está ${(acos - TARGET_ACOS).toFixed(1)}pp acima da meta. Fórmula: bid × (target ÷ actual) = ${sym}${currentBid.toFixed(2)} × (${TARGET_ACOS} ÷ ${acos.toFixed(1)}) = ${sym}${proposedBid.toFixed(2)}.`,
                  evidence: `acos=${acos.toFixed(1)}%, target_acos=${TARGET_ACOS}%, clicks=${clicks}, orders=${orders}, spend=${sym}${spend.toFixed(2)}, sales=${sym}${sales.toFixed(2)}`,
                  action: `Reduzir bid de ${sym}${currentBid.toFixed(2)} para ${sym}${newBid.toFixed(2)} (${changePct.toFixed(1)}%).`,
                  executeAt: 'Início do próximo dia.',
                  whyThisAction: 'A keyword converte — não deve ser pausada. A redução proporcional ao ACoS busca aproximar o custo da meta sem eliminar o volume de conversões.',
                  whyNotAlternatives: 'Pausar eliminaria conversões existentes. Negativar seria inadequado (há vendas). Reduzir orçamento da campanha afetaria todas as keywords.',
                  risk: 'Médio — pode reduzir impressões e cliques se o bid ficar abaixo do leilão.',
                  confidence,
                  expectedResult: `ACoS próximo de ${TARGET_ACOS}% após 7 dias.`,
                  evaluationAt: 'Em 7 dias.',
                  successCriteria: `ACoS entre ${TARGET_ACOS * 0.9}% e ${TARGET_ACOS * 1.1}% após 7 dias.`,
                  rollbackCriteria: `Reverter se pedidos caírem > 50% ou impressões caírem > 70% após 7 dias.`,
                  sym,
                }),
                data_used: JSON.stringify({ acos, target_acos: TARGET_ACOS, clicks, orders, spend: spend.toFixed(2), maturity, confidence, proposed_bid: proposedBid.toFixed(2) }),
                risk: 'medium',
                requires_approval: autonomyLevel < 3,
                status: outcome === 'EXECUTE_NOW' ? 'approved' : 'pending',
                confidence: Math.round(confidence * 100),
                objective: objective.toLowerCase(),
                country_code: cc, currency_code: code, currency_symbol: sym,
                idempotency_key: iKey, source_function: 'runDailyAdsOptimization',
                evaluation_due_at: daysFromNow(7),
                period_analyzed: `até ${safeCutoff}`,
                rollback_payload: JSON.stringify({ action: 'update_bid', value: currentBid }),
                created_at: now,
              });
              campaignChangedThisCycle.set(kw.campaign_id, 'bid');
              stats.bid_decrease++;
            } else { stats.skipped_dup++; }
          }
        }

        // ── C6. WINNER: ACoS dentro da meta, escalar ─────────────────────
        else if (orders >= MIN_ORDERS && acos > 0 && acos <= TARGET_ACOS && clicks >= 10 && maturity === 'MATURE') {
          if (productBlockerList.includes('LOW_STOCK')) {
            blocked.push({ entity: kw.keyword_id, reason: 'LOW_STOCK_BLOCKS_INCREASE', text: kw.keyword_text });
            continue;
          }
          if (inIncCooldown) { stats.skipped_cooldown++; continue; }

          const isStrongWinner = orders >= 3 && acos <= TARGET_ACOS * 0.70;
          const increasePct = isStrongWinner ? Math.min(MAX_INC_PCT, 0.10) : Math.min(MAX_INC_PCT * 0.5, 0.05);
          const newBid = Math.min(currentBid * (1 + increasePct), MAX_BID);

          if (newBid > currentBid + 0.005) {
            const riskLevel = isStrongWinner ? 'medium' : 'low';
            const iKey = makeKey(amazonAccountId, 'bid_change', kw.keyword_id, 'increase_winner', today);
            if (!existingKeys.has(iKey)) {
              const outcome = resolveOutcome(confidence, maturity, [], autonomyLevel, riskLevel, false);
              decisionsToCreate.push({
                amazon_account_id: amazonAccountId,
                decision_type: 'bid_change', entity_type: 'keyword',
                entity_id: kw.keyword_id, campaign_id: kw.campaign_id, ad_group_id: kw.ad_group_id,
                keyword_id: kw.keyword_id, keyword_text: kw.keyword_text || kw.keyword, asin: kw.asin,
                action: 'increase_bid',
                value_before: currentBid, value_after: Number(newBid.toFixed(2)),
                change_pct: Number(((newBid / currentBid - 1) * 100).toFixed(1)),
                rationale: buildFullRationale({
                  objective: `${objective}: escalar keyword vencedora com rentabilidade comprovada.`,
                  diagnosis: `"${kw.keyword_text}" é ${isStrongWinner ? 'VENCEDORA FORTE' : 'WINNER'}: ACoS de ${acos.toFixed(1)}% está ${(TARGET_ACOS - acos).toFixed(1)}pp abaixo da meta com ${orders} pedidos e ${clicks} cliques.`,
                  evidence: `acos=${acos.toFixed(1)}%, target=${TARGET_ACOS}%, orders=${orders}, clicks=${clicks}, cvr=${(convRate * 100).toFixed(2)}%, sales=${sym}${sales.toFixed(2)}, estoque_ok=${!productBlockerList.includes('LOW_STOCK')}`,
                  action: `Aumentar bid +${Math.round(increasePct * 100)}%: de ${sym}${currentBid.toFixed(2)} para ${sym}${newBid.toFixed(2)}.`,
                  executeAt: 'Início do próximo dia.',
                  whyThisAction: 'A keyword demonstra rentabilidade e conversão consistente. Um aumento gradual busca ampliar a visibilidade no leilão sem comprometer o ACoS.',
                  whyNotAlternatives: 'Aumentar orçamento da campanha afetaria todas as keywords. Aumentar placement afeta a estratégia global. O aumento de bid isolado é mais controlado.',
                  risk: riskLevel === 'medium' ? 'Médio (vencedor forte — maior exposição financeira).' : 'Baixo (primeiro aumento gradual).',
                  confidence,
                  expectedResult: `Aumento de impressões e pedidos mantendo ACoS < ${TARGET_ACOS}%.`,
                  evaluationAt: 'Em 7 dias.',
                  successCriteria: `Aumento de pedidos com ACoS ainda < ${TARGET_ACOS}%.`,
                  rollbackCriteria: `Reverter se ACoS ultrapassar ${MAX_ACOS}% após 7 dias.`,
                  sym,
                }),
                data_used: JSON.stringify({ acos, orders, clicks, sales: sales.toFixed(2), maturity, confidence, strong_winner: isStrongWinner }),
                risk: riskLevel,
                requires_approval: riskLevel !== 'low' || autonomyLevel < 3,
                status: outcome === 'EXECUTE_NOW' ? 'approved' : 'pending',
                confidence: Math.round(confidence * 100),
                objective: objective.toLowerCase(),
                country_code: cc, currency_code: code, currency_symbol: sym,
                idempotency_key: iKey, source_function: 'runDailyAdsOptimization',
                evaluation_due_at: daysFromNow(7),
                rollback_payload: JSON.stringify({ action: 'update_bid', value: currentBid }),
                created_at: now,
              });
              campaignChangedThisCycle.set(kw.campaign_id, 'bid');
              stats.bid_increase++;
            } else { stats.skipped_dup++; }
          } else {
            stats.no_action++; // NO_ACTION: já no máximo ou mudança insignificante
          }
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // BLOCO D — PRIORIDADE 7: Análise de Budget de Campanhas
    // (apenas campanhas não alteradas neste ciclo)
    // ═══════════════════════════════════════════════════════════════════════
    if (cfg.budget_optimization_enabled !== false) {
      for (const c of campaigns) {
        if (c.state !== 'enabled' && c.status !== 'enabled') continue;
        if (campaignChangedThisCycle.has(c.campaign_id)) continue;

        const currentBudget = c.daily_budget || 0;
        const campAcos      = c.acos   || 0;
        const campSpend     = c.spend  || 0;
        const campSales     = c.sales  || 0;
        const campRoas      = campSales > 0 ? campSales / campSpend : 0;
        const campOrders    = c.orders || 0;
        const objective     = inferCampaignObjective(c, cfg);
        const product       = c.asin ? productMap.get(c.asin) : null;
        const histRate      = calcHistoricalSuccessRate(recentDecisions, c.campaign_id, 'budget_change');

        const maturity = calcMaturity({
          createdAt: c.created_at || c.start_date,
          lastSyncAt: [c.synced_at, c.last_sync_at, account.last_sync_at].filter(Boolean).sort().pop(),
          impressions: c.impressions, clicks: c.clicks, spend: c.spend,
        });

        if (maturity !== 'MATURE') continue; // não alterar budget de campanha imatura

        const campConfidence = calcConfidence({
          clicks: c.clicks || 0, orders: campOrders,
          lastSyncAt: [c.synced_at, c.last_sync_at, account.last_sync_at].filter(Boolean).sort().pop(),
          maturity, attrSafetyHours: ATTR_HOURS, product, daysWindow: 14,
          historicalSuccessRate: histRate,
        });

        // ── D1. Redução: ACoS muito acima do máximo ─────────────────────
        if (campAcos > MAX_ACOS && campSpend >= MIN_SPEND * 3) {
          const newBudget = Math.max(currentBudget * (1 - MAX_BUD_DEC), 1);
          const iKey = makeKey(amazonAccountId, 'budget_change', c.campaign_id, 'reduce_high_acos', today);
          if (!existingKeys.has(iKey)) {
            decisionsToCreate.push({
              amazon_account_id: amazonAccountId,
              decision_type: 'budget_change', entity_type: 'campaign',
              entity_id: c.campaign_id, campaign_id: c.campaign_id, asin: c.asin,
              action: 'update_budget',
              value_before: currentBudget, value_after: Number(newBudget.toFixed(2)),
              change_pct: -Math.round(MAX_BUD_DEC * 100),
              rationale: buildFullRationale({
                objective: `${objective}: controlar gasto da campanha com ACoS muito acima do máximo tolerável.`,
                diagnosis: `Campanha "${c.name}" possui ACoS de ${campAcos.toFixed(1)}% (máx. tolerado: ${MAX_ACOS}%) com gasto de ${sym}${campSpend.toFixed(2)}. Redução de orçamento é necessária para limitar a exposição financeira enquanto a causa raiz é investigada nos bids.`,
                evidence: `acos=${campAcos.toFixed(1)}%, max_acos=${MAX_ACOS}%, spend=${sym}${campSpend.toFixed(2)}, sales=${sym}${campSales.toFixed(2)}, maturity=${maturity}`,
                action: `Reduzir orçamento de ${sym}${currentBudget.toFixed(2)} para ${sym}${newBudget.toFixed(2)} (-${Math.round(MAX_BUD_DEC * 100)}%).`,
                executeAt: 'Início do próximo dia.',
                whyThisAction: 'A campanha consome orçamento desproporcional sem retorno compatível. A redução limita o dano enquanto os bids individuais são ajustados.',
                whyNotAlternatives: 'Pausar a campanha eliminaria dados de aprendizado. Alterar bids é necessário mas insuficiente para controle imediato de spend.',
                risk: 'Médio — pode reduzir volume de conversões.',
                confidence: campConfidence,
                expectedResult: 'Redução do gasto diário com manutenção de conversões mais rentáveis.',
                evaluationAt: 'Em 7 dias.',
                successCriteria: `ACoS abaixo de ${MAX_ACOS}% após 7 dias.`,
                rollbackCriteria: `Reverter se vendas caírem > 30% sem melhora no ACoS.`,
                sym,
              }),
              data_used: JSON.stringify({ acos: campAcos, max_acos: MAX_ACOS, spend: campSpend, maturity }),
              risk: 'medium',
              requires_approval: campConfidence < 0.90,
              status: resolveOutcome(campConfidence, maturity, [], autonomyLevel, 'medium') === 'EXECUTE_NOW' ? 'approved' : 'pending',
              confidence: Math.round(campConfidence * 100),
              objective: objective.toLowerCase(),
              country_code: cc, currency_code: code, currency_symbol: sym,
              idempotency_key: iKey, source_function: 'runDailyAdsOptimization',
              evaluation_due_at: daysFromNow(7),
              rollback_payload: JSON.stringify({ action: 'update_budget', value: currentBudget }),
              created_at: now,
            });
            campaignChangedThisCycle.set(c.campaign_id, 'budget');
            stats.budget_decrease++;
          }
        }

        // ── D2. Aumento: campanha rentável limitada por orçamento ────────
        // Requer aprovação humana — alteração de médio risco
        else if (
          campAcos > 0 && campAcos <= TARGET_ACOS &&
          campRoas >= TARGET_ROAS &&
          campOrders >= MIN_ORDERS &&
          campSpend >= currentBudget * 0.90 && // gastou >= 90% do orçamento
          currentBudget < (cfg.maximum_campaign_budget || 100) &&
          !getProductBlockers(product).includes('LOW_STOCK') &&
          !getProductBlockers(product).includes('OUT_OF_STOCK')
        ) {
          const newBudget = Math.min(currentBudget * (1 + MAX_BUD_INC), cfg.maximum_campaign_budget || 100);
          if (newBudget > currentBudget + 0.50) {
            const iKey = makeKey(amazonAccountId, 'budget_change', c.campaign_id, 'increase_profitable', today);
            if (!existingKeys.has(iKey)) {
              decisionsToCreate.push({
                amazon_account_id: amazonAccountId,
                decision_type: 'budget_change', entity_type: 'campaign',
                entity_id: c.campaign_id, campaign_id: c.campaign_id, asin: c.asin,
                action: 'increase_budget',
                value_before: currentBudget, value_after: Number(newBudget.toFixed(2)),
                change_pct: Math.round(MAX_BUD_INC * 100),
                rationale: buildFullRationale({
                  objective: `${objective}: ampliar entrega de campanha rentável limitada por orçamento.`,
                  diagnosis: `Campanha "${c.name}" esgotou ${(campSpend / currentBudget * 100).toFixed(0)}% do orçamento com ACoS de ${campAcos.toFixed(1)}% e ROAS de ${campRoas.toFixed(2)}x. O limite de orçamento está impedindo conversões no período de melhor desempenho.`,
                  evidence: `acos=${campAcos.toFixed(1)}%, target=${TARGET_ACOS}%, roas=${campRoas.toFixed(2)}x, spend=${sym}${campSpend.toFixed(2)}/${sym}${currentBudget.toFixed(2)} (${(campSpend / currentBudget * 100).toFixed(0)}%), orders=${campOrders}`,
                  action: `Aumentar orçamento de ${sym}${currentBudget.toFixed(2)} para ${sym}${newBudget.toFixed(2)} (+${Math.round(MAX_BUD_INC * 100)}%).`,
                  executeAt: 'Início do próximo dia.',
                  whyThisAction: 'O problema é o orçamento, não o bid. A campanha já converte dentro da meta e perde exposição por limitação de budget.',
                  whyNotAlternatives: 'Aumentar bid elevaria o CPC sem ampliar o tempo de veiculação. Aumentar placement alteraria a estratégia.',
                  risk: 'Médio — aumento de exposição financeira. Requer aprovação.',
                  confidence: campConfidence,
                  expectedResult: `Aumento de pedidos com manutenção de ACoS < ${TARGET_ACOS}%.`,
                  evaluationAt: 'Em 7 dias.',
                  successCriteria: `Mais pedidos sem aumento do ACoS acima de ${TARGET_ACOS}%.`,
                  rollbackCriteria: `Reverter para ${sym}${currentBudget.toFixed(2)} se ACoS ultrapassar ${MAX_ACOS}%.`,
                  sym,
                }),
                data_used: JSON.stringify({ acos: campAcos, roas: campRoas, spend: campSpend, budget: currentBudget, utilization_pct: (campSpend / currentBudget * 100).toFixed(0) }),
                risk: 'medium',
                requires_approval: campConfidence < 0.90,
                status: resolveOutcome(campConfidence, maturity, [], autonomyLevel, 'medium') === 'EXECUTE_NOW' ? 'approved' : 'pending',
                confidence: Math.round(campConfidence * 100),
                objective: objective.toLowerCase(),
                country_code: cc, currency_code: code, currency_symbol: sym,
                idempotency_key: iKey, source_function: 'runDailyAdsOptimization',
                evaluation_due_at: daysFromNow(7),
                rollback_payload: JSON.stringify({ action: 'update_budget', value: currentBudget }),
                created_at: now,
              });
              campaignChangedThisCycle.set(c.campaign_id, 'budget');
              stats.budget_increase++;
            }
          }
        }
      }
    }

    // ── Gravar decisões em lotes de 50 ───────────────────────────────────
    let decisionsCreated = 0;
    const approvedIds = [];
    for (let i = 0; i < decisionsToCreate.length; i += 50) {
      const batch = decisionsToCreate.slice(i, i + 50);
      const created = await base44.asServiceRole.entities.OptimizationDecision.bulkCreate(batch);
      decisionsCreated += batch.length;
      // Coletar IDs aprovados para execução imediata
      if (Array.isArray(created)) {
        for (const d of created) {
          if (d?.id && d?.status === 'approved') approvedIds.push(d.id);
        }
      } else {
        // bulkCreate pode não retornar IDs — buscar aprovadas após o loop
      }
    }

    // ── Auto-executar decisões aprovadas (confiança >= 90%) ──────────────
    let executed = 0, execFailed = 0;
    if (autonomyLevel >= 2) {
      // Se bulkCreate não retornou IDs, buscar as recém criadas aprovadas
      let idsToExec = approvedIds;
      if (!idsToExec.length) {
        const freshApproved = await base44.asServiceRole.entities.OptimizationDecision.filter(
          { amazon_account_id: amazonAccountId, status: 'approved' }, '-created_at', 200
        );
        // Só executar as criadas neste ciclo (últimos 2 min)
        const cutoff = Date.now() - 2 * 60000;
        idsToExec = freshApproved
          .filter(d => new Date(d.created_at || d.created_date || 0).getTime() > cutoff)
          .map(d => d.id);
      }

      if (idsToExec.length > 0) {
        const execRes = await base44.asServiceRole.functions.invoke('executeAutopilotDecision', {
          decision_ids: idsToExec,
          _service_role: true,
        }).catch(e => ({ data: { ok: false, error: e.message } }));
        executed = execRes?.data?.executed || 0;
        execFailed = execRes?.data?.failed || 0;
      }
    }

    // ── Finalizar run record ──────────────────────────────────────────────
    await base44.asServiceRole.entities.AutopilotRun.update(runRecord.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      campaigns_analyzed: campaigns.length,
      keywords_analyzed: keywords.length,
      decisions_generated: decisionsCreated,
      total_spend_analyzed: campaigns.reduce((s, c) => s + (c.spend || 0), 0),
    });

    return Response.json({
      ok: true,
      decisions_created: decisionsCreated,
      decisions_executed: executed,
      decisions_exec_failed: execFailed,
      breakdown: stats,
      blocked: blocked.length,
      wait_for_data: waitForData.length,
      rollback_candidates: rollbackCandidates.length,
      autonomy_level: autonomyLevel,
      safe_cutoff: safeCutoff,
      attribution_safety_hours: ATTR_HOURS,
      duration_ms: Date.now() - startTime,
      // debug
      _debug: {
        keywords_loaded: keywords.length,
        campaigns_loaded: campaigns.length,
        account_last_sync: account.last_sync_at,
        decisions_to_create_before_save: decisionsToCreate.length,
        wait_for_data_sample: waitForData.slice(0, 3),
        blocked_sample: blocked.slice(0, 3),
      },
    });

  } catch (error) {
    if (runRecord?.id) {
      const b44 = createClientFromRequest(req);
      await b44.asServiceRole.entities.AutopilotRun.update(runRecord.id, {
        status: 'failed', completed_at: new Date().toISOString(), error_message: error.message,
      }).catch(() => {});
    }
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});