// approveDecision — delega aprovação/execução ao Xano (único gateway Amazon)
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

    const xanoBase = Deno.env.get('XANO_BASE_URL') || 'https://x8ki-letl-twmt.n7.xano.io/api:living-finds-api';
    const endpoint = (action === 'reject') ? '/decisions/reject' : '/decisions/approve';

    // Delegar ao Xano — ele aplica na Amazon API
    const xanoRes = await fetch(`${xanoBase}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision_id }),
    });

    const xanoData = await xanoRes.json().catch(() => ({}));

    const newStatus = (action === 'reject') ? 'rejected' : (xanoRes.ok ? 'executed' : 'failed');

    // Actualizar entidade local
    await base44.asServiceRole.entities.Decision.update(decision_id, {
      status: newStatus,
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
      executed_at: xanoRes.ok && action !== 'reject' ? new Date().toISOString() : null,
      error_message: xanoRes.ok ? null : (xanoData.message || `HTTP ${xanoRes.status}`),
    });

    // Log evento de aprendizagem
    await base44.asServiceRole.entities.LearningEvent.create({
      amazon_account_id: decision.amazon_account_id,
      event_type: `decision_${newStatus}`,
      entity_type: decision.entity_type,
      entity_id: decision.entity_id,
      observation: `Decisão ${newStatus} por ${user.full_name || user.id}. Xano: ${xanoData.message || 'ok'}`,
      decision_id,
      recorded_at: new Date().toISOString(),
    });

    return Response.json({ ok: xanoRes.ok, status: newStatus, xano: xanoData });
  } catch (error) {
    return Response.json({ ok: false, message: error.message || 'approveDecision failed' }, { status: 500 });
  }
});