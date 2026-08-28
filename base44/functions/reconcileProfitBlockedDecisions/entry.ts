import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const n=(v:any,f=0)=>{
  const x=Number(v);
  return Number.isFinite(x) ? x : f;
};

const lower=(v:any)=>
  String(v||'').trim().toLowerCase();

const upper=(v:any)=>
  String(v||'').trim().toUpperCase();

/* SALES INTENSITY V4: only structured codes may retain a bid block. */
const BID_ACTIONS=new Set([
  'increase_bid','bid_increase','bid_change','set_bid','update_bid',
  'reduce_bid','bid_decrease'
]);

const HARD_BID_GUARD_CODES=new Set([
  'out_of_stock','not_buyable','listing_inactive','listing_suppressed',
  'product_inactive','not_eligible','negative_margin',
  'confirmed_economic_loss','break_even_violation','account_daily_cap',
  'daily_cap','budget_exceeded','user_restriction','manual_restriction'
]);

function normalizedGuardCode(value:any){
  return lower(value).replace(/[\\s-]+/g,'_');
}

function hardBidGuardOf(d:any){
  for(const value of [d.reason_code,d.rule_key]){
    const code=normalizedGuardCode(value);
    if(HARD_BID_GUARD_CODES.has(code)) return code;
  }
  return null;
}

function campaignIdOf(d:any){
  return String(
    d.campaign_id ||
    (
      d.entity_type==='campaign'
        ? d.entity_id
        : ''
    ) ||
    ''
  );
}

function metricBucket(){
  return {
    impressions:0,
    clicks:0,
    spend:0,
    orders:0,
    sales:0
  };
}

function addMetric(target:any,m:any){
  target.impressions+=n(m.impressions);
  target.clicks+=n(m.clicks);
  target.spend+=n(m.spend ?? m.cost);
  target.orders+=n(
    m.orders ??
    m.purchases
  );
  target.sales+=n(
    m.sales ??
    m.attributed_sales
  );
}

Deno.serve(async(req)=>{
  const started=Date.now();

  try{

    const base44=createClientFromRequest(req);
    const body=await req.json().catch(()=>({}));

    const authenticated=
      await base44.auth.isAuthenticated().catch(()=>false);

    if(!authenticated && !body._service_role){
      return Response.json(
        {ok:false,error:'Não autorizado'},
        {status:401}
      );
    }

    const accounts=body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter(
          {id:body.amazon_account_id},
          undefined,
          1
        )
      : await base44.asServiceRole.entities.AmazonAccount.filter(
          {status:'connected'},
          '-updated_at',
          50
        );

    const results:any[]=[];

    for(const account of accounts){

      const aid=String(account.id);

      const [
        blocked,
        cancelled,
        campaigns,
        metrics,
        products,
        snapshots,
        settingsRows,
        allDecisions
      ]=await Promise.all([

        base44.asServiceRole.entities.OptimizationDecision.filter(
          {
            amazon_account_id:aid,
            status:'blocked'
          },
          '-updated_at',
          5000
        ).catch(()=>[]),

        base44.asServiceRole.entities.OptimizationDecision.filter(
          {
            amazon_account_id:aid,
            status:'cancelled'
          },
          '-updated_at',
          5000
        ).catch(()=>[]),

        base44.asServiceRole.entities.Campaign.filter(
          {amazon_account_id:aid},
          '-updated_at',
          10000
        ).catch(()=>[]),

        base44.asServiceRole.entities.CampaignMetricsDaily.filter(
          {amazon_account_id:aid},
          '-date',
          50000
        ).catch(()=>[]),

        base44.asServiceRole.entities.Product.filter(
          {amazon_account_id:aid},
          '-updated_at',
          10000
        ).catch(()=>[]),

        base44.asServiceRole.entities.RepricingSnapshot.filter(
          {amazon_account_id:aid},
          '-created_at',
          20000
        ).catch(()=>[]),

        base44.asServiceRole.entities.PerformanceSettings.filter(
          {amazon_account_id:aid},
          '-updated_at',
          1
        ).catch(()=>[]),

        base44.asServiceRole.entities.OptimizationDecision.filter(
          {amazon_account_id:aid},
          '-updated_at',
          10000
        ).catch(()=>[])
      ]);

      const settings=settingsRows[0] || {};

      const minSpend=Math.max(
        5,
        n(settings.min_spend_for_decision,5)
      );

      const productByAsin=new Map<string,any>();

      for(const p of products){
        if(p.asin){
          productByAsin.set(
            upper(p.asin),
            p
          );
        }
      }

      const snapshotByAsin=new Map<string,any>();

      for(const s of snapshots){

        const asin=upper(s.asin);

        if(
          asin &&
          !snapshotByAsin.has(asin)
        ){
          snapshotByAsin.set(
            asin,
            s
          );
        }
      }

      const campaignById=new Map<string,any>();

      for(const c of campaigns){

        for(const id of [
          c.id,
          c.campaign_id,
          c.amazon_campaign_id
        ].filter(Boolean)){

          campaignById.set(
            String(id),
            c
          );
        }
      }

      const cutoff7=
        new Date(
          Date.now()-7*86400000
        )
        .toISOString()
        .slice(0,10);

      const cutoff30=
        new Date(
          Date.now()-30*86400000
        )
        .toISOString()
        .slice(0,10);

      const agg7=new Map<string,any>();
      const agg30=new Map<string,any>();

      for(const m of metrics){

        const cid=String(
          m.campaign_id || ''
        );

        if(!cid)
          continue;

        const date=String(
          m.date || ''
        );

        if(date>=cutoff30){

          const a=
            agg30.get(cid) ||
            metricBucket();

          addMetric(a,m);
          agg30.set(cid,a);
        }

        if(date>=cutoff7){

          const a=
            agg7.get(cid) ||
            metricBucket();

          addMetric(a,m);
          agg7.set(cid,a);
        }
      }

      /*
       * ====================================================
       * 1. CANCELAMENTOS DE WINNER PROTECTION
       * ====================================================
       *
       * Eles NÃO são falhas.
       *
       * O cancelamento impede que o motor pause uma campanha
       * vencedora.
       */
      let winnerCancellationsConfirmed=0;

      for(const d of cancelled){

        const text=[
          d.rule_key,
          d.reason_code,
          d.rationale,
          d.error_message
        ].join(' ').toUpperCase();

        if(
          text.includes(
            'WINNER_PROTECTION_DEDUP'
          )
          ||
          text.includes(
            'WINNER_PROTECTION_BLOCKED'
          )
        ){

          await base44.asServiceRole.entities.OptimizationDecision.update(
            d.id,
            {
              approval_status:
                'no_decision_profit_winner_protected',

              error_message:
                'NO_DECISION: pausa descartada porque a campanha possui proteção econômica/vencedora. Cancelamento correto.',

              updated_at:
                new Date().toISOString()
            }
          ).catch(()=>null);

          winnerCancellationsConfirmed++;
        }
      }

      /*
       * ====================================================
       * 2. DECISÕES BLOQUEADAS
       * ====================================================
       */
      let reductionsReopened=0;
      let uselessPausesCancelled=0;
      let prematurePausesCancelled=0;
      let hardPausesReopened=0;
      let softBidBlocksCancelled=0;
      let hardBidBlocksRetained=0;
      let unresolved=0;

      const reopened:any[]=[];
      const cancelledRows:any[]=[];

      for(const d of blocked){

        const action=String(
          d.action || ''
        );

        const bidAction=BID_ACTIONS.has(action);

        if(!bidAction && action!=='pause_campaign'){
          continue;
        }

        const hardBidGuard=bidAction ? hardBidGuardOf(d) : null;
        if(hardBidGuard){
          hardBidBlocksRetained++;
          continue;
        }

        const campaignId=
          campaignIdOf(d);

        if(!campaignId){
          if(bidAction){
            await base44.asServiceRole.entities.OptimizationDecision.update(
              d.id,
              {
                status:'cancelled',
                queue_status:'closed',
                approval_status:'no_decision_soft_bid_block',
                confirmation_required:false,
                confirmation_status:'not_applicable',
                error_message:'NO_DECISION: bloqueio operacional reversível sem campanha vinculada; não manter bid em blocked.',
                updated_at:new Date().toISOString()
              }
            ).catch(()=>null);
            softBidBlocksCancelled++;
            cancelledRows.push({id:d.id,action,reason:'SOFT_BID_BLOCK_NO_CAMPAIGN'});
            continue;
          }
          unresolved++;
          continue;
        }

        const campaign=
          campaignById.get(
            campaignId
          );

        const m7=
          agg7.get(campaignId) ||
          metricBucket();

        const m30=
          agg30.get(campaignId) ||
          metricBucket();

        const asin=upper(
          d.asin ||
          campaign?.asin ||
          campaign?.advertised_asin ||
          ''
        );

        const product=
          productByAsin.get(asin);

        const snapshot=
          snapshotByAsin.get(asin);

        const stock=Math.max(
          0,

          n(product?.fulfillable_quantity),
          n(product?.available_quantity),
          n(product?.inventory_quantity),
          n(product?.stock),
          n(product?.fba_inventory),

          n(snapshot?.inventory_available)
        );

        const buyable=
          snapshot?.buyable !== false &&
          product?.listing_buyable !== false;

        const listingStatus=
          lower(
            snapshot?.listing_status
          );

        const offerStatus=
          lower(
            snapshot?.offer_status
          );

        const listingOkay=
          ![
            'inactive',
            'suppressed',
            'closed',
            'deleted',
            'not_found'
          ].includes(listingStatus);

        const offerOkay=
          ![
            'inactive',
            'suppressed',
            'closed',
            'deleted',
            'not_found'
          ].includes(offerStatus);

        const before=n(
          d.value_before ??
          d.current_value
        );

        const after=n(
          d.value_after ??
          d.proposed_value
        );

        /*
         * ==================================================
         * REDUÇÃO DE BID
         * ==================================================
         *
         * Reduzir bid é ação DEFENSIVA e reversível.
         *
         * Não precisa ser impedida simplesmente porque SP-API
         * ou economics snapshot estão antigos quando a própria
         * campanha já provou desperdício.
         */

        const realReduction=
          (
            action==='reduce_bid'
            ||
            action==='bid_decrease'
            ||
            action==='set_bid'
            ||
            action==='update_bid'
            ||
            action==='bid_change'
          )
          &&
          before>0
          &&
          after>0
          &&
          after<before;

        const waste7=
          m7.orders===0
          &&
          m7.sales===0
          &&
          m7.clicks>=10
          &&
          m7.spend>=minSpend;

        const waste30=
          m30.orders===0
          &&
          m30.sales===0
          &&
          m30.clicks>=12
          &&
          m30.spend>=minSpend;

        if(
          realReduction &&
          (waste7 || waste30)
        ){

          /*
           * Rollback obrigatório agora existe.
           */
          const rollbackPlan=
            JSON.stringify({
              action:'set_bid',
              keyword_id:
                d.keyword_id ||
                d.entity_id ||
                null,

              campaign_id:
                campaignId,

              value:
                before,

              reason:
                'rollback_profit_waste_bid_reduction'
            });

          const precondition=
            JSON.stringify({
              campaign_id:
                campaignId,

              asin,

              stock,

              buyable,

              listing_status:
                snapshot?.listing_status ||
                null,

              offer_status:
                snapshot?.offer_status ||
                null,

              metrics_7d:m7,

              metrics_30d:m30,

              validated_at:
                new Date().toISOString()
            });

          await base44.asServiceRole.entities.OptimizationDecision.update(
            d.id,
            {
              /*
               * Passa novamente à fila.
               */
              status:'approved',
              queue_status:'pending',

              /*
               * Não reenviar ao mesmo guard que já avaliou
               * snapshot agregado incompleto.
               */
              canonical_action_type:null,

              source_function:
                'reconcileProfitBlockedDecisions',

              rule_key:
                'PROVEN_ZERO_ORDER_WASTE_BID_REDUCTION',

              reason_code:
                'PROVEN_ZERO_ORDER_WASTE',

              rationale:
                `Lucro esperado: redução defensiva revalidada. 7d: gasto R$${m7.spend.toFixed(2)}, ${m7.clicks} cliques, ${m7.orders} pedidos; 30d: gasto R$${m30.spend.toFixed(2)}, ${m30.clicks} cliques, ${m30.orders} pedidos. Bid R$${before.toFixed(2)} → R$${after.toFixed(2)}.`,

              requires_approval:false,

              approval_status:
                'auto_reapproved_profit_waste',

              execution_mode:
                'EXPEDITED_QUEUE',

              priority_class:
                'P1',

              confirmation_required:true,
              confirmation_status:'pending',

              /*
               * A decisão usa evidência observada da campanha;
               * SP snapshot velho não bloqueia redução de risco.
               */
              requires_fresh_data:false,

              maximum_data_age_minutes:
                24*60,

              data_scope_validated:true,
              data_scope_status:'VALID',

              rollback_plan:
                rollbackPlan,

              precondition_snapshot:
                precondition,

              attempt_count:0,
              next_retry_at:null,

              execute_before:
                new Date(
                  Date.now()+60*60000
                ).toISOString(),

              error_message:null,
              confirmation_error:null,

              updated_at:
                new Date().toISOString()
            }
          ).catch(()=>null);

          reductionsReopened++;

          reopened.push({
            id:d.id,
            action,
            asin,
            campaign_id:
              campaignId,

            before,
            after,

            spend_7d:
              Number(
                m7.spend.toFixed(2)
              ),

            clicks_7d:
              m7.clicks,

            orders_7d:
              m7.orders,

            reason:
              'PROVEN_ZERO_ORDER_WASTE'
          });

          continue;
        }

        /* Non-hard blocked bid proposals are reversible operational holds. */
        if(bidAction){
          await base44.asServiceRole.entities.OptimizationDecision.update(
            d.id,
            {
              status:'cancelled',
              queue_status:'closed',
              approval_status:'no_decision_soft_bid_block',
              confirmation_required:false,
              confirmation_status:'not_applicable',
              error_message:'NO_DECISION: bloqueio operacional reversível de ajuste de bid; proposta encerrada sem execução Amazon.',
              updated_at:new Date().toISOString()
            }
          ).catch(()=>null);

          softBidBlocksCancelled++;
          cancelledRows.push({
            id:d.id,action,asin,campaign_id:campaignId,reason:'SOFT_BID_BLOCK'
          });
          continue;
        }

        /*
         * ==================================================
         * PAUSA DE CAMPANHA
         * ==================================================
         */

        if(action==='pause_campaign'){

          /*
           * ZERO DELIVERY ABSOLUTO:
           *
           * 0 gasto + 0 cliques não representa prejuízo.
           * Pausar não melhora lucro.
           *
           * Portanto vira HOLD/NO_DECISION.
           */
          const absoluteZeroDelivery=
            m30.spend===0
            &&
            m30.clicks===0
            &&
            m30.orders===0
            &&
            m30.sales===0;

          if(absoluteZeroDelivery){

            await base44.asServiceRole.entities.OptimizationDecision.update(
              d.id,
              {
                status:'cancelled',
                queue_status:'none',

                approval_status:
                  'no_decision_zero_delivery_no_loss',

                error_message:
                  'NO_DECISION: campanha com zero gasto não causa prejuízo; pausa não melhora lucro esperado. Manter em observação/recuperação de entrega.',

                updated_at:
                  new Date().toISOString()
              }
            ).catch(()=>null);

            uselessPausesCancelled++;

            cancelledRows.push({
              asin,
              campaign_id:
                campaignId,

              reason:
                'ZERO_DELIVERY_NO_FINANCIAL_LOSS'
            });

            continue;
          }

          /*
           * Antes de pausar desperdício, exigimos duas reduções
           * anteriores já executadas/confirmadas.
           *
           * hold -> reduction -> reduction -> pause
           */
          const priorReductions=
            allDecisions.filter(
              (x:any)=>
                String(
                  x.campaign_id || ''
                )===campaignId

                &&
                [
                  'reduce_bid',
                  'set_bid'
                ].includes(
                  String(x.action||'')
                )

                &&
                (
                  x.status==='executed'
                  ||
                  x.confirmation_status==='confirmed'
                )

                &&
                n(
                  x.value_after ??
                  x.proposed_value
                )
                <
                n(
                  x.value_before ??
                  x.current_value
                )
            ).length;

          const provenPersistentWaste=
            m30.orders===0
            &&
            m30.sales===0
            &&
            m30.clicks>=20
            &&
            m30.spend>=Math.max(
              15,
              minSpend*2
            );

          if(
            provenPersistentWaste
            &&
            priorReductions>=2
          ){

            await base44.asServiceRole.entities.OptimizationDecision.update(
              d.id,
              {
                status:'approved',
                queue_status:'pending',

                canonical_action_type:null,

                source_function:
                  'reconcileProfitBlockedDecisions',

                rule_key:
                  'PROVEN_PERSISTENT_WASTE_AFTER_TWO_REDUCTIONS',

                reason_code:
                  'PROVEN_PERSISTENT_WASTE',

                rationale:
                  `Pausa revalidada somente após desperdício persistente: 30d gasto R$${m30.spend.toFixed(2)}, ${m30.clicks} cliques, zero pedidos e ${priorReductions} reduções anteriores.`,

                requires_approval:false,

                approval_status:
                  'auto_reapproved_persistent_loss',

                execution_mode:
                  'EXPEDITED_QUEUE',

                priority_class:'P1',

                confirmation_required:true,
                confirmation_status:'pending',

                requires_fresh_data:false,

                rollback_plan:
                  JSON.stringify({
                    action:'enable_campaign',
                    campaign_id:campaignId,
                    reason:
                      'rollback_persistent_waste_pause'
                  }),

                precondition_snapshot:
                  JSON.stringify({
                    asin,
                    campaign_id:campaignId,
                    stock,
                    buyable,
                    listing_okay:listingOkay,
                    offer_okay:offerOkay,
                    metrics_30d:m30,
                    prior_reductions:
                      priorReductions
                  }),

                attempt_count:0,
                next_retry_at:null,

                execute_before:
                  new Date(
                    Date.now()+60*60000
                  ).toISOString(),

                error_message:null,

                updated_at:
                  new Date().toISOString()
              }
            ).catch(()=>null);

            hardPausesReopened++;

            reopened.push({
              id:d.id,
              action,
              asin,
              campaign_id:campaignId,
              spend_30d:
                Number(
                  m30.spend.toFixed(2)
                ),
              clicks_30d:
                m30.clicks,
              prior_reductions:
                priorReductions,
              reason:
                'PERSISTENT_WASTE'
            });

            continue;
          }

          /*
           * Ainda não passou pela sequência econômica:
           * não pausar.
           */
          await base44.asServiceRole.entities.OptimizationDecision.update(
            d.id,
            {
              status:'cancelled',
              queue_status:'none',

              approval_status:
                'no_decision_pause_requires_reduction_sequence',

              error_message:
                `NO_DECISION: pausa exige desperdício persistente + duas reduções anteriores. Atual: 30d gasto R$${m30.spend.toFixed(2)}, ${m30.clicks} cliques, ${m30.orders} pedidos, reductions=${priorReductions}.`,

              updated_at:
                new Date().toISOString()
            }
          ).catch(()=>null);

          prematurePausesCancelled++;

          continue;
        }
      }

      results.push({
        amazon_account_id:aid,

        blocked_reviewed:
          blocked.length,

        cancelled_reviewed:
          cancelled.length,

        winner_cancellations_confirmed:
          winnerCancellationsConfirmed,

        bid_reductions_reopened:
          reductionsReopened,

        zero_loss_pauses_cancelled:
          uselessPausesCancelled,

        premature_pauses_cancelled:
          prematurePausesCancelled,

        persistent_waste_pauses_reopened:
          hardPausesReopened,

        soft_bid_blocks_cancelled:
          softBidBlocksCancelled,

        hard_bid_blocks_retained:
          hardBidBlocksRetained,

        unresolved,

        reopened_sample:
          reopened.slice(0,100),

        cancelled_sample:
          cancelledRows.slice(0,100)
      });
    }

    return Response.json({
      ok:true,

      engine:
        'PROFIT_BLOCKED_DECISION_RECONCILER_V1',

      primary_goal:
        'MAXIMIZE_EXPECTED_PROFIT_BOUNDED_LOSS',

      results,

      duration_ms:
        Date.now()-started
    });

  }catch(error:any){

    return Response.json(
      {
        ok:false,

        engine:
          'PROFIT_BLOCKED_DECISION_RECONCILER_V1',

        error:
          error?.message ||
          String(error)
      },
      {status:500}
    );
  }
});
