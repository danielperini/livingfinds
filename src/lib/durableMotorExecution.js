const ACTIVE_RUN_STATUSES = new Set(['queued', 'running']);

function unwrap(result) {
  return result?.data ?? result ?? {};
}

export async function startDurableMotorExecution(base44, {
  functionName = 'runCanonicalDecisionCycle', accountId, payload = {}, requestKey,
}) {
  const accepted = unwrap(await base44.functions.invoke('startMotorExecution', {
    function_name: functionName,
    account_id: accountId,
    request_key: requestKey,
    payload: { ...payload, amazon_account_id: accountId },
  }));
  if (!accepted?.run_id) throw new Error(accepted?.error || 'O motor não devolveu o identificador da execução.');
  return accepted;
}

export async function getDurableMotorExecution(base44, runId) {
  const result = unwrap(await base44.functions.invoke('getMotorExecutionRun', { run_id: runId }));
  if (!result?.run) throw new Error(result?.error || 'Não foi possível consultar o estado da execução.');
  return result.run;
}

export async function listDurableMotorExecutions(base44, accountId, limit = 10) {
  const result = unwrap(await base44.functions.invoke('listMotorExecutions', { account_id: accountId, limit }));
  if (!Array.isArray(result?.runs)) throw new Error(result?.error || 'Não foi possível consultar o histórico de execuções.');
  return result.runs;
}

export const isDurableMotorRunActive = (run) => ACTIVE_RUN_STATUSES.has(run?.status);
