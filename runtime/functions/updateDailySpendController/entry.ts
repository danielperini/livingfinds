/**
 * updateDailySpendController
 *
 * Atualiza o AccountDailySpendController para a data operacional atual (BRT).
 * Calcula: confirmed_spend, pacing, cap_status, projected_total_spend, remaining_spend.
 * Não pausa campanhas — apenas monitora e expõe estado.
 * Chamado pelo motor antes de gerar decisões e pelo guardrail horário.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const TZ_OFFSET_HOURS = -3; // BRT = UTC-3

function getBrtDate(): string {
  const now = new Date();
  const brt = new Date(now.getTime() + TZ_OFFSET_HOURS * 3600000);
  return brt.toISOString().slice(0, 10);
}

function getBrtHour(): number {
  const now = new Date();
  const brt = new Date(now.getTime() + TZ_OFFSET_HOURS * 3600000);
  return brt.getUTCHours();
}

function calcCapStatus(spent: number, cap: number): string {
  if (cap <= 0) return 'safe';
  const ratio = spent / cap;
  if (ratio >= 1.0) return 'cap_reached';
  if (ratio >= 0.95) return 'cap_imminent';
  if (ratio >= 0.85) return 'critical';
  if (ratio >= 0.70) return 'attention';
  return 'safe';
}

function calcPacing(confirmed: number, cap: number, currentHour: number): { status: string; ratio: number } {
  if (cap <= 0 || currentHour <= 0) return { status: 'unknown', ratio: 0 };
  // Esperado: distribuição linear ao longo do dia (0-23h)
  const expectedFraction = Math.min(1, currentHour / 24);
  const expectedSpend = cap * expectedFraction;
  if (expectedSpend <= 0) return { status: 'unknown', ratio: 0 };
  const ratio = Math.round((confirmed / expectedSpend) * 100) / 100;
  const status = ratio < 0.70 ? 'underpacing' : ratio > 1.20 ? 'overpacing' : 'on_track';
  return { status, ratio };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const now = new Date().toISOString();
    const spendDate = getBrtDate();
    const currentHour = getBrtHour();

    // Resolver conta
    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' });
    const aid = account.id;

    // Carregar PerformanceSettings para user_daily_spend_cap
    let userCap = 70;
    try {
      const psList = await base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1);
      if (psList[0]?.daily_budget_limit > 0) userCap = Number(psList[0].daily_budget_limit);
    } catch {}

    // Gasto confirmado de hoje via CampaignMetricsDaily
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const metricsToday = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: aid, date: spendDate }, null, 500
    ).catch(() => []);
    const metricsYesterday = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: aid, date: yesterday }, null, 500
    ).catch(() => []);

    // Se não há métricas de hoje, usar yesterday como fallback para estimated_pending
    const confirmedSpend = metricsToday.reduce((s: number, m: any) => s + (m.spend || 0), 0);
    const yesterdaySpend = metricsYesterday.reduce((s: number, m: any) => s + (m.spend || 0), 0);

    // Estimar gasto pendente: ritmo atual × horas restantes
    const hoursElapsed = Math.max(1, currentHour);
    const hoursRemaining = Math.max(0, 24 - hoursElapsed);
    const spendRatePerHour = confirmedSpend > 0 ? confirmedSpend / hoursElapsed : yesterdaySpend / 24;
    const estimatedPending = Math.round(spendRatePerHour * hoursRemaining * 100) / 100;

    // Soma nominal de budgets das campanhas
    const campaigns = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 200).catch(() => []);
    const activeCamps = campaigns.filter((c: any) => {
      const s = String(c.state || c.status || '').toLowerCase();
      return s === 'enabled' || s === 'active';
    });
    const totalNominalBudget = activeCamps.reduce((s: number, c: any) => s + Number(c.daily_budget || c.budget || 0), 0);

    // Campanhas com budget limitado (gasto >= 90% do budget)
    const campMetrics14d = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: aid }, '-date', 100
    ).catch(() => []);
    const todayByCamp = new Map<string, number>();
    for (const m of campMetrics14d) {
      if (m.date === spendDate && m.campaign_id) {
        todayByCamp.set(m.campaign_id, (todayByCamp.get(m.campaign_id) || 0) + (m.spend || 0));
      }
    }
    let budgetLimitedCount = 0;
    for (const c of activeCamps) {
      const cid = c.campaign_id || c.amazon_campaign_id || c.id;
      const budget = Number(c.daily_budget || c.budget || 0);
      const spent = todayByCamp.get(cid) || 0;
      if (budget > 0 && spent / budget >= 0.90) budgetLimitedCount++;
    }

    // Campanhas pausadas pelo teto hoje
    let pausedToday: string[] = [];
    try {
      const existing = await base44.asServiceRole.entities.AccountDailySpendController.filter(
        { amazon_account_id: aid, spend_date: spendDate }, null, 1
      );
      if (existing[0]?.campaigns_paused_today) pausedToday = existing[0].campaigns_paused_today;
    } catch {}

    // Calcular campos derivados
    const reservedSpend = 0; // sem reserva ativa agora
    const projectedTotal = Math.round((confirmedSpend + estimatedPending + reservedSpend) * 100) / 100;
    const remainingSpend = Math.round((userCap - projectedTotal) * 100) / 100;
    const capStatus = calcCapStatus(projectedTotal, userCap);
    const pacing = calcPacing(confirmedSpend, userCap, currentHour);

    // Upsert: buscar registro existente do dia
    const existingList = await base44.asServiceRole.entities.AccountDailySpendController.filter(
      { amazon_account_id: aid, spend_date: spendDate }, null, 1
    ).catch(() => []);

    const payload = {
      amazon_account_id: aid,
      marketplace_id: account.marketplace_id || 'A2Q3Y263D00KWC',
      spend_date: spendDate,
      timezone: 'America/Sao_Paulo',
      user_daily_spend_cap: userCap,
      effective_daily_spend_cap: userCap,
      confirmed_spend: Math.round(confirmedSpend * 100) / 100,
      estimated_pending_spend: estimatedPending,
      reserved_spend: reservedSpend,
      projected_total_spend: projectedTotal,
      remaining_spend: remainingSpend,
      cap_status: capStatus,
      spend_pacing: pacing.status,
      pacing_ratio: pacing.ratio,
      current_hour_brt: currentHour,
      total_campaign_budget_nominal: Math.round(totalNominalBudget * 100) / 100,
      campaigns_budget_limited_count: budgetLimitedCount,
      campaigns_paused_today: pausedToday,
      campaigns_paused_count: pausedToday.length,
      last_ads_sync_at: account.ads_data_fresh_at || account.last_sync_at || null,
      last_action_at: now,
      last_pacing_check_at: now,
      updated_at: now,
    };

    let record: any;
    if (existingList[0]) {
      record = await base44.asServiceRole.entities.AccountDailySpendController.update(existingList[0].id, payload);
    } else {
      record = await base44.asServiceRole.entities.AccountDailySpendController.create({ ...payload, created_at: now });
    }

    return Response.json({
      ok: true,
      spend_date: spendDate,
      current_hour_brt: currentHour,
      user_daily_spend_cap: userCap,
      confirmed_spend: Math.round(confirmedSpend * 100) / 100,
      estimated_pending_spend: estimatedPending,
      projected_total_spend: projectedTotal,
      remaining_spend: remainingSpend,
      cap_status: capStatus,
      spend_pacing: pacing.status,
      pacing_ratio: pacing.ratio,
      total_campaign_budget_nominal: Math.round(totalNominalBudget * 100) / 100,
      campaigns_budget_limited_count: budgetLimitedCount,
      campaigns_paused_count: pausedToday.length,
      note: 'A soma nominal dos budgets pode ultrapassar o teto — isso é normal. O teto controla o gasto acumulado real.',
    });

  } catch (error: any) {
    console.error('[updateDailySpendController]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});