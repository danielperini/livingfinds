/**
 * Campaign nominal budgets are independent from the account's actual daily spend cap.
 * The account cap is enforced by AccountDailySpendController and the kill-switch;
 * it must never be confused with the sum of Amazon campaign budgets.
 */
export function campaignBudgetPolicy(settings:any={},legacy:any={}) {
 const rawMax=Number(settings.maximum_campaign_budget ?? legacy.maximum_campaign_budget ?? 150);
 const rawMin=Number(settings.minimum_campaign_budget ?? legacy.minimum_campaign_budget ?? 15);
 const allowRaw=settings.allow_campaign_budget_overcommit ?? legacy.allow_campaign_budget_overcommit;
 const allowNominalOvercommit=allowRaw === false ? false : true;
 return {
  maximumCampaignBudget:Number.isFinite(rawMax)&&rawMax>=15?rawMax:150,
  minimumCampaignBudget:Number.isFinite(rawMin)&&rawMin>=15?rawMin:15,
  allowNominalOvercommit,
 };
}
export function nominalBudgetHeadroom(settings:any,accountCap:number,nominalSum:number):number {
 return campaignBudgetPolicy(settings).allowNominalOvercommit ? Number.POSITIVE_INFINITY : Math.max(0,accountCap-nominalSum);
}
export function nominalBudgetExceedsLimit(settings:any,accountCap:number,nominalSum:number):boolean {
 return !campaignBudgetPolicy(settings).allowNominalOvercommit && nominalSum>accountCap;
}
