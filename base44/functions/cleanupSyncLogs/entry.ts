/**
 * cleanupSyncLogs — Remove logs antigos de execução de sync (>30 dias)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    
    // Verificar se é execução agendada (sem user) ou manual (com user admin)
    const user = await base44.auth.me().catch(() => null);
    if (user && user.role !== 'admin') {
      return Response.json({ error: 'Admin only' }, { status: 403 });
    }

    const cutoff = new Date(Date.now() - 30 * 86400000);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    // Buscar logs antigos
    const oldLogs = await base44.asServiceRole.entities.SyncExecutionLog.filter({
      execution_date: { $lt: cutoffStr },
    }, 'execution_date', 1000);

    // Deletar em batches de 500
    let deletedCount = 0;
    for (let i = 0; i < oldLogs.length; i += 500) {
      const batch = oldLogs.slice(i, i + 500);
      const deletePromises = batch.map(log => 
        base44.asServiceRole.entities.SyncExecutionLog.delete(log.id).catch(() => {})
      );
      await Promise.all(deletePromises);
      deletedCount += batch.length;
    }

    return Response.json({
      ok: true,
      deleted_count: deletedCount,
      cutoff_date: cutoffStr,
      message: `${deletedCount} logs de sync removidos (>30 dias)`,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});