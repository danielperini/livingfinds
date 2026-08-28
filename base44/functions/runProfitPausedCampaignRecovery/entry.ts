import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const n=(v:any,f=0)=>{
  const x=Number(v);
  return Number.isFinite(x) ? x : f;
};

const low=(v:any)=>String(v||'').trim().toLowerCase();
const up=(v:any)=>String(v||'').trim().toUpperCase();

function campaignIdOf(c:any){
  return String(
    c?.campaign_id ||
    c?.amazon_campaign_id ||
    c?.id ||
    ''
  );
}

function isPaused(c:any){
  const s=low(
    c?.state ||
    c?.status ||
    c?.amazon_state
  );

  return s==='paused' ||
         s==='paused_external';
}

function isProductLocallyActive(p:any){
  const s=low(
    p?.status ||
    p?.state ||
    p?.amazon_status
  );

  if(!s) return true;

  return ![
    'inactive',
    'archived',
    'deleted',
    'closed',
    'suppressed'
  ].includes(s);
}

function stockOf(p:any,snapshot:any){
  return Math.max(
    0,
    n(p?.fulfillable_quantity),
    n(p?.available_quantity),
    n(p?.inventory_quantity),
    n(p?.stock),
    n(p?.fba_inventory),
    n(snapshot?.inventory_available)
  );
}

function campaignMetrics(c:any){
  const spend=n(
    c?.spend ??
    c?.cost ??
    c?.ad_spend ??
    c?.spend_30d ??
    c?.spend30d
  );

  const sales=n(
    c?.sales ??
    c?.attributed_sales ??
    c?.sales_30d ??
    c?.sales30d
  );

  const orders=n(
    c?.orders ??
    c?.purchases ??
    c?.orders_30d ??
    c?.orders30d
  );

  const acos=
    sales>0
      ? spend/sales*100
      : null;

  const roas=
    spend>0
      ? sales/spend
      : 0;

  return {
    spend,
    sales,
    orders,
    acos,
    roas
  };
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

    const maxPerRun=Math.max(
      1,
      Math.min(
        20,
        Number(body.max_reactivations || 8)
      )
    );

    const results:any[]=[];

    for(const account of accounts){

      const aid=String(account.id);

      const [
        campaigns,
        products,
        snapshots,
        settingsRows,
        existingDecisions
      ]=await Promise.all([

        base44.asServiceRole.entities.Campaign.filter(
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
        ).catch(()=>[]),

        base44.asServiceRole.entities.PerformanceSettings.filter(
          {amazon_account_id:aid},
          '-updated_at',
          1
        ).catch(()=>[]),

        base44.asServiceRole.entities.OptimizationDecision.filter(
          {amazon_account_id:aid},
          '-created_at',
          10000
        ).catch(()=>[])
      ]);

      const settings=settingsRows[0] || {};

      const targetAcos=
        n(settings.target_acos,25);

      const maxAcos=
        n(
          settings.max_acos ||
          settings.maximum_acos,
          Math.max(35,targetAcos*1.5)
        );

      const productByAsin=new Map<string,any>();

      for(const p of products){
        if(p.asin){
          productByAsin.set(up(p.asin),p);
        }
      }

      const snapshotByAsin=new Map<string,any>();

      for(const s of snapshots){
        const asin=up(s.asin);
        if(asin && !snapshotByAsin.has(asin)){
          snapshotByAsin.set(asin,s);
        }
      }

      const candidates:any[]=[];
      const rejected:any[]=[];

      for(const c of campaigns){

        if(!isPaused(c))
          continue;

        const campaignId=
          campaignIdOf(c);

        if(!campaignId)
          continue;

        const asin=up(
          c.asin ||
          c.advertised_asin ||
          c.product_asin
        );

        const product=
          productByAsin.get(asin);

        const snapshot=
          snapshotByAsin.get(asin);

        /*
         * Sem ASIN resolvido não fazemos reativação.
         */
        if(!asin || !product){
          rejected.push({
            campaign_id:campaignId,
            asin,
            reason:'UNRESOLVED_PRODUCT'
          });
          continue;
        }

        const stock=
          stockOf(product,snapshot);

        const listingStatus=
          low(snapshot?.listing_status);

        const offerStatus=
          low(snapshot?.offer_status);

        const listingActive=
          ![
            'inactive',
            'closed',
            'deleted',
            'suppressed',
            'not_found'
          ].includes(listingStatus);

        const offerActive=
          ![
            'inactive',
            'closed',
            'deleted',
            'suppressed',
            'not_found'
          ].includes(offerStatus);

        const buyable=
          typeof snapshot?.buyable==='boolean'
            ? snapshot.buyable
            : product?.listing_buyable !== false;

        const localActive=
          isProductLocallyActive(product);

        /*
         * HARD GUARDS.
         */
        if(
          stock<=0 ||
          !localActive ||
          !listingActive ||
          !offerActive ||
          !buyable
        ){
          rejected.push({
            campaign_id:campaignId,
            asin,
            reason:'HARD_PRODUCT_GUARD',
            stock,
            local_active:localActive,
            listing_active:listingActive,
            offer_active:offerActive,
            buyable
          });
          continue;
        }

        const m=
          campaignMetrics(c);

        /*
         * Só recuperamos campanha pausada se houver
         * evidência econômica real.
         *
         * Critério principal:
         * - pelo menos 1 pedido;
         * - vendas > 0;
         * - ACoS <= maxAcos
         * OU ROAS >= 2.5.
         */
        const hasSalesProof=
          m.orders>=1 &&
          m.sales>0;

        const economicProof=
          hasSalesProof &&
          (
            (
              m.acos!==null &&
              m.acos<=maxAcos
            )
            ||
            m.roas>=2.5
          );

        if(!economicProof){
          rejected.push({
            campaign_id:campaignId,
            asin,
            reason:'NO_PROFITABLE_HISTORY_PROOF',
            spend:m.spend,
            sales:m.sales,
            orders:m.orders,
            acos:m.acos,
            roas:m.roas
          });
          continue;
        }

        /*
         * Não recriar se já existe enable_campaign ativo/pendente
         * recente para a mesma campanha.
         */
        const duplicate=
          existingDecisions.some((d:any)=>
            String(d.campaign_id || d.entity_id || '')===campaignId
            &&
            String(d.action || '')==='enable_campaign'
            &&
            ![
              'failed',
              'cancelled',
              'rejected',
              'skipped',
              'superseded'
            ].includes(
              String(d.status || '')
            )
          );

        if(duplicate)
          continue;

        /*
         * Score de priorização:
         * vendas/pedidos e ROAS maiores ganham prioridade,
         * ACoS alto reduz score.
         */
        const score=
          m.orders*100 +
          m.sales +
          m.roas*25 -
          (m.acos || 0);

        candidates.push({
          campaign:c,
          campaignId,
          asin,
          product,
          snapshot,
          stock,
          metrics:m,
          score
        });
      }

      candidates.sort(
        (a,b)=>b.score-a.score
      );

      const selected=
        candidates.slice(0,maxPerRun);

      const created:any[]=[];

      for(const row of selected){

        const m=row.metrics;

        const key=
          `PROFIT_REACTIVATE|${aid}|${row.campaignId}`;

        if(body.dry_run===true){
          created.push({
            campaign_id:row.campaignId,
            asin:row.asin,
            action:'enable_campaign',
            stock:row.stock,
            spend:m.spend,
            sales:m.sales,
            orders:m.orders,
            acos:m.acos,
            roas:m.roas,
            dry_run:true
          });

          continue;
        }

        const decision=
          await base44.asServiceRole.entities.OptimizationDecision.create({

            amazon_account_id:aid,

            decision_type:
              'campaign_reactivation',

            entity_type:
              'campaign',

            entity_id:
              row.campaignId,

            campaign_id:
              row.campaignId,

            campaign_name:
              row.campaign.name ||
              row.campaign.campaign_name ||
              null,

            asin:
              row.asin,

            sku:
              row.product?.sku ||
              row.snapshot?.sku ||
              null,

            action:
              'enable_campaign',

            canonical_action_type:
              'CAMPAIGN_STATE_CHANGE',

            rationale:
              `Reativação subordinada à meta de lucro: campanha pausada possui ${m.orders} pedido(s), vendas R$${m.sales.toFixed(2)}, gasto R$${m.spend.toFixed(2)}, ACoS ${m.acos===null?'n/a':m.acos.toFixed(1)+'%'}, ROAS ${m.roas.toFixed(2)}, estoque ${row.stock}, listing/offer compráveis.`,

            rule_key:
              'PROFITABLE_PAUSED_CAMPAIGN_RECOVERY',

            reason_code:
              'PROFITABLE_PAUSED_CAMPAIGN_RECOVERY',

            primary_goal:
              'expected_profit',

            objective:
              'profitability',

            confidence:
              m.orders>=2
                ? 0.93
                : 0.84,

            risk:
              'low',

            requires_approval:false,

            approval_status:
              'auto_approved_profit_recovery',

            status:
              'approved',

            queue_status:
              'pending',

            priority_class:
              'P1',

            execution_mode:
              'EXPEDITED_QUEUE',

            confirmation_required:
              true,

            confirmation_status:
              'pending',

            data_scope_validated:
              true,

            data_scope_status:
              'VALID',

            requires_fresh_data:
              false,

            maximum_data_age_minutes:
              24*60,

            snapshot_id:
              row.snapshot?.id ||
              null,

            idempotency_key:
              key,

            conflict_group:
              `${aid}|campaign|${row.campaignId}`,

            source_function:
              'runProfitPausedCampaignRecovery',

            data_used:
              JSON.stringify({
                campaign_id:
                  row.campaignId,

                asin:
                  row.asin,

                stock:
                  row.stock,

                spend:
                  m.spend,

                sales:
                  m.sales,

                orders:
                  m.orders,

                acos:
                  m.acos,

                roas:
                  m.roas,

                target_acos:
                  targetAcos,

                max_acos:
                  maxAcos,

                listing_status:
                  row.snapshot?.listing_status,

                offer_status:
                  row.snapshot?.offer_status,

                buyable:
                  row.snapshot?.buyable,

                objective:
                  'MAXIMIZE_EXPECTED_PROFIT_BOUNDED_LOSS'
              }),

            created_at:
              new Date().toISOString(),

            updated_at:
              new Date().toISOString()
          });

        created.push({
          decision_id:
            decision.id,

          campaign_id:
            row.campaignId,

          asin:
            row.asin,

          action:
            'enable_campaign',

          stock:
            row.stock,

          orders:
            m.orders,

          acos:
            m.acos,

          roas:
            m.roas
        });
      }

      results.push({
        amazon_account_id:aid,

        paused_campaigns:
          campaigns.filter(isPaused).length,

        economically_eligible:
          candidates.length,

        selected:
          selected.length,

        decisions_created:
          created.length,

        decisions:
          created,

        rejected_sample:
          rejected.slice(0,100)
      });
    }

    return Response.json({
      ok:true,

      engine:
        'PROFIT_PAUSED_CAMPAIGN_RECOVERY_V1',

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
          'PROFIT_PAUSED_CAMPAIGN_RECOVERY_V1',

        error:
          error?.message ||
          String(error)
      },
      {status:500}
    );
  }
});
