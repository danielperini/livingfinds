import {assertEquals} from 'jsr:@std/assert';
import {accountDailySpend} from './accountDailySpend.ts';
const day='2026-10-08';
const snap=(id:string,spend:number,hour:number)=>({campaign_id:id,spend,spend_date:day,observed_at:`2026-10-08T${hour}:00:00Z`});
Deno.test('today intraday spend remains visible without daily report',()=>assertEquals(accountDailySpend([], [snap('a',6.72,18)],day).spend,6.72));
Deno.test('repeated cumulative snapshots and daily reports are not added twice',()=>assertEquals(accountDailySpend([{campaign_id:'a',date:day,spend:5},{campaign_id:'a',date:day,spend:5}], [snap('a',4,17),snap('a',6.72,18),snap('b',2,18)],day).spend,8.72));
Deno.test('account cap uses conservative per-campaign evidence and ignores other dates',()=>assertEquals(accountDailySpend([{campaign_id:'a',date:day,spend:98},{campaign_id:'b',date:'2026-10-07',spend:900}], [snap('a',95,18)],day).spend,98));
Deno.test('unknown spend differs from confirmed zero',()=>{assertEquals(accountDailySpend([],[],day).hasData,false);assertEquals(accountDailySpend([],[snap('a',0,18)],day).hasData,true);});
