import {
  applyAmazonObservation,
  buildCampaignFunnelPanel,
  calculateBidLadder,
  diagnoseZeroDelivery,
  harvestCandidates,
  isValidTransition,
  transition,
} from "./campaignFunnelPolicy.ts";
function eq<T>(a: T, b: T) {
  if (a !== b) throw new Error(`Expected ${String(b)}, got ${String(a)}`);
}
const base = {
  id: "x",
  term: "red shoe",
  source: "MANUAL" as const,
  stage: "CAMPAIGN_CREATED" as const,
  createdAt: "2026-08-22T00:00:00Z",
  impressions: 0,
  spend: 0,
  bid: 0.4,
  safeMaxCpc: 0.5,
};
Deno.test("tests all funnel stages and rejects skips", () => {
  let r = { ...base };
  for (
    const stage of [
      "AMAZON_ACCEPTED",
      "CONFIRMED",
      "IMPRESSING",
      "CLICKING",
      "SELLING",
    ] as const
  ) r = transition(r, stage);
  eq(r.stage, "SELLING");
  eq(isValidTransition("TERM_DISCOVERED", "CAMPAIGN_CREATED"), false);
});
Deno.test("harvests AUTO/BROAD/PHRASE/MANUAL with deduplication and 20/day limit", () => {
  const sources = ["AUTO", "BROAD", "PHRASE", "MANUAL"] as const;
  const candidates = Array.from(
    { length: 25 },
    (_, i) => ({ term: `Term ${i}`, source: sources[i % 4], safeMaxCpc: 1 }),
  );
  const result = harvestCandidates(
    [...candidates, { ...candidates[0], term: " term 0 " }],
    [],
    0,
    20,
  );
  eq(result.accepted.length, 20);
  eq(result.skippedDailyLimit, 6);
  eq(new Set(result.accepted.map((x) => x.term.toLowerCase())).size, 20);
});
Deno.test("never exceeds safeMaxCpc and follows 5/10/15 percent ladder", () => {
  const a = calculateBidLadder({
    currentBid: 0.4,
    sourceCpc: 0.8,
    safeMaxCpc: 1,
    strongWinner: true,
    economicsAllow: true,
  });
  eq(a.nextBid, 0.42);
  const b = calculateBidLadder({
    currentBid: 0.42,
    sourceCpc: 0.8,
    safeMaxCpc: 1,
    strongWinner: true,
    economicsAllow: true,
    appliedPct: 0.05,
  });
  eq(b.nextBid, 0.44);
  const c = calculateBidLadder({
    currentBid: 0.46,
    sourceCpc: 0.8,
    safeMaxCpc: 0.47,
    strongWinner: true,
    economicsAllow: true,
    appliedPct: 0.10,
  });
  eq(c.nextBid, 0.47);
  eq(c.nextBid <= 0.47, true);
});
Deno.test("diagnoses zero delivery without creating duplicate campaigns", () => {
  const early = diagnoseZeroDelivery(base, new Date("2026-08-22T12:00:00Z"));
  eq(early.cause, "DELIVERY_OR_ACCOUNT");
  const confirmed = {
    ...base,
    amazonCampaignId: "amz-1",
    amazonStatus: "CONFIRMED",
  };
  eq(
    diagnoseZeroDelivery(confirmed, new Date("2026-08-22T12:00:00Z")).cause,
    "TOO_EARLY",
  );
  eq(
    diagnoseZeroDelivery(confirmed, new Date("2026-08-25T00:00:00Z")).cause,
    "ZERO_SPEND_PERSISTENT",
  );
});
Deno.test("confirms Amazon only from matching accepted observation", () => {
  const accepted = applyAmazonObservation(base, {
    localId: "x",
    amazonCampaignId: "amz-1",
    status: "ACCEPTED",
  });
  eq(accepted.stage, "CONFIRMED");
  eq(accepted.amazonCampaignId, "amz-1");
});
Deno.test("builds panel with stages, sources, transitions and delivery", () => {
  const records = [base, {
    ...base,
    id: "y",
    source: "AUTO" as const,
    stage: "SELLING" as const,
    impressions: 10,
    sales: 1,
    spend: 2,
    amazonCampaignId: "a",
    amazonStatus: "ACTIVE",
  }];
  const panel = buildCampaignFunnelPanel(records, [{
    from: "TERM_DISCOVERED",
    to: "WINNER_ELIGIBLE",
  }, { from: "TERM_DISCOVERED", to: "WINNER_ELIGIBLE" }]);
  eq(panel.total, 2);
  eq(panel.byStage.SELLING, 1);
  eq(panel.bySource.AUTO, 1);
  eq(panel.transitions[0].count, 2);
  eq(panel.delivery.zeroImpression, 1);
});
