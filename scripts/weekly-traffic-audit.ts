import {sql,query} from 'file:///app/server/src/db.ts';
try{
const rows=await query(`WITH latest AS (SELECT DISTINCT ON (data->>'campaign_id',data->>'date') data FROM campaign_metrics_daily WHERE data->>'amazon_account_id'=$1 AND data->>'date' BETWEEN '2026-06-22' AND '2026-10-06' ORDER BY data->>'campaign_id',data->>'date',updated_at DESC), daily AS (SELECT (data->>'date')::date day,data FROM latest) SELECT date_trunc('week',day)::date week,count(DISTINCT day) days,count(DISTINCT data->>'campaign_id') campaigns,sum(COALESCE((data->>'impressions')::numeric,0)) impressions,sum(COALESCE((data->>'clicks')::numeric,0)) clicks,sum(COALESCE((data->>'spend')::numeric,0)) spend,sum(COALESCE((data->>'sales')::numeric,0)) sales,sum(COALESCE((data->>'orders')::numeric,0)) orders FROM daily GROUP BY 1 ORDER BY 1`,['6a40448b9af1241f356e9fcc']);
console.log('WEEKLY_ADS='+JSON.stringify(rows));
}finally{await sql.end();}
