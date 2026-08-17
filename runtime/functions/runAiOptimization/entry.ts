/**
 * runAiOptimization — DEPRECATED
 * Redirecionado para aiEngine (mode=autopilot) — fonte única de IA.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const res = await base44.asServiceRole.functions.invoke('aiEngine', {
      mode: 'autopilot',
      amazon_account_id: body.amazon_account_id,
    });
    return Response.json({
      ...res?.data,
      deprecated: true,
      redirected_to: 'aiEngine?mode=autopilot',
    });
  } catch (error) {
    return Response.json({ ok: false, error: error.message, deprecated: true, redirected_to: 'aiEngine?mode=autopilot' }, { status: 500 });
  }
});