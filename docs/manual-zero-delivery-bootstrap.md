# Manual zero-delivery bootstrap

## Operational contract

`runManualZeroDeliveryBootstrap` is a stage of the canonical
`runUnifiedDecisionEngine`; it is not an independent decision engine or queue.
It considers only complete, Amazon-confirmed, enabled manual SP EXACT
structures with fresh metrics, an eligible listing, real stock, at least 24
hours of age, and exactly zero impressions, clicks, and spend.

It permits at most two increases, with a 72-hour cooldown and a hard 20%
per-attempt limit. The proposed bid is bounded by Amazon's suggested midpoint,
configured maximum bid, and trustworthy economic CPC limits. Missing economic
limits block the action. `dry_run` neither writes diagnostic state nor creates
or executes decisions.

Execution delegates to `executePairedManualBidDecision`. That executor confirms
the current Amazon entities, updates ad group and keyword together, rolls the
ad group back if the keyword write fails, and updates local canonical/base bids
only after Amazon confirms both writes. Every proposal has a deterministic
idempotency key and an `OptimizationDecision` audit record.

After two unsuccessful delivery attempts, the campaign is marked
`replacement_review_required`. Term replacement remains deliberately gated:
the existing campaign is not paused and no new term is launched until the
existing canonical campaign-creation workflow can confirm relevance and the
new full campaign remotely. This avoids a destructive partial replacement.

## Scheduler audit

The self-hosted scheduler is `server/src/scheduler.ts`. It reads
`base44/schedules/amazon-automation-schedule.json` every 30 seconds and runs only
when `ENABLE_SCHEDULER` permits it.

The versioned schedule directly contains:

- `processAmazonNightWindow`: 00:00, 01:00, 02:00, 03:00 and 13:00 BRT.
- `runMorningRecovery0600`: 06:00 BRT.
- `runIntraDayBudgetPacingCycle`: 06:05, 13:05, 19:00 and 22:00 BRT.
- `runMorningAmazonSchedule`: 06:40 BRT.
- `autoStockCampaignGuard`: 07:00 BRT.

`runUnifiedDecisionEngine`, `runManualZeroDeliveryBootstrap`,
`runAmazonWriteWindow`, `runCanonicalDaypartingEngine`,
`processBidDecisionQueue`, and `syncAmazonScheduleBidRules` are not direct
entries in that JSON. They run only when invoked transitively by a scheduled
orchestrator or explicitly through an authenticated/service-role request.
Consequently, merging code alone does not prove that the bootstrap ran against
Amazon; production execution must be verified in `OptimizationDecision`,
`BidHistory`, and the scheduler/application logs.
