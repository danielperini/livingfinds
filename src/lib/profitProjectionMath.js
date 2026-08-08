const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

export function quantile(values, probability) {
  const sorted = values.map(finite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * Math.min(1, Math.max(0, probability));
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

export function median(values) { return quantile(values, 0.5); }

function theilSenSlope(values) {
  const slopes = [];
  for (let right = 1; right < values.length; right += 1) {
    for (let left = 0; left < right; left += 1) slopes.push((values[right] - values[left]) / (right - left));
  }
  return median(slopes);
}

function holt(values, alpha = 0.3, beta = 0.12) {
  if (!values.length) return { level: 0, trend: 0 };
  let level = values[0];
  let trend = values.length > 1 ? values[1] - values[0] : 0;
  for (let i = 1; i < values.length; i += 1) {
    const previousLevel = level;
    level = alpha * values[i] + (1 - alpha) * (level + trend);
    trend = beta * (level - previousLevel) + (1 - beta) * trend;
  }
  return { level, trend };
}

/**
 * Forecast probabilístico para lucro diário. Mantém o modelo auditável:
 * - Holt linear captura nível e aceleração recente;
 * - Theil-Sen reduz influência de dias atípicos;
 * - sazonalidade semanal vem dos resíduos por dia da semana;
 * - P10/P50/P90 usam quantis empíricos dos resíduos históricos.
 */
export function projectProfitSeries(points, horizon = 30) {
  const ordered = [...points]
    .filter((point) => point?.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const values = ordered.map((point) => finite(point.profit));
  if (values.length < 2) return { ready: false, points: [], p10: 0, p50: 0, p90: 0, diagnostics: {} };

  const fitted = holt(values);
  const robustTrend = theilSenSlope(values);
  const trend = 0.65 * fitted.trend + 0.35 * robustTrend;
  const weekdayResiduals = Array.from({ length: 7 }, () => []);
  const rawResiduals = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const weekday = new Date(`${ordered[index].date}T12:00:00Z`).getUTCDay();
    const baseline = fitted.level + trend * (index - ordered.length + 1);
    weekdayResiduals[weekday].push(values[index] - baseline);
  }
  const weekdayEffects = weekdayResiduals.map((residuals) => residuals.length ? median(residuals) : 0);
  for (let index = 0; index < ordered.length; index += 1) {
    const weekday = new Date(`${ordered[index].date}T12:00:00Z`).getUTCDay();
    const baseline = fitted.level + trend * (index - ordered.length + 1) + weekdayEffects[weekday];
    rawResiduals.push(values[index] - baseline);
  }
  const residualP10 = quantile(rawResiduals, 0.1);
  const residualP50 = quantile(rawResiduals, 0.5);
  const residualP90 = quantile(rawResiduals, 0.9);
  const lastDate = new Date(`${ordered[ordered.length - 1].date}T12:00:00Z`);
  const forecast = Array.from({ length: horizon }, (_, index) => {
    const date = new Date(lastDate);
    date.setUTCDate(date.getUTCDate() + index + 1);
    const weekday = date.getUTCDay();
    const baseline = fitted.level + trend * (index + 1) + weekdayEffects[weekday];
    return { date: date.toISOString().slice(0, 10), p10: baseline + residualP10, p50: baseline + residualP50, p90: baseline + residualP90 };
  });
  const sum = (field) => forecast.reduce((total, point) => total + point[field], 0);
  const residualScale = Math.max(1, Math.abs(residualP90 - residualP10));
  const signalScale = Math.max(1, Math.abs(fitted.level));
  const confidence = Math.max(0, Math.min(100, Math.round((Math.min(90, values.length) / 90) * 65 + Math.max(0, 35 - residualScale / signalScale * 35))));
  return {
    ready: values.length >= 30,
    points: forecast,
    p10: sum('p10'), p50: sum('p50'), p90: sum('p90'),
    diagnostics: { observations: values.length, holtLevel: fitted.level, trendPerDay: trend, residualP10, residualP90, confidence },
  };
}
