function norm(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function ids(product: any): Set<string> {
  return new Set([
    product?.linked_campaign_id,
    product?.campaign_id,
    ...(Array.isArray(product?.linked_campaign_ids) ? product.linked_campaign_ids : []),
  ].filter(Boolean).map(String));
}

export function isStockPause(product: any): boolean {
  const reason = norm(product?.pause_reason || product?.ads_pause_reason);
  return reason.includes('stock') || reason.includes('estoque');
}

/**
 * A quantidade FBA não confirma que o cliente consegue comprar o item.
 * Estes campos são alimentados pela consulta Listings Items da SP-API e têm
 * precedência sobre estoque para qualquer ativação de publicidade.
 */
export function productOfferEligibility(product: any): { eligible: boolean; reason: string | null } {
  const status = norm(product?.ads_eligibility_status);
  if (product?.listing_suppressed === true || status === 'listing_suppressed') {
    return { eligible: false, reason: 'LISTING_SUPPRESSED' };
  }
  if (product?.offer_active === false || ['offer_inactive', 'listing_inactive'].includes(status)) {
    return { eligible: false, reason: 'OFFER_INACTIVE' };
  }
  if (product?.listing_buyable === false || status === 'not_buyable') {
    return { eligible: false, reason: 'LISTING_NOT_BUYABLE' };
  }
  return { eligible: true, reason: null };
}

export function isProductEligibleForCampaignActivation(product: any): boolean {
  return productOfferEligibility(product).eligible && !isProductCampaignPauseLocked(product);
}

export function isProductCampaignPauseLocked(product: any): boolean {
  if (!product) return false;
  if (product.campaign_pause_lock === true) return true;
  if (norm(product.ads_scope_status) === 'manual_block') return true;
  // Migração segura: pausas existentes sem marca de reposição passam a ser
  // preservadas. Pausas exclusivamente por falta de estoque continuam reversíveis.
  // A pause state may have been written by an old pacing/reconciliation run.
  // Only an explicit manual lock above is persistent; eligible stock resumes.
  return false;
}

export function campaignMatchesProduct(campaign: any, product: any): boolean {
  if (!campaign || !product) return false;
  const campaignIds = [
    campaign.id,
    campaign.campaign_id,
    campaign.amazon_campaign_id,
  ].filter(Boolean).map(String);
  if (campaignIds.some(id => ids(product).has(id))) return true;
  const campaignAsin = norm(campaign.asin || campaign.advertised_asin);
  const campaignSku = norm(campaign.sku);
  return Boolean(
    (campaignAsin && campaignAsin === norm(product.asin)) ||
    (campaignSku && campaignSku === norm(product.sku))
  );
}

export function findPauseLockedProduct(products: any[], campaign: any): any | null {
  return products.find(product =>
    isProductCampaignPauseLocked(product) && campaignMatchesProduct(campaign, product)
  ) || null;
}

export function manualPauseLockPatch(now: string, actor?: string) {
  return {
    campaign_pause_lock: true,
    campaign_pause_lock_reason: 'USER_MANUAL',
    campaign_pause_locked_at: now,
    campaign_pause_locked_by: actor || 'authenticated_user',
    campaign_status: 'paused',
    should_activate_campaign: false,
    ads_resume_pending: false,
    ads_pause_reason: 'USER_MANUAL',
    ads_paused_at: now,
  };
}

export function clearManualPauseLockPatch(now: string, actor?: string) {
  return {
    campaign_pause_lock: false,
    campaign_pause_lock_reason: null,
    campaign_pause_locked_at: null,
    campaign_pause_locked_by: actor || 'authenticated_user',
    campaign_status: 'active',
    ads_resume_pending: false,
    ads_pause_reason: null,
    ads_scope_updated_at: now,
  };
}
