import { clamp, numberValue, roundMoney } from './profitGuardPolicy.ts';

export const LOW_VOLUME_MAX_DAILY_ORDERS = 1;
// Sponsored Products BR rejeita budgets abaixo do piso operacional observado.
// O teto econômico menor continua sendo imposto pelo bid e pelo governador intradiário.
export const LOW_VOLUME_AMAZON_MIN_BUDGET_BRL = 5;

export function isPriorityLowVolumeProduct(product: any): boolean {
  const text = String(product?.product_name || product?.title || product?.name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return /moedor/.test(text) || /organizador.*(mala|bagagem)|(?:mala|bagagem).*organizador/.test(text) ||
    /ventilador/.test(text) || (/lixeira/.test(text) && /(cinza|13\s*l(?:itros?)?)/.test(text));
}

export function calculateLowVolumeDailyPlan(input: {
  sales: unknown;
  orders: unknown;
  spend: unknown;
  sampleDays: unknown;
  targetAcos: unknown;
  profitBeforeAdsPerUnit: unknown;
  safeMaxCpc: unknown;
  targetCpc?: unknown;
  accountCampaignShareCap: unknown;
  currentBudget?: unknown;
}) {
  const sales = Math.max(0, numberValue(input.sales));
  const orders = Math.max(0, numberValue(input.orders));
  const spend = Math.max(0, numberValue(input.spend));
  const sampleDays = clamp(Math.floor(numberValue(input.sampleDays, 14)), 1, 30);
  const dailySales = sales / sampleDays;
  const dailyOrders = orders / sampleDays;
  const targetAcos = clamp(numberValue(input.targetAcos, 10), 1, 100);
  const profitPerUnit = Math.max(0, numberValue(input.profitBeforeAdsPerUnit));
  const safeMaxCpc = Math.max(0, numberValue(input.safeMaxCpc));
  const targetCpc = Math.max(0, numberValue(input.targetCpc));
  const accountShareCap = Math.max(LOW_VOLUME_AMAZON_MIN_BUDGET_BRL, numberValue(input.accountCampaignShareCap, 1));

  // Com vendas, o menor dos três limites protege receita, ACoS e margem.
  // Sem vendas suficientes, a presença fica no piso Amazon e o bid assume o controle do risco.
  const salesAcosCap = dailySales > 0 ? dailySales * (targetAcos / 100) : 0;
  const contributionCap = dailyOrders > 0 && profitPerUnit > 0 ? dailyOrders * profitPerUnit * 0.8 : 0;
  const revenueCap = dailySales;
  const provenSalesCaps = [salesAcosCap, contributionCap, revenueCap, accountShareCap].filter((value) => value > 0);
  const learningCandidates = [
    profitPerUnit > 0 ? profitPerUnit * 0.10 : 0,
    safeMaxCpc > 0 ? safeMaxCpc * 2 : 0,
    accountShareCap,
  ].filter((value) => value > 0);
  const calculatedSpendCap = sales > 0 && orders > 0
    ? Math.min(...provenSalesCaps)
    : Math.min(LOW_VOLUME_AMAZON_MIN_BUDGET_BRL, ...learningCandidates);
  const amazonBudgetFloorApplied = calculatedSpendCap < LOW_VOLUME_AMAZON_MIN_BUDGET_BRL;
  const rawBudget = Math.max(LOW_VOLUME_AMAZON_MIN_BUDGET_BRL, calculatedSpendCap);
  const currentBudget = Math.max(0, numberValue(input.currentBudget));
  const dailyBudget = roundMoney(Math.max(LOW_VOLUME_AMAZON_MIN_BUDGET_BRL,
    Math.min(rawBudget, currentBudget > 0 ? currentBudget : rawBudget, accountShareCap)));

  const maximumDailyLoss = profitPerUnit > 0
    ? roundMoney(Math.max(0, dailyBudget - dailyOrders * profitPerUnit))
    : roundMoney(dailyBudget);
  const cpcCandidates = [safeMaxCpc, targetCpc, calculatedSpendCap / 4, 1].filter((value) => value > 0);
  const targetBid = roundMoney(clamp(Math.min(...cpcCandidates), 0.02, 1));
  const acos = sales > 0 ? roundMoney(spend / sales * 100) : null;

  return {
    strategy: 'AUTO_LOW_VOLUME_PROFIT_GUARD',
    lowVolume: orders > 0 && dailyOrders <= LOW_VOLUME_MAX_DAILY_ORDERS,
    dailyBudget,
    calculatedSpendCap: roundMoney(calculatedSpendCap),
    maximumDailyLoss,
    targetBid,
    amazonBudgetFloorApplied,
    dailySales: roundMoney(dailySales),
    dailyOrders: roundMoney(dailyOrders),
    targetAcos: roundMoney(targetAcos),
    acos,
    guardrails: ['spend_not_above_revenue', 'target_acos', 'contribution_margin', 'account_daily_cap'],
  };
}
