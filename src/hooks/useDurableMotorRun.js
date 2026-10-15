import { useCallback, useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';
import {
  getDurableMotorExecution,
  isDurableMotorRunActive,
  listDurableMotorExecutions,
  startDurableMotorExecution,
} from '@/lib/durableMotorExecution';

export function useDurableMotorRun(accountId) {
  const [run, setRun] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!accountId) return undefined;
    let alive = true;
    listDurableMotorExecutions(base44, accountId, 5)
      .then((runs) => {
        if (alive) setRun((current) => current || runs.find(isDurableMotorRunActive) || runs[0] || null);
      })
      .catch((cause) => { if (alive) setError(cause.message); });
    return () => { alive = false; };
  }, [accountId]);

  useEffect(() => {
    if (!accountId || !run?.id || !isDurableMotorRunActive(run)) return undefined;
    let alive = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const current = await getDurableMotorExecution(base44, run.id);
        if (alive) { setRun(current); setError(null); }
      } catch (cause) {
        if (alive) setError(`Consulta indisponível; a execução continua registrada (${cause.message}).`);
      } finally { polling = false; }
    };
    const timer = setInterval(poll, 5_000);
    void poll();
    return () => { alive = false; clearInterval(timer); };
  }, [accountId, run?.id, run?.status]);

  const start = useCallback(async (functionName, payload = {}) => {
    if (!accountId) throw new Error('Selecione uma conta Amazon antes de iniciar o motor.');
    setError(null);
    const accepted = await startDurableMotorExecution(base44, {
      functionName, accountId, payload,
      requestKey: payload.correlation_id,
    });
    setRun({
      id: accepted.run_id,
      status: accepted.status,
      function_name: functionName,
      current_stage: null,
      accepted_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      status_url: accepted.status_url,
    });
    return accepted;
  }, [accountId]);

  return { run, error, setError, start };
}
