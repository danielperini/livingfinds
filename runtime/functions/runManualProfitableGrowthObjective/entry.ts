/**
 * Alias legado. Desde a v18, a meta oficial é SERVING_CAMPAIGNS e nunca a
 * quantidade de campanhas manuais existentes/produtivas.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }
    const response = await base44.asServiceRole.functions.invoke('runServingCampaignGrowthObjective', {
      ...body,
      _service_role: true,
      serving_campaign_growth_target_pct: body.serving_campaign_growth_target_pct ?? 40,
      trigger_type: body.trigger_type || 'legacy_manual_growth_alias',
    });
    const data = response?.data || response || {};
    return Response.json({
      ...data,
      deprecated_alias: 'runManualProfitableGrowthObjective',
      delegated_to: 'runServingCampaignGrowthObjective',
      legacy_manual_count_goal_disabled: true,
    }, { status: data?.ok === false ? 500 : 200 });
  } catch (error: any) {
    return Response.json({
      ok: false,
      deprecated_alias: 'runManualProfitableGrowthObjective',
      delegated_to: 'runServingCampaignGrowthObjective',
      error: error?.message || String(error),
    }, { status: 500 });
  }
});
