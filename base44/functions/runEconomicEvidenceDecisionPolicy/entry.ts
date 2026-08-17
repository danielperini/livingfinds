import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { assessEconomicEvidence, selectContextualExplorationArm } from '../../shared/economicEvidencePolicy.ts';

const s=(v:unknown)=>String(v||'').trim();
const n=(v:unknown,f=0)=>Number.isFinite(Number(v))?Number(v):f;
const low=(v:unknown)=>s(v).toLowerCase();
const todayBrt=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo'}).format(new Date());
const active=(row:any)=>['enabled','active'].includes(low(row?.state||row?.status));

Deno.serve(async(request)=>{
 try{
  const base44=createClientFromRequest(request);
  const body=await request.json().catch(()=>({}));
  const authenticated=await base44.auth.isAuthenticated().catch(()=>false);
  if(!authenticated&&!body._service_role)return Response.json({ok:false,error:'Não autorizado'},{status:401});
  const accounts=body.amazon_account_id
   ? await base44.asServiceRole.entities.AmazonAccount.filter({id:body.amazon_account_id},null,1)
   : await base44.asServiceRole.entities.AmazonAccount.filter({status:'connected'},null,100);
  const results:any[]=[];
  for(const account of accounts){
   const aid=account.id,today=todayBrt();
   const [settingsRows,products,economics,terms,campaigns]=await Promise.all([
    base44.asServiceRole.entities.PerformanceSettings.filter({amazon_account_id:aid},'-updated_at',1).catch(()=>[]),
    base44.asServiceRole.entities.Product.filter({amazon_account_id:aid},'-updated_at',5000).catch(()=>[]),
    base44.asServiceRole.entities.ProductEconomics.filter({amazon_account_id:aid},'-updated_at',5000).catch(()=>[]),
    base44.asServiceRole.entities.SearchTerm.filter({amazon_account_id:aid},'-updated_date',10000).catch(()=>[]),
    base44.asServiceRole.entities.Campaign.filter({amazon_account_id:aid},'-updated_at',5000).catch(()=>[]),
   ]);
   const settings=settingsRows[0]||{},defaultTarget=Math.max(1,n(settings.target_acos??settings.acos_target,15));
   const productByAsin=new Map(products.filter((p:any)=>s(p.asin)).map((p:any)=>[s(p.asin).toUpperCase(),p]));
   const econByAsin=new Map(economics.filter((e:any)=>s(e.asin)).map((e:any)=>[s(e.asin).toUpperCase(),e]));
   const campaignById=new Map(campaigns.map((c:any)=>[s(c.campaign_id||c.amazon_campaign_id||c.id),c]));
   const candidates:any[]=[];
   for(const term of terms){
    const date=s(term.date||term.report_date||term.metric_date||term.start_date).slice(0,10); if(date!==today)continue;
    const campaignId=s(term.campaign_id||term.amazon_campaign_id),campaign=campaignById.get(campaignId); if(!campaign||!active(campaign))continue;
    const asin=s(term.advertised_asin||term.asin||campaign.asin).toUpperCase(),product=productByAsin.get(asin),econ=econByAsin.get(asin); if(!asin||!product)continue;
    const stock=n(product.fba_inventory??product.available_quantity??product.fulfillable_quantity,0); if(stock<=0||product.listing_buyable===false||product.listing_suppressed===true)continue;
    const spend=n(term.spend),sales=term.same_sku_attribution_verified===true?n(term.same_sku_sales):n(term.sales_1d),orders=term.same_sku_attribution_verified===true?n(term.same_sku_orders):n(term.orders_1d),clicks=n(term.clicks),impressions=n(term.impressions);
    if(clicks<=0&&impressions<=0)continue;
    const breakEven=Math.max(defaultTarget,n(econ?.break_even_acos??product.break_even_acos_pct,defaultTarget));
    const target=Math.max(1,n(econ?.target_acos,defaultTarget));
    const marginAmount=n(econ?.contribution_margin_amount??econ?.profit_before_ads??product.available_profit_per_sale??product.contribution_margin,NaN);
    const marginRate=n(econ?.contribution_margin_rate??econ?.contribution_margin_pct??product.contribution_margin_pct,0);
    const observedDays=Math.max(1,n(term.observed_days??term.days_with_data??1,1));
    const assessment=assessEconomicEvidence({clicks,orders,impressions,observedDays,spend,sales,targetAcosPct:target,breakEvenAcosPct:breakEven,contributionMarginAmount:marginAmount,contributionMarginRate:marginRate});
    const baseReward=assessment.reward;
    const arms=[
     {key:'REDUCE',expectedReward:baseReward+(assessment.zone.includes('CONTAINMENT')||assessment.zone==='PAUSE_OR_NEGATIVE'?Math.max(0,spend*.12):0),uncertainty:Math.max(0,spend*.05),minimumEvidence:'MEDIUM' as const},
     {key:'HOLD',expectedReward:baseReward,uncertainty:Math.max(0,spend*.08),minimumEvidence:'LOW' as const},
     {key:'SCALE',expectedReward:baseReward+(assessment.zone==='SCALE'?Math.max(0,assessment.reward*.10):Math.min(0,assessment.reward*.05)),uncertainty:Math.max(0,Math.abs(baseReward)*.12+1),minimumEvidence:'MEDIUM' as const},
    ];
    const arm=selectContextualExplorationArm(arms,{evidenceLevel:assessment.evidenceLevel,riskPenalty:assessment.reward<0?.75:.15,explorationWeight:assessment.evidenceLevel==='HIGH'?.20:.35});
    candidates.push({asin,campaign_id:campaignId,search_term:s(term.search_term||term.keyword_text||term.keyword),...assessment,contextual_arm:arm?.key||'HOLD',contextual_expected_reward:arm?.expectedReward??baseReward,contextual_uncertainty:arm?.uncertainty??0,spend,sales,clicks,orders,impressions,target_acos_pct:target,break_even_acos_pct:breakEven});
   }
   const selected=candidates.sort((a,b)=>b.evidenceScore-a.evidenceScore).slice(0,Number(body.max_candidates||100));
   let persisted=0;
   if(body.dry_run!==true){
    for(const row of selected){
     const idem=`${aid}|economic_evidence_shadow|${today}|${row.campaign_id}|${row.search_term}|${row.zone}`;
     const existing=await base44.asServiceRole.entities.OptimizationDecision.filter({amazon_account_id:aid,idempotency_key:idem},'-created_at',1).catch(()=>[]); if(existing.length)continue;
     await base44.asServiceRole.entities.OptimizationDecision.create({amazon_account_id:aid,decision_type:'economic_evidence_shadow',entity_type:'search_term',entity_id:row.search_term||row.campaign_id,asin:row.asin,campaign_id:row.campaign_id,action:`shadow_${low(row.zone)}`,rationale:`SHADOW econômico/contextual · ${row.rationale}; contextual_arm=${row.contextual_arm}; expected_reward=${n(row.contextual_expected_reward).toFixed(2)}; uncertainty=${n(row.contextual_uncertainty).toFixed(2)}. Não executa Amazon.`,risk:row.allowPause?'medium':'low',requires_approval:false,approval_status:'shadow_only',status:'shadow',queue_status:'not_queued',idempotency_key:idem,source_function:'runEconomicEvidenceDecisionPolicy',execution_result:'Hypothetical action only; canonical deterministic engine remains execution owner.',economic_zone:row.zone,evidence_level:row.evidenceLevel,evidence_score:row.evidenceScore,reward:row.reward,break_even_acos_pct:row.break_even_acos_pct,target_acos_pct:row.target_acos_pct,recommended_bid_adjustment_pct:row.bidAdjustmentPct,contextual_arm:row.contextual_arm,created_at:new Date().toISOString(),updated_at:new Date().toISOString()}).catch(()=>null);
     persisted++;
    }
   }
   await base44.asServiceRole.entities.SyncExecutionLog.create({amazon_account_id:aid,operation:'economic_evidence_contextual_shadow',trigger_type:body.trigger_type||'unified_engine',status:'success',records_processed:selected.length,result_summary:`shadow=${persisted}; scale=${selected.filter(x=>x.zone==='SCALE').length}; hold=${selected.filter(x=>x.zone==='EXPLORE_HOLD').length}; light=${selected.filter(x=>x.zone==='LIGHT_CONTAINMENT').length}; strong=${selected.filter(x=>x.zone==='STRONG_CONTAINMENT').length}; terminal_candidates=${selected.filter(x=>x.zone==='PAUSE_OR_NEGATIVE').length}`,started_at:new Date().toISOString(),completed_at:new Date().toISOString()}).catch(()=>{});
   results.push({amazon_account_id:aid,ok:true,shadow_only:true,candidates:selected.length,persisted,summary:{scale:selected.filter(x=>x.zone==='SCALE').length,hold:selected.filter(x=>x.zone==='EXPLORE_HOLD').length,light_containment:selected.filter(x=>x.zone==='LIGHT_CONTAINMENT').length,strong_containment:selected.filter(x=>x.zone==='STRONG_CONTAINMENT').length,pause_or_negative:selected.filter(x=>x.zone==='PAUSE_OR_NEGATIVE').length},sample:selected.slice(0,20)});
  }
  return Response.json({ok:true,policy:'economic-evidence-contextual-v1',execution_mode:'shadow_only',canonical_executor:'executeApprovedDecisionQueue',results});
 }catch(error:any){return Response.json({ok:false,error:error?.message||String(error)},{status:500})}
});
