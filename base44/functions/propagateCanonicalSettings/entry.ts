import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { waitUntil } from 'base44:runtime';

/**
 * Propagação canônica dos PerformanceSettings para a Amazon Ads:
 * 1. Budgets (teto diário + budget mínimo por campanha) via adjustCampaignBudgets
 * 2. Placement adjustments via updatePlacements
 * 3. Cap do dia no AccountDailySpendController
 * Depois dispara a releitura de métricas confirmadas (syncUnifiedAdsReportsDaily).
 */
const r2 = (value: number) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const norm = (value: any) => String(value || '').trim().toLowerCase();
const active = (value: any) => ['enabled', 'active'].includes(norm(value));

// Regra Canônica: 0/null = ignorado
function goal(value: any): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export default async function handler(req: Request): Promise<Response> {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({})) as any;
    const aid = String(body.amazon_account_id || '');
    if (!aid) return Response.json({ error: 'amazon_account_id obrigatório' }, { status: 400 });

    const [accounts, settings, campaigns] = await Promise.all([
      base44.asServiceRole.entities.AmazonAccount.filter({ id: aid }, null, 1),
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, null, 1),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 1000),
    ]);
    const account = accounts[0];
    if (!account) return Response.json({ error: 'Conta Amazon não encontrada' }, { status: 404 });
    const perf = settings[0] || {};

    const dailyCap = goal(perf.daily_budget_limit);
    const minBudget = goal(perf.minimum_campaign_budget);
    const now = new Date().toISOString();
    const todayBRT = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
    const results: any = { budgets: null, placements: null, controller: null, validation: null };

    const enabledSp = campaigns.filter((campaign: any) => {
      const cid = String(campaign.amazon_campaign_id || campaign.campaign_id || '');
      return cid && active(campaign.state || campaign.status) && campaign.archived !== true &&
        String(campaign.campaign_type || 'SP').toUpperCase() === 'SP';
    });

    // ── 1. Budgets: piso mínimo + escala proporcional ao teto diário ────────
    const planned = enabledSp.map((campaign: any) => ({
      campaign,
      cid: String(campaign.amazon_campaign_id || campaign.campaign_id || ''),
      current: Number(campaign.daily_budget || 0),
      next: minBudget > 0 ? Math.max(Number(campaign.daily_budget || 0), minBudget) : Number(campaign.daily_budget || 0),
    }));
    // O teto diário (daily_budget_limit) é aplicado pelo AccountDailySpendController
    // e pelos motores de pacing — nunca pela soma nominal dos budgets (conflito
    // conhecido entre mínimo por campanha × teto quando há muitas campanhas).
    const adjustments = planned
      .filter((plan: any) => Math.abs(r2(plan.next) - r2(plan.current)) >= 0.01)
      .map((plan: any) => ({
        campaign_id: plan.cid,
        db_id: plan.campaign.id,
        new_budget: r2(plan.next),
        reason: 'canonical_settings_propagation',
      }));

    if (body.dry_run === true) {
      return Response.json({
        ok: true,
        dry_run: true,
        daily_cap: dailyCap,
        min_budget: minBudget,
        campaigns_enabled: enabledSp.length,
        budget_adjustments: adjustments.slice(0, 50),
        placements: { top: goal(perf.top_of_search_limit), rest: goal(perf.rest_of_search_limit), product: goal(perf.product_page_limit), enabled: perf.placement_optimization_enabled !== false },
      });
    }

    if (adjustments.length > 0) {
      const response = await base44.functions.invoke('adjustCampaignBudgets', {
        amazon_account_id: aid,
        adjustments,
        _service_role: true,
      }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
      results.budgets = { attempted: adjustments.length, ...(response?.data || response || {}) };
    } else {
      results.budgets = { attempted: 0, ok: true, message: 'Nenhum ajuste de budget necessário' };
    }

    // Validação/reforço do budget mínimo (função existente)
    if (minBudget > 0) {
      const response = await base44.functions.invoke('validateCampaignBudgets', {
        amazon_account_id: aid,
        minimum_campaign_budget: minBudget,
        apply_fixes: true,
        trigger: 'canonical_settings_propagation',
      }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
      results.validation = response?.data || response || {};
    }

    // ── 2. Placements ────────────────────────────────────────────────────────
    const tos = goal(perf.top_of_search_limit);
    const ros = goal(perf.rest_of_search_limit);
    const pp = goal(perf.product_page_limit);
    if (perf.placement_optimization_enabled !== false && (tos > 0 || ros > 0 || pp > 0)) {
      const placementResults: any[] = [];
      for (const campaign of enabledSp.slice(0, 25)) {
        const cid = String(campaign.amazon_campaign_id || campaign.campaign_id || '');
        const response = await base44.functions.invoke('updatePlacements', {
          amazon_account_id: aid,
          campaign_id: cid,
          placement_top: tos > 0 ? tos : null,
          placement_rest: ros > 0 ? ros : null,
          placement_product: pp > 0 ? pp : null,
        }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
        const data = response?.data || response || {};
        placementResults.push({ campaign_id: cid, ok: data?.ok === true, error: data?.ok === true ? null : String(data?.error || '').slice(0, 200) });
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      results.placements = {
        attempted: placementResults.length,
        succeeded: placementResults.filter((item) => item.ok).length,
        failed: placementResults.filter((item) => !item.ok).length,
        items: placementResults.slice(0, 50),
      };
    } else {
      results.placements = { attempted: 0, skipped: tos + ros + pp === 0 ? 'limites zerados (ignorados)' : 'placement_optimization desativado' };
    }

    // ── 3. AccountDailySpendController do dia ────────────────────────────────
    if (dailyCap > 0) {
      const controllers = await base44.asServiceRole.entities.AccountDailySpendController.filter(
        { amazon_account_id: aid, spend_date: todayBRT }, null, 1,
      ).catch(() => []);
      const capPayload = { user_daily_spend_cap: dailyCap, effective_daily_spend_cap: dailyCap, updated_by: user.id, cap_updated_at: now, updated_at: now };
      if (controllers[0]) {
        await base44.asServiceRole.entities.AccountDailySpendController.update(controllers[0].id, capPayload).catch(() => {});
      } else {
        await base44.asServiceRole.entities.AccountDailySpendController.create({
          amazon_account_id: aid,
          spend_date: todayBRT,
          timezone: 'America/Sao_Paulo',
          ...capPayload,
          cap_status: 'safe',
          created_at: now,
        }).catch(() => {});
      }
      results.controller = { ok: true, cap: dailyCap };
    }

    const failures =
      (results.budgets?.ok === false ? 1 : 0) +
      (results.placements?.failed || 0) +
      (results.validation?.ok === false ? 1 : 0);

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'canonical_settings_propagation',
      trigger_type: String(body.trigger || 'manual'),
      status: failures === 0 ? 'success' : 'partial',
      execution_date: todayBRT,
      started_at: new Date(startedAt).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      records_processed: (results.budgets?.attempted || 0) + (results.placements?.attempted || 0),
      result_summary: JSON.stringify({
        budgets: { attempted: results.budgets?.attempted, ok: results.budgets?.ok },
        placements: { attempted: results.placements?.attempted, succeeded: results.placements?.succeeded, failed: results.placements?.failed },
        controller: results.controller,
        daily_cap: dailyCap,
        min_budget: minBudget,
      }).slice(0, 1500),
      error_message: failures > 0 ? `${failures} etapa(s) com erro na propagação canônica.` : null,
    }).catch(() => {});

    // ── Pull canônico: reler métricas confirmadas da Amazon ─────────────────
    waitUntil(
      base44.functions.invoke('syncUnifiedAdsReportsDaily', { amazon_account_id: aid, trigger: 'canonical_settings_propagation' }).catch(() => {}),
    );

    return Response.json({ ok: failures === 0, results, duration_ms: Date.now() - startedAt });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha na propagação canônica' }, { status: 500 });
  }
}