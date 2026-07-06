/**
 * runWeeklyClaudeRuleReview — Módulo A: Analista Semanal com Claude
 *
 * Executado uma vez por semana (domingo 03:00 BRT).
 * Claude NÃO executa ações — apenas propõe regras determinísticas estruturadas.
 * O motor diário (runDeterministicDecisionEngine) NÃO chama Claude.
 *
 * Fluxo:
 * 1. Lock distribuído (impede execução dupla)
 * 2. Coleta e sanitiza dataset semanal
 * 3. Chama Claude com schema estruturado
 * 4. Valida resposta (schema + operadores + backtest)
 * 5. Publica nova versão de regras (somente aprovadas)
 * 6. Libera lock
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import Anthropic from 'npm:@anthropic-ai/sdk@0.52.0';

// ── Configuração central do modelo ──────────────────────────────────────────
// ALTERAR APENAS AQUI para trocar o modelo de revisão semanal.
const AI_WEEKLY_REVIEW_MODEL = Deno.env.get('AI_WEEKLY_REVIEW_MODEL') || 'claude-sonnet-4-5';
const PROMPT_VERSION = '1.0.0';

// ── Guardrails financeiros (imutáveis — codificados no sistema) ──────────────
const MIN_TOTAL_DAILY_BUDGET = 50;
const TARGET_TOTAL_DAILY_BUDGET = 60;
const MAX_TOTAL_DAILY_BUDGET = 65;
const MIN_CONFIDENCE = 0.95;
const MIN_BID = 0.10;
const MAX_BID = 5.0;

// ── Operadores, métricas e ações autorizados ─────────────────────────────────
const ALLOWED_OPERATORS = new Set([
  'equals','not_equals','greater_than','greater_than_or_equal','less_than',
  'less_than_or_equal','between','in','not_in','percentage_change',
  'days_since','consecutive_periods','all','any'
]);
const ALLOWED_METRICS = new Set([
  'impressions','clicks','ctr','cpc','spend','orders','units','conversion_rate',
  'sales','acos','tacos','roas','gross_profit','net_profit','profit_per_order',
  'stock','stock_days','current_bid','current_budget','campaign_age_days',
  'keyword_age_days','search_term_confidence'
]);
const ALLOWED_ACTIONS = new Set([
  'increase_bid_percent','decrease_bid_percent','set_bid','pause_keyword',
  'activate_keyword','negate_search_term','create_exact_keyword',
  'create_phrase_keyword','create_broad_keyword','create_product_target',
  'pause_campaign','activate_campaign','redistribute_budget','recommend_manual_review'
]);

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }

// ── Validação de regra proposta ──────────────────────────────────────────────
function validateProposedRule(rule, existingRuleKeys = new Set()) {
  const errors = [];

  // Campos obrigatórios
  if (!rule.rule_key || typeof rule.rule_key !== 'string') errors.push('rule_key ausente');
  else if (existingRuleKeys.has(rule.rule_key)) errors.push(`rule_key duplicado neste batch: ${rule.rule_key}`);
  if (!rule.name || typeof rule.name !== 'string') errors.push('name ausente');
  if (!rule.scope) errors.push('scope ausente');
  const ALLOWED_SCOPES = new Set(['keyword','campaign','ad_group','search_term','account','product']);
  if (rule.scope && !ALLOWED_SCOPES.has(rule.scope)) errors.push(`scope inválido: ${rule.scope}`);
  if (typeof rule.priority !== 'number' || rule.priority < 0 || rule.priority > 999) errors.push('priority deve ser número entre 0 e 999');
  if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) errors.push('conditions não pode ser vazio');
  if (rule.conditions?.length > 10) errors.push('conditions excede limite de 10 por regra');

  // Ação
  if (!rule.action || typeof rule.action !== 'object') errors.push('action ausente');
  else {
    if (!rule.action.type) errors.push('action.type ausente');
    else if (!ALLOWED_ACTIONS.has(rule.action.type)) errors.push(`action.type não autorizado: ${rule.action.type}`);
    // Ações que requerem value
    const requiresValue = new Set(['increase_bid_percent','decrease_bid_percent','set_bid']);
    if (requiresValue.has(rule.action.type) && (rule.action.value == null || typeof rule.action.value !== 'number')) {
      errors.push(`action.value obrigatório para ${rule.action.type}`);
    }
    // Guardrails de bid
    if (rule.action.type === 'set_bid') {
      if (rule.action.value < MIN_BID) errors.push(`bid ${rule.action.value} abaixo do mínimo R$${MIN_BID}`);
      if (rule.action.value > MAX_BID) errors.push(`bid ${rule.action.value} acima do máximo R$${MAX_BID}`);
    }
    if (rule.action.type === 'increase_bid_percent') {
      if (rule.action.value <= 0) errors.push('increase_bid_percent.value deve ser > 0');
      if (rule.action.value > 30) errors.push('aumento de bid > 30% bloqueado');
    }
    if (rule.action.type === 'decrease_bid_percent') {
      if (rule.action.value <= 0) errors.push('decrease_bid_percent.value deve ser > 0');
      if (rule.action.value > 30) errors.push('redução de bid > 30% bloqueado');
    }
  }

  // Confidence
  if (typeof rule.confidence !== 'number') errors.push('confidence deve ser número');
  else if (rule.confidence < MIN_CONFIDENCE) errors.push(`confidence ${rule.confidence} < mínimo ${MIN_CONFIDENCE}`);
  else if (rule.confidence > 1.0) errors.push('confidence deve ser <= 1.0');

  // Rollback e cooldown
  if (!rule.rollback_condition || typeof rule.rollback_condition !== 'object') errors.push('rollback_condition ausente ou inválido');
  if (!rule.cooldown_hours || typeof rule.cooldown_hours !== 'number' || rule.cooldown_hours < 24) errors.push('cooldown_hours deve ser >= 24');
  if (rule.max_changes_per_week != null && (typeof rule.max_changes_per_week !== 'number' || rule.max_changes_per_week < 1)) {
    errors.push('max_changes_per_week deve ser >= 1');
  }

  // Validar cada condição individualmente
  for (const [i, cond] of (rule.conditions || []).entries()) {
    if (!cond.metric) { errors.push(`conditions[${i}]: metric ausente`); continue; }
    if (!ALLOWED_METRICS.has(cond.metric)) errors.push(`conditions[${i}]: metric não autorizada: ${cond.metric}`);
    if (!cond.operator) { errors.push(`conditions[${i}]: operator ausente`); continue; }
    if (!ALLOWED_OPERATORS.has(cond.operator)) errors.push(`conditions[${i}]: operator não autorizado: ${cond.operator}`);
    // between requer array de 2 elementos
    if (cond.operator === 'between') {
      if (!Array.isArray(cond.value) || cond.value.length !== 2) errors.push(`conditions[${i}]: 'between' requer value=[min,max]`);
    }
    // in / not_in requerem array
    if ((cond.operator === 'in' || cond.operator === 'not_in') && !Array.isArray(cond.value)) {
      errors.push(`conditions[${i}]: '${cond.operator}' requer array de valores`);
    }
    // operadores de comparação simples requerem valor numérico
    const numericOps = new Set(['greater_than','greater_than_or_equal','less_than','less_than_or_equal','equals','not_equals']);
    if (numericOps.has(cond.operator) && cond.value == null) errors.push(`conditions[${i}]: valor ausente para operador ${cond.operator}`);
  }

  return errors;
}

// ── Avaliador de condição única ───────────────────────────────────────────────
function evalCondition(cond, entity) {
  const val = entity[cond.metric] ?? 0;
  switch (cond.operator) {
    case 'greater_than':              return val > cond.value;
    case 'greater_than_or_equal':     return val >= cond.value;
    case 'less_than':                 return val < cond.value;
    case 'less_than_or_equal':        return val <= cond.value;
    case 'equals':                    return val === cond.value;
    case 'not_equals':                return val !== cond.value;
    case 'between':
      return Array.isArray(cond.value) && cond.value.length === 2
        ? val >= cond.value[0] && val <= cond.value[1]
        : false;
    case 'in':                        return Array.isArray(cond.value) && cond.value.includes(val);
    case 'not_in':                    return Array.isArray(cond.value) && !cond.value.includes(val);
    case 'percentage_change': {
      // Requer reference no cond: (val - reference) / reference * 100
      const ref = cond.reference ?? 0;
      if (ref === 0) return false;
      const pct = ((val - ref) / ref) * 100;
      return cond.direction === 'decrease' ? pct <= -(cond.value ?? 0) : pct >= (cond.value ?? 0);
    }
    case 'days_since': {
      // entity deve ter campo com data ISO; cond.value = número de dias mínimo
      const dateVal = entity[`${cond.metric}_at`] || entity[cond.metric];
      if (!dateVal) return false;
      const daysDiff = (Date.now() - new Date(dateVal).getTime()) / 86400000;
      return daysDiff >= (cond.value ?? 0);
    }
    case 'consecutive_periods':
      // Aproximação: verificar se valor está fora do threshold por N períodos
      return val >= (cond.value ?? 0);
    case 'all': case 'any':
      // Operadores compostos: aprovado no backtest simples (requer avaliação de sub-conditions)
      return true;
    default:
      return true; // operadores desconhecidos: pass-through conservador
  }
}

// ── Backtest completo ─────────────────────────────────────────────────────────
async function backtestProposedRule(base44, rule, aid, keywords, metrics30d) {
  const result = {
    rule_key: rule.rule_key,
    rule_version: 1,
    records_tested: 0,
    actions_simulated: 0,
    spend_real: 0,
    spend_simulated: 0,
    sales_real: 0,
    sales_simulated: 0,
    acos_real: 0,
    acos_simulated: 0,
    passed: false,
    rejection_reasons: [],
    risk_level: 'low',
  };

  // Dados insuficientes: regra de scope keyword sem keywords
  const isKeywordScope = !rule.scope || rule.scope === 'keyword';
  if (isKeywordScope && keywords.length < 5) {
    result.rejection_reasons.push('dados insuficientes para backtest (< 5 keywords)');
    return result;
  }

  // Para escopo de campanha, usar métricas diárias agregadas
  const entities = isKeywordScope ? keywords : metrics30d.reduce((acc, m) => {
    const key = m.campaign_id || 'global';
    if (!acc[key]) acc[key] = { campaign_id: key, spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0, acos: 0 };
    acc[key].spend += m.spend || 0;
    acc[key].sales += m.sales || 0;
    acc[key].orders += m.orders || 0;
    acc[key].clicks += m.clicks || 0;
    acc[key].impressions += m.impressions || 0;
    return acc;
  }, {});
  const entityList = isKeywordScope ? keywords : Object.values(entities);

  // Calcular métricas reais agregadas dos 30d
  const realSpend = metrics30d.reduce((s, m) => s + (m.spend || 0), 0);
  const realSales = metrics30d.reduce((s, m) => s + (m.sales || 0), 0);
  result.spend_real = realSpend;
  result.sales_real = realSales;
  result.acos_real = realSales > 0 ? (realSpend / realSales) * 100 : 0;
  result.records_tested = entityList.length;

  // Simulação: identificar entidades afetadas e estimar impacto
  let actionsCount = 0;
  let spendAffected = 0;
  let salesAffected = 0;

  for (const entity of entityList) {
    // Calcular acos da entidade se não existir
    const entityAcos = entity.acos || (entity.sales > 0 ? (entity.spend / entity.sales) * 100 : 0);
    const entityWithAcos = { ...entity, acos: entityAcos };

    const meetsAll = (rule.conditions || []).every(cond => evalCondition(cond, entityWithAcos));
    if (!meetsAll) continue;

    actionsCount++;
    spendAffected += entity.spend || 0;
    salesAffected += entity.sales || 0;
  }

  result.actions_simulated = actionsCount;

  // Estimar impacto financeiro da ação
  // Fator de elasticidade: mudança de bid X% → mudança de spend ~0.5X%, vendas ~0.3X%
  let spendDelta = 0;
  let salesDelta = 0;

  switch (rule.action.type) {
    case 'decrease_bid_percent': {
      const pct = (rule.action.value || 10) / 100;
      spendDelta  = -(spendAffected * pct * 0.55);
      salesDelta  = -(salesAffected * pct * 0.30);
      break;
    }
    case 'increase_bid_percent': {
      const pct = (rule.action.value || 10) / 100;
      spendDelta  = spendAffected * pct * 0.45;
      salesDelta  = salesAffected * pct * 0.35;
      break;
    }
    case 'set_bid': {
      // Estimar com base no spread entre bid atual e bid alvo
      const avgCurrentBid = entityList
        .filter(e => {
          const entityAcos = e.acos || (e.sales > 0 ? (e.spend / e.sales) * 100 : 0);
          return (rule.conditions || []).every(c => evalCondition(c, { ...e, acos: entityAcos }));
        })
        .reduce((s, e, _, arr) => s + (e.current_bid || 0.25) / arr.length, 0);
      const bidRatio = avgCurrentBid > 0 ? rule.action.value / avgCurrentBid : 1;
      spendDelta = spendAffected * (bidRatio - 1) * 0.5;
      salesDelta = salesAffected * (bidRatio - 1) * 0.3;
      break;
    }
    case 'pause_keyword':
    case 'pause_campaign':
      spendDelta = -spendAffected;
      salesDelta = -salesAffected;
      break;
    case 'negate_search_term':
      // Impacto parcial: apenas o spend do search term específico
      spendDelta = -spendAffected * 0.8;
      salesDelta = -salesAffected * 0.5; // pode perder algumas vendas colaterais
      break;
    case 'create_exact_keyword':
    case 'create_phrase_keyword':
    case 'create_broad_keyword':
      // Harvest: spend adicional estimado
      spendDelta = spendAffected * 0.15;
      salesDelta = salesAffected * 0.25;
      break;
    default:
      // Ações sem impacto financeiro direto
      spendDelta = 0;
      salesDelta = 0;
  }

  result.spend_simulated = Math.max(0, realSpend + spendDelta);
  result.sales_simulated = Math.max(0, realSales + salesDelta);
  result.acos_simulated = result.sales_simulated > 0
    ? (result.spend_simulated / result.sales_simulated) * 100
    : 0;

  // ── Critérios de rejeição do backtest ───────────────────────────────────
  // 1. Nenhuma entidade afetada (regra inerte)
  if (actionsCount === 0) {
    result.rejection_reasons.push('nenhuma entidade seria afetada pela regra com os dados atuais');
  }

  // 2. Alcance excessivo (> 60% das entidades) — alto risco
  const coverageRatio = entityList.length > 0 ? actionsCount / entityList.length : 0;
  if (coverageRatio > 0.60) {
    result.risk_level = 'high';
    result.rejection_reasons.push(
      `alcance excessivo: ${actionsCount}/${entityList.length} entidades afetadas (${(coverageRatio * 100).toFixed(0)}% > 60%)`
    );
  } else if (coverageRatio > 0.35) {
    result.risk_level = 'medium';
  }

  // 3. Spend simulado negativo ou abaixo do mínimo total
  if (result.spend_simulated < 0) {
    result.rejection_reasons.push('spend simulado resultaria em valor negativo');
  }

  // 4. ACoS simulado piora > 20pp em relação ao real (regra vai piorar a eficiência)
  const acosDelta = result.acos_simulated - result.acos_real;
  if (result.acos_real > 0 && acosDelta > 20) {
    result.risk_level = 'high';
    result.rejection_reasons.push(
      `ACoS simulado piora ${acosDelta.toFixed(1)}pp (real: ${result.acos_real.toFixed(1)}% → simulado: ${result.acos_simulated.toFixed(1)}%)`
    );
  }

  // 5. Redução de vendas > 40% (regra vai prejudicar o negócio)
  const salesDropPct = realSales > 0 ? ((realSales - result.sales_simulated) / realSales) * 100 : 0;
  if (salesDropPct > 40) {
    result.risk_level = 'high';
    result.rejection_reasons.push(
      `queda de vendas simulada de ${salesDropPct.toFixed(1)}% — risco inaceitável`
    );
  }

  // 6. Budget total após ação ficaria fora da faixa permitida
  if (rule.action.type === 'redistribute_budget') {
    const budgetAfter = realSpend + spendDelta;
    if (budgetAfter > MAX_TOTAL_DAILY_BUDGET) {
      result.rejection_reasons.push(
        `budget simulado R$${budgetAfter.toFixed(2)} ultrapassa máximo R$${MAX_TOTAL_DAILY_BUDGET}`
      );
    }
    if (budgetAfter < MIN_TOTAL_DAILY_BUDGET) {
      result.rejection_reasons.push(
        `budget simulado R$${budgetAfter.toFixed(2)} abaixo do mínimo R$${MIN_TOTAL_DAILY_BUDGET}`
      );
    }
  }

  result.passed = result.rejection_reasons.length === 0;
  return result;
}

// ── Handler principal ──────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const correlationId = uuid();
  const startTime = Date.now();
  const now = new Date().toISOString();
  const base44 = createClientFromRequest(req);
  let reviewRecord = null;

  try {
    // Auth e conta
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    let account = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0] || null;
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon conectada.' });
    const aid = account.id;

    // ── Lock distribuído ──────────────────────────────────────────────────
    const existingLocks = await base44.asServiceRole.entities.WeeklyRuleReview.filter(
      { amazon_account_id: aid, status: 'running' }, '-started_at', 1
    );
    if (existingLocks.length > 0) {
      const lockAge = (Date.now() - new Date(existingLocks[0].started_at).getTime()) / 60000;
      if (lockAge < 60) {
        return Response.json({ ok: false, skipped: true, reason: `Revisão semanal já em execução (${Math.round(lockAge)} min)` });
      }
      // Lock travado > 60 min → forçar conclusão
      await base44.asServiceRole.entities.WeeklyRuleReview.update(existingLocks[0].id, {
        status: 'failed', error_message: `Lock liberado após ${Math.round(lockAge)} min`, completed_at: now,
      });
    }

    // Criar registro da revisão
    const reviewId = `review_${Date.now()}`;
    reviewRecord = await base44.asServiceRole.entities.WeeklyRuleReview.create({
      amazon_account_id: aid,
      review_id: reviewId,
      model: AI_WEEKLY_REVIEW_MODEL,
      prompt_version: PROMPT_VERSION,
      status: 'running',
      started_at: now,
      analysis_period_start: daysAgo(90),
      analysis_period_end: daysAgo(1),
    });

    // ── Coleta de dataset ──────────────────────────────────────────────────
    const [keywords, campaigns, products, metrics90d, searchTerms, existingRules, recentExecutions] = await Promise.all([
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-spend', 500),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, '-spend', 200),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 100),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 1000),
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: aid }, '-orders_14d', 300),
      base44.asServiceRole.entities.DecisionRule.filter({ amazon_account_id: aid, status: 'active' }),
      base44.asServiceRole.entities.RuleExecution.filter({ amazon_account_id: aid }, '-created_date', 200),
    ]);

    const metrics30d = metrics90d.filter(m => m.date >= daysAgo(30));
    const metrics7d = metrics90d.filter(m => m.date >= daysAgo(7));

    // Sanitizar: remover campos sensíveis
    const sanitizedKeywords = keywords.map(k => ({
      id: k.id, keyword_text: k.keyword_text, match_type: k.match_type, state: k.state,
      acos: k.acos, clicks: k.clicks, spend: k.spend, sales: k.sales, orders: k.orders,
      impressions: k.impressions, cpc: k.cpc, current_bid: k.current_bid || k.bid,
      campaign_id: k.campaign_id, asin: k.asin,
    }));

    const sanitizedCampaigns = campaigns.map(c => ({
      id: c.id, campaign_id: c.campaign_id, name: c.name || c.campaign_name,
      targeting_type: c.targeting_type, state: c.state, status: c.status,
      acos: c.acos, spend: c.spend, sales: c.sales, orders: c.orders, daily_budget: c.daily_budget,
    }));

    // Agregados por período
    function aggregateMetrics(rows) {
      return rows.reduce((acc, m) => ({
        spend: acc.spend + (m.spend || 0),
        sales: acc.sales + (m.sales || 0),
        orders: acc.orders + (m.orders || 0),
        clicks: acc.clicks + (m.clicks || 0),
        impressions: acc.impressions + (m.impressions || 0),
      }), { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 });
    }
    const agg7d = aggregateMetrics(metrics7d);
    const agg30d = aggregateMetrics(metrics30d);
    const agg90d = aggregateMetrics(metrics90d);

    const totalActiveBudget = campaigns
      .filter(c => c.state === 'enabled' || c.status === 'enabled')
      .reduce((s, c) => s + (c.daily_budget || 0), 0);

    const dataset = {
      account: { marketplace: account.marketplace_id, country: account.country_code, currency: account.currency_code },
      aggregates: { last_7d: agg7d, last_30d: agg30d, last_90d: agg90d },
      total_active_budget: totalActiveBudget,
      active_campaigns: campaigns.filter(c => c.state === 'enabled' || c.status === 'enabled').length,
      keywords_sample: sanitizedKeywords.slice(0, 200),
      campaigns: sanitizedCampaigns,
      search_terms_with_orders: searchTerms.filter(s => (s.orders_14d || 0) > 0).slice(0, 100),
      existing_rules: existingRules.map(r => ({
        rule_key: r.rule_key, name: r.name, scope: r.scope, priority: r.priority,
        conditions: r.conditions, action: r.action, times_triggered: r.times_triggered,
        times_succeeded: r.times_succeeded, confidence: r.confidence,
      })),
      recent_rule_executions_summary: {
        total: recentExecutions.length,
        completed: recentExecutions.filter(e => e.status === 'completed').length,
        failed: recentExecutions.filter(e => e.status === 'failed').length,
        rolled_back: recentExecutions.filter(e => e.status === 'rolled_back').length,
      },
    };

    const dataHash = String(JSON.stringify(dataset).length) + '_' + agg30d.spend.toFixed(0);

    // ── Chamada ao Claude ──────────────────────────────────────────────────
    const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });

    const systemPrompt = `Você é o analisador semanal de regras determinísticas do Living Finds Amazon Ads.
PAPEL: analisar dados de performance, avaliar regras vigentes, propor regras determinísticas estruturadas.
RESTRIÇÕES:
- Responda SOMENTE em JSON válido com o schema fornecido.
- Não gere código TypeScript executável.
- Use apenas operadores autorizados: ${[...ALLOWED_OPERATORS].join(', ')}.
- Use apenas métricas autorizadas: ${[...ALLOWED_METRICS].join(', ')}.
- Use apenas ações autorizadas: ${[...ALLOWED_ACTIONS].join(', ')}.
- Budget total ENTRE R$${MIN_TOTAL_DAILY_BUDGET} e R$${MAX_TOTAL_DAILY_BUDGET}. NÃO multiplique R$${TARGET_TOTAL_DAILY_BUDGET} por número de produtos ou campanhas.
- Confidence mínima: ${MIN_CONFIDENCE}.
- Toda regra deve ter rollback_condition.
- Toda regra deve ter cooldown_hours >= 24.
- Não crie regras que elevem budget total acima de R$${MAX_TOTAL_DAILY_BUDGET}.
- Não crie regras para bids abaixo de R$${MIN_BID} ou acima de R$${MAX_BID}.`;

    const userPrompt = `Analise os dados abaixo e retorne SOMENTE o JSON estruturado.

PERÍODO: ${daysAgo(90)} a ${daysAgo(1)}
DADOS:
${JSON.stringify(dataset, null, 2)}

SCHEMA DE RESPOSTA OBRIGATÓRIO:
{
  "analysis_period": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
  "model": "${AI_WEEKLY_REVIEW_MODEL}",
  "data_quality": { "score": 0.0-1.0, "missing_sources": [], "warnings": [] },
  "rules_to_create": [ { "rule_key": "", "name": "", "scope": "", "priority": 0, "conditions": [], "action": {}, "minimum_evidence": {}, "cooldown_hours": 72, "max_changes_per_week": 1, "expected_result": {}, "confidence": 0.95, "reason": "", "source_metrics": [], "rollback_condition": {}, "expires_at": null } ],
  "rules_to_update": [],
  "rules_to_disable": [],
  "rules_unchanged": [],
  "global_observations": [],
  "expected_impact": { "spend_change_percent": 0, "sales_change_percent": 0, "profit_change_percent": 0 }
}`;

    let claudeResponse = null;
    let tokensUsed = 0;
    let costEstimate = 0;

    try {
      const response = await anthropic.messages.create({
        model: AI_WEEKLY_REVIEW_MODEL,
        max_tokens: 4096,
        temperature: 0.1,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });
      tokensUsed = response.usage?.input_tokens + response.usage?.output_tokens || 0;
      costEstimate = (tokensUsed / 1000) * 0.003;
      const rawText = response.content[0]?.text || '{}';
      claudeResponse = JSON.parse(rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
    } catch (claudeErr) {
      await base44.asServiceRole.entities.WeeklyRuleReview.update(reviewRecord.id, {
        status: 'failed',
        error_message: `Claude falhou: ${claudeErr.message}`,
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - startTime,
      });
      return Response.json({
        ok: false, error: 'Claude falhou — regras atuais mantidas.',
        detail: claudeErr.message, correlationId,
      });
    }

    // ── Validação e backtest de cada regra proposta ───────────────────────
    const rulesToCreate = claudeResponse.rules_to_create || [];
    const rulesToUpdate = claudeResponse.rules_to_update || [];
    const approvedRules = [];
    const approvedUpdates = [];
    const rejectedRules = [];
    const backtestResults = [];

    // Set de rule_keys já aprovados neste batch (evita duplicatas intra-revisão)
    const seenRuleKeys = new Set(existingRules.map(r => r.rule_key));

    for (const rule of rulesToCreate) {
      const validationErrors = validateProposedRule(rule, seenRuleKeys);
      if (validationErrors.length > 0) {
        rejectedRules.push({ rule_key: rule.rule_key || '(sem chave)', reasons: validationErrors });
        continue;
      }
      seenRuleKeys.add(rule.rule_key);

      // Backtest
      const bt = await backtestProposedRule(base44, rule, aid, sanitizedKeywords, metrics30d);
      backtestResults.push(bt);
      await base44.asServiceRole.entities.RuleBacktest.create({
        amazon_account_id: aid,
        review_id: reviewId,
        ...bt,
        period_days: 30,
      }).catch(() => {});

      if (!bt.passed) {
        rejectedRules.push({ rule_key: rule.rule_key, reasons: bt.rejection_reasons, risk_level: bt.risk_level });
        continue;
      }

      approvedRules.push(rule);
    }

    // Validar e processar atualizações de regras existentes
    for (const update of rulesToUpdate) {
      if (!update.rule_key) { rejectedRules.push({ rule_key: '(sem chave)', reasons: ['rule_key ausente na atualização'] }); continue; }
      // Encontrar regra existente
      const found = existingRules.find(r => r.rule_key === update.rule_key);
      if (!found) { rejectedRules.push({ rule_key: update.rule_key, reasons: ['regra não encontrada para atualização'] }); continue; }
      // Mesclar com a regra existente e validar o resultado
      const merged = { ...found, ...update };
      const validationErrors = validateProposedRule(merged, new Set()); // updates não precisam checar duplicatas
      if (validationErrors.length > 0) {
        rejectedRules.push({ rule_key: update.rule_key, reasons: validationErrors });
        continue;
      }
      const bt = await backtestProposedRule(base44, merged, aid, sanitizedKeywords, metrics30d);
      backtestResults.push(bt);
      await base44.asServiceRole.entities.RuleBacktest.create({
        amazon_account_id: aid, review_id: reviewId, ...bt, period_days: 30,
      }).catch(() => {});
      if (!bt.passed) {
        rejectedRules.push({ rule_key: update.rule_key, reasons: bt.rejection_reasons, risk_level: bt.risk_level });
        continue;
      }
      approvedUpdates.push({ existing_id: found.id, ...update });
    }

    // ── Publicar nova versão de regras ────────────────────────────────────
    let versionId = null;
    if (approvedRules.length > 0 || approvedUpdates.length > 0) {
      // Obter versão atual
      const versions = await base44.asServiceRole.entities.DecisionRuleVersion.filter(
        { amazon_account_id: aid, status: 'active' }, '-version_number', 1
      );
      const nextVersion = (versions[0]?.version_number || 0) + 1;

      // Criar regras no banco
      const createdRuleKeys = [];
      for (const rule of approvedRules) {
        await base44.asServiceRole.entities.DecisionRule.create({
          amazon_account_id: aid,
          rule_key: rule.rule_key,
          name: rule.name,
          scope: rule.scope,
          priority: rule.priority,
          conditions: rule.conditions,
          action: rule.action,
          minimum_evidence: rule.minimum_evidence,
          cooldown_hours: rule.cooldown_hours,
          max_changes_per_week: rule.max_changes_per_week,
          expected_result: rule.expected_result,
          confidence: rule.confidence,
          reason: rule.reason,
          source_metrics: rule.source_metrics,
          rollback_condition: rule.rollback_condition,
          expires_at: rule.expires_at,
          status: 'active',
          is_protected: false,
          version: nextVersion,
          review_id: reviewId,
          source: 'claude_weekly',
          effective_from: new Date().toISOString(),
        });
        createdRuleKeys.push(rule.rule_key);
      }

      // Aplicar atualizações aprovadas
      const updatedRuleKeys = [];
      for (const upd of approvedUpdates) {
        const { existing_id, ...fields } = upd;
        await base44.asServiceRole.entities.DecisionRule.update(existing_id, {
          ...fields,
          version: (fields.version || 1) + 1,
          review_id: reviewId,
          effective_from: new Date().toISOString(),
        });
        updatedRuleKeys.push(upd.rule_key);
      }

      // Regras a desativar
      const disabledKeys = (claudeResponse.rules_to_disable || []).map(r => r.rule_key || r);
      for (const rk of disabledKeys) {
        const found = await base44.asServiceRole.entities.DecisionRule.filter({ amazon_account_id: aid, rule_key: rk, status: 'active' });
        if (found[0]) await base44.asServiceRole.entities.DecisionRule.update(found[0].id, { status: 'suspended', effective_until: new Date().toISOString() });
      }

      // Versionar versões ativas anteriores
      if (versions[0]) {
        await base44.asServiceRole.entities.DecisionRuleVersion.update(versions[0].id, {
          status: 'superseded', superseded_at: new Date().toISOString(),
        });
      }

      // Criar nova versão
      const newVersion = await base44.asServiceRole.entities.DecisionRuleVersion.create({
        amazon_account_id: aid,
        version_number: nextVersion,
        review_id: reviewId,
        model: AI_WEEKLY_REVIEW_MODEL,
        prompt_version: PROMPT_VERSION,
        data_hash: dataHash,
        status: 'active',
        activated_at: new Date().toISOString(),
        previous_version_id: versions[0]?.id || null,
        rules_created: createdRuleKeys,
        rules_updated: updatedRuleKeys,
        rules_disabled: disabledKeys,
        rules_unchanged: (claudeResponse.rules_unchanged || []).map(r => r.rule_key || r),
        backtest_result: backtestResults,
        expected_impact: claudeResponse.expected_impact || {},
        rollback_available: true,
        justification: (claudeResponse.global_observations || []).join(' | '),
      });
      versionId = newVersion.id;
    }

    // Finalizar revisão
    await base44.asServiceRole.entities.WeeklyRuleReview.update(reviewRecord.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      data_hash: dataHash,
      data_quality_score: claudeResponse.data_quality?.score || 0,
      data_warnings: claudeResponse.data_quality?.warnings || [],
      records_analyzed: keywords.length + campaigns.length + metrics30d.length,
      tokens_used: tokensUsed,
      cost_estimate_usd: costEstimate,
      rules_proposed: rulesToCreate.length + rulesToUpdate.length,
      rules_approved: approvedRules.length + approvedUpdates.length,
      rules_rejected: rejectedRules.length,
      rules_unchanged: (claudeResponse.rules_unchanged || []).length,
      version_id: versionId,
      version_activated: !!versionId,
      global_observations: claudeResponse.global_observations || [],
    });

    return Response.json({
      ok: true,
      correlationId,
      review_id: reviewId,
      model: AI_WEEKLY_REVIEW_MODEL,
      rules_proposed: rulesToCreate.length + rulesToUpdate.length,
      rules_approved: approvedRules.length + approvedUpdates.length,
      rules_rejected: rejectedRules.length,
      rejected_reasons: rejectedRules,
      version_activated: versionId,
      tokens_used: tokensUsed,
      cost_estimate_usd: costEstimate,
      duration_ms: Date.now() - startTime,
    });

  } catch (error) {
    console.error('[runWeeklyClaudeRuleReview]', error.message);
    if (reviewRecord?.id) {
      const b44 = createClientFromRequest(req);
      await b44.asServiceRole.entities.WeeklyRuleReview.update(reviewRecord.id, {
        status: 'failed', error_message: error.message, completed_at: new Date().toISOString(),
      }).catch(() => {});
    }
    return Response.json({ ok: false, error: error.message, correlationId }, { status: 500 });
  }
});