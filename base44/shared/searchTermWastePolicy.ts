import { assessSearchTerm } from './searchTermQuality.ts';
export type SearchTermWasteRow = Record<string, unknown>;

const numeric = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizedTerm = (row: SearchTermWasteRow): string =>
  String(row.normalized_search_term || row.search_term_normalized || row.search_term || row.search_term_original || "")
    .trim()
    .toLocaleLowerCase("pt-BR");

const sourceTerm = (row: SearchTermWasteRow): string =>
  String(row.search_term_original || row.search_term || row.search_term_normalized || row.normalized_search_term || "").trim();

const freshness = (row: SearchTermWasteRow): number => {
  const value = row.metrics_fresh_at || row.synced_at || row.updated_at || row.created_at;
  const time = value ? new Date(String(value)).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
};

/** Keep the newest revision of a daily report row; never sum duplicate snapshots. */
export function dedupeSearchTermWasteRows(rows: SearchTermWasteRow[]): SearchTermWasteRow[] {
  const unique = new Map<string, SearchTermWasteRow>();
  for (const row of rows) {
    if (!assessSearchTerm(sourceTerm(row)).accepted) continue;
    const date = String(row.date || "").slice(0, 10);
    const campaignId = String(row.campaign_id || "");
    const targetId = String(row.source_target_id || row.target_id || row.keyword_id || "");
    const term = normalizedTerm(row);
    if (!date || !campaignId || !targetId || !term) continue;
    const product = `${String(row.advertised_asin || "").trim().toUpperCase()}|${String(row.advertised_sku || "").trim().toUpperCase()}`;
    const key = `${String(row.unique_key || `${date}|${campaignId}|${row.ad_group_id || ""}|${targetId}|${term}`)}|${product}`;
    const previous = unique.get(key);
    if (!previous || freshness(row) >= freshness(previous)) unique.set(key, row);
  }
  return [...unique.values()];
}

export type TargetWasteEvidence = {
  campaignId: string;
  targetId: string;
  isAutomatic: boolean;
  spend: number;
  sales: number;
  orders: number;
  clicks: number;
  attributionComplete: boolean;
  latestDate: string;
  terms: Array<{ text: string; spend: number; sales: number; orders: number; clicks: number; attributionComplete: boolean }>;
};

/** Aggregate by the Amazon bid-bearing target, since AUTO bids are shared across its search terms. */
export function aggregateSearchTermWasteTargets(
  rows: SearchTermWasteRow[],
  campaignsById: Map<string, Record<string, unknown>>,
  options: { fromDate: string; throughDate: string },
): TargetWasteEvidence[] {
  const targets = new Map<string, TargetWasteEvidence & { termMap: Map<string, TargetWasteEvidence["terms"][number]> }>();
  for (const row of dedupeSearchTermWasteRows(rows)) {
    const date = String(row.date || "").slice(0, 10);
    if (date < options.fromDate || date > options.throughDate) continue;
    const campaignId = String(row.campaign_id || "");
    const campaign = campaignsById.get(campaignId);
    if (!campaign) continue;
    const targetId = String(row.source_target_id || row.target_id || row.keyword_id || "");
    const term = normalizedTerm(row);
    const rowAsin = String(row.advertised_asin || "").trim().toUpperCase();
    const rowSku = String(row.advertised_sku || "").trim().toUpperCase();
    const campaignAsin = String(campaign.asin || campaign.advertised_asin || "").trim().toUpperCase();
    const campaignSku = String(campaign.sku || campaign.advertised_sku || "").trim().toUpperCase();
    if ((rowAsin && campaignAsin && rowAsin !== campaignAsin) || (rowSku && campaignSku && rowSku !== campaignSku)) continue;
    if (!((rowAsin && campaignAsin && rowAsin === campaignAsin) || (rowSku && campaignSku && rowSku === campaignSku))) continue;

    const sourceType = String(row.source_type || "").toUpperCase();
    const matchType = String(row.match_type || "").toLowerCase();
    const isAutomatic = sourceType === "AUTO_SEARCH_TERM" || matchType === "auto" ||
      /^\s*auto\s*[|:]/i.test(String(campaign.name || campaign.campaign_name || ""));
    const key = `${campaignId}|${targetId}|${isAutomatic ? "auto" : "keyword"}`;
    const evidence = targets.get(key) || {
      campaignId,
      targetId,
      isAutomatic,
      spend: 0,
      sales: 0,
      orders: 0,
      clicks: 0,
      attributionComplete: true,
      latestDate: date,
      terms: [],
      termMap: new Map(),
    };
    // Use 1-day attribution per report date. 7/14/30-day columns repeat
    // conversions across daily rows and would double-count them.
    const spend = numeric(row.spend);
    const salesPresent = row.sales_1d !== null && row.sales_1d !== undefined && row.sales_1d !== "";
    const ordersPresent = row.orders_1d !== null && row.orders_1d !== undefined && row.orders_1d !== "";
    const sales = numeric(row.sales_1d);
    const orders = numeric(row.orders_1d);
    const clicks = numeric(row.clicks);
    evidence.spend += spend;
    evidence.sales += sales;
    evidence.orders += orders;
    evidence.clicks += clicks;
    evidence.attributionComplete = evidence.attributionComplete && salesPresent && ordersPresent;
    if (date > evidence.latestDate) evidence.latestDate = date;
    const termEvidence = evidence.termMap.get(term) || { text: sourceTerm(row), spend: 0, sales: 0, orders: 0, clicks: 0, attributionComplete: true };
    termEvidence.spend += spend;
    termEvidence.sales += sales;
    termEvidence.orders += orders;
    termEvidence.clicks += clicks;
    termEvidence.attributionComplete = termEvidence.attributionComplete && salesPresent && ordersPresent;
    evidence.termMap.set(term, termEvidence);
    targets.set(key, evidence);
  }
  return [...targets.values()].map(({ termMap, ...evidence }) => ({
    ...evidence,
    terms: [...termMap.values()].sort((a, b) => b.spend - a.spend),
  }));
}

export function isTermTargetWaste(evidence: Pick<TargetWasteEvidence, "spend" | "sales" | "orders" | "clicks" | "latestDate" | "attributionComplete"> & {
  minimumSpend: number;
  throughDate: string;
  maxReportAgeDays?: number;
}): boolean {
  const ageDays = Math.floor((Date.parse(`${evidence.throughDate}T12:00:00Z`) - Date.parse(`${evidence.latestDate}T12:00:00Z`)) / 86400000);
  return evidence.attributionComplete && evidence.sales <= 0 && evidence.orders <= 0 && evidence.spend >= evidence.minimumSpend &&
    evidence.clicks >= 8 && ageDays >= 0 && ageDays <= (evidence.maxReportAgeDays ?? 3);
}

export function firstWasteBid(currentBid: number): number {
  return Math.max(0.02, Math.round(currentBid * 0.7 * 100) / 100);
}

export type WasteProgressionAction = "HOLD" | "REDUCE_BID_30" | "REDUCE_BID_10" | "NEGATIVE_EXACT";

export function decideWasteProgression(input: {
  priorConfirmedReductions: number;
  hoursSinceLastReduction: number;
  hoursSinceFirstReduction: number;
  spendSinceLastReduction: number;
  clicksSinceLastReduction: number;
  ordersSinceLastReduction: number;
  salesSinceLastReduction: number;
  termAfterLastReduction?: { text: string; spend: number; clicks: number; orders: number; sales: number; attributionComplete: boolean };
  minimumSpend: number;
  alreadyNegative?: boolean;
}): WasteProgressionAction {
  if (input.priorConfirmedReductions <= 0) return "REDUCE_BID_30";
  if (input.priorConfirmedReductions === 1) {
    return input.hoursSinceLastReduction >= 24 && input.spendSinceLastReduction >= input.minimumSpend &&
        input.clicksSinceLastReduction >= 4 && input.ordersSinceLastReduction === 0 && input.salesSinceLastReduction <= 0
      ? "REDUCE_BID_10"
      : "HOLD";
  }
  const term = input.termAfterLastReduction;
  return input.priorConfirmedReductions >= 2 && input.hoursSinceFirstReduction >= 72 && term &&
      term.attributionComplete && term.spend >= input.minimumSpend && term.clicks >= 8 && term.orders === 0 && term.sales <= 0 &&
      !input.alreadyNegative
    ? "NEGATIVE_EXACT"
    : "HOLD";
}
