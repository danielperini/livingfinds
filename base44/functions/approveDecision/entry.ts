// approveDecision — aprova ou rejeita uma decisão IA localmente, sem dependência do Xano
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { decision_id, action } = body; // action: 'approve' | 'reject'
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