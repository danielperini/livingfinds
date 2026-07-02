/**
 * unlockStuckSyncs — Libera locks de sync e autopilot travados.
 * Regra: started_at > 30 min → liberar. Apenas admins.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
    const amazonAccountId = body.amazon_account_id;
    const now = new Date().toISOString();
    const LOCK_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutos
    const RUN_THRESHOLD_MS = 60 * 60 * 1000;  // 60 minutos

    let syncReleased = 0;
    let runReleased = 0;
    const details = [];

    // 1. Liberar SyncExecutionLog travados (> 30 min)
    const stuckSyncs = await base44.asServiceRole.entities.SyncExecutionLog.filter({ status: 'started' }, '-started_at', 50);
    for (const s of stuckSyncs) {
      if (amazonAccountId && s.amazon_account_id !== amazonAccountId) continue;
      const ageMs = Date.now() - new Date(s.started_at || s.created_date).getTime();
      if (ageMs >= LOCK_THRESHOLD_MS) {
        await base44.asServiceRole.entities.SyncExecutionLog.update(s.id, {
          status: 'error',
          completed_at: now,
          error_message: `Lock antigo liberado automaticamente após ${Math.round(ageMs / 60000)} minutos`,
        });
        syncReleased++;
        details.push({ type: 'sync', id: s.id, operation: s.operation, age_minutes: Math.round(ageMs / 60000) });
      }
    }

    // 2. Liberar AutopilotRun travados (> 60 min)
    const stuckRuns = await base44.asServiceRole.entities.AutopilotRun.filter({ status: 'running' }, '-started_at', 20);
    for (const r of stuckRuns) {
      if (amazonAccountId && r.amazon_account_id !== amazonAccountId) continue;
      const ageMs = Date.now() - new Date(r.started_at || r.created_date).getTime();
      if (ageMs >= RUN_THRESHOLD_MS) {
        await base44.asServiceRole.entities.AutopilotRun.update(r.id, {
          status: 'failed',
          completed_at: now,
          error_message: `Run liberado automaticamente após ${Math.round(ageMs / 60000)} minutos`,
        });
        runReleased++;
        details.push({ type: 'autopilot_run', id: r.id, age_minutes: Math.round(ageMs / 60000) });
      }
    }

    // 3. Liberar SyncRun antigos
    const stuckSyncRuns = await base44.asServiceRole.entities.SyncRun.filter({ status: 'running' }, '-started_at', 20);
    for (const sr of stuckSyncRuns) {
      if (amazonAccountId && sr.amazon_account_id !== amazonAccountId) continue;
      const ageMs = Date.now() - new Date(sr.started_at || sr.created_date).getTime();
      if (ageMs >= LOCK_THRESHOLD_MS) {
        await base44.asServiceRole.entities.SyncRun.update(sr.id, { status: 'error' });
        syncReleased++;
        details.push({ type: 'sync_run', id: sr.id, age_minutes: Math.round(ageMs / 60000) });
      }
    }

    return Response.json({
      ok: true,
      sync_released: syncReleased,
      runs_released: runReleased,
      total_released: syncReleased + runReleased,
      details,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});