import { availableAdsStock, hasFreshAdsInventory } from './stockAdsPolicy.ts';
import { isProductCampaignPauseLocked, productOfferEligibility } from './productCampaignPauseGuard.ts';

export function kickoffDiscovery(product: any, campaigns: any[], queue: any[], now = Date.now()) {
  const sku = String(product.sku || '').trim();
  const asin = String(product.asin || '').trim().toUpperCase();
  const same = (r: any) => r.amazon_account_id === product.amazon_account_id &&
    (r.sku ? String(r.sku).trim().toUpperCase() === sku.toUpperCase() : r.asin === asin);
  if (product.status === 'archived' || !sku || !/^B0[A-Z0-9]{8}$/.test(asin)) return { status: 'excluded', reasons: [] };
  if (campaigns.some(c => same(c) && ['enabled', 'active'].includes(String(c.state || c.status).toLowerCase()))) return { status: 'covered', reasons: [] };
  if (queue.some(q => same(q) && ['scheduled', 'processing', 'waiting_stock'].includes(q.status))) return { status: 'queued', reasons: ['Kickoff já está na fila.'] };
  const stock = availableAdsStock(product);
  // Keep previously discovered products visible until their blockers are resolved.
  if (!product.kickoff_discovered_at && stock <= 0 && product.status !== 'active' && product.offer_active !== true) return { status: 'excluded', reasons: [] };
  const reasons: string[] = [];
  if (!hasFreshAdsInventory(product, now)) reasons.push('Atualizar saldo FBA.');
  if (stock <= 0) reasons.push(stock === 0 ? 'Sem saldo FBA.' : 'Saldo FBA não confirmado.');
  if (isProductCampaignPauseLocked(product)) reasons.push('Pausa manual: reativação depende da sua decisão.');
  if (!productOfferEligibility(product).eligible) reasons.push('Oferta indisponível na Amazon.');
  const offerAge = now - Date.parse(product.ads_last_eligibility_check_at || '');
  if (product.offer_active !== true || product.listing_buyable !== true || !Number.isFinite(offerAge) || offerAge < 0 || offerAge > 86400000) reasons.push('Confirmar disponibilidade da oferta.');
  if (product.cost_confirmed !== true) reasons.push('Confirmar custo do produto.');
  if (product.ads_scope_status !== 'authorized') reasons.push('Autorizar SKU para anúncios.');
  if (campaigns.some(c => same(c) && String(c.state || c.status).toLowerCase() === 'paused')) reasons.push('Revisar campanha pausada antes de iniciar outra.');
  return { status: reasons.length ? 'blocked' : 'ready', reasons };
}
