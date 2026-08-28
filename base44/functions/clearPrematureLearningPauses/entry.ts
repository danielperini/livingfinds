import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const n=(v:any)=>Number.isFinite(Number(v))?Number(v):0;

function daysOld(v:any){
  const t=new Date(String(v||'')).getTime();
  return Number.isFinite(t)
    ? (Date.now()-t)/86400000
    : 999;
}

Deno.serve(async(req)=>{
  try{
    const base44=createClientFromRequest(req);
    const body=await req.json().catch(()=>({}));

    const auth=await base44.auth.isAuthenticated().catch(()=>false);

    if(!auth && !body._service_role){
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

    const out:any[]=[];

    for(const account of accounts){

      const aid=String(account.id);

      const [
        campaigns,
        metrics,
        blocked,
        skipped,
        approved,
        retries
      ]=await Promise.all([

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

        base44.asServiceRole.entities.OptimizationDecision.filter(
          {amazon_account_id:aid,status:'blocked'},
          '-updated_at',
          5000
        ).catch(()=>[]),

        base44.asServiceRole.entities.OptimizationDecision.filter(
          {amazon_account_id:aid,status:'skipped'},
          '-updated_at',
          5000
        ).catch(()=>[]),

        base44.asServiceRole.entities.OptimizationDecision.filter(
          {amazon_account_id:aid,status:'approved'},
          '-updated_at',
          5000
        ).catch(()=>[]),

        base44.asServiceRole.entities.OptimizationDecision.filter(
          {amazon_account_id:aid,status:'waiting_retry'},
          '-updated_at',
          5000
        ).catch(()=>[])
      ]);

      const campaignMap=new Map<string,any>();

      for(const c of campaigns){
        for(const id of [
          c.id,
          c.campaign_id,
          c.amazon_campaign_id
        ].filter(Boolean)){
          campaignMap.set(String(id),c);
        }
      }

      const cutoff=
        new Date(Date.now()-30*86400000)
          .toISOString()
          .slice(0,10);

      const agg=new Map<string,any>();

      for(const m of metrics){

        if(String(m.date||'') < cutoff)
          continue;

        const id=String(m.campaign_id||'');

        if(!id) continue;

        const x=agg.get(id)||{
          spend:0,
          sales:0,
          orders:0,
          clicks:0,
          impressions:0
        };

        x.spend+=n(m.spend);
        x.sales+=n(m.sales);
        x.orders+=n(m.orders);
        x.clicks+=n(m.clicks);
        x.impressions+=n(m.impressions);

        agg.set(id,x);
      }

      const decisions=[
        ...blocked,
        ...skipped,
        ...approved,
        ...retries
      ].filter((d:any)=>
        d.action==='pause_campaign' ||
        d.action==='pause_keyword'
      );

      let cancelled=0;
      let hardKept=0;
      let matureKept=0;

      const samples:any[]=[];

      for(const d of decisions){

        const campaignId=String(
          d.campaign_id ||
          (
            d.entity_type==='campaign'
              ? d.entity_id
              : ''
          ) ||
          ''
        );

        const campaign=campaignMap.get(campaignId);

        if(!campaign)
          continue;

        const age=daysOld(
          campaign.created_at ||
          campaign.created_date
        );

        const m=agg.get(campaignId)||{
          spend:0,
          sales:0,
          orders:0,
          clicks:0,
          impressions:0
        };

        const text=[
          d.reason_code,
          d.rule_key,
          d.rationale,
          d.error_message
        ].join(' ').toUpperCase();

        /*
         * Estes continuam hard stops mesmo em Learning Mode.
         */
        const trueHardGuard=
          /OUT_OF_STOCK|NOT_BUYABLE|LISTING_SUPPRESSED|LISTING_INACTIVE|ACCOUNT_KILL_SWITCH|ACCOUNT_DAILY_CAP|RUNAWAY_SPEND|NEGATIVE_MARGIN|MARGIN_FLOOR/.test(text);

        if(trueHardGuard){
          hardKept++;
          continue;
        }

        /*
         * 0–10 dias:
         * absolutamente nenhuma pausa de performance.
         */
        if(age < 10){

          await base44.asServiceRole.entities.OptimizationDecision.update(
            d.id,
            {
              status:'cancelled',
              queue_status:'none',
              approval_status:'learning_mode_no_decision',
              error_message:
                `NO_DECISION_LEARNING_MODE: campanha com ${age.toFixed(1)} dias. Learning Mode 0-10d aceita prejuízo e baixa performance.`,
              updated_at:new Date().toISOString()
            }
          ).catch(()=>null);

          cancelled++;

          samples.push({
            campaign_id:campaignId,
            asin:d.asin,
            age_days:Number(age.toFixed(1)),
            reason:'LEARNING_0_10D'
          });

          continue;
        }

        /*
         * 10–21 dias:
         * pausa só se a perda já ultrapassou o envelope de aprendizagem.
         *
         * Zero pedidos tolera até R$15 de spend.
         *
         * Havendo venda, ACoS temporariamente alto é permitido.
         */
        if(age < 21){

          const temporaryAcos=
            m.sales>0
              ? m.spend/m.sales*100
              : null;

          const stillLearning=
            (
              m.orders===0 &&
              m.spend<=15
            )
            ||
            (
              m.orders>0 &&
              m.sales>0 &&
              temporaryAcos!==null &&
              temporaryAcos<=70
            )
            ||
            (
              m.impressions<300 &&
              m.clicks<30
            );

          if(stillLearning){

            await base44.asServiceRole.entities.OptimizationDecision.update(
              d.id,
              {
                status:'cancelled',
                queue_status:'none',
                approval_status:
                  'learning_mode_no_decision',

                error_message:
                  `NO_DECISION_LEARNING_MODE: ${age.toFixed(1)}d, ${m.impressions} imp, ${m.clicks} clicks, gasto ${m.spend.toFixed(2)}, ${m.orders} pedidos. Evidência insuficiente para pausa.`,

                updated_at:new Date().toISOString()
              }
            ).catch(()=>null);

            cancelled++;

            samples.push({
              campaign_id:campaignId,
              asin:d.asin,
              age_days:Number(age.toFixed(1)),
              spend:Number(m.spend.toFixed(2)),
              orders:m.orders,
              reason:'LEARNING_10_21D'
            });

            continue;
          }
        }

        matureKept++;
      }

      out.push({
        amazon_account_id:aid,
        inspected:decisions.length,
        cancelled_learning_pauses:cancelled,
        hard_guards_kept:hardKept,
        mature_decisions_kept:matureKept,
        sample:samples.slice(0,100)
      });
    }

    return Response.json({
      ok:true,
      engine:'learning-mode-pause-cleaner-v1',
      results:out
    });

  }catch(error:any){

    return Response.json(
      {
        ok:false,
        error:error?.message||String(error)
      },
      {status:500}
    );
  }
});
