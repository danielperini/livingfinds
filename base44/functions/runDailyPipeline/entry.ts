/**
 * runDailyPipeline — DEPRECATED. Wrapper para runDailyAdsOptimization.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const res = await base44.functions.invoke('runDailyAdsOptimization', body);
    return Response.json({ ...res.data, deprecated: true, redirected_to: 'runDailyAdsOptimization' });
  } catch (error) {
    return Response.json({ ok: false, error: error.message, deprecated: true, redirected_to: 'runDailyAdsOptimization' }, { status: 500 });
  }
});