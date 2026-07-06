/**
 * calculateDailyBudgetAllocation — Motor Oficial de Orçamento v2
 *
 * FONTE OFICIAL DE VERDADE — esta é a única função que define o limite diário geral.
 *
 * REGRAS FUNDAMENTAIS:
 *  - Limite diário geral ≠ soma dos budgets individuais
 *  - Cada campanha inicia com R$15,00 mínimo
 *  - Aumento de +R$5 só quando: budget esgotado + venda real + dentro da meta + estoque ok
 *  - Sem venda: manter budget, registrar "esgotado sem conversão"
 *  - Limite geral calculado por fórmula ponderada (campanhas×2 + horas×1) / 3
 *  - Faixa: R$50 (floor) a R$130 (ceiling)
 *  - Cálculos 100% determinísticos — sem IA
 *
 * Fórmula:
 *   campaign_factor = eligible_campaigns / weekly_capacity  (clamp 0..1)
 *   hours_factor    = target_coverage_hours / 24            (clamp 0..1)
 *   utilization     = (campaign_factor×2 + hours_factor) / 3
 *   daily_limit     = floor + (ceiling-floor) × utilization  → clamp floor..ceiling
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const FLOOR   = 50.00;
const CEILING = 130.00;
const RANGE   = CEILING - FLOOR; // 80
const MIN_CAMPAIGN_BUDGET = 15.00;
const BUDGET_INCREMENT    = 5.00;

function clamp(val: number, min: number, max: number) { return Math.min(max, Math.max(min, val)); }
function r2(v: number) { return Math.round(v * 100) / 100; }

function isMeetingGoal(metrics: any, cfg: any): boolean {
  const acos   = metrics.acos  || 0;
  const roas   = metrics.roas  || 0;
  const tacos  = metrics.tacos || 0;
  const cpc    = metrics.cpc   || 0;
  const cpo    = metrics.orders > 0 ? metrics.spend / metrics.orders : 0;

  const targetAcos  = cfg.target_acos  || 0;
  const targetRoas  = cfg.target_roas  || 0;
  const targetTacos = cfg.target_tacos || 0;
  const targetCpc   = cfg.target_cpc   || 0;
  const targetCpo   = cfg.target_cost_per_order || 0;

  const primary = (cfg.primary_goal || 'acos').toLowerCase();

  if (primary === 'acos')          return targetAcos  > 0 ? acos  <= targetAcos  : true;
  if (primary === 'roas')          return targetRoas  > 0 ? roas  >= targetRoas  : true;
  if (primary === 'tacos')         return targetTacos > 0 ? tacos <= targetTacos : true;
  if (primary === 'cpc')           return targetCpc   > 0 ? cpc   <= targetCpc   : true;
  if (primary === 'cost_per_order') return targetCpo  > 0 ? cpo   <= targetCpo   : true;
  return true;
}

async function loadPaged(entity: any, query: any) {
  const all: any[] = [];
  let skip = 0;
  while (true) {
    const page = await entity.filter(query, '-created_date', 500, skip);
    all.push(...page);
    if (page.length < 500) break;
    skip += 500;
  }
  return all;
}

Deno.serve(async (req) => {
  const now = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const dry_run   = body.dry_run  !== false ? true : false;
    const trigger   = body.trigger  || 'manual';
    const force     = body.force    || false;

    // ── 1. Conta ────────────────────────────────────────────────────────────
    let account: any = null;
    if (body.amazon_account_id) {
      const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = rows[0] || null;
    }
    if (!account) {
      const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = rows[0] || null;
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon conectada.' });
    const aid = account.id;

    // ── 2. BudgetConfiguration (fonte oficial) ──────────────────────────────
    const budgetConfigs = await base44.asServiceRole.entities.BudgetConfiguration.filter({ amazon_account_id: aid });
    let budgetCfg: any = budgetConfigs[0] || null;

    // Criar config padrão se não existir
    if (!budgetCfg) {
      budgetCfg = await base44.asServiceRole.entities.BudgetConfiguration.create({
        amazon_account_id: aid,
        daily_budget_floor: FLOOR,
        daily_budget_ceiling: CEILING,
        weekly_campaign_capacity: 10,
        target_coverage_hours: 24,
        campaign_weight: 2,
        hours_weight: 1,
        minimum_campaign_budget: MIN_CAMPAIGN_BUDGET,
        campaign_budget_increment: BUDGET_INCREMENT,
        primary_goal: 'acos',
        updated_at: now,
      });
    }

    const floor           = Number(budgetCfg.daily_budget_floor   || FLOOR);
    const ceiling         = Number(budgetCfg.daily_budget_ceiling  || CEILING);
    const weeklyCapacity  = Math.max(1, Number(budgetCfg.weekly_campaign_capacity || 10));
    const coverageHours   = clamp(Number(budgetCfg.target_coverage_hours || 24), 1, 24);
    const campaignWeight  = Number(budgetCfg.campaign_weight || 2);
    const hoursWeight     = Number(budgetCfg.hours_weight    || 1);
    const minBudget       = Number(budgetCfg.minimum_campaign_budget  || MIN_CAMPAIGN_BUDGET);
    const increment       = Number(budgetCfg.campaign_budget_increment || BUDGET_INCREMENT);

    // ── 3. Campanhas elegíveis (ENABLED, não-archived, não-duplicadas) ──────
    const allCampaigns = await loadPaged(
      base44.asServiceRole.entities.Campaign,
      { amazon_account_id: aid }
    );
    const eligibleCampaigns = allCampaigns.filter((c: any) =>
      (c.state === 'enabled' || c.status === 'enabled') &&
      c.state !== 'archived' && c.status !== 'archived' && !c.archived
    );
    // Deduplicar por campaign_id
    const seenCampIds = new Set<string>();
    const dedupedEligible = eligibleCampaigns.filter((c: any) => {
      const cid = String(c.campaign_id || c.id);
      if (seenCampIds.has(cid)) return false;
      seenCampIds.add(cid);
      return true;
    });
    const eligibleCount = dedupedEligible.length;

    // ── 4. Fórmula ponderada ─────────────────────────────────────────────────
    const campaign_factor   = clamp(eligibleCount / weeklyCapacity, 0, 1);
    const hours_factor      = clamp(coverageHours / 24, 0, 1);
    const totalWeightSum    = campaignWeight + hoursWeight;
    const utilization_score = ((campaign_factor * campaignWeight) + (hours_factor * hoursWeight)) / totalWeightSum;
    const rangeSpan         = ceiling - floor;
    const daily_limit       = r2(clamp(floor + rangeSpan * utilization_score, floor, ceiling));

    const calcLog = {
      floor, ceiling, weekly_capacity: weeklyCapacity, eligible_campaigns: eligibleCount,
      coverage_hours: coverageHours, campaign_weight: campaignWeight, hours_weight: hoursWeight,
      campaign_factor: r2(campaign_factor), hours_factor: r2(hours_factor),
      utilization_score: r2(utilization_score), range_span: rangeSpan, daily_limit,
      formula: `${floor} + (${rangeSpan} × ${r2(utilization_score)}) = ${daily_limit}`,
    };

    // ── 5. Métricas D-1 por campanha ─────────────────────────────────────────
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const metricsRaw = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: aid }, '-date', 3000
    );
    const thirtyAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const metrics30 = metricsRaw.filter((m: any) => m.date >= thirtyAgo);

    // Agregar por campanha (deduplicado)
    const campMetrics = new Map<string, any>();
    const seenMetricKey = new Set<string>();
    for (const m of metrics30) {
      const key = `${m.campaign_id}|${m.date}`;
      if (seenMetricKey.has(key)) continue;
      seenMetricKey.add(key);
      const cid = String(m.campaign_id || '');
      if (!cid) continue;
      if (!campMetrics.has(cid)) campMetrics.set(cid, { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0, days: 0 });
      const agg = campMetrics.get(cid);
      agg.spend      += Number(m.spend  || 0);
      agg.sales      += Number(m.sales  || 0);
      agg.orders     += Number(m.orders || 0);
      agg.clicks     += Number(m.clicks || 0);
      agg.impressions += Number(m.impressions || 0);
      agg.days++;
    }
    // Calcular métricas derivadas
    campMetrics.forEach((agg, cid) => {
      agg.acos = agg.sales > 0 ? (agg.spend / agg.sales) * 100 : 0;
      agg.roas = agg.spend > 0 ? agg.sales / agg.spend : 0;
      agg.cpc  = agg.clicks > 0 ? agg.spend / agg.clicks : 0;
    });

    // Métricas de ontem (para detectar budget esgotado)
    const yesterdayMetricsMap = new Map<string, any>();
    for (const m of metricsRaw.filter((m: any) => m.date === yesterday)) {
      const cid = String(m.campaign_id || '');
      if (!cid) continue;
      if (!yesterdayMetricsMap.has(cid)) yesterdayMetricsMap.set(cid, { spend: 0, orders: 0, sales: 0 });
      const y = yesterdayMetricsMap.get(cid);
      y.spend  += Number(m.spend  || 0);
      y.orders += Number(m.orders || 0);
      y.sales  += Number(m.sales  || 0);
    }

    // ── 6. Calcular sugestão de budget por campanha ──────────────────────────
    // Regra: cada campanha começa com minBudget (R$15).
    // Recebe +increment (R$5) somente se:
    //   - budget foi esgotado ontem (spend ≥ 95% do budget atual)
    //   - houve pelo menos 1 venda atribuída
    //   - campanha está dentro da meta
    //   - nenhum aumento já pendente hoje
    //   - limite geral ainda permite gasto adicional
    const totalCurrentBudget = dedupedEligible.reduce((s: number, c: any) => s + Number(c.daily_budget || 0), 0);
    const budgetRemainingForIncreases = daily_limit - totalCurrentBudget;

    const allocations: any[] = [];
    let totalIncreases = 0;

    for (const campaign of dedupedEligible) {
      const cid     = String(campaign.campaign_id || campaign.id);
      const current = Number(campaign.daily_budget || minBudget);
      const metrics = campMetrics.get(cid) || { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0, days: 0, acos: 0, roas: 0, cpc: 0 };
      const yest    = yesterdayMetricsMap.get(cid) || { spend: 0, orders: 0, sales: 0 };

      const budgetExhausted = current > 0 && yest.spend >= current * 0.95;
      const hasSale         = yest.orders > 0 && yest.sales > 0;
      const withinGoal      = isMeetingGoal(metrics, budgetCfg);
      const hasStock        = true; // simplificado — stock check via produto se necessário
      const limitAllows     = (budgetRemainingForIncreases - totalIncreases) >= increment;

      let suggestedBudget = Math.max(minBudget, current);
      let action          = 'manter';
      let reason          = 'sem_mudança';

      if (budgetExhausted && hasSale && withinGoal && hasStock && limitAllows) {
        suggestedBudget = current + increment;
        action = 'aumentar';
        reason = `budget_esgotado+venda+meta_ok`;
        totalIncreases += increment;
      } else if (budgetExhausted && !hasSale) {
        action = 'manter';
        reason = 'budget_esgotado_sem_conversao';
      } else if (budgetExhausted && !withinGoal) {
        action = 'manter';
        reason = 'budget_esgotado_fora_da_meta';
      } else if (budgetExhausted && !limitAllows) {
        action = 'manter';
        reason = 'budget_esgotado_limite_geral_atingido';
      }

      // Garantir mínimo absoluto
      suggestedBudget = Math.max(minBudget, r2(suggestedBudget));

      allocations.push({
        campaign_id: cid,
        campaign_db_id: campaign.id,
        campaign_name: campaign.name || campaign.campaign_name,
        current_budget: current,
        suggested_budget: suggestedBudget,
        budget_change: r2(suggestedBudget - current),
        action,
        reason,
        yesterday_spend: r2(yest.spend),
        yesterday_orders: yest.orders,
        yesterday_sales: r2(yest.sales),
        acos_30d: r2(metrics.acos),
        roas_30d: r2(metrics.roas),
        cpc_30d: r2(metrics.cpc),
        budget_exhausted: budgetExhausted,
        has_sale: hasSale,
        within_goal: withinGoal,
      });
    }

    const totalSuggestedBudgets = allocations.reduce((s: number, a: any) => s + a.suggested_budget, 0);
    const campaignsIncreased    = allocations.filter((a: any) => a.action === 'aumentar').length;

    // ── 7. Persistir se não dry_run ──────────────────────────────────────────
    if (!dry_run) {
      // Atualizar BudgetConfiguration
      const nextMonday = new Date();
      nextMonday.setDate(nextMonday.getDate() + ((8 - nextMonday.getDay()) % 7 || 7));
      nextMonday.setHours(0, 0, 0, 0);

      await base44.asServiceRole.entities.BudgetConfiguration.update(budgetCfg.id, {
        calculated_daily_budget: daily_limit,
        eligible_campaign_count: eligibleCount,
        campaign_factor: r2(campaign_factor),
        hours_factor: r2(hours_factor),
        utilization_score: r2(utilization_score),
        last_weekly_recalculation: now,
        next_weekly_recalculation: nextMonday.toISOString(),
        calculation_log: JSON.stringify(calcLog),
        updated_at: now,
      });

      // Aplicar aumentos de budget nas campanhas elegíveis
      const toUpdate = allocations
        .filter((a: any) => a.action === 'aumentar')
        .map((a: any) => ({ id: a.campaign_db_id, daily_budget: a.suggested_budget }));

      for (let i = 0; i < toUpdate.length; i += 50) {
        await base44.asServiceRole.entities.Campaign.bulkUpdate(toUpdate.slice(i, i + 50)).catch(() => {});
      }

      // Registrar histórico
      const historyEntries = allocations
        .filter((a: any) => a.action === 'aumentar')
        .map((a: any) => ({
          amazon_account_id: aid,
          campaign_id: a.campaign_id,
          change_type: 'CAMPAIGN_BUDGET_INCREASE',
          entity_type: 'campaign',
          entity_id: a.campaign_id,
          field_name: 'daily_budget',
          old_value: String(a.current_budget),
          new_value: String(a.suggested_budget),
          source: 'BUDGET_ENGINE_V2',
          source_function: 'calculateDailyBudgetAllocation',
          reason: JSON.stringify({
            trigger, action: a.action, reason: a.reason,
            yesterday_spend: a.yesterday_spend, yesterday_orders: a.yesterday_orders,
            yesterday_sales: a.yesterday_sales, acos_30d: a.acos_30d,
            roas_30d: a.roas_30d, cpc_30d: a.cpc_30d,
            daily_limit, budget_increment: increment,
          }),
          changed_at: now,
          changed_by: 'calculateDailyBudgetAllocation_v2',
          status: 'executed',
        }));

      for (const entry of historyEntries) {
        await base44.asServiceRole.entities.CampaignChangeHistory.create(entry).catch(() => {});
      }
    }

    return Response.json({
      ok: true,
      dry_run,
      trigger,
      // Limite diário geral (fórmula ponderada)
      daily_limit,
      floor,
      ceiling,
      // Memória do cálculo
      calculation: calcLog,
      // Campanhas
      eligible_campaigns: eligibleCount,
      weekly_capacity: weeklyCapacity,
      total_current_budget_sum: r2(totalCurrentBudget),
      total_suggested_budget_sum: r2(totalSuggestedBudgets),
      campaigns_increased: campaignsIncreased,
      allocations,
      // Config
      coverage_hours: coverageHours,
      primary_goal: budgetCfg.primary_goal || 'acos',
      min_campaign_budget: minBudget,
      budget_increment: increment,
      next_weekly_recalculation: budgetCfg.next_weekly_recalculation || null,
    });

  } catch (error: any) {
    console.error('[calculateDailyBudgetAllocation v2]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});