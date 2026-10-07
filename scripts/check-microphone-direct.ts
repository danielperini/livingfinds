const refresh=Deno.env.get('AMAZON_SP_REFRESH_TOKEN')||Deno.env.get('SP_REFRESH_TOKEN');
const client=Deno.env.get('AMAZON_LWA_CLIENT_ID')||Deno.env.get('SP_CLIENT_ID');
const secret=Deno.env.get('AMAZON_LWA_CLIENT_SECRET')||Deno.env.get('SP_CLIENT_SECRET');
const auth=await fetch('https://api.amazon.com/auth/o2/token',{method:'POST',body:new URLSearchParams({grant_type:'refresh_token',refresh_token:refresh,client_id:client,client_secret:secret})});
const a=await auth.json();if(!auth.ok||!a.access_token)throw Error('SP authentication failed');
import {sql,query} from 'file:///app/server/src/db.ts';
try{
const rows=await query("SELECT data FROM amazon_account WHERE id=$1",['6a40448b9af1241f356e9fcc']);
const account=rows[0].data;const market=account.marketplace_id||'A2Q3Y263D00KWC';
const q=new URLSearchParams({details:'true',granularityType:'Marketplace',granularityId:market,marketplaceIds:market,sellerSkus:'FBA-0122'});
const r=await fetch('https://sellingpartnerapi-na.amazon.com/fba/inventory/v1/summaries?'+q,{headers:{'x-amz-access-token':a.access_token}});
const d=await r.json();console.log('DIRECT_FBA='+JSON.stringify({status:r.status,marketplace:market,response:d}));
}finally{await sql.end();}
