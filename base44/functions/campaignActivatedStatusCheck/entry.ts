import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

Deno.serve(async(req)=>{
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

    const url=new URL(req.url);

    const campaignId=String(
      body.campaign_id ||
      url.searchParams.get('campaign_id') ||
      ''
    );

    const accountId=String(
      body.amazon_account_id ||
      url.searchParams.get('amazon_account_id') ||
      ''
    );

    if(!campaignId){
      return Response.json(
        {ok:false,error:'campaign_id obrigatório'},
        {status:400}
      );
    }

    const rows=
      await base44.asServiceRole.entities.Campaign.filter(
        accountId
          ? {
              amazon_account_id:accountId,
              campaign_id:campaignId
            }
          : {
              campaign_id:campaignId
            },
        '-updated_at',
        1
      ).catch(()=>[]);

    const c=rows[0];

    if(!c){
      return Response.json({
        ok:true,
        found:false,
        campaign_id:campaignId,
        state:'UNKNOWN'
      });
    }

    const state=String(
      c.state ||
      c.status ||
      c.amazon_state ||
      ''
    ).toUpperCase();

    return Response.json({
      ok:true,
      found:true,
      campaign_id:campaignId,
      state,
      enabled:state==='ENABLED',
      paused:state==='PAUSED',
      updated_at:c.updated_at || null
    });

  }catch(error:any){

    return Response.json(
      {
        ok:false,
        error:error?.message || String(error)
      },
      {status:500}
    );
  }
});
