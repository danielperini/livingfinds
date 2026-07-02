/**
 * optimizeKeywordBidsDaily — DEPRECATED
 * Redirecionado para aiEngine (mode=full) — fonte única de IA.
 * As regras de bid desta função foram consolidadas em:
 * - smartBidFromCpc (bid = 50% do CPC)
 * - calibrateBidsNoImpressions (piso R$0.25, teto R$1.20)
 * - runDailyAdsOptimization (motor decisório principal)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const res = await base44.asServiceRole.functions.invoke('aiEngine', {
      mode: 'full',
      amazon_account_id: body.amazon_account_id,
    });
    return Response.json({
      ...res?.data,
      deprecated: true,
      redirected_to: 'aiEngine?mode=full',
    });
  } catch (error) {
    return Response.json({ ok: false, error: error.message, deprecated: true, redirected_to: 'aiEngine?mode=full' }, { status: 500 });
  }
});