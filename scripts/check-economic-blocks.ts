import {sql,query} from 'file:///app/server/src/db.ts';
try{
const rows=await query("SELECT data FROM product_economics WHERE data->>'amazon_account_id'=$1 AND upper(data->>'sku') IN ('FBA-0076A','FBA-0008V','FBA-0010','FBA-0024B')",['6a40448b9af1241f356e9fcc']);console.log('ECONOMICS='+JSON.stringify(rows));
const terms=await query("SELECT data FROM search_term WHERE data->>'amazon_account_id'=$1 AND (data->>'search_term' ILIKE '%sem neutro%' OR data->>'search_term' ILIKE '%moedor cafe eletrico%') AND (data->>'same_sku_orders')::numeric > 0 ORDER BY data->>'date' DESC LIMIT 6",['6a40448b9af1241f356e9fcc']);console.log('CONVERTED_TERMS='+JSON.stringify(terms));
}finally{await sql.end();}
