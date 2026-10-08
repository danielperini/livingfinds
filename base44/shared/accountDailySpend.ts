/** Cumulative daily spend: one value per campaign, never a sum of repeated snapshots. */
export function accountDailySpend(dailyRows: any[], snapshots: any[], day: string) {
  const daily = new Map<string, number>(), intraday = new Map<string, {spend:number;at:number}>();
  for (const row of dailyRows) {
    const id=String(row.campaign_id || row.amazon_campaign_id || '');
    const spend=Number(row.spend);
    if (!id || row.date !== day || row.spend == null || !Number.isFinite(spend) || spend < 0) continue;
    daily.set(id,Math.max(daily.get(id)||0,spend));
  }
  for (const row of snapshots) {
    const id=String(row.campaign_id || row.amazon_campaign_id || '');
    const spend=Number(row.spend), at=Date.parse(row.observed_at || '');
    if (!id || row.spend_date !== day || row.spend == null || !Number.isFinite(spend) || spend < 0 || !Number.isFinite(at)) continue;
    if (!intraday.has(id) || at > intraday.get(id)!.at) intraday.set(id,{spend,at});
  }
  const byCampaign = new Map(daily);
  for(const [id,row] of intraday) byCampaign.set(id,Math.max(byCampaign.get(id)||0,row.spend));
  return {spend:Math.round([...byCampaign.values()].reduce((a,b)=>a+b,0)*100)/100,byCampaign,
    source:intraday.size?'intraday_and_daily_by_campaign':'metrics_daily',
    hasData:byCampaign.size>0,observedAt:intraday.size?new Date(Math.max(...[...intraday.values()].map(r=>r.at))).toISOString():null};
}
