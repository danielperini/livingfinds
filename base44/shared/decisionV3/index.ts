import { estimateBayesianConversion } from '../decisionStatistics.ts';

export const DECISION_V3_VERSION = 'shadow-profit-v3.1';
const n = (v: unknown) => Number.isFinite(Number(v)) ? Number(v) : 0;
const r = (v: number) => Math.round(v * 10000) / 10000;

export type DecisionEvidencePacketV3 = { packet_id: string; version: 'decision-evidence-v3'; generated_at: string; account: any; entity: any; current_state: any; windows: any; economics: any; inventory: any; attribution: any; posterior: any; data_quality: any; intervention_history: any; policy_context: any; provenance: any };

export function buildDecisionEvidencePacketV3(input: any): DecisionEvidencePacketV3 {
  const clicks = n(input.clicks), orders = Math.min(clicks, n(input.orders));
  const posterior = estimateBayesianConversion({ clicks, orders, priorMean: input.prior_mean || 0.05, priorStrength: input.prior_strength || 20, sustainableRate: input.sustainable_rate || 0 });
  const blockers: string[] = [];
  if (!input.economics_available) blockers.push('ECONOMICS_UNAVAILABLE');
  if (!input.in_stock) blockers.push('OUT_OF_STOCK');
  if (!input.data_fresh) blockers.push('ADS_DATA_STALE');
  const maturityPenalty = n(input.maturity_ratio ?? 1) < .7 ? 15 : 0;
  const score = Math.max(0, Math.min(100, 100 - blockers.length * 35 - (clicks < 10 ? 15 : 0) - maturityPenalty));
  const packetId = `v3:${input.amazon_account_id}:${input.entity_id}:${input.window_end || 'unknown'}:${input.decision_id || 'none'}`;
  return { packet_id: packetId, version: 'decision-evidence-v3', generated_at: new Date().toISOString(), account: { amazon_account_id: input.amazon_account_id, marketplace_id: input.marketplace_id || null, currency_code: input.currency_code || 'BRL' }, entity: { entity_type: input.entity_type, entity_id: input.entity_id, campaign_id: input.campaign_id || null, keyword_id: input.keyword_id || null, asin: input.asin || null }, current_state: { bid: input.current_bid || null, budget: input.current_budget || null, status: input.status || null }, windows: { d14: { impressions: n(input.impressions), clicks, spend: n(input.spend), orders, sales: n(input.sales), complete: input.data_fresh === true } }, economics: { contribution_margin_per_order: n(input.margin_per_order), maximum_economic_cpc: n(input.safe_cpc), safe_cpc: n(input.safe_cpc), target_acos: n(input.target_acos), economics_available: input.economics_available === true, economics_confidence: input.economics_available ? 100 : 0 }, inventory: { in_stock: input.in_stock === true, stock_qty: n(input.stock_qty), urgency: input.in_stock ? 'healthy' : 'critical', signal_quality: input.stock_qty != null ? 'sufficient' : 'unknown' }, attribution: { raw_clicks: clicks, mature_clicks: n(input.mature_clicks ?? clicks), maturity_ratio: n(input.maturity_ratio ?? 1), confidence: n(input.maturity_ratio ?? 1) >= .9 ? 'complete' : 'partial' }, posterior, data_quality: { score, blockers, warnings: clicks < 10 ? ['LOW_SAMPLE'] : [] }, intervention_history: { changes_24h: n(input.changes_24h), cooldown_active: input.cooldown_active === true }, policy_context: { account_daily_budget_limit: n(input.account_budget), account_daily_spend: n(input.account_spend) }, provenance: { source_function: 'runDecisionArbiterV3', snapshot_id: input.snapshot_id || null, data_window_end: input.window_end || null } };
}

function random(seed: string) { let x = 2166136261; for (const c of seed) x = Math.imul(x ^ c.charCodeAt(0), 16777619); return () => ((x = Math.imul(x ^ x >>> 15, x | 1)) >>> 0) / 4294967296; }
export function generateBidCandidatesV3(packet: DecisionEvidencePacketV3) {
  const bid = n(packet.current_state.bid), safe = n(packet.economics.safe_cpc); const blocked = packet.data_quality.blockers.length > 0 || packet.intervention_history.cooldown_active;
  return [-.10, -.05, 0, .03, .05].map(change => { const proposed = r(bid * (1 + change)); const valid = !blocked && proposed > 0 && (!safe || proposed <= safe); return { candidate_id: `${packet.packet_id}:bid:${change}`, action_type: change === 0 ? 'NO_ACTION' : 'UPDATE_BID', current_value: bid, proposed_value: proposed, change_pct: change * 100, hard_blockers: valid ? [] : packet.data_quality.blockers, warnings: packet.data_quality.warnings, model_version: DECISION_V3_VERSION }; });
}
export function simulateCandidateOutcomeV3(packet: DecisionEvidencePacketV3, candidate: any, iterations = 500) {
  const rng = random(`${packet.packet_id}:${candidate.candidate_id}:${DECISION_V3_VERSION}`); const w = packet.windows.d14; const baseBid = Math.max(.01, n(packet.current_state.bid)); const multiplier = n(candidate.proposed_value) / baseBid; const cvr = n(packet.posterior.posterior_mean); const margin = n(packet.economics.contribution_margin_per_order); const baseline = n(w.spend) > 0 ? n(w.orders) * margin - n(w.spend) : 0; const samples: number[] = [];
  for (let i = 0; i < iterations; i++) { const clicks = Math.max(0, Math.round(n(w.clicks) * multiplier * (.8 + rng() * .4))); let orders = 0; for (let j = 0; j < clicks; j++) if (rng() < cvr) orders++; samples.push(orders * margin - clicks * n(candidate.proposed_value) - baseline); }
  samples.sort((a,b)=>a-b); const mean = samples.reduce((a,b)=>a+b,0) / Math.max(1,samples.length); const q = (p:number) => samples[Math.min(samples.length-1, Math.floor(p*(samples.length-1)))] || 0;
  return { iterations, expected_incremental_profit: r(mean), profit_p05: r(q(.05)), profit_p50: r(q(.5)), profit_p95: r(q(.95)), probability_profit_positive: r(samples.filter(x=>x>0).length / Math.max(1,samples.length)), expected_downside: r(Math.abs(samples.filter(x=>x<0).reduce((a,b)=>a+b,0) / Math.max(1,samples.filter(x=>x<0).length))), causal_status: 'PREDICTIVE_ONLY_NOT_CAUSAL' };
}
export function decisionUtilityV3(sim: any, packet: DecisionEvidencePacketV3, candidate: any) { const risk = sim.expected_downside * .8 + Math.max(0, -sim.profit_p05) * .4; const instability = Math.abs(n(candidate.change_pct)) * .03; return r(sim.expected_incremental_profit - risk - instability - (packet.inventory.urgency === 'critical' ? 9999 : 0)); }
