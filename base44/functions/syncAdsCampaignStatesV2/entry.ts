import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const STATES = ['ENABLED', 'PAUSED', 'ARCHIVED'];
const PRIORITY:any = { ENABLED: 3, PAUSED: 2, ARCHIVED: 1 };

function normalizedState(value:any){const state=String(value||'').toUpperCase();if(state==='ENABLED')return'enabled';if(state==='PAUSED')return'paused';return'archived';}

Deno.serve(async(request)=>{const startedAt=new Date().toISOString();try{
 const base44=createClientFromRequest(request),body=await request.json().catch(()=>({}));
 if(!body._service_role)return Response.json({ok:false,error:'Uso interno'},{status:403});
 const accountId=body.amazon_account_id;if(!accountId)return Response.json({ok:false,error:'amazon_account_id obrigatório'},{status:400});
 const found=new Map(),requestIds:string[]=[];let pages=0;
 for(const state of STATES){let nextToken:any=null;const seen=new Set();do{
   const response=await base44.asServiceRole.functions.invoke('amazonAdsCommand',{amazon_account_id:accountId,operation:`listCampaigns${state}`,method:'POST',path:'/sp/campaigns/list',payload:{stateFilter:{include:[state]},maxResults:500,...(nextToken?{nextToken}:{})},content_type:'application/vnd.spCampaign.v3+json',accept:'application/vnd.spCampaign.v3+json',queue_type:'READ',_service_role:true});
   const data=response?.data||response||{};if(!data?.ok)throw new Error(data?.errors?.[0]?.message||data?.error||`Falha ao listar campanhas ${state}`);
   const payload=data?.payload||data||{};for(const campaign of payload?.campaigns||[]){const id=String(campaign.campaignId);const current=found.get(id);const candidateState=String(campaign.state||state).toUpperCase();if(!current||PRIORITY[candidateState]>PRIORITY[String(current.state||'ARCHIVED').toUpperCase()])found.set(id,{...campaign,state:candidateState});}
   if(data?.request_id)requestIds.push(data.request_id);pages++;nextToken=payload?.nextToken||null;if(nextToken&&seen.has(nextToken))throw new Error('nextToken repetido');if(nextToken)seen.add(nextToken);
  }while(nextToken);}
 const remoteIds=new Set(found.keys()),existing=await base44.asServiceRole.entities.Campaign.filter({amazon_account_id:accountId},'-updated_at',5000).catch(()=>[]);let created=0,updated=0,archived=0;
 for(const campaign of found.values()){const id=String(campaign.campaignId),rows=existing.filter((row:any)=>String(row.campaign_id)===id),record={amazon_account_id:accountId,campaign_id:id,name:campaign.name,campaign_name:campaign.name,campaign_type:'SP',targeting_type:campaign.targetingType,state:normalizedState(campaign.state),status:normalizedState(campaign.state),archived:normalizedState(campaign.state)==='archived',daily_budget:Number(campaign.budget?.budget||campaign.dailyBudget||0),start_date:campaign.startDate||null,end_date:campaign.endDate||null,bidding_strategy:campaign.dynamicBidding?.strategy||campaign.bidding?.strategy||null,synced_at:new Date().toISOString(),updated_at:new Date().toISOString()};if(rows[0]){await base44.asServiceRole.entities.Campaign.update(rows[0].id,record);updated++;}else{await base44.asServiceRole.entities.Campaign.create(record);created++;}}
 for(const row of existing){if(!remoteIds.has(String(row.campaign_id))&&normalizedState(row.state||row.status)!=='archived'){await base44.asServiceRole.entities.Campaign.update(row.id,{state:'archived',status:'archived',archived:true,synced_at:new Date().toISOString()}).catch(()=>{});archived++;}}
 const summary={ok:true,pages,remote_total:found.size,enabled:[...found.values()].filter((c:any)=>normalizedState(c.state)==='enabled').length,paused:[...found.values()].filter((c:any)=>normalizedState(c.state)==='paused').length,archived:[...found.values()].filter((c:any)=>normalizedState(c.state)==='archived').length,created,updated,stale_archived:archived,request_ids:requestIds};
 await base44.asServiceRole.entities.SyncExecutionLog.create({amazon_account_id:accountId,operation:'sync_ads_campaign_states_v2',status:'success',trigger_type:body.trigger_type||'scheduled',started_at:startedAt,completed_at:new Date().toISOString(),records_processed:found.size,result_summary:JSON.stringify(summary).slice(0,4000),error_message:null}).catch(()=>{});
 return Response.json(summary);
}catch(error){return Response.json({ok:false,error:error?.message||'Erro ao reconciliar campanhas'},{status:500});}});
