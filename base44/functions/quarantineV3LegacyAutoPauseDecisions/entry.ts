import {
  createClientFromRequest,
} from 'npm:@base44/sdk@0.8.40';

const OPEN = [
  'approved',
  'scheduled',
  'waiting_retry',
  'pending',
  'retry',
  'skipped',
];

Deno.serve(async(req) => {

  const started=
    Date.now();

  try {

    const base44=
      createClientFromRequest(req);

    const body=
      await req.json()
        .catch(() => ({}));

    if(body._service_role !== true) {

      return Response.json(
        {
          ok:false,
          error:'service role required'
        },
        {
          status:403
        }
      );
    }

    const accounts=
      body.amazon_account_id

        ? await base44
            .asServiceRole
            .entities
            .AmazonAccount
            .filter(
              {
                id:
                  body.amazon_account_id
              },
              undefined,
              1
            )

        : await base44
            .asServiceRole
            .entities
            .AmazonAccount
            .list(
              '-created_date',
              50
            );

    const reports:any[]=[];

    for(const account of accounts) {

      const aid=
        String(account.id);

      const rows:any[]=[];

      for(const status of OPEN) {

        const found=
          await base44
            .asServiceRole
            .entities
            .OptimizationDecision
            .filter(
              {
                amazon_account_id:
                  aid,

                status,
              },
              '-created_at',
              5000
            )
            .catch(() => []);

        rows.push(
          ...found
        );
      }

      let quarantined=0;

      const samples:any[]=[];

      for(const row of rows) {

        const action=
          String(
            row.action ||
            ''
          );

        if(
          action !==
          'pause_campaign'
        )
          continue;

        const source=
          String(
            row.source_function ||
            ''
          );

        const rule=
          String(
            row.rule_key ||
            ''
          );

        const decisionType=
          String(
            row.decision_type ||
            ''
          );

        /*
         * Somente as pausas criadas pelos allocators/
         * consolidadores experimentais recentes.
         *
         * NÃO tocar hard guards de estoque,
         * listing, kill switch etc.
         */
        const legacyPortfolioPause=
          source ===
            'runV3SkuPortfolioAllocator'
          ||
          rule ===
            'ONE_ACTIVE_AUTO_PER_SKU_KEEP_BEST'
          ||
          rule ===
            'ONE_ACTIVE_AUTO_PER_SKU_TRANSACTIONAL'
          ||
          decisionType ===
            'portfolio_remove_duplicate_auto';

        if(!legacyPortfolioPause)
          continue;

        await base44
          .asServiceRole
          .entities
          .OptimizationDecision
          .update(
            row.id,
            {
              status:
                'superseded',

              approval_status:
                'superseded_portfolio_reconciliation',

              requires_approval:
                false,

              error_message:
                'SUPERSEDED_PORTFOLIO_PAUSE: pausa antiga neutralizada antes da reconstrução transacional da cobertura AUTO.',
            }
          );

        quarantined++;

        if(samples.length < 50) {

          samples.push({
            id:
              row.id,

            campaign_id:
              row.campaign_id,

            asin:
              row.asin,

            source_function:
              source,

            rule_key:
              rule,

            previous_status:
              row.status,
          });
        }
      }

      reports.push({
        amazon_account_id:
          aid,

        scanned:
          rows.length,

        quarantined,

        samples,
      });
    }

    return Response.json({
      ok:true,

      policy:
        'supersede_legacy_portfolio_pause_before_auto_recovery',

      reports,

      duration_ms:
        Date.now() -
        started,
    });

  } catch(error:any) {

    return Response.json(
      {
        ok:false,

        error:
          error?.message ||
          String(error),

        duration_ms:
          Date.now() -
          started,
      },
      {
        status:500
      }
    );
  }
});
