import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// Scheduled function — runs daily, no user auth required
Deno.serve(async (req) => {
  const startTime = Date.now();
  const results = {};
  const errors = [];

  try {
    // Use service role for scheduled operations
    const base44 = createClientFromRequest(req);

    const body2 = await req.json().catch(() => ({}));
    const targetAccountId = body2.amazon_account_id;

    // Filtrar por conta específica se passado, senão todas as conectadas
    const accountFilter = targetAccountId ? { id: targetAccountId, status: 'connected' } : { status: 'connected' };
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(accountFilter);

    if (accounts.length === 0) {
      return Response.json({ ok: true, message: 'No connected accounts to sync', accounts: 0 });
    }

    const today = new Date().toISOString().slice(0, 10);
    let syncsToday = 0;

    for (const account of accounts) {
      try {
        // Verificar limite de syncs automáticos (6/dia)
        const todaySyncs = await base44.asServiceRole.entities.SyncExecutionLog.filter({
          amazon_account_id: account.id,
          execution_date: today,
          status: { $in: ['success', 'started'] },
        });

        if (todaySyncs.length >= 6) {
          console.log(`[syncFullDaily] Conta ${account.id}: limite diário atingido (${todaySyncs.length}/6)`);
          results[account.id] = { skipped: 'Limite diário de 6 syncs atingido' };
          continue;
        }

        syncsToday++;
        const syncResult = await base44.functions.invoke('syncAds', { amazon_account_id: account.id, trigger_type: 'automatic' });
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
      syncs_executed: syncsToday,
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