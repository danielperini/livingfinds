export function cleanIdentifier(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function resolveSellerId(
  account: Record<string, unknown> | null | undefined,
  environment: Record<string, unknown> = {},
): { sellerId: string; source: string | null } {
  const candidates: Array<[string, unknown]> = [
    ["account.seller_id", account?.seller_id],
    ["account.selling_partner_id", account?.selling_partner_id],
    ["account.sellerId", account?.sellerId],
    ["account.merchant_id", account?.merchant_id],
    ["AMAZON_SELLER_ID", environment.AMAZON_SELLER_ID],
    ["SP_SELLER_ID", environment.SP_SELLER_ID],
  ];
  for (const [source, value] of candidates) {
    const sellerId = cleanIdentifier(value);
    if (sellerId) return { sellerId, source };
  }
  return { sellerId: "", source: null };
}

function availableStock(product: any): number {
  const values = [product?.available_quantity, product?.fulfillable_quantity, product?.stock, product?.quantity];
  const value = values.find((candidate) => Number.isFinite(Number(candidate)));
  return value === undefined ? -1 : Number(value);
}

function candidateEligible(product: any, marketplaceId = "") {
  const state = cleanIdentifier(product?.state || product?.status || product?.listing_status).toLowerCase();
  const productMarketplace = cleanIdentifier(product?.marketplace_id || product?.marketplaceId);
  if (marketplaceId && productMarketplace && productMarketplace !== marketplaceId) return false;
  if (product?.archived === true || product?.listing_suppressed === true || product?.api_missing === true) return false;
  if (["archived", "deleted", "removed", "inactive", "inativo"].includes(state)) return false;
  return true;
}

function candidateRank(product: any) {
  const state = cleanIdentifier(product?.state || product?.status || product?.listing_status).toLowerCase();
  const stock = availableStock(product);
  return (stock > 0 ? 1000 : stock === 0 ? 0 : 100) +
    (["active", "enabled", "buyable", "discoverable", "ativo"].includes(state) ? 200 : 0) +
    (cleanIdentifier(product?.asin) ? 50 : 0) +
    (product?.listing_eligible === true || product?.buyable === true ? 25 : 0);
}

export function selectSpApiSamples(products: any[], marketplaceId = "") {
  const eligible = products.filter((product) => candidateEligible(product, marketplaceId));
  const ranked = [...eligible].sort((a, b) => candidateRank(b) - candidateRank(a));
  const listingCandidates = ranked.filter((product) => cleanIdentifier(product?.sku));
  const asinCandidates = ranked.filter((product) => cleanIdentifier(product?.asin));
  const pricingCandidates = ranked.filter((product) => cleanIdentifier(product?.sku) && cleanIdentifier(product?.asin));
  return {
    listing: listingCandidates[0] || null,
    asin: asinCandidates[0] || null,
    pricing: pricingCandidates[0] || null,
    listingCandidates,
    pricingCandidates,
  };
}

export function sellerIdFromParticipations(payload: any): string {
  const root = payload?.payload?.payload || payload?.payload || payload || {};
  const participations = Array.isArray(root) ? root : (
    root.marketplaceParticipations || root.participations || []
  );
  for (const participation of participations) {
    const sellerId = cleanIdentifier(
      participation?.seller?.sellerId || participation?.sellerId ||
        participation?.sellingPartnerId,
    );
    if (sellerId) return sellerId;
  }
  return cleanIdentifier(root?.seller?.sellerId || root?.sellerId);
}

export function sellerIdFromAdsProfiles(
  payload: any,
  preferredProfileId?: unknown,
): string {
  const profiles = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.profiles)
    ? payload.profiles
    : [];
  const preferred = cleanIdentifier(preferredProfileId);
  const ordered = preferred
    ? [
      ...profiles.filter((profile: any) =>
        cleanIdentifier(profile?.profileId) === preferred
      ),
      ...profiles.filter((profile: any) =>
        cleanIdentifier(profile?.profileId) !== preferred
      ),
    ]
    : profiles;
  for (const profile of ordered) {
    const type = cleanIdentifier(
      profile?.accountInfo?.type || profile?.type,
    ).toLowerCase();
    if (type && type !== "seller") continue;
    const sellerId = cleanIdentifier(
      profile?.accountInfo?.id || profile?.accountInfo?.sellerId,
    );
    if (sellerId) return sellerId;
  }
  return "";
}
