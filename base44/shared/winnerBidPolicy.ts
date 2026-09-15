import { AMAZON_BID_CEILING_BRL, AMAZON_WINNER_BID_CEILING_BRL } from './amazonBidCeiling.ts';

const n = (value: any) => Number.isFinite(Number(value)) ? Number(value) : 0;

export function keywordIdsAboveEconomicCeiling(payload: any): string[] {
  const rows = Array.isArray(payload) ? payload
    : Array.isArray(payload?.keywords) ? payload.keywords
    : [];
  return [...new Set(rows.filter((row: any) => {
    const bid = row?.bid && typeof row.bid === 'object' ? row.bid.value : row?.bid;
    return n(bid) > AMAZON_BID_CEILING_BRL;
  }).map((row: any) => String(row?.keywordId || '')).filter(Boolean))];
}

export function normalizedAcosPercent(value: any, targetAcos: any): number {
  const acos = n(value);
  return acos > 0 && acos <= 1 && n(targetAcos) > 1 ? acos * 100 : acos;
}

export function winnerBidEligibility(keyword: any, targetAcos: any, now = Date.now()) {
  const target = n(targetAcos);
  const acos = normalizedAcosPercent(keyword?.acos, target);
  const orders = n(keyword?.orders);
  const sales = n(keyword?.sales);
  const observedAt = new Date(keyword?.performance_confirmed_at || 0).getTime();
  const fresh = observedAt > 0 && now - observedAt <= 72 * 60 * 60 * 1000;
  const eligible = orders >= 1 && sales > 0 && acos > 0 && target > 0 && acos <= target && fresh;
  return {
    eligible,
    ceiling: eligible ? AMAZON_WINNER_BID_CEILING_BRL : AMAZON_BID_CEILING_BRL,
    reason: eligible ? 'winner_acos_within_target' : !fresh ? 'metrics_stale_or_missing'
      : orders < 1 || sales <= 0 ? 'not_a_winner'
      : acos <= 0 ? 'acos_missing_or_zero'
      : acos > target ? 'acos_above_target'
      : 'target_acos_missing',
    acos,
    targetAcos: target,
    orders,
    sales,
    fresh,
  };
}

export async function resolveWinnerKeywordCeilings(
  base44: any,
  amazonAccountId: string,
  path: string,
  method: string,
  payload: any,
) {
  if (!String(path).includes('keywords') || !['POST', 'PUT'].includes(String(method).toUpperCase())) {
    return { ceilings: {}, evidence: [] };
  }
  const ids = keywordIdsAboveEconomicCeiling(payload);
  if (!ids.length) return { ceilings: {}, evidence: [] };
  const [settingsRows, keywordRows] = await Promise.all([
    base44.asServiceRole.entities.PerformanceSettings.filter(
      { amazon_account_id: amazonAccountId }, '-updated_at', 10,
    ).catch(() => []),
    base44.asServiceRole.entities.Keyword.filter(
      { amazon_account_id: amazonAccountId }, '-synced_at', 10000,
    ).catch(() => []),
  ]);
  const targetAcos = Number(settingsRows[0]?.target_acos || 0);
  const byId = new Map<string, any>();
  for (const row of keywordRows) {
    const id = String(row.keyword_id || '');
    if (id && !byId.has(id)) byId.set(id, row);
  }
  const ceilings: Record<string, number> = {};
  const evidence = ids.map((keywordId) => {
    const result = winnerBidEligibility(byId.get(keywordId), targetAcos);
    if (result.eligible) ceilings[keywordId] = result.ceiling;
    return { keyword_id: keywordId, ...result };
  });
  return { ceilings, evidence };
}
