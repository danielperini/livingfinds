/** Regras de confirmação do ciclo: envio de chamada não equivale a sucesso. */
export function isConfirmedCycleStage(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && (result as Record<string, unknown>).ok === true);
}

export function collectUnconfirmedCycleStages(
  stages: Record<string, unknown>,
  required: string[],
): string[] {
  return required.filter((name) => !isConfirmedCycleStage(stages[name]));
}

export function shouldRepairSkuCoverage(missingAsins: unknown, attemptCount: number, maxAttempts = 3): boolean {
  return Array.isArray(missingAsins) && missingAsins.length > 0 &&
    Number.isFinite(attemptCount) && attemptCount < maxAttempts;
}

export function shouldRecoverDailyCycle(input: {
  due: boolean;
  confirmedSuccess: boolean;
  latestAttemptAgeMinutes: number;
  attemptsToday: number;
  maxAttempts?: number;
  retryIntervalMinutes?: number;
}): boolean {
  const maxAttempts = input.maxAttempts ?? 3;
  const retryInterval = input.retryIntervalMinutes ?? 20;
  return input.due && !input.confirmedSuccess && input.attemptsToday < maxAttempts &&
    input.latestAttemptAgeMinutes >= retryInterval;
}

export function isDecisionExecutionConfirmed(executor: any, confirmation: any): boolean {
  return executor?.ok === true && executor?.skipped !== true &&
    Number(executor?.failed || 0) === 0 && Number(executor?.remaining || 0) === 0 &&
    confirmation?.ok === true && confirmation?.skipped !== true &&
    Number(confirmation?.divergences || 0) === 0;
}
