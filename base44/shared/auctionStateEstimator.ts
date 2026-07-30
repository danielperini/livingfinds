export type AuctionPressureState =
  | 'STABLE'
  | 'RISING'
  | 'FALLING'
  | 'PROBABLE_REGIME_CHANGE'
  | 'INSUFFICIENT_DATA';

type CpcObservation = {
  cpc?: number | null;
  spend?: number | null;
  clicks?: number | null;
  structuralChange?: boolean;
};

const finite = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const round = (value: number, decimals = 6): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/**
 * Filtro de Kalman local linear para nível e tendência de CPC.
 *
 * A saída nunca autoriza aumento por conta própria. Ela deve apenas limitar ou
 * bloquear exposição quando o CPC previsto ultrapassa o teto econômico.
 */
export function estimateCpcAuctionState(
  observations: CpcObservation[],
  options: {
    baseMeasurementNoise?: number;
    processNoiseLevel?: number;
    processNoiseTrend?: number;
  } = {},
) {
  const rows = (observations || [])
    .map(row => {
      const clicks = Math.max(0, finite(row.clicks));
      const cpc = finite(row.cpc) > 0
        ? finite(row.cpc)
        : clicks > 0
          ? Math.max(0, finite(row.spend)) / clicks
          : 0;
      return { ...row, clicks, cpc };
    })
    .filter(row => row.cpc > 0);

  if (rows.length < 3) {
    return {
      cpc_kalman_level: rows.at(-1)?.cpc || 0,
      cpc_kalman_trend: 0,
      predicted_cpc_next_window: rows.at(-1)?.cpc || 0,
      innovation: 0,
      innovation_z_score: 0,
      auction_pressure_state: 'INSUFFICIENT_DATA' as AuctionPressureState,
      observations: rows.length,
    };
  }

  const baseMeasurementNoise = Math.max(0.000001, options.baseMeasurementNoise ?? 0.04);
  const baseProcessLevel = Math.max(0.000001, options.processNoiseLevel ?? 0.0025);
  const baseProcessTrend = Math.max(0.000001, options.processNoiseTrend ?? 0.0005);

  let level = rows[0].cpc;
  let trend = 0;
  let p00 = 1;
  let p01 = 0;
  let p10 = 0;
  let p11 = 1;
  let innovation = 0;
  let innovationZ = 0;
  let consecutiveLargeInnovations = 0;

  for (let index = 1; index < rows.length; index++) {
    const row = rows[index];
    const processMultiplier = row.structuralChange ? 4 : 1;

    const predictedLevel = level + trend;
    const predictedTrend = trend;
    const pp00 = p00 + p01 + p10 + p11 + baseProcessLevel * processMultiplier;
    const pp01 = p01 + p11;
    const pp10 = p10 + p11;
    const pp11 = p11 + baseProcessTrend * processMultiplier;

    const measurementNoise = baseMeasurementNoise / Math.max(1, row.clicks);
    innovation = row.cpc - predictedLevel;
    const innovationVariance = Math.max(0.000001, pp00 + measurementNoise);
    innovationZ = innovation / Math.sqrt(innovationVariance);
    consecutiveLargeInnovations = Math.abs(innovationZ) >= 2
      ? consecutiveLargeInnovations + 1
      : 0;

    const k0 = pp00 / innovationVariance;
    const k1 = pp10 / innovationVariance;
    level = predictedLevel + k0 * innovation;
    trend = predictedTrend + k1 * innovation;

    p00 = (1 - k0) * pp00;
    p01 = (1 - k0) * pp01;
    p10 = pp10 - k1 * pp00;
    p11 = pp11 - k1 * pp01;
  }

  const predicted = Math.max(0, level + trend);
  const relativeTrend = level > 0 ? trend / level : 0;
  const state: AuctionPressureState = consecutiveLargeInnovations >= 2
    ? 'PROBABLE_REGIME_CHANGE'
    : relativeTrend >= 0.05
      ? 'RISING'
      : relativeTrend <= -0.05
        ? 'FALLING'
        : 'STABLE';

  return {
    cpc_kalman_level: round(level),
    cpc_kalman_trend: round(trend),
    predicted_cpc_next_window: round(predicted),
    innovation: round(innovation),
    innovation_z_score: round(innovationZ),
    auction_pressure_state: state,
    observations: rows.length,
  };
}
