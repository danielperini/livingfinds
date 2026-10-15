const PROGRESS_TIMEOUT_MS = 5_000;

export async function reportDurableMotorRunProgress(input: {
  runId?: string | null;
  lease?: string | null;
  stage: string;
  stageStatus: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: unknown;
  result?: Record<string, unknown>;
  remoteOutcome?: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  if (!input.runId) return;
  if (!input.lease) throw new Error('Execução durável sem lease; etapa não iniciada para evitar trabalho sem rastreio.');
  const base = Deno.env.get('MOTOR_RUNS_INTERNAL_URL') || 'http://127.0.0.1:8000';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROGRESS_TIMEOUT_MS);
  try {
    const response = await (input.fetchImpl || fetch)(
      `${base.replace(/\/$/, '')}/internal/motor-runs/${encodeURIComponent(input.runId)}/progress`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-motor-run-lease': input.lease },
        signal: controller.signal,
        body: JSON.stringify({
          stage: input.stage,
          stage_status: input.stageStatus,
          started_at: input.startedAt,
          completed_at: input.completedAt,
          duration_ms: input.durationMs,
          error: input.error ? String((input.error as Error)?.message || input.error).slice(0, 1000) : null,
          result: input.result,
          remote_outcome: input.remoteOutcome,
        }),
      },
    );
    if (!response.ok) throw new Error(`Ledger de execução recusou progresso (HTTP ${response.status}).`);
  } catch (error) {
    throw new Error(`Falha ao persistir progresso da execução: ${String((error as Error)?.message || error).slice(0, 250)}`);
  } finally {
    clearTimeout(timer);
  }
}
