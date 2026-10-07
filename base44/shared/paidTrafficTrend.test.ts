import { assertEquals } from 'jsr:@std/assert';
import { paidTrafficTrend } from './paidTrafficTrend.ts';
const today = '2026-10-07';
const rows = (totals: number[]) => totals.flatMap((total, week) => Array.from({length:7}, (_,day) => ({
  campaign_id:'one', date:new Date(Date.parse(today) - (week*7+day+1)*86400000).toISOString().slice(0,10), impressions:total/7,
})));
Deno.test('weekly traffic excludes incomplete current day and isolates exceptional peaks', () => {
  const data=rows([700,1400,1400,1400,7000]);
  const result=paidTrafficTrend([...data,{campaign_id:'one',date:today,impressions:999999}],today);
  assertEquals(result.status,'declining'); assertEquals(result.change_pct,-50);
  assertEquals(result.anomalous_weeks.length,1); assertEquals(result.automatic_spend_increase_allowed,false);
});
Deno.test('missing reports never become observed zero traffic', () => {
  assertEquals(paidTrafficTrend(rows([700,1400,1400,1400]).slice(1),today).status,'insufficient_data');
  assertEquals(paidTrafficTrend([],today).change_pct,null);
});
Deno.test('duplicate reports do not double impressions', () => {
  const data=rows([1400,1400,1400,1400]);
  assertEquals(paidTrafficTrend([...data,...data],today).change_pct,0);
  assertEquals(paidTrafficTrend(data,today).store_page_views_status,'not_imported');
});
