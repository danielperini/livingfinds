const finite = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

const normalize = (value: unknown) => String(value || '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[\s-]+/g, '_');

const INACTIVE_TOKENS = [
  'inactive', 'inativo', 'disabled', 'desativado', 'archived', 'arquivado',
  'deleted', 'excluido', 'closed', 'encerrado', 'removed', 'removido',
  'suppressed', 'suprimido', 'blocked', 'bloqueado', 'not_buyable',
  'unavailable', 'indisponivel', 'out_of_stock', 'sem_estoque',
];

const ACTIVE_TOKENS = [
  'active', 'ativo', 'enabled', 'habilitado', 'buyable', 'compravel',
  'live', 'available', 'disponivel',
];

const statusValues = (product: any) => [
  product?.status,
  product?.state,
  product?.product_status,
  product?.amazon_status,
  product?.listing_status,
  product?.offer_status,
  product?.lifecycle_status,
  product?.ads_eligibility_status,
].map(normalize).filter(Boolean);

const hasToken = (values: string[], tokens: string[]) => values.some((value) =>
  tokens.some((token) => value === token || value.includes(`_${token}`) || value.includes(`${token}_`) || value.includes(token))
);

export type ProductAdsEligibility = {
  eligible: boolean;
  active: boolean;
  inStock: boolean;
  stock: number;
  reason: 'ELIGIBLE' | 'PRODUCT_NOT_FOUND' | 'PRODUCT_INACTIVE' | 'PRODUCT_OUT_OF_STOCK' | 'LISTING_SUPPRESSED' | 'LISTING_NOT_BUYABLE';
  statusSignals: string[];
};

export function productAdsEligibility(product: any): ProductAdsEligibility {
  if (!product) {
    return { eligible: false, active: false, inStock: false, stock: 0, reason: 'PRODUCT_NOT_FOUND', statusSignals: [] };
  }

  const signals = statusValues(product);
  const stock = Math.max(0, finite(
    product.fulfillable_quantity ??
    product.available_quantity ??
    product.inventory_quantity ??
    product.stock ??
    product.fba_inventory,
    0,
  ));

  const explicitlyInactive = product.active === false || product.is_active === false || product.enabled === false || hasToken(signals, INACTIVE_TOKENS);
  const explicitlyActive = product.active === true || product.is_active === true || product.enabled === true || hasToken(signals, ACTIVE_TOKENS);
  const active = !explicitlyInactive && (explicitlyActive || signals.length === 0 || stock > 0);
  const inStock = stock > 0;

  if (!active) return { eligible: false, active: false, inStock, stock, reason: 'PRODUCT_INACTIVE', statusSignals: signals };
  if (!inStock) return { eligible: false, active: true, inStock: false, stock, reason: 'PRODUCT_OUT_OF_STOCK', statusSignals: signals };
  if (product.listing_suppressed === true) return { eligible: false, active: true, inStock: true, stock, reason: 'LISTING_SUPPRESSED', statusSignals: signals };
  if (product.listing_buyable === false) return { eligible: false, active: true, inStock: true, stock, reason: 'LISTING_NOT_BUYABLE', statusSignals: signals };

  return { eligible: true, active: true, inStock: true, stock, reason: 'ELIGIBLE', statusSignals: signals };
}
