import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function brazilHour(){const parts=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',hour12:false}).formatToParts(new Date());return Number(parts.find((part)=>part.type==='hour')?.value||0);}
function nextHour(){const hour=brazilHour();if(hour<4)return Math.min(3,hour+1);if(hour<13)return 13;return 0;}
function windowLabel(hour:number){return hour===13?'13:00-14:00':`${String(hour).padStart(2,'0')}:00-${String(hour+1).padStart(2,'0')}:00`;}
function entityKey(decision:any){return [decision.amazon_account_id,decision.action,decision.entity_type,decision.entity_id||decision.keyword_id,decision.campaign_id].filter(Boolean).join('|');}

Deno.serve(async(request)=>{try{
 const base44=createClientFromRequest(request),body=await request.json().catch(()=>({}));
 if(!body._service_role)return Response.json({ok:false,error:'Uso interno'},{status:403});
 const accountId=body.amazon_account_id;if(!accountId)return Response.json({ok:false,error:'amazon_account_id obrigatório'},{status:400});
 const [configs,globalConfigs,pending]=await Promise.all([
  base44.asServiceRole.entities.AutopilotConfig.filter({amazon_account_id:accountId},'-updated_at',1).catch(()=>[]),
  base44.asServiceRole.entities.AppOptimizationConfig.filter({amazon_account_id:accountId},'-updated_at',1).catch(()=>[]),
  base44.asServiceRole.entities.OptimizationDecision.filter({amazon_account_id:accountId,status:'pending'},'-created_at',500).catch(()=>[]),
 ]);
 const config=configs[0]||{},globalConfig=globalConfigs[0]||{};
 const autonomy=Number(config.autonomy_level??1);
 const minimumConfidence=Number(globalConfig.minimum_confidence??config.minimum_confidence??90);
 const queueHour=nextHour(),queueWindow=windowLabel(queueHour);
 const bidDecisions=pending.filter((decision:any)=>['reduce_bid','increase_bid','update_bid'].includes(String(decision.action)));
 const newestByKey=new Map();
 for(const decision of bidDecisions){const key=entityKey(decision);if(!newestByKey.has(key))newestByKey.set(key,decision);else await base44.asServiceRole.entities.OptimizationDecision.update(decision.id,{status:'superseded',queue_status:'completed',error_message:null,superseded_by:newestByKey.get(key).id,superseded_at:new Date().toISOString()}).catch(()=>{});}
 const results=[];
 for(const decision of newestByKey.values()){
  const confidence=Number(decision.confidence||0);
  const risk=String(decision.risk||'low').toLowerCase();
  const eligible=autonomy>=2&&confidence>=minimumConfidence&&risk!=='very_high';
  if(eligible){
   await base44.asServiceRole.entities.OptimizationDecision.update(decision.id,{status:'approved',queue_status:'scheduled',queue_hour:queueHour,queue_window:queueWindow,queued_at:new Date().toISOString(),pending_reason:null,error_message:null});
   results.push({id:decision.id,keyword:decision.keyword_text||decision.entity_name,confidence,eligible:true,queued:true,queue_window:queueWindow});
  }else{
   const reasons=[];if(autonomy<2)reasons.push(`autonomia ${autonomy} exige aprovação humana`);if(confidence<minimumConfidence)reasons.push(`confiança ${confidence}% abaixo do mínimo ${minimumConfidence}%`);if(risk==='very_high')reasons.push('risco muito alto');
   await base44.asServiceRole.entities.OptimizationDecision.update(decision.id,{queue_status:'awaiting_approval',pending_reason:reasons.join('; '),error_message:null});
   results.push({id:decision.id,keyword:decision.keyword_text||decision.entity_name,confidence,eligible:false,queued:false,reason:reasons.join('; ')});
  }
 }
 return Response.json({ok:true,checked:bidDecisions.length,unique:newestByKey.size,queued:results.filter((item:any)=>item.queued).length,awaiting_approval:results.filter((item:any)=>!item.queued).length,superseded:bidDecisions.length-newestByKey.size,minimum_confidence:minimumConfidence,autonomy_level:autonomy,queue_window:queueWindow,results});
}catch(error){return Response.json({ok:false,error:error?.message||'Erro ao reconciliar bids pendentes'},{status:500});}});
