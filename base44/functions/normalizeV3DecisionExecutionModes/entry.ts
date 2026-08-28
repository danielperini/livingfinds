import {
  createClientFromRequest,
} from 'npm:@base44/sdk@0.8.40';

const BID_ACTIONS = new Set([
  'set_bid',
  'reduce_bid',
  'increase_bid',
  'update_bid',
]);

const BUDGET_ACTIONS = new Set([
  'set_budget',
  'update_budget',
  'reduce_budget',
  'increase_budget',
]);

Deno.serve(async(request) => {

  const started =
    Date.now();

  try {

    const base44 =
      createClientFromRequest(
        request
      );

    const body =
      await request
        .json()
        .catch(
          () => ({})
        );

    if(!body._service_role) {

      const authenticated =
        await base44.auth
          .isAuthenticated()
          .catch(
            () => false
          );

      if(!authenticated) {

        return Response.json(
          {
            ok:false,
            error:'Não autorizado',
          },
          {
            status:401,
          }
        );
      }
    }

    const accounts =
      body.amazon_account_id
        ? await base44
            .asServiceRole
            .entities
            .AmazonAccount
            .filter(
              {
                id:
                  body.amazon_account_id,
              },
              undefined,
              1
            )

        : await base44
            .asServiceRole
            .entities
            .AmazonAccount
            .filter(
              {
                status:'connected',
              },
              '-updated_at',
              50
            );

    const reports:any[]=[];

    for(const account of accounts) {

      const aid =
        String(
          account.id
        );

      const statuses = [
        'approved',
        'waiting_retry',
        'skipped',
      ];

      const rows:any[]=[];

      for(const status of statuses) {

        const found =
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
              3000
            )
            .catch(
              () => []
            );

        rows.push(
          ...found
        );
      }

      const cutoff =
        Date.now() -
        48 * 60 * 60 * 1000;

      let normalized=0;
      let restored=0;
      let untouched=0;

      const samples:any[]=[];

      for(const row of rows) {

        const created =
          new Date(
            row.created_at ||
            row.created_date ||
            0
          ).getTime();

        if(
          Number.isFinite(created) &&
          created > 0 &&
          created < cutoff
        ) {
          untouched++;
          continue;
        }

        const action =
          String(
            row.action ||
            ''
          );

        const mode =
          String(
            row.execution_mode ||
            ''
          );

        const error =
          String(
            row.error_message ||
            ''
          );

        const isBid =
          BID_ACTIONS.has(
            action
          );

        const isBudget =
          BUDGET_ACTIONS.has(
            action
          );

        if(
          !isBid &&
          !isBudget
        ) {
          untouched++;
          continue;
        }

        const badMode =
          ![
            'EXPEDITED_QUEUE',
            'STANDARD_QUEUE',
            'SCHEDULED_WINDOW',
          ].includes(
            mode
          );

        const modeRejected =
          error.includes(
            'EXECUTION_MODE_NOT_ALLOWED'
          );

        if(
          !badMode &&
          !modeRejected
        ) {
          untouched++;
          continue;
        }

        const update:any = {
          execution_mode:
            'STANDARD_QUEUE',

          approval_status:
            'auto_approved',

          autopilot_authorized:
            true,

          requires_approval:
            false,

          confirmation_required:
            true,

          error_message:
            'V3_EXECUTION_MODE_NORMALIZED: ação autônoma enviada pela STANDARD_QUEUE canônica.',
        };

        /*
         * Se tinha sido SKIPPED exclusivamente por
         * execution_mode inválido, devolver para fila.
         */
        if(
          String(
            row.status ||
            ''
          ).toLowerCase()
          ===
          'skipped'
          &&
          modeRejected
        ) {

          update.status =
            'approved';

          update.queue_status =
            'pending';

          restored++;
        }

        /*
         * waiting_retry pode ser aprovado imediatamente
         * se o único problema registrado era mode.
         */
        else if(
          String(
            row.status ||
            ''
          ).toLowerCase()
          ===
          'waiting_retry'
          &&
          modeRejected
        ) {

          update.status =
            'approved';

          update.queue_status =
            'pending';

          update.next_retry_at =
            null;

          restored++;
        }

        await base44
          .asServiceRole
          .entities
          .OptimizationDecision
          .update(
            row.id,
            update
          );

        normalized++;

        if(samples.length < 30) {
          samples.push({
            id:
              row.id,

            action,

            before_mode:
              mode,

            after_mode:
              'STANDARD_QUEUE',

            restored_to_queue:
              Boolean(
                update.status ===
                'approved'
              ),
          });
        }
      }

      reports.push({
        amazon_account_id:
          aid,

        scanned:
          rows.length,

        normalized,

        restored_to_queue:
          restored,

        untouched,

        samples,
      });
    }

    return Response.json({
      ok:true,

      policy:
        'bid_and_budget_actions_use_standard_queue',

      reports,

      duration_ms:
        Date.now() -
        started,
    });

  }

  catch(error:any) {

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
        status:500,
      }
    );
  }
});
