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

    // Preservar logs de 180 dias para auditoria de IA
    const cutoff = new Date(Date.now() - 180 * 86400000);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    // Buscar logs antigos (>180 dias)
    const oldLogs = await base44.asServiceRole.entities.SyncExecutionLog.filter({
      execution_date: { $lt: cutoffStr },
    }, 'execution_date', 2000);

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
      retention_days: 180,
      message: `${deletedCount} logs removidos (>180 dias), histórico preservado para IA`,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});