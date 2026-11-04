export type AiTaskClass = 'complex_decision' | 'repetitive_analysis';

export const DEFAULT_COMPLEX_MODEL = 'gpt-4o';
export const DEFAULT_FAST_MODEL = 'gpt-4o-mini';

export function selectAiModel(task: AiTaskClass, configured?: string | null): string {
  const explicit = String(configured || '').trim();
  if (explicit) return explicit;
  return task === 'complex_decision' ? DEFAULT_COMPLEX_MODEL : DEFAULT_FAST_MODEL;
}

export function aiTaskPolicy(task: AiTaskClass) {
  return task === 'complex_decision'
    ? {
        task,
        model_role: 'raciocinio_complexo',
        requires_evidence: true,
        proposal_only: true,
        min_confidence_for_opportunity: 0.85,
        min_confidence_for_loss_prevention: 0.80,
      }
    : {
        task,
        model_role: 'classificacao_resumo',
        requires_evidence: true,
        proposal_only: true,
        min_confidence_for_opportunity: 0.85,
        min_confidence_for_loss_prevention: 0.80,
      };
}
