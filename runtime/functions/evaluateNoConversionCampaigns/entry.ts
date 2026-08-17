/**
 * Compatibilidade para o job legado de campanhas sem conversão.
 *
 * A implementação antiga pausava a campanha inteira após somente 3 cliques e
 * 2 dias. O endpoint permanece para não quebrar agendamentos, mas delega ao
 * motor canônico: dados frescos, 20 cliques, economia/atribuição confirmadas,
 * redução de bid primeiro e eventual pausa somente da keyword.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

Deno.serve(async (request) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const result = await base44.asServiceRole.functions.invoke('runDeterministicDecisionEngine', {
      amazon_account_id: body.amazon_account_id || null,
      _service_role: true,
      force_batch: false,
      source_function: 'evaluateNoConversionCampaigns_compat',
    });
    const data = result?.data || result || {};
    return Response.json({
      ok: data?.ok !== false,
      delegated: true,
      delegated_to: 'runDeterministicDecisionEngine',
      policy: {
        min_clicks: 20,
        action_order: ['reduce_keyword_bid_10_to_25_pct', 'pause_keyword_after_mature_review'],
        whole_campaign_pause: false,
        winner_protection: true,
      },
      result: data,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error: any) {
    return Response.json({
      ok: false,
      error: error?.message || String(error),
      duration_ms: Date.now() - startedAt,
    }, { status: 500 });
  }
});
