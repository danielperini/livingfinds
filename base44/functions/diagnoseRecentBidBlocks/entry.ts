import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const TERMS = [
  'lixeira anti odor',
  'lixeira inteligente',
  'lixo banheiro',
  'lixeira cozinha com sensor',
  'lixeiro banheiro',
  'lixeira pequena',
  'lixeira banheiro automatica',
  'lixeira antiodor',
];

const norm = (v:any) =>
  String(v || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');

const num = (v:any) =>
  Number.isFinite(Number(v)) ? Number(v) : null;

Deno.serve(async(req)=>{
  try{
    const base44=createClientFromRequest(req);
    const body=await req.json().catch(()=>({}));

    const auth=
      await base44.auth.isAuthenticated().catch(()=>false);

    if(!auth && !body._service_role){
      return Response.json(
        {ok:false,error:'Não autorizado'},
        {status:401}
      );
    }

    const accounts=
      await base44.asServiceRole.entities.AmazonAccount.filter(
        {status:'connected'},
        '-updated_at',
        50
      );

    const output:any[]=[];

    for(const account of accounts){

      const aid=String(account.id);

      const [
        decisions,
        campaigns,
        products,
        snapshots
      ]=await Promise.all([

        base44.asServiceRole.entities.OptimizationDecision.filter(
          {amazon_account_id:aid},
          '-created_at',
          5000
        ).catch(()=>[]),

        base44.asServiceRole.entities.Campaign.filter(
          {amazon_account_id:aid},
          '-updated_at',
          10000
        ).catch(()=>[]),

        base44.asServiceRole.entities.Product.filter(
          {amazon_account_id:aid},
          '-updated_at',
          10000
        ).catch(()=>[]),

        base44.asServiceRole.entities.RepricingSnapshot.filter(
          {amazon_account_id:aid},
          '-created_at',
          10000
        ).catch(()=>[])
      ]);

      const campaignsById=new Map<string,any>();

      for(const c of campaigns){
        for(const id of [
          c.id,
          c.campaign_id,
          c.amazon_campaign_id
        ].filter(Boolean)){
          campaignsById.set(String(id),c);
        }
      }

      const productsByAsin=new Map<string,any>();

      for(const p of products){
        if(p.asin){
          productsByAsin.set(
            String(p.asin).toUpperCase(),
            p
          );
        }
      }

      const wanted=new Set(TERMS.map(norm));

      const matches=decisions
        .filter((d:any)=>{
          const label=norm(
            d.keyword_text ||
            d.search_term ||
            d.term ||
            d.entity_name ||
            d.name
          );

          return (
            wanted.has(label) &&
            String(d.action || '').includes('bid')
          );
        })
        .slice(0,200);

      for(const d of matches){

        const campaignId=String(
          d.campaign_id ||
          (
            d.entity_type==='campaign'
              ? d.entity_id
              : ''
          ) ||
          ''
        );

        const asin=String(
          d.asin ||
          d.product_asin ||
          ''
        ).toUpperCase();

        const campaign=
          campaignsById.get(campaignId);

        const product=
          productsByAsin.get(asin);

        const snapshot=
          snapshots.find((s:any)=>
            (
              asin &&
              String(s.asin || '').toUpperCase()===asin
            )
            ||
            (
              product?.sku &&
              String(s.sku || '')===String(product.sku)
            )
          ) || null;

        let dataUsed:any={};

        try{
          dataUsed=
            typeof d.data_used==='string'
              ? JSON.parse(d.data_used)
              : d.data_used || {};
        }catch{}

        output.push({
          created_at:d.created_at,
          updated_at:d.updated_at,

          term:
            d.keyword_text ||
            d.search_term ||
            d.term ||
            d.entity_name ||
            d.name,

          asin,
          campaign_id:campaignId,

          action:d.action,

          status:d.status,
          queue_status:d.queue_status,

          approval_status:d.approval_status,
          confirmation_status:d.confirmation_status,

          reason_code:d.reason_code,
          rule_key:d.rule_key,

          rationale:d.rationale,
          error_message:d.error_message,
          confirmation_error:d.confirmation_error,

          execution_mode:d.execution_mode,
          priority_class:d.priority_class,

          value_before:
            num(d.value_before ?? d.current_value),

          value_after:
            num(d.value_after ?? d.proposed_value),

          safe_max_cpc:
            num(
              d.safe_max_cpc ??
              dataUsed?.safe_max_cpc ??
              dataUsed?.admission?.safe_max_cpc
            ),

          maximum_cpc:
            num(d.maximum_cpc),

          attempt_count:
            num(d.attempt_count),

          next_retry_at:d.next_retry_at,

          execute_before:d.execute_before,

          campaign_state:
            campaign?.state ||
            campaign?.status,

          campaign_budget:
            num(
              campaign?.daily_budget ||
              campaign?.budget
            ),

          product_status:
            product?.status ||
            product?.state ||
            product?.amazon_status,

          stock:
            num(
              product?.fulfillable_quantity ??
              product?.available_quantity ??
              product?.inventory_quantity ??
              product?.stock ??
              product?.fba_inventory
            ),

          listing_status:
            snapshot?.listing_status,

          offer_status:
            snapshot?.offer_status,

          buyable:
            snapshot?.buyable,

          inventory_available:
            num(snapshot?.inventory_available),

          data_fresh:
            snapshot?.data_fresh,

          ads_data_fresh_at:
            snapshot?.ads_data_fresh_at,

          sp_api_data_fresh_at:
            snapshot?.sp_api_data_fresh_at,

          economics_data_fresh_at:
            snapshot?.economics_data_fresh_at,

          economic_state:
            snapshot?.economic_state,

          economic_confidence:
            num(snapshot?.economic_confidence),

          snapshot_id:
            snapshot?.id,

          canonical_action_type:
            d.canonical_action_type,

          source_function:
            d.source_function,
        });
      }
    }

    return Response.json({
      ok:true,
      count:output.length,
      rows:output
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
