// syncAll — delega a sincronização completa ao Xano (único gateway Amazon)
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id } = body;
    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    const xanoBase = Deno.env.get('XANO_BASE_URL') || 'https://x8ki-letl-twmt.n7.xano.io/api:living-finds-api';

    // Chamar o endpoint de sync do Xano — ele é quem fala com a Amazon
    const syncRes = await fetch(`${xanoBase}/sync/full-daily`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amazon_account_id }),
    });

    const syncData = await syncRes.json().catch(() => ({}));

    // Actualizar timestamp na entidade local
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: user.id });
    if (accounts.length > 0) {
      await base44.asServiceRole.entities.AmazonAccount.update(accounts[0].id, {
        last_sync_at: new Date().toISOString(),
        status: syncRes.ok ? 'connected' : 'error',
      });
    }

    // Registar evento de sync
    await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id,
      operation: 'xano_full_sync',
      status: syncRes.ok ? 'success' : 'error',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      error_message: syncRes.ok ? null : (syncData.message || `HTTP ${syncRes.status}`),
    });

    return Response.json({ ok: syncRes.ok, xano: syncData });
  } catch (error) {
    return Response.json({ ok: false, message: error.message || 'syncAll failed' }, { status: 500 });
  }
});