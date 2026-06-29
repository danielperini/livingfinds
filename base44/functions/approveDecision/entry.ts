// approveDecision — aprova ou rejeita uma decisão, e aplica regras automáticas de lances
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * Verifica se uma decisão é coberta por uma regra ativa e deve ser auto-aprovada.
 * Retorna true se a regra disparar sobre a decisão.
 */
function matchesRule(rule, decision) {
  if (!rule.is_active) return false;

  // Apenas regras de auto-aprovação
  if (rule.action !== 'auto_approve') return false;

  // Filtro de confiança
  if (rule.confidence_threshold != null && (decision.confidence ?? 0) < rule.confidence_threshold) return false;

  // Filtro de ACoS (decisões de bid_adjust geralmente têm change_pct como proxy de ACoS)
  // Usamos o campo acos se disponível na entidade, caso contrário verificamos pelo change_pct
  const acos = decision.current_value ?? null; // current_value = acos atual quando decision_type é bid_adjust
  if (rule.acos_min != null && acos != null && acos < rule.acos_min) return false;
  if (rule.acos_max != null && acos != null && acos > rule.acos_max) return false;

  // Escopo
  if (rule.scope === 'campaign_type' && rule.campaign_type_filter) {
    if (decision.entity_type !== 'campaign') return false;
  }
  if (rule.scope === 'specific_campaign' && rule.campaign_id_filter) {
    if (decision.entity_id !== rule.campaign_id_filter) return false;
  }

  return true;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { decision_id, action, apply_rules, amazon_account_id } = body;

    // Modo: aplicar regras automáticas a todas as decisões pendentes de uma conta
    if (apply_rules && amazon_account_id) {
      const [pendingDecisions, rules] = await Promise.all([
        base44.asServiceRole.entities.Decision.filter({ amazon_account_id, status: 'pending' }, '-created_date', 500),
        base44.asServiceRole.entities.BiddingRule.filter({ amazon_account_id, is_active: true }, '-created_date', 50),
      ]);

      let autoApproved = 0;
      const now = new Date().toISOString();

      for (const decision of pendingDecisions) {
        for (const rule of rules) {
          if (matchesRule(rule, decision)) {
            await base44.asServiceRole.entities.Decision.update(decision.id, {
              status: 'approved',
              reviewed_by: `auto:rule:${rule.id}`,
              reviewed_at: now,
            });
            await base44.asServiceRole.entities.BiddingRule.update(rule.id, {
              last_applied_at: now,
              applied_count: (rule.applied_count || 0) + 1,
            });
            await base44.asServiceRole.entities.LearningEvent.create({
              amazon_account_id,
              event_type: 'auto_rule_applied',
              entity_type: decision.entity_type,
              entity_id: decision.entity_id,
              observation: `Regra automática "${rule.name}" aplicou aprovação (ACoS threshold: ${rule.acos_min ?? '—'}–${rule.acos_max ?? '—'}%)`,
              decision_id: decision.id,
              recorded_at: now,
            });
            autoApproved++;
            break; // primeira regra que casou é suficiente
          }
        }
      }

      return Response.json({ ok: true, auto_approved: autoApproved, total_checked: pendingDecisions.length });
    }

    // Modo: aprovação/rejeição manual de uma decisão específica
    if (!decision_id) return Response.json({ error: 'decision_id required' }, { status: 400 });

    const decision = await base44.asServiceRole.entities.Decision.get(decision_id);
    if (!decision) return Response.json({ error: 'Decision not found' }, { status: 404 });
    if (decision.status !== 'pending') {
      return Response.json({ error: `Decision is already ${decision.status}` }, { status: 409 });
    }

    const newStatus = action === 'reject' ? 'rejected' : 'approved';

    await base44.asServiceRole.entities.Decision.update(decision_id, {
      status: newStatus,
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
    });

    await base44.asServiceRole.entities.LearningEvent.create({
      amazon_account_id: decision.amazon_account_id,
      event_type: `decision_${newStatus}`,
      entity_type: decision.entity_type,
      entity_id: decision.entity_id,
      observation: `Decisão ${newStatus} por ${user.full_name || user.email}`,
      decision_id,
      recorded_at: new Date().toISOString(),
    });

    return Response.json({ ok: true, status: newStatus });
  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});