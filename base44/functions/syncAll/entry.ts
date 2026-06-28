/**
 * syncAll — Delega sincronização completa ao Xano via POST /sync_all
 * O Xano é o único gateway que fala com a Amazon.
 * Payload: { amazon_account_id }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id } = body;
    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    const xanoBase = (Deno.env.get('XANO_BASE_URL') || '').replace(/\/$/, '');
    const xanoKey = Deno.env.get('XANO_API_KEY') || '';

    if (!xanoBase) return Response.json({ ok: false, error: 'XANO_BASE_URL não configurada.' }, { status: 503 });
    if (!xanoKey) return Response.json({ ok: false, error: 'XANO_API_KEY não configurada.' }, { status: 503 });

    // 1. Validar saúde antes de sincronizar
    const healthRes = await fetch(`${xanoBase}/health`, {
      headers: { 'X-API-Key': xanoKey, 'Content-Type': 'application/json' },
    });
    if (!healthRes.ok) {
      const hData = await healthRes.json().catch(() => ({}));
      await base44.asServiceRole.entities.SyncRun.create({
        amazon_account_id,
        operation: 'syncAll:healthCheck',
        status: 'error',
        error_message: `Health check falhou: ${hData.message || healthRes.status}`,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      });
      return Response.json({ ok: false, error: 'Xano health check falhou. Sync cancelado.', health: hData }, { status: 503 });
    }

    // 2. POST /sync_all no Xano
    const syncRes = await fetch(`${xanoBase}/sync_all`, {
      method: 'POST',
      headers: { 'X-API-Key': xanoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const syncData = await syncRes.json().catch(() => ({}));

    // 3. Registar resultado
    await base44.asServiceRole.entities.AmazonAccount.update(amazon_account_id, {
      last_sync_at: new Date().toISOString(),
      status: syncRes.ok ? 'connected' : 'error',
    });

    await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id,
      operation: 'syncAll:xano_sync_all',
      status: syncRes.ok ? 'success' : 'error',
      duration_ms: Date.now() - startTime,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      error_message: syncRes.ok ? null : (syncData.message || `HTTP ${syncRes.status}`),
    });

    return Response.json({ ok: syncRes.ok, xano: syncData });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});