// Pause only the three redundant AUTO campaigns enabled by this recovery.
const token=Deno.env.get("API_TOKEN")||Deno.env.get("ADMIN_PASSWORD")||"";
async function call(name,payload={}) {
 const res=await fetch("http://127.0.0.1:8000/functions/"+name,{method:"POST",headers:{"content-type":"application/json","x-api-token":token},body:JSON.stringify({_service_role:true,amazon_account_id:"6a40448b9af1241f356e9fcc",...payload}),signal:AbortSignal.timeout(240000)});
 const data=await res.json();console.log("RECOVERY="+JSON.stringify({name,http:res.status,data}).slice(0,35000));return data;
}
for(const campaignId of ["209089673854678","75620440656198","279022891328400"]) {
 const result=await call("amazonAdsCommand",{operation:"pauseRecoveryDuplicateAuto",method:"PUT",path:"/sp/campaigns",payload:{campaigns:[{campaignId,state:"PAUSED"}]},content_type:"application/vnd.spCampaign.v3+json",accept:"application/vnd.spCampaign.v3+json"});
 if(result.ok!==true)throw Error("Amazon did not confirm duplicate pause");
}
await call("syncAdsCampaignStatesV2");
await call("pollAmazonAdsReportJobs",{max_jobs:10});
await call("runImmediateSameSkuSearchTermHarvest",{dry_run:true,lookback_days:30,max_promotions:2,require_fresh_inventory:true});
await call("verifyRemoteSkuCampaignFloor");
