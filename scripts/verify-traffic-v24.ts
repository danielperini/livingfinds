const token=Deno.env.get("API_TOKEN")||Deno.env.get("ADMIN_PASSWORD")||"";
async function call(name,payload) {const r=await fetch("http://127.0.0.1:8000/functions/"+name,{method:"POST",headers:{"content-type":"application/json","x-api-token":token},body:JSON.stringify({_service_role:true,amazon_account_id:"6a40448b9af1241f356e9fcc",...payload}),signal:AbortSignal.timeout(180000)});const data=await r.json(); console.log(name+"="+JSON.stringify(data));if(!r.ok||data.ok===false)throw new Error(name+" failed");return data;}
await call("enforceSkuProfitProtection",{dry_run:true});
await call("runIntradaySalesRecovery",{dry_run:true,_canonical_orchestrator:"runUnifiedDecisionEngine"});
