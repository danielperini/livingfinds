/** Pure campaign-funnel, harvesting, delivery and confirmation policies.
 * No Amazon/network calls are made here; integrations pass observations in and out.
 */
export const FUNNEL_STAGES = [
  "TERM_DISCOVERED",
  "WINNER_ELIGIBLE",
  "RESERVED",
  "CAMPAIGN_CREATED",
  "AMAZON_ACCEPTED",
  "CONFIRMED",
  "IMPRESSING",
  "CLICKING",
  "SELLING",
] as const;
export type FunnelStage = typeof FUNNEL_STAGES[number];
export type HarvestSource = "AUTO" | "BROAD" | "PHRASE" | "MANUAL";
export type DeliveryCause =
  | "TOO_EARLY"
  | "BID_TOO_LOW"
  | "ZERO_SPEND_PERSISTENT"
  | "TARGETING_OR_CATALOG"
  | "DELIVERY_OR_ACCOUNT"
  | "INVALID_BID"
  | "NONE";

export interface FunnelRecord {
  id: string;
  term: string;
  source: HarvestSource;
  stage: FunnelStage;
  createdAt: string;
  impressions?: number;
  clicks?: number;
  sales?: number;
  spend?: number;
  bid?: number;
  safeMaxCpc?: number;
  amazonCampaignId?: string;
  amazonStatus?: string;
}
export interface HarvestCandidate {
  term: string;
  source: HarvestSource;
  observedCpc?: number;
  cvr?: number;
  targetAcos?: number;
  averageOrderValue?: number;
  marginPerOrder?: number;
  safeMaxCpc: number;
  discoveredAt?: string;
}
export interface HarvestResult {
  accepted: HarvestCandidate[];
  skippedDuplicates: number;
  skippedDailyLimit: number;
  limit: number;
}
export interface BidLadderInput {
  currentBid: number;
  safeMaxCpc: number;
  sourceCpc?: number;
  strongWinner: boolean;
  economicsAllow: boolean;
  appliedPct?: number;
}
export interface BidLadderResult {
  action: "HOLD" | "ADJUST_BID";
  cause: "BID_TOO_LOW" | "NONE";
  nextBid: number;
  appliedPct: number;
  capped: boolean;
}
export interface AmazonObservation {
  localId: string;
  amazonCampaignId?: string;
  status?: string;
  accepted?: boolean;
  confirmed?: boolean;
}
export interface Panel {
  generatedAt: string;
  total: number;
  byStage: Record<FunnelStage, number>;
  bySource: Record<HarvestSource, number>;
  transitions: { from: FunnelStage; to: FunnelStage; count: number }[];
  delivery: { zeroImpression: number; zeroSpend: number; selling: number };
  amazon: { accepted: number; confirmed: number; pending: number };
}

const round = (v: number) => Math.round(Math.max(0, v) * 100) / 100;
const num = (v: unknown) =>
  Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0;
const canonical = (term: string) =>
  term.trim().toLocaleLowerCase().replace(/\s+/g, " ");
const finiteDate = (v: string | undefined) => {
  const d = v ? new Date(v) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
};

export function isValidTransition(from: FunnelStage, to: FunnelStage): boolean {
  if (from === to) return true;
  const next: Partial<Record<FunnelStage, FunnelStage[]>> = {
    TERM_DISCOVERED: ["WINNER_ELIGIBLE"],
    WINNER_ELIGIBLE: ["RESERVED"],
    RESERVED: ["CAMPAIGN_CREATED"],
    CAMPAIGN_CREATED: ["AMAZON_ACCEPTED"],
    AMAZON_ACCEPTED: ["CONFIRMED"],
    CONFIRMED: ["IMPRESSING"],
    IMPRESSING: ["CLICKING"],
    CLICKING: ["SELLING"],
  };
  return next[from]?.includes(to) ?? false;
}

export function transition(
  record: FunnelRecord,
  to: FunnelStage,
): FunnelRecord {
  if (!isValidTransition(record.stage, to)) {
    throw new Error(`Invalid funnel transition ${record.stage} -> ${to}`);
  }
  return { ...record, stage: to };
}

export function harvestCandidates(
  candidates: readonly HarvestCandidate[],
  existingTerms: readonly string[],
  alreadyCreatedToday = 0,
  limit = 20,
): HarvestResult {
  const seen = new Set(existingTerms.map(canonical));
  const accepted: HarvestCandidate[] = [];
  let skippedDuplicates = 0;
  const ordered = [...candidates].sort((a, b) =>
    (b.cvr ?? 0) - (a.cvr ?? 0) || (b.observedCpc ?? 0) - (a.observedCpc ?? 0)
  );
  for (const candidate of ordered) {
    const key = canonical(candidate.term);
    if (!key || seen.has(key)) {
      skippedDuplicates++;
      continue;
    }
    if (
      alreadyCreatedToday + accepted.length >= Math.min(20, Math.max(0, limit))
    ) break;
    seen.add(key);
    accepted.push({ ...candidate, term: candidate.term.trim() });
  }
  return {
    accepted,
    skippedDuplicates,
    skippedDailyLimit: Math.max(
      0,
      ordered.length - skippedDuplicates - accepted.length,
    ),
    limit: Math.min(20, Math.max(0, limit)),
  };
}

export function calculateBidLadder(input: BidLadderInput): BidLadderResult {
  const current = num(input.currentBid);
  const safe = round(input.safeMaxCpc);
  const source = num(input.sourceCpc);
  const prior = Math.min(0.15, num(input.appliedPct));
  const step = prior < 0.05
    ? 0.05
    : prior < 0.10
    ? 0.10
    : prior < 0.15
    ? 0.15
    : 0;
  const proposed = round(Math.min(safe, current * (1 + step)));
  const shouldRaise = input.strongWinner && input.economicsAllow &&
    source > current && step > 0 && proposed > current && proposed <= safe;
  return {
    action: shouldRaise ? "ADJUST_BID" : "HOLD",
    cause: shouldRaise ? "BID_TOO_LOW" : "NONE",
    nextBid: shouldRaise ? proposed : current,
    appliedPct: shouldRaise ? step : prior,
    capped: shouldRaise && proposed === safe,
  };
}

export function diagnoseZeroDelivery(
  record: Pick<
    FunnelRecord,
    | "stage"
    | "createdAt"
    | "impressions"
    | "spend"
    | "bid"
    | "safeMaxCpc"
    | "amazonStatus"
    | "amazonCampaignId"
  >,
  now = new Date(),
): {
  cause: DeliveryCause;
  action:
    | "HOLD"
    | "ADJUST_BID"
    | "REVIEW_EXISTING"
    | "FIX_TARGETING_OR_CATALOG"
    | "FIX_ACCOUNT_OR_DELIVERY";
} {
  if (num(record.impressions) > 0) return { cause: "NONE", action: "HOLD" };
  if (num(record.bid) <= 0 || num(record.safeMaxCpc) <= 0) {
    return { cause: "INVALID_BID", action: "REVIEW_EXISTING" };
  }
  if (!record.amazonCampaignId || record.amazonStatus !== "CONFIRMED") {
    return { cause: "DELIVERY_OR_ACCOUNT", action: "FIX_ACCOUNT_OR_DELIVERY" };
  }
  const ageHours =
    Math.max(0, now.getTime() - finiteDate(record.createdAt).getTime()) /
    3600000;
  if (ageHours < 24) return { cause: "TOO_EARLY", action: "HOLD" };
  if (num(record.spend) === 0 && ageHours >= 48) {
    return { cause: "ZERO_SPEND_PERSISTENT", action: "REVIEW_EXISTING" };
  }
  return { cause: "BID_TOO_LOW", action: "ADJUST_BID" };
}

export function applyAmazonObservation(
  record: FunnelRecord,
  observation: AmazonObservation,
): FunnelRecord {
  if (observation.localId !== record.id) {
    throw new Error("Amazon observation does not match local campaign");
  }
  const accepted = observation.accepted ||
    ["ACCEPTED", "ENABLED", "ACTIVE"].includes(
      (observation.status ?? "").toUpperCase(),
    );
  const confirmed = observation.confirmed ||
    (accepted && Boolean(observation.amazonCampaignId));
  let stage = record.stage;
  if (accepted && isValidTransition(stage, "AMAZON_ACCEPTED")) {
    stage = "AMAZON_ACCEPTED";
  }
  if (confirmed && isValidTransition(stage, "CONFIRMED")) stage = "CONFIRMED";
  return {
    ...record,
    stage,
    amazonCampaignId: observation.amazonCampaignId ?? record.amazonCampaignId,
    amazonStatus: observation.status ?? record.amazonStatus,
  };
}

export function buildCampaignFunnelPanel(
  records: readonly FunnelRecord[],
  transitions: readonly { from: FunnelStage; to: FunnelStage }[] = [],
  now = new Date(),
): Panel {
  const byStage = Object.fromEntries(
    FUNNEL_STAGES.map((stage) => [
      stage,
      records.filter((r) => r.stage === stage).length,
    ]),
  ) as Record<FunnelStage, number>;
  const bySource = Object.fromEntries(
    (["AUTO", "BROAD", "PHRASE", "MANUAL"] as HarvestSource[]).map((
      source,
    ) => [source, records.filter((r) => r.source === source).length]),
  ) as Record<HarvestSource, number>;
  const transitionCounts = new Map<string, number>();
  for (const item of transitions) {
    const key = `${item.from}->${item.to}`;
    transitionCounts.set(key, (transitionCounts.get(key) ?? 0) + 1);
  }
  const zeroImpression = records.filter((r) => num(r.impressions) === 0).length;
  const zeroSpend = records.filter((r) => num(r.spend) === 0).length;
  return {
    generatedAt: now.toISOString(),
    total: records.length,
    byStage,
    bySource,
    transitions: [...transitionCounts].map(([key, count]) => {
      const [from, to] = key.split("->") as [FunnelStage, FunnelStage];
      return { from, to, count };
    }),
    delivery: {
      zeroImpression,
      zeroSpend,
      selling:
        records.filter((r) => r.stage === "SELLING" || num(r.sales) > 0).length,
    },
    amazon: {
      accepted: records.filter((r) =>
        r.stage === "AMAZON_ACCEPTED" ||
        FUNNEL_STAGES.indexOf(r.stage) >
          FUNNEL_STAGES.indexOf("AMAZON_ACCEPTED")
      ).length,
      confirmed:
        records.filter((r) =>
          FUNNEL_STAGES.indexOf(r.stage) >= FUNNEL_STAGES.indexOf("CONFIRMED")
        ).length,
      pending: records.filter((r) => !r.amazonCampaignId).length,
    },
  };
}
