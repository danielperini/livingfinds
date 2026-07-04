const DAY_MS = 86400000;

export const MIN_BUDGET_CONFIDENCE = 85;

function n(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function evaluateDailyBudgetPolicy({
  dailyEntries = [],
  activeCampaignBudget = 0,
  aiSuggested = 0,
  aiConfidence = 0,
  aiIsValid = false,
}) {
  const daysWithData = dailyEntries.length;
  const totalSpend = dailyEntries.reduce((sum, [, spend]) => sum + n(spend), 0);
  const averageSpend = daysWithData > 0 ? totalSpend / daysWithData : 0;
  const latestSpend = dailyEntries.length ? n(dailyEntries[dailyEntries.length - 1][1]) : 0;

  const historicalBase = averageSpend > 0 ? averageSpend * 1.3 : 0;
  const operationalFloor = n(activeCampaignBudget);
  const validAIValue = aiIsValid && n(aiConfidence) >= MIN_BUDGET_CONFIDENCE ? n(aiSuggested) : 0;
  const base = Math.max(historicalBase, operationalFloor, validAIValue);

  const lastThree = dailyEntries.slice(-3);
  const hadThreeLowUsageDays = lastThree.length === 3 && base > 0 && lastThree.every(([, spend]) => n(spend) <= base * 0.75);
  const reachedDailyLimit = base > 0 && latestSpend >= base * 0.98;

  let suggested = base;
  let rule = 'base';

  if (reachedDailyLimit) {
    suggested = Math.max(base * 1.15, latestSpend * 1.3);
    rule = 'increase_next_day';
  } else if (hadThreeLowUsageDays) {
    suggested = Math.max(operationalFloor, base * 0.75);
    rule = 'reduce_25_after_three_days';
  }

  const confidence = Math.min(
    99,
    Math.max(
      MIN_BUDGET_CONFIDENCE,
      aiIsValid ? n(aiConfidence) : Math.round(85 + Math.min(10, daysWithData / 3))
    )
  );

  const nextEffectiveAt = new Date(Date.now() + DAY_MS);
  nextEffectiveAt.setHours(0, 1, 0, 0);

  return {
    suggestedBudget: Number(Math.max(0, suggested).toFixed(2)),
    confidence,
    averageSpend,
    latestSpend,
    operationalFloor,
    reachedDailyLimit,
    hadThreeLowUsageDays,
    rule,
    nextEffectiveAt: nextEffectiveAt.toISOString(),
  };
}
