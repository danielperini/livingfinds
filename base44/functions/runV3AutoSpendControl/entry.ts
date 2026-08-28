import {
  createClientFromRequest
} from 'npm:@base44/sdk@0.8.40';

function n(v:any){
  const x=Number(v);
  return Number.isFinite(x) ? x : 0;
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

function dateDaysAgo(days:number){
  const d=new Date();
  d.setUTCDate(
    d.getUTCDate()-days
  );
  return d.toISOString().slice(0,10);
}

function campaignId(c:any){
  return String(
    c.campaign_id ||
    c.amazon_campaign_id ||
    c.id ||
    ''
  );
}

function isAuto(c:any){

  const type=upper(
    c.amazon_targeting_type ||
    c.targeting_type ||
    c.campaign_type
  );

  const name=upper(
    c.name ||
    c.campaign_name
  );

  return (
    type.includes('AUTO') ||
    /^AUTO\s*\|/.test(name) ||
    name.includes('| AUTO |')
  );
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
        {status:401}
      );
    }

    const accounts=
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
            20
          );

    const reports:any[]=[];

    for(const account of accounts){

      const aid=account.id;

      const [
        campaigns,
        adGroups,
        searchTerms,
        settings
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
              20000
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
            .catch(()=>[])
        ]);

      const config=settings[0] || {};

      const minBid=Math.max(
        0.20,
        n(config.min_bid) || 0.25
      );

      const targetAcos=
        n(config.target_acos)
        || 15;

      const cutoff=dateDaysAgo(7);

      const groupsByCampaign=
        new Map<string,any[]>();

      for(const g of adGroups){

        const cid=String(
          g.campaign_id || ''
        );

        if(!cid) continue;

        const arr=
          groupsByCampaign.get(cid)
          || [];

        arr.push(g);

        groupsByCampaign.set(
          cid,
          arr
        );
      }

      const metrics=
        new Map<
          string,
          {
            spend:number;
            clicks:number;
            orders:number;
            sales:number;
            impressions:number;
          }
        >();

      for(const row of searchTerms){

        if(
          String(row.date || '') <
          cutoff
        ){
          continue;
        }

        const cid=String(
          row.campaign_id || ''
        );

        if(!cid) continue;

        const m=
          metrics.get(cid)
          || {
            spend:0,
            clicks:0,
            orders:0,
            sales:0,
            impressions:0
          };

        m.spend +=
          n(row.spend);

        m.clicks +=
          n(row.clicks);

        m.orders +=
          n(
            row.same_sku_orders ??
            row.orders_7d ??
            row.total_orders
          );

        m.sales +=
          n(
            row.same_sku_sales ??
            row.sales_7d ??
            row.total_sales
          );

        m.impressions +=
          n(row.impressions);

        metrics.set(
          cid,
          m
        );
      }

      let evaluated=0;
      let proposed=0;

      const decisions:any[]=[];

      for(const campaign of campaigns){

        if(!isAuto(campaign))
          continue;

        const state=lower(
          campaign.state ||
          campaign.status
        );

        if(
          state &&
          state!=='enabled' &&
          state!=='active'
        ){
          continue;
        }

        const cid=
          campaignId(campaign);

        if(!cid)
          continue;

        evaluated++;

        const m=
          metrics.get(cid)
          || {
            spend:0,
            clicks:0,
            orders:0,
            sales:0,
            impressions:0
          };

        const budget=
          n(
            campaign.daily_budget ??
            campaign.budget ??
            campaign.campaign_budget
          );

        const cpc=
          m.clicks>0
            ? m.spend/m.clicks
            : 0;

        const acos=
          m.sales>0
            ? m.spend/m.sales*100
            : (
                m.spend>0
                  ? 999
                  : 0
              );

        const asin=
          upper(
            campaign.asin ||
            campaign.advertised_asin
          );

        const sku=
          String(
            campaign.sku ||
            campaign.advertised_sku ||
            ''
          );

        /*
         * =============================================
         * DECISÃO ECONÔMICA AUTO
         * =============================================
         */

        let reductionPct=0;
        let reason='';

        /*
         * Caso específico observado:
         * B0GHP9PPWN
         *
         * 17 clicks / 0 order / orçamento consumido.
         */
        if(
          asin==='B0GHP9PPWN' &&
          m.orders===0 &&
          m.clicks>=12 &&
          (
            budget<=0 ||
            m.spend>=budget*0.80
          )
        ){
          reductionPct=0.25;

          reason=
            'AUTO_OVESPEND_B0GHP9PPWN_NO_ORDER';
        }

        /*
         * Regra geral:
         * 20+ cliques sem venda = redução forte.
         */
        else if(
          m.orders===0 &&
          m.clicks>=20 &&
          (
            budget<=0 ||
            m.spend>=budget*0.80
          )
        ){
          reductionPct=0.25;

          reason=
            'AUTO_OVESPEND_20_PLUS_CLICKS_NO_ORDER';
        }

        /*
         * 12–19 cliques sem venda.
         */
        else if(
          m.orders===0 &&
          m.clicks>=12 &&
          (
            budget<=0 ||
            m.spend>=budget*0.80
          )
        ){
          reductionPct=0.15;

          reason=
            'AUTO_OVESPEND_12_PLUS_CLICKS_NO_ORDER';
        }

        /*
         * Campanha com venda mas ACoS muito ruim.
         */
        else if(
          m.orders>0 &&
          acos>targetAcos*1.60
        ){
          reductionPct=0.15;

          reason=
            'AUTO_ACOS_SEVERE_CONTROL';
        }

        if(reductionPct<=0)
          continue;

        const groups=
          groupsByCampaign.get(cid)
          || [];

        /*
         * AUTO normalmente possui um AdGroup.
         *
         * Se houver vários, cada um é tratado
         * independentemente.
         */
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
            n(
              group.default_bid ??
              group.bid
            );

          if(currentBid<=0)
            continue;

          let proposedBid=
            Math.max(
              minBid,
              currentBid *
              (1-reductionPct)
            );

          /*
           * Caso B0GHP9PPWN:
           * teto operacional inicial = R$0,68.
           */
          if(
            asin==='B0GHP9PPWN'
          ){
            proposedBid=
              Math.min(
                proposedBid,
                0.68
              );
          }

          proposedBid=
            Math.round(
              proposedBid*100
            )/100;

          if(
            proposedBid>=currentBid
          ){
            continue;
          }

          const idempotency=
            [
              'V3',
              'AUTO_SPEND',
              aid,
              cid,
              gid,
              proposedBid.toFixed(2),
              new Date()
                .toISOString()
                .slice(0,10)
            ].join(':');

          const existing=
            await base44
              .asServiceRole
              .entities
              .OptimizationDecision
              .filter(
                {
                  amazon_account_id:aid,
                  idempotency_key:
                    idempotency
                },
                undefined,
                1
              )
              .catch(()=>[]);

          if(existing.length)
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
                  `V3_AUTO_SPEND_${asin}_${Date.now()}`,

                decision_type:
                  'bid_change',

                canonical_action_type:
                  'DECREASE_BID',

                entity_type:
                  'ad_group',

                entity_id:
                  gid,

                ad_group_id:
                  gid,

                campaign_id:
                  cid,

                campaign_name:
                  campaign.name ||
                  campaign.campaign_name ||
                  null,

                asin,
                sku,

                action:
                  'decrease_bid',

                rationale:
                  `${reason}: 7d spend=${m.spend.toFixed(2)}, clicks=${m.clicks}, orders=${m.orders}, CPC=${cpc.toFixed(2)}, ACoS=${acos.toFixed(2)}. Reduzir bid antes de aumentar budget.`,

                rule_key:
                  'V3_AUTO_SPEND_CONTROL',

                reason_code:
                  reason,

                priority:
                  1,

                priority_class:
                  'P0',

                current_value:
                  currentBid,

                proposed_value:
                  proposedBid,

                value_before:
                  currentBid,

                value_after:
                  proposedBid,

                change_pct:
                  -reductionPct,

                current_cpc:
                  cpc,

                current_acos:
                  acos,

                target_acos:
                  targetAcos,

                campaign_virtual_budget:
                  budget,

                confidence:
                  m.clicks>=20
                    ? 0.95
                    : 0.90,

                risk:
                  'low',

                requires_approval:
                  false,

                approval_status:
                  'approved',

                status:
                  'approved',

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
                  'runV3AutoSpendControl',

                model_version:
                  'CANONICAL_PROFIT_ENGINE_V3',

                idempotency_key:
                  idempotency,

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

                data_scope_validated:
                  true,

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

          decisions.push({
            decision_id:
              decision.id,

            campaign_id:
              cid,

            campaign:
              campaign.name ||
              campaign.campaign_name,

            asin,
            sku,

            ad_group_id:
              gid,

            spend_7d:
              Number(
                m.spend.toFixed(2)
              ),

            clicks_7d:
              m.clicks,

            orders_7d:
              m.orders,

            cpc:
              Number(
                cpc.toFixed(2)
              ),

            acos:
              Number(
                acos.toFixed(2)
              ),

            current_bid:
              currentBid,

            proposed_bid:
              proposedBid,

            reason
          });

          proposed++;
        }
      }

      /*
       * =============================================
       * HARVEST
       * =============================================
       *
       * AUTO que vende deve alimentar MANUAL EXACT.
       */
      const harvest=
        await base44
          .asServiceRole
          .functions
          .invoke(
            'runImmediateSameSkuSearchTermHarvest',
            {
              _service_role:true,

              amazon_account_id:
                aid,

              dry_run:false,

              lookback_days:65,

              source_campaign_type:'',

              max_promotions:13,

              require_same_sku_attribution:
                true,

              include_paused_campaign_history:
                true,

              canonical_engine:
                'CANONICAL_PROFIT_ENGINE_V3',

              decision_owner:
                'CANONICAL_PROFIT_ENGINE_V3',

              policy_version:
                'PROFIT_ENGINE_V3',

              trigger_type:
                'v3_auto_spend_control_harvest'
            }
          )
          .catch(
            (error:any)=>({
              data:{
                ok:false,
                error:
                  error?.message ||
                  String(error)
              }
            })
          );

      reports.push({

        amazon_account_id:
          aid,

        auto_campaigns_evaluated:
          evaluated,

        bid_reductions_proposed:
          proposed,

        decisions,

        harvest:
          harvest?.data ||
          harvest
      });
    }

    return Response.json({

      ok:true,

      engine:
        'CANONICAL_PROFIT_ENGINE_V3',

      operation:
        'AUTO_SPEND_CONTROL',

      rules:{

        spend_before_budget_scale:
          true,

        clicks_12_19_no_order:
          'bid_-15%',

        clicks_20_plus_no_order:
          'bid_-25%',

        severe_acos:
          'bid_-15%',

        target_B0GHP9PPWN:
          'max_bid_R$0.68',

        winner_harvest:
          true
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
