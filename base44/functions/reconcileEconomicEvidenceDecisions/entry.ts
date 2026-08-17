import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const s=(v:unknown)=>String(v||'').trim();
const low=(v:unknown)=>s(v).toLowerCase();
const n=(v:unknown,f=0)=>Number.isFinite(Number(v))?Number(v):f;
const pctChange=(before:number,after:number)=>before>0?(after/before-1)*100:0;

Deno.serve(async(request)=>{
  try{
    const base44=createClientFromRequest(request);
    const body=await request.json().catch(()=>({}));
    const authenticated=await base44.auth.isAuthenticated().catch(()=>false);
    if(!authenticated&&!body._service_role)return Response.json({ok:false,error:'Não autorizado'},{status:401});
    const accounts=body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({id:body.amazon_account_id},null,1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({status:'connected'},null,100);
    const since=s(body.since)||new Date(Date.now()-10*60_000).toISOString();
    const results:any[]=[];
    for(const account of accounts){
      const aid=account.id;
      const [approved,shadow]=await Promise.all([
        base44.asServiceRole.entities.OptimizationDecision.filter({amazon_account_id:aid,status:'approved',created_at:{$gte:since}},'-created_at',1000).catch(()=>[]),
        base44.asServiceRole.entities.OptimizationDecision.filter({amazon_account_id:aid,decision_type:'economic_evidence_shadow',created_at:{$gte:since}},'-created_at',1000).catch(()=>[]),
      ]);
      const key=(row:any)=>[
        s(row.asin).toUpperCase(),s(row.campaign_id),low(row.keyword_text||row.entity_id),
      ].join('|');
      const byKey=new Map<string,any>();
      const byCampaign=new Map<string,any[]>();
      for(const row of shadow){
        byKey.set(key(row),row);
        const ck=[s(row.asin).toUpperCase(),s(row.campaign_id)].join('|');
        if(!byCampaign.has(ck))byCampaign.set(ck,[]); byCampaign.get(ck)!.push(row);
      }
      let blocked=0,capped=0,kept=0,unmatched=0;
      const changes:any[]=[];
      for(const d of approved){
        if(low(d.source_function).includes('economicevidence'))continue;
        const exact=byKey.get(key(d));
        const campaignRows=byCampaign.get([s(d.asin).toUpperCase(),s(d.campaign_id)].join('|'))||[];
        const evidence=exact||campaignRows.sort((a:any,b:any)=>n(b.evidence_score)-n(a.evidence_score))[0];
        if(!evidence){unmatched++;continue;}
        const zone=s(evidence.economic_zone||evidence.zone).toUpperCase();
        const level=s(evidence.evidence_level).toUpperCase();
        const action=low(d.action);
        const before=n(d.value_before,NaN),after=n(d.value_after,NaN);
        const isIncrease=Number.isFinite(before)&&Number.isFinite(after)&&after>before;
        const isDecrease=Number.isFinite(before)&&Number.isFinite(after)&&after<before;
        const isTerminal=action.includes('pause')||action.includes('negative')||action.includes('archive');

        if(isTerminal&&level!=='HIGH'){
          await base44.asServiceRole.entities.OptimizationDecision.update(d.id,{
            status:'blocked',approval_status:'blocked_evidence_gate',queue_status:'cancelled',
            rationale:`${d.rationale||''} [ECONOMIC_EVIDENCE_GATE: ação terminal bloqueada; evidence=${level||'UNKNOWN'}, zone=${zone||'UNKNOWN'}. Alternativa: reduzir/observar.]`,
            economic_evidence_reconciled:true,economic_evidence_zone:zone,economic_evidence_level:level,
          }).catch(()=>{}); blocked++; changes.push({id:d.id,result:'blocked_terminal_low_evidence',zone,level}); continue;
        }
        if(isIncrease&&['LIGHT_CONTAINMENT','STRONG_CONTAINMENT','PAUSE_OR_NEGATIVE'].includes(zone)){
          await base44.asServiceRole.entities.OptimizationDecision.update(d.id,{
            status:'blocked',approval_status:'blocked_economic_zone',queue_status:'cancelled',
            rationale:`${d.rationale||''} [ECONOMIC_EVIDENCE_GATE: crescimento bloqueado; zone=${zone}, evidence=${level}.]`,
            economic_evidence_reconciled:true,economic_evidence_zone:zone,economic_evidence_level:level,
          }).catch(()=>{}); blocked++; changes.push({id:d.id,result:'blocked_growth_in_loss_zone',zone,level}); continue;
        }
        if(isIncrease&&zone==='EXPLORE_HOLD'&&level==='LOW'){
          await base44.asServiceRole.entities.OptimizationDecision.update(d.id,{
            status:'blocked',approval_status:'blocked_low_evidence_growth',queue_status:'cancelled',
            rationale:`${d.rationale||''} [ECONOMIC_EVIDENCE_GATE: crescimento adiado por baixa evidência; manter/explorar sem aumento.]`,
            economic_evidence_reconciled:true,economic_evidence_zone:zone,economic_evidence_level:level,
          }).catch(()=>{}); blocked++; changes.push({id:d.id,result:'blocked_low_evidence_growth',zone,level}); continue;
        }
        if(isDecrease&&Number.isFinite(before)&&Number.isFinite(after)){
          const suggested=n(evidence.recommended_bid_adjustment_pct,0);
          if(suggested<0&&suggested>-35){
            const actual=pctChange(before,after);
            if(actual<suggested-0.5){
              const cappedAfter=Math.max(0.01,Math.round(before*(1+suggested/100)*100)/100);
              await base44.asServiceRole.entities.OptimizationDecision.update(d.id,{
                value_after:cappedAfter,
                rationale:`${d.rationale||''} [ECONOMIC_EVIDENCE_GATE: redução suavizada de ${actual.toFixed(1)}% para ${suggested.toFixed(1)}% conforme evidence=${level}, zone=${zone}.]`,
                economic_evidence_reconciled:true,economic_evidence_zone:zone,economic_evidence_level:level,
              }).catch(()=>{}); capped++; changes.push({id:d.id,result:'capped_reduction',from_pct:actual,to_pct:suggested,zone,level}); continue;
            }
          }
        }
        await base44.asServiceRole.entities.OptimizationDecision.update(d.id,{
          economic_evidence_reconciled:true,economic_evidence_zone:zone,economic_evidence_level:level,
        }).catch(()=>{}); kept++;
      }
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id:aid,operation:'reconcile_economic_evidence_decisions',trigger_type:body.trigger_type||'canonical_cycle',status:'success',records_processed:approved.length,
        result_summary:`approved=${approved.length}; blocked=${blocked}; capped=${capped}; kept=${kept}; unmatched=${unmatched}; single_executor=true`,started_at:since,completed_at:new Date().toISOString(),
      }).catch(()=>{});
      results.push({amazon_account_id:aid,ok:true,approved_scanned:approved.length,shadow_scanned:shadow.length,blocked,capped,kept,unmatched,changes:changes.slice(0,100)});
    }
    return Response.json({ok:true,reconciliation:'economic-evidence-before-canonical-executor',single_executor:true,results});
  }catch(error:any){return Response.json({ok:false,error:error?.message||String(error)},{status:500})}
});
