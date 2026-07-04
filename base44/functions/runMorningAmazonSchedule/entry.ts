import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function nowBR(){const p=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date());return Object.fromEntries(p.map(x=>[x.type,x.value]));}

Deno.serve(async(req)=>{try{
 const b=createClientFromRequest(req),x=await req.json().catch(()=>({}));
 if(!x._service_role)return Response.json({ok:false,error:'Uso interno'},{status:403});
 const t=nowBR(),h=Number(t.hour),m=Number(t.minute),payload={amazon_account_id:x.amazon_account_id||null,force:true,_service_role:true};
 if(h===6&&m<40){const r=await b.asServiceRole.functions.invoke('runMorningRecovery0600',payload);return Response.json({ok:true,cycle:'06:00',result:r?.data||r||{}});}
 if(h===6&&m>=40){
  const reports=await b.asServiceRole.functions.invoke('runMorningReports0640',payload);
  const accounts=x.amazon_account_id?await b.asServiceRole.entities.AmazonAccount.filter({id:x.amazon_account_id}):await b.asServiceRole.entities.AmazonAccount.filter({status:'connected'});
  const audits=[];
  for(const account of accounts){
   const sync=await b.asServiceRole.functions.invoke('syncAdsCampaignStatesV2',{amazon_account_id:account.id,trigger_type:'scheduled_0640',_service_role:true});
   const links=await b.asServiceRole.functions.invoke('fixProductCampaignLinks',{amazon_account_id:account.id,_service_role:true});
   const audit=await b.asServiceRole.functions.invoke('auditAmazonDataConsistency',{amazon_account_id:account.id,trigger_type:'scheduled_0640_post_reports',_service_role:true});
   audits.push({amazon_account_id:account.id,sync:sync?.data||sync||{},links:links?.data||links||{},audit:audit?.data||audit||{}});
  }
  return Response.json({ok:true,cycle:'06:40',reports:reports?.data||reports||{},audits});
 }
 return Response.json({ok:true,skipped:true,brazil_time:`${t.hour}:${t.minute}`,next_cycles:['06:00 repescagem','06:40 relatórios, reconciliação e análise']});
}catch(e){return Response.json({ok:false,error:e?.message||'Erro no despachante matinal'},{status:500});}});
