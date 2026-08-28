import {
  createClientFromRequest
} from 'npm:@base44/sdk@0.8.40';

function lower(v:any){
  return String(v || '')
    .trim()
    .toLowerCase();
}

function upper(v:any){
  return String(v || '')
    .trim()
    .toUpperCase();
}

function num(v:any){
  const n=Number(v);
  return Number.isFinite(n)
    ? n
    : 0;
}

function hours(v:any){
  const t=
    new Date(v || 0)
      .getTime();

  if(!Number.isFinite(t))
    return Infinity;

  return (
    Date.now()-t
  )/3600000;
}

function campaignAsin(c:any){
  return upper(
    c.asin ||
    c.advertised_asin ||
    c.product_asin
  );
}

function campaignSku(c:any){
  return String(
    c.sku ||
    c.advertised_sku ||
    c.product_sku ||
    ''
  ).trim();
}

function productStock(p:any){
  return num(
    p.fulfillable_quantity ??
    p.available_quantity ??
    p.fba_inventory ??
    p.inventory_quantity ??
    p.stock
  );
}

function activeCampaign(c:any){
  const s=lower(
    c.state ||
    c.amazon_status ||
    c.status
  );

  return (
    s==='enabled' ||
    s==='active'
  );
}

function pausedCampaign(c:any){
  const s=lower(
    c.state ||
    c.amazon_status ||
    c.status
  );

  return s==='paused';
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
      const authenticated=
        await base44.auth
          .isAuthenticated()
          .catch(()=>false);

      if(!authenticated){
        return Response.json(
          {
            ok:false,
            error:'Não autorizado'
          },
          {status:401}
        );
      }
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
            50
          );

    const reports:any[]=[];

    for(const account of accounts){

      const aid=
        account.id;

      const [
        products,
        campaigns,
        metrics,
        kickoff,
        terms,
        decisions
      ]=
        await Promise.all([

          base44
            .asServiceRole
            .entities
            .Product
            .filter(
              {
                amazon_account_id:aid
              },
              '-updated_at',
              5000
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
            .catch(()=>[]),

          base44
            .asServiceRole
            .entities
            .CampaignMetrics
            .filter(
              {
                amazon_account_id:aid
              },
              '-date',
              20000
            )
            .catch(()=>[]),

          base44
            .asServiceRole
            .entities
            .ProductKickoffQueue
            .filter(
              {
                amazon_account_id:aid
              },
              '-scheduled_at',
              5000
            )
            .catch(()=>[]),

          base44
            .asServiceRole
            .entities
            .TermBank
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
            .OptimizationDecision
            .filter(
              {
                amazon_account_id:aid
              },
              '-created_at',
              10000
            )
            .catch(()=>[])
        ]);

      /*
       * -------------------------------------------------
       * PRODUTOS ELEGÍVEIS
       * -------------------------------------------------
       *
       * Kick-off ativo OU produto Ads autorizado.
       * Hard guards continuam prevalecendo.
       */
      const eligibleProducts=
        products.filter(
          (p:any)=>{

            const asin=
              upper(p.asin);

            if(!asin)
              return false;

            const stock=
              productStock(p);

            if(stock<=0)
              return false;

            if(
              p.buyable === false
            ){
              return false;
            }

            if(
              [
                'inactive',
                'suppressed',
                'blocked',
                'closed'
              ].includes(
                lower(
                  p.listing_status ||
                  p.status
                )
              )
            ){
              return false;
            }

            const scope=
              lower(
                p.ads_scope_status
              );

            if(
              [
                'not_authorized',
                'manual_block',
                'mapping_conflict'
              ].includes(scope)
            ){
              return false;
            }

            return true;
          }
        );

      const kickoffByAsin=
        new Map<string,any[]>();

      for(const k of kickoff){

        const asin=
          upper(
            k.asin ||
            k.product_asin
          );

        if(!asin)
          continue;

        if(
          !kickoffByAsin.has(asin)
        ){
          kickoffByAsin.set(
            asin,
            []
          );
        }

        kickoffByAsin
          .get(asin)!
          .push(k);
      }

      const campaignByAsin=
        new Map<string,any[]>();

      for(const campaign of campaigns){

        const asin=
          campaignAsin(
            campaign
          );

        if(!asin)
          continue;

        if(
          !campaignByAsin.has(asin)
        ){
          campaignByAsin.set(
            asin,
            []
          );
        }

        campaignByAsin
          .get(asin)!
          .push(campaign);
      }

      const metricByCampaign=
        new Map<string,any[]>();

      for(const m of metrics){

        const cid=
          String(
            m.campaign_id ||
            m.amazon_campaign_id ||
            ''
          );

        if(!cid)
          continue;

        if(
          !metricByCampaign.has(cid)
        ){
          metricByCampaign.set(
            cid,
            []
          );
        }

        metricByCampaign
          .get(cid)!
          .push(m);
      }

      const termByAsin=
        new Map<string,any[]>();

      for(const t of terms){

        const asin=
          upper(
            t.asin ||
            t.advertised_asin ||
            t.product_asin
          );

        if(!asin)
          continue;

        if(
          !termByAsin.has(asin)
        ){
          termByAsin.set(
            asin,
            []
          );
        }

        termByAsin
          .get(asin)!
          .push(t);
      }

      const skuReviews:any[]=[];

      for(const product of eligibleProducts){

        const asin=
          upper(product.asin);

        const sku=
          String(
            product.sku ||
            product.seller_sku ||
            ''
          );

        const skuCampaigns=
          campaignByAsin.get(
            asin
          ) || [];

        const enabled=
          skuCampaigns.filter(
            activeCampaign
          );

        const paused=
          skuCampaigns.filter(
            pausedCampaign
          );

        /*
         * -------------------------------------------------
         * MÉTRICAS 7D / 30D DO SKU
         * -------------------------------------------------
         */
        let spend7=0;
        let sales7=0;
        let orders7=0;
        let clicks7=0;
        let impressions7=0;

        let spend30=0;
        let sales30=0;
        let orders30=0;
        let clicks30=0;
        let impressions30=0;

        const now=
          Date.now();

        for(const campaign of skuCampaigns){

          const cid=
            String(
              campaign.campaign_id ||
              campaign.amazon_campaign_id ||
              campaign.id ||
              ''
            );

          const rows=
            metricByCampaign.get(cid)
            || [];

          for(const m of rows){

            const date=
              new Date(
                m.date ||
                m.metric_date ||
                m.created_at ||
                0
              ).getTime();

            if(
              !Number.isFinite(date)
            ){
              continue;
            }

            const ageDays=
              (
                now-date
              )/86400000;

            const spend=
              num(
                m.spend ||
                m.cost
              );

            const sales=
              num(
                m.sales ||
                m.attributed_sales ||
                m.sales_7d
              );

            const orders=
              num(
                m.orders ||
                m.purchases ||
                m.orders_7d
              );

            const clicks=
              num(m.clicks);

            const impressions=
              num(
                m.impressions
              );

            if(ageDays<=30){

              spend30+=spend;
              sales30+=sales;
              orders30+=orders;
              clicks30+=clicks;
              impressions30+=
                impressions;
            }

            if(ageDays<=7){

              spend7+=spend;
              sales7+=sales;
              orders7+=orders;
              clicks7+=clicks;
              impressions7+=
                impressions;
            }
          }
        }

        const acos7=
          sales7>0
            ? spend7/sales7*100
            : (
                spend7>0
                  ? 999
                  : 0
              );

        const acos30=
          sales30>0
            ? spend30/sales30*100
            : (
                spend30>0
                  ? 999
                  : 0
              );

        const roas7=
          spend7>0
            ? sales7/spend7
            : 0;

        const roas30=
          spend30>0
            ? sales30/spend30
            : 0;

        const cpc7=
          clicks7>0
            ? spend7/clicks7
            : 0;

        const ctr7=
          impressions7>0
            ? clicks7/
              impressions7*100
            : 0;

        const cvr7=
          clicks7>0
            ? orders7/clicks7*100
            : 0;

        const winners=
          (
            termByAsin.get(asin)
            || []
          )
            .filter(
              (t:any)=>
                num(
                  t.orders ||
                  t.purchases
                )>0
                ||
                lower(
                  t.classification ||
                  t.status
                ).includes(
                  'winner'
                )
            );

        const kickoffRows=
          kickoffByAsin.get(
            asin
          ) || [];

        const activeKickoff=
          kickoffRows.some(
            (k:any)=>
              ![
                'failed_final',
                'cancelled',
                'canceled',
                'completed'
              ].includes(
                lower(k.status)
              )
          );

        /*
         * -------------------------------------------------
         * DIAGNÓSTICO DO SKU
         * -------------------------------------------------
         */
        let priority='P2';
        let recommended=
          'HOLD';
        let reason=
          'SKU_HEALTHY_OR_LEARNING';

        /*
         * P0 — dinheiro sendo gasto sem retorno.
         */
        if(
          spend7>=5 &&
          clicks7>=12 &&
          orders7===0
        ){
          priority='P0';
          recommended=
            'WASTE_CONTROL';
          reason=
            'SKU_PROVEN_ZERO_ORDER_WASTE';
        }

        /*
         * P0 — economia ruim com vendas.
         */
        else if(
          orders7>0 &&
          acos7>160
        ){
          priority='P0';
          recommended=
            'REDUCE_BID';
          reason=
            'SKU_SEVERE_ACOS_CONTROL';
        }

        /*
         * P1 — produto apto sem cobertura ativa.
         */
        else if(
          enabled.length===0
        ){
          priority='P1';
          recommended=
            activeKickoff
              ? 'CONTINUE_KICKOFF'
              : 'KICKOFF_OR_REBUILD';

          reason=
            'SKU_WITH_STOCK_WITHOUT_ACTIVE_CAMPAIGN';
        }

        /*
         * P1 — zero delivery.
         */
        else if(
          impressions7===0 &&
          clicks7===0 &&
          spend7===0
        ){
          priority='P1';
          recommended=
            'ZERO_DELIVERY_RECOVERY';

          reason=
            'SKU_ZERO_DELIVERY';
        }

        /*
         * P1 — nenhum pedido em 30d mas existem winners
         * históricos: reconstruir estrutura.
         */
        else if(
          orders30===0 &&
          winners.length>0
        ){
          priority='P1';
          recommended=
            'REBUILD_FROM_WINNER_TERMS';

          reason=
            'SKU_NO_CURRENT_SALES_WITH_WINNER_TERMS';
        }

        /*
         * P1/P2 — winner com espaço de crescimento.
         */
        else if(
          orders7>0 &&
          roas7>=3 &&
          acos7>0 &&
          acos7<=90
        ){
          priority='P1';
          recommended=
            'SCALE_WINNER';

          reason=
            'SKU_PROFITABLE_WINNER';
        }

        /*
         * P2 — entrega baixa.
         */
        else if(
          impressions7>0 &&
          impressions7<100
        ){
          priority='P2';
          recommended=
            'RECOVER_VISIBILITY';

          reason=
            'SKU_LOW_IMPRESSIONS';
        }

        skuReviews.push({
          asin,
          sku,

          product_id:
            product.id,

          product_name:
            product.product_name ||
            product.title ||
            product.name ||
            null,

          stock:
            productStock(product),

          kickoff_active:
            activeKickoff,

          campaigns:{
            total:
              skuCampaigns.length,

            enabled:
              enabled.length,

            paused:
              paused.length
          },

          metrics_7d:{
            spend:
              Number(
                spend7.toFixed(2)
              ),

            sales:
              Number(
                sales7.toFixed(2)
              ),

            orders:
              orders7,

            clicks:
              clicks7,

            impressions:
              impressions7,

            acos:
              Number(
                acos7.toFixed(2)
              ),

            roas:
              Number(
                roas7.toFixed(2)
              ),

            cpc:
              Number(
                cpc7.toFixed(2)
              ),

            ctr:
              Number(
                ctr7.toFixed(2)
              ),

            cvr:
              Number(
                cvr7.toFixed(2)
              )
          },

          metrics_30d:{
            spend:
              Number(
                spend30.toFixed(2)
              ),

            sales:
              Number(
                sales30.toFixed(2)
              ),

            orders:
              orders30,

            clicks:
              clicks30,

            impressions:
              impressions30,

            acos:
              Number(
                acos30.toFixed(2)
              ),

            roas:
              Number(
                roas30.toFixed(2)
              )
          },

          winner_terms:
            winners
              .slice(0,13)
              .map(
                (t:any)=>({
                  term:
                    t.search_term ||
                    t.term ||
                    t.keyword ||
                    t.keyword_text,

                  orders:
                    num(
                      t.orders ||
                      t.purchases
                    ),

                  sales:
                    num(
                      t.sales
                    )
                })
              ),

          priority,
          recommended_action:
            recommended,
          reason
        });
      }

      /*
       * -------------------------------------------------
       * ORDENAR TODOS OS SKUs.
       *
       * Nenhum SKU elegível desaparece porque outro SKU
       * esteja vendendo muito.
       * -------------------------------------------------
       */
      const rank:any={
        P0:0,
        P1:1,
        P2:2,
        P3:3
      };

      skuReviews.sort(
        (a,b)=>
          (
            rank[a.priority] ??
            9
          )
          -
          (
            rank[b.priority] ??
            9
          )
          ||
          a.metrics_7d.orders
          -
          b.metrics_7d.orders
      );

      /*
       * -------------------------------------------------
       * DISPARAR AÇÕES CANÔNICAS EXISTENTES
       * -------------------------------------------------
       *
       * Não executamos Amazon diretamente aqui.
       * Apenas usamos capacidades já pertencentes ao V3.
       */
      const noCoverage=
        skuReviews.filter(
          r =>
            r.recommended_action===
            'KICKOFF_OR_REBUILD'
        );

      const zeroDelivery=
        skuReviews.filter(
          r =>
            r.recommended_action===
            'ZERO_DELIVERY_RECOVERY'
        );

      const rebuildWinner=
        skuReviews.filter(
          r =>
            r.recommended_action===
            'REBUILD_FROM_WINNER_TERMS'
        );

      const winnerScale=
        skuReviews.filter(
          r =>
            r.recommended_action===
            'SCALE_WINNER'
        );

      /*
       * Cobertura / kick-off.
       */
      if(
        noCoverage.length>0 &&
        body.execute_actions !== false
      ){
        await base44
          .asServiceRole
          .functions
          .invoke(
            'ensureActiveProductCampaignCoverage',
            {
              _service_role:true,

              amazon_account_id:
                aid,

              target_asins:
                noCoverage.map(
                  r=>r.asin
                ),

              force:true,

              canonical_engine:
                'CANONICAL_PROFIT_ENGINE_V3',

              policy_version:
                'PROFIT_ENGINE_V3',

              trigger_type:
                'v3_sku_coverage'
            }
          )
          .catch(()=>null);
      }

      /*
       * Winner harvesting / rebuild.
       */
      if(
        (
          rebuildWinner.length>0
          ||
          winnerScale.length>0
        )
        &&
        body.execute_actions !== false
      ){
        await base44
          .asServiceRole
          .functions
          .invoke(
            'runImmediateSameSkuSearchTermHarvest',
            {
              _service_role:true,

              amazon_account_id:
                aid,

              target_asins:[
                ...new Set([
                  ...rebuildWinner.map(
                    r=>r.asin
                  ),

                  ...winnerScale.map(
                    r=>r.asin
                  )
                ])
              ],

              lookback_days:65,

              max_terms_per_asin:13,

              require_same_sku_attribution:true,

              include_paused_campaign_history:true,

              canonical_engine:
                'CANONICAL_PROFIT_ENGINE_V3',

              policy_version:
                'PROFIT_ENGINE_V3',

              trigger_type:
                'v3_sku_winner_harvest'
            }
          )
          .catch(()=>null);
      }

      /*
       * Zero delivery e demais decisões econômicas
       * voltam ao próprio V3 para avaliação com contexto
       * SKU explícito.
       */
      if(
        skuReviews.length>0 &&
        body.reenter_v3 === true
      ){

        await base44
          .asServiceRole
          .functions
          .invoke(
            'runCanonicalDecisionCycle',
            {
              _service_role:true,

              dry_run:false,

              force:true,

              force_full_scan:false,

              target_asins:
                skuReviews.map(
                  r=>r.asin
                ),

              sku_context:
                skuReviews,

              sku_by_sku_review:true,

              canonical_engine:
                'CANONICAL_PROFIT_ENGINE_V3',

              policy_version:
                'PROFIT_ENGINE_V3',

              trigger_type:
                'v3_sku_portfolio_reentry',

              /*
               * Evita recursão.
               */
              skip_sku_portfolio_review:
                true
            }
          )
          .catch(()=>null);
      }

      const productsWithOrders=
        skuReviews.filter(
          r =>
            r.metrics_7d.orders>0
        ).length;

      const productsWithoutOrders=
        skuReviews.filter(
          r =>
            r.metrics_7d.orders===0
        ).length;

      reports.push({
        amazon_account_id:
          aid,

        eligible_skus:
          skuReviews.length,

        skus_with_sales_7d:
          productsWithOrders,

        skus_without_sales_7d:
          productsWithoutOrders,

        sku_sales_coverage_pct:
          skuReviews.length>0
            ? Number(
                (
                  productsWithOrders /
                  skuReviews.length *
                  100
                ).toFixed(2)
              )
            : 0,

        p0:
          skuReviews.filter(
            r=>r.priority==='P0'
          ).length,

        p1:
          skuReviews.filter(
            r=>r.priority==='P1'
          ).length,

        p2:
          skuReviews.filter(
            r=>r.priority==='P2'
          ).length,

        without_active_campaign:
          noCoverage.length,

        zero_delivery:
          zeroDelivery.length,

        rebuild_from_winners:
          rebuildWinner.length,

        profitable_winners:
          winnerScale.length,

        sku_reviews:
          skuReviews
      });
    }

    return Response.json({
      ok:true,

      engine:
        'CANONICAL_PROFIT_ENGINE_V3',

      operation:
        'SKU_BY_SKU_PORTFOLIO_REVIEW',

      objectives:{
        primary:
          'maximize_expected_profit',

        product_level:
          'generate_profitable_sales_for_every_eligible_sku',

        portfolio_success:
          'overall_profit_plus_sales_coverage_by_sku'
      },

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
