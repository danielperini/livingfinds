import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const auth = await base44.auth.isAuthenticated().catch(() => false);

    if (!auth && !body._service_role) {
      return Response.json({ ok:false, error:'Não autorizado' }, { status:401 });
    }

    const accounts =
      await base44.asServiceRole.entities.AmazonAccount.filter(
        { status:'connected' },
        '-updated_at',
        50
      );

    let reviewed = 0;
    let cancelled = 0;
    let confirmedProtected = 0;

    const sample:any[] = [];

    for (const account of accounts) {
      const decisions =
        await base44.asServiceRole.entities.OptimizationDecision.filter(
          { amazon_account_id: account.id },
          '-created_at',
          10000
        ).catch(() => []);

      for (const d of decisions) {
        reviewed++;

        const txt = [
          d.rule_key,
          d.reason_code,
          d.rationale,
          d.error_message
        ].join(' ').toUpperCase();

        const invalidShareRule =
          txt.includes('ASIN_PORTFOLIO_CONCENTRATION') ||
          (
            txt.includes('CONCENTROU') &&
            String(d.action || '') === 'reduce_budget'
          );

        if (!invalidShareRule) continue;

        if (
          d.confirmation_status === 'confirmed' ||
          d.status === 'executed'
        ) {
          confirmedProtected++;
          continue;
        }

        await base44.asServiceRole.entities.OptimizationDecision.update(
          d.id,
          {
            status:'cancelled',
            queue_status:'none',

            approval_status:
              'cancelled_invalid_asin_share_budget_rule',

            error_message:
              'NO_DECISION: participação do ASIN no gasto total não limita o budget individual da campanha.',

            updated_at:new Date().toISOString()
          }
        ).catch(() => null);

        cancelled++;

        sample.push({
          id:d.id,
          asin:d.asin,
          campaign_id:d.campaign_id,
          action:d.action
        });
      }
    }

    return Response.json({
      ok:true,
      reviewed,
      cancelled,
      confirmed_protected:confirmedProtected,
      sample:sample.slice(0,100)
    });

  } catch (error:any) {
    return Response.json(
      { ok:false, error:error?.message || String(error) },
      { status:500 }
    );
  }
});
