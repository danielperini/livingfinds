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
function validateProposedRule(rule) {
  const errors = [];
  if (!rule.rule_key || typeof rule.rule_key !== 'string') errors.push('rule_key ausente');
  if (!rule.name) errors.push('name ausente');
  if (!rule.scope) errors.push('scope ausente');
  if (typeof rule.priority !== 'number') errors.push('priority inválida');
  if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) errors.push('conditions vazio');
  if (!rule.action?.type) errors.push('action.type ausente');
  if (!ALLOWED_ACTIONS.has(rule.action?.type)) errors.push(`action.type não autorizado: ${rule.action?.type}`);
  if (typeof rule.confidence !== 'number' || rule.confidence < MIN_CONFIDENCE) errors.push(`confidence ${rule.confidence} < mínimo ${MIN_CONFIDENCE}`);
  if (!rule.rollback_condition) errors.push('rollback_condition ausente');
  if (!rule.cooldown_hours || rule.cooldown_hours < 1) errors.push('cooldown_hours inválido');

  // Validar operadores e métricas nas conditions
  for (const cond of (rule.conditions || [])) {
    if (cond.operator && !ALLOWED_OPERATORS.has(cond.operator)) errors.push(`operator não autorizado: ${cond.operator}`);
    if (cond.metric && !ALLOWED_METRICS.has(cond.metric)) errors.push(`metric não autorizada: ${cond.metric}`);
  }

  // Guardrail: ação de bid
  if (rule.action.type === 'set_bid') {
    if (rule.action.value < MIN_BID) errors.push(`bid ${rule.action.value} abaixo do mínimo ${MIN_BID}`);
    if (rule.action.value > MAX_BID) errors.push(`bid ${rule.action.value} acima do máximo ${MAX_BID}`);
  }
  if (rule.action.type === 'increase_bid_percent' && rule.action.value > 30) errors.push('aumento de bid > 30% bloqueado');
  if (rule.action.type === 'decrease_bid_percent' && rule.action.value > 30) errors.push('redução de bid > 30% bloqueado');

  return errors;
}

// ── Backtest simplificado ─────────────────────────────────────────────────────
async function backtestProposedRule(base44, rule, aid, keywords, metrics30d) {
  const result = {
    rule_key: rule.rule_key,
    records_tested: 0,
    actions_simulated: 0,
    spend_real: 0,
    spend_simulated: 0,
    passed: false,
    rejection_reasons: [],
    risk_level: 'low',
  };

  if (keywords.length < 5) {
    result.rejection_reasons.push('dados insuficientes para backtest (< 5 keywords)');
    return result;
  }

  // Simular: quantas keywords teriam sido atingidas por essa regra
  let actionsCount = 0;
  let totalSpendAffected = 0;

  for (const kw of keywords) {
    const meetsConditions = (rule.conditions || []).every(cond => {
      const val = kw[cond.metric] ?? 0;
      switch (cond.operator) {
        case 'greater_than': return val > cond.value;
        case 'greater_than_or_equal': return val >= cond.value;
        case 'less_than': return val < cond.value;
        case 'equals': return val === cond.value;
        default: return true; // operadores complexos: aprovado por padrão no backtest simples
      }
    });

    if (meetsConditions) {
      actionsCount++;
      totalSpendAffected += kw.spend || 0;
    }
  }

  result.records_tested = keywords.length;
  result.actions_simulated = actionsCount;
  result.spend_real = metrics30d.reduce((s, m) => s + (m.spend || 0), 0);

  // Estimativa de gasto simulado: aplicar ação sobre o spend afetado
  let spendFactor = 1.0;
  if (rule.action.type === 'decrease_bid_percent') spendFactor = 1 - (rule.action.value / 100) * 0.6;
  if (rule.action.type === 'increase_bid_percent') spendFactor = 1 + (rule.action.value / 100) * 0.4;
  if (rule.action.type === 'pause_keyword' || rule.action.type === 'pause_campaign') spendFactor = 0;

  result.spend_simulated = result.spend_real - totalSpendAffected * (1 - spendFactor);

  // Validações do backtest
  if (actionsCount === 0) result.rejection_reasons.push('nenhuma keyword seria afetada pela regra');
  if (actionsCount > keywords.length * 0.5) {
    result.risk_level = 'high';
    result.rejection_reasons.push(`ações excessivas: ${actionsCount}/${keywords.length} keywords afetadas (> 50%)`);
  }
  if (result.spend_simulated < 0) result.rejection_reasons.push('spend simulado negativo');

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
    const approvedRules = [];
    const rejectedRules = [];
    const backtestResults = [];

    for (const rule of rulesToCreate) {
      const validationErrors = validateProposedRule(rule);
      if (validationErrors.length > 0) {
        rejectedRules.push({ rule_key: rule.rule_key, reasons: validationErrors });
        continue;
      }

      // Backtest
      const bt = await backtestProposedRule(base44, rule, aid, sanitizedKeywords, metrics30d);
      backtestResults.push(bt);
      await base44.asServiceRole.entities.RuleBacktest.create({
        amazon_account_id: aid,
        review_id: reviewId,
        ...bt,
        period_days: 30,
      });

      if (!bt.passed) {
        rejectedRules.push({ rule_key: rule.rule_key, reasons: bt.rejection_reasons });
        continue;
      }

      approvedRules.push(rule);
    }

    // ── Publicar nova versão de regras ────────────────────────────────────
    let versionId = null;
    if (approvedRules.length > 0) {
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
      rules_proposed: rulesToCreate.length,
      rules_approved: approvedRules.length,
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
      rules_proposed: rulesToCreate.length,
      rules_approved: approvedRules.length,
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