import { calculateInitialBid, diagnoseNoImpression, evaluateImpressionCoverage } from './exactBidPolicy.ts';
function eq<T>(a: T, b: T) { if (a !== b) throw new Error(`Expected ${String(b)}, got ${String(a)}`); }
Deno.test('calculates initial bid from source CPC and economics, never above safeMaxCpc', () => {
  const result = calculateInitialBid({ observedCpcTerm: 1.2, observedCpcCampaign: 0.8, cvr: 0.1, targetAcos: 0.3, averageOrderValue: 30, marginRate: 0.4, safeMaxCpc: 0.5 });
  eq(result.observedCpc, 1.2); eq(result.initialBid, 0.5); eq(result.initialBid <= result.safeMaxCpc, true);
});
Deno.test('diagnoses low bid and applies cumulative +5%, +10%, +15% only to a strong winner', () => {
  const base = { impressions: 0, spend: 0, ageHours: 30, currentBid: 0.4, safeMaxCpc: 0.6, observedCpcTerm: 0.5, sameSkuOrders: 1, sameSkuSales: 20, postAdsProfit: 8, acos: 0.2, economicAcosLimit: 0.3 };
  eq(diagnoseNoImpression(base).nextBid, 0.42); eq(diagnoseNoImpression({ ...base, currentBid: 0.42, correctionPctApplied: 0.05, baselineBid: 0.4 }).nextBid, 0.44); eq(diagnoseNoImpression({ ...base, currentBid: 0.46, correctionPctApplied: 0.15, baselineBid: 0.4 }).action, 'HOLD');
});
Deno.test('persistent zero spend reviews the existing campaign and does not create another', () => {
  const result = diagnoseNoImpression({ impressions: 0, spend: 0, ageHours: 60, currentBid: 0.5, safeMaxCpc: 0.7, sameSkuOrders: 0, sameSkuSales: 0, postAdsProfit: 0, acos: 0, economicAcosLimit: 0.3 });
  eq(result.cause, 'ZERO_SPEND_PERSISTENT'); eq(result.action, 'REVIEW_EXISTING');
});
Deno.test('coverage enforces 80% in 24h and 95% in 48h', () => {
  const now = new Date('2026-08-24T00:00:00Z'); const items = Array.from({ length: 20 }, (_, i) => ({ createdAt: new Date(now.getTime() - (i < 16 ? 12 : 36) * 3600000), impressions: i < 19 ? 1 : 0 }));
  const result = evaluateImpressionCoverage(items, now); eq(result.meets24h, true); eq(result.meets48h, true); eq(result.action, 'HEALTHY');
});
