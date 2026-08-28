import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { validateAmazonAction } from '../../shared/amazonActionRegistry.ts';

const n=(v:any)=>{
  const x=Number(v);
  return Number.isFinite(x) ? x : 0;
};

function json(v:any){
  if(!v) return {};
  if(typeof v==='object') return v;
  try{return JSON.parse(String(v));}
  catch{return {};}
}

function active(v:any){
  return ['enabled','active'].includes(
    String(v||'').toLowerCase()
  );
}

function stock(p:any){
  return Math.max(
    n(p?.fba_inventory),
    n(p?.inventory_available),
    n(p?.available_quantity),
    n(p?.quantity),
    n(p?.stock)
  );
}

function actionFamily(action:string){
  if(action.includes('bid')) return 'bid';
  if(action.includes('budget')) return 'budget';
  if(action.includes('pause')) return 'pause';
  if(action.includes('enable')) return 'enable';
  if(action.includes('campaign') || action.includes('keyword')) return 'create';
  return action;
}

function keyOf(d:any){
  return [
    String(d.action||''),
    String(d.entity_type||'')
  ].join('|');
}

function conflictKey(d:any){
  return String(
    d.conflict_group ||
    [
      d.action,
      d.entity_type,
      d.entity_id ||
      d.keyword_id ||
      d.campaign_id ||
      d.asin
    ].join('|')
  );
}

const EXECUTABLE = new Set([
  'increase_bid',
  'reduce_bid',
  'set_bid',
  'update_bid',

  'increase_budget',
  'reduce_budget',
  'set_budget',
  'update_budget',

  'pause_campaign',
  'pause_keyword',

  'enable_campaign',
  'enable_keyword'
]);

const SALES_POSITIVE = new Set([
  'increase_bid',
  'set_bid',
  'update_bid',

  'increase_budget',
  'set_budget',
  'update_budget',

  'enable_campaign',
  'enable_keyword'
]);

Deno.serve(async(req)=>{

  const started=Date.now();

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

    const accounts=body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter(
          {id:body.amazon_account_id},
          undefined,
          1
        )
      : await base44.asServiceRole.entities.AmazonAccount.filter(
          {status:'connected'},
          '-updated_at',
          50
        );

    const accountResults:any[]=[];

    for(const account of accounts){

      const aid=String(account.id);

      /*
       * Uma consulta para TODO o histórico.
       * Limite 5000 cobre os 2953 informados.
       */
      const [
        all,
        campaigns,
        products,
        metrics
      ]=await Promise.all([

        base44.asServiceRole.entities.OptimizationDecision.filter(
          {amazon_account_id:aid},
          '-updated_at',
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

        base44.asServiceRole.entities.CampaignMetricsDaily.filter(
          {amazon_account_id:aid},
          '-date',
          50000
        ).catch(()=>[])
      ]);

      /*
       * ========================================
       * 1. APRENDER COM DECISÕES CONFIRMADAS
       * ========================================
       */

      const confirmed=all.filter((d:any)=>
        d.confirmation_status==='confirmed' ||
        (
          ['executed','completed'].includes(
            String(d.status||'')
          ) &&
          d.confirmed_at
        )
      );

      const templateByExact=
        new Map<string,any>();

      const templateByFamily=
        new Map<string,any>();

      for(const d of confirmed){

        const exact=keyOf(d);
        const family=actionFamily(
          String(d.action||'')
        );

        if(!templateByExact.has(exact)){
          templateByExact.set(exact,d);
        }

        if(!templateByFamily.has(family)){
          templateByFamily.set(family,d);
        }
      }

      /*
       * Os exemplos como:
       *
       * lixeira automatica 6l
       * lixeira banheiro automática 15l
       * lixeira cozinha sensor
       * lixeira de banheiro automatica com sensor
       *
       * são usados aqui pelo STATUS CONFIRMED,
       * e não pela palavra do termo.
       */

      /*
       * ========================================
       * 2. MAPEAR PRODUTOS/CAMPANHAS
       * ========================================
       */

      const productsByAsin=
        new Map<string,any>();

      for(const p of products){
        const asin=String(
          p.asin||''
        ).toUpperCase();

        if(asin){
          productsByAsin.set(asin,p);
        }
      }

      const campaignsById=
        new Map<string,any>();

      for(const c of campaigns){

        for(const id of [
          c.id,
          c.campaign_id,
          c.amazon_campaign_id
        ].filter(Boolean)){

          campaignsById.set(
            String(id),
            c
          );
        }
      }

      /*
       * ========================================
       * 3. MÉTRICAS 30 DIAS
       * ========================================
       */

      const cutoff30=
        new Date(
          Date.now()-30*86400000
        ).toISOString().slice(0,10);

      const agg=new Map<string,any>();

      for(const m of metrics){

        if(String(m.date||'') < cutoff30)
          continue;

        const cid=String(m.campaign_id||'');

        if(!cid) continue;

        const a=agg.get(cid)||{
          impressions:0,
          clicks:0,
          spend:0,
          sales:0,
          orders:0
        };

        a.impressions+=n(m.impressions);
        a.clicks+=n(m.clicks);
        a.spend+=n(m.spend);
        a.sales+=n(m.sales);
        a.orders+=n(m.orders);

        agg.set(cid,a);
      }

      /*
       * ========================================
       * 4. DEDUPLICAR AS 2953
       * ========================================
       */

      const latest=
        new Map<string,any>();

      const duplicates:any[]=[];

      for(const d of all){

        /*
         * Não mexer no histórico confirmado.
         */
        if(
          d.confirmation_status==='confirmed'
        ){
          continue;
        }

        const key=conflictKey(d);
        const old=latest.get(key);

        if(!old){
          latest.set(key,d);
          continue;
        }

        const oldTime=
          new Date(
            old.updated_at ||
            old.created_at ||
            0
          ).getTime();

        const newTime=
          new Date(
            d.updated_at ||
            d.created_at ||
            0
          ).getTime();

        if(newTime > oldTime){
          duplicates.push(old);
          latest.set(key,d);
        }else{
          duplicates.push(d);
        }
      }

      let duplicateClosed=0;

      for(const d of duplicates){

        await base44.asServiceRole.entities.OptimizationDecision.update(
          d.id,
          {
            status:'cancelled',
            queue_status:'none',

            approval_status:
              'confirmed_pattern_duplicate',

            error_message:
              'NO_DECISION_DUPLICATE: decisão posterior equivalente preservada.',

            updated_at:
              new Date().toISOString()
          }
        ).catch(()=>null);

        duplicateClosed++;
      }

      /*
       * ========================================
       * 5. CLASSIFICAR TODAS AS ÚNICAS
       * ========================================
       */

      const eligible:any[]=[];
      const noDecision:any[]=[];

      for(const d of latest.values()){

        const action=String(d.action||'');

        if(!EXECUTABLE.has(action)){
          noDecision.push({
            d,
            reason:'NON_EXECUTABLE_ACTION'
          });
          continue;
        }

        const family=actionFamily(action);

        const template=
          templateByExact.get(keyOf(d)) ||
          templateByFamily.get(family) ||
          null;

        /*
         * Queremos usar como modelo algo que
         * comprovadamente já chegou à Amazon.
         */
        if(!template){
          noDecision.push({
            d,
            reason:'NO_CONFIRMED_PATTERN'
          });
          continue;
        }

        const evidence=json(d.data_used);
        const admission=evidence?.admission||{};

        const asin=String(
          d.asin ||
          d.product_asin ||
          admission.asin ||
          ''
        ).toUpperCase();

        const p=
          productsByAsin.get(asin);

        const availableStock=
          p ? stock(p) : 0;

        const pState=String(
          p?.status ||
          p?.state ||
          ''
        ).toLowerCase();

        const productActive=
          !p ||
          ![
            'inactive',
            'archived',
            'deleted',
            'suppressed'
          ].includes(pState);

        const cid=String(
          d.campaign_id ||
          (
            d.entity_type==='campaign'
              ? d.entity_id
              : ''
          ) ||
          ''
        );

        const campaign=
          campaignsById.get(cid);

        const campaignActive=
          campaign
            ? active(
                campaign.state ||
                campaign.status
              )
            : true;

        const m=agg.get(cid)||{
          impressions:0,
          clicks:0,
          spend:0,
          sales:0,
          orders:0
        };

        const acos=
          m.sales>0
            ? m.spend/m.sales*100
            : null;

        const roas=
          m.spend>0
            ? m.sales/m.spend
            : 0;

        const reasonText=[
          d.reason_code,
          d.rule_key,
          d.rationale,
          d.error_message
        ]
        .join(' ')
        .toUpperCase();

        /*
         * Hard guards continuam fora.
         */
        const hard=
          /ACCOUNT_KILL_SWITCH|ACCOUNT_DAILY_CAP|OUT_OF_STOCK|NOT_BUYABLE|LISTING_INACTIVE|LISTING_SUPPRESSED|OFFER_INACTIVE|PARENT_ASIN/.test(
            reasonText
          );

        if(hard){
          noDecision.push({
            d,
            reason:'HARD_GUARD'
          });
          continue;
        }

        /*
         * Crescimento: ASIN conhecido exige
         * produto ativo + estoque.
         */
        if(
          SALES_POSITIVE.has(action) &&
          asin &&
          (
            !productActive ||
            availableStock<=0
          )
        ){
          noDecision.push({
            d,
            reason:'NO_ACTIVE_STOCK'
          });
          continue;
        }

        /*
         * Pause só é aceita se houver desperdício comprovado.
         */
        if(action.includes('pause')){

          const provenWaste=
            m.orders===0 &&
            (
              m.spend>=5 ||
              (
                m.impressions===0 &&
                m.clicks===0
              )
            );

          const winner=
            m.orders>0 &&
            m.sales>0 &&
            (
              acos===null ||
              acos<=50 ||
              roas>=2
            );

          if(winner){
            noDecision.push({
              d,
              reason:'WINNER_PROTECTED'
            });
            continue;
          }

          if(!provenWaste){
            noDecision.push({
              d,
              reason:'PAUSE_NOT_PROVEN'
            });
            continue;
          }
        }

        /*
         * Bid: não passar do safe CPC.
         */
        const safeCpc=Math.max(
          n(d.safe_max_cpc),
          n(admission.safe_max_cpc),
          n(evidence.safe_max_cpc)
        );

        const after=n(
          d.value_after ??
          d.proposed_bid
        );

        if(
          action.includes('bid') &&
          safeCpc>0 &&
          after>safeCpc*1.02
        ){
          noDecision.push({
            d,
            reason:'SAFE_CPC_EXCEEDED'
          });
          continue;
        }

        /*
         * ====================================
         * SALES SCORE
         * ====================================
         */

        let score=0;

        /*
         * Já existe padrão confirmado igual.
         */
        score+=30;

        if(SALES_POSITIVE.has(action))
          score+=15;

        if(availableStock>0)
          score+=20;

        if(productActive)
          score+=10;

        if(campaignActive)
          score+=5;

        if(m.orders>0)
          score+=10;

        if(m.sales>0)
          score+=5;

        if(
          acos!==null &&
          acos<=50
        )
          score+=5;

        if(action.includes('pause'))
          score+=5;

        eligible.push({
          d,
          template,
          score,

          asin,
          stock:availableStock,
          campaign_id:cid,

          metrics:m,
          acos,
          roas,

          safeCpc
        });
      }

      /*
       * ========================================
       * 6. META 60%
       * ========================================
       */

      eligible.sort(
        (a,b)=>b.score-a.score
      );

      const target=
        eligible.length>0
          ? Math.ceil(
              eligible.length*0.60
            )
          : 0;

      const selected=new Set<string>();

      /*
       * Score alto entra primeiro.
       */
      for(const item of eligible){

        if(item.score>=60){
          selected.add(
            String(item.d.id)
          );
        }
      }

      /*
       * Se ainda não bate 60%, completa com
       * as melhores decisões restantes.
       */
      for(const item of eligible){

        if(selected.size>=target)
          break;

        selected.add(
          String(item.d.id)
        );
      }

      let approved=0;
      let belowTarget=0;

      const approvedSample:any[]=[];

      /*
       * ========================================
       * 7. APLICAR O PADRÃO CONFIRMADO
       * ========================================
       */

      for(const item of eligible){

        const d=item.d;

        if(
          !selected.has(
            String(d.id)
          )
        ){

          await base44.asServiceRole.entities.OptimizationDecision.update(
            d.id,
            {
              status:'cancelled',
              queue_status:'none',

              approval_status:
                'below_confirmed_sales_pattern',

              error_message:
                `NO_DECISION_BELOW_60_POOL: score ${item.score}.`,

              updated_at:
                new Date().toISOString()
            }
          ).catch(()=>null);

          belowTarget++;

          continue;
        }

        const template=item.template;

        /*
         * O principal:
         *
         * copiar o CAMINHO de execução que
         * comprovadamente chegou na Amazon.
         */
        let mode=String(
          template.execution_mode ||
          ''
        );

        /*
         * Corrigir templates antigos.
         */
        if(
          [
            'increase_bid',
            'reduce_bid',
            'set_bid',
            'update_bid',
            'increase_budget',
            'reduce_budget',
            'set_budget',
            'update_budget',
            'pause_campaign',
            'pause_keyword',
            'enable_campaign',
            'enable_keyword'
          ].includes(
            String(d.action||'')
          )
        ){
          mode='EXPEDITED_QUEUE';
        }

        /*
         * LF_INITIAL_BID_FALLBACK_ONLY_WHEN_NO_VALID_BID
         *
         * O fallback de R$0,60 é exclusivamente BID INICIAL.
         * Nunca reotimizar keyword ativa existente para 0,60 apenas
         * porque o template confirmado usou esse fallback.
         */
        const lfBefore = Number(
          d.value_before ??
          d.current_value ??
          0
        );

        const lfAfter = Number(
          d.value_after ??
          d.proposed_value ??
          0
        );

        const lfText = [
          d.rationale,
          d.reason_code,
          d.rule_key
        ].join(' ').toUpperCase();

        const lfInitialFallback =
          (
            lfText.includes('FALLBACK R$0,60') ||
            lfText.includes('FALLBACK_0.60') ||
            Math.abs(lfAfter - 0.60) < 0.001
          );

        if (
          d.action === 'set_bid' &&
          lfInitialFallback &&
          lfBefore > 0
        ) {
          await base44.asServiceRole.entities.OptimizationDecision.update(
            d.id,
            {
              status:'cancelled',
              queue_status:'none',
              approval_status:'no_decision_initial_fallback_not_applicable',
              error_message:
                `NO_DECISION: fallback inicial R$0,60 não pode sobrescrever bid existente R$${lfBefore.toFixed(2)}.`,
              updated_at:new Date().toISOString(),
            }
          ).catch(()=>null);

          continue;
        }

        const capability=
          validateAmazonAction({
            action:d.action,
            execution_mode:mode as any
          });

        if(!capability.valid){

          await base44.asServiceRole.entities.OptimizationDecision.update(
            d.id,
            {
              status:'cancelled',
              queue_status:'none',

              approval_status:
                'confirmed_pattern_registry_rejected',

              error_message:
                `NO_DECISION_REGISTRY:${capability.reason}`,

              updated_at:
                new Date().toISOString()
            }
          ).catch(()=>null);

          continue;
        }

        await base44.asServiceRole.entities.OptimizationDecision.update(
          d.id,
          {
            status:'approved',
            queue_status:'pending',

            execution_mode:mode,

            priority_class:
              item.score>=80
                ? 'P1'
                : 'P2',

            /*
             * O padrão confirmado já demonstrou
             * compatibilidade com o transporte.
             *
             * Evita duplicar soft governance.
             */
            canonical_action_type:null,
            snapshot_id:null,

            source_function:
              'review2953FromConfirmedPatterns',

            requires_approval:false,

            approval_status:
              'confirmed_pattern_auto_approved',

            requires_fresh_data:false,

            confirmation_required:true,
            confirmation_status:'pending',

            max_confirmation_attempts:
              Math.max(
                10,
                n(
                  template.max_confirmation_attempts
                )
              ),

            attempt_count:0,
            confirmation_attempt_count:0,

            next_retry_at:null,

            execute_before:
              new Date(
                Date.now()+2*3600000
              ).toISOString(),

            error_message:null,
            confirmation_error:null,

            updated_at:
              new Date().toISOString()
          }
        ).catch(()=>null);

        approved++;

        approvedSample.push({
          id:d.id,
          action:d.action,
          asin:item.asin,
          campaign_id:item.campaign_id,
          score:item.score,

          copied_from_confirmed:
            template.id,

          execution_mode:
            mode,

          stock:
            item.stock,

          orders_30d:
            item.metrics.orders,

          sales_30d:
            Number(
              item.metrics.sales.toFixed(2)
            )
        });
      }

      /*
       * ========================================
       * 8. TODAS AS NÃO ELEGÍVEIS VIRAM
       * NO_DECISION, NÃO BLOCKED
       * ========================================
       */

      let noDecisionClosed=0;

      for(const row of noDecision){

        const d=row.d;

        if(
          d.confirmation_status==='confirmed'
        ){
          continue;
        }

        await base44.asServiceRole.entities.OptimizationDecision.update(
          d.id,
          {
            status:'cancelled',
            queue_status:'none',

            approval_status:
              `no_decision_${String(
                row.reason
              ).toLowerCase()}`,

            error_message:
              `NO_DECISION_CONFIRMED_PATTERN_REVIEW:${row.reason}`,

            updated_at:
              new Date().toISOString()
          }
        ).catch(()=>null);

        noDecisionClosed++;
      }

      accountResults.push({

        amazon_account_id:aid,

        total_2953_reviewed:
          all.length,

        confirmed_examples_found:
          confirmed.length,

        exact_confirmed_patterns:
          templateByExact.size,

        confirmed_action_families:
          templateByFamily.size,

        duplicate_closed:
          duplicateClosed,

        unique_candidates_reviewed:
          latest.size,

        eligible:
          eligible.length,

        target_60_percent:
          target,

        selected:
          selected.size,

        approved:
          approved,

        approval_rate:
          eligible.length
            ? Number(
                (
                  approved /
                  eligible.length *
                  100
                ).toFixed(1)
              )
            : 0,

        no_decision_closed:
          noDecisionClosed,

        below_60_pool:
          belowTarget,

        approved_sample:
          approvedSample.slice(0,100)
      });
    }

    return Response.json({
      ok:true,

      engine:
        'CONFIRMED_PATTERN_2953_V1',

      rule:
        'confirmed Amazon decisions are execution templates; minimum 60% of eligible decisions selected',

      accounts:
        accountResults,

      duration_ms:
        Date.now()-started
    });

  }catch(error:any){

    return Response.json(
      {
        ok:false,
        engine:
          'CONFIRMED_PATTERN_2953_V1',

        error:
          error?.message ||
          String(error)
      },
      {status:500}
    );
  }
});
