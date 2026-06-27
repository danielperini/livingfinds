import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id } = body;
    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    const mode = Deno.env.get('OPERATION_MODE') || 'mock';

    const results = {};

    // Invoke individual sync functions
    const syncAds = await base44.functions.invoke('syncAds', { amazon_account_id });
    results.ads = syncAds;

    // Update account last_sync_at
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: user.id });
    if (accounts.length > 0) {
      await base44.asServiceRole.entities.AmazonAccount.update(accounts[0].id, {
        last_sync_at: new Date().toISOString(),
        status: 'connected',
      });
    }

    // Run learner after sync
    await base44.functions.invoke('runLearnerCycle', { amazon_account_id }).catch(() => {});

    return Response.json({ ok: true, mode, results });
  } catch (error) {
    return Response.json({ ok: false, message: error.message || 'syncAll failed' }, { status: 500 });
  }
});