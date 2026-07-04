import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const STOP=new Set(['a','o','os','as','de','da','do','das','dos','e','em','para','por','com','sem','um','uma','kit']);
const norm=(v:any)=>String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
const words=(v:any)=>norm(v).split(' ').filter((w)=>w&&!STOP.has(w));
const clamp=(v:number)=>Math.max(0,Math.min(1,v));

Deno.serve(async(req)=>{try{
 const b=createClientFromRequest(req),x=await req.json().catch(()=>({}));
 if(!x._service_role||!x.amazon_account_id)return Response.json({ok:false,error:'Parâmetros inválidos'},{status:400});
 const accountId=x.amazon_account_id,cutoff=new Date(Date.now()-24*3600000),cutoffDay=cutoff.toISOString().slice(0,10);
 const [products,terms,configs,existing]=await Promise.all([
  b.asServiceRole.entities.Product.filter({amazon_account_id:accountId},'-updated_at',5000).catch(()=>[]),
  b.asServiceRole.entities.SearchTerm.filter({amazon_account_id:accountId},'-date',5000).catch(()=>[]),
  b.asServiceRole.entities.AppOptimizationConfig.filter({amazon_account_id:accountId},'-updated_at',1).catch(()=>[]),
  b.asServiceRole.entities.KeywordStrategySignal.filter({amazon_account_id:accountId},'-evaluated_at',5000).catch(()=>[]),
 ]);
 const targetAcos=Number(configs[0]?.target_acos||25),targetRoas=Number(configs[0]?.target_roas||4);
 const productMap=new Map(products.map((p:any)=>[String(p.asin),p]));
 const existingMap=new Map(existing.map((s:any)=>[`${s.asin}|${s.normalized_term}`,s]));
 const agg=new Map();
 for(const row of terms){const date=String(row.date||row.report_date||'');if(date&&date>cutoffDay)continue;const asin=String(row.advertised_asin||row.asin||''),term=String(row.search_term||row.term||'').trim();if(!asin||!term)continue;const key=`${asin}|${norm(term)}`,item=agg.get(key)||{asin,term,impressions:0,clicks:0,orders:0,spend:0,sales:0};item.impressions+=Number(row.impressions||0);item.clicks+=Number(row.clicks||0);item.orders+=Number(row.orders_14d||row.orders_7d||row.orders||0);item.spend+=Number(row.spend||0);item.sales+=Number(row.sales_14d||row.sales_7d||row.sales||0);agg.set(key,item);}
 let created=0,updated=0;
 for(const item of agg.values()){const product=productMap.get(item.asin)||{},title=String(product.product_name||product.display_name||product.title||''),termWords=words(item.term),titleSet=new Set(words(title));const overlap=termWords.length?termWords.filter((w)=>titleSet.has(w)).length/termWords.length:0;const ctr=item.impressions?item.clicks/item.impressions:0,cvr=item.clicks?item.orders/item.clicks:0,acos=item.sales?item.spend/item.sales*100:item.spend?999:0,roas=item.spend?item.sales/item.spend:0;const relevance=clamp(overlap*0.7+(termWords.length>=3?0.3:0));const engagement=clamp(ctr/0.02),conversion=clamp(cvr/0.15),profit=item.orders?clamp((targetAcos/Math.max(acos,1))*0.6+(roas/Math.max(targetRoas,0.1))*0.4):0;const opportunity=clamp(relevance*0.3+engagement*0.15+conversion*0.25+profit*0.3);const action=item.orders>=2&&acos<=targetAcos?'harvest_exact':item.clicks>=8&&item.orders===0?'review_waste':item.orders>=1&&overlap<0.34?'title_opportunity':'observe';const payload={amazon_account_id:accountId,asin:item.asin,term:item.term,normalized_term:norm(item.term),source:'search_term',word_count:termWords.length,title_overlap:Number(overlap.toFixed(4)),relevance_score:Number(relevance.toFixed(4)),engagement_score:Number(engagement.toFixed(4)),conversion_score:Number(conversion.toFixed(4)),profitability_score:Number(profit.toFixed(4)),opportunity_score:Number(opportunity.toFixed(4)),impressions:item.impressions,clicks:item.clicks,orders:item.orders,spend:Number(item.spend.toFixed(2)),sales:Number(item.sales.toFixed(2)),ctr:Number((ctr*100).toFixed(4)),cvr:Number((cvr*100).toFixed(4)),acos:Number(acos.toFixed(2)),roas:Number(roas.toFixed(2)),recommended_action:action,confidence:Math.min(95,50+item.clicks*3+item.orders*8),reason:`Relevância ${Math.round(relevance*100)}%, conversão ${Math.round(conversion*100)}%, lucratividade ${Math.round(profit*100)}%.`,data_cutoff_at:cutoff.toISOString(),evaluated_at:new Date().toISOString()};const current=existingMap.get(`${item.asin}|${norm(item.term)}`);if(current){await b.asServiceRole.entities.KeywordStrategySignal.update(current.id,payload);updated++;}else{await b.asServiceRole.entities.KeywordStrategySignal.create(payload);created++;}}
 await b.asServiceRole.entities.LearningEvent.create({amazon_account_id:accountId,event_type:'keyword_signal_learning',entity_type:'account',entity_id:accountId,observation:`${agg.size} termos avaliados por relevância, engajamento, conversão e lucratividade. Corte de 24h aplicado aos relatórios comerciais.`,recorded_at:new Date().toISOString()}).catch(()=>{});
 return Response.json({ok:true,terms_analyzed:agg.size,created,updated,data_cutoff_at:cutoff.toISOString(),principles:['relevance','engagement','conversion','profitability','long_tail','24h_lag']});
}catch(e){return Response.json({ok:false,error:e?.message||'Erro ao gerar sinais do ML'},{status:500});}});
