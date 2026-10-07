const token=Deno.env.get('API_TOKEN')||Deno.env.get('ADMIN_PASSWORD')||'';
const account='6a40448b9af1241f356e9fcc';
for(const [group,type] of [['campaigns','spCampaign'],['adGroups','spAdGroup'],['productAds','spProductAd']]){
 const r=await fetch('http://127.0.0.1:8000/functions/amazonAdsCommand',{method:'POST',headers:{'content-type':'application/json','x-api-token':token},body:JSON.stringify({_service_role:true,amazon_account_id:account,operation:'verifyMicrophoneKickoff',method:'POST',path:'/sp/'+group+'/list',payload:{campaignIdFilter:{include:['16209687146105']},maxResults:100},content_type:'application/vnd.'+type+'.v3+json',accept:'application/vnd.'+type+'.v3+json'}),signal:AbortSignal.timeout(90000)});
 console.log('AMAZON_'+group+'='+JSON.stringify(await r.json()));
}
import {sql,query} from 'file:///app/server/src/db.ts';
try{console.log('DAILY_SCAN='+JSON.stringify(await query("SELECT max(data->>'kickoff_discovery_checked_at') last_scan,count(*) FILTER (WHERE data->>'kickoff_discovery_checked_at' IS NOT NULL) scanned FROM product WHERE data->>'amazon_account_id'=$1",[account])));}finally{await sql.end();}
