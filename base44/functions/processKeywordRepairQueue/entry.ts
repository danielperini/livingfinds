import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function hourBR(){const p=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',hour12:false}).formatToParts(new Date());return Number(p.find(x=>x.type==='hour')?.value||0);}

Deno.serve(async(req)=>{try{
  const b=createClientFromRequest(req),body=await req.json().catch(()=>({}));
  if(!body._service_role)return Response.json({ok:false,error:'Uso interno'},{status:403});
  const hour=Number.isFinite(Number(body.hour))?Number(body.hour):hourBR();
  if(![0,1,2,3,13].includes(hour))return Response.json({ok:true,skipped:true,hour});
  const rows=await b.asServiceRole.entities.KeywordRepairQueue.filter({...(body.amazon_account_id?{amazon_account_id:body.amazon_account_id}:{}),status:'scheduled',queue_hour:hour},'scheduled_at',10);
  const results=[];
  for(const item of rows){
    if(item.scheduled_at&&new Date(item.scheduled_at).getTime()>Date.now())continue;
    await b.asServiceRole.entities.KeywordRepairQueue.update(item.id,{status:'processing',attempt_count:Number(item.attempt_count||0)+1});
    try{
      const r=await b.asServiceRole.functions.invoke('repairExactAdGroupKeywords',{amazon_account_id:item.amazon_account_id,asins:[item.asin],_window_execution:true,_service_role:true});
      const data=r?.data||r||{};
      const ok=data?.results?.some((x:any)=>x.asin===item.asin&&x.complete===true)===true;
      const attempts=Number(item.attempt_count||0)+1;
      const retry=!ok&&attempts<5;
      await b.asServiceRole.entities.KeywordRepairQueue.update(item.id,{status:ok?'completed':retry?'scheduled':'failed',attempt_count:attempts,last_error:ok?null:String(data?.error||data?.results?.[0]?.error||'Grupo ainda sem keyword').slice(0,500)});
      results.push({id:item.id,asin:item.asin,ok,retry_scheduled:retry});
    }catch(e){
      const attempts=Number(item.attempt_count||0)+1,retry=attempts<5;
      await b.asServiceRole.entities.KeywordRepairQueue.update(item.id,{status:retry?'scheduled':'failed',attempt_count:attempts,last_error:String(e?.message||e).slice(0,500)}).catch(()=>{});
      results.push({id:item.id,asin:item.asin,ok:false,retry_scheduled:retry});
    }
    await wait(14000);
  }
  return Response.json({ok:true,hour,processed:results.length,spacing_seconds:14,results});
}catch(e){return Response.json({ok:false,error:e?.message||'Erro na fila de keywords'},{status:500});}});
