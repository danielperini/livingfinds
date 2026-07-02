/**
 * weeklyBudgetUpdate — Toda sexta-feira:
 * 1. Calcula spend médio diário real com dados das APIs e relatórios importados como fonte da verdade.
 *    Ordem de prioridade: AdsMetricsHistory (relatórios processados) → AdsReportRaw (relatórios brutos)
 *    → CampaignMetricsDaily (fallback).
 * 2. Atualiza max_daily_budget_limit da conta (arredondado para CIMA).
 * 3. Garante budget mínimo de R$15 em todas as campanhas ativas/pausadas.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const PAGE = 200;

async function loadAllCampaigns(base44, amazonAccountId) {
  const all = [];
  let offset = 0;
  while (true) {
    const page = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: amazonAccountId },
      '-created_date',
      PAGE,
      offset
    );
    all.push(...page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

/** Deduplica registros por (campaign_id + date) e agrega spend por dia → retorna array de spend diário */
function aggregateDailySpend(records) {
  const dedupMap = new Map();
  for (const m of records) {
    const key = `${m.campaign_id || 'global'}-${m.date || m.report_date}`;
    if (!dedupMap.has(key)) dedupMap.set(key, m);
  }
  const spendByDay = {};
  for (const m of dedupMap.values()) {
    const day = m.date || m.report_date;
    if (!day) continue;
    spendByDay[day] = (spendByDay[day] || 0) + (m.spend || 0);
  }
  return Object.values(spendByDay);
}

/** Extrai spend total de registros AdsReportRaw (raw_data pode ser objeto ou string JSON) */
function extractSpendFromRaw(records) {
  const spendByDay = {};
  for (const r of records) {
    const day = r.report_date || r.period_end;
    if (!day) continue;
    let spend = 0;
    try {
      const data = typeof r.raw_data === 'string' ? JSON.parse(r.raw_data) : (r.raw_data || {});
      // raw_data pode ser array de linhas de relatório ou objeto com totalSpend
      if (Array.isArray(data)) {
        spend = data.reduce((s, row) => s + (Number(row.spend || row.cost || 0)), 0);
      } else {
        spend = Number(data.spend || data.totalSpend || data.cost || 0);
      }
    } catch { spend = 0; }
    spendByDay[day] = (spendByDay[day] || 0) + spend;
  }
  return Object.values(spendByDay);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    const body = await req.json().catch(() => ({}));
    let accounts = [];
    if (body.amazon_account_id) {
      accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
    } else {
      accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });
    }

    if (!accounts.length) {
      return Response.json({ ok: false, message: 'Nenhuma conta Amazon conectada.' });
    }

    const results = [];
    const twentyDaysAgo = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);

    for (const account of accounts) {
      const aid = account.id;
      const now = new Date().toISOString();
      const MIN_CAMPAIGN_BUDGET = 15;

      // ── FONTE 1: AdsMetricsHistory — relatórios processados (fonte primária) ──
      const adsMetrics = await base44.asServiceRole.entities.AdsMetricsHistory.filter(
        { amazon_account_id: aid, date: { $gte: twentyDaysAgo }, report_type: 'campaigns' },
        '-date',
        3000
      );

      let spendDays = aggregateDailySpend(adsMetrics);
      let dataSource = 'AdsMetricsHistory';

      // ── FONTE 2: AdsReportRaw — relatórios brutos importados ──
      if (spendDays.length < 5) {
        const rawReports = await base44.asServiceRole.entities.AdsReportRaw.filter(
          { amazon_account_id: aid, report_date: { $gte: twentyDaysAgo }, report_type: 'campaigns' },
          '-report_date',
          500
        );
        const rawSpendDays = extractSpendFromRaw(rawReports);
        if (rawSpendDays.length > spendDays.length) {
          spendDays = rawSpendDays;
          dataSource = 'AdsReportRaw';
        }
      }

      // ── FONTE 3: CampaignMetricsDaily — fallback ──
      if (spendDays.length < 3) {
        const dailyMetrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
          { amazon_account_id: aid, date: { $gte: twentyDaysAgo } },
          '-date',
          2000
        );
        const fallbackDays = aggregateDailySpend(dailyMetrics);
        if (fallbackDays.length > spendDays.length) {
          spendDays = fallbackDays;
          dataSource = 'CampaignMetricsDaily (fallback)';
        }
      }

      const avgDailySpend = spendDays.length > 0
        ? spendDays.reduce((s, v) => s + v, 0) / spendDays.length
        : 0;

      if (avgDailySpend <= 0) {
        results.push({ account_id: aid, skipped: true, reason: `Sem dados de spend em nenhuma fonte.` });
        continue;
      }

      // ── Calcular budget sugerido ──
      const campaigns = await loadAllCampaigns(base44, aid);
      const activeBudgetTotal = campaigns
        .filter(c => (c.state === 'enabled' || c.status === 'enabled') && !c.archived && c.state !== 'archived')
        .reduce((s, c) => s + (c.daily_budget || 0), 0);

      const rawSuggested = Math.min(
        avgDailySpend * 1.2,
        Math.max(activeBudgetTotal, avgDailySpend * 1.5)
      );
      const newBudget = Math.ceil(rawSuggested);
      const oldBudget = account.max_daily_budget_limit || 0;

      // ── Atualizar budget geral máximo da conta ──
      await base44.asServiceRole.entities.AmazonAccount.update(aid, {
        max_daily_budget_limit: newBudget,
      });

      await base44.asServiceRole.entities.CampaignChangeHistory.create({
        amazon_account_id: aid,
        campaign_id: 'account_level',
        change_type: 'BUDGET_RULE',
        entity_type: 'account',
        entity_id: aid,
        field_name: 'max_daily_budget_limit',
        old_value: String(oldBudget),
        new_value: String(newBudget),
        source: 'SCHEDULE_RULE',
        source_function: 'weeklyBudgetUpdate',
        reason: `Atualização semanal (sexta-feira). Fonte: ${dataSource}. Spend médio ${avgDailySpend.toFixed(2)} × 1.2 = ${rawSuggested.toFixed(2)} → arredondado para cima: ${newBudget}. Dias analisados: ${spendDays.length}.`,
        changed_at: now,
        changed_by: 'autopilot',
      });

      // ── Garantir budget mínimo R$15 em todas as campanhas ativas/pausadas ──
      const operationalCampaigns = campaigns.filter(
        c => c.state !== 'archived' && c.status !== 'archived' && !c.archived
      );

      let campaignsUpdated = 0;
      const campaignUpdates = [];

      for (const c of operationalCampaigns) {
        const currentCampBudget = c.daily_budget || 0;
        if (currentCampBudget < MIN_CAMPAIGN_BUDGET) {
          campaignUpdates.push({ id: c.id, daily_budget: MIN_CAMPAIGN_BUDGET });

          await base44.asServiceRole.entities.CampaignChangeHistory.create({
            amazon_account_id: aid,
            campaign_id: c.campaign_id,
            change_type: 'CAMPAIGN_BUDGET',
            entity_type: 'campaign',
            entity_id: c.campaign_id,
            field_name: 'daily_budget',
            old_value: String(currentCampBudget),
            new_value: String(MIN_CAMPAIGN_BUDGET),
            source: 'SCHEDULE_RULE',
            source_function: 'weeklyBudgetUpdate',
            reason: `Budget mínimo R$${MIN_CAMPAIGN_BUDGET} aplicado na atualização semanal. Era R$${currentCampBudget.toFixed(2)}.`,
            changed_at: now,
            changed_by: 'autopilot',
          });

          campaignsUpdated++;
        }
      }

      for (let i = 0; i < campaignUpdates.length; i += 50) {
        await base44.asServiceRole.entities.Campaign.bulkUpdate(campaignUpdates.slice(i, i + 50));
      }

      results.push({
        account_id: aid,
        old_budget: oldBudget,
        new_budget: newBudget,
        avg_daily_spend: Number(avgDailySpend.toFixed(2)),
        raw_suggested: Number(rawSuggested.toFixed(2)),
        days_analyzed: spendDays.length,
        data_source: dataSource,
        campaigns_enforced_min_budget: campaignsUpdated,
      });
    }

    return Response.json({ ok: true, updated: results.filter(r => !r.skipped).length, results });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});