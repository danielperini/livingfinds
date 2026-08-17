export type EconomicZone = 'SCALE' | 'EXPLORE_HOLD' | 'LIGHT_CONTAINMENT' | 'STRONG_CONTAINMENT' | 'PAUSE_OR_NEGATIVE';
export type EvidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type EconomicInput = { clicks:number; orders:number; impressions:number; observedDays:number; spend:number; sales:number; targetAcosPct:number; breakEvenAcosPct:number; contributionMarginRate?:number; contributionMarginAmount?:number };
const clamp=(v:number,a:number,b:number)=>Math.min(b,Math.max(a,v));
const n=(v:unknown,f=0)=>Number.isFinite(Number(v))?Number(v):f;
export function calculateEvidenceScore(input: Pick<EconomicInput,'clicks'|'orders'|'impressions'|'observedDays'>){
 const clicks=Math.max(0,n(input.clicks)),orders=Math.max(0,n(input.orders)),impressions=Math.max(0,n(input.impressions)),days=Math.max(0,n(input.observedDays));
 return clamp(Math.min(30,clicks*.75)+Math.min(35,orders*7)+Math.min(25,days*3.5)+Math.min(10,Math.log10(impressions+1)*2.5),0,100);
}
export function evidenceLevel(score:number):EvidenceLevel{return score>=70?'HIGH':score>=40?'MEDIUM':'LOW'}
export function contributionReward(input:EconomicInput){
 const sales=Math.max(0,n(input.sales)),spend=Math.max(0,n(input.spend)),marginAmount=n(input.contributionMarginAmount,NaN);
 if(Number.isFinite(marginAmount)&&marginAmount>0&&n(input.orders)>0)return marginAmount*Math.max(0,n(input.orders))-spend;
 const raw=n(input.contributionMarginRate,0),rate=clamp(raw>1?raw/100:raw,0,1); return sales*rate-spend;
}
export function assessEconomicEvidence(input:EconomicInput){
 const spend=Math.max(0,n(input.spend)),sales=Math.max(0,n(input.sales)),target=Math.max(.1,n(input.targetAcosPct,15)),breakEven=Math.max(target,n(input.breakEvenAcosPct,target));
 const acos=sales>0?spend/sales*100:null,score=calculateEvidenceScore(input),level=evidenceLevel(score),reward=contributionReward(input);
 let zone:EconomicZone='EXPLORE_HOLD',adjustment=0,allowPause=false,allowNegative=false;
 if(acos===null){if(level==='HIGH'&&spend>0){zone='STRONG_CONTAINMENT';adjustment=-20}else if(level==='MEDIUM'){zone='LIGHT_CONTAINMENT';adjustment=-10}}
 else if(acos<=target*.70&&level!=='LOW'&&reward>0){zone='SCALE';adjustment=level==='HIGH'?15:10}
 else if(acos<=target*1.10){zone='EXPLORE_HOLD'}
 else if(acos<breakEven){zone='LIGHT_CONTAINMENT';adjustment=level==='HIGH'?-15:level==='MEDIUM'?-10:0}
 else if(acos<breakEven*1.50||level!=='HIGH'){zone='STRONG_CONTAINMENT';adjustment=level==='HIGH'?-25:-15}
 else{zone='PAUSE_OR_NEGATIVE';adjustment=-35;allowPause=true;allowNegative=true}
 if(level==='LOW'){allowPause=false;allowNegative=false;adjustment=clamp(adjustment,-10,5);if(zone==='PAUSE_OR_NEGATIVE')zone='STRONG_CONTAINMENT'}
 return {acosPct:acos,reward,evidenceScore:score,evidenceLevel:level,zone,bidAdjustmentPct:adjustment,allowPause,allowNegative,rationale:`zone=${zone}; evidence=${level}(${score.toFixed(1)}); acos=${acos===null?'n/a':acos.toFixed(2)}%; target=${target.toFixed(2)}%; break_even=${breakEven.toFixed(2)}%; reward=${reward.toFixed(2)}; bid_adjust=${adjustment}%`};
}
export type ContextualArm={key:string;expectedReward:number;uncertainty:number;minimumEvidence?:EvidenceLevel};
export function selectContextualExplorationArm(arms:ContextualArm[],context:{evidenceLevel:EvidenceLevel;riskPenalty?:number;explorationWeight?:number}){
 const weight=clamp(n(context.explorationWeight,.35),0,1),risk=Math.max(0,n(context.riskPenalty,0)),rank:Record<EvidenceLevel,number>={LOW:0,MEDIUM:1,HIGH:2};
 const eligible=arms.filter(a=>rank[context.evidenceLevel]>=rank[a.minimumEvidence||'LOW']); if(!eligible.length)return null;
 return [...eligible].sort((a,b)=>(b.expectedReward+weight*Math.max(0,b.uncertainty)-risk*Math.max(0,-b.expectedReward))-(a.expectedReward+weight*Math.max(0,a.uncertainty)-risk*Math.max(0,-a.expectedReward)))[0]||null;
}
