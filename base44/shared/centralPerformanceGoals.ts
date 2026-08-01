export type CentralGoalMode = 'BLOCKED' | 'DEFEND' | 'HOLD' | 'GROW';
const positive = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export function evaluateCentralGoals(input: {
  targetAcos: unknown; maximumAcos: unknown; targetRoas: unknown; targetTacos: unknown;
  maximumCpc: unknown; dailyBudget: unknown; acos: unknown; roas: unknown; tacos: unknown;
  cpc: unknown; spend: unknown; profitPositive?: boolean; dataComplete?: boolean;
}) {
  const targetAcos = positive(input.targetAcos) || 10;
  const maximumAcos = Math.max(targetAcos, positive(input.maximumAcos) || targetAcos);
  const configuredRoas = positive(input.targetRoas) || 0;
  const consistentRoas = 100 / targetAcos;
  const effectiveRoas = Math.max(configuredRoas, consistentRoas);
  const targetTacos = positive(input.targetTacos);
  const maximumCpc = positive(input.maximumCpc);
  const budget = positive(input.dailyBudget);
  const acos = positive(input.acos);
  const roas = positive(input.roas);
  const tacos = positive(input.tacos);
  const cpc = positive(input.cpc);
  const spend = Math.max(0, Number(input.spend) || 0);

  const reasons: string[] = [];
  if (configuredRoas > 0 && configuredRoas < consistentRoas) reasons.push('ROAS_TARGET_CONFLICTS_WITH_ACOS_TARGET');
  if (input.dataComplete === false) reasons.push('DATA_INCOMPLETE');
  if (input.profitPositive === false) reasons.push('PROFIT_NOT_POSITIVE');
  if (acos !== null && acos > maximumAcos) reasons.push('ACOS_ABOVE_MAXIMUM');
  if (maximumCpc !== null && cpc !== null && cpc > maximumCpc) reasons.push('CPC_ABOVE_MAXIMUM');
  if (targetTacos !== null && tacos !== null && tacos > targetTacos) reasons.push('TACOS_ABOVE_TARGET');
  if (budget !== null && spend >= budget) reasons.push('DAILY_BUDGET_REACHED');

  let mode: CentralGoalMode = 'HOLD';
  if (input.dataComplete === false || input.profitPositive === false) mode = 'BLOCKED';
  else if (reasons.some((reason) => ['ACOS_ABOVE_MAXIMUM', 'CPC_ABOVE_MAXIMUM', 'TACOS_ABOVE_TARGET', 'DAILY_BUDGET_REACHED'].includes(reason))) mode = 'DEFEND';
  else if (acos !== null && acos <= targetAcos && roas !== null && roas >= effectiveRoas && (targetTacos === null || tacos === null || tacos <= targetTacos)) mode = 'GROW';

  return {
    mode, reasons,
    effective: { targetAcos, maximumAcos, targetRoas: effectiveRoas, targetTacos, maximumCpc, dailyBudget: budget },
    permissions: {
      increaseBid: mode === 'GROW', topOfSearch: mode === 'GROW', createCampaign: mode === 'GROW',
      reactivateForGrowth: mode === 'GROW', minimumSafePresence: mode !== 'BLOCKED',
      reduceBid: mode === 'DEFEND' || mode === 'BLOCKED', pause: mode !== 'GROW',
      repriceForMargin: true, lowerPrice: mode === 'GROW',
    },
  };
}
