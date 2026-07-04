import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));

Deno.serve(async(request)=>{try{
 const base44=createClientFromRequest(request),body=await request.json().catch(()=>({}));
 if(!body._service_role||!body.amazon_account_id)return Response.json({ok:false,error:'Parâmetros inválidos'},{status:400});
 const accountId=body.amazon_account_id;
 const [signals,configs,models]=await Promise.all([
  base44.asServiceRole.entities.KeywordStrategySignal.filter({amazon_account_id:accountId},'-evaluated_at',5000).catch(()=>[]),
  base44.asServiceRole.entities.AppOptimizationConfig.filter({amazon_account_id:accountId},'-updated_at',1).catch(()=>[]),
  base44.asServiceRole.entities.MLModel.filter({amazon_account_id:accountId},'-trained_at',1).catch(()=>[]),
 ]);
 const cfg=configs[0]||{},targetAcos=Number(cfg.target_acos||25),targetRoas=Number(cfg.target_roas||4);
 const reliable=signals.filter((signal:any)=>Number(signal.confidence||0)>=70&&Number(signal.clicks||0)>=3);
 const profitable=reliable.filter((signal:any)=>Number(signal.orders||0)>0&&Number(signal.acos||999)<=targetAcos&&Number(signal.roas||0)>=targetRoas*0.8);
 const waste=reliable.filter((signal:any)=>Number(signal.orders||0)===0&&Number(signal.clicks||0)>=8&&Number(signal.spend||0)>=3);
 const highIntent=reliable.filter((signal:any)=>Number(signal.relevance_score||0)>=0.6&&Number(signal.opportunity_score||0)>=0.6);
 const profitableRate=reliable.length?profitable.length/reliable.length:0;
 const wasteRate=reliable.length?waste.length/reliable.length:0;
 const harvestOrders=profitableRate>=0.35?1:2;
 const minClicks=clamp(Math.round(8+wasteRate*8-profitableRate*3),6,15);
 const maxIncrease=clamp(Math.round(5+profitableRate*10),5,15);
 const maxDecrease=clamp(Math.round(10+wasteRate*15),10,25);
 const confidence=clamp(0.55+Math.min(reliable.length,100)/250+profitableRate*0.15,0.55,0.95);
 const notes=`Modelo econômico: ${reliable.length} sinais confiáveis; ${profitable.length} lucrativos; ${waste.length} desperdícios; ${highIntent.length} alta intenção. Corte de 24h. Meta ACoS ${targetAcos}% e ROAS ${targetRoas}x.`;
 let model=models[0];
 const payload={amazon_account_id:accountId,model_version:String(Number(model?.model_version||1)+0.1),training_samples:Number(model?.training_samples||0)+reliable.length,target_acos:targetAcos,max_bid_increase_pct:maxIncrease,max_bid_decrease_pct:maxDecrease,min_clicks_for_decision:minClicks,harvest_after_orders:harvestOrders,confidence_score:Number(confidence.toFixed(3)),trained_at:new Date().toISOString(),training_notes:notes};
 if(model)await base44.asServiceRole.entities.MLModel.update(model.id,payload);else model=await base44.asServiceRole.entities.MLModel.create(payload);
 await base44.asServiceRole.entities.LearningEvent.create({amazon_account_id:accountId,event_type:'profitability_model_calibration',entity_type:'account',entity_id:accountId,observation:notes,recorded_at:new Date().toISOString()}).catch(()=>{});
 return Response.json({ok:true,reliable_signals:reliable.length,profitable_signals:profitable.length,waste_signals:waste.length,high_intent_signals:highIntent.length,calibration:{target_acos:targetAcos,target_roas:targetRoas,min_clicks_for_decision:minClicks,harvest_after_orders:harvestOrders,max_bid_increase_pct:maxIncrease,max_bid_decrease_pct:maxDecrease,confidence_score:Number(confidence.toFixed(3))}});
}catch(error){return Response.json({ok:false,error:error?.message||'Erro ao calibrar ML'},{status:500});}});
