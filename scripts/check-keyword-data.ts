import {sql,query} from 'file:///app/server/src/db.ts';
try{
for(const table of ['search_term','search_term_report','search_term_daily','keyword','campaign']){
try {console.log('COUNTS='+JSON.stringify({table,rows:await query(`SELECT data->>'amazon_account_id' account, count(*) FROM ${table} GROUP BY 1`)}));}catch{console.log('MISSING_TABLE='+table);}
}
console.log('TERMS='+JSON.stringify(await query("SELECT data->>'campaign_id' campaign, count(*) n FROM search_term GROUP BY 1 ORDER BY n DESC LIMIT 20")));
console.log('CAMPAIGNS='+JSON.stringify(await query("SELECT id,data->>'campaign_id' campaign,data->>'amazon_campaign_id' amazon,data->>'name' name,data->>'state' state,data->>'status' status FROM campaign WHERE data->>'amazon_account_id'=$1 LIMIT 100",['6a40448b9af1241f356e9fcc'])));
}finally{await sql.end();}
