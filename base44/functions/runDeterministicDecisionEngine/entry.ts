/**
 * runDeterministicDecisionEngine — Módulo B: Motor Determinístico Diário
 *
 * REGRA ABSOLUTA: Este módulo NÃO chama Claude, nenhum LLM, nenhuma IA.
 * Carrega regras vigentes do banco e executa decisões puramente calculadas.
 * A indisponibilidade de qualquer IA não afeta este módulo.
 *
 * Resultado para mesma entrada + mesma versão de regras = SEMPRE igual (determinístico).
 *
 * Guardrails financeiros protegidos (codificados — não vêm do banco):
 *   Budget total automático: R$50–R$65
 *   Bid mínimo: R$0.10 | Bid máximo: R$5.00
 *   Toda ação passa pela fila com idempotency_key
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── Guardrails financeiros (imutáveis — codificados no sistema) ──────────────
const MIN_TOTAL_DAILY_BUDGET = 50;
const TARGET_TOTAL_DAILY_BUDGET = 60;
const MAX_TOTAL_DAILY_BUDGET = 65;
const MIN_BID = 0.10;
const MAX_BID = 5.0;
const MAX_BID_CHANGE_PCT = 0.30; // máximo 30% por execução

// Prioridade de conflito (menor = mais prioritário)
const CONFLICT_PRIORITY = {
  financial_safety: 1, stock: 2, profit: 3, budget_limit: 4,
  protected_rules: 5, dedup: 6, pause_loss: 7, reduce_bid: 8,
  maintenance: 9, increase_bid: 10, expansion: 11, campaign_creation: 12,
};

function uuid() { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }

// ── Avaliador de condição determinístico ────────────────────────────────────
function evaluateCondition(cond, entity) {
  const val = entity[cond.metric] ?? 0;
  switch (cond.operator) {
    case 'equals': return val === cond.value;
    case 'not_equals': return val !== cond.value;
    case 'greater_than': return val > cond.value;
    case 'greater_than_or_equal': return val >= cond.value;
    case 'less_than': return val < cond.value;
    case 'less_than_or_equal': return val <= cond.value;
    case 'between': return val >= cond.value[0] && val <= cond.value[1];
    case 'in': return Array.isArray(cond.value) && cond.value.includes(val);
    case 'not_in': return Array.isArray(cond.value) && !cond.value.includes(val);
    case 'days_since': {
      if (!entity[cond.metric]) return false;
      const ageDays = (Date.now() - new Date(entity[cond.metric]).getTime()) / 86400000;
      return ageDays >= (cond.value || 0);
    }
    default: return false;
  }
}

function entityMatchesRule(rule, entity) {
  return (rule.conditions || []).every(cond => evaluateCondition(cond, entity));
}

// ── Calcular valor da ação ───────────────────────────────────────────────────
function calculateActionValue(rule, entity) {
  const action = rule.action;
  const currentBid = entity.current_bid || entity.bid || 0.25;
  const currentBudget = entity.daily_budget || entity.current_budget || 0;

  switch (action.type) {
    case 'increase_bid_percent': {
      const pct = Math.min(action.value / 100, MAX_BID_CHANGE_PCT);
      return Math.min(currentBid * (1 + pct), MAX_BID);
    }
    case 'decrease_bid_percent': {
      const pct = Math.min(action.value / 100, MAX_BID_CHANGE_PCT);
      return Math.max(currentBid * (1 - pct), MIN_BID);
    }
    case 'set_bid':
      return Math.min(Math.max(action.value, MIN_BID), MAX_BID);
    default:
      return action.value;
  }
}

// ── Resolver conflito entre duas regras ─────────────────────────────────────
function resolveRuleConflicts(ruleA, ruleB) {
  const typeA = ruleA.action?.type || '';
  const typeB = ruleB.action?.type || '';

  const categoryOf = (t) => {
    if (['pause_campaign', 'pause_keyword'].includes(t)) return 'pause_loss';
    if (['decrease_bid_percent', 'set_bid'].includes(t) && ruleA.priority <= ruleB.priority) return 'reduce_bid';
    if (['increase_bid_percent'].includes(t)) return 'increase_bid';
    if (['create_exact_keyword', 'create_phrase_keyword', 'create_broad_keyword', 'create_campaign'].includes(t)) return 'expansion';
    return 'maintenance';
  };

  const catA = categoryOf(typeA);
  const catB = categoryOf(typeB);
  const prioA = CONFLICT_PRIORITY[catA] || 99;
  const prioB = CONFLICT_PRIORITY[catB] || 99;

  return prioA <= prioB ? { execute: ruleA, skip: ruleB } : { execute: ruleB, skip: ruleA };
}

// ── Handler principal ────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const correlationId = uuid();
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const base44 = createClientFromRequest(req);

  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    let account = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada.' });
    const aid = account.id;

    // ── 1. Carregar regras vigentes (somente status=active, dentro de vigência) ──
    const allRules = await base44.asServiceRole.entities.DecisionRule.filter({ amazon_account_id: aid, status: 'active' });
    const activeRules = allRules.filter(r => {
      if (r.effective_from && new Date(r.effective_from) > new Date()) return false;
      if (r.effective_until && new Date(r.effective_until) < new Date()) return false;
      return true;
    }).sort((a, b) => (a.priority || 100) - (b.priority || 100));

    if (activeRules.length === 0) {
      return Response.json({ ok: true, message: 'Nenhuma regra ativa. Motor encerrado.', correlationId });
    }

    // ── 2. Carregar métricas atualizadas ──────────────────────────────────
    const [keywords, campaigns, products] = await Promise.all([
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-spend', 500),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 200),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 100),
    ]);

    // ── 3. Validar qualidade dos dados ────────────────────────────────────
    const dataAge = account.last_sync_at
      ? (Date.now() - new Date(account.last_sync_at).getTime()) / 3600000
      : 999;
    if (dataAge > 48) {
      return Response.json({
        ok: false, skipped: true,
        reason: `Dados desatualizados (${Math.round(dataAge)}h sem sync). Motor bloqueado por segurança.`,
        correlationId,
      });
    }

    // ── 4. Guardrail: verificar budget total ──────────────────────────────
    const totalActiveBudget = campaigns
      .filter(c => c.state === 'enabled' || c.status === 'enabled')
      .reduce((s, c) => s + (c.daily_budget || 0), 0);

    const suggestedTotalBudget = Math.min(
      MAX_TOTAL_DAILY_BUDGET,
      Math.max(MIN_TOTAL_DAILY_BUDGET, TARGET_TOTAL_DAILY_BUDGET)
    );

    // ── 5. Índices ─────────────────────────────────────────────────────────
    const productMap = new Map(products.map(p => [p.asin, p]));
    const campaignMap = new Map(campaigns.map(c => [c.campaign_id, c]));

    // Últimas execuções para controle de cooldown
    const recentExecs = await base44.asServiceRole.entities.RuleExecution.filter(
      { amazon_account_id: aid }, '-created_date', 300
    );
    const lastExecByRuleEntity = new Map();
    for (const ex of recentExecs) {
      const k = `${ex.rule_key}|${ex.entity_id}`;
      if (!lastExecByRuleEntity.has(k)) lastExecByRuleEntity.set(k, ex);
    }

    // Idempotency keys já usadas hoje
    const existingExecsToday = recentExecs.filter(e => (e.created_date || '').slice(0, 10) === today);
    const usedIdemKeys = new Set(existingExecsToday.map(e => e.idempotency_key).filter(Boolean));

    const actionsToEnqueue = [];
    const conflicts = [];
    const stats = { evaluated: 0, matched: 0, skipped_cooldown: 0, skipped_dup: 0, skipped_stock: 0, enqueued: 0 };

    // Controle de ação por entidade neste ciclo (uma variável por entidade)
    const entityChangedThisCycle = new Map(); // entity_id → rule_key

    const scopedEntities = {
      keyword: keywords,
      campaign: campaigns,
    };

    // ── 6. Avaliar cada regra contra cada entidade do escopo ──────────────
    for (const rule of activeRules) {
      const entities = scopedEntities[rule.scope] || [];

      for (const entity of entities) {
        stats.evaluated++;

        const entityId = entity.keyword_id || entity.campaign_id || entity.id;
        if (!entityId) continue;

        // Guardrail: produto sem estoque
        const product = entity.asin ? productMap.get(entity.asin) : null;
        if (product?.inventory_status === 'out_of_stock' && ['increase_bid_percent', 'activate_campaign', 'activate_keyword', 'create_exact_keyword'].includes(rule.action.type)) {
          stats.skipped_stock++;
          continue;
        }

        // Verificar condições
        const entityData = {
          ...entity,
          current_bid: entity.current_bid || entity.bid || 0.25,
          current_budget: entity.daily_budget || 0,
          stock: product?.fba_inventory || 0,
          stock_days: product?.stock_days || 0,
        };

        if (!entityMatchesRule(rule, entityData)) continue;
        stats.matched++;

        // Guardrail cooldown
        const lastExec = lastExecByRuleEntity.get(`${rule.rule_key}|${entityId}`);
        if (lastExec?.executed_at) {
          const hoursAgo = (Date.now() - new Date(lastExec.executed_at).getTime()) / 3600000;
          if (hoursAgo < (rule.cooldown_hours || 72)) {
            stats.skipped_cooldown++;
            continue;
          }
        }

        // Resolver conflito com ação já agendada para esta entidade neste ciclo
        const existingRuleKey = entityChangedThisCycle.get(entityId);
        if (existingRuleKey) {
          const existingRule = activeRules.find(r => r.rule_key === existingRuleKey);
          if (existingRule) {
            const resolution = resolveRuleConflicts(existingRule, rule);
            conflicts.push({
              amazon_account_id: aid,
              correlation_id: correlationId,
              rule_key_a: existingRule.rule_key,
              rule_key_b: rule.rule_key,
              entity_id: entityId,
              resolution: `execute:${resolution.execute.rule_key}`,
              rule_executed: resolution.execute.rule_key,
              rule_skipped: resolution.skip.rule_key,
              resolved_at: now,
            });
            if (resolution.execute.rule_key !== rule.rule_key) continue; // skip esta
          }
        }

        // Calcular valor da ação
        const newValue = calculateActionValue(rule, entityData);

        // Idempotency key
        const iKey = `det|${aid}|${rule.rule_key}|${entityId}|${today}`;
        if (usedIdemKeys.has(iKey)) { stats.skipped_dup++; continue; }

        // Guardrail final: budget total não pode exceder MAX
        if (['redistribute_budget'].includes(rule.action.type) && totalActiveBudget > MAX_TOTAL_DAILY_BUDGET) {
          continue; // bloquear ação de budget se já está no limite
        }

        actionsToEnqueue.push({
          amazon_account_id: aid,
          correlation_id: correlationId,
          rule_key: rule.rule_key,
          rule_version: rule.version || 1,
          entity_type: rule.scope,
          entity_id: entityId,
          campaign_id: entity.campaign_id,
          keyword_id: entity.keyword_id,
          asin: entity.asin,
          action_type: rule.action.type,
          value_before: entityData.current_bid || entityData.current_budget || 0,
          value_after: newValue,
          idempotency_key: iKey,
          status: 'pending',
        });
        entityChangedThisCycle.set(entityId, rule.rule_key);
        stats.enqueued++;
      }
    }

    // ── 7. Gravar conflitos e ações na fila ───────────────────────────────
    for (const c of conflicts.slice(0, 50)) {
      await base44.asServiceRole.entities.RuleConflict.create(c).catch(() => {});
    }

    for (let i = 0; i < actionsToEnqueue.length; i += 50) {
      await base44.asServiceRole.entities.RuleExecution.bulkCreate(actionsToEnqueue.slice(i, i + 50));
    }

    return Response.json({
      ok: true,
      correlationId,
      active_rules: activeRules.length,
      data_age_hours: Math.round(dataAge),
      total_active_budget: Math.round(totalActiveBudget * 100) / 100,
      suggested_total_budget: suggestedTotalBudget,
      budget_within_limits: totalActiveBudget <= MAX_TOTAL_DAILY_BUDGET,
      stats,
      conflicts_resolved: conflicts.length,
      actions_enqueued: actionsToEnqueue.length,
    });

  } catch (error) {
    console.error('[runDeterministicDecisionEngine]', error.message);
    return Response.json({ ok: false, error: error.message, correlationId }, { status: 500 });
  }
});