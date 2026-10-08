/** Closed-day same-SKU evidence. No title seeds, halo revenue or overlapping summary reports. */
export function verifiedBidEvidence(rows: any[], now = Date.now()) {
  const days = 86400000;
  const today = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
  const start = new Date(now - 30 * days).toISOString().slice(0,10);
  const matureEnd = new Date(now - 7 * days).toISOString().slice(0,10);
  const grouped = new Map<string, any[]>();
  const byKey = new Map<string, any>();
  for (const r of rows) {
    if (r.same_sku_attribution_verified !== true || !r.advertised_sku || !r.advertised_asin || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '') || r.date < start || r.date >= today) continue;
    const updated = Date.parse(r.metrics_fresh_at || r.synced_at || '');
    if (!Number.isFinite(updated) || now - updated > 36 * 3600000 || updated > now) continue;
    if ([r.clicks,r.spend,r.same_sku_sales,r.same_sku_orders].some(v => v == null || !Number.isFinite(Number(v)) || Number(v)<0)) continue;
    const id = String(r.source_target_id || r.keyword_id || r.target_id || '');
    if (!id) continue;
    const key = [r.campaign_id,id,r.advertised_asin,r.advertised_sku,r.date,r.search_term].join('|');
    const previous = byKey.get(key);
    if (!previous || updated > previous.updated) byKey.set(key,{r,updated});
  }
  for (const {r} of byKey.values()) {
    const id = String(r.source_target_id || r.keyword_id || r.target_id);
    const key = [r.campaign_id,id,r.advertised_asin,r.advertised_sku].join('|');
    const entries = grouped.get(key) || []; entries.push(r); grouped.set(key,entries);
  }
  return [...grouped.values()].map(rows => {
    const first=rows[0];
    const sum=(subset:any[],key:string)=>subset.reduce((s,r)=>s+Number(r[key]),0);
    const mature=rows.filter(r=>r.date<=matureEnd);
    return {campaignId:String(first.campaign_id),keywordId:String(first.source_target_id||first.keyword_id||first.target_id),asin:String(first.advertised_asin).toUpperCase(),sku:String(first.advertised_sku).trim().toUpperCase(),
      clicks:sum(rows,'clicks'),spend:sum(rows,'spend'),sales:sum(rows,'same_sku_sales'),orders:sum(rows,'same_sku_orders'),
      matureClicks:sum(mature,'clicks'),matureSpend:sum(mature,'spend'),matureSales:sum(mature,'same_sku_sales'),matureOrders:sum(mature,'same_sku_orders')};
  });
}
