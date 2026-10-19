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
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/(refresh_token|client_secret|access_token)[=:]\s*[^\s,}]+/gi, '$1=[REDACTED]')
      .replace(/[\r\n\t]+/g, ' ')
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


/**
 * Keeps the deterministic cycle's completion independent from its AI diagnostic.
 * Core stage failures still block execution; an AI outage remains visible as a
 * partial supervision result but does not strand already validated decisions.
 */
export function resolveCanonicalCycleOutcome(
  failedCoreStages: unknown,
  supervisionRequired: boolean,
  supervision: unknown,
) {
  const coreOk = Array.isArray(failedCoreStages) && failedCoreStages.length === 0;
  const supervisionOk = !supervisionRequired || isConfirmedCycleStage(supervision);
  return {
    ok: coreOk,
    core_ok: coreOk,
    supervision_ok: supervisionOk,
    partial: coreOk && !supervisionOk,
  };
}

/** Preserve bounded, secret-safe details from nested decision-engine failures. */
export function collectDetailedStageFailures(
  stages: Record<string, unknown>,
  limit = 12,
): Array<{ stage: string; error: string; account_id?: string }> {
  const failures: Array<{ stage: string; error: string; account_id?: string }> = [];
  const safeError = (value: unknown) => String(value || 'stage_returned_ok_false')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(refresh_token|client_secret|access_token)[=:]\s*[^\s,}]+/gi, '$1=[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 300);
  for (const [name, raw] of Object.entries(stages)) {
    if (!raw || typeof raw !== 'object' || (raw as Record<string, unknown>).ok !== false) continue;
    const result = raw as Record<string, any>;
    let nestedFailure = false;
    if (Array.isArray(result.results)) for (const row of result.results) {
      if (!row || typeof row !== 'object' || !row.stages || typeof row.stages !== 'object') continue;
      for (const [childName, child] of Object.entries(row.stages) as Array<[string, any]>) {
        if (child?.ok !== false) continue;
        nestedFailure = true;
        failures.push({
          stage: (name + '.' + childName).slice(0, 160),
          error: safeError(child.error || child.reason),
          ...(row.amazon_account_id || row.account_id
            ? { account_id: String(row.amazon_account_id || row.account_id).slice(0, 100) }
            : {}),
        });
        if (failures.length >= limit) return failures;
      }
    }
    if (!nestedFailure) failures.push({
      stage: name.slice(0, 160),
      error: safeError(result.error || result.reason),
    });
    if (failures.length >= limit) return failures;
  }
  return failures;
}
