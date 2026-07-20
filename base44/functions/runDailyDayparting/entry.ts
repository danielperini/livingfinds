import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

/**
 * runDailyDayparting v3 — Dayparting determinístico orientado a ACoS 15%.
 *
 * Princípios:
 * - usa exclusivamente HourlyMetric real persistido;
 * - nunca infere horário a partir de CSV agregado de campanha;
 * - protege horas/campanhas vencedoras;
 * - nenhum ajuste automático de bid ultrapassa ±20%;
 * - não reduz hora com venda e ACoS <= meta;
 * - exige evidência antes de reduzir gasto sem venda;
 * - somente cria decisão automática com confiança >= 90%;
 * - idempotência diária por conta + campanha.
 */

const TARGET_ACOS = 15;
const MAX_ACOS = 18;
const MAX_INCREASE_PCT = 0.20;
const MAX_DECREASE_PCT = 0.20;
const MIN_DAYS = 7;
const MIN_TOTAL_CLICKS = 30;
const MIN_TOTAL_ORDERS = 2;
const MIN_HOUR_CLICKS_FOR_CUT = 10;
const MIN_HOUR_SPEND_FOR_CUT = 12;

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

function normalizeBid(v: number) {
  return Math.round(v * 100) / 100;
}

function nextBrtHourUtc(hour: number): string {
  const now = new Date();
  const currentBrtHour = (now.getUTCHours() - 3 + 24) % 24;
  let ahead = hour - currentBrtHour;
  if (ahead <= 0) ahead += 24;
  const target = new Date(now.getTime() + ahead * 3600000);
  target.setUTCMinutes(0, 0, 0);
  return target.toISOString();
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  const now = new Date().toISOString();
  const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);

  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    let account: any = null;
    if (body.amazon_account_id) {
      const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1).catch(() => []);
      account = rows[0] || null;
    }
    if (!account) {
      const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1).catch(() => []);
      account = rows[0] || null;
    }
    if (!account) return Response.json({ ok: true, skipped: true, reason: 'Nenhuma conta Amazon conectada.' });

    const aid = account.id;
    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, null, 1).catch(() => []);
    const cfg = configs[0] || {};
    if (cfg.dayparting_enabled === false) {
      return Response.json({ ok: true, skipped: true, reason: 'Dayparting desabilitado.' });
    }

    const minBid = Number(cfg.min_bid || 0.40);
    const maxBid = Number(cfg.max_bid || 5.00);
    const autonomyLevel = Number(cfg.autonomy_level ?? 3);
    const cutoff30d = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    const [campaigns, hourlyMetrics, keywords, products, existingDecisions] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid, status: 'enabled' }, '-spend', 300).catch(() => []),
      base44.asServiceRole.entities.HourlyMetric.filter({ amazon_account_id: aid, date: { $gte: cutoff30d } }, '-date', 5000).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid, state: 'enabled' }, null, 3000).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 1000).catch(() => []),
      base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: aid, action: 'apply_dayparting' }, '-created_at', 500).catch(() => []),
    ]);

    const productByAsin = new Map(products.filter((p: any) => p.asin).map((p: any) => [p.asin, p]));
    const metricsByCampaign = new Map<string, any[]>();
    for (const m of hourlyMetrics) {
      if (!m.campaign_id) continue;
      if (!metricsByCampaign.has(m.campaign_id)) metricsByCampaign.set(m.campaign_id, []);
      metricsByCampaign.get(m.campaign_id)!.push(m);
    }

    const bidsByCampaign = new Map<string, number[]>();
    for (const kw of keywords) {
      if (!kw.campaign_id) continue;
      const bid = Number(kw.current_bid || kw.bid || 0);
      if (!(bid > 0)) continue;
      if (!bidsByCampaign.has(kw.campaign_id)) bidsByCampaign.set(kw.campaign_id, []);
      bidsByCampaign.get(kw.campaign_id)!.push(bid);
    }

    const existingToday = new Set(
      existingDecisions
        .filter((d: any) => (d.created_at || d.created_date || '').slice(0, 10) === today && !['failed', 'cancelled', 'expired', 'rejected'].includes(d.status))
        .map((d: any) => d.campaign_id),
    );

    const stats: any = {
      campaigns_active: campaigns.length,
      analyzed: 0,
      decisions_created: 0,
      auto_applied: 0,
      pending_review: 0,
      skipped_duplicate: 0,
      skipped_no_stock: 0,
      skipped_no_data: 0,
      protected_winners: 0,
      errors: 0,
    };
    const results: any[] = [];
    const errors: any[] = [];

    for (const campaign of campaigns) {
      const cid = campaign.campaign_id || campaign.amazon_campaign_id;
      if (!cid) continue;
      if (existingToday.has(cid)) { stats.skipped_duplicate++; continue; }

      const product: any = campaign.asin ? productByAsin.get(campaign.asin) : null;
      if (product) {
        const qty = Number(product.available_quantity ?? product.total_quantity ?? product.inventory_quantity ?? 0);
        if (product.inventory_status === 'out_of_stock' || qty === 0) {
          stats.skipped_no_stock++;
          continue;
        }
      }

      const rows = metricsByCampaign.get(cid) || [];
      if (!rows.length) { stats.skipped_no_data++; continue; }

      const daysWithData = new Set(rows.filter((r: any) => Number(r.impressions || 0) > 0).map((r: any) => r.date)).size;
      const totalClicks = rows.reduce((s: number, r: any) => s + Number(r.clicks || 0), 0);
      const totalOrders = rows.reduce((s: number, r: any) => s + Number(r.orders || 0), 0);
      const totalSpend = rows.reduce((s: number, r: any) => s + Number(r.spend || 0), 0);
      const totalSales = rows.reduce((s: number, r: any) => s + Number(r.sales || 0), 0);
      const avgAcos = totalSales > 0 ? (totalSpend / totalSales) * 100 : null;
      const avgRoas = totalSpend > 0 ? totalSales / totalSpend : 0;

      if (daysWithData < MIN_DAYS || totalClicks < MIN_TOTAL_CLICKS || totalOrders < MIN_TOTAL_ORDERS) {
        stats.skipped_no_data++;
        continue;
      }

      stats.analyzed++;

      const bids = bidsByCampaign.get(cid) || [];
      const baseBid = normalizeBid(clamp(
        bids.length ? bids.reduce((a, b) => a + b, 0) / bids.length : Number(campaign.default_bid || 0.50),
        minBid,
        maxBid,
      ));

      const matrix: Record<number, any> = {};
      for (let h = 0; h < 24; h++) matrix[h] = { hour: h, clicks: 0, spend: 0, sales: 0, orders: 0, impressions: 0, days: new Set<string>() };
      for (const r of rows) {
        const h = Number(r.hour);
        if (!Number.isInteger(h) || h < 0 || h > 23) continue;
        matrix[h].clicks += Number(r.clicks || 0);
        matrix[h].spend += Number(r.spend || 0);
        matrix[h].sales += Number(r.sales || 0);
        matrix[h].orders += Number(r.orders || 0);
        matrix[h].impressions += Number(r.impressions || 0);
        if (r.date) matrix[h].days.add(r.date);
      }

      const schedule: any[] = [];
      let winnerHours = 0;
      for (let h = 0; h < 24; h++) {
        const d = matrix[h];
        const hourAcos = d.sales > 0 ? (d.spend / d.sales) * 100 : null;
        const hourRoas = d.spend > 0 ? d.sales / d.spend : 0;
        let adjustmentPct = 0;
        let classification = 'hold';

        // Escala apenas quando a campanha também está economicamente dentro da meta.
        if (d.orders >= 1 && hourAcos !== null && hourAcos <= TARGET_ACOS && (avgAcos === null || avgAcos <= TARGET_ACOS)) {
          winnerHours++;
          if (d.clicks >= 8 && hourAcos <= TARGET_ACOS * 0.60) {
            adjustmentPct = 0.10;
            classification = 'peak_high_profit';
          } else if (d.clicks >= 6 && hourAcos <= TARGET_ACOS * 0.80) {
            adjustmentPct = 0.05;
            classification = 'peak_conversion';
          } else {
            classification = 'efficient';
          }
        } else if (d.orders >= 1 && hourAcos !== null && hourAcos <= TARGET_ACOS) {
          // Hora vencedora dentro de campanha mais cara: nunca reduzir essa hora.
          classification = 'protected_winner';
          winnerHours++;
        } else if (d.orders >= 1 && hourAcos !== null && hourAcos > MAX_ACOS && d.clicks >= MIN_HOUR_CLICKS_FOR_CUT) {
          const gap = (hourAcos - TARGET_ACOS) / TARGET_ACOS;
          adjustmentPct = -clamp(gap * 0.10, 0.05, 0.10);
          classification = 'high_acos';
        } else if (d.orders === 0 && d.clicks >= MIN_HOUR_CLICKS_FOR_CUT && d.spend >= MIN_HOUR_SPEND_FOR_CUT) {
          adjustmentPct = -0.10;
          classification = 'deficit';
        }

        adjustmentPct = clamp(adjustmentPct, -MAX_DECREASE_PCT, MAX_INCREASE_PCT);
        if (Math.abs(adjustmentPct) < 0.001) continue;

        const recommendedBid = normalizeBid(clamp(baseBid * (1 + adjustmentPct), minBid, maxBid));
        schedule.push({
          hour: h,
          classification,
          adjustment_pct: Number((adjustmentPct * 100).toFixed(1)),
          baseBid,
          recommendedBid,
          clicks: d.clicks,
          orders: d.orders,
          spend: Number(d.spend.toFixed(2)),
          sales: Number(d.sales.toFixed(2)),
          acos: hourAcos === null ? null : Number(hourAcos.toFixed(1)),
          roas: Number(hourRoas.toFixed(2)),
          days: d.days.size,
          scheduled_at: nextBrtHourUtc(h),
        });
      }

      if (!schedule.length) { stats.skipped_no_data++; continue; }
      stats.protected_winners += winnerHours;

      const evidenceScore = Math.min(1, totalClicks / 100) * 0.35 + Math.min(1, totalOrders / 8) * 0.30 + Math.min(1, daysWithData / 21) * 0.25 + (avgAcos !== null && avgAcos <= TARGET_ACOS ? 0.10 : 0.05);
      const confidence = Math.round(evidenceScore * 100);
      const hasIncrease = schedule.some((s: any) => s.adjustment_pct > 0);
      const hasDecrease = schedule.some((s: any) => s.adjustment_pct < 0);
      const autoApply = confidence >= 90 && autonomyLevel >= 2;
      const idempotencyKey = `${aid}|dayparting_acos15|${cid}|${today}`;

      const decision = await base44.asServiceRole.entities.OptimizationDecision.create({
        amazon_account_id: aid,
        decision_type: 'strategy_change',
        entity_type: 'campaign',
        entity_id: cid,
        campaign_id: cid,
        asin: campaign.asin || null,
        action: 'apply_dayparting',
        rationale: `Dayparting ACoS 15%: ${schedule.length} janela(s) acionável(is), ${hasIncrease ? 'escala controlada de vencedores' : 'sem aumento'}, ${hasDecrease ? 'redução de desperdício com evidência' : 'sem redução'}. Ajuste máximo por ação limitado a ±20%. Campanha ACoS ${avgAcos === null ? 'sem vendas' : avgAcos.toFixed(1) + '%'}, ${totalClicks} cliques, ${totalOrders} pedidos em ${daysWithData} dias.`,
        data_used: JSON.stringify({
          target_acos: TARGET_ACOS,
          max_acos: MAX_ACOS,
          max_bid_change_pct: MAX_INCREASE_PCT * 100,
          base_bid: baseBid,
          min_bid: minBid,
          max_bid: maxBid,
          days_with_data: daysWithData,
          total_clicks: totalClicks,
          total_orders: totalOrders,
          total_spend: Number(totalSpend.toFixed(2)),
          total_sales: Number(totalSales.toFixed(2)),
          avg_acos: avgAcos === null ? null : Number(avgAcos.toFixed(1)),
          avg_roas: Number(avgRoas.toFixed(2)),
          dayparting_schedule: schedule,
        }),
        confidence,
        risk: 'low',
        requires_approval: !autoApply,
        status: autoApply ? 'approved' : 'pending_approval',
        idempotency_key: idempotencyKey,
        source_function: 'runDailyDayparting_v3_acos15',
        evaluation_due_at: new Date(Date.now() + 72 * 3600000).toISOString(),
        created_at: now,
      });
      stats.decisions_created++;

      let applied = false;
      let applyError: string | null = null;
      if (autoApply) {
        const res = await base44.asServiceRole.functions.invoke('applyDaypartingSchedule', {
          opportunity_id: decision.id,
          approve: true,
          auto_apply: true,
          _service_role: true,
        }).catch((e: any) => ({ data: { ok: false, error: e.message } }));
        const data = res?.data || res || {};
        applied = data?.ok === true;
        applyError = applied ? null : data?.error || 'Falha ao agendar dayparting';
        if (applied) stats.auto_applied++;
        else stats.errors++;
      } else {
        stats.pending_review++;
      }

      results.push({
        campaign_id: cid,
        campaign_name: campaign.name || campaign.campaign_name || cid,
        asin: campaign.asin || null,
        acos: avgAcos === null ? null : Number(avgAcos.toFixed(1)),
        roas: Number(avgRoas.toFixed(2)),
        clicks: totalClicks,
        orders: totalOrders,
        confidence,
        schedule_windows: schedule.length,
        auto_applied: applied,
        error: applyError,
      });
    }

    return Response.json({
      ok: stats.errors === 0,
      policy: 'acos15_guarded_dayparting_v3',
      target_acos: TARGET_ACOS,
      max_acos: MAX_ACOS,
      max_bid_change_pct: 20,
      evidence: { min_days: MIN_DAYS, min_clicks: MIN_TOTAL_CLICKS, min_orders: MIN_TOTAL_ORDERS },
      stats,
      results,
      errors,
      duration_ms: Date.now() - startTime,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha no dayparting' }, { status: 500 });
  }
});
