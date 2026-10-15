import { createEmptyHarvestMemo } from './emptyHarvestMemo.ts';

const payload = { amazon_account_id:'a',target_asins:['ASIN-A'],source_campaign_type:'AUTO',lookback_days:65,max_promotions:1,dry_run:false };
const empty = () => ({ ok:true,evidence_complete:true,reports:[{ evidence_complete:true,amazon_account_id:'a',same_sku_candidates:0,selected:0,promoted:0,failed:0,promoted_terms:[],failures:[] }] });

Deno.test('47 campaigns with the same empty harvest invoke it once; a new cycle reads again', async () => {
  const memo=createEmptyHarvestMemo(); let calls=0;
  const invoke=async()=>{calls++;return {data:empty()};};
  for(let i=0;i<47;i++) {
    const result=await memo(payload,invoke);
    if(result.reports[0].promoted!==0) throw new Error('Created a fictional winner');
  }
  if(calls!==1) throw new Error('Repeated the same empty history');
  await createEmptyHarvestMemo()(payload,invoke);
  if(Number(calls)!==2) throw new Error('New daily data was not read');
});

Deno.test('empty harvest memo isolates account, ASIN, source type and report window', async () => {
  const memo=createEmptyHarvestMemo(); let calls=0;
  for(const p of [payload,{...payload,amazon_account_id:'b'},{...payload,target_asins:['ASIN-B']},{...payload,source_campaign_type:'MANUAL'},{...payload,lookback_days:30}]) {
    await memo(p,async()=>{calls++;const data=empty();data.reports[0].amazon_account_id=p.amazon_account_id;return data;});
  }
  if(calls!==5) throw new Error('Mixed distinct evidence scopes');
});

Deno.test('mutations, candidates, partial responses and failures are never memoized', async () => {
  for(const modify of [
    (d:any)=>{d.reports[0].promoted=1;},(d:any)=>{d.reports[0].same_sku_candidates=1;},
    (d:any)=>{d.partial=true;},(d:any)=>{d.reports[0].failed=1;},(d:any)=>{d.ok=false;},
    (d:any)=>{d.reports=[];},(d:any)=>{delete d.reports[0].failures;},
    (d:any)=>{delete d.evidence_complete;},(d:any)=>{delete d.reports[0].evidence_complete;},
    (d:any)=>{d.complete=false;},(d:any)=>{d.reports[0].complete=false;},
  ]) {
    const memo=createEmptyHarvestMemo();let calls=0;
    const invoke=async()=>{calls++;const data=empty();modify(data);return data;};
    await memo(payload,invoke);await memo(payload,invoke);
    if(calls!==2) throw new Error('Cached unsafe or unresolved harvest');
  }
});
