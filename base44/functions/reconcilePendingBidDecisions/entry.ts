import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function brazilHour(){const parts=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',hour12:false}).formatToParts(new Date());return Number(parts.find((part)=>part.type==='hour')?.value||0);}
function nextHour(){const hour=brazilHour();if(hour<4)return Math.min(3,hour+1);if(hour<13)return 13;return 0;}
function windowLabel(hour:number){return hour===13?'13:00-14:00':`${String(hour).padStart(2,'0')}:00-${String(hour+1).padStart(2,'0')}:00`;}
function entityKey(decision:any){return [decision.amazon_account_id,decision.action,decision.entity_type,decision.entity_id||decision.keyword_id,decision.campaign_id].filter(Boolean).join('|');}

Deno.serve(async(request)=>{try{
 const base44=createClientFromRequest(request),body=await request.json().catch(()=>({}));
 if(!body._service_role)return Response.json({ok:false,error:'Uso interno'},{status:403});
 const accountId=body.amazon_account_id;if(!accountId)return Response.json({ok:false,error:'amazon_account_id obrigatório'},{status:400});
 const [configs,globalConfigs,performanceSettings,pending]=await Promise.all([
  base44.asServiceRole.entities.AutopilotConfig.filter({amazon_account_id:accountId},'-updated_at',1).catch(()=>[]),
  base44.asServiceRole.entities.AppOptimizationConfig.filter({amazon_account_id:accountId},'-updated_at',1).catch(()=>[]),
  base44.asServiceRole.entities.PerformanceSettings.filter({amazon_account_id:accountId},'-updated_at',1).catch(()=>[]),
  base44.asServiceRole.entities.OptimizationDecision.filter({amazon_account_id:accountId,status:'pending'},'-created_at',500).catch(()=>[]),
 ]);
 const config=configs[0]||{},globalConfig=globalConfigs[0]||{},policy=performanceSettings[0]||{};
 const autonomy=Number(config.autonomy_level??1);
 const aiMode=String(policy.ai_mode||(policy.ai_auto_optimization?'LOW_RISK_AUTO':'SHADOW'));
 const protectionConfidence=Number(policy.protection_confidence_threshold??globalConfig.minimum_confidence??config.minimum_confidence??85);
 const expansionConfidence=Number(policy.expansion_confidence_threshold??globalConfig.minimum_confidence??config.minimum_confidence??95);
 const queueHour=nextHour(),queueWindow=windowLabel(queueHour);
 const bidDecisions=pending.filter((decision:any)=>['reduce_bid','increase_bid','update_bid'].includes(String(decision.action)));
 const newestByKey=new Map();
 for(const decision of bidDecisions){const key=entityKey(decision);if(!newestByKey.has(key))newestByKey.set(key,decision);else await base44.asServiceRole.entities.OptimizationDecision.update(decision.id,{status:'superseded',queue_status:'completed',error_message:null,superseded_by:newestByKey.get(key).id,superseded_at:new Date().toISOString()}).catch(()=>{});}
 const results=[];
 for(const decision of newestByKey.values()){
  const confidence=Number(decision.confidence||0),risk=String(decision.risk||'low').toLowerCase();
  const proposedBid=Number(decision.new_bid??decision.proposed_bid??decision.recommended_bid??0),currentBid=Number(decision.current_bid??decision.old_bid??0);
  const isExpansion=String(decision.action)==='increase_bid'||(String(decision.action)==='update_bid'&&proposedBid>currentBid);
  const minimumConfidence=isExpansion?expansionConfidence:protectionConfidence;
  const eligible=aiMode==='LOW_RISK_AUTO'&&autonomy>=2&&confidence>=minimumConfidence&&risk==='low';
  if(eligible){
   await base44.asServiceRole.entities.OptimizationDecision.update(decision.id,{status:'approved',queue_status:'scheduled',queue_hour:queueHour,queue_window:queueWindow,queued_at:new Date().toISOString(),pending_reason:null,error_message:null});
   results.push({id:decision.id,keyword:decision.keyword_text||decision.entity_name,confidence,eligible:true,queued:true,queue_window:queueWindow,policy:isExpansion?'expansion':'protection'});
  }else{
   const reasons=[];if(aiMode!=='LOW_RISK_AUTO')reasons.push(`modo de IA ${aiMode} exige aprovação humana`);if(autonomy<2)reasons.push(`autonomia ${autonomy} exige aprovação humana`);if(confidence<minimumConfidence)reasons.push(`confiança ${confidence}% abaixo do mínimo ${minimumConfidence}% para ${isExpansion?'expansão':'proteção'}`);if(risk!=='low')reasons.push(`risco ${risk} fora do modo automático de baixo risco`);
   await base44.asServiceRole.entities.OptimizationDecision.update(decision.id,{queue_status:'awaiting_approval',pending_reason:reasons.join('; '),error_message:null});
   results.push({id:decision.id,keyword:decision.keyword_text||decision.entity_name,confidence,eligible:false,queued:false,reason:reasons.join('; '),policy:isExpansion?'expansion':'protection'});
  }
 }
 return Response.json({ok:true,checked:bidDecisions.length,unique:newestByKey.size,queued:results.filter((item:any)=>item.queued).length,awaiting_approval:results.filter((item:any)=>!item.queued).length,superseded:bidDecisions.length-newestByKey.size,ai_mode:aiMode,protection_confidence:protectionConfidence,expansion_confidence:expansionConfidence,autonomy_level:autonomy,queue_window:queueWindow,results});
}catch(error){return Response.json({ok:false,error:error?.message||'Erro ao reconciliar bids pendentes'},{status:500});}});
