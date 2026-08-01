import { normalizeSku } from "./repricingPolicy.ts";

export const REPRICING_TIME_ZONE = "America/Sao_Paulo";
export const AUTOMATIC_REPRICING_RUNTIME_FLAG =
  "LIVINGFINDS_AUTOMATIC_REPRICING_V2_ENABLED";

export function isAutomaticRepricingRuntimeEnabled(value: unknown): boolean {
  return String(value || "").trim().toLowerCase() === "true";
}

export const CONCURRENT_PRICE_ACTION_STATUSES = new Set([
  "pending",
  "submitted",
  "processing",
]);

export const DAILY_PRICE_ACTION_STATUSES = new Set([
  ...CONCURRENT_PRICE_ACTION_STATUSES,
  "confirmed",
]);

export function dayKeyInTimeZone(
  value: string | number | Date = Date.now(),
  timeZone = REPRICING_TIME_ZONE,
): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [
      part.type,
      part.value,
    ]),
  );
  return values.year && values.month && values.day
    ? `${values.year}-${values.month}-${values.day}`
    : null;
}

export function actionMatchesSku(action: any, sku: unknown): boolean {
  const expected = normalizeSku(sku);
  return Boolean(expected) &&
    normalizeSku(action?.normalized_sku || action?.sku) === expected;
}

export function isConcurrentPriceAction(action: any): boolean {
  return CONCURRENT_PRICE_ACTION_STATUSES.has(String(action?.status || ""));
}

export function actionBlocksAutomaticDay(
  action: any,
  day: string,
): boolean {
  if (!day || !DAILY_PRICE_ACTION_STATUSES.has(String(action?.status || ""))) {
    return false;
  }
  const keyDay = String(action?.idempotency_key || "").split(":").at(-1);
  const createdDay = action?.created_at
    ? dayKeyInTimeZone(action.created_at)
    : null;
  return keyDay === day || createdDay === day;
}

export function pricesMatch(
  observed: unknown,
  expected: unknown,
  tolerance = 0.01,
): boolean {
  const observedPrice = Number(observed);
  const expectedPrice = Number(expected);
  return Number.isFinite(observedPrice) && observedPrice > 0 &&
    Number.isFinite(expectedPrice) && expectedPrice > 0 &&
    Math.abs(observedPrice - expectedPrice) < tolerance;
}

export function listingExecutionBlockReasons(listing: any): string[] {
  const reasons: string[] = [];
  if (listing?.offerActive !== true) reasons.push("oferta_inativa");
  if (listing?.buyable !== true) reasons.push("listing_nao_compravel");
  if (!String(listing?.productType || "").trim()) {
    reasons.push("product_type_ausente");
  }
  if (String(listing?.sellerFulfillmentType || "").toUpperCase() !== "AFN") {
    reasons.push("fulfillment_nao_confirmado_como_fba");
  }
  return reasons;
}

export function importedUnitCostError(item: any): string | null {
  if (!Object.prototype.hasOwnProperty.call(item || {}, "unit_cost")) {
    return "Custo unitário deve ser informado explicitamente.";
  }
  const value = item?.unit_cost;
  if (
    value === null || value === undefined || value === "" ||
    !Number.isFinite(Number(value)) || Number(value) <= 0
  ) return "Custo unitário deve ser um número maior que zero.";
  return null;
}

export function isOperationalConfirmedHistory(row: any): boolean {
  const before = Number(row?.price_before);
  const after = Number(row?.price_after);
  return row?.history_type === "price_confirmed" &&
    row?.status === "confirmed" &&
    Number.isFinite(before) && before > 0 &&
    Number.isFinite(after) && after > 0 &&
    Math.abs(after - before) >= 0.01 &&
    row?.amazon_response !== null && row?.amazon_response !== undefined;
}

export function dedupeOperationalConfirmedHistory(rows: any[]): any[] {
  const seen = new Set<string>();
  return rows.filter(isOperationalConfirmedHistory).filter((row) => {
    const day = dayKeyInTimeZone(row.changed_at) || "invalid-date";
    const sku = normalizeSku(
      row.normalized_sku || row.sku || row.asin || row.product_id || row.id,
    );
    const key = `${day}:${sku}`;
    if (!sku || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
