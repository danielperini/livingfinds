import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// Scheduled function — runs daily, no user auth required
Deno.serve(async (req) => {
  const startTime = Date.now();
  const results = {};
  const errors = [];

  try {
    // Use service role for scheduled operations
    const base44 = createClientFromRequest(req);

    // For scheduled runs, use service role
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });

    if (accounts.length === 0) {
      return Response.json({ ok: true, message: 'No connected accounts to sync', accounts: 0 });
    }

    for (const account of accounts) {
      try {
        const syncResult = await base44.functions.invoke('syncAds', { amazon_account_id: account.id });
        results[account.id] = { ads: syncResult.data };

        // Run learner after sync
        await base44.functions.invoke('runLearnerCycle', { amazon_account_id: account.id }).catch(() => {});

        // Update last sync
        await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
          last_sync_at: new Date().toISOString(),
        });
      } catch (err) {
        errors.push({ account_id: account.id, error: err.message });
        await base44.asServiceRole.entities.AmazonAccount.update(account.id, {
          status: 'error',
          error_message: err.message,
        }).catch(() => {});
      }
    }

    return Response.json({
      ok: errors.length === 0,
      accounts_processed: accounts.length,
      results,
      errors,
      duration_ms: Date.now() - startTime,
    });
  } catch (error) {
    return Response.json({
      ok: false,
      message: error.message || 'Daily sync failed',
      duration_ms: Date.now() - startTime,
    }, { status: 500 });
  }
});