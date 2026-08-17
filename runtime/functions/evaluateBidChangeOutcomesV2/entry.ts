import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { getBrazilDate } from '../../shared/amazonDateTime.ts';

const total=(r,k)=>r.reduce((s,x)=>s+Number(x?.[k]||0),0);
const change=(a,b)=>a>0?(b-a)/a*100:b>0?100:0;
const stats=(r)=>{const spend=total(r,'spend'),sales=total(r,'sales'),orders=total(r,'orders'),clicks=total(r,'clicks'),impressions=total(r,'impressions');return{spend,sales,orders,clicks,impressions,acos:sales>0?spend/sales*100:0,roas:spend>0?sales/spend:0,conversion_rate:clicks>0?orders/clicks*100:0};};
const verdict=(a,b)=>{if(b.clicks<5&&b.orders===0)return['insufficient_data','wait_more_data'];const r=change(a.roas,b.roas),s=change(a.sales,b.sales),c=change(a.acos,b.acos);if((r>=10||s>=15)&&c<=15)return['positive','keep'];if(r<=-15||c>=20)return['negative','revert'];return['neutral','wait_more_data'];};

Deno.serve(async(req)=>{
  try{
    const base44=createClientFromRequest(req);const body=await req.json().catch(()=>({}));
    const auth=await base44.auth.isAuthenticated().catch(()=>false);
    if(!auth&&!body._service_role)return Response.json({ok:false,error:'Não autorizado'},{status:401});
    if(!body.amazon_account_id)return Response.json({ok:false,error:'amazon_account_id obrigatório'},{status:400});
    const rows=await base44.asServiceRole.entities.BidHistory.filter({amazon_account_id:body.amazon_account_id},'-created_at',500);
    let evaluated=0,skipped=0;
    for(const item of rows){
      if(item.ml_learning_status==='learned'||item.evaluated_at){skipped++;continue;}
      const at=item.executed_at||item.created_at;
      if(!at||Date.now()-new Date(at).getTime()<604800000){skipped++;continue;}
      const ds=item.decision_id?await base44.asServiceRole.entities.OptimizationDecision.filter({id:item.decision_id},null,1):[];
      const d=ds[0]||{},campaignId=d.campaign_id||item.campaign_id;
      if(!campaignId){skipped++;continue;}
      const m=await base44.asServiceRole.entities.CampaignMetricsDaily.filter({amazon_account_id:body.amazon_account_id,campaign_id:campaignId},'-date',90);
      const t=new Date(at),start=getBrazilDate(new Date(t.getTime()-604800000)),day=getBrazilDate(t),end=getBrazilDate(new Date(t.getTime()+604800000));
      const before=stats(m.filter(x=>x.date>=start&&x.date<day)),after=stats(m.filter(x=>x.date>=day&&x.date<end));
      const [outcome,next]=verdict(before,after);
      await base44.asServiceRole.entities.BidHistory.update(item.id,{evaluation_period_days:7,evaluation_start_at:day,evaluation_end_at:end,impressions_before:before.impressions,clicks_before:before.clicks,spend_before:before.spend,sales_before:before.sales,orders_before:before.orders,acos_before:before.acos,roas_before:before.roas,conversion_rate_before:before.conversion_rate,impressions_after:after.impressions,clicks_after:after.clicks,spend_after:after.spend,sales_after:after.sales,orders_after:after.orders,acos_after:after.acos,roas_after:after.roas,conversion_rate_after:after.conversion_rate,performance_change_pct:change(before.roas,after.roas),outcome,recommended_next_action:next,ml_learning_status:'learned',evaluated_at:new Date().toISOString()});
      await base44.asServiceRole.entities.LearningEvent.create({amazon_account_id:body.amazon_account_id,event_type:'bid_change_evaluated',entity_type:item.entity_type||'keyword',entity_id:item.entity_id||item.keyword_id||campaignId,asin:d.asin||item.asin||null,keyword:d.keyword_text||item.entity_name||null,outcome,source:'bid_history_ml',metadata:JSON.stringify({bid_before:item.bid_before??item.old_bid??null,bid_after:item.bid_after??item.new_bid??null,change_pct:item.change_pct??null,campaign_id:campaignId,before,after,recommended_next_action:next})}).catch(()=>{});
      evaluated++;
    }
    return Response.json({ok:true,evaluated,skipped,total:rows.length});
  }catch(error){return Response.json({ok:false,error:error?.message||'Erro ao avaliar histórico de bids'},{status:500});}
});