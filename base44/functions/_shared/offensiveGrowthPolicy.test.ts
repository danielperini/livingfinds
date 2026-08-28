import { assertEquals } from "jsr:@std/assert";
import { chooseSoftPauseRecoveryAction, clampGrowthCaps } from "./offensiveGrowthPolicy.ts";

Deno.test("soft pause follows recovery order", () => {
  assertEquals(chooseSoftPauseRecoveryAction({ blocked: true }), "recover_bid");
  assertEquals(chooseSoftPauseRecoveryAction({ blocked: true, attempted: ["recover_bid"] }), "increase_budget");
  assertEquals(chooseSoftPauseRecoveryAction({ blocked: true, attempted: ["recover_bid", "increase_budget"] }), "reactivate");
  assertEquals(chooseSoftPauseRecoveryAction({ blocked: true, attempted: ["recover_bid", "increase_budget", "reactivate"] }), "promote_exact");
  assertEquals(chooseSoftPauseRecoveryAction({ blocked: true, attempted: ["recover_bid", "increase_budget", "reactivate", "promote_exact"] }), "HOLD");
});

Deno.test("winner 30d remains protected", () => {
  assertEquals(chooseSoftPauseRecoveryAction({ blocked: true, winner30d: true }), "recover_bid");
  assertEquals(chooseSoftPauseRecoveryAction({ blocked: true, winner30d: true, attempted: ["recover_bid"] }), "HOLD");
});

Deno.test("growth caps are bounded", () => {
  assertEquals(clampGrowthCaps({ maxBudgetActions: 99, maxExactActions: 99, maxBidRecoveries: 99 }), {
    maxBudgetActions: 6,
    maxExactActions: 6,
    maxBidRecoveries: 8,
  });
});
