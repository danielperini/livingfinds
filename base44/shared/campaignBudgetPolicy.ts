/** Campaign nominal budgets are independent from the account's actual daily spend cap. */
export function campaignBudgetPolicy(settings:any={},legacy:any={}) {
 const raw=Number(settings.maximum_campaign_budget ?? legacy.maximum_campaign_budget ?? 15);
 return {maximumCampaignBudget:Number.isFinite(raw)&&raw>=1?raw:15,allowNominalOvercommit:settings.allow_campaign_budget_overcommit===true};
}
export function nominalBudgetHeadroom(settings:any,accountCap:number,nominalSum:number):number {
 return settings?.allow_campaign_budget_overcommit===true ? Number.POSITIVE_INFINITY : Math.max(0,accountCap-nominalSum);
}
export function nominalBudgetExceedsLimit(settings:any,accountCap:number,nominalSum:number):boolean {
 return settings?.allow_campaign_budget_overcommit!==true && nominalSum>accountCap;
}
