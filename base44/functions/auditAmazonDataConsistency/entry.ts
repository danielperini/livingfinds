import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function normalizeState(value:any){const s=String(value||'').toLowerCase();if(['enabled','active','ativa','ativada'].includes(s))return'enabled';if(['paused','pausada'].includes(s))return'paused';if(['archived','ended','encerrada','deleted'].includes(s))return'archived';return s||'unknown';}
function ts(row:any){for(const key of ['updated_at','synced_at','completed_at','created_at','created_date','date']){const value=new Date(row?.[key]||0).getTime();if(Number.isFinite(value)&&value>0)return value;}return 0;}
function latest(rows:any[]){const value=rows.reduce((max,row)=>Math.max(max,ts(row)),0);return value?new Date(value).toISOString():null;}

Deno.serve(async(request)=>{const startedAt=new Date().toISOString();try{
 const base44=createClientFromRequest(request),body=await request.json().catch(()=>({}));
 if(!body._service_role)return Response.json({ok:false,error:'Uso interno'},{status:403});
 const accountId=body.amazon_account_id;if(!accountId)return Response.json({ok:false,error:'amazon_account_id obrigatório'},{status:400});
 const cutoff30=new Date(Date.now()-30*86400000).toISOString().slice(0,10);
 const [campaigns,products,metrics,hourly,logs,decisions,configRows]=await Promise.all([
  base44.asServiceRole.entities.Campaign.filter({amazon_account_id:accountId},'-updated_at',5000).catch(()=>[]),
  base44.asServiceRole.entities.Product.filter({amazon_account_id:accountId},'-updated_at',5000).catch(()=>[]),
  base44.asServiceRole.entities.CampaignMetricsDaily.filter({amazon_account_id:accountId},'-date',5000).catch(()=>[]),
  base44.asServiceRole.entities.HourlyMetric.filter({amazon_account_id:accountId},'-date',5000).catch(()=>[]),
  base44.asServiceRole.entities.SyncExecutionLog.filter({amazon_account_id:accountId},'-completed_at',500).catch(()=>[]),
  base44.asServiceRole.entities.OptimizationDecision.filter({amazon_account_id:accountId},'-created_at',1000).catch(()=>[]),
  base44.asServiceRole.entities.AppOptimizationConfig.filter({amazon_account_id:accountId},'-updated_at',1).catch(()=>[]),
 ]);
 const metric30=metrics.filter((m:any)=>m.date>=cutoff30),hourly30=hourly.filter((m:any)=>m.date>=cutoff30);
 const unique=new Map();for(const row of metric30)unique.set(`${row.campaign_id||''}:${row.date||''}`,row);
 const states=campaigns.reduce((acc:any,c:any)=>{acc[normalizeState(c.state||c.status)]=(acc[normalizeState(c.state||c.status)]||0)+1;return acc;},{});
 const productsWithCampaign=products.filter((p:any)=>p.has_campaign||p.linked_campaign_id||p.campaign_id).length;
 const adsLogs=logs.filter((l:any)=>String(l.operation||'').includes('report')||String(l.operation||'').includes('syncAds'));
 const productLogs=logs.filter((l:any)=>String(l.operation||'').includes('product')||String(l.operation||'').includes('catalog'));
 const issues:string[]=[];
 if((states.enabled||0)===0&&campaigns.length>0)issues.push('Nenhuma campanha ativa foi identificada, embora existam campanhas sincronizadas.');
 if(productsWithCampaign===0&&campaigns.length>0)issues.push('Nenhum produto está vinculado a campanhas sincronizadas.');
 if(metric30.length===0)issues.push('Sem métricas diárias dos últimos 30 dias.');
 if(hourly30.length===0)issues.push('Sem métricas horárias dos últimos 30 dias.');
 if(metric30.length-unique.size>0)issues.push(`${metric30.length-unique.size} duplicata(s) em CampaignMetricsDaily.`);
 const lastAds=latest(adsLogs),lastProducts=latest(productLogs),lastMetrics=latest(metric30),lastHourly=latest(hourly30);
 const staleCutoff=Date.now()-36*3600000;
 if(!lastAds||new Date(lastAds).getTime()<staleCutoff)issues.push('Relatórios Ads estão desatualizados há mais de 36 horas.');
 if(!lastProducts||new Date(lastProducts).getTime()<staleCutoff)issues.push('Relatórios de produtos estão desatualizados há mais de 36 horas.');
 let config=configRows[0];
 if(!config){config=await base44.asServiceRole.entities.AppOptimizationConfig.create({amazon_account_id:accountId,primary_goal:'acos',target_acos:25,target_tacos:10,target_roas:4,min_auto_bid:0.30,max_auto_bid:1.50,min_manual_bid:0.30,max_manual_bid:1.50,bid_step:0.10,max_daily_budget_limit:100,max_budget_per_campaign:20,max_spend_without_sale:20,minimum_data_hours:24,minimum_change_interval_hours:36,minimum_confidence:85,automation_mode:'approval',updated_at:new Date().toISOString()});}
 const snapshot={amazon_account_id:accountId,status:issues.length?'warning':'healthy',checked_at:new Date().toISOString(),last_ads_report_at:lastAds,last_products_report_at:lastProducts,last_metrics_at:lastMetrics,last_hourly_metrics_at:lastHourly,campaigns_total:campaigns.length,campaigns_active:states.enabled||0,campaigns_paused:states.paused||0,campaigns_archived:states.archived||0,products_total:products.length,products_with_campaign:productsWithCampaign,metrics_rows_30d:metric30.length,metrics_unique_30d:unique.size,metrics_duplicates_30d:metric30.length-unique.size,hourly_rows_30d:hourly30.length,ml_rows_30d:decisions.filter((d:any)=>ts(d)>=Date.now()-30*86400000).length,issues,summary_json:JSON.stringify({goals:config,states,lastAds,lastProducts,lastMetrics,lastHourly}).slice(0,8000)};
 await base44.asServiceRole.entities.AmazonDataAuditSnapshot.create(snapshot);
 await base44.asServiceRole.entities.SyncExecutionLog.create({amazon_account_id:accountId,operation:'amazon_data_consistency_audit',status:issues.length?'error':'success',trigger_type:body.trigger_type||'scheduled_0640',started_at:startedAt,completed_at:new Date().toISOString(),records_processed:campaigns.length+products.length+metric30.length+hourly30.length,result_summary:JSON.stringify(snapshot).slice(0,4000),error_message:issues.length?issues.join(' | ').slice(0,1000):null}).catch(()=>{});
 return Response.json({ok:true,audit:snapshot,optimization_config:config});
}catch(error){return Response.json({ok:false,error:error?.message||'Erro na auditoria Amazon'},{status:500});}});
