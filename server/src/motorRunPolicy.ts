export type MotorTerminalStatus = 'completed' | 'partial' | 'failed' | 'remote_unknown';

export function safeMotorError(value: unknown): string {
  return String((value as Error)?.message || value || 'unknown_motor_error')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/Atza\|[^\s]+/gi, '[REDACTED]')
    .replace(/(token|secret|password|authorization)\s*[:=]\s*[^,\s"]+/gi, '$1=[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ').slice(0, 700);
}

export function summarizeMotorResult(value: unknown): Record<string, unknown> {
  const result = value && typeof value === 'object' ? value as Record<string, any> : {};
  const summary: Record<string, unknown> = {};
  for (const key of ['ok','engine','engine_version','correlation_id','snapshot_run_id','daily_close','dry_run','executed','remaining','confirmed','divergences','blocked','created','updated','processed','records_processed','remote_outcome']) {
    if (result[key] !== undefined) summary[key] = result[key];
  }
  if (Array.isArray(result.failed_stages)) summary.failed_stages = result.failed_stages.slice(0, 30).map((item: any) => ({
    stage: String(item?.stage || item?.name || 'unknown').slice(0, 120),
    error: safeMotorError(item?.error || item?.message || 'stage_failed'),
  }));
  for (const key of ['items','results','actions','item_results']) {
    if (!Array.isArray(result[key])) continue;
    summary[key] = result[key].slice(0, 100).map((item: any) => {
      if (!item || typeof item !== 'object') return item;
      const safe: Record<string, unknown> = {};
      for (const field of ['id','decision_id','campaign_id','keyword_id','asin','sku','action','status','execution_status','confirmation_status','remote_state','value_before','value_after','old_value','new_value','http_status','error','reason']) {
        if (item[field] !== undefined) safe[field] = typeof item[field] === 'string' && field === 'error' ? safeMotorError(item[field]) : item[field];
      }
      return safe;
    });
  }
  if (result.error) summary.error = safeMotorError(result.error);
  if (result.report_status) summary.report_status = result.report_status;
  return summary;
}

export function terminalMotorStatus(result: Record<string, any>): MotorTerminalStatus {
  if (result.remote_outcome === 'unknown' || result.timed_out === true) return 'remote_unknown';
  const stageFailures = Array.isArray(result.failed_stages) ? result.failed_stages.length : 0;
  const stageMap = result.stages && typeof result.stages === 'object' ? Object.values(result.stages) as any[] : [];
  const anyStageFailed = stageMap.some((stage) => stage?.ok === false) || stageFailures > 0;
  if (stageMap.some((stage) => stage?.remote_outcome === 'unknown' || stage?.timed_out === true)) return 'remote_unknown';
  const itemResults = ['items','results','actions','item_results'].flatMap((key) => Array.isArray(result[key]) ? result[key] : []);
  const itemFailures = itemResults.filter((item: any) => ['failed','rejected','unknown','error'].includes(String(item?.status || item?.execution_status || item?.confirmation_status || '').toLowerCase())).length;
  if (result.ok === false || anyStageFailed || itemFailures > 0) {
    const completedStages = Object.values(result.stages || {}).filter((stage: any) => stage?.ok !== false && stage?.skipped !== true).length;
    return completedStages || Number(result.executed || 0) > 0 ? 'partial' : 'failed';
  }
  return 'completed';
}

export function classifyStageOutcome(result: Record<string, any>): 'completed' | 'partial' | 'failed' | 'remote_unknown' | 'report_pending' {
  if (result.remote_outcome === 'unknown' || result.timed_out === true) return 'remote_unknown';
  if (result.report_status === 'processing' || result.report_status === 'pending') return 'report_pending';
  if (result.ok === false && (Number(result.executed || 0) > 0 || Number(result.processed || 0) > 0)) return 'partial';
  if (result.ok === false) return 'failed';
  return 'completed';
}

export function canClaimRun(status: string, hasActiveScopeRun: boolean): boolean {
  return status === 'queued' && !hasActiveScopeRun;
}

export function recoverExpiredRun(currentStage: string | null): { status: 'interrupted' | 'remote_unknown'; remote_outcome: 'not_attempted' | 'unknown' } {
  return currentStage
    ? { status: 'remote_unknown', remote_outcome: 'unknown' }
    : { status: 'interrupted', remote_outcome: 'not_attempted' };
}

export function motorRemoteOutcome(functionName: string, result: Record<string, unknown>): string {
  if (result.remote_outcome === 'unknown') return 'unknown';
  if (result.remote_outcome === 'confirmed') return 'confirmed';
  const confirmed = Number(result.confirmed || 0);
  const executed = Number(result.executed || result.sent || 0);
  if (confirmed > 0) return 'confirmed';
  if (executed > 0) return 'sent_unconfirmed';
  // Only the queue executor can send campaign mutations in this run API.
  // Decision generation and confirmation may fail, but that alone does not mean
  // a campaign write was sent. Preserve explicit uncertainty and send counters above.
  if (functionName !== 'executeApprovedDecisionQueue') return 'not_attempted';
  // For the executor, require an explicit successful zero count before declaring
  // that no remote write was attempted.
  if (result.ok === true && (result.executed === 0 || result.sent === 0)) {
    return 'not_attempted';
  }
  return 'unknown';
}

export function motorFailureRemoteOutcome(functionName: string, timedOut: boolean): string {
  if (timedOut || functionName === 'executeApprovedDecisionQueue') return 'unknown';
  return 'not_attempted';
}
