import {assertEquals} from 'jsr:@std/assert';
import {campaignBudgetPolicy,nominalBudgetHeadroom,nominalBudgetExceedsLimit} from './campaignBudgetPolicy.ts';
Deno.test('nominal sum may exceed account spend cap without changing it',()=>{
 const s={daily_budget_limit:100,maximum_campaign_budget:150,allow_campaign_budget_overcommit:true};
 assertEquals(campaignBudgetPolicy(s).maximumCampaignBudget,150);
 assertEquals(nominalBudgetHeadroom(s,100,2000),Infinity);
 assertEquals(nominalBudgetExceedsLimit(s,100,2000),false);
 assertEquals(s.daily_budget_limit,100);
});
Deno.test('explicit legacy opt-out retains nominal constraint and campaign cap fallback',()=>{
 const legacy={allow_campaign_budget_overcommit:false};
 assertEquals(nominalBudgetExceedsLimit(legacy,100,200),true);
 assertEquals(nominalBudgetHeadroom(legacy,100,80),20);
 assertEquals(campaignBudgetPolicy({}, {maximum_campaign_budget:100}).maximumCampaignBudget,100);
 assertEquals(campaignBudgetPolicy({maximum_campaign_budget:-1}).maximumCampaignBudget,150);
});

Deno.test('default policy keeps the account cap as spend-only',()=>{
 const s={daily_budget_limit:100,minimum_campaign_budget:15};
 assertEquals(campaignBudgetPolicy(s).minimumCampaignBudget,15);
 assertEquals(nominalBudgetExceedsLimit(s,100,1000),false);
 assertEquals(nominalBudgetHeadroom(s,100,1000),Infinity);
});
