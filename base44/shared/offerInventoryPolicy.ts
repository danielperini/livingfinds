import {availableAdsStock} from './stockAdsPolicy.ts';
import {recoveredOfferLockPatch} from './catalogRecoveryPolicy.ts';
/** Listings describe offer eligibility. FBA Inventory alone owns the available stock. */
export function offerOnlyProductPatch(product:any,signal:any,observed:any,now:string) {
  const quantity=availableAdsStock(product);
  const eligibility=observed.listing_status_confirmed===false ? (product.ads_eligibility_status || 'verification_pending')
    : signal.listing_suppressed ? 'listing_suppressed'
    : !signal.offer_active ? 'offer_inactive'
    : !signal.listing_buyable ? 'not_buyable'
    : quantity<0 ? 'verification_pending'
    : quantity===0 ? 'out_of_stock' : 'eligible';
  const {fulfillment_channel,...offerSignal}=signal;
  return {...offerSignal,listing_fulfillment_channel:fulfillment_channel,
    ...recoveredOfferLockPatch(product,observed),ads_eligibility_status:eligibility,
    ads_ineligibility_reason:signal.reason || (eligibility==='out_of_stock'?'Estoque FBA disponível zero':quantity<0?'Estoque FBA não confirmado':''),
    ads_last_eligibility_check_at:now,listing_checked_at:now};
}
