export const AMAZON_BID_CEILING_BRL = 1;
export const AMAZON_WINNER_BID_CEILING_BRL = 1.5;

export function clampAmazonBid(value: unknown, ceiling = AMAZON_BID_CEILING_BRL): number | unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
    return { ...value, value: clampAmazonBid((value as any).value, ceiling) };
  }
  const bid = Number(value);
  if (!Number.isFinite(bid) || bid <= 0) return value;
  const safeCeiling = Math.min(AMAZON_WINNER_BID_CEILING_BRL, Math.max(0.02, Number(ceiling) || AMAZON_BID_CEILING_BRL));
  return Math.round(Math.min(bid, safeCeiling) * 100) / 100;
}

export function enforceBidCeilingOnPayload(
  path: string,
  method: string,
  payload: any,
  entityCeilings: Record<string, number> = {},
): any {
  if (!['POST', 'PUT'].includes(String(method).toUpperCase()) || payload == null) return payload;
  const entityKey = path.includes('adGroups') ? 'adGroups'
    : path.includes('keywords') ? 'keywords'
    : path.includes('targets') ? (Array.isArray(payload?.targetingClauses) ? 'targetingClauses' : 'targets')
    : null;
  if (!entityKey) return payload;

  const clamp = (item: any) => {
    if (!item || typeof item !== 'object') return item;
    const result = { ...item };
    const entityId = String(result.keywordId || result.adGroupId || result.targetId || '');
    const ceiling = entityId && Number(entityCeilings[entityId]) > 0
      ? Number(entityCeilings[entityId])
      : AMAZON_BID_CEILING_BRL;
    if ('bid' in result) result.bid = clampAmazonBid(result.bid, ceiling);
    if ('defaultBid' in result) result.defaultBid = clampAmazonBid(result.defaultBid, ceiling);
    return result;
  };

  if (Array.isArray(payload)) return payload.map(clamp);
  if (Array.isArray(payload[entityKey])) return { ...payload, [entityKey]: payload[entityKey].map(clamp) };
  return payload;
}
