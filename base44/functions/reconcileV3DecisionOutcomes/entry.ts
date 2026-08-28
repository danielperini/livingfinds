import {
  createClientFromRequest,
} from 'npm:@base44/sdk@0.8.40';

const RECOVERABLE = new Set([
  'STALE_DATA',
  'ADS_DATA_STALE',
  'SP_API_DATA_STALE',
  'ECONOMICS_DATA_STALE',

  'ECONOMICS_INCOMPLETE',
  'LOW_ECONOMIC_CONFIDENCE',
  'ECONOMIC_CONFIDENCE',

  'SNAPSHOT_REQUIRED',
  'SNAPSHOT_MISSING',

  'STRUCTURE_INCOMPLETE',
  'COMPETITION_STALE',
  'PREDICTION_CONFIDENCE',

  'COOLDOWN_ACTIVE',
]);

const HARD = new Set([
  'ACCOUNT_KILL_SWITCH',
  'ACCOUNT_DAILY_CAP',

  'OUT_OF_STOCK',
  'NOT_BUYABLE',

  'PRODUCT_NOT_ELIGIBLE',
  'LISTING_INACTIVE',
  'OFFER_INACTIVE',

  'SAFE_CPC_CEILING',
  'SAFE_CPC_EXCEEDED',
  'ECONOMIC_CEILING',
  'MARGIN_FLOOR',

  'PARENT_ASIN',
]);

function text(
  row:any,
):string {
  return [
    row.error_message,
    row.rationale,
    row.reason,
    row.approval_status,
  ]
    .filter(Boolean)
    .join(' ')
    .toUpperCase();
}

function codes(
  row:any,
):string[] {

  const value=
    text(row);

  const all=[
    ...RECOVERABLE,
    ...HARD,
  ];

  return all.filter(
    code =>
      value.includes(code)
  );
}

function entityKey(
  row:any,
):string {

  return [
    row.amazon_account_id || '',
    row.campaign_id || '',
    row.keyword_id ||
      row.entity_id ||
      row.asin ||
      '',
    row.action || '',
  ].join('|');
}

Deno.serve(async(request) => {

  const started=
    Date.now();

  try {

    const base44=
      createClientFromRequest(
        request
      );

    const body=
      await request
        .json()
        .catch(
          () => ({})
        );

    if(!body._service_role) {

      const auth=
        await base44.auth
          .isAuthenticated()
          .catch(
            () => false
          );

      if(!auth) {
        return Response.json(
          {
            ok:false,
            error:'Não autorizado',
          },
          {
            status:401
          }
        );
      }
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
            .filter(
              {
                status:'connected'
              },
              '-updated_at',
              50
            );

    const results:any[]=[];

    for(const account of accounts) {

      const aid=
        String(
          account.id
        );

      /*
       * Examinar decisões recentes que foram apresentadas
       * como bloqueadas/canceladas/expiradas.
       */
      const statuses=[
        'blocked',
        'cancelled',
        'expired',
        'waiting_retry',
        'approved',
      ];

      const rows:any[]=[];

      for(const status of statuses) {

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
              1000
            )
            .catch(
              () => []
            );

        rows.push(
          ...found
        );
      }

      const cutoff=
        Date.now() -
        24 * 60 * 60 * 1000;

      const recent=
        rows.filter(
          row => {

            const when=
              new Date(
                row.created_at ||
                row.created_date ||
                row.updated_at ||
                0
              ).getTime();

            return (
              Number.isFinite(when)
              &&
              when >= cutoff
            );
          }
        );

      let recoverable=0;
      let protectedCount=0;
      let superseded=0;
      let deduplicated=0;

      /*
       * --------------------------------------------------
       * DEDUPLICAÇÃO
       * --------------------------------------------------
       *
       * Uma campanha/keyword não deve aparecer 6 vezes
       * como "Bloqueado".
       */
      const groups=
        new Map<
          string,
          any[]
        >();

      for(const row of recent) {

        const key=
          entityKey(row);

        if(
          !groups.has(key)
        ) {
          groups.set(
            key,
            []
          );
        }

        groups
          .get(key)!
          .push(row);
      }

      for(
        const group
        of groups.values()
      ) {

        group.sort(
          (a,b) =>
            new Date(
              b.created_at ||
              b.created_date ||
              0
            ).getTime()
            -
            new Date(
              a.created_at ||
              a.created_date ||
              0
            ).getTime()
        );

        /*
         * Manter somente o registro mais recente.
         */
        for(
          const old
          of group.slice(1)
        ) {

          const status=
            String(
              old.status ||
              ''
            ).toLowerCase();

          if(
            [
              'blocked',
              'cancelled',
              'expired',
            ].includes(status)
          ) {

            await base44
              .asServiceRole
              .entities
              .OptimizationDecision
              .update(
                old.id,
                {
                  status:
                    'superseded',

                  approval_status:
                    'duplicate_superseded',

                  error_message:
                    'SUPERSEDED_DUPLICATE: uma decisão mais recente para a mesma entidade substituiu este registro.',
                }
              )
              .catch(
                () => {}
              );

            deduplicated++;
          }
        }
      }

      /*
       * --------------------------------------------------
       * RECLASSIFICAR ÚLTIMA DECISÃO DE CADA ENTIDADE
       * --------------------------------------------------
       */
      for(
        const group
        of groups.values()
      ) {

        const row=
          group[0];

        if(!row)
          continue;

        const status=
          String(
            row.status ||
            ''
          )
            .toLowerCase();

        if(
          ![
            'blocked',
            'cancelled',
            'expired',
            'waiting_retry',
          ].includes(status)
        )
          continue;

        const blockers=
          codes(row);

        const hasHard=
          blockers.some(
            code =>
              HARD.has(code)
          );

        const hasRecoverable=
          blockers.some(
            code =>
              RECOVERABLE.has(code)
          );

        /*
         * -----------------------------------------------
         * HARD GUARD REAL
         * -----------------------------------------------
         *
         * Não existe ação Ads produtiva.
         *
         * Isso é PROTEÇÃO, não decisão bloqueada.
         */
        if(hasHard) {

          await base44
            .asServiceRole
            .entities
            .OptimizationDecision
            .update(
              row.id,
              {
                status:
                  'protected',

                approval_status:
                  'protection_only',

                requires_approval:
                  false,

                error_message:
                  `V3_PROTECTION: ${blockers.join(',')}. Nenhuma decisão executável permanece aberta enquanto o hard guard existir.`,
              }
            )
            .catch(
              () => {}
            );

          protectedCount++;

          continue;
        }

        /*
         * -----------------------------------------------
         * BLOCKER REPARÁVEL
         * -----------------------------------------------
         *
         * Não CANCELAR.
         *
         * Atualizar dados e tentar novamente.
         */
        if(
          hasRecoverable
          ||
          status === 'expired'
        ) {

          await base44
            .asServiceRole
            .entities
            .OptimizationDecision
            .update(
              row.id,
              {
                status:
                  'waiting_retry',

                approval_status:
                  'automatic_reassessment',

                requires_approval:
                  false,

                next_retry_at:
                  new Date(
                    Date.now() +
                    10 * 60 * 1000
                  ).toISOString(),

                error_message:
                  `V3_AUTOMATIC_REASSESSMENT: ${blockers.join(',') || 'dados/decisão obsoletos'}. Atualizar evidências e recalcular alternativa.`,
              }
            )
            .catch(
              () => {}
            );

          recoverable++;

          continue;
        }

        /*
         * -----------------------------------------------
         * CANCELADO/BLOQUEADO SEM HARD GUARD IDENTIFICADO
         * -----------------------------------------------
         *
         * Isso é incoerência.
         *
         * => SUPERSEDED
         * => motor recalcula.
         */
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
                'contradiction_redecision',

              requires_approval:
                false,

              error_message:
                'V3_CONTRADICTION_REDECISION: decisão bloqueada/cancelada sem hard guard terminal identificado; remover decisão antiga e recalcular alternativa.',
            }
          )
          .catch(
            () => {}
          );

        superseded++;
      }

      /*
       * --------------------------------------------------
       * REFRESH AUTOMÁTICO SE HÁ BLOQUEIO RECUPERÁVEL
       * --------------------------------------------------
       */
      let refreshed=false;

      if(recoverable > 0) {

        await base44
          .asServiceRole
          .functions
          .invoke(
            'syncAmazonIntradayCampaignMetrics',
            {
              _service_role:true,
              action:'auto',
              trigger_type:
                'v3_block_recovery'
            }
          )
          .catch(
            () => null
          );

        await base44
          .asServiceRole
          .functions
          .invoke(
            'syncAdsCampaignStatesV2',
            {
              _service_role:true,
              trigger_type:
                'v3_block_recovery'
            }
          )
          .catch(
            () => null
          );

        refreshed=true;
      }

      results.push({
        amazon_account_id:
          aid,

        scanned:
          recent.length,

        recoverable_to_retry:
          recoverable,

        hard_to_protection:
          protectedCount,

        contradiction_superseded:
          superseded,

        duplicates_superseded:
          deduplicated,

        refreshed,
      });
    }

    return Response.json({
      ok:true,

      policy:
        'recoverable_retry_hard_protection_contradiction_redecision',

      results,

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
        status:500
      }
    );
  }
});
