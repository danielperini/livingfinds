import {
  createClientFromRequest
} from 'npm:@base44/sdk@0.8.40';

function upper(v:any){
  return String(v || '')
    .trim()
    .toUpperCase();
}

function id(v:any){
  return String(v || '');
}

async function loadPaged(
  entity:any,
  query:any,
  sort:string,
  maximum=30000
){
  const rows:any[]=[];

  for(
    let skip=0;
    skip<maximum;
    skip+=5000
  ){

    const page=
      await entity
        .filter(
          query,
          sort,
          Math.min(
            5000,
            maximum-skip
          ),
          skip
        )
        .catch(()=>[]);

    rows.push(...page);

    if(page.length<5000)
      break;
  }

  return rows;
}

Deno.serve(async(req)=>{

  const started=
    Date.now();

  try{

    const base44:any=
      createClientFromRequest(req);

    const body:any=
      await req.json()
        .catch(()=>({}));

    if(
      body._service_role !== true
    ){
      return Response.json(
        {
          ok:false,
          error:'service role required'
        },
        {status:401}
      );
    }

    const accounts=
      body.amazon_account_id

      ? await base44
          .asServiceRole
          .entities
          .AmazonAccount
          .filter(
            {id:body.amazon_account_id},
            undefined,
            1
          )

      : await base44
          .asServiceRole
          .entities
          .AmazonAccount
          .filter(
            {status:'connected'},
            '-updated_at',
            20
          );

    const reports:any[]=[];

    for(const account of accounts){

      const aid=
        account.id;

      const [
        searchTerms,
        productAds,
        campaigns
      ]=
        await Promise.all([

          loadPaged(
            base44
              .asServiceRole
              .entities
              .SearchTerm,

            {
              amazon_account_id:aid
            },

            '-date',

            30000
          ),

          base44
            .asServiceRole
            .entities
            .ProductAd
            .filter(
              {
                amazon_account_id:aid
              },
              '-updated_at',
              10000
            )
            .catch(()=>[]),

          base44
            .asServiceRole
            .entities
            .Campaign
            .filter(
              {
                amazon_account_id:aid
              },
              '-updated_at',
              10000
            )
            .catch(()=>[])
        ]);

      const campaignById=
        new Map<string,any>();

      for(const campaign of campaigns){

        for(const value of [
          campaign.id,
          campaign.campaign_id,
          campaign.amazon_campaign_id
        ]){

          if(value){
            campaignById.set(
              id(value),
              campaign
            );
          }
        }
      }

      const adsByAdGroup=
        new Map<string,any[]>();

      const adsByCampaign=
        new Map<string,any[]>();

      for(const ad of productAds){

        const state=
          String(
            ad.state ||
            ad.status ||
            ''
          ).toLowerCase();

        if(state==='archived')
          continue;

        const agid=
          id(ad.ad_group_id);

        const cid=
          id(ad.campaign_id);

        if(agid){

          const rows=
            adsByAdGroup.get(agid)
            || [];

          rows.push(ad);

          adsByAdGroup.set(
            agid,
            rows
          );
        }

        if(cid){

          const rows=
            adsByCampaign.get(cid)
            || [];

          rows.push(ad);

          adsByCampaign.set(
            cid,
            rows
          );
        }
      }

      let scanned=0;
      let updated=0;
      let ambiguous=0;
      let alreadyVerified=0;
      let missing=0;

      const examples:any[]=[];

      /*
       * Processar em batches para não sobrecarregar DB.
       */
      const patches:any[]=[];

      for(const row of searchTerms){

        scanned++;

        if(
          row.same_sku_attribution_verified === true
        ){
          alreadyVerified++;
          continue;
        }

        const cid=
          id(row.campaign_id);

        const agid=
          id(row.ad_group_id);

        const candidates=
          (
            adsByAdGroup.get(agid)
            ||
            adsByCampaign.get(cid)
            ||
            []
          );

        const distinctAsins=
          [
            ...new Set(
              candidates
                .map(
                  (ad:any)=>
                    upper(ad.asin)
                )
                .filter(Boolean)
            )
          ];

        /*
         * Nunca presumir quando há mais de um produto.
         */
        if(distinctAsins.length>1){

          ambiguous++;

          continue;
        }

        let asin='';
        let sku='';

        if(distinctAsins.length===1){

          asin=
            distinctAsins[0];

          const ad=
            candidates.find(
              (x:any)=>
                upper(x.asin)===asin
            )
            || {};

          sku=
            String(
              ad.sku ||
              ''
            ).trim();
        }

        /*
         * Fallback secundário:
         * campanha já possui ASIN único.
         */
        if(!asin){

          const campaign=
            campaignById.get(cid);

          if(campaign?.asin){

            asin=
              upper(
                campaign.asin
              );

            sku=
              String(
                campaign.sku ||
                ''
              ).trim();
          }
        }

        if(!asin){

          missing++;
          continue;
        }

        /*
         * Se o SearchTerm já traz um ASIN diferente,
         * não sobrescrever.
         */
        const existingAsin=
          upper(
            row.advertised_asin ||
            row.asin
          );

        if(
          existingAsin &&
          existingAsin!==asin
        ){
          ambiguous++;
          continue;
        }

        patches.push({
          id:row.id,

          advertised_asin:
            asin,

          advertised_sku:
            row.advertised_sku ||
            sku ||
            '',

          sku_resolution_status:
            'single_advertised_sku',

          updated_at:
            new Date().toISOString()
        });

        if(examples.length<30){

          examples.push({
            search_term:
              row.search_term,

            campaign_id:
              cid,

            ad_group_id:
              agid,

            asin,

            sku:
              row.advertised_sku ||
              sku ||
              null
          });
        }
      }

      for(
        let index=0;
        index<patches.length;
        index+=100
      ){

        const batch=
          patches.slice(
            index,
            index+100
          );

        await base44
          .asServiceRole
          .entities
          .SearchTerm
          .bulkUpdate(batch);

        updated+=
          batch.length;
      }

      reports.push({
        amazon_account_id:aid,

        scanned,

        already_verified:
          alreadyVerified,

        changed_to_single_advertised_sku:
          updated,

        ambiguous,

        missing,

        examples
      });
    }

    return Response.json({
      ok:true,

      engine:
        'CANONICAL_PROFIT_ENGINE_V3',

      operation:
        'BACKFILL_SINGLE_ADVERTISED_SKU_SEARCH_TERMS',

      reports,

      duration_ms:
        Date.now()-started
    });

  }catch(error:any){

    return Response.json(
      {
        ok:false,
        error:
          error?.message ||
          String(error)
      },
      {status:500}
    );
  }
});
