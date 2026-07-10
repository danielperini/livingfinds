/**
 * getCanonicalAccountContext
 *
 * FONTE ÚNICA DE VERDADE: carrega e agrega dados exatamente como o motor
 * determinístico (runDeterministicDecisionEngine) os consome.
 *
 * Garante que Dashboard, IA e qualquer outra página leiam os mesmos valores:
 *   - PerformanceSettings (metas) → mesma cascata de fallback do motor
 *   - CampaignMetricsDaily → agregado por período (14d/30d)
 *   - SalesDaily → agregado por ASIN (últimos 30d)
 *   - Campanhas ativas (não arquivadas)
 *   - KPIs derivados: ACoS, ROAS, TACoS, CPC, CTR
 *   - Snapshot de qualidade de dados (data_quality)
 *
 * Usado por: useAccountData (frontend) + qualquer módulo que precise dos KPIs
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const FALLBACK_TARGET_ACOS = 10;
const FALLBACK_MAX_ACOS = 15;
const FALLBACK_DAILY_BUDGET_CAP = 56;
const FALLBACK_MIN_BID = 0.40;
const FALLBACK_MAX_BID = 1.00;
const ATTRIBUTION_WINDOW_DAYS = 14;

function safeDiv(a: number, b: number, fallback = 0) {
  return b > 0 ? a / b : fallback;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const db = base44.asServiceRole;

    // ── 1. Resolver conta ────────────────────────────────────────────────────
    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await db.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1);
      account = accs[0] || null;
    }
    if (!account) {
      const accs = await db.entities.AmazonAccount.filter({ user_id: user.id }, '-updated_date', 5);
      account = accs.find((a: any) => a.status === 'connected') || accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });
    const aid = account.id;

    // ── 2. PerformanceSettings — MESMA CASCATA DO MOTOR ─────────────────────
    let settings: any = null;

    try {
      const psList = await db.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1);
      if (psList.length > 0) {
        const ps = psList[0];
        settings = {
          source: 'PerformanceSettings',
          primary_goal: ps.primary_goal || 'acos',
          objective: ps.objective || 'profitability',
          target_acos: Number(ps.target_acos ?? FALLBACK_TARGET_ACOS),
          max_acos: Number(ps.max_acos ?? FALLBACK_MAX_ACOS),
          target_roas: Number(ps.target_roas ?? 4),
          target_tacos: Number(ps.target_tacos ?? 5),
          max_tacos: Number(ps.max_tacos ?? 10),
          daily_budget_limit: Number(ps.daily_budget_limit ?? FALLBACK_DAILY_BUDGET_CAP),
          target_cpc: Number(ps.target_cpc ?? 0),
          max_cpc: Number(ps.max_cpc ?? 0),
          min_bid: Number(ps.min_bid ?? FALLBACK_MIN_BID),
          max_bid: Number(ps.max_bid ?? FALLBACK_MAX_BID),
          max_bid_increase_pct: Number(ps.max_bid_increase_pct ?? 20),
          max_bid_decrease_pct: Number(ps.max_bid_decrease_pct ?? 20),
          pacing_enabled: Boolean(ps.pacing_enabled ?? true),
          dayparting_enabled: Boolean(ps.dayparting_enabled ?? true),
          ai_auto_optimization: Boolean(ps.ai_auto_optimization ?? false),
          weekly_campaign_capacity: Number(ps.weekly_campaign_capacity ?? 10),
          updated_at: ps.updated_at || null,
        };
      }
    } catch {}

    if (!settings) {
      try {
        const apList = await db.entities.AutopilotConfig.filter({ amazon_account_id: aid }, null, 1);
        if (apList.length > 0) {
          const cfg = apList[0];
          settings = {
            source: 'AutopilotConfig',
            primary_goal: 'acos',
            objective: cfg.objective || 'profitability',
            target_acos: Number(cfg.target_acos ?? FALLBACK_TARGET_ACOS),
            max_acos: Number(cfg.maximum_acos ?? FALLBACK_MAX_ACOS),
            target_roas: Number(cfg.target_roas ?? 4),
            target_tacos: Number(cfg.target_tacos ?? 5),
            max_tacos: Number(cfg.maximum_tacos ?? 10),
            daily_budget_limit: Number(cfg.total_daily_budget ?? cfg.daily_budget_limit ?? FALLBACK_DAILY_BUDGET_CAP),
            target_cpc: Number(cfg.target_cpc ?? 0),
            max_cpc: Number(cfg.maximum_cpc ?? 0),
            min_bid: Number(cfg.min_bid ?? FALLBACK_MIN_BID),
            max_bid: Number(cfg.max_bid ?? FALLBACK_MAX_BID),
            max_bid_increase_pct: Number(cfg.max_bid_increase_pct ?? 20),
            max_bid_decrease_pct: Number(cfg.max_bid_decrease_pct ?? 20),
            pacing_enabled: Boolean(cfg.budget_optimization_enabled ?? true),
            dayparting_enabled: Boolean(cfg.dayparting_enabled ?? true),
            ai_auto_optimization: Boolean(cfg.ai_auto_optimization ?? false),
            weekly_campaign_capacity: 10,
            updated_at: null,
          };
        }
      } catch {}
    }

    if (!settings) {
      settings = {
        source: 'system_defaults',
        primary_goal: 'acos', objective: 'profitability',
        target_acos: FALLBACK_TARGET_ACOS, max_acos: FALLBACK_MAX_ACOS,
        target_roas: 4, target_tacos: 5, max_tacos: 10,
        daily_budget_limit: FALLBACK_DAILY_BUDGET_CAP,
        target_cpc: 0, max_cpc: 0,
        min_bid: FALLBACK_MIN_BID, max_bid: FALLBACK_MAX_BID,
        max_bid_increase_pct: 20, max_bid_decrease_pct: 20,
        pacing_enabled: true, dayparting_enabled: true,
        ai_auto_optimization: false, weekly_campaign_capacity: 10,
        updated_at: null,
      };
    }

    // ── 3. Carregar dados em paralelo — MESMAS QUERIES DO MOTOR ──────────────
    const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const since14 = new Date(Date.now() - ATTRIBUTION_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    const [campaigns, metricsRaw, salesDailyRaw, products] = await Promise.all([
      db.entities.Campaign.filter({ amazon_account_id: aid }, null, 2000).catch(() => []),
      db.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 5000).catch(() => []),
      db.entities.SalesDaily.filter({ amazon_account_id: aid }, '-date', 1000).catch(() => []),
      db.entities.Product.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
    ]);

    // ── 4. Campanhas ativas (não arquivadas) — mesmo filtro do motor ─────────
    const activeCampaigns = campaigns.filter((c: any) => {
      const st = String(c.state || c.status || '').toLowerCase();
      return st !== 'archived' && !c.archived;
    });
    const totalDailyBudget = activeCampaigns.reduce((s: number, c: any) => s + (c.daily_budget || 0), 0);

    // campaign_id → asin
    const campaignAsinMap = new Map<string, string>();
    for (const c of campaigns) {
      if (c.campaign_id && c.asin) campaignAsinMap.set(c.campaign_id, c.asin);
      if (c.amazon_campaign_id && c.asin) campaignAsinMap.set(c.amazon_campaign_id, c.asin);
    }

    // ── 5. Agregar métricas de Ads — janelas 14d e 30d ───────────────────────
    const kpis30d = { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0 };
    const kpis14d = { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0 };
    const kpisYesterday = { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0 };
    const seenKeys30 = new Set<string>();
    const seenKeys14 = new Set<string>();
    const seenKeysY = new Set<string>();

    // Por data para gráfico
    const byDate: Record<string, { spend: number; sales: number; clicks: number; impressions: number; orders: number }> = {};

    for (const m of metricsRaw) {
      if (!m.date) continue;
      const key = `${m.campaign_id || ''}-${m.date}`;

      if (!byDate[m.date]) byDate[m.date] = { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0 };
      // Deduplicar por campanha+data para gráfico
      if (!seenKeys30.has(key)) {
        byDate[m.date].spend += m.spend || 0;
        byDate[m.date].sales += m.sales || 0;
        byDate[m.date].clicks += m.clicks || 0;
        byDate[m.date].impressions += m.impressions || 0;
        byDate[m.date].orders += m.orders || 0;
      }

      if (m.date >= since30 && !seenKeys30.has(key)) {
        seenKeys30.add(key);
        kpis30d.spend += m.spend || 0;
        kpis30d.sales += m.sales || 0;
        kpis30d.clicks += m.clicks || 0;
        kpis30d.impressions += m.impressions || 0;
        kpis30d.orders += m.orders || 0;
      }
      if (m.date >= since14 && !seenKeys14.has(key)) {
        seenKeys14.add(key);
        kpis14d.spend += m.spend || 0;
        kpis14d.sales += m.sales || 0;
        kpis14d.clicks += m.clicks || 0;
        kpis14d.impressions += m.impressions || 0;
        kpis14d.orders += m.orders || 0;
      }
      if (m.date === yesterday && !seenKeysY.has(key)) {
        seenKeysY.add(key);
        kpisYesterday.spend += m.spend || 0;
        kpisYesterday.sales += m.sales || 0;
        kpisYesterday.clicks += m.clicks || 0;
        kpisYesterday.impressions += m.impressions || 0;
        kpisYesterday.orders += m.orders || 0;
      }
    }

    function deriveKpis(k: typeof kpis30d) {
      return {
        ...k,
        acos: k.sales > 0 ? (k.spend / k.sales) * 100 : 0,
        roas: k.spend > 0 ? k.sales / k.spend : 0,
        cpc: k.clicks > 0 ? k.spend / k.clicks : 0,
        ctr: k.impressions > 0 ? (k.clicks / k.impressions) * 100 : 0,
        cvr: k.clicks > 0 ? (k.orders / k.clicks) * 100 : 0,
      };
    }

    // ── 6. Agregar SalesDaily — MESMO CÁLCULO DO MOTOR ───────────────────────
    const salesByAsin = new Map<string, { revenue: number; units: number; orders: number; dates: Set<string> }>();
    for (const s of salesDailyRaw) {
      if (!s.asin || !s.date || s.date < since30) continue;
      if (!salesByAsin.has(s.asin)) salesByAsin.set(s.asin, { revenue: 0, units: 0, orders: 0, dates: new Set() });
      const e = salesByAsin.get(s.asin)!;
      e.revenue += s.ordered_product_sales || 0;
      e.units += s.units_ordered || 0;
      if ((s.units_ordered || 0) > 0) e.orders++;
      if (s.date) e.dates.add(s.date);
    }

    // KPIs reais agregados de toda a conta (SP-API)
    const realKpis30d = { revenue: 0, units: 0, orders: 0 };
    for (const v of salesByAsin.values()) {
      realKpis30d.revenue += v.revenue;
      realKpis30d.units += v.units;
      realKpis30d.orders += v.orders;
    }

    // TACoS real da conta (30d)
    const tacos30d = realKpis30d.revenue > 0 ? (kpis30d.spend / realKpis30d.revenue) * 100 : null;
    const tacos14d = realKpis30d.revenue > 0 ? (kpis14d.spend / realKpis30d.revenue) * 100 : null;

    // ── 7. Qualidade de dados — mesmo diagnóstico do motor ───────────────────
    const lastSyncAt = account.ads_data_fresh_at || account.ads_metrics_last_sync_at || account.last_sync_at || null;
    const syncAgeHours = lastSyncAt
      ? (Date.now() - new Date(lastSyncAt).getTime()) / 3600000
      : null;

    const metricDates = metricsRaw.map((m: any) => m.date).filter(Boolean).sort();
    const latestMetricDate = metricDates.length > 0 ? metricDates[metricDates.length - 1] : null;
    const metricAgeHours = latestMetricDate
      ? (Date.now() - new Date(latestMetricDate).getTime()) / 3600000
      : null;

    const spDates = salesDailyRaw.map((s: any) => s.date).filter(Boolean).sort();
    const latestSpDate = spDates.length > 0 ? spDates[spDates.length - 1] : null;

    // Determinar qualidade geral
    const isAdsStale = syncAgeHours !== null && syncAgeHours > 48;
    const isSpStale = latestSpDate !== null && latestSpDate < since14;
    const dataQuality = isAdsStale || isSpStale ? 'stale' : 'fresh';

    // ── 8. Snapshot canônico — o que o motor veria agora ────────────────────
    const canonicalSnapshot = {
      generated_at: new Date().toISOString(),
      account_id: aid,

      // Metas (fonte única — mesma cascata do motor)
      settings,

      // Campanhas
      campaigns_total: campaigns.length,
      campaigns_active: activeCampaigns.length,
      total_daily_budget: Math.round(totalDailyBudget * 100) / 100,
      budget_within_limits: totalDailyBudget <= settings.daily_budget_limit,

      // KPIs de Ads — janela 14d (escopo MRC primário, usado pelo motor)
      kpis_14d: { ...deriveKpis(kpis14d), tacos: tacos14d },
      // KPIs de Ads — janela 30d (usado pelo Dashboard para análise de tendências)
      kpis_30d: { ...deriveKpis(kpis30d), tacos: tacos30d },
      // KPIs do dia anterior (para pacing)
      kpis_yesterday: deriveKpis(kpisYesterday),

      // Faturamento real (SP-API Orders)
      real_kpis_30d: realKpis30d,

      // Metas vs realidade (14d — mesmo que o motor usa para decisões)
      goal_status: {
        acos: {
          value: deriveKpis(kpis14d).acos,
          target: settings.target_acos,
          max: settings.max_acos,
          status: deriveKpis(kpis14d).acos === 0 ? 'no_data'
            : deriveKpis(kpis14d).acos <= settings.target_acos ? 'ok'
            : deriveKpis(kpis14d).acos <= settings.max_acos ? 'warn'
            : 'over',
        },
        roas: {
          value: deriveKpis(kpis14d).roas,
          target: settings.target_roas,
          status: settings.target_roas <= 0 ? 'no_target'
            : deriveKpis(kpis14d).roas >= settings.target_roas ? 'ok'
            : 'under',
        },
        tacos: {
          value: tacos14d,
          target: settings.target_tacos,
          max: settings.max_tacos,
          status: tacos14d === null ? 'no_data'
            : tacos14d <= settings.target_tacos ? 'ok'
            : tacos14d <= settings.max_tacos ? 'warn'
            : 'over',
        },
        budget: {
          value: kpisYesterday.spend,
          limit: settings.daily_budget_limit,
          pct: settings.daily_budget_limit > 0 ? kpisYesterday.spend / settings.daily_budget_limit * 100 : null,
          status: kpisYesterday.spend > settings.daily_budget_limit ? 'over' : 'ok',
        },
      },

      // Qualidade de dados
      data_quality: {
        status: dataQuality,
        ads_last_sync_at: lastSyncAt,
        ads_sync_age_hours: syncAgeHours !== null ? Math.round(syncAgeHours * 10) / 10 : null,
        ads_latest_metric_date: latestMetricDate,
        sp_api_latest_date: latestSpDate,
        motor_would_run: !isAdsStale,
        attribution_window_days: ATTRIBUTION_WINDOW_DAYS,
      },

      // Séries temporais para gráficos (todo o histórico disponível)
      daily_series: Object.entries(byDate)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, v]) => ({ date, ...v })),
    };

    return Response.json({ ok: true, ...canonicalSnapshot });
  } catch (err: any) {
    return Response.json({ ok: false, error: err?.message || 'Erro inesperado' }, { status: 500 });
  }
});