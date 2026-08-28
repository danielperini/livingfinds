import {
  createClientFromRequest
} from 'npm:@base44/sdk@0.8.40';

import {
  productAdsEligibility
} from '../../shared/productAdsEligibility.ts';

const QUEUES = [
  'ProductKickoffQueue',
  'AutoCampaignRepairQueue',
  'KeywordRepairQueue',
];

const RETRYABLE =
  /(\b429\b|rate.?limit|throttl|timeout|timed.?out|network|temporar|\b502\b|\b503\b|\b504\b|\b524\b|connection reset|circuit.?open|socket|econn|fetch failed)/i;

function norm(v:any){
  return String(v || '')
    .trim()
    .toLowerCase();
}

function upper(v:any){
  return String(v || '')
    .trim()
    .toUpperCase();
}

function errorText(row:any){
  return String(
    row?.last_error ||
    row?.error_code ||
    ''
  ).trim();
}

function campaignId(row:any){
  return String(
    row?.campaign_id ||
    row?.amazon_campaign_id ||
    ''
  );
}

function campaignInactive(c:any){
  return [
    'paused',
    'archived',
    'deleted',
    'inactive',
    'ended',
  ].includes(
    norm(
      c?.state ||
      c?.status
    )
  );
}

Deno.serve(async(request)=>{

  const started=Date.now();

  try{

    const base44:any =
      createClientFromRequest(request);

    const body:any =
      await request.json()
        .catch(()=>({}));

    if(body._service_role !== true){
      return Response.json(
        {
          ok:false,
          error:'service role required'
        },
        {status:403}
      );
    }

    const accounts =
      body.amazon_account_id

      ? await base44
          .asServiceRole
          .entities
          .AmazonAccount
          .filter(
            {id:body.amazon_account_id},
            undefined,
            1
          )

      : await base44
          .asServiceRole
          .entities
          .AmazonAccount
          .filter(
            {status:'connected'},
            '-updated_at',
            50
          )
          .catch(()=>[]);

    const reports:any[]=[];

    for(const account of accounts){

      const aid=account.id;

      const [
        products,
        campaigns
      ] = await Promise.all([

        base44
          .asServiceRole
          .entities
          .Product
          .filter(
            {amazon_account_id:aid},
            '-updated_at',
            5000
          )
          .catch(()=>[]),

        base44
          .asServiceRole
          .entities
          .Campaign
          .filter(
            {amazon_account_id:aid},
            '-updated_at',
            10000
          )
          .catch(()=>[])
      ]);

      const productByAsin=
        new Map(
          products.map(
            (p:any)=>[
              upper(p.asin),
              p
            ]
          )
        );

      const campaignById=
        new Map<string,any>();

      for(const c of campaigns){

        for(const value of [
          c.id,
          c.campaign_id,
          c.amazon_campaign_id
        ]){
          if(value){
            campaignById.set(
              String(value),
              c
            );
          }
        }
      }

      const counters:any={
        failed_seen:0,
        retry_transient:0,
        protected_stock:0,
        protected_scope:0,
        cancelled_inactive_campaign:0,
        cancelled_missing_product:0,
        recovery_once:0,
        already_recovery_failed:0,
      };

      const details:any[]=[];

      for(const entity of QUEUES){

        const rows=
          await base44
            .asServiceRole
            .entities[entity]
            .filter(
              {
                amazon_account_id:aid,
                status:'failed'
              },
              '-updated_at',
              1000
            )
            .catch(()=>[]);

        for(const row of rows){

          counters.failed_seen++;

          const now=
            new Date()
              .toISOString();

          const product=
            productByAsin.get(
              upper(row.asin)
            );

          const cid=
            campaignId(row);

          const campaign=
            cid
              ? campaignById.get(cid)
              : null;

          const err=
            errorText(row);

          const attempts=
            Number(
              row.attempt_count ||
              0
            );

          const maxAttempts=
            Math.max(
              1,
              Number(
                row.max_attempts ||
                5
              )
            );

          const patchBase:any={
            started_at:null,
            completed_at:null,
          };

          /*
           * ---------------------------------------------
           * 1. CAMPANHA JÁ INATIVA
           * ---------------------------------------------
           */
          if(
            campaign &&
            campaignInactive(campaign)
          ){

            await base44
              .asServiceRole
              .entities[entity]
              .update(
                row.id,
                {
                  ...patchBase,
                  status:'cancelled',
                  retryable:false,
                  scheduled_at:null,
                  completed_at:now,
                  error_code:
                    'V3_CAMPAIGN_INACTIVE_PROTECTED',
                  last_error:
                    `V3 encerrou fila obsoleta: campanha ${cid} está ${norm(campaign.state || campaign.status)}.`,
                }
              );

            counters
              .cancelled_inactive_campaign++;

            continue;
          }

          /*
           * ---------------------------------------------
           * 2. PRODUTO NÃO EXISTE MAIS
           * ---------------------------------------------
           */
          if(!product){

            await base44
              .asServiceRole
              .entities[entity]
              .update(
                row.id,
                {
                  ...patchBase,
                  status:'cancelled',
                  retryable:false,
                  scheduled_at:null,
                  completed_at:now,
                  error_code:
                    'V3_PRODUCT_MISSING_QUEUE_CLOSED',
                  last_error:
                    'Produto canônico não localizado; fila obsoleta encerrada.',
                }
              );

            counters
              .cancelled_missing_product++;

            continue;
          }

          const eligibility=
            productAdsEligibility(
              product
            );

          /*
           * ---------------------------------------------
           * 3. SEM ESTOQUE
           * ---------------------------------------------
           */
          if(!eligibility.inStock){

            await base44
              .asServiceRole
              .entities[entity]
              .update(
                row.id,
                {
                  ...patchBase,
                  status:'waiting_stock',
                  retryable:true,
                  scheduled_at:null,
                  error_code:
                    'V3_WAITING_STOCK',
                  last_error:
                    `Aguardando estoque: ${eligibility.reason}.`,
                }
              );

            counters
              .protected_stock++;

            continue;
          }

          /*
           * ---------------------------------------------
           * 4. HARD GUARD / ESCOPO
           * ---------------------------------------------
           */
          if(!eligibility.eligible){

            await base44
              .asServiceRole
              .entities[entity]
              .update(
                row.id,
                {
                  ...patchBase,
                  status:'cancelled',
                  retryable:false,
                  scheduled_at:null,
                  completed_at:now,
                  error_code:
                    'V3_PRODUCT_NOT_ELIGIBLE_PROTECTED',
                  last_error:
                    `Hard guard V3: ${eligibility.reason}.`,
                }
              );

            counters
              .protected_scope++;

            continue;
          }

          /*
           * ---------------------------------------------
           * 5. ERRO TRANSITÓRIO
           * ---------------------------------------------
           */
          if(
            row.retryable === true ||
            RETRYABLE.test(err)
          ){

            const delayMinutes=
              Math.min(
                30,
                2 *
                (
                  2 **
                  Math.min(
                    attempts,
                    4
                  )
                )
              );

            await base44
              .asServiceRole
              .entities[entity]
              .update(
                row.id,
                {
                  ...patchBase,
                  status:'scheduled',
                  retryable:true,
                  scheduled_at:
                    new Date(
                      Date.now() +
                      delayMinutes *
                      60_000
                    ).toISOString(),
                  error_code:
                    'V3_TRANSIENT_RETRY',
                  last_error:
                    `Retry V3 automático após erro transitório: ${err.slice(0,300)}`,
                }
              );

            counters
              .retry_transient++;

            continue;
          }

          /*
           * ---------------------------------------------
           * 6. RECOVERY TERMINAL UMA ÚNICA VEZ
           * ---------------------------------------------
           *
           * queue_window funciona como marcador persistente.
           *
           * Se já passou por este recovery e voltou a
           * falhar, NÃO reabrimos novamente.
           */
          if(
            String(
              row.queue_window ||
              ''
            ) ===
            'v3_terminal_recovery_once'
          ){

            counters
              .already_recovery_failed++;

            details.push({
              entity,
              id:row.id,
              asin:row.asin,
              error:err,
              classification:
                'REAL_FAILURE_AFTER_V3_RECOVERY'
            });

            continue;
          }

          /*
           * Produto está:
           * - em estoque;
           * - elegível;
           * - sem hard guard;
           *
           * Logo uma falha terminal antiga merece UMA
           * nova tentativa sob o runtime V3 atual.
           */
          await base44
            .asServiceRole
            .entities[entity]
            .update(
              row.id,
              {
                ...patchBase,

                status:'scheduled',

                retryable:true,

                scheduled_at:
                  new Date(
                    Date.now() +
                    15_000
                  ).toISOString(),

                attempt_count:0,

                max_attempts:
                  Math.max(
                    3,
                    maxAttempts
                  ),

                queue_window:
                  'v3_terminal_recovery_once',

                error_code:
                  'V3_TERMINAL_RECOVERY_ONCE',

                last_error:
                  `V3 reabriu uma única vez falha terminal elegível. Erro anterior: ${err.slice(0,300)}`,
              }
            );

          counters
            .recovery_once++;

          details.push({
            entity,
            id:row.id,
            asin:row.asin,
            classification:
              'V3_TERMINAL_RECOVERY_ONCE'
          });
        }
      }

      reports.push({
        amazon_account_id:aid,
        ...counters,
        details
      });
    }

    return Response.json({
      ok:true,
      engine:
        'CANONICAL_PROFIT_ENGINE_V3',
      operation:
        'OPERATIONAL_QUEUE_FAILURE_RECOVERY',
      reports,
      duration_ms:
        Date.now()-started
    });

  }catch(error:any){

    return Response.json(
      {
        ok:false,
        error:
          error?.message ||
          String(error)
      },
      {status:500}
    );
  }
});
