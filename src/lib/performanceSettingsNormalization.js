const finiteNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const positiveNumber = (value) => {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
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
  // ACoS and ROAS are separate desired goals. Derive only when the field was
  // absent in legacy data; never overwrite a deliberately configured value.
  const hasAcos = Object.prototype.hasOwnProperty.call(settings, 'target_acos')
    && finiteNumber(settings.target_acos) !== null;
  const hasRoas = Object.prototype.hasOwnProperty.call(settings, 'target_roas')
    && finiteNumber(settings.target_roas) !== null;
  const fallbackAcos = finiteNumber(defaults.target_acos);
  const fallbackRoas = finiteNumber(defaults.target_roas);
  const targetAcos = hasAcos
    ? finiteNumber(settings.target_acos)
    : hasRoas
      ? deriveAcosFromRoas(settings.target_roas)
      : fallbackAcos ?? (fallbackRoas !== null ? deriveAcosFromRoas(fallbackRoas) : null);
  const targetRoas = hasRoas
    ? finiteNumber(settings.target_roas)
    : hasAcos
      ? deriveRoasFromAcos(settings.target_acos)
      : fallbackRoas ?? (fallbackAcos !== null ? deriveRoasFromAcos(fallbackAcos) : null);
  const bidCeiling = resolveUnifiedBidCeiling(
    settings,
    defaults.max_bid ?? defaults.max_cpc ?? 5,
  );
  const configuredMinBid = finiteNumber(merged.min_bid);
  const minBid = configuredMinBid === null ? null : Math.min(configuredMinBid, bidCeiling);

  return {
    ...merged,
    target_acos: targetAcos,
    target_roas: targetRoas,
    // Desired targets remain distinct from hard limits. Conflicts are surfaced
    // by the shared resolver instead of silently rewriting the user's values.
    max_acos: finiteNumber(merged.max_acos),
    target_tacos: finiteNumber(merged.target_tacos),
    max_tacos: finiteNumber(merged.max_tacos),
    target_cpc: finiteNumber(merged.target_cpc),
    target_cost_per_order: finiteNumber(merged.target_cost_per_order),
    growth_efficiency_target: finiteNumber(merged.growth_efficiency_target),
    target_daily_impressions: finiteNumber(merged.target_daily_impressions),
    target_coverage_hours: finiteNumber(merged.target_coverage_hours),
    max_bid: bidCeiling,
    max_cpc: finiteNumber(merged.max_cpc) ?? bidCeiling,
    min_bid: minBid,
  };
}

export function updateEfficiencyGoal(settings, field, value) {
  if (field !== 'target_acos' && field !== 'target_roas') return settings;
  const parsed = finiteNumber(value);
  return { ...settings, [field]: parsed };
}

export function updateUnifiedBidCeiling(settings, value) {
  const bidCeiling = Math.max(0.02, Number(value) || 0.02);
  const targetCpc = finiteNumber(settings?.target_cpc);
  const coherentTargetCpc = targetCpc === null ? null : Math.min(targetCpc, bidCeiling);
  return {
    ...settings,
    max_bid: round(bidCeiling, 2),
    max_cpc: round(bidCeiling, 2),
    min_bid: Math.min(Number(settings?.min_bid) || 0.02, bidCeiling),
    target_cpc: coherentTargetCpc,
  };
}

