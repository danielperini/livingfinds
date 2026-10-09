const ACTIVE_LISTING_STATES = new Set(["ACTIVE", "BUYABLE", "DISCOVERABLE"]);

export function normalizeListingStates(summaries: any): string[] {
  if (!Array.isArray(summaries)) return [];
  return [...new Set(summaries.flatMap((summary: any) => {
    const raw = Array.isArray(summary?.status) ? summary.status : [summary?.status];
    return raw.flatMap((value: any) => String(value || "").split(","));
  }).map((value: string) => value.trim().toUpperCase()).filter(Boolean))];
}

export function listingOfferStatus(summaries: any) {
  const states = normalizeListingStates(summaries);
  return {
    states,
    statusKnown: states.length > 0,
    offerActive: states.some((state) => ACTIVE_LISTING_STATES.has(state)),
  };
}

/** BUYABLE is authoritative; an invalid attribute/image is not listing suppression. */
export function listingBuyability(summaries:any, issues:any) {
  const status=listingOfferStatus(summaries);
  const rows=Array.isArray(issues)?issues:[];
  const actions=rows.flatMap((issue:any)=>[
    ...(Array.isArray(issue.enforcementActions)?issue.enforcementActions:[]),
    ...(Array.isArray(issue.enforcements?.actions)?issue.enforcements.actions:[]),
  ]).map((a:any)=>String(typeof a==='string'?a:a?.action||'').toUpperCase());
  const suppressed=actions.some((a:string)=>['LISTING_SUPPRESSED','SEARCH_SUPPRESSED','OFFER_SUPPRESSED'].includes(a));
  return {...status,suppressed,buyable:status.states.includes('BUYABLE')&&!suppressed,
    issueCodes:rows.map((i:any)=>String(i.code||'')).filter(Boolean)};
}
