/**
 * applyDailyBudgetAdjustment
 *
 * Ajusta o daily_budget de cada campanha ativa com base no gasto real
 * dos últimos 14 dias (média × 1.25), distribuído proporcionalmente.
 *
 * Guardrails:
 *  - Budget mínimo por campanha: R$5,00
 *  - Budget máximo por campanha: AutopilotConfig.maximum_campaign_budget (default R$200)
 *  - Variação máxima por execução: ±30% do atual (evita choques bruscos)
 *  - Só aplica se novo valor diferir > 5% do atual (evita micro-ajustes)
 *  - Salva histórico em CampaignChangeHistory
 *
 * Payload:
 *   amazon_account_id — obrigatório
 *   dry_run           — opcional (default false) — lista o que seria feito sem aplicar
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const PAGE = 200;

async function loadAll(entity: any, query: any, sort: string, limit: number) {
  const all: any[] = [];
  let offset = 0;
  while (true) {
    const page = await entity.filter(query, sort, limit, offset);
    all.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  return all;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false } = body;

    if (!amazon_account_id) {
      return Response.json({ ok: false, error: 'amazon_account_id é obrigatório.' }, { status: 400 });
    }

    const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id });
    const account = accs[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada.' });

    const aid = account.id;
    const now = new Date().toISOString();
    const sym = account.currency_symbol || 'R$';

    // ── Carregar AutopilotConfig para guardrails ─────────────────────────────
    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid });
    const cfg = configs[0] || {};
    const MAX_CAMPAIGN_BUDGET = cfg.maximum_campaign_budget || 200;
    const MIN_CAMPAIGN_BUDGET = 5;
    const MAX_CHANGE_PCT = 0.30; // ±30% por execução

    // ── Janela: últimos 14 dias (excluindo hoje) ─────────────────────────────
    const today = now.slice(0, 10);
    const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);

    // ── Carregar gasto real por campanha nos últimos 14 dias ─────────────────
    // Fonte 1: CampaignMetricsDaily
    const metricsRaw = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: aid },
      '-date',
      3000
    );

    // Spend total por campaign_id nos últimos 14 dias
    const spendByCampaign: Record<string, { total: number; days: Set<string> }> = {};
    for (const m of metricsRaw) {
      if (!m.date || m.date < fourteenDaysAgo || m.date >= today) continue;
      const cid = m.campaign_id;
      if (!cid) continue;
      if (!spendByCampaign[cid]) spendByCampaign[cid] = { total: 0, days: new Set() };
      spendByCampaign[cid].total += m.spend || 0;
      spendByCampaign[cid].days.add(m.date);
    }

    // Fonte 2: Campaign.spend como fallback quando não há métricas diárias
    // (campo spend = acumulado 30d, usado apenas quando não há métricas)

    // ── Carregar campanhas ativas ────────────────────────────────────────────
    const allCampaigns = await loadAll(
      base44.asServiceRole.entities.Campaign,
      { amazon_account_id: aid },
      '-created_date',
      PAGE
    );

    const activeCampaigns = allCampaigns.filter((c: any) =>
      (c.state === 'enabled' || c.status === 'enabled') &&
      c.state !== 'archived' &&
      !c.archived
    );

    if (activeCampaigns.length === 0) {
      return Response.json({ ok: true, message: 'Nenhuma campanha ativa encontrada.', adjustments: [] });
    }

    // ── Calcular spend médio diário total da conta nos últimos 14 dias ───────
    // Deduplica por (campaign_id + date)
    const seenDayKeys = new Set<string>();
    const spendByDay: Record<string, number> = {};
    for (const m of metricsRaw) {
      if (!m.date || m.date < fourteenDaysAgo || m.date >= today) continue;
      const key = `${m.campaign_id || ''}-${m.date}`;
      if (seenDayKeys.has(key)) continue;
      seenDayKeys.add(key);
      spendByDay[m.date] = (spendByDay[m.date] || 0) + (m.spend || 0);
    }

    const spendDays = Object.values(spendByDay);
    const numDays = spendDays.length;

    // Fallback: usar campaign.spend (acumulado) / 30 se sem métricas diárias
    let avgDailySpendAccount: number;
    let dataSource: string;

    if (numDays >= 3) {
      avgDailySpendAccount = spendDays.reduce((s, v) => s + v, 0) / numDays;
      dataSource = `CampaignMetricsDaily (${numDays} dias)`;
    } else {
      // Fallback: soma de campaign.spend / 30
      const totalCampSpend = activeCampaigns.reduce((s: number, c: any) => s + (c.spend || 0), 0);
      avgDailySpendAccount = totalCampSpend / 30;
      dataSource = 'Campaign.spend (fallback 30d)';
    }

    if (avgDailySpendAccount <= 0) {
      return Response.json({
        ok: false,
        message: 'Sem dados de spend suficientes para ajuste. Execute um sync primeiro.',
        data_source: dataSource,
      });
    }

    // ── Budget total alvo = média 14d × 1.25 ────────────────────────────────
    const targetTotalBudget = Math.max(MIN_CAMPAIGN_BUDGET * activeCampaigns.length, avgDailySpendAccount * 1.25);

    // ── Distribuir proporcionalmente por campanha ────────────────────────────
    // Peso de cada campanha = média de spend próprio / total médio
    // Se campanha não tem dados históricos, usa peso médio
    const totalBudgetCurrent = activeCampaigns.reduce((s: number, c: any) => s + (c.daily_budget || 0), 0);

    const adjustments: any[] = [];
    const updates: any[] = [];

    for (const campaign of activeCampaigns) {
      const cid = campaign.campaign_id;
      const currentBudget = campaign.daily_budget || MIN_CAMPAIGN_BUDGET;

      // Peso proporcional: gasto médio desta campanha / gasto médio total
      const campData = spendByCampaign[cid];
      let campAvgSpend: number;

      if (campData && campData.days.size >= 2) {
        campAvgSpend = campData.total / campData.days.size;
      } else if (totalBudgetCurrent > 0) {
        // Sem histórico: usa peso proporcional pelo budget atual
        campAvgSpend = (currentBudget / totalBudgetCurrent) * avgDailySpendAccount;
      } else {
        campAvgSpend = avgDailySpendAccount / activeCampaigns.length;
      }

      // Budget alvo para esta campanha = seu spend médio × 1.25
      let targetBudget = campAvgSpend * 1.25;

      // Guardrail 1: mínimo R$5
      targetBudget = Math.max(targetBudget, MIN_CAMPAIGN_BUDGET);

      // Guardrail 2: máximo configurado
      targetBudget = Math.min(targetBudget, MAX_CAMPAIGN_BUDGET);

      // Guardrail 3: variação máxima ±30% do atual
      const maxUp   = currentBudget * (1 + MAX_CHANGE_PCT);
      const maxDown = currentBudget * (1 - MAX_CHANGE_PCT);
      targetBudget = Math.min(targetBudget, maxUp);
      targetBudget = Math.max(targetBudget, maxDown);
      targetBudget = Math.max(targetBudget, MIN_CAMPAIGN_BUDGET); // re-apply min after clamp

      // Arredondar para 2 casas
      targetBudget = Math.round(targetBudget * 100) / 100;

      // Só ajusta se diferença > 5%
      const changePct = Math.abs((targetBudget - currentBudget) / currentBudget);
      if (changePct < 0.05) {
        adjustments.push({
          campaign_id: cid,
          campaign_name: campaign.name || campaign.campaign_name,
          current_budget: currentBudget,
          target_budget: targetBudget,
          change_pct: Number((changePct * 100).toFixed(1)),
          action: 'skipped_no_change',
        });
        continue;
      }

      const direction = targetBudget > currentBudget ? '↑' : '↓';
      adjustments.push({
        campaign_id: cid,
        campaign_name: campaign.name || campaign.campaign_name,
        current_budget: currentBudget,
        target_budget: targetBudget,
        change_pct: Number(((targetBudget - currentBudget) / currentBudget * 100).toFixed(1)),
        camp_avg_spend: Number(campAvgSpend.toFixed(2)),
        action: dry_run ? 'dry_run' : `applied_${direction}`,
      });

      if (!dry_run) {
        updates.push({ id: campaign.id, daily_budget: targetBudget });
      }
    }

    // ── Aplicar atualizações em lotes ────────────────────────────────────────
    let applied = 0;
    if (!dry_run && updates.length > 0) {
      for (let i = 0; i < updates.length; i += 50) {
        await base44.asServiceRole.entities.Campaign.bulkUpdate(updates.slice(i, i + 50));
      }
      applied = updates.length;

      // Registrar no histórico
      const accountBudgetBefore = totalBudgetCurrent;
      const accountBudgetAfter = activeCampaigns.reduce((s: number, c: any) => {
        const adj = adjustments.find(a => a.campaign_id === c.campaign_id && a.action?.startsWith('applied'));
        return s + (adj ? adj.target_budget : (c.daily_budget || 0));
      }, 0);

      await base44.asServiceRole.entities.CampaignChangeHistory.create({
        amazon_account_id: aid,
        campaign_id: 'account_level',
        change_type: 'BUDGET_RULE',
        entity_type: 'account',
        entity_id: aid,
        field_name: 'daily_budget_adjustment',
        old_value: String(Number(accountBudgetBefore.toFixed(2))),
        new_value: String(Number(accountBudgetAfter.toFixed(2))),
        source: 'PERFORMANCE_RULE',
        source_function: 'applyDailyBudgetAdjustment',
        reason: `Ajuste automático diário: média ${numDays > 0 ? numDays : '30'}d ${sym}${avgDailySpendAccount.toFixed(2)}/dia × 1.25 = alvo ${sym}${targetTotalBudget.toFixed(2)}. Fonte: ${dataSource}. ${applied} campanhas ajustadas.`,
        changed_at: now,
        changed_by: 'autopilot',
      }).catch(() => {});

      // Atualizar AutopilotConfig com o budget sugerido calculado
      if (configs.length > 0) {
        await base44.asServiceRole.entities.AutopilotConfig.update(configs[0].id, {
          ai_suggested_daily_budget: Number(targetTotalBudget.toFixed(2)),
          ai_budget_reasoning: `Média real ${dataSource}: ${sym}${avgDailySpendAccount.toFixed(2)}/dia × 1.25 = ${sym}${targetTotalBudget.toFixed(2)}. ${applied} de ${activeCampaigns.length} campanhas ajustadas.`,
          ai_budget_confidence: numDays >= 7 ? 90 : numDays >= 3 ? 75 : 50,
          ai_budget_generated_at: now,
        }).catch(() => {});
      }
    }

    const appliedCount = adjustments.filter(a => a.action?.startsWith('applied')).length;
    const skippedCount = adjustments.filter(a => a.action === 'skipped_no_change').length;

    console.log(`[applyDailyBudgetAdjustment] avg=${sym}${avgDailySpendAccount.toFixed(2)}/dia target_total=${sym}${targetTotalBudget.toFixed(2)} applied=${appliedCount} skipped=${skippedCount} dry_run=${dry_run}`);

    return Response.json({
      ok: true,
      dry_run,
      data_source: dataSource,
      num_days_analyzed: numDays,
      avg_daily_spend: Number(avgDailySpendAccount.toFixed(2)),
      target_total_budget: Number(targetTotalBudget.toFixed(2)),
      active_campaigns: activeCampaigns.length,
      campaigns_adjusted: appliedCount,
      campaigns_skipped: skippedCount,
      adjustments,
    });

  } catch (error: any) {
    console.error('[applyDailyBudgetAdjustment]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});