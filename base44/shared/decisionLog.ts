/**
 * decisionLog.ts — Registro de decisão auditável (entregável #4).
 *
 * Grava um registro uniforme na entidade `Decision` (que já existe, com rationale/formula/
 * metrics_used) para CADA decisão automática relevante — de forma consistente e consultável.
 * Objetivo: dá pra responder "POR QUE o sistema fez X?" num só lugar (aprovou um termo, fechou
 * uma campanha em 48h, barrou uma keyword genérica, mudou um lance...).
 *
 * Nunca lança exceção: se o log falhar, a operação principal segue (auditoria não pode quebrar o fluxo).
 */

// deno-lint-ignore no-explicit-any
type Any = any;

export interface DecisionInput {
  amazon_account_id: string;
  decision_type: string; // ex.: create_campaign_manual, pause_campaign, negate_keyword, reduce_bid...
  rationale: string; // POR QUE — frase legível
  entity_type?: string; // campaign | keyword | search_term | ad_group | product
  entity_id?: string;
  entity_name?: string;
  asin?: string;
  campaign_id?: string;
  ad_group_id?: string;
  keyword_id?: string;
  search_term?: string;
  // deno-lint-ignore no-explicit-any
  metrics?: Record<string, any>; // evidências numéricas usadas (viram metrics_used em JSON)
  formula?: string;
  current_value?: number;
  proposed_value?: number;
  confidence?: number;
  priority?: 'high' | 'medium' | 'low';
  objective?: string;
  expected_impact?: string;
  risk?: string;
  status?: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed' | 'skipped';
  source?: string; // função que originou a decisão
}

/**
 * Cria um registro Decision auditável. Retorna o registro criado ou null (sem lançar).
 */
export async function logDecision(base44: Any, input: DecisionInput): Promise<Any | null> {
  try {
    const now = new Date().toISOString();
    const status = input.status ?? 'executed';
    const rec: Any = {
      amazon_account_id: input.amazon_account_id,
      decision_type: input.decision_type,
      rationale: input.rationale,
      entity_type: input.entity_type ?? null,
      entity_id: input.entity_id ?? null,
      entity_name: input.entity_name ?? null,
      asin: input.asin ?? null,
      campaign_id: input.campaign_id ?? null,
      ad_group_id: input.ad_group_id ?? null,
      keyword_id: input.keyword_id ?? null,
      search_term: input.search_term ?? null,
      metrics_used: input.metrics ? JSON.stringify(input.metrics) : null,
      formula: input.formula ?? null,
      current_value: input.current_value ?? null,
      proposed_value: input.proposed_value ?? null,
      confidence: input.confidence ?? null,
      priority: input.priority ?? 'medium',
      objective: input.objective ?? null,
      expected_impact: input.expected_impact ?? null,
      risk: input.risk ?? null,
      approval_required: false,
      status,
      source: input.source ?? null,
      executed_at: status === 'executed' ? now : null,
    };
    return await base44.asServiceRole.entities.Decision.create(rec);
  } catch (e) {
    console.warn('[decisionLog] falha ao registrar decisão (ignorado):', (e as Error)?.message);
    return null;
  }
}
