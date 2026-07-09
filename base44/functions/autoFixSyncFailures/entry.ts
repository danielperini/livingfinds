/**
 * autoFixSyncFailures
 * Monitora o SyncExecutionLog, identifica padrões de falha por operação
 * e tenta corrigir automaticamente conforme o tipo de erro:
 *
 * - "Lock antigo" / "Lock liberado" → chama unlockStuckSyncs
 * - "error code: 1042" (DB connection) → aguarda e re-tenta syncAdsQuick
 * - "403" / "Token" / "unauthorized" → chama keepAmazonConnected (refreshes tokens)
 * - "relatório" / "PENDING" / "report" → chama syncAdsMetricsDirect
 * - Outros erros → registra para revisão manual
 *
 * Retorna um resumo das ações tomadas.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const db = base44.asServiceRole;

    const auth = await base44.auth.isAuthenticated().catch(() => false);
    if (!auth && !body._service_role) {
      return Response.json({ error: 'Não autorizado' }, { status: 401 });
    }

    // Buscar logs de erro dos últimos 7 dias
    const since7d = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const errorLogs = await db.entities.SyncExecutionLog.filter(
      { status: 'error' }, '-created_date', 200
    ).catch(() => []);

    // Filtrar apenas recentes (últimos 7 dias)
    const recentErrors = errorLogs.filter((log: any) => {
      const d = log.started_at || log.created_date;
      return d && new Date(d) >= new Date(since7d);
    });

    if (!recentErrors.length) {
      return Response.json({ ok: true, message: 'Nenhuma falha recente encontrada.', fixed: 0, summary: [] });
    }

    // Agrupar erros por tipo de falha
    const groups: Record<string, { count: number; operations: Set<string>; accountIds: Set<string>; lastError: string; lastAt: string }> = {
      lock:    { count: 0, operations: new Set(), accountIds: new Set(), lastError: '', lastAt: '' },
      db:      { count: 0, operations: new Set(), accountIds: new Set(), lastError: '', lastAt: '' },
      auth:    { count: 0, operations: new Set(), accountIds: new Set(), lastError: '', lastAt: '' },
      report:  { count: 0, operations: new Set(), accountIds: new Set(), lastError: '', lastAt: '' },
      other:   { count: 0, operations: new Set(), accountIds: new Set(), lastError: '', lastAt: '' },
    };

    for (const log of recentErrors) {
      const err = String(log.error_message || '').toLowerCase();
      const op  = log.operation || 'unknown';
      const aid = log.amazon_account_id || '';
      const at  = log.started_at || log.created_date || '';

      let type = 'other';
      if (err.includes('lock') || err.includes('liberado')) type = 'lock';
      else if (err.includes('1042') || err.includes('db') || err.includes('connection')) type = 'db';
      else if (err.includes('403') || err.includes('token') || err.includes('unauthorized') || err.includes('expired') || err.includes('refresh')) type = 'auth';
      else if (err.includes('relat') || err.includes('report') || err.includes('pending') || err.includes('425')) type = 'report';

      groups[type].count++;
      groups[type].operations.add(op);
      if (aid) groups[type].accountIds.add(aid);
      if (!groups[type].lastAt || at > groups[type].lastAt) {
        groups[type].lastAt = at;
        groups[type].lastError = log.error_message || '';
      }
    }

    // Determinar accounts únicas para corrigir
    const allAccountIds = new Set<string>();
    for (const g of Object.values(groups)) {
      for (const aid of g.accountIds) allAccountIds.add(aid);
    }
    // Fallback: buscar conta conectada se não há IDs dos logs
    if (!allAccountIds.size) {
      const accounts = await db.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1).catch(() => []);
      if (accounts[0]) allAccountIds.add(accounts[0].id);
    }

    const actions: { type: string; action: string; result: string; account_id?: string }[] = [];
    const fixes = { lock: 0, db: 0, auth: 0, report: 0, other: 0 };

    for (const accountId of allAccountIds) {
      // FIX 1 — Locks travados
      if (groups.lock.count > 0) {
        try {
          const r = await db.functions.invoke('unlockStuckSyncs', { amazon_account_id: accountId, _service_role: true });
          fixes.lock++;
          actions.push({ type: 'lock', action: 'unlockStuckSyncs', result: r?.ok ? 'ok' : (r?.message || 'executado'), account_id: accountId });
        } catch (e: any) {
          actions.push({ type: 'lock', action: 'unlockStuckSyncs', result: `erro: ${e.message}`, account_id: accountId });
        }
      }

      // FIX 2 — Token/Auth expirado
      if (groups.auth.count > 0) {
        try {
          const r = await db.functions.invoke('keepAmazonConnected', { amazon_account_id: accountId, _service_role: true });
          fixes.auth++;
          actions.push({ type: 'auth', action: 'keepAmazonConnected', result: r?.ok ? 'token renovado' : (r?.message || 'executado'), account_id: accountId });
        } catch (e: any) {
          actions.push({ type: 'auth', action: 'keepAmazonConnected', result: `erro: ${e.message}`, account_id: accountId });
        }
      }

      // FIX 3 — Falha de DB / connection error — re-tenta sync leve
      if (groups.db.count > 0) {
        try {
          const r = await db.functions.invoke('syncAdsQuick', { amazon_account_id: accountId, _service_role: true });
          fixes.db++;
          actions.push({ type: 'db', action: 'syncAdsQuick (retry)', result: r?.ok ? `ok · ${r?.campaigns_synced || 0} campanhas` : (r?.error || 'executado'), account_id: accountId });
        } catch (e: any) {
          actions.push({ type: 'db', action: 'syncAdsQuick (retry)', result: `erro: ${e.message}`, account_id: accountId });
        }
      }

      // FIX 4 — Relatórios com problema — solicita novo relatório
      if (groups.report.count > 0) {
        try {
          const r = await db.functions.invoke('syncAdsMetricsDirect', { amazon_account_id: accountId, _service_role: true });
          fixes.report++;
          actions.push({ type: 'report', action: 'syncAdsMetricsDirect', result: r?.ok ? 'solicitação enviada' : (r?.error || 'executado'), account_id: accountId });
        } catch (e: any) {
          actions.push({ type: 'report', action: 'syncAdsMetricsDirect', result: `erro: ${e.message}`, account_id: accountId });
        }
      }
    }

    const totalFixed = fixes.lock + fixes.db + fixes.auth + fixes.report;
    const now = new Date().toISOString();

    // Registrar a execução desta função no log
    await db.entities.SyncExecutionLog.create({
      amazon_account_id: [...allAccountIds][0] || '',
      operation: 'auto_fix_sync_failures',
      status: 'success',
      trigger_type: body.trigger_type || 'scheduled',
      started_at: startedAt,
      completed_at: now,
      records_processed: totalFixed,
      result_summary: JSON.stringify({
        errors_found: recentErrors.length,
        fixed: totalFixed,
        groups: {
          lock:   { count: groups.lock.count,   fixed: fixes.lock },
          auth:   { count: groups.auth.count,   fixed: fixes.auth },
          db:     { count: groups.db.count,     fixed: fixes.db },
          report: { count: groups.report.count, fixed: fixes.report },
          other:  { count: groups.other.count,  fixed: 0 },
        },
        actions: actions.slice(0, 20),
      }).slice(0, 4000),
    }).catch(() => {});

    // Montar resumo retornado
    const summary = Object.entries(groups)
      .filter(([, g]) => g.count > 0)
      .map(([type, g]) => ({
        type,
        count: g.count,
        operations: [...g.operations],
        last_error: g.lastError,
        last_at: g.lastAt,
        fixed: fixes[type as keyof typeof fixes] || 0,
        fix_applied: type === 'lock' ? 'unlockStuckSyncs' :
                     type === 'auth' ? 'keepAmazonConnected' :
                     type === 'db'   ? 'syncAdsQuick (retry)' :
                     type === 'report' ? 'syncAdsMetricsDirect' : 'nenhuma (revisão manual)',
      }));

    return Response.json({
      ok: true,
      errors_found: recentErrors.length,
      fixed: totalFixed,
      summary,
      actions,
    });
  } catch (error: any) {
    console.error('[autoFixSyncFailures]', error?.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});