const positiveNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const round = (value, decimals = 2) => {
  const factor = 10 ** decimals;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};

export function deriveRoasFromAcos(targetAcos) {
  const acos = positiveNumber(targetAcos);
  return acos == null ? 0 : round(100 / acos, 2);
}

export function deriveAcosFromRoas(targetRoas) {
  const roas = positiveNumber(targetRoas);
  return roas == null ? 0 : round(100 / roas, 2);
}

export function resolveUnifiedBidCeiling(settings, fallback = 5) {
  const fallbackValue = positiveNumber(fallback) || 5;
  const configured = [settings?.max_bid, settings?.max_cpc]
    .map(positiveNumber)
    .filter((value) => value != null);
  return round(configured.length ? Math.min(...configured) : fallbackValue, 2);
}

/**
 * Converte os campos legados em uma única configuração coerente.
 * target_acos é a fonte canônica quando os dois campos antigos existem.
 */
export function normalizePerformanceSettings(settings = {}, defaults = {}) {
  const merged = { ...defaults, ...settings };
  const targetAcos = positiveNumber(settings.target_acos)
    || deriveAcosFromRoas(settings.target_roas)
    || positiveNumber(defaults.target_acos)
    || deriveAcosFromRoas(defaults.target_roas);
  const targetRoas = deriveRoasFromAcos(targetAcos);
  const bidCeiling = resolveUnifiedBidCeiling(
    settings,
    defaults.max_bid ?? defaults.max_cpc ?? 5,
  );
  const minBid = positiveNumber(merged.min_bid);
  const targetCpc = positiveNumber(merged.target_cpc);
  const maxAcos = positiveNumber(merged.max_acos);
  const targetTacos = positiveNumber(merged.target_tacos);
  const maxTacos = positiveNumber(merged.max_tacos);

  return {
    ...merged,
    target_acos: targetAcos || 0,
    target_roas: targetRoas || 0,
    max_acos: maxAcos == null ? merged.max_acos : round(Math.max(maxAcos, targetAcos || 0), 2),
    target_tacos: targetTacos == null ? merged.target_tacos : round(targetTacos, 2),
    max_tacos: maxTacos == null ? merged.max_tacos : round(Math.max(maxTacos, targetTacos || 0), 2),
    target_cpc: targetCpc == null ? merged.target_cpc : round(Math.min(targetCpc, bidCeiling), 2),
    min_bid: minBid == null ? merged.min_bid : round(Math.min(minBid, bidCeiling), 2),
    max_bid: bidCeiling,
    max_cpc: bidCeiling,
  };
}

export function updateEfficiencyGoal(settings, field, value) {
  if (field === 'target_roas') {
    const targetRoas = Number(value) || 0;
    return {
      ...settings,
      target_roas: targetRoas,
      target_acos: deriveAcosFromRoas(targetRoas),
    };
  }

  const targetAcos = Number(value) || 0;
  return {
    ...settings,
    target_acos: targetAcos,
    target_roas: deriveRoasFromAcos(targetAcos),
  };
}

export function updateUnifiedBidCeiling(settings, value) {
  const bidCeiling = Math.max(0.02, Number(value) || 0.02);
  return {
    ...settings,
    max_bid: round(bidCeiling, 2),
    max_cpc: round(bidCeiling, 2),
    min_bid: Math.min(Number(settings?.min_bid) || 0.02, bidCeiling),
    target_cpc: positiveNumber(settings?.target_cpc) == null
      ? settings?.target_cpc
      : round(Math.min(Number(settings.target_cpc), bidCeiling), 2),
  };
}

