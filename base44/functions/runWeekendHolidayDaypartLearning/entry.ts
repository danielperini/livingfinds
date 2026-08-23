import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const BRT = 'America/Sao_Paulo';
const LOOKBACK_DAYS = 35;
const MIN_WEEKEND_DAYS = 3;
const MIN_CLICKS = 12;
const MAX_UPLIFT = 20;

function dateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BRT, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  const dow: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour') || 0) % 24, dayOfWeek: dow[get('weekday')] ?? 0 };
}
function r2(v: number) { return Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100; }
function aggregate(rows: any[]) {
  const days = new Set(rows.map((row) => row.date).filter(Boolean));
  const totals = rows.reduce((a, row) => ({ spend: a.spend + Number(row.spend || 0), sales: a.sales + Number(row.sales || 0), orders: a.orders + Number(row.orders || 0), clicks: a.clicks + Number(row.clicks || 0), impressions: a.impressions + Number(row.impressions || 0) }), { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 });
  const dayCount = Math.max(1, days.size);
  return { ...totals, days: days.size, salesPerDay: totals.sales / dayCount, impressionsPerDay: totals.impressions / dayCount, cvr: totals.clicks > 0 ? totals.orders / totals.clicks : 0, ctr: totals.impressions > 0 ? totals.clicks / totals.impressions : 0, acos: totals.sales > 0 ? totals.spend / totals.sales * 100 : null };
}
function isWeekendDate(value: string) {
  const d = new Date(`${value}T12:00:00-03:00`);
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

async function fetchBrazilHolidays(year: number): Promise<string[]> {
  const response = await fetch(`https://brasilapi.com.br/api/feriados/v1/${year}`, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) return [];
  const rows = await response.json().catch(() => []);
  return [...new Set((Array.isArray(rows) ? rows : []).map((row: any) => String(row.date || '')).filter(Boolean))];
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }
    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' }, { status: 404 });

    const aid = account.id;
    const clock = dateParts();
    const [settings, rules, metrics] = await Promise.all([
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1).catch(() => []),
      base44.asServiceRole.entities.AmazonScheduledRule.filter({ amazon_account_id: aid }, '-updated_at', 500).catch(() => []),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 10000).catch(() => []),
    ]);

    const holidayDates = new Set<string>();
    for (const rule of rules) for (const date of Array.isArray(rule.holiday_dates) ? rule.holiday_dates : []) holidayDates.add(String(date));
    for (const date of await fetchBrazilHolidays(Number(clock.date.slice(0, 4)))) holidayDates.add(date);
    const activePeriod = clock.dayOfWeek === 0 || clock.dayOfWeek === 6 || holidayDates.has(clock.date);
    if (!activePeriod) return Response.json({ ok: true, skipped: true, reason: 'not_weekend_or_holiday', current_date: clock.date });

    const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
    const history = metrics.filter((row: any) => String(row.date || '') >= cutoff && String(row.date || '') < clock.date);
    const weekend = aggregate(history.filter((row: any) => isWeekendDate(String(row.date || '')) || holidayDates.has(String(row.date || ''))));
    const weekday = aggregate(history.filter((row: any) => !isWeekendDate(String(row.date || '')) && !holidayDates.has(String(row.date || ''))));
    const perf = settings[0] || {};
    const targetAcos = Number(perf.target_acos || 0);
    if (!(targetAcos > 0)) return Response.json({ ok: true, skipped: true, reason: 'missing_target_acos_source_of_truth' });

    // Sales Engine: a meta de ACoS continua sendo o ideal, não um bloqueio absoluto
    // para disputar leilão em fim de semana. O sinal sazonal pode operar dentro da
    // zona de crescimento; o motor canônico continua fazendo o gate por SKU usando
    // safe CPC, break-even, margem, estoque, buyability e cap diário.
    const configuredMaxAcos = Number(perf.max_acos || perf.maximum_acos || 0);
    const growthAcosCeiling = Math.max(targetAcos, Math.min(
      configuredMaxAcos > 0 ? configuredMaxAcos : targetAcos * 1.45,
      targetAcos * 1.45,
    ));
    const revenueDrop = weekday.salesPerDay > 0 ? 1 - weekend.salesPerDay / weekday.salesPerDay : 0;
    const impressionDrop = weekday.impressionsPerDay > 0 ? 1 - weekend.impressionsPerDay / weekday.impressionsPerDay : 0;
    const cvrRetention = weekday.cvr > 0 ? weekend.cvr / weekday.cvr : 1;
    const evidence = weekend.days >= MIN_WEEKEND_DAYS && weekend.clicks >= MIN_CLICKS;
    const economicallyHealthy = weekend.acos !== null && weekend.acos <= growthAcosCeiling && cvrRetention >= 0.70;
    const lostAuctionOpportunity = revenueDrop >= 0.15 && impressionDrop >= 0.10;

    if (!evidence || !economicallyHealthy || !lostAuctionOpportunity) {
      return Response.json({
        ok: true,
        skipped: true,
        reason: !evidence ? 'insufficient_weekend_evidence' : !economicallyHealthy ? 'weekend_outside_sales_growth_zone' : 'no_evidence_of_lost_auction_opportunity',
        weekend, weekday,
        target_acos: targetAcos,
        growth_acos_ceiling: r2(growthAcosCeiling),
        revenue_drop_pct: r2(revenueDrop * 100),
        impression_drop_pct: r2(impressionDrop * 100),
        cvr_retention_pct: r2(cvrRetention * 100),
      });
    }

    // +10% é a recuperação-base. +15% quando a queda de receita é forte.
    // +20% fica reservado a fim de semana realmente saudável/eficiente.
    const uplift = Math.min(MAX_UPLIFT,
      weekend.acos <= targetAcos * 0.8 && cvrRetention >= 1 ? 20
        : revenueDrop >= 0.30 && cvrRetention >= 0.80 ? 15
        : 10,
    );
    const idem = `${aid}|weekend_holiday_learning|${clock.date}|${clock.hour}|${uplift}`;
    const existing = await base44.asServiceRole.entities.DaypartingDecision.filter({ amazon_account_id: aid, idempotency_key: idem }, '-created_at', 1).catch(() => []);

    if (!existing.length && body.dry_run !== true) {
      await base44.asServiceRole.entities.DaypartingDecision.create({
        amazon_account_id: aid,
        entity_type: 'account',
        entity_id: aid,
        day_of_week: clock.dayOfWeek,
        hour: clock.hour,
        slot_label: `${clock.dayOfWeek}_${clock.hour}h_weekend_holiday`,
        time_slot_score: uplift === 20 ? 95 : uplift === 15 ? 88 : 80,
        slot_classification: 'STRONG_TIME',
        rule_id: 'weekend_holiday_learning_signal',
        rule_version: 'weekend-holiday-learning-sales-v2',
        decision_type: 'MAINTAIN',
        bid_multiplier: 1 + uplift / 100,
        metric_window: `${LOOKBACK_DAYS}d`,
        decision_window: 'current_hour_brt',
        requires_approval: false,
        status: 'executed',
        data_confidence: 'HIGH',
        data_mature: true,
        reason: `Versão Vendas: receita/dia ${r2(revenueDrop * 100)}% abaixo e impressões/dia ${r2(impressionDrop * 100)}% abaixo, CVR retido em ${r2(cvrRetention * 100)}%, ACoS ${r2(Number(weekend.acos))}% dentro da zona de crescimento até ${r2(growthAcosCeiling)}%. Autoriza teste de até +${uplift}% pelo motor canônico; hard guardrails por SKU permanecem obrigatórios.`,
        idempotency_key: idem,
        cycle_date: clock.date,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        executed_at: new Date().toISOString(),
      }).catch(() => null);
    }

    const response = body.dry_run === true
      ? { data: { ok: true, dry_run: true } }
      : await base44.asServiceRole.functions.invoke('runCanonicalDaypartingEngine', {
          amazon_account_id: aid,
          bid_multiplier_override: 1 + uplift / 100,
          trigger_type: 'weekend_holiday_sales_engine',
          _service_role: true,
        }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
    const engine = response?.data || response || {};

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'weekend_holiday_daypart_learning',
      trigger_type: body.trigger_type || 'scheduler',
      status: engine.ok === false ? 'warning' : 'success',
      records_processed: 1,
      result_summary: `Sales Engine sazonal +${uplift}% entregue ao motor único; receita/dia=${r2(revenueDrop * 100)}% abaixo; impressões/dia=${r2(impressionDrop * 100)}% abaixo; CVR_retido=${r2(cvrRetention * 100)}%; ACoS=${r2(Number(weekend.acos))}%; growth_ceiling=${r2(growthAcosCeiling)}%.`,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    }).catch(() => {});

    return Response.json({
      ok: engine.ok !== false,
      weekend_holiday: true,
      sales_engine: true,
      learned_uplift_cap_pct: uplift,
      growth_acos_ceiling: r2(growthAcosCeiling),
      signal_only: true,
      canonical_engine_executed: body.dry_run !== true,
      weekend,
      weekday,
      engine,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});
