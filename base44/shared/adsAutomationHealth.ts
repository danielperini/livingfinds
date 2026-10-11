export type AutomationStageState = 'healthy' | 'no_actions' | 'running' | 'failed' | 'stale' | 'unknown';

export type AutomationStageHealth = {
  state: AutomationStageState;
  operation: string | null;
  latest_at: string | null;
  age_minutes: number | null;
  status: string | null;
  detail: string | null;
};

const timestamp = (row: any): number => {
  const raw = row?.completed_at || row?.started_at || row?.created_at;
  const parsed = raw ? Date.parse(String(raw)) : NaN;
  return Number.isFinite(parsed) ? parsed : NaN;
};

const isNoAction = (row: any): boolean => {
  const status = String(row?.status || '').toLowerCase();
  if (['no_action', 'no_actions', 'noop', 'no-op', 'skipped'].includes(status)) return true;
  const summary = String(row?.result_summary || '').toLowerCase();
  return /\b0 (?:ações|actions|decisões|decisions|executadas|executed|alterações|changes)\b/.test(summary)
    || /nenhuma ação|no actions? taken|sem ações/.test(summary);
};

/** Reads only the requested stage; self-generated watchdog rows are never stage evidence. */
export function assessAutomationStage(
  logs: any[],
  operationPrefixes: string | string[],
  maxAgeMinutes: number,
  now = Date.now(),
): AutomationStageHealth {
  const prefixes = Array.isArray(operationPrefixes) ? operationPrefixes : [operationPrefixes];
  const matching = (Array.isArray(logs) ? logs : [])
    .filter((row) => {
      const operation = String(row?.operation || '');
      return operation !== 'ads_automation_e2e_audit' && prefixes.some((prefix) => operation.startsWith(prefix));
    })
    .filter((row) => Number.isFinite(timestamp(row)))
    .sort((a, b) => timestamp(b) - timestamp(a));
  const latest = matching[0];
  if (!latest) {
    return { state: 'unknown', operation: null, latest_at: null, age_minutes: null, status: null, detail: 'NO_STAGE_EVIDENCE' };
  }

  const at = timestamp(latest);
  const age = Math.max(0, (now - at) / 60_000);
  const status = String(latest.status || '').toLowerCase();
  const operation = String(latest.operation || '');
  const common = {
    operation,
    latest_at: new Date(at).toISOString(),
    age_minutes: age,
    status: status || null,
  };
  if (age > maxAgeMinutes) return { ...common, state: 'stale', detail: 'STAGE_LOG_STALE' };
  if (['error', 'failed', 'failure', 'rejected'].includes(status)) {
    return { ...common, state: 'failed', detail: String(latest.error_message || 'STAGE_REPORTED_FAILURE') };
  }
  if (['pending', 'processing', 'running', 'submitted'].includes(status)) {
    return { ...common, state: 'running', detail: 'STAGE_IN_PROGRESS' };
  }
  if (isNoAction(latest)) return { ...common, state: 'no_actions', detail: 'STAGE_SUCCEEDED_WITHOUT_ACTIONS' };
  if (['success', 'completed', 'warning'].includes(status)) {
    return { ...common, state: 'healthy', detail: status === 'warning' ? 'STAGE_COMPLETED_WITH_WARNINGS' : 'STAGE_COMPLETED' };
  }
  return { ...common, state: 'unknown', detail: 'UNRECOGNIZED_STAGE_STATUS' };
}
