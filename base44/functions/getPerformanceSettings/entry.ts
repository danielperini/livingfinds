/**
 * getPerformanceSettings — Fonte Única de Metas do Motor de Decisão
 *
 * Carrega PerformanceSettings do banco (criado via Configurações > Metas de Performance).
 * Fallback em cascata: PerformanceSettings → AutopilotConfig → defaults hardcoded.
 *
 * TODOS os motores devem chamar esta função antes de decidir qualquer coisa.
 * Nenhum motor pode usar valores fixos divergentes dos parâmetros configurados.
 *
 * Retorna objeto padronizado com todos os parâmetros necessários para:
 * - Bid (min, max, aumento/redução máximos)
 * - Budget (diário geral, por campanha, incremento, capacidade semanal)
 * - ACoS (alvo, máximo)
 * - ROAS (alvo)
 * - TACoS (alvo, máximo)
 * - CPC (alvo, máximo, enforcement)
 * - Impressões (meta ativa, alvo, mínimo)
 * - Automações (pacing, dayparting, placement)
 * - Placement (limites por tipo)
 * - IA (auto optimization toggle)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// Defaults absolutos — usados somente se não houver configuração no banco
const SYSTEM_DEFAULTS = {
  primary_metric: 'acos',
  strategic_goal: 'profitability',
  target_acos: 10,
  max_acos: 15,
  target_roas: 4,
  target_tacos: 5,
  max_tacos: 10,
  daily_budget_cap: 56,
  target_cpc: 0.60,
  max_cpc: 1.00,
  enforce_max_cpc: true,
  impressions_goal_enabled: false,
  target_daily_impressions: 0,
  minimum_daily_impressions: 0,
  min_bid: 0.40,
  max_bid: 1.00,
  max_bid_increase_percent: 20,
  max_bid_decrease_percent: 20,
  min_campaign_budget: 15,
  budget_increment_allowed: 5,
  weekly_campaign_capacity: 10,
  pacing_enabled: true,
  dayparting_enabled: true,
  placement_optimization_enabled: true,
  max_top_of_search_adjustment: 0,
  max_rest_of_search_adjustment: 0,
  max_product_pages_adjustment: 0,
  ai_auto_optimization_enabled: false,
};

function buildSettingsFromPerformanceSettings(ps: any) {
  return {
    primary_metric: ps.primary_goal || SYSTEM_DEFAULTS.primary_metric,
    strategic_goal: ps.objective || SYSTEM_DEFAULTS.strategic_goal,
    target_acos: Number(ps.target_acos ?? SYSTEM_DEFAULTS.target_acos),
    max_acos: Number(ps.max_acos ?? SYSTEM_DEFAULTS.max_acos),
    target_roas: Number(ps.target_roas ?? SYSTEM_DEFAULTS.target_roas),
    target_tacos: Number(ps.target_tacos ?? SYSTEM_DEFAULTS.target_tacos),
    max_tacos: Number(ps.max_tacos ?? SYSTEM_DEFAULTS.max_tacos),
    daily_budget_cap: Number(ps.daily_budget_limit ?? SYSTEM_DEFAULTS.daily_budget_cap),
    target_cpc: Number(ps.target_cpc ?? SYSTEM_DEFAULTS.target_cpc),
    max_cpc: Number(ps.max_cpc ?? SYSTEM_DEFAULTS.max_cpc),
    enforce_max_cpc: ps.max_cpc > 0,
    impressions_goal_enabled: Boolean(ps.impressions_goal_enabled ?? SYSTEM_DEFAULTS.impressions_goal_enabled),
    target_daily_impressions: Number(ps.target_daily_impressions ?? SYSTEM_DEFAULTS.target_daily_impressions),
    minimum_daily_impressions: Number(ps.min_daily_impressions ?? SYSTEM_DEFAULTS.minimum_daily_impressions),
    min_bid: Number(ps.min_bid ?? SYSTEM_DEFAULTS.min_bid),
    max_bid: Number(ps.max_bid ?? SYSTEM_DEFAULTS.max_bid),
    max_bid_increase_percent: Number(ps.max_bid_increase_pct ?? SYSTEM_DEFAULTS.max_bid_increase_percent),
    max_bid_decrease_percent: Number(ps.max_bid_decrease_pct ?? SYSTEM_DEFAULTS.max_bid_decrease_percent),
    min_campaign_budget: Number(ps.minimum_campaign_budget ?? SYSTEM_DEFAULTS.min_campaign_budget),
    budget_increment_allowed: Number(ps.campaign_budget_increment ?? SYSTEM_DEFAULTS.budget_increment_allowed),
    weekly_campaign_capacity: Number(ps.weekly_campaign_capacity ?? SYSTEM_DEFAULTS.weekly_campaign_capacity),
    pacing_enabled: Boolean(ps.pacing_enabled ?? SYSTEM_DEFAULTS.pacing_enabled),
    dayparting_enabled: Boolean(ps.dayparting_enabled ?? SYSTEM_DEFAULTS.dayparting_enabled),
    placement_optimization_enabled: Boolean(ps.placement_optimization_enabled ?? SYSTEM_DEFAULTS.placement_optimization_enabled),
    max_top_of_search_adjustment: Number(ps.top_of_search_limit ?? SYSTEM_DEFAULTS.max_top_of_search_adjustment),
    max_rest_of_search_adjustment: Number(ps.rest_of_search_limit ?? SYSTEM_DEFAULTS.max_rest_of_search_adjustment),
    max_product_pages_adjustment: Number(ps.product_page_limit ?? SYSTEM_DEFAULTS.max_product_pages_adjustment),
    ai_auto_optimization_enabled: Boolean(ps.ai_auto_optimization ?? SYSTEM_DEFAULTS.ai_auto_optimization_enabled),
    source: 'PerformanceSettings',
  };
}

function buildSettingsFromAutopilotConfig(cfg: any) {
  return {
    primary_metric: SYSTEM_DEFAULTS.primary_metric,
    strategic_goal: cfg.objective || SYSTEM_DEFAULTS.strategic_goal,
    target_acos: Number(cfg.target_acos ?? SYSTEM_DEFAULTS.target_acos),
    max_acos: Number(cfg.maximum_acos ?? SYSTEM_DEFAULTS.max_acos),
    target_roas: Number(cfg.target_roas ?? SYSTEM_DEFAULTS.target_roas),
    target_tacos: Number(cfg.target_tacos ?? SYSTEM_DEFAULTS.target_tacos),
    max_tacos: Number(cfg.maximum_tacos ?? SYSTEM_DEFAULTS.max_tacos),
    daily_budget_cap: Number(cfg.total_daily_budget ?? cfg.daily_budget_limit ?? SYSTEM_DEFAULTS.daily_budget_cap),
    target_cpc: Number(cfg.target_cpc ?? SYSTEM_DEFAULTS.target_cpc),
    max_cpc: Number(cfg.maximum_cpc ?? SYSTEM_DEFAULTS.max_cpc),
    enforce_max_cpc: Boolean(cfg.cpc_enforcement ?? SYSTEM_DEFAULTS.enforce_max_cpc),
    impressions_goal_enabled: Boolean(cfg.impressions_goal_enabled ?? SYSTEM_DEFAULTS.impressions_goal_enabled),
    target_daily_impressions: Number(cfg.target_daily_impressions ?? SYSTEM_DEFAULTS.target_daily_impressions),
    minimum_daily_impressions: Number(cfg.min_daily_impressions ?? SYSTEM_DEFAULTS.minimum_daily_impressions),
    min_bid: Number(cfg.min_bid ?? SYSTEM_DEFAULTS.min_bid),
    max_bid: Number(cfg.max_bid ?? SYSTEM_DEFAULTS.max_bid),
    max_bid_increase_percent: Number(cfg.max_bid_increase_pct ?? SYSTEM_DEFAULTS.max_bid_increase_percent),
    max_bid_decrease_percent: Number(cfg.max_bid_decrease_pct ?? SYSTEM_DEFAULTS.max_bid_decrease_percent),
    min_campaign_budget: Number(cfg.minimum_stock_days ? 15 : SYSTEM_DEFAULTS.min_campaign_budget), // AutopilotConfig não tem campo direto
    budget_increment_allowed: SYSTEM_DEFAULTS.budget_increment_allowed,
    weekly_campaign_capacity: SYSTEM_DEFAULTS.weekly_campaign_capacity,
    pacing_enabled: Boolean(cfg.budget_optimization_enabled ?? SYSTEM_DEFAULTS.pacing_enabled),
    dayparting_enabled: Boolean(cfg.dayparting_enabled ?? SYSTEM_DEFAULTS.dayparting_enabled),
    placement_optimization_enabled: Boolean(cfg.placement_optimization_enabled ?? SYSTEM_DEFAULTS.placement_optimization_enabled),
    max_top_of_search_adjustment: Number(cfg.top_of_search_limit ?? SYSTEM_DEFAULTS.max_top_of_search_adjustment),
    max_rest_of_search_adjustment: Number(cfg.rest_of_search_limit ?? SYSTEM_DEFAULTS.max_rest_of_search_adjustment),
    max_product_pages_adjustment: Number(cfg.product_page_limit ?? SYSTEM_DEFAULTS.max_product_pages_adjustment),
    ai_auto_optimization_enabled: Boolean(cfg.ai_auto_optimization ?? SYSTEM_DEFAULTS.ai_auto_optimization_enabled),
    source: 'AutopilotConfig',
  };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    let amazon_account_id = body.amazon_account_id;

    // Resolver conta se não informado
    if (!amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter(
        { user_id: user.id }, '-created_date', 1
      );
      amazon_account_id = accs[0]?.id;
    }
    if (!amazon_account_id) {
      // Último fallback: conta conectada
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter(
        { status: 'connected' }, '-created_date', 1
      );
      amazon_account_id = accs[0]?.id;
    }
    if (!amazon_account_id) {
      return Response.json({ ok: true, settings: SYSTEM_DEFAULTS, source: 'system_defaults', warning: 'Nenhuma conta encontrada' });
    }

    // 1. Tentar PerformanceSettings (fonte primária)
    const psList = await base44.asServiceRole.entities.PerformanceSettings.filter(
      { amazon_account_id }, '-updated_at', 1
    ).catch(() => []);

    if (psList.length > 0) {
      const settings = buildSettingsFromPerformanceSettings(psList[0]);
      return Response.json({ ok: true, settings, amazon_account_id });
    }

    // 2. Fallback: AutopilotConfig (compatibilidade com registros antigos)
    const apList = await base44.asServiceRole.entities.AutopilotConfig.filter(
      { amazon_account_id }, null, 1
    ).catch(() => []);

    if (apList.length > 0) {
      const settings = buildSettingsFromAutopilotConfig(apList[0]);
      return Response.json({ ok: true, settings, amazon_account_id, warning: 'PerformanceSettings não encontrado. Usando AutopilotConfig como fallback. Acesse Configurações > Metas de Performance para definir a fonte oficial.' });
    }

    // 3. Defaults absolutos do sistema
    return Response.json({
      ok: true,
      settings: { ...SYSTEM_DEFAULTS, source: 'system_defaults' },
      amazon_account_id,
      warning: 'Nenhuma configuração de performance encontrada. Usando defaults do sistema. Acesse Configurações > Metas de Performance.',
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});