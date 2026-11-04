export const AI_OPPORTUNITY_CONFIDENCE = 0.85;
export const AI_LOSS_PREVENTION_CONFIDENCE = 0.80;

const LOSS_PREVENTION_ACTIONS = new Set([
  'reduce_bid', 'reduce_budget', 'pause_campaign', 'pause_keyword',
  'negative_exact', 'negative_keyword',
]);
const OPPORTUNITY_ACTIONS = new Set([
  'increase_bid', 'increase_budget', 'enable_campaign', 'enable_keyword',
  'create_keyword', 'apply_dayparting',
]);

function normalizedConfidence(value: unknown): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return 0;
  return raw > 1 ? raw / 100 : raw;
}

export type AiAutopilotGate = {
  allowed: boolean;
  class: 'loss_prevention' | 'opportunity' | 'neutral';
  threshold: number;
  confidence: number;
  reason: string;
};

export function evaluateAiAutopilotGate(decision: Record<string, any>): AiAutopilotGate {
  const action = String(decision.action || decision.decision_type || '').toLowerCase();
  const confidence = normalizedConfidence(decision.confidence);
  const isLoss = LOSS_PREVENTION_ACTIONS.has(action) || decision.risk_state === 'LOSS_CONFIRMED';
  const isOpportunity = OPPORTUNITY_ACTIONS.has(action);
  const className = isLoss ? 'loss_prevention' : isOpportunity ? 'opportunity' : 'neutral';
  const threshold = isLoss ? AI_LOSS_PREVENTION_CONFIDENCE : AI_OPPORTUNITY_CONFIDENCE;
  if (className === 'neutral') return { allowed: true, class: className, threshold, confidence, reason: 'AÇÃO FORA DO ESCOPO DO GATE DE IA' };
  if (confidence < threshold) return { allowed: false, class: className, threshold, confidence, reason: `AI_CONFIDENCE_BELOW_THRESHOLD:${Math.round(confidence * 100)}<${Math.round(threshold * 100)}` };
  return { allowed: true, class: className, threshold, confidence, reason: 'AI_CONFIDENCE_THRESHOLD_MET' };
}
