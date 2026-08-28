import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const n=(v:any,f=0)=>{
  const x=Number(v);
  return Number.isFinite(x) ? x : f;
};

const low=(v:any)=>String(v||'').trim().toLowerCase();
const upper=(v:any)=>String(v||'').trim().toUpperCase();

const BID_ACTIONS=new Set([
  'set_bid',
  'increase_bid',
  'reduce_bid',
  'update_bid'
]);

const HARD_REASONS=[
  'OUT_OF_STOCK',
  'NOT_BUYABLE',
  'LISTING_INACTIVE',
  'LISTING_SUPPRESSED',
  'OFFER_INACTIVE',
  'ACCOUNT_KILL_SWITCH',
  'ACCOUNT_DAILY_CAP',
  'SAFE_CPC_EXCEEDED',
  'SAFE_CPC_CEILING',
  'ECONOMIC_CEILING',
  'NEGATIVE_MARGIN',
  'MARGIN_FLOOR',
  'RUNAWAY_SPEND',
];

const ECONOMIC_REDUCTION_REASONS=[
  'PROVEN_WASTE',
  'HIGH_ACOS',
  'ECONOMIC',
  'BREAK_EVEN',
  'MARGIN',
  'WASTE',
  'LOSS_BUDGET',
];

function parseJson(v:any){
  if(!v) return {};
  if(typeof v==='object') return v;

  try{
    return JSON.parse(String(v));
  }catch{
    return {};
  }
}

function decisionText(d:any){
  return [
    d.reason_code,
    d.rule_key,
    d.rationale,
    d.error_message
  ].join(' ').toUpperCase();
}

function entityKey(d:any){
  return String(
    d.keyword_id ||
    d.entity_id ||
    [
      d.campaign_id,
      d.keyword_text ||
      d.search_term ||
      d.term ||
      d.entity_name
    ].join('|')
  );
}

function decisionTs(d:any){
  return new Date(
    d.confirmed_at ||
    d.executed_at ||
    d.updated_at ||
    d.created_at ||
    0
  ).getTime();
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

    const output:any[]=[];

    for(const account of accounts){

      const aid=String(account.id);

      const [
        decisions,
        products,
        snapshots
      ]=await Promise.all([

        base44.asServiceRole.entities.OptimizationDecision.filter(
          {amazon_account_id:aid},
          '-updated_at',
          10000
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
        ).catch(()=>[])
      ]);

      const productByAsin=new Map<string,any>();

      for(const p of products){
        if(p.asin){
          productByAsin.set(
            upper(p.asin),
            p
          );
        }
      }

      /*
       * Snapshot mais novo por ASIN/SKU.
       */
      const snapshotByAsin=new Map<string,any>();
      const snapshotBySku=new Map<string,any>();

      for(const s of snapshots){

        const asin=upper(s.asin);
        const sku=upper(s.sku);

        if(asin && !snapshotByAsin.has(asin))
          snapshotByAsin.set(asin,s);

        if(sku && !snapshotBySku.has(sku))
          snapshotBySku.set(sku,s);
      }

      /*
       * Último aumento CONFIRMADO/EXECUTADO por entidade.
       *
       * Será nosso lock de direção.
       */
      const lastIncreaseByEntity=new Map<string,any>();

      const sorted=[
        ...decisions
      ].sort(
        (a,b)=>decisionTs(b)-decisionTs(a)
      );

      for(const d of sorted){

        if(d.action!=='increase_bid')
          continue;

        if(
          ![
            'executed',
            'completed',
            'confirming'
          ].includes(String(d.status||''))
          &&
          d.confirmation_status!=='confirmed'
        ){
          continue;
        }

        const key=entityKey(d);

        if(!key || lastIncreaseByEntity.has(key))
          continue;

        lastIncreaseByEntity.set(key,d);
      }

      let staleReopened=0;
      let fallbackCancelled=0;
      let conflictingReductionsCancelled=0;
      let noEntityCancelled=0;
      let hardKept=0;

      const reopened:any[]=[];
      const cancelled:any[]=[];

      const now=Date.now();
      const directionLockMs=6*60*60*1000;

      for(const d of decisions){

        if(!BID_ACTIONS.has(String(d.action||'')))
          continue;

        /*
         * Não alterar fatos já confirmados.
         */
        if(d.confirmation_status==='confirmed')
          continue;

        const text=decisionText(d);
        const evidence=parseJson(d.data_used);
        const admission=evidence?.admission || {};

        const asin=upper(
          d.asin ||
          d.product_asin ||
          admission.asin
        );

        const product=
          productByAsin.get(asin);

        const sku=upper(product?.sku);

        const snapshot=
          snapshotByAsin.get(asin) ||
          (
            sku
              ? snapshotBySku.get(sku)
              : null
          ) ||
          null;

        const localStock=Math.max(
          0,
          n(product?.fulfillable_quantity),
          n(product?.available_quantity),
          n(product?.inventory_quantity),
          n(product?.stock),
          n(product?.fba_inventory)
        );

        const remoteStock=Math.max(
          0,
          n(snapshot?.inventory_available)
        );

        const effectiveStock=Math.max(
          localStock,
          remoteStock
        );

        const listingStatus=low(
          snapshot?.listing_status
        );

        const offerStatus=low(
          snapshot?.offer_status
        );

        const listingActive=
          ![
            'inactive',
            'closed',
            'not_found',
            'error',
            'suppressed'
          ].includes(listingStatus);

        const offerActive=
          ![
            'inactive',
            'closed',
            'not_found',
            'error',
            'suppressed'
          ].includes(offerStatus);

        const buyable=
          snapshot?.buyable === true;

        const hardReason=
          HARD_REASONS.some(
            x=>text.includes(x)
          );

        /*
         * Hard guards continuam intactos.
         */
        if(
          hardReason ||
          effectiveStock<=0 ||
          snapshot?.buyable===false ||
          listingActive===false ||
          offerActive===false
        ){
          hardKept++;
          continue;
        }

        /*
         * ====================================================
         * REGRA 1 — fallback 0,60
         * ====================================================
         *
         * Fallback inicial só faz sentido se NÃO havia bid válido.
         *
         * Nunca mais:
         * 1,60 -> 0,60
         * 1,05 -> 0,60
         * 0,72 -> 0,60
         *
         * numa keyword ativa simplesmente porque um template histórico
         * usou fallback.
         */
        const before=n(
          d.value_before ??
          d.current_value,
          0
        );

        const after=n(
          d.value_after ??
          d.proposed_value,
          0
        );

        const isLegacyFallback=
          String(d.source_function||'')===
            'review2953FromConfirmedPatterns'
          &&
          (
            text.includes('FALLBACK R$0,60')
            ||
            text.includes('FALLBACK_0.60')
            ||
            (
              d.action==='set_bid' &&
              Math.abs(after-0.60)<0.001
            )
          );

        if(
          isLegacyFallback &&
          before>0
        ){
          await base44.asServiceRole.entities.OptimizationDecision.update(
            d.id,
            {
              status:'cancelled',
              queue_status:'none',

              approval_status:
                'no_decision_legacy_initial_bid_fallback',

              error_message:
                `NO_DECISION: fallback inicial R$0,60 não pode sobrescrever keyword ativa com bid válido R$${before.toFixed(2)}.`,

              updated_at:
                new Date().toISOString()
            }
          ).catch(()=>null);

          fallbackCancelled++;

          cancelled.push({
            id:d.id,
            action:d.action,
            asin,
            before,
            after,
            reason:'LEGACY_FALLBACK_060'
          });

          continue;
        }

        /*
         * ====================================================
         * REGRA 2 — LOCK DE DIREÇÃO
         * ====================================================
         *
         * Depois de um increase_bid confirmado/executado,
         * não aceitamos redução genérica por 6 horas.
         *
         * Redução ainda é permitida se existir evidência econômica
         * explícita — ACoS/waste/margin/break-even.
         */
        const key=entityKey(d);
        const lastIncrease=
          lastIncreaseByEntity.get(key);

        const isReduction=
          (
            d.action==='reduce_bid'
          )
          ||
          (
            d.action==='set_bid' &&
            after>0 &&
            before>0 &&
            after<before
          );

        const hasEconomicReductionProof=
          ECONOMIC_REDUCTION_REASONS.some(
            x=>text.includes(x)
          );

        if(
          isReduction &&
          lastIncrease &&
          now-decisionTs(lastIncrease)<directionLockMs &&
          !hasEconomicReductionProof
        ){
          const increasedTo=n(
            lastIncrease.value_after ??
            lastIncrease.proposed_value
          );

          await base44.asServiceRole.entities.OptimizationDecision.update(
            d.id,
            {
              status:'cancelled',
              queue_status:'none',

              approval_status:
                'no_decision_bid_direction_lock',

              error_message:
                `NO_DECISION_DIRECTION_LOCK: aumento recente para R$${increasedTo.toFixed(2)} protegido por 6h contra redução genérica.`,

              updated_at:
                new Date().toISOString()
            }
          ).catch(()=>null);

          conflictingReductionsCancelled++;

          cancelled.push({
            id:d.id,
            asin,
            action:d.action,
            before,
            after,
            reason:'DIRECTION_LOCK'
          });

          continue;
        }

        /*
         * ====================================================
         * REGRA 3 — STALE NON-BLOCKING
         * ====================================================
         *
         * Para bid:
         *
         * - produto existe;
         * - estoque positivo;
         * - snapshot Amazon existe;
         * - listing ativo;
         * - offer ativo;
         * - buyable=true;
         * - value_after > 0;
         * - respeita safe CPC quando disponível.
         *
         * Nessa situação, SP-API/economics stale isoladamente NÃO é
         * motivo para impedir ajuste competitivo de bid.
         */
        const staleRelated=
          text.includes('STALE')
          ||
          d.status==='blocked'
          ||
          d.status==='skipped'
          ||
          d.status==='waiting_retry'
          ||
          d.status==='approved';

        const safeCpc=n(
          d.safe_max_cpc ??
          admission.safe_max_cpc ??
          evidence.safe_max_cpc,
          0
        );

        const safeBid=
          after>0 &&
          (
            safeCpc<=0 ||
            after<=safeCpc+0.001
          );

        const amazonOperationalEvidence=
          Boolean(snapshot?.id)
          &&
          effectiveStock>0
          &&
          listingActive
          &&
          offerActive
          &&
          buyable;

        const trustedCompetitiveAction=
          String(d.source_function||'')===
            'runIntradaySalesRecovery'
          ||
          String(d.reason_code||'')===
            'INTRADAY_COMPETITIVE_COVERAGE_FLOOR'
          ||
          String(d.rule_key||'')===
            'INTRADAY_COMPETITIVE_COVERAGE_FLOOR';

        if(
          staleRelated &&
          amazonOperationalEvidence &&
          safeBid &&
          trustedCompetitiveAction
        ){
          /*
           * A decisão foi revalidada com evidência operacional Amazon.
           *
           * Retiramos APENAS o requisito agregado de freshness que estava
           * transformando SP-API antiga em hard blocker.
           */
          await base44.asServiceRole.entities.OptimizationDecision.update(
            d.id,
            {
              status:'approved',
              queue_status:'pending',

              execution_mode:
                'EXPEDITED_QUEUE',

              requires_approval:false,

              approval_status:
                'auto_reapproved_amazon_operational_evidence',

              /*
               * Evita que o executor volte para snapshot stale agregado.
               * Os hard guards já foram revalidados acima.
               */
              canonical_action_type:null,
              snapshot_id:null,

              requires_fresh_data:false,

              maximum_data_age_minutes:
                24*60,

              attempt_count:0,
              next_retry_at:null,

              execute_before:
                new Date(
                  Date.now()+60*60*1000
                ).toISOString(),

              error_message:null,

              data_used:JSON.stringify({
                ...evidence,

                stale_policy:
                  'NON_BLOCKING_FOR_BID_WHEN_AMAZON_OPERATIONAL_EVIDENCE_IS_VALID',

                operational_revalidation:{
                  verified:true,

                  snapshot_id:
                    snapshot.id,

                  listing_status:
                    snapshot.listing_status,

                  offer_status:
                    snapshot.offer_status,

                  buyable:true,

                  inventory_available:
                    remoteStock,

                  effective_stock:
                    effectiveStock,

                  value_after:
                    after,

                  safe_max_cpc:
                    safeCpc || null,

                  verified_at:
                    new Date().toISOString(),
                }
              }),

              updated_at:
                new Date().toISOString()
            }
          ).catch(()=>null);

          staleReopened++;

          reopened.push({
            id:d.id,
            asin,
            action:d.action,
            before,
            after,
            safe_cpc:
              safeCpc || null,
            stock:effectiveStock,
            reason:
              'STALE_NON_BLOCKING'
          });

          continue;
        }

        /*
         * Decisão sem ASIN/snapshot/estoque não é convertida em execução.
         *
         * Isso cobre os dois "lixeira antiodor" sem identidade do produto.
         */
        if(
          !asin &&
          !snapshot?.id
        ){
          if(
            ![
              'executed',
              'completed',
              'confirming'
            ].includes(String(d.status||''))
          ){
            await base44.asServiceRole.entities.OptimizationDecision.update(
              d.id,
              {
                status:'cancelled',
                queue_status:'none',

                approval_status:
                  'no_decision_unresolved_product',

                error_message:
                  'NO_DECISION: ajuste de bid sem ASIN/snapshot resolvido não pode ser reexecutado automaticamente.',

                updated_at:
                  new Date().toISOString()
              }
            ).catch(()=>null);

            noEntityCancelled++;
          }
        }
      }

      output.push({
        amazon_account_id:aid,

        stale_reopened:
          staleReopened,

        legacy_fallback_cancelled:
          fallbackCancelled,

        conflicting_reductions_cancelled:
          conflictingReductionsCancelled,

        unresolved_product_cancelled:
          noEntityCancelled,

        hard_guards_kept:
          hardKept,

        reopened_sample:
          reopened.slice(0,100),

        cancelled_sample:
          cancelled.slice(0,100),
      });
    }

    return Response.json({
      ok:true,
      engine:'BID_SALES_NORMALIZER_V1',
      results:output,
      duration_ms:Date.now()-started
    });

  }catch(error:any){

    return Response.json(
      {
        ok:false,
        engine:'BID_SALES_NORMALIZER_V1',
        error:error?.message||String(error)
      },
      {status:500}
    );
  }
});
