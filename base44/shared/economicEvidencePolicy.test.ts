import { assertEquals, assert } from 'jsr:@std/assert@1';
import { assessEconomicEvidence, calculateEvidenceScore, selectContextualExplorationArm } from './economicEvidencePolicy.ts';

Deno.test('low evidence cannot pause or negative',()=>{
 const r=assessEconomicEvidence({clicks:3,orders:0,impressions:100,observedDays:1,spend:20,sales:10,targetAcosPct:15,breakEvenAcosPct:30,contributionMarginRate:.30});
 assertEquals(r.allowPause,false); assertEquals(r.allowNegative,false); assert(r.bidAdjustmentPct>=-10);
});
Deno.test('profitable mature target scales conservatively',()=>{
 const r=assessEconomicEvidence({clicks:45,orders:8,impressions:4000,observedDays:10,spend:50,sales:500,targetAcosPct:18,breakEvenAcosPct:30,contributionMarginRate:.35});
 assertEquals(r.zone,'SCALE'); assert(r.bidAdjustmentPct>=10&&r.bidAdjustmentPct<=15); assert(r.reward>0);
});
Deno.test('mature structural loss permits terminal action',()=>{
 const r=assessEconomicEvidence({clicks:70,orders:2,impressions:6000,observedDays:14,spend:150,sales:200,targetAcosPct:18,breakEvenAcosPct:30,contributionMarginRate:.30});
 assertEquals(r.zone,'PAUSE_OR_NEGATIVE'); assertEquals(r.allowPause,true); assertEquals(r.allowNegative,true);
});
Deno.test('evidence grows with clicks orders days and visibility',()=>{
 assert(calculateEvidenceScore({clicks:40,orders:5,impressions:5000,observedDays:10})>calculateEvidenceScore({clicks:3,orders:0,impressions:50,observedDays:1}));
});
Deno.test('contextual exploration respects evidence requirement',()=>{
 const arm=selectContextualExplorationArm([{key:'SCALE',expectedReward:10,uncertainty:5,minimumEvidence:'MEDIUM'},{key:'HOLD',expectedReward:5,uncertainty:1,minimumEvidence:'LOW'}],{evidenceLevel:'LOW'});
 assertEquals(arm?.key,'HOLD');
});
