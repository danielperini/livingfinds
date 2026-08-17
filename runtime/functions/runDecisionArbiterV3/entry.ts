import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { buildDecisionEvidencePacketV3, decisionUtilityV3, generateBidCandidatesV3, simulateCandidateOutcomeV3, DECISION_V3_VERSION } from '../../shared/decisionV3/index.ts';

const n = (v: unknown) => Number.isFinite(Number(v)) ? Number(v) : 0;
Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req); const body = await req.json().catch(() => ({}));
  if (!body._service_role && !(await base44.auth.isAuthenticated().catch(() => false))) return Response.json({ ok:false, error:'Não autorizado' }, { status:401 });
  const accounts = body.amazon_account_id ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1) : await base44.asServiceRole.entities.AmazonAccount.filter({ status:'connected' }, '-updated_at', 10);
  const result:any[]=[];
  for (const account of accounts) {
    const aid=account.id; const [decisions, existing, settingsRows] = await Promise.all([
      base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id:aid }, '-created_at', 100),
      base44.asServiceRole.entities.DecisionV3ShadowRun.filter({ amazon_account_id:aid }, '-created_at', 500),
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id:aid }, '-updated_at', 1),
    ]);
    const settings=settingsRows[0]||{}; let created=0;
    for (const v2 of decisions.filter((d:any)=>d.entity_id && ['set_bid','update_bid','increase_bid','reduce_bid'].includes(String(d.action||''))).slice(0,25)) {
      if (existing.some((s:any)=>String(s.v2_decision_id)===String(v2.id))) continue;
      const packet=buildDecisionEvidencePacketV3({ amazon_account_id:aid, marketplace_id:account.marketplace_id, entity_id:v2.entity_id, entity_type:v2.entity_type, campaign_id:v2.campaign_id, keyword_id:v2.keyword_id, asin:v2.asin, decision_id:v2.id, current_bid:v2.value_before ?? v2.current_value, clicks:v2.raw_clicks, mature_clicks:v2.mature_clicks, orders:v2.same_sku_orders ?? 0, spend:v2.current_cpc && v2.raw_clicks ? n(v2.current_cpc)*n(v2.raw_clicks) : 0, margin_per_order:v2.contribution_margin_per_order, safe_cpc:v2.safe_cpc || v2.maximum_economic_cpc, target_acos:v2.target_acos || settings.target_acos, economics_available:n(v2.safe_cpc || v2.maximum_economic_cpc)>0 && n(v2.contribution_margin_per_order)>0, in_stock:n(v2.stock_qty)>0, stock_qty:v2.stock_qty, data_fresh:v2.requires_fresh_data !== true || Boolean(v2.data_window_end), maturity_ratio:v2.maturity_ratio || 1, cooldown_active:Boolean(v2.cooldown_until && new Date(v2.cooldown_until).getTime()>Date.now()), account_budget:settings.daily_budget_limit, account_spend:v2.account_daily_spend, window_end:v2.data_window_end });
      const candidates=generateBidCandidatesV3(packet).map((c:any)=>{ const sim=simulateCandidateOutcomeV3(packet,c,500); return { ...c, prediction:sim, utility:decisionUtilityV3(sim,packet,c), evidence_quality_score:packet.data_quality.score }; }).sort((a:any,b:any)=>b.utility-a.utility);
      const best=candidates[0]||null; const v2Change=n(v2.value_after ?? v2.proposed_value)-n(v2.value_before ?? v2.current_value); const agreement=best ? Math.sign(n(best.change_pct))===Math.sign(v2Change) : false;
      await base44.asServiceRole.entities.DecisionV3ShadowRun.create({ amazon_account_id:aid, v2_decision_id:v2.id, packet_id:packet.packet_id, policy_version:DECISION_V3_VERSION, status:packet.data_quality.blockers.length?'blocked':'shadow', evidence_packet:packet, candidates, selected_candidate_id:best?.candidate_id||null, v2_action:String(v2.action||''), v3_action:best?.action_type||'NO_ACTION', agreement, causal_status:'PREDICTIVE_ONLY_NOT_CAUSAL', created_at:new Date().toISOString() }); created++;
    }
    result.push({ amazon_account_id:aid, created, execution:'shadow_only_no_amazon_write' });
  }
  return Response.json({ ok:true, engine:DECISION_V3_VERSION, shadow_only:true, result });
});
