/**
 * Compatibilidade para o endpoint legado de expansão AUTO → MANUAL.
 * Não sugere keywords a partir do título nem chama a Amazon diretamente.
 * Toda criação passa pelo harvest canônico, que exige duas vendas verificadas
 * do mesmo SKU, economia válida, estoque e deduplicação por ASIN + termo.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role && !(await base44.auth.isAuthenticated().catch(() => false))) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }
    if (!body.amazon_account_id) {
      return Response.json({ ok: false, error: 'amazon_account_id é obrigatório' }, { status: 400 });
    }

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });

    const campaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: account.id }, '-updated_at', 5000,
    );
    const targetAsins = [...new Set(campaigns
      .filter((campaign: any) =>
        String(campaign.targeting_type || campaign.amazon_targeting_type || '').toUpperCase().includes('AUTO') &&
        !['paused', 'archived'].includes(String(campaign.state || campaign.status || '').toLowerCase()) &&
        campaign.asin,
      )
      .map((campaign: any) => String(campaign.asin).toUpperCase()))]
      .slice(0, Math.max(1, Math.min(100, Number(body.max_per_run || 100))));

    if (!targetAsins.length) {
      return Response.json({ ok: true, campaigns_created: 0, message: 'Nenhuma campanha automática ativa elegível.' });
    }

    const response = await base44.asServiceRole.functions.invoke('runImmediateSameSkuSearchTermHarvest', {
      _service_role: true,
      amazon_account_id: account.id,
      target_asins: targetAsins,
      max_promotions: Math.max(1, Math.min(50, Number(body.max_per_run || 25))),
      lookback_days: 65,
      dry_run: body.dry_run === true,
      trigger_type: 'legacy_endpoint_routed_to_verified_search_terms',
    });
    const result = response?.data || response || {};
    const reports = Array.isArray(result.reports) ? result.reports : [];
    const created = reports.flatMap((report: any) => report.promoted_terms || []);
    const rejected = reports.flatMap((report: any) => report.rejected_terms || []);
    return Response.json({
      ok: result.ok !== false,
      dry_run: body.dry_run === true,
      source: 'verified_search_term_report',
      policy: 'minimum_two_verified_same_sku_orders; no_title_generated_keywords',
      asins_checked: targetAsins.length,
      campaigns_created: created.length,
      blocked_title_generation: true,
      created,
      rejected_count: rejected.length,
      reports,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: String(error?.message || error).slice(0, 500) }, { status: 500 });
  }
});
