import {
  createClientFromRequest
} from 'npm:@base44/sdk@0.8.40';

function num(v:any){
  const x=Number(v);
  return Number.isFinite(x)
    ? x
    : 0;
}

function upper(v:any){
  return String(v || '')
    .trim()
    .toUpperCase();
}

function lower(v:any){
  return String(v || '')
    .trim()
    .toLowerCase();
}

function firstPositive(
  ...values:any[]
){
  for(const value of values){
    const n=num(value);

    if(n>0)
      return n;
  }

  return 0;
}

function daysSince(value:any){
  if(!value)
    return 999;

  const ts=
    new Date(value).getTime();

  if(!Number.isFinite(ts))
    return 999;

  return Math.max(
    0,
    (
      Date.now()-ts
    ) /
    86_400_000
  );
}

function campaignId(c:any){
  return String(
    c.campaign_id ||
    c.amazon_campaign_id ||
    c.id ||
    ''
  );
}

function enabled(c:any){
  const state=lower(
    c.state ||
    c.status
  );

  return (
    !state ||
    state==='enabled' ||
    state==='active'
  );
}

type Phase =
  | 'NEW'
  | 'YOUNG'
  | 'MATURING'
  | 'MATURE';

function classifyPhase(input:{
  ageDays:number;
  clicks:number;
  orders:number;
  impressions:number;
}):Phase{

  /*
   * Primeiros dois dias:
   * aprendizado puro.
   */
  if(input.ageDays < 3)
    return 'NEW';

  /*
   * Jovem:
   * idade pequena OU amostra ainda insuficiente.
   */
  if(
    input.ageDays <= 7 ||
    (
      input.clicks < 12 &&
      input.orders < 2
    )
  ){
    return 'YOUNG';
  }

  /*
   * Transição gradual.
   */
  if(
    input.ageDays <= 14 ||
    (
      input.clicks < 25 &&
      input.orders < 3
    )
  ){
    return 'MATURING';
  }

  return 'MATURE';
}

function phaseTolerance(
  phase:Phase
){

  switch(phase){

    case 'NEW':
    case 'YOUNG':
      return 1.15;

    case 'MATURING':
      return 1.075;

    case 'MATURE':
    default:
      return 1.00;
  }
}

Deno.serve(async(req)=>{

  const started=Date.now();

  try{

    const base44:any=
      createClientFromRequest(req);

    const body:any=
      await req.json()
        .catch(()=>({}));

    if(
      body._service_role !== true
    ){
      return Response.json(
        {
          ok:false,
          error:'service role required'
        },
        {status:403}
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
          .filter(
            {
              status:'connected'
            },
            '-updated_at',
            50
          )
          .catch(()=>[]);

    const reports:any[]=[];

    for(const account of accounts){

      const aid=account.id;

      const [
        campaigns,
        adGroups,
        searchTerms,
        products,
        settings,
        existingDecisions
      ]=
        await Promise.all([

          base44
            .asServiceRole
            .entities
            .Campaign
            .filter(
              {
                amazon_account_id:aid
              },
              '-updated_at',
              5000
            )
            .catch(()=>[]),

          base44
            .asServiceRole
            .entities
            .AdGroup
            .filter(
              {
                amazon_account_id:aid
              },
              '-updated_at',
              10000
            )
            .catch(()=>[]),

          base44
            .asServiceRole
            .entities
            .SearchTerm
            .filter(
              {
                amazon_account_id:aid
              },
              '-date',
              30000
            )
            .catch(()=>[]),

          base44
            .asServiceRole
            .entities
            .Product
            .filter(
              {
                amazon_account_id:aid
              },
              '-updated_at',
              5000
            )
            .catch(()=>[]),

          base44
            .asServiceRole
            .entities
            .PerformanceSettings
            .filter(
              {
                amazon_account_id:aid
              },
              '-updated_at',
              1
            )
            .catch(()=>[]),

          base44
            .asServiceRole
            .entities
            .OptimizationDecision
            .filter(
              {
                amazon_account_id:aid
              },
              '-created_at',
              5000
            )
            .catch(()=>[])
        ]);

      const config=
        settings[0] || {};

      const productByAsin=
        new Map<string,any>();

      for(const product of products){

        const asin=
          upper(product.asin);

        if(asin){
          productByAsin.set(
            asin,
            product
          );
        }
      }

      const groupsByCampaign=
        new Map<string,any[]>();

      for(const group of adGroups){

        const cid=String(
          group.campaign_id ||
          ''
        );

        if(!cid)
          continue;

        const arr=
          groupsByCampaign.get(cid)
          || [];

        arr.push(group);

        groupsByCampaign.set(
          cid,
          arr
        );
      }

      /*
       * Métricas 7d.
       */
      const cutoff=
        new Date(
          Date.now()-
          7*86_400_000
        )
          .toISOString()
          .slice(0,10);

      const metrics=
        new Map<
          string,
          {
            spend:number;
            sales:number;
            clicks:number;
            impressions:number;
            orders:number;
          }
        >();

      for(const row of searchTerms){

        if(
          String(
            row.date || ''
          ) < cutoff
        ){
          continue;
        }

        const cid=String(
          row.campaign_id ||
          ''
        );

        if(!cid)
          continue;

        const m=
          metrics.get(cid)
          || {
            spend:0,
            sales:0,
            clicks:0,
            impressions:0,
            orders:0
          };

        m.spend +=
          num(row.spend);

        m.sales +=
          num(
            row.same_sku_sales ??
            row.sales_7d ??
            row.total_sales
          );

        m.clicks +=
          num(row.clicks);

        m.impressions +=
          num(row.impressions);

        m.orders +=
          num(
            row.same_sku_orders ??
            row.orders_7d ??
            row.total_orders
          );

        metrics.set(
          cid,
          m
        );
      }

      let reviewed=0;
      let newCount=0;
      let youngCount=0;
      let maturingCount=0;
      let matureCount=0;

      let bidIncreases=0;
      let reductionsSuperseded=0;

      const actions:any[]=[];

      for(const campaign of campaigns){

        if(!enabled(campaign))
          continue;

        const cid=
          campaignId(campaign);

        if(!cid)
          continue;

        reviewed++;

        const m=
          metrics.get(cid)
          || {
            spend:0,
            sales:0,
            clicks:0,
            impressions:0,
            orders:0
          };

        const ageDays=
          daysSince(
            campaign.start_date ||
            campaign.startDate ||
            campaign.creation_date ||
            campaign.created_at ||
            campaign.created_date
          );

        const phase=
          classifyPhase({
            ageDays,
            clicks:m.clicks,
            orders:m.orders,
            impressions:m.impressions
          });

        if(phase==='NEW')
          newCount++;

        if(phase==='YOUNG')
          youngCount++;

        if(phase==='MATURING')
          maturingCount++;

        if(phase==='MATURE')
          matureCount++;

        const asin=
          upper(
            campaign.asin ||
            campaign.advertised_asin
          );

        const product=
          productByAsin.get(asin);

        /*
         * CPC-alvo.
         *
         * Não inventar valor:
         * se não houver referência econômica,
         * não aumentar automaticamente.
         */
        const targetCpc=
          firstPositive(
            campaign.target_cpc,
            product?.target_cpc,
            product?.recommended_cpc,
            config.target_cpc,
            config.default_target_cpc
          );

        const safeMaxCpc=
          firstPositive(
            product?.safe_max_cpc,
            product?.safe_cpc,
            product?.break_even_cpc,
            campaign.safe_max_cpc,
            config.safe_max_cpc,
            targetCpc
              ? targetCpc*1.15
              : 0
          );

        const tolerance=
          phaseTolerance(
            phase
          );

        const learningCpcCeiling=
          (
            targetCpc>0 &&
            safeMaxCpc>0
          )
            ? Math.min(
                targetCpc *
                tolerance,
                safeMaxCpc
              )
            : 0;

        const coverageDays=
          firstPositive(
            product?.days_of_cover,
            product?.daysOfCover,
            product?.coverage_days,
            product?.stock_coverage_days
          );

        /*
         * =================================================
         * CORRIGIR REDUÇÕES PREMATURAS POR ESTOQUE
         * =================================================
         *
         * >=10 dias:
         * estoque NÃO é motivo para reduzir bid.
         */
        if(
          coverageDays >= 10
        ){

          for(
            const decision
            of existingDecisions
          ){

            const dCid=String(
              decision.campaign_id ||
              ''
            );

            if(dCid !== cid)
              continue;

            const status=lower(
              decision.status
            );

            if(
              ![
                'pending',
                'approved',
                'queued',
                'scheduled'
              ].includes(status)
            ){
              continue;
            }

            const action=lower(
              decision.action ||
              decision.canonical_action_type
            );

            if(
              !(
                action.includes(
                  'decrease'
                ) ||
                action.includes(
                  'reduce'
                )
              )
            ){
              continue;
            }

            const rationale=lower(
              [
                decision.reason_code,
                decision.rationale,
                decision.reason
              ]
                .filter(Boolean)
                .join(' ')
            );

            if(
              !(
                rationale.includes(
                  'stock'
                ) ||
                rationale.includes(
                  'estoque'
                ) ||
                rationale.includes(
                  'coverage'
                )
              )
            ){
              continue;
            }

            await base44
              .asServiceRole
              .entities
              .OptimizationDecision
              .update(
                decision.id,
                {
                  status:
                    'superseded',

                  queue_status:
                    'superseded',

                  reason_code:
                    'STOCK_COVERAGE_SUFFICIENT_NO_BID_REDUCTION',

                  rationale:
                    `${coverageDays.toFixed(1)} dias de cobertura. Estoque suficiente; redução preventiva de bid cancelada pelo V3.`,

                  updated_at:
                    new Date()
                      .toISOString()
                }
              )
              .catch(()=>{});

            reductionsSuperseded++;
          }
        }

        /*
         * MATURE:
         * nenhuma política especial de aprendizado.
         */
        if(phase==='MATURE')
          continue;

        /*
         * Zero delivery continua no lifecycle.
         *
         * Não duplicar +R$0,10 daqui.
         */
        if(
          m.impressions <= 0
        ){
          actions.push({
            campaign_id:cid,
            asin,
            phase,
            action:
              'DELEGATE_ZERO_DELIVERY_TO_LIFECYCLE'
          });

          continue;
        }

        /*
         * Sem referência econômica segura:
         * apenas observar.
         */
        if(
          targetCpc<=0 ||
          safeMaxCpc<=0 ||
          learningCpcCeiling<=0
        ){
          actions.push({
            campaign_id:cid,
            asin,
            phase,
            action:
              'LEARNING_HOLD',
            reason:
              'NO_SAFE_CPC_REFERENCE'
          });

          continue;
        }

        /*
         * Campanha jovem subexposta.
         *
         * Busca impressões, mas NÃO compra tráfego
         * sem qualquer limite.
         */
        const underExposed=
          (
            m.impressions < 500 ||
            m.clicks < 5
          );

        if(!underExposed)
          continue;

        /*
         * Se já gastou demais sem nenhuma venda,
         * não usar aprendizado como desculpa para waste.
         */
        const destructiveSpend=
          (
            m.orders === 0 &&
            m.spend >
              Math.max(
                8,
                targetCpc*12
              )
          );

        if(destructiveSpend){

          actions.push({
            campaign_id:cid,
            asin,
            phase,
            action:
              'LEARNING_STOP_SCALE',
            reason:
              'SPEND_EVIDENCE_OVERRIDES_LEARNING'
          });

          continue;
        }

        const groups=
          groupsByCampaign.get(cid)
          || [];

        for(const group of groups){

          const gid=String(
            group.ad_group_id ||
            group.amazon_ad_group_id ||
            group.id ||
            ''
          );

          if(!gid)
            continue;

          const currentBid=
            firstPositive(
              group.default_bid,
              group.bid
            );

          if(currentBid<=0)
            continue;

          /*
           * NEW/YOUNG:
           * até +10% por ciclo.
           *
           * MATURING:
           * até +5%.
           */
          const step=
            (
              phase==='NEW' ||
              phase==='YOUNG'
            )
              ? 1.10
              : 1.05;

          /*
           * V3_YOUNG_EFFECTIVE_CENT_CEILING
           *
           * ceiling 0.80 nunca gera proposed 0.81.
           */
          const effectiveLearningCeiling =
            Math.floor(
              (
                Math.min(
                  learningCpcCeiling,
                  safeMaxCpc
                ) +
                1e-9
              ) *
              100
            ) /
            100;

          let proposedBid =
            Math.min(
              currentBid * step,
              effectiveLearningCeiling
            );

          proposedBid =
            Math.min(
              effectiveLearningCeiling,
              Math.floor(
                (proposedBid + 1e-9) *
                100
              ) / 100
            );

          if(
            proposedBid <=
            currentBid
          ){
            continue;
          }

          const key=[
            'V3',
            'YOUNG_LEARNING',
            aid,
            cid,
            gid,
            phase,
            proposedBid.toFixed(2),
            new Date()
              .toISOString()
              .slice(0,10)
          ].join(':');

          const duplicate=
            await base44
              .asServiceRole
              .entities
              .OptimizationDecision
              .filter(
                {
                  amazon_account_id:
                    aid,

                  idempotency_key:
                    key
                },
                undefined,
                1
              )
              .catch(()=>[]);

          if(duplicate.length)
            continue;

          const now=
            new Date()
              .toISOString();

          const decision=
            await base44
              .asServiceRole
              .entities
              .OptimizationDecision
              .create({

                amazon_account_id:
                  aid,

                correlation_id:
                  `V3_YOUNG_${cid}_${Date.now()}`,

                campaign_id:
                  cid,

                campaign_name:
                  campaign.name ||
                  campaign.campaign_name ||
                  null,

                ad_group_id:
                  gid,

                asin,

                sku:
                  campaign.sku ||
                  campaign.advertised_sku ||
                  product?.sku ||
                  null,

                decision_type:
                  'bid_change',

                canonical_action_type:
                  'INCREASE_BID',

                action:
                  'increase_bid',

                entity_type:
                  'ad_group',

                entity_id:
                  gid,

                current_value:
                  currentBid,

                proposed_value:
                  proposedBid,

                value_before:
                  currentBid,

                value_after:
                  proposedBid,

                change_pct:
                  Number(
                    (
                      proposedBid /
                      currentBid -
                      1
                    ).toFixed(4)
                  ),

                reason_code:
                  phase === 'MATURING'
                    ? 'MATURING_LOW_EXPOSURE_SCALE'
                    : 'YOUNG_CAMPAIGN_LEARNING_SCALE',

                rationale:
                  `${phase}: campanha jovem/subexposta. Busca controlada de mais impressões. CPC-alvo=${targetCpc.toFixed(2)}, tolerância=${((tolerance-1)*100).toFixed(1)}%, ceiling=${learningCpcCeiling.toFixed(2)}, safeMax=${safeMaxCpc.toFixed(2)}.`,

                priority:
                  2,

                priority_class:
                  'P2',

                confidence:
                  0.88,

                risk:
                  'low',

                status:
                  'approved',

                approval_status:
                  'approved',

                requires_approval:
                  false,

                queue_status:
                  'pending',

                execution_mode:
                  'EXECUTE_NOW',

                confirmation_required:
                  true,

                confirmation_status:
                  'pending',

                requires_fresh_data:
                  true,

                maximum_data_age_minutes:
                  180,

                source_function:
                  'runV3YoungCampaignLearningReview',

                model_version:
                  'CANONICAL_PROFIT_ENGINE_V3',

                policy_version:
                  'PROFIT_ENGINE_V3_YOUNG_LEARNING',

                idempotency_key:
                  key,

                lock_key:
                  `ads:ad_group:${gid}`,

                rollback_plan:
                  JSON.stringify({
                    action:
                      'restore_bid',

                    ad_group_id:
                      gid,

                    bid:
                      currentBid
                  }),

                metric_window:
                  '7d',

                data_window_start:
                  cutoff,

                data_window_end:
                  new Date()
                    .toISOString()
                    .slice(0,10),

                evaluated_at:
                  now,

                approved_at:
                  now,

                queued_at:
                  now,

                created_at:
                  now,

                updated_at:
                  now
              });

          bidIncreases++;

          actions.push({
            decision_id:
              decision.id,

            campaign_id:
              cid,

            campaign:
              campaign.name ||
              campaign.campaign_name,

            asin,

            phase,

            age_days:
              Number(
                ageDays.toFixed(1)
              ),

            impressions_7d:
              m.impressions,

            clicks_7d:
              m.clicks,

            orders_7d:
              m.orders,

            target_cpc:
              targetCpc,

            safe_max_cpc:
              safeMaxCpc,

            learning_cpc_ceiling:
              Number(
                learningCpcCeiling
                  .toFixed(2)
              ),

            current_bid:
              currentBid,

            proposed_bid:
              proposedBid,

            action:
              'INCREASE_BID_FOR_LEARNING'
          });
        }
      }

      reports.push({

        amazon_account_id:
          aid,

        reviewed,

        lifecycle:{
          new:newCount,
          young:youngCount,
          maturing:maturingCount,
          mature:matureCount
        },

        bid_increases:
          bidIncreases,

        stock_reductions_superseded:
          reductionsSuperseded,

        actions
      });
    }

    return Response.json({

      ok:true,

      engine:
        'CANONICAL_PROFIT_ENGINE_V3',

      policy:
        'YOUNG_CAMPAIGN_LEARNING_V1',

      rules:{
        young_cpc_tolerance:
          0.15,

        maturing_cpc_tolerance:
          0.075,

        mature_cpc_tolerance:
          0,

        safe_cpc_always_hard_ceiling:
          true,

        zero_delivery_owner:
          'CAMPAIGN_LIFECYCLE',

        stock_days_no_preventive_reduction:
          10
      },

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
