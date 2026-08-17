export type DailyDemandSample = {
  date: string;
  units: number;
  price?: number | null;
  stockAvailable?: boolean | null;
  stockQty?: number | null;
  adsSpend?: number | null;
};

export type DemandForecast = {
  status: 'OK' | 'INSUFFICIENT_DATA';
  predicted1d: number | null;
  predicted3d: number | null;
  predicted7d: number | null;
  predicted14d: number | null;
  low: number | null;
  median: number | null;
  high: number | null;
  confidence: number;
  observations: number;
  method: string;
};

export type ElasticityPoint = {
  date: string;
  price: number;
  units: number;
  stockAvailable?: boolean | null;
  stockQty?: number | null;
  adsSpend?: number | null;
};

export type ElasticityEstimate = {
  status: 'INELASTIC' | 'UNIT_ELASTIC' | 'ELASTIC' | 'INSUFFICIENT_DATA';
  elasticity: number | null;
  confidence: number;
  observations: number;
  rejected: number;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number, digits = 4) => {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};
const finite = (value: unknown): value is number => Number.isFinite(Number(value));
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

function logGamma(value: number): number {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  let x = 0.99999999999980993;
  const z = value - 1;
  for (let i = 0; i < coefficients.length; i += 1) x += coefficients[i] / (z + i + 1);
  const t = z + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const maxIterations = 200;
  const epsilon = 3e-12;
  const fpMin = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < fpMin) d = fpMin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIterations; m += 1) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpMin) d = fpMin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpMin) c = fpMin;
    d = 1 / d;
    h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpMin) d = fpMin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpMin) c = fpMin;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return h;
}

export function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (a <= 0 || b <= 0) return Number.NaN;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? front * betaContinuedFraction(a, b, x) / a
    : 1 - front * betaContinuedFraction(b, a, 1 - x) / b;
}

export function betaQuantile(probability: number, a: number, b: number): number {
  if (probability <= 0) return 0;
  if (probability >= 1) return 1;
  let low = 0;
  let high = 1;
  for (let i = 0; i < 70; i += 1) {
    const middle = (low + high) / 2;
    if (regularizedBeta(middle, a, b) < probability) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

export function estimateBayesianConversion(params: {
  clicks: number;
  orders: number;
  priorAlpha?: number;
  priorBeta?: number;
  confidenceLevel?: number;
  sustainableThreshold?: number;
}) {
  const clicks = Math.max(0, Math.floor(Number(params.clicks) || 0));
  const orders = clamp(Math.floor(Number(params.orders) || 0), 0, clicks);
  const priorAlpha = Math.max(0.01, Number(params.priorAlpha ?? 1));
  const priorBeta = Math.max(0.01, Number(params.priorBeta ?? 19));
  const confidenceLevel = clamp(Number(params.confidenceLevel ?? 0.95), 0.50, 0.999);
  const alpha = priorAlpha + orders;
  const beta = priorBeta + clicks - orders;
  const tail = (1 - confidenceLevel) / 2;
  const threshold = clamp(Number(params.sustainableThreshold ?? 0.05), 0, 1);
  return {
    posteriorAlpha: round(alpha),
    posteriorBeta: round(beta),
    mean: round(alpha / (alpha + beta), 6),
    lower: round(betaQuantile(tail, alpha, beta), 6),
    upper: round(betaQuantile(1 - tail, alpha, beta), 6),
    probabilityAboveThreshold: round(1 - regularizedBeta(threshold, alpha, beta), 6),
    observations: clicks,
    prior: { alpha: priorAlpha, beta: priorBeta },
    modelVersion: 'beta-binomial-v1',
  };
}

export function probabilityAtLeastOneSale(conversionRate: number, projectedClicks: number): number {
  const rate = clamp(Number(conversionRate) || 0, 0, 1);
  const clicks = Math.max(0, Number(projectedClicks) || 0);
  return round(1 - (1 - rate) ** clicks, 6);
}

export function calculateEconomicCpc(params: {
  conversionRate: number;
  conversionLowerBound: number;
  allowableAdSpendPerOrder: number;
  safetyFactor?: number;
}) {
  const allowable = Math.max(0, Number(params.allowableAdSpendPerOrder) || 0);
  const maximumEconomicCpc = clamp(Number(params.conversionRate) || 0, 0, 1) * allowable;
  const safeMaxCpc = clamp(Number(params.conversionLowerBound) || 0, 0, 1) * allowable * clamp(Number(params.safetyFactor ?? 0.85), 0, 1);
  return { maximumEconomicCpc: round(maximumEconomicCpc), safeMaxCpc: round(Math.min(maximumEconomicCpc, safeMaxCpc)) };
}

export function forecastDemand(samples: DailyDemandSample[], asOfDate = new Date().toISOString().slice(0, 10)): DemandForecast {
  const sorted = samples
    .filter((sample) => sample.date && finite(sample.units) && Number(sample.units) >= 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-65);
  const valid = sorted.filter((sample) => sample.stockAvailable !== false && !(finite(sample.stockQty) && Number(sample.stockQty) <= 0));
  if (valid.length < 7) {
    return { status: 'INSUFFICIENT_DATA', predicted1d: null, predicted3d: null, predicted7d: null, predicted14d: null, low: null, median: null, high: null, confidence: 0, observations: valid.length, method: 'weighted-moving-average+exponential-smoothing+dow' };
  }
  const units = valid.map((sample) => Number(sample.units));
  const recent = units.slice(-7);
  const weightTotal = recent.reduce((sum, _value, index) => sum + index + 1, 0);
  const weightedAverage = recent.reduce((sum, value, index) => sum + value * (index + 1), 0) / weightTotal;
  let smoothed = units[0];
  for (const value of units.slice(1)) smoothed = 0.35 * value + 0.65 * smoothed;
  const lastThree = average(units.slice(-3));
  const previousThree = average(units.slice(-6, -3));
  const rawTrend = (lastThree - previousThree) / 3;
  const trend = clamp(rawTrend, -Math.max(0.25, weightedAverage * 0.25), Math.max(0.25, weightedAverage * 0.25));
  const asOf = new Date(`${asOfDate}T12:00:00Z`);
  const weekdayValues = valid.filter((sample) => new Date(`${sample.date}T12:00:00Z`).getUTCDay() === asOf.getUTCDay()).map((sample) => Number(sample.units));
  const weekday = weekdayValues.length >= 2 ? average(weekdayValues) : weightedAverage;
  const base = Math.max(0, weightedAverage * 0.45 + smoothed * 0.35 + weekday * 0.20);
  const predictTotal = (days: number) => {
    let total = 0;
    for (let day = 1; day <= days; day += 1) total += Math.max(0, base + trend * day);
    return round(total, 2);
  };
  const residuals = units.slice(-30).map((value) => value - base);
  const standardDeviation = Math.sqrt(average(residuals.map((value) => value ** 2)));
  const median7 = predictTotal(7);
  const interval = 1.64 * standardDeviation * Math.sqrt(7);
  const excludedShare = sorted.length ? (sorted.length - valid.length) / sorted.length : 0;
  const confidence = round(clamp(valid.length / 30, 0, 1) * (1 - excludedShare * 0.5), 4);
  return {
    status: 'OK',
    predicted1d: predictTotal(1), predicted3d: predictTotal(3), predicted7d: median7, predicted14d: predictTotal(14),
    low: round(Math.max(0, median7 - interval), 2), median: median7, high: round(median7 + interval, 2),
    confidence, observations: valid.length, method: 'weighted-moving-average+exponential-smoothing+dow',
  };
}

export function estimateCanonicalElasticity(points: ElasticityPoint[]): ElasticityEstimate {
  const sorted = points
    .filter((point) => point.date && finite(point.price) && point.price > 0 && finite(point.units) && point.units > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .filter((point) => point.stockAvailable !== false && !(finite(point.stockQty) && Number(point.stockQty) <= 0))
    .slice(-20);
  if (sorted.length < 3) return { status: 'INSUFFICIENT_DATA', elasticity: null, confidence: 0, observations: 0, rejected: points.length - sorted.length };
  const estimates: number[] = [];
  let rejected = points.length - sorted.length;
  for (let i = 1; i < sorted.length; i += 1) {
    const before = sorted[i - 1];
    const after = sorted[i];
    const priceChange = (after.price - before.price) / before.price;
    const unitsChange = (after.units - before.units) / before.units;
    if (Math.abs(priceChange) < 0.01) { rejected += 1; continue; }
    const beforeAds = Number(before.adsSpend || 0);
    const afterAds = Number(after.adsSpend || 0);
    if ((beforeAds === 0) !== (afterAds === 0)) { rejected += 1; continue; }
    if (beforeAds > 0) {
      const adsRatio = afterAds / beforeAds;
      if (adsRatio < 0.5 || adsRatio > 2) { rejected += 1; continue; }
    }
    const estimate = -(unitsChange / priceChange);
    if (!Number.isFinite(estimate) || estimate <= 0 || estimate > 5) { rejected += 1; continue; }
    estimates.push(estimate);
  }
  const value = median(estimates);
  if (value === null || estimates.length < 2) return { status: 'INSUFFICIENT_DATA', elasticity: null, confidence: 0, observations: estimates.length, rejected };
  const absolute = Math.abs(value);
  const status = absolute < 0.8 ? 'INELASTIC' : absolute <= 1.2 ? 'UNIT_ELASTIC' : 'ELASTIC';
  return { status, elasticity: round(absolute), confidence: round(Math.min(1, estimates.length / 5)), observations: estimates.length, rejected };
}

export function simulateProfitCurve(params: {
  currentPrice: number;
  economicFloor: number;
  variableCostPerUnit: number;
  referralFeePct?: number;
  salesTaxPct?: number;
  baselineDailyUnits: number;
  adsSpendPerDay: number;
  elasticity: ElasticityEstimate;
  maximumChangePct?: number;
}) {
  const currentPrice = Math.max(0, Number(params.currentPrice) || 0);
  if (currentPrice <= 0 || params.variableCostPerUnit < 0) return { status: 'INSUFFICIENT_DATA' as const, candidates: [], best: null };
  const maximumChange = Math.min(0.02, Math.max(0, Number(params.maximumChangePct ?? 0.02)));
  const changes = params.elasticity.status === 'INSUFFICIENT_DATA' ? [0] : [-0.02, -0.01, 0, 0.01, 0.02].filter((change) => Math.abs(change) <= maximumChange + 1e-9);
  const elasticity = params.elasticity.elasticity || 0;
  const candidates = changes.map((change) => {
    const price = round(currentPrice * (1 + change), 2);
    const demand = change === 0 || elasticity <= 0
      ? Math.max(0, params.baselineDailyUnits)
      : Math.max(0, params.baselineDailyUnits * (price / currentPrice) ** (-elasticity));
    const proportionalFees = price * ((Number(params.referralFeePct || 0) + Number(params.salesTaxPct || 0)) / 100);
    const unitProfit = price - params.variableCostPerUnit - proportionalFees;
    const expectedProfit = demand * unitProfit - Math.max(0, params.adsSpendPerDay);
    return {
      changePct: round(change), price, demand: round(demand, 3), revenue: round(demand * price, 2),
      unitProfit: round(unitProfit, 2), expectedProfit: round(expectedProfit, 2),
      allowed: price >= params.economicFloor && unitProfit > 0,
    };
  });
  const allowed = candidates.filter((candidate) => candidate.allowed);
  const best = allowed.sort((a, b) => b.expectedProfit - a.expectedProfit)[0] || null;
  return { status: params.elasticity.status === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT_DATA' as const : 'OK' as const, candidates, best };
}

function seededRandom(seed: string) {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i += 1) state = Math.imul(state ^ seed.charCodeAt(i), 16777619);
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function sampleGamma(shape: number, random: () => number): number {
  if (shape < 1) return sampleGamma(shape + 1, random) * random() ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number;
    let v: number;
    do {
      const u1 = Math.max(random(), 1e-12);
      const u2 = random();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v **= 3;
    const u = random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x ** 2 + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function rankThompsonBidArms(params: {
  seed: string;
  currentBid: number;
  safeMaxCpc: number;
  posteriorAlpha: number;
  posteriorBeta: number;
  allowableAdSpendPerOrder: number;
  projectedClicks: number;
  inStock: boolean;
  defensive: boolean;
  winnerProtected: boolean;
  cooldownActive: boolean;
}) {
  if (!params.inStock || params.defensive || params.winnerProtected || params.cooldownActive || params.currentBid <= 0 || params.safeMaxCpc <= 0) {
    return { eligible: false, reason: 'GOVERNANCE_BLOCK', arms: [] };
  }
  const random = seededRandom(params.seed);
  const alphaSample = sampleGamma(Math.max(0.01, params.posteriorAlpha), random);
  const betaSample = sampleGamma(Math.max(0.01, params.posteriorBeta), random);
  const sampledCvr = alphaSample / (alphaSample + betaSample);
  const arms = [-0.05, 0, 0.03, 0.05].map((changePct) => {
    const bid = round(params.currentBid * (1 + changePct), 2);
    const allowed = bid <= params.safeMaxCpc && (changePct <= 0 || bid > params.currentBid);
    const expectedOrders = sampledCvr * params.projectedClicks;
    const reward = expectedOrders * params.allowableAdSpendPerOrder - bid * params.projectedClicks;
    return { changePct, bid, sampledCvr: round(sampledCvr, 6), reward: round(reward, 4), allowed };
  }).filter((arm) => arm.allowed).sort((a, b) => b.reward - a.reward);
  return { eligible: arms.length > 0, reason: arms.length ? 'THOMPSON_PRIORITY_ONLY' : 'SAFE_CPC_BLOCK', arms };
}
