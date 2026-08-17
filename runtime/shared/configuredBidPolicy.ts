import { AMAZON_BID_CEILING_BRL } from './amazonBidCeiling.ts';

const positive = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export type ConfiguredBidPolicy = {
  minBid: number;
  maxBid: number;
  maxCpc: number | null;
  ceiling: number;
  cpcEnforced: boolean;
  source: string;
};

/**
 * Resolve o teto operacional exclusivamente a partir da configuração salva.
 * Quando CPC máximo estiver preenchido, ele funciona como segundo guardrail e
 * prevalece se for menor que o Bid máximo.
 */
export function resolveConfiguredBidPolicy(
  settings: any,
  fallbackCeiling = AMAZON_BID_CEILING_BRL,
): ConfiguredBidPolicy {
  const fallback = positive(fallbackCeiling) || AMAZON_BID_CEILING_BRL;
  const maxBid = positive(settings?.max_bid) || fallback;
  const maxCpc = positive(settings?.max_cpc ?? settings?.maximum_cpc);
  const cpcEnforced = maxCpc != null;
  const ceiling = Math.round(Math.max(0.02, Math.min(maxBid, cpcEnforced ? maxCpc : maxBid)) * 100) / 100;
  const requestedMinBid = positive(settings?.min_bid) || 0.02;
  const minBid = Math.round(Math.min(requestedMinBid, ceiling) * 100) / 100;

  return {
    minBid,
    maxBid: Math.round(maxBid * 100) / 100,
    maxCpc: maxCpc == null ? null : Math.round(maxCpc * 100) / 100,
    ceiling,
    cpcEnforced,
    source: String(settings?.source || settings?._settings_source || 'system_defaults'),
  };
}

export function clampBidToConfiguredPolicy(value: unknown, policy: ConfiguredBidPolicy): number | unknown {
  const bid = Number(value);
  if (!Number.isFinite(bid) || bid <= 0) return value;
  return Math.round(Math.min(bid, policy.ceiling) * 100) / 100;
}

/** Carrega a mesma fonte exibida em Configurações, com fallback de migração. */
export async function loadConfiguredBidPolicy(
  base44: any,
  amazonAccountId: string,
  fallbackCeiling = AMAZON_BID_CEILING_BRL,
): Promise<ConfiguredBidPolicy> {
  const [performanceRows, autopilotRows] = await Promise.all([
    base44.asServiceRole.entities.PerformanceSettings.filter(
      { amazon_account_id: amazonAccountId }, '-updated_at', 1,
    ).catch(() => []),
    base44.asServiceRole.entities.AutopilotConfig.filter(
      { amazon_account_id: amazonAccountId }, '-updated_at', 1,
    ).catch(() => []),
  ]);

  const performance = performanceRows[0];
  if (performance) {
    return resolveConfiguredBidPolicy({ ...performance, source: 'PerformanceSettings' }, fallbackCeiling);
  }

  const autopilot = autopilotRows[0];
  if (autopilot) {
    return resolveConfiguredBidPolicy({ ...autopilot, source: 'AutopilotConfig' }, fallbackCeiling);
  }

  return resolveConfiguredBidPolicy({ source: 'system_defaults' }, fallbackCeiling);
}
