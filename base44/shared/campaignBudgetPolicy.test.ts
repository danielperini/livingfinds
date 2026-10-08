import {assertEquals} from 'jsr:@std/assert';
import {campaignBudgetPolicy,nominalBudgetHeadroom,nominalBudgetExceedsLimit} from './campaignBudgetPolicy.ts';
Deno.test('nominal sum may exceed account spend cap without changing it',()=>{
 const s={daily_budget_limit:100,maximum_campaign_budget:150,allow_campaign_budget_overcommit:true};
 assertEquals(campaignBudgetPolicy(s).maximumCampaignBudget,150);
 assertEquals(nominalBudgetHeadroom(s,100,2000),Infinity);
 assertEquals(nominalBudgetExceedsLimit(s,100,2000),false);
 assertEquals(s.daily_budget_limit,100);
});
Deno.test('legacy accounts retain their nominal constraint and campaign cap fallback',()=>{
 assertEquals(nominalBudgetExceedsLimit({},100,200),true);
 assertEquals(nominalBudgetHeadroom({},100,80),20);
 assertEquals(campaignBudgetPolicy({}, {maximum_campaign_budget:100}).maximumCampaignBudget,100);
 assertEquals(campaignBudgetPolicy({maximum_campaign_budget:-1}).maximumCampaignBudget,15);
});
