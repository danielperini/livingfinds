import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * Pipeline diário: sincroniza os dados e, em seguida, avalia campanhas sem conversão.
 * Pode substituir o job syncFullDaily no agendamento diário do Base44.
 */
Deno.serve(async (req) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });
    const results = [];

    for (const account of accounts) {
      const sync = await base44.functions.invoke('syncAds', {
        amazon_account_id: account.id,
        trigger_type: 'automatic',
      }).catch(error => ({ data: { ok: false, error: error.message } }));

      const evaluation = await base44.functions.invoke('evaluateNoConversionCampaigns', {
        amazon_account_id: account.id,
        dry_run: false,
      }).catch(error => ({ data: { ok: false, error: error.message } }));

      results.push({
        amazon_account_id: account.id,
        sync: sync.data,
        no_conversion_auto_pause: evaluation.data,
      });
    }

    return Response.json({
      ok: results.every(item => item.sync?.ok !== false && item.no_conversion_auto_pause?.ok !== false),
      accounts_processed: accounts.length,
      results,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error.message, duration_ms: Date.now() - startedAt }, { status: 500 });
  }
});
