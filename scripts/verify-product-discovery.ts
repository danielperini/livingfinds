const token=Deno.env.get("API_TOKEN")||Deno.env.get("ADMIN_PASSWORD")||"";
const response=await fetch("http://127.0.0.1:8000/functions/discoverDailyKickoffProducts",{
 method:"POST",headers:{"content-type":"application/json","x-api-token":token},
 body:JSON.stringify({_service_role:true,amazon_account_id:"6a40448b9af1241f356e9fcc"}),signal:AbortSignal.timeout(240000),
});
const data=await response.json();
console.log("DISCOVERY="+JSON.stringify({ok:data.ok,http:response.status,results:data.results?.map(r=>({ok:r.ok,error:r.error,checked_at:r.checked_at,scanned:r.scanned,candidates:r.candidates?.length,microphone:r.candidates?.filter(p=>p.sku==="FBA-0122"||p.asin==="B0HLMF8PPD")}))}));
if(data.ok!==true)throw Error("Daily discovery failed");
