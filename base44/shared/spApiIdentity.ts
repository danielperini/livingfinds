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

export function selectSpApiSamples(products: any[]) {
  const withSku = products.find((product) => cleanIdentifier(product?.sku));
  const withAsin = products.find((product) => cleanIdentifier(product?.asin));
  const pricing = products.find((product) =>
    cleanIdentifier(product?.sku) && cleanIdentifier(product?.asin)
  );
  return {
    listing: withSku || null,
    asin: withAsin || null,
    pricing: pricing || null,
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
