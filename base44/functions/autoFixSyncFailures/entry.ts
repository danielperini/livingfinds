/**
 * autoFixSyncFailures
 * Corrige apenas falhas ATIVAS do SyncExecutionLog.
 * Uma operação com sucesso posterior deixa de ser tratada como incidente.
 * Estados HTTP esperados de catálogo (ex.: getListingsItem 404) não são falhas.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function logTime(log: any): number {
  return new Date(log?.completed_at || log?.started_at || log?.created_date || 0).getTime();
}

function operationKey(log: any): string {
  return String(log?.operation || log?.sync_type || log?.job_name || 'unknown').trim().toLowerCase();
}

function resultStatus(log: any): number {
  try { return Number(JSON.parse(log?.result_summary || '{}')?.status || 0); }
  catch { return 0; }
}

function expectedCatalogState(log: any): boolean {
  const op = operationKey(log);
  return op.includes('getlistingsitem') && resultStatus(log) === 404;
}

function benignLock(log: any): boolean {
  const text = `${log?.error_message || ''} ${log?.result_summary || ''}`.toLowerCase();
  return text.includes('sync lock liberado') || text.includes('lock released') || text.includes('guardrail');
}

function classify(log: any): 'lock' | 'db' | 'auth' | 'report' | 'other' {
  const err = String(log?.error_message || '').toLowerCase();
  const op = operationKey(log);
  if (err.includes('lock') || op.includes('lock')) return 'lock';
  if (err.includes('1042') || err.includes('db') || err.includes('connection')) return 'db';
  if (
    err.includes('403') || err.includes('401') || err.includes('token') ||
    err.includes('unauthorized') || err.includes('expired') || err.includes('refresh') ||
    err.includes('not authorized') || err.includes('sp_api_reauthorization_required') ||
    op.includes('token') || op.includes('auth') || op.includes('oauth')
  ) return 'auth';
  if (err.includes('relat') || err.includes('report') || err.includes('pending') || err.includes('425')) return 'report';
  return 'other';
}

Deno.serve(async (req) => {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const db = base44.asServiceRole;

    const auth = await base44.auth.isAuthenticated().catch(() => false);
    if (!auth && !body._service_role) return Response.json({ error: 'Não autorizado' }, { status: 401 });

    const sinceMs = Date.now() - 7 * 86400000;
    const filters = body.amazon_account_id ? { amazon_account_id: body.amazon_account_id } : {};
    const logs = await db.entities.SyncExecutionLog.filter(filters, '-created_date', 1000).catch(() => []);
    const recent = logs.filter((log: any) => logTime(log) >= sinceMs);
    const historicalErrors = recent.filter((log: any) => String(log?.status || '').toLowerCase() === 'error');

    // O estado atual de uma operação é o registro mais recente, independentemente
    // de ter sido sucesso ou erro. Isso impede "ressuscitar" erros já recuperados.
    const latestByOperation = new Map<string, any>();
    [...recent].sort((a: any, b: any) => logTime(b) - logTime(a)).forEach((log: any) => {
      const key = operationKey(log);
      if (!latestByOperation.has(key)) latestByOperation.set(key, log);
    });

    const activeErrors = [...latestByOperation.values()].filter((log: any) =>
      String(log?.status || '').toLowerCase() === 'error' &&
      !expectedCatalogState(log) &&
      !benignLock(log)
    );

    if (!activeErrors.length) {
      return Response.json({
        ok: true,
        message: 'Nenhuma falha ativa encontrada.',
        errors_found: 0,
        historical_errors_7d: historicalErrors.length,
        fixed: 0,
        summary: [],
      });
    }

    const groups: Record<string, { count: number; operations: Set<string>; accountIds: Set<string>; lastError: string; lastAt: string }> = {
      lock: { count: 0, operations: new Set(), accountIds: new Set(), lastError: '', lastAt: '' },
      db: { count: 0, operations: new Set(), accountIds: new Set(), lastError: '', lastAt: '' },
      auth: { count: 0, operations: new Set(), accountIds: new Set(), lastError: '', lastAt: '' },
      report: { count: 0, operations: new Set(), accountIds: new Set(), lastError: '', lastAt: '' },
      other: { count: 0, operations: new Set(), accountIds: new Set(), lastError: '', lastAt: '' },
    };

    for (const log of activeErrors) {
      const type = classify(log);
      const op = log.operation || 'unknown';
      const aid = log.amazon_account_id || '';
      const at = log.completed_at || log.started_at || log.created_date || '';
      groups[type].count++;
      groups[type].operations.add(op);
      if (aid) groups[type].accountIds.add(aid);
      if (!groups[type].lastAt || at > groups[type].lastAt) {
        groups[type].lastAt = at;
        groups[type].lastError = log.error_message || '';
      }
    }

    const allAccountIds = new Set<string>();
    for (const g of Object.values(groups)) for (const aid of g.accountIds) allAccountIds.add(aid);
    if (!allAccountIds.size && body.amazon_account_id) allAccountIds.add(String(body.amazon_account_id));
    if (!allAccountIds.size) {
      const accounts = await db.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1).catch(() => []);
      if (accounts[0]) allAccountIds.add(accounts[0].id);
    }

    const actions: { type: string; action: string; result: string; account_id?: string }[] = [];
    const fixes = { lock: 0, db: 0, auth: 0, report: 0, other: 0 };

    for (const accountId of allAccountIds) {
      if (groups.lock.count > 0) {
        try {
          const r = await db.functions.invoke('unlockStuckSyncs', { amazon_account_id: accountId, _service_role: true });
          fixes.lock++;
          actions.push({ type: 'lock', action: 'unlockStuckSyncs', result: r?.ok ? 'ok' : (r?.message || 'executado'), account_id: accountId });
        } catch (e: any) { actions.push({ type: 'lock', action: 'unlockStuckSyncs', result: `erro: ${e.message}`, account_id: accountId }); }
      }

      if (groups.auth.count > 0) {
        try {
          // keepAmazonConnected continua útil para Amazon Ads. Para SP-API, o
          // gateway central agora renova LWA automaticamente em cada chamada.
          const r = await db.functions.invoke('keepAmazonConnected', { amazon_account_id: accountId, _service_role: true });
          // Revalida SP-API com uma leitura real de inventário. Não marca como
          // corrigido só porque uma rotina de Ads executou.
          const inventory = await db.functions.invoke('syncAmazonOfferAvailability', {
            amazon_account_id: accountId,
            _service_role: true,
            max_products: 1,
          }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
          const inv = inventory?.data || inventory || {};
          if (inv.ok === false) throw new Error(inv.error || 'Revalidação SP-API falhou');
          fixes.auth++;
          actions.push({ type: 'auth', action: 'keepAmazonConnected + SP-API revalidation', result: r?.ok === false ? 'SP-API validada; Ads refresh retornou aviso' : 'credenciais revalidadas', account_id: accountId });
        } catch (e: any) { actions.push({ type: 'auth', action: 'SP-API revalidation', result: `erro: ${e.message}`, account_id: accountId }); }
      }

      if (groups.db.count > 0) {
        try {
          const r = await db.functions.invoke('syncAdsQuick', { amazon_account_id: accountId, _service_role: true });
          fixes.db++;
          actions.push({ type: 'db', action: 'syncAdsQuick (retry)', result: r?.ok ? `ok · ${r?.campaigns_synced || 0} campanhas` : (r?.error || 'executado'), account_id: accountId });
        } catch (e: any) { actions.push({ type: 'db', action: 'syncAdsQuick (retry)', result: `erro: ${e.message}`, account_id: accountId }); }
      }

      if (groups.report.count > 0) {
        try {
          const r = await db.functions.invoke('syncAdsMetricsDirect', { amazon_account_id: accountId, _service_role: true });
          fixes.report++;
          actions.push({ type: 'report', action: 'syncAdsMetricsDirect', result: r?.ok ? 'solicitação enviada' : (r?.error || 'executado'), account_id: accountId });
        } catch (e: any) { actions.push({ type: 'report', action: 'syncAdsMetricsDirect', result: `erro: ${e.message}`, account_id: accountId }); }
      }
    }

    const totalFixed = fixes.lock + fixes.db + fixes.auth + fixes.report;
    const now = new Date().toISOString();
    await db.entities.SyncExecutionLog.create({
      amazon_account_id: [...allAccountIds][0] || '',
      operation: 'auto_fix_sync_failures',
      status: 'success',
      trigger_type: body.trigger_type || 'manual',
      started_at: startedAt,
      completed_at: now,
      records_processed: totalFixed,
      result_summary: JSON.stringify({
        active_errors_found: activeErrors.length,
        historical_errors_7d: historicalErrors.length,
        fixed: totalFixed,
        groups: Object.fromEntries(Object.entries(groups).map(([type, g]) => [type, { count: g.count, fixed: fixes[type as keyof typeof fixes] || 0 }])),
        actions: actions.slice(0, 20),
      }).slice(0, 4000),
    }).catch(() => {});

    const summary = Object.entries(groups).filter(([, g]) => g.count > 0).map(([type, g]) => ({
      type,
      count: g.count,
      operations: [...g.operations],
      last_error: g.lastError,
      last_at: g.lastAt,
      fixed: fixes[type as keyof typeof fixes] || 0,
      fix_applied: type === 'lock' ? 'unlockStuckSyncs' : type === 'auth' ? 'LWA refresh + SP-API revalidation' : type === 'db' ? 'syncAdsQuick (retry)' : type === 'report' ? 'syncAdsMetricsDirect' : 'nenhuma (revisão manual)',
    }));

    return Response.json({
      ok: true,
      errors_found: activeErrors.length,
      historical_errors_7d: historicalErrors.length,
      fixed: totalFixed,
      summary,
      actions,
    });
  } catch (error: any) {
    console.error('[autoFixSyncFailures]', error?.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});