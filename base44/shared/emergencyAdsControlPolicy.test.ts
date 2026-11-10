import { assertEquals } from "jsr:@std/assert@1";
import { aggregateDailyMetrics, campaignIdentity, parseEmergencyRun, uniqueCampaigns } from "./emergencyAdsControlPolicy.ts";

Deno.test("deduplicates campaign rows and only selects the requested state", () => {
  const result = uniqueCampaigns([
    { campaign_id: "1", campaign_type: "SP", state: "enabled", synced_at: "2026-11-01" },
    { campaign_id: "1", campaign_type: "SP", state: "paused", synced_at: "2026-11-02" },
    { campaign_id: "2", campaign_type: "SB", state: "enabled" },
    { campaign_id: "2", campaign_type: "SB", state: "enabled" },
  ], "enabled");
  assertEquals(result.map((item) => item.identity.type + ":" + item.identity.id), ["SB:2"]);
});

Deno.test("uses supported campaign identity and excludes missing ids or unknown types", () => {
  assertEquals(campaignIdentity({ amazon_campaign_id: "8", campaign_type: "SD" }), { type: "SD", id: "8" });
  assertEquals(campaignIdentity({ campaign_type: "DSP", campaign_id: "9" }), null);
  assertEquals(campaignIdentity({ campaign_type: "SP" }), null);
});

Deno.test("aggregates from deduplicated campaign-day totals, not percent averages", () => {
  const rows = [
    { amazon_account_id: "a", campaign_id: "1", date: "2026-11-01", spend: 5, sales: 10, clicks: 2, impressions: 100, orders: 1 },
    { amazon_account_id: "a", campaign_id: "1", date: "2026-11-01", spend: 5, sales: 10, clicks: 2, impressions: 100, orders: 1 },
    { amazon_account_id: "a", campaign_id: "2", date: "2026-11-01", spend: 20, sales: 10, clicks: 2, impressions: 100, orders: 0 },
  ];
  const result = aggregateDailyMetrics(rows);
  assertEquals(result.unique_campaign_days, 2);
  assertEquals(result.totals.spend, 25);
  assertEquals(result.conflicting_campaign_days, 0);
  assertEquals(result.totals.sales, 20);
  assertEquals(result.acos, 125);
  assertEquals(result.roas, 0.8);
});

Deno.test("malformed emergency snapshots are rejected", () => {
  assertEquals(parseEmergencyRun("not-json"), null);
  assertEquals(parseEmergencyRun(JSON.stringify({ confirmedCampaignIds: ["1"] }))?.confirmedCampaignIds, ["1"]);
});

Deno.test("omits conflicting same-day metric duplicates instead of choosing arbitrary economics", () => {
  const result = aggregateDailyMetrics([
    { amazon_account_id: "a", campaign_id: "1", date: "2026-11-01", spend: 5, sales: 10, clicks: 2, impressions: 100, orders: 1 },
    { amazon_account_id: "a", campaign_id: "1", date: "2026-11-01", spend: 50, sales: 10, clicks: 2, impressions: 100, orders: 1 },
  ]);
  assertEquals(result.conflicting_campaign_days, 1);
  assertEquals(result.unique_campaign_days, 0);
  assertEquals(result.totals.spend, 0);
});
