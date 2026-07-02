/**
 * migrateDecisions — Migra decisões pendentes de entidades legadas para OptimizationDecision.
 * Fontes: AutopilotDecision, AgentAction, Decision, AdsAiDecisio.
 * Seguro: não apaga registros originais, impede duplicatas via legacy_id.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const amazonAccountId = body.amazon_account_id;
    if (!amazonAccountId) return Response.json({ error: 'amazon_account_id obrigatório' }, { status: 400 });

    const now = new Date().toISOString();
    let migrated = 0;
    let skipped = 0;
    const errors = [];

    // Buscar IDs já migrados para evitar duplicação
    const existing = await base44.asServiceRole.entities.OptimizationDecision.filter(
      { amazon_account_id: amazonAccountId }, '-created_at', 2000
    );
    const migratedIds = new Set(existing.filter(d => d.legacy_id).map(d => d.legacy_id));

    // ── Migrar AutopilotDecision ──
    try {
      const legacyDecs = await base44.asServiceRole.entities.AutopilotDecision.filter(
        { amazon_account_id: amazonAccountId, status: 'pending' }, '-created_date', 500
      );
      for (const d of legacyDecs) {
        if (migratedIds.has(d.id)) { skipped++; continue; }
        await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id: amazonAccountId,
          decision_type: 'bid_change',
          entity_type: d.entity_type || 'keyword',
          entity_id: d.entity_id,
          campaign_id: d.campaign_id || d.run_id,
          keyword_id: d.entity_id,
          keyword_text: d.entity_name,
          action: d.action,
          value_before: d.current_value,
          value_after: d.new_value,
          change_pct: d.change_pct,
          rationale: d.reason,
          data_used: d.evidence,
          risk: d.risk_level || 'medium',
          requires_approval: d.requires_approval !== false,
          status: 'pending',
          legacy_source: 'AutopilotDecision',
          legacy_id: d.id,
          country_code: 'BR',
          currency_code: 'BRL',
          currency_symbol: 'R$',
          created_at: d.created_date || now,
        });
        migrated++;
      }
    } catch (e) { errors.push(`AutopilotDecision: ${e.message}`); }

    // ── Migrar AgentAction ──
    try {
      const agentActions = await base44.asServiceRole.entities.AgentAction.filter(
        { amazon_account_id: amazonAccountId, status: 'pending' }, '-created_date', 500
      );
      for (const a of agentActions) {
        if (migratedIds.has(a.id)) { skipped++; continue; }
        const decisionType = a.action === 'update_bid' ? 'bid_change'
          : a.action === 'update_budget' ? 'budget_change'
          : a.action === 'pause_campaign' ? 'pause'
          : a.action === 'enable_campaign' ? 'enable'
          : a.action === 'negative_keyword' ? 'negative_keyword'
          : a.action === 'create_keyword' ? 'create_keyword'
          : a.action === 'create_auto_campaign' || a.action === 'create_manual_campaign' ? 'create_campaign'
          : 'bid_change';
        await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id: amazonAccountId,
          decision_type: decisionType,
          entity_type: a.campaign_id ? 'campaign' : a.keyword_id ? 'keyword' : 'keyword',
          entity_id: a.keyword_id || a.campaign_id || a.ad_group_id,
          campaign_id: a.campaign_id,
          ad_group_id: a.ad_group_id,
          keyword_id: a.keyword_id,
          asin: a.asin,
          action: a.action,
          value_before: a.current_value,
          value_after: a.new_value,
          rationale: a.reason,
          data_used: a.evidence,
          risk: a.risk_level || 'medium',
          requires_approval: a.requires_approval !== false,
          status: 'pending',
          legacy_source: 'AgentAction',
          legacy_id: a.id,
          country_code: 'BR',
          currency_code: 'BRL',
          currency_symbol: 'R$',
          created_at: a.created_date || now,
        });
        migrated++;
      }
    } catch (e) { errors.push(`AgentAction: ${e.message}`); }

    return Response.json({ ok: true, migrated, skipped, errors });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});