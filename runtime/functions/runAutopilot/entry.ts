/**
 * runAutopilot — DEPRECATED. Wrapper para runDailyAdsOptimization.
 * Mantido para compatibilidade com automações e chamadas existentes.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const res = await base44.functions.invoke('runDailyAdsOptimization', body);
    return Response.json({
      ...res.data,
      deprecated: true,
      redirected_to: 'runDailyAdsOptimization',
      // Mapear campo para compatibilidade com chamadas antigas
      decisions_generated: res.data?.decisions_created || 0,
      alerts: 0,
      negative_suggestions: res.data?.breakdown?.negative || 0,
    });
  } catch (error) {
    return Response.json({ ok: false, error: error.message, deprecated: true, redirected_to: 'runDailyAdsOptimization' }, { status: 500 });
  }
});