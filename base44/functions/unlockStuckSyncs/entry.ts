/**
 * unlockStuckSyncs — Verifica e desbloqueia syncs travados
 *
 * Roda a cada 15 minutos via automação agendada.
 * Detecta SyncExecutionLog com status 'started' há mais de 30 minutos
 * e marca como erro para permitir novo sync.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    // Verificar se é admin
    if (user.role !== 'admin') {
      return Response.json({ error: 'Admin only' }, { status: 403 });
    }

    const now = new Date();
    const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);

    // Buscar syncs travados (started há mais de 30 min) — sem filtro de data para pegar fins de semana
    const allStuck = await base44.asServiceRole.entities.SyncExecutionLog.filter({
      status: 'started',
    }, '-started_at', 100);

    const unlocked = [];
    const stillRunning = [];

    for (const sync of allStuck) {
      const startedAt = sync.started_at ? new Date(sync.started_at) : null;
      if (!startedAt) continue;

      const minutesRunning = (now.getTime() - startedAt.getTime()) / (1000 * 60);

      if (minutesRunning > 30) {
        // Desbloquear — marcar como erro
        await base44.asServiceRole.entities.SyncExecutionLog.update(sync.id, {
          status: 'error',
          error_message: `Sync travado por ${Math.round(minutesRunning)} min. Desbloqueado automaticamente.`,
          completed_at: now.toISOString(),
          duration_ms: now.getTime() - startedAt.getTime(),
        });

        // Atualizar AmazonAccount se existir
        if (sync.amazon_account_id) {
          await base44.asServiceRole.entities.AmazonAccount.update(sync.amazon_account_id, {
            status: 'error',
            error_message: `Sync travado por ${Math.round(minutesRunning)} min. Desbloqueado automaticamente.`,
          }).catch(() => {});
        }

        unlocked.push({
          id: sync.id,
          amazon_account_id: sync.amazon_account_id,
          minutes_running: Math.round(minutesRunning),
        });

        console.log(`[unlockStuckSyncs] Desbloqueado sync ${sync.id} (${Math.round(minutesRunning)} min)`);
      } else {
        stillRunning.push({
          id: sync.id,
          minutes_running: Math.round(minutesRunning),
        });
      }
    }

    return Response.json({
      ok: true,
      unlocked,
      still_running: stillRunning,
      total_checked: allStuck.length,
      message: `${unlocked.length} sync(s) desbloqueado(s). ${stillRunning.length} ainda rodando normalmente.`,
    });
  } catch (error) {
    console.error('[unlockStuckSyncs] Erro:', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});