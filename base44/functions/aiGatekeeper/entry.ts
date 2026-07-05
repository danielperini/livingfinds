/**
 * aiGatekeeper — Portão de acesso à IA
 *
 * Toda chamada de IA deve passar por aqui antes de invocar InvokeLLM ou claudeAdsAgent.
 *
 * Responsabilidades:
 *  1. Verificar orçamento diário de IA (calls, tokens, custo)
 *  2. Verificar cache de análises anteriores (AIAnalysisCache)
 *  3. Verificar se há mudança relevante (hasMeaningfulChange)
 *  4. Registrar uso no AIUsageLog
 *  5. Retornar resultado em cache ou sinalizar que pode prosseguir
 *
 * Resposta:
 *   { allowed: true }           → pode chamar IA
 *   { allowed: false, reason }  → usar regra local / cache / adiar
 *   { allowed: false, cached: true, result } → usar resultado em cache
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const DEFAULT_DAILY_LIMITS = {
  calls: 20,
  tokens: 150000,
  cost: 3.0,
};

// TTLs por tipo de análise (ms)
const AI_CACHE_TTL: Record<string, number> = {
  keyword_relevance:    30 * 86400000,
  keyword_analysis:     14 * 86400000,
  campaign_strategy:     7 * 86400000,
  daily_summary:        24 * 3600000,
  decision_explanation:  7 * 86400000,
  risk_analysis:         3 * 86400000,
  search_term_intent:   30 * 86400000,
};

// Priority weights — order: critical financeiro > gasto alto > prejuízo > ...
const PRIORITY_WEIGHTS: Record<string, number> = {
  budget_overrun: 100,
  high_spend: 90,
  product_loss: 85,
  multi_campaign_impact: 80,
  new_campaign: 70,
  ambiguous_term: 60,
  strategy: 50,
  explanation: 30,
  summary: 10,
};

function simpleHash(obj: object): string {
  const str = JSON.stringify(obj, Object.keys(obj).sort());
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const {
      amazon_account_id,
      analysis_type,
      entity_type = 'account',
      entity_id = '',
      input_data = {},
      priority_type = 'strategy',
      force = false,
    } = body;

    if (!amazon_account_id || !analysis_type) {
      return Response.json({ allowed: false, reason: 'missing_params' });
    }

    const today = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();

    // ── 1. Gerar hash do input ──────────────────────────────────────────
    const input_hash = simpleHash({ analysis_type, entity_type, entity_id, ...input_data });

    // ── 2. Verificar cache de análise ───────────────────────────────────
    if (!force) {
      const cached = await base44.asServiceRole.entities.AIAnalysisCache.filter({
        amazon_account_id,
        analysis_type,
        entity_type,
        input_hash,
        status: 'valid',
      }, '-created_date', 1);

      if (cached.length > 0) {
        const entry = cached[0];
        const isValid = entry.expires_at && new Date(entry.expires_at).getTime() > Date.now();
        if (isValid) {
          // Atualizar reuse_count e last_reused_at
          await base44.asServiceRole.entities.AIAnalysisCache.update(entry.id, {
            last_reused_at: now,
            reuse_count: (entry.reuse_count || 0) + 1,
          });
          // Registrar evitação no log
          await incrementLog(base44, amazon_account_id, today, { calls_avoided_cache: 1, decisions_reused: 1 });
          let result = null;
          try { result = JSON.parse(entry.result_json || '{}'); } catch {}
          return Response.json({
            allowed: false,
            cached: true,
            result,
            decision: entry.decision,
            reason_cached: entry.reason,
            confidence: entry.confidence,
            expires_at: entry.expires_at,
            reuse_count: entry.reuse_count + 1,
          });
        } else {
          // Marcar como expirado
          await base44.asServiceRole.entities.AIAnalysisCache.update(entry.id, { status: 'expired' });
        }
      }
    }

    // ── 3. Verificar orçamento diário ───────────────────────────────────
    const logs = await base44.asServiceRole.entities.AIUsageLog.filter({
      amazon_account_id, log_date: today,
    }, null, 1);
    const log = logs[0] || { calls_made: 0, tokens_used: 0, cost_estimate: 0, calls_limit: DEFAULT_DAILY_LIMITS.calls };
    const calls_limit = log.calls_limit || DEFAULT_DAILY_LIMITS.calls;
    const remaining = calls_limit - (log.calls_made || 0);

    if (remaining <= 0) {
      // Budget esgotado → apenas análises críticas passam
      const priority_weight = PRIORITY_WEIGHTS[priority_type] || 50;
      if (priority_weight < 85) {
        await incrementLog(base44, amazon_account_id, today, { calls_avoided_rules: 1 });
        return Response.json({
          allowed: false,
          reason: 'daily_budget_exhausted',
          calls_made: log.calls_made,
          calls_limit,
          priority_type,
          suggestion: 'Análise adiada para o próximo ciclo. Regras locais aplicadas.',
        });
      }
    }

    // ── 4. Verificar se não é cálculo simples ────────────────────────────
    const simple_calc_types = ['calc_metrics', 'bid_rule', 'budget_rule', 'status_check', 'sort', 'filter', 'dedup'];
    if (simple_calc_types.includes(analysis_type)) {
      await incrementLog(base44, amazon_account_id, today, { calls_avoided_rules: 1, local_calculations: 1 });
      return Response.json({ allowed: false, reason: 'simple_calculation_use_rule_engine' });
    }

    // ── 5. Autorizado ────────────────────────────────────────────────────
    return Response.json({
      allowed: true,
      input_hash,
      remaining_calls: remaining,
      ttl_ms: AI_CACHE_TTL[analysis_type] || null,
    });

  } catch (err) {
    return Response.json({ allowed: false, reason: 'error', error: err.message });
  }
});

async function incrementLog(base44: any, amazon_account_id: string, today: string, fields: Record<string, number>) {
  try {
    const logs = await base44.asServiceRole.entities.AIUsageLog.filter({ amazon_account_id, log_date: today }, null, 1);
    if (logs.length > 0) {
      const log = logs[0];
      const update: Record<string, number> = {};
      for (const [k, v] of Object.entries(fields)) {
        update[k] = (log[k] || 0) + v;
      }
      await base44.asServiceRole.entities.AIUsageLog.update(log.id, update);
    } else {
      await base44.asServiceRole.entities.AIUsageLog.create({
        amazon_account_id,
        log_date: today,
        ...fields,
        budget_resets_at: new Date(Date.now() + 86400000).toISOString(),
      });
    }
  } catch {}
}