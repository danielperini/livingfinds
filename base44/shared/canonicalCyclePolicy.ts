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

export function describeUnconfirmedCycleStage(name: string, result: unknown) {
  const value = result && typeof result === 'object' ? result as Record<string, any> : {};
  const nested = Array.isArray(value.failed_stages)
    ? value.failed_stages
    : value.stages && typeof value.stages === 'object'
      ? Object.entries(value.stages).filter(([, stage]: [string, any]) => stage?.ok === false)
        .map(([stage, details]: [string, any]) => ({ stage, ...details }))
      : [];
  const details = nested.slice(0, 8).map((item: any) => ({
    stage: String(item?.stage || item?.name || 'unknown_stage').slice(0, 100),
    error: String(item?.error || item?.reason || 'stage_returned_ok_false')
      .replace(/Bearer\\s+[A-Za-z0-9._~+\\/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/(refresh_token|client_secret|access_token)[=:]\\s*[^\\s,}]+/gi, '$1=[REDACTED]')
      .replace(/[\\r\\n\\t]+/g, ' ')
      .slice(0, 300),
  }));
  const fallbackError = value.error || value.reason ||
    (details.length ? `${details.length} child stage(s) failed` : 'stage_not_confirmed');
  return {
    stage: name,
    ok: false,
    error: String(fallbackError).slice(0, 400),
    details,
  };
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
