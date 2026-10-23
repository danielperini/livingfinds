import { AsyncLocalStorage } from 'node:async_hooks';

type QualityRun = { excluded: Set<string>; accepted: Set<string> };
const runs = new AsyncLocalStorage<QualityRun>();

export function recordTermQualityRead(entity: string, rows: any[]) {
  const run = runs.getStore();
  if (!run) return;
  for (const row of rows) {
    const key = `${entity}:${row.id}`;
    (row.accepted ? run.accepted : run.excluded).add(key);
  }
}

/** Nested engine functions share a run; concurrent accounts never share counters. */
export async function withTermQualityRun(
  execute: () => Promise<Response>,
  persist: (summary: { filtered_count: number; accepted_count: number }) => Promise<unknown>,
): Promise<Response> {
  if (runs.getStore()) return await execute();
  return await runs.run({ excluded: new Set(), accepted: new Set() }, async () => {
    const response = await execute();
    const run = runs.getStore()!;
    if (!run.excluded.size) return response;
    const summary = { filtered_count: run.excluded.size, accepted_count: run.accepted.size };
    // Never turn a confirmed remote action into an exception/replay because audit failed.
    let audit_status = 'persisted';
    try { await persist(summary); } catch { audit_status = 'unavailable'; }
    const body = await response.clone().json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return response;
    return Response.json({ ...body, search_term_quality: { ...summary, audit_status },
      term_validation_outcome: run.accepted.size ? 'valid_terms_available' : 'invalid_terms_filtered' },
      { status: response.status, headers: response.headers });
  });
}
