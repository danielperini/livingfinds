import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
/** Legacy suggestion entry point shares the same evidence and deduplication gate as every normal promotion. */
Deno.serve(async req => {
  try {
    const base44=createClientFromRequest(req);
    const body=await req.json().catch(()=>({}));
    if (!body._service_role && !(await base44.auth.isAuthenticated().catch(()=>false))) return Response.json({ok:false,error:'Não autorizado'},{status:401});
    if (!body.amazon_account_id || !Array.isArray(body.suggestion_ids) || !body.suggestion_ids.length) return Response.json({ok:false,error:'Conta e suggestion_ids são obrigatórios'},{status:400});
    const results:any[]=[];
    for(const id of [...new Set(body.suggestion_ids)]) {
      const rows=await base44.asServiceRole.entities.KeywordSuggestion.filter({id,amazon_account_id:body.amazon_account_id},undefined,1);
      const suggestion=rows[0];
      if(!suggestion) {results.push({id,ok:false,blocked:true,error:'Sugestão não encontrada nesta conta'});continue;}
      if(suggestion.status==='created') {results.push({id,ok:false,already_exists:true});continue;}
      const response=await base44.asServiceRole.functions.invoke('createManualCampaignV2',{
        _service_role:true,amazon_account_id:body.amazon_account_id,asin:suggestion.asin,sku:suggestion.sku,
        keyword:suggestion.keyword,dry_run:body.dry_run===true,
      });
      const data=response?.data||response||{};
      if(data.ok && data.campaign_id && !body.dry_run) await base44.asServiceRole.entities.KeywordSuggestion.update(suggestion.id,{
        status:'created',amazon_campaign_id:data.campaign_id,executed_at:new Date().toISOString(),
      });
      results.push({id,ok:data.ok===true,blocked:data.blocked===true,keyword:suggestion.keyword,amazon_campaign_id:data.campaign_id,error:data.error});
    }
    return Response.json({ok:true,created:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok&&!r.blocked&&!r.already_exists).length,blocked:results.filter(r=>r.blocked).length,already_exists:results.filter(r=>r.already_exists).length,results});
  } catch(error: any) {return Response.json({ok:false,error:error.message},{status:500});}
});