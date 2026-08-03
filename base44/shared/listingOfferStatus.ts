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
