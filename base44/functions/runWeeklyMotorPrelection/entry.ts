/**
 * runWeeklyMotorPrelection — Preleção Semanal do Motor
 *
 * Executado 1x/semana (quinta 03h50 BRT automático).
 * Claude atua como auditor estratégico — NÃO substitui o motor determinístico diário.
 *
 * Fluxo:
 *  1. Carregar metas (PerformanceSettings)
 *  2. Coletar métricas dos últimos 7 dias (banco + relatórios disponíveis + dados dashboard)
 *  3. Preparar payload compacto para Claude
 *  4. Chamar Claude 1x com JSON estruturado (sem timeout forçado)
 *  5. Salvar WeeklyMotorPrelection
 *  6. Salvar MotorRuleChangeProposal (confidence >= 0.95 → approved, senão proposed)
 *  7. Enfileirar campanhas manuais recomendadas
 *
 * O QUE CLAUDE NÃO PODE FAZER (enforçado pelo código, não pelo prompt):
 *  - Inventar keywords (só aceita de Search Term ou Amazon Ads oficial)
 *  - Exceder bid máximo / mínimo configurado
 *  - Exceder budget diário geral
 *  - Executar placement se limite = 0
 *  - Criar campanha para produto sem estoque
 *  - Alterar regra com confidence < 0.95
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import Anthropic from 'npm:@anthropic-ai/sdk@0.27.0';

const MODEL = Deno.env.get('AI_WEEKLY_REVIEW_MODEL') || 'claude-opus-4-8';
const FALLBACK = { target_acos: 10, max_acos: 15, target_roas: 4, target_tacos: 5, max_tacos: 10, daily_budget_cap: 56, target_cpc: 0.60, max_cpc: 1.00, min_bid: 0.40, max_bid: 1.00, max_bid_increase_pct: 20, max_bid_decrease_pct: 20, min_campaign_budget: 15, budget_increment: 5, weekly_campaign_capacity: 10 };

function weekBounds(offsetWeeks = 0) {
  const now = new Date();
  const dow = now.getDay();
  const daysSinceMonday = (dow + 6) % 7;
  const monday = new Date(now); monday.setDate(now.getDate() - daysSinceMonday - offsetWeeks * 7); monday.setHours(0,0,0,0);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6); sunday.setHours(23,59,59,999);
  return { start: monday.toISOString().slice(0,10), end: sunday.toISOString().slice(0,10) };
}

function clampBid(bid: number, s: any) { return Math.min(s.max_bid, Math.max(s.min_bid, bid)); }
function fmt2(v: number) { return Math.round(v * 100) / 100; }
function uuid() { return `${Date.now()}-${Math.random().toString(36).slice(2,8)}`; }

function isInAmazonWindow(): boolean {
  const brt = new Date(Date.now() - 3 * 3600000);
  const h = brt.getUTCHours();
  return (h >= 0 && h < 4) || (h >= 13 && h < 14);
}

Deno.serve(async (req) => {
  const runId = uuid();
  const now = new Date().toISOString();

  const base44 = createClientFromRequest(req);
  try {
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const dryRun = body.dry_run === true;

    // ── 1. Conta Amazon ──────────────────────────────────────────────────
    let account: any = null;
    if (body.amazon_account_id) {
      const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = rows[0];
    }
    if (!account) {
      const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = rows[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada.' });
    const aid = account.id;

    // ── 2. Metas (fonte única) ───────────────────────────────────────────
    let s: any = null;
    const psList = await base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1).catch(() => []);
    if (psList.length > 0) {
      const ps = psList[0];
      s = {
        target_acos: Number(ps.target_acos ?? FALLBACK.target_acos),
        max_acos: Number(ps.max_acos ?? FALLBACK.max_acos),
        target_roas: Number(ps.target_roas ?? FALLBACK.target_roas),
        target_tacos: Number(ps.target_tacos ?? FALLBACK.target_tacos),
        max_tacos: Number(ps.max_tacos ?? FALLBACK.max_tacos),
        daily_budget_cap: Number(ps.daily_budget_limit ?? FALLBACK.daily_budget_cap),
        target_cpc: Number(ps.target_cpc ?? FALLBACK.target_cpc),
        max_cpc: Number(ps.max_cpc ?? FALLBACK.max_cpc),
        min_bid: Number(ps.min_bid ?? FALLBACK.min_bid),
        max_bid: Number(ps.max_bid ?? FALLBACK.max_bid),
        max_bid_increase_pct: Number(ps.max_bid_increase_pct ?? FALLBACK.max_bid_increase_pct),
        max_bid_decrease_pct: Number(ps.max_bid_decrease_pct ?? FALLBACK.max_bid_decrease_pct),
        min_campaign_budget: Number(ps.minimum_campaign_budget ?? FALLBACK.min_campaign_budget),
        budget_increment: Number(ps.campaign_budget_increment ?? FALLBACK.budget_increment),
        weekly_campaign_capacity: Number(ps.weekly_campaign_capacity ?? FALLBACK.weekly_campaign_capacity),
        top_of_search_limit: Number(ps.top_of_search_limit ?? 0),
        rest_of_search_limit: Number(ps.rest_of_search_limit ?? 0),
        product_page_limit: Number(ps.product_page_limit ?? 0),
        ai_auto_optimization: Boolean(ps.ai_auto_optimization ?? false),
        settings_source: 'PerformanceSettings',
      };
    }
    if (!s) s = { ...FALLBACK, top_of_search_limit: 0, rest_of_search_limit: 0, product_page_limit: 0, ai_auto_optimization: false, settings_source: 'defaults' };

    // ── 3. Verificar cooldown — só 1 preleção por semana ────────────────
    const { start: weekStart, end: weekEnd } = weekBounds(0);
    const existingRuns = await base44.asServiceRole.entities.WeeklyMotorPrelection.filter(
      { amazon_account_id: aid, week_start: weekStart }, '-created_at', 1
    ).catch(() => []);
    if (existingRuns.length > 0 && existingRuns[0].status === 'completed' && !body.force) {
      return Response.json({ ok: true, skipped: true, reason: `Preleção já realizada para semana ${weekStart}–${weekEnd}.`, prelection_id: existingRuns[0].id });
    }

    // ── 4. Criar registro inicial ────────────────────────────────────────
    const prelectionRecord = await base44.asServiceRole.entities.WeeklyMotorPrelection.create({
      amazon_account_id: aid,
      week_start: weekStart,
      week_end: weekEnd,
      started_at: now,
      status: 'running',
      model_used: MODEL,
      target_acos: s.target_acos,
      max_acos: s.max_acos,
      target_roas: s.target_roas,
      target_tacos: s.target_tacos,
      max_tacos: s.max_tacos,
      daily_budget_cap: s.daily_budget_cap,
      created_at: now,
    });
    const prelectionId = prelectionRecord.id;

    // ── 5. Sincronização leve de dados Amazon (antes da análise) ──────────
    if (!dryRun) {
      // Serial: aguardar sincronização básica antes de coletar dados
      await base44.functions.invoke('syncAdsQuick', { amazon_account_id: aid }).catch(e => console.warn('[prelection] syncAdsQuick falhou:', e.message));
      await base44.functions.invoke('fixProductCampaignLinks', { amazon_account_id: aid }).catch(e => console.warn('[prelection] fixProductCampaignLinks falhou:', e.message));
      await base44.functions.invoke('evaluateDecisionOutcomes', { amazon_account_id: aid }).catch(e => console.warn('[prelection] evaluateDecisionOutcomes falhou:', e.message));
    }

    // ── 6. Coletar dados — banco + relatórios + dashboard ────────────────
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0,10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0,10);

    // Coleta paralela: todas as fontes ao mesmo tempo
    const [
      campaigns, products, keywords, metricsWeek, searchTerms,
      decisions, strategyLogs, bidLogs, unifiedMetrics,
      activeRules, reportCatalog, benchmarks, syncLogs,
    ] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 300),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 200),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-spend', 500),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 500),
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: aid }, '-orders', 300).catch(() => []),
      base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: aid }, '-created_at', 100).catch(() => []),
      base44.asServiceRole.entities.StrategyExecutionLog.filter({ amazon_account_id: aid }, '-created_at', 100).catch(() => []),
      base44.asServiceRole.entities.AdsBidChangeLog.filter({ amazon_account_id: aid }, '-created_at', 200).catch(() => []),
      base44.asServiceRole.entities.UnifiedAdsMetricsDaily.filter({ amazon_account_id: aid }, '-date', 200).catch(() => []),
      base44.asServiceRole.entities.DecisionRule.filter({ amazon_account_id: aid, status: 'active' }, null, 50).catch(() => []),
      // Relatórios disponíveis no catálogo
      base44.asServiceRole.entities.AmazonReportCatalog.filter({ amazon_account_id: aid }, '-created_at', 20).catch(() => []),
      // Benchmarks de faturamento real (dados do dashboard)
      base44.asServiceRole.entities.SellerPerformanceBenchmark.filter({ amazon_account_id: aid }, '-period_end', 4).catch(() => []),
      // Últimas sincronizações (saúde dos dados)
      base44.asServiceRole.entities.SyncRun.filter({ amazon_account_id: aid }, '-created_at', 10).catch(() => []),
    ]);

    // ── 6b. Carregar campanhas pausadas e seus termos ────────────────────
    const pausedCampaignsAll = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: aid }, null, 500
    ).then((cs: any[]) => cs.filter(c => ['paused','PAUSED'].includes(String(c.state||c.status||'').toUpperCase())));

    // ── 6c. Retroativamente negativar termos de manuais existentes nas AUTOs ──
    if (!dryRun) {
      // Para cada campanha MANUAL ativa, pegar suas keywords e negativar na AUTO do mesmo ASIN
      const manualCampsAll = campaigns.filter((c: any) => (c.targeting_type||'').toUpperCase() === 'MANUAL' && !['archived','ARCHIVED'].includes(String(c.state||c.status||'')));
      const autoCampsAll   = campaigns.filter((c: any) => (c.targeting_type||'').toUpperCase() === 'AUTO'   && !['archived','ARCHIVED'].includes(String(c.state||c.status||'')));
      for (const manualC of manualCampsAll.slice(0, 20)) {
        if (!manualC.asin) continue;
        const autoC = autoCampsAll.find((c: any) => c.asin === manualC.asin);
        if (!autoC) continue;
        const manualKws = keywords.filter((k: any) => {
          const cids = [manualC.campaign_id, manualC.amazon_campaign_id, manualC.id].filter(Boolean);
          return cids.includes(k.campaign_id);
        });
        for (const kw of manualKws.slice(0, 10)) {
          const kwText = (kw.keyword_text || kw.keyword || '').toLowerCase().trim();
          if (!kwText) continue;
          // Verificar se já negativado
          const already = await base44.asServiceRole.entities.OptimizationDecision.filter({
            amazon_account_id: aid, campaign_id: autoC.campaign_id, keyword_text: kwText,
            decision_type: 'negative_keyword', status: 'executed',
          }, null, 1).catch(() => []);
          if (!already.length) {
            base44.functions.invoke('negateKeywordInAutoCampaign', {
              amazon_account_id: aid, asin: manualC.asin, keyword_text: kwText,
              manual_campaign_id: manualC.campaign_id || manualC.id,
              triggered_by: 'weekly_prelection_retroactive',
            }).catch(() => {});
          }
        }
      }
    }

    // ── 7. Agregações determinísticas ────────────────────────────────────

    const weekMetrics = metricsWeek.filter(m => m.date >= sevenDaysAgo && m.date <= yesterday);
    const weekTotals = weekMetrics.reduce((acc, m) => ({
      spend: acc.spend + (m.spend || 0),
      sales: acc.sales + (m.sales || 0),
      orders: acc.orders + (m.orders || 0),
      clicks: acc.clicks + (m.clicks || 0),
      impressions: acc.impressions + (m.impressions || 0),
    }), { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 });
    const weekAcos = weekTotals.sales > 0 ? fmt2(weekTotals.spend / weekTotals.sales * 100) : 0;
    const weekRoas = weekTotals.spend > 0 ? fmt2(weekTotals.sales / weekTotals.spend) : 0;
    const weekCpc = weekTotals.clicks > 0 ? fmt2(weekTotals.spend / weekTotals.clicks) : 0;

    // Unified metrics — agregar semana
    const unifiedWeek = unifiedMetrics.filter(m => m.date >= sevenDaysAgo && m.date <= yesterday);
    const unifiedTotals = unifiedWeek.reduce((acc, m) => ({
      cost: acc.cost + (m.cost || 0),
      purchases: acc.purchases + (m.purchases || 0),
      sales: acc.sales + (m.sales || 0),
      clicks: acc.clicks + (m.clicks || 0),
      impressions: acc.impressions + (m.impressions || 0),
      halo_sales: acc.halo_sales + (m.halo_sales || 0),
      invalid_clicks: acc.invalid_clicks + (m.invalid_clicks || 0),
    }), { cost: 0, purchases: 0, sales: 0, clicks: 0, impressions: 0, halo_sales: 0, invalid_clicks: 0 });

    // Benchmark de faturamento real (dados do dashboard — evitar subestimação por latência)
    const latestBenchmark = benchmarks[0] || null;
    const dashboardRevenue = latestBenchmark ? {
      period: `${latestBenchmark.period_start} – ${latestBenchmark.period_end}`,
      gross_revenue: latestBenchmark.gross_revenue,
      gross_margin_pct: latestBenchmark.gross_margin_pct,
      tacos_pct: latestBenchmark.tacos_pct,
      ads_spend: latestBenchmark.ads_spend,
      units_sold: latestBenchmark.units_sold,
      sales_count: latestBenchmark.sales_count,
    } : null;

    // TACoS real se tiver benchmark
    let tacos: number | null = null;
    if (dashboardRevenue && dashboardRevenue.gross_revenue > 0 && weekTotals.spend > 0) {
      tacos = fmt2(weekTotals.spend / dashboardRevenue.gross_revenue * 100);
    }

    // Relatórios disponíveis (resumo para Claude)
    const availableReports = reportCatalog.slice(0, 10).map((r: any) => ({
      type: r.report_type || r.type,
      status: r.status,
      date: r.report_date || r.created_at?.slice(0,10),
      processed: r.processed || false,
    }));

    // Saúde dos dados de sync
    const lastSync = syncLogs[0];
    const dataSyncHealth = lastSync ? {
      last_sync_at: lastSync.created_at || lastSync.started_at,
      status: lastSync.status,
      campaigns_synced: lastSync.campaigns_synced || 0,
      keywords_synced: lastSync.keywords_synced || 0,
    } : null;

    // Classificar campanhas
    const activeCampaigns = campaigns.filter(c => ['enabled', 'ENABLED'].includes(String(c.state || c.status || '').toUpperCase()) && String(c.state || c.status || '').toLowerCase() !== 'archived');
    const pausedCampaigns = campaigns.filter(c => ['paused', 'PAUSED'].includes(String(c.state || c.status || '').toUpperCase()));
    const incompleteCampaigns = campaigns.filter(c => (c.is_incomplete || c.incomplete) === true);
    const autoCampaigns = activeCampaigns.filter(c => (c.targeting_type || '').toLowerCase() === 'auto' || (c.campaign_name || c.name || '').toUpperCase().includes('AUTO'));
    const manualCampaigns = activeCampaigns.filter(c => (c.targeting_type || '').toLowerCase() === 'manual' || (c.campaign_name || c.name || '').toUpperCase().includes('MANUAL'));

    const activeProducts = products.filter(p => p.status === 'active' && Number(p.fba_inventory || 0) > 0);
    const outOfStockProducts = products.filter(p => Number(p.fba_inventory || 0) === 0);
    const productAsins = new Set(activeProducts.map(p => p.asin).filter(Boolean));

    const campaignsByAsin = new Map<string, any[]>();
    for (const c of activeCampaigns) {
      if (!c.asin) continue;
      if (!campaignsByAsin.has(c.asin)) campaignsByAsin.set(c.asin, []);
      campaignsByAsin.get(c.asin)!.push(c);
    }
    const asinsWithoutCampaign = activeProducts.filter(p => p.asin && !campaignsByAsin.has(p.asin)).map(p => p.asin);

    const spendByCampaign = new Map<string, number>();
    const salesByCampaign = new Map<string, number>();
    const ordersByCampaign = new Map<string, number>();
    for (const m of weekMetrics) {
      if (!m.campaign_id) continue;
      spendByCampaign.set(m.campaign_id, (spendByCampaign.get(m.campaign_id) || 0) + (m.spend || 0));
      salesByCampaign.set(m.campaign_id, (salesByCampaign.get(m.campaign_id) || 0) + (m.sales || 0));
      ordersByCampaign.set(m.campaign_id, (ordersByCampaign.get(m.campaign_id) || 0) + (m.orders || 0));
    }

    const campaignPerfRows: any[] = [];
    for (const c of activeCampaigns) {
      const cid = c.campaign_id || c.amazon_campaign_id || c.id;
      const spend = spendByCampaign.get(cid) || 0;
      const sales = salesByCampaign.get(cid) || 0;
      const orders = ordersByCampaign.get(cid) || 0;
      const acos = sales > 0 ? fmt2(spend / sales * 100) : null;
      const roas = spend > 0 ? fmt2(sales / spend) : null;
      const ageHours = c.created_at ? (Date.now() - new Date(c.created_at).getTime()) / 3600000 : 9999;
      const matured = ageHours >= 48;
      campaignPerfRows.push({ cid, name: (c.campaign_name || c.name || cid).slice(0,60), spend, sales, orders, acos, roas, asin: c.asin, type: autoCampaigns.includes(c) ? 'AUTO' : 'MANUAL', matured });
    }
    campaignPerfRows.sort((a, b) => b.spend - a.spend);
    const topCampsBySpend = campaignPerfRows.slice(0, 20);
    const topCampsBySales = [...campaignPerfRows].sort((a, b) => b.sales - a.sales).slice(0, 20);

    const losingCampaigns = campaignPerfRows.filter(c =>
      c.matured && c.spend > 5 && (c.acos == null || c.acos > s.max_acos) && c.orders === 0
    ).slice(0, 20);

    // Campanhas pausadas que tiveram vendas — candidatas a reativar
    const pausedWithSales: any[] = [];
    for (const pc of pausedCampaignsAll.slice(0, 50)) {
      const cid = pc.campaign_id || pc.amazon_campaign_id || pc.id;
      const pcMetrics = metricsWeek.filter((m: any) => m.campaign_id === cid);
      const pcOrders = pcMetrics.reduce((s: number, m: any) => s + (m.orders||0), 0);
      const pcSales  = pcMetrics.reduce((s: number, m: any) => s + (m.sales||0), 0);
      const pcSpend  = pcMetrics.reduce((s: number, m: any) => s + (m.spend||0), 0);
      const pcAcos   = pcSales > 0 ? fmt2(pcSpend / pcSales * 100) : null;
      if (pcOrders > 0) {
        pausedWithSales.push({ cid, name: (pc.campaign_name||pc.name||cid).slice(0,60), orders: pcOrders, sales: pcSales, spend: pcSpend, acos: pcAcos, asin: pc.asin, type: (pc.targeting_type||'').toUpperCase() });
      }
    }

    // Search terms com >= 3 pedidos → candidatos a campanha manual EXACT
    const strongWinningTerms = searchTerms.filter((t: any) => {
      const orders = t.orders || 0;
      const sales  = t.sales  || 0;
      const spend  = t.spend  || 0;
      const acos   = sales > 0 ? spend / sales * 100 : null;
      return orders >= 3 && sales > 0 && (acos == null || acos <= s.max_acos * 1.5);
    }).slice(0, 20).map((t: any) => ({
      search_term: t.query || t.search_term || t.term,
      asin: t.asin,
      campaign_id: t.campaign_id,
      campaign_type: t.campaign_type || 'AUTO',
      orders: t.orders || 0,
      sales: fmt2(t.sales || 0),
      spend: fmt2(t.spend || 0),
      acos: t.sales > 0 ? fmt2((t.spend||0)/(t.sales||1)*100) : null,
      cpc: (t.clicks||0) > 0 ? fmt2((t.spend||0)/(t.clicks||1)) : 0,
    }));

    const winningTerms = searchTerms.filter(t => {
      const orders = t.orders || 0;
      const sales = t.sales || 0;
      const spend = t.spend || 0;
      const acos = sales > 0 ? spend / sales * 100 : null;
      const clicks = t.clicks || 0;
      const cpc = clicks > 0 ? spend / clicks : 0;
      return orders > 0 && sales > 0 && acos != null && acos <= s.max_acos && cpc <= s.max_cpc;
    }).slice(0, 20).map(t => {
      const sales = t.sales || 0;
      const spend = t.spend || 0;
      const clicks = t.clicks || 0;
      const acos = sales > 0 ? fmt2(spend / sales * 100) : 0;
      const roas = spend > 0 ? fmt2(sales / spend) : 0;
      const cpc = clicks > 0 ? fmt2(spend / clicks) : 0;
      let classification = 'teste_promissor';
      if (acos <= s.target_acos && (t.orders || 0) >= 3) classification = 'vencedor_forte';
      else if (acos <= s.max_acos && (t.orders || 0) >= 1) classification = 'vencedor_moderado';
      else if (cpc > s.target_cpc) classification = 'termo_caro';
      return { search_term: t.query || t.search_term || t.term, asin: t.asin, campaign_id: t.campaign_id, campaign_type: t.campaign_type || 'AUTO', orders: t.orders || 0, sales, spend, acos, roas, cpc, classification };
    });

    const losingTerms = searchTerms.filter(t => {
      const spend = t.spend || 0;
      const orders = t.orders || 0;
      const clicks = t.clicks || 0;
      return spend > 5 && orders === 0 && clicks >= 8;
    }).slice(0, 20).map(t => ({
      search_term: t.query || t.search_term || t.term,
      asin: t.asin,
      spend: fmt2(t.spend || 0),
      clicks: t.clicks || 0,
      orders: 0,
    }));

    const recentBidChanges = bidLogs.filter(b => (b.created_at || b.created_date || '') >= sevenDaysAgo).slice(0, 30).map(b => ({
      keyword: b.keyword, direction: b.direction, old_bid: b.old_bid, new_bid: b.new_bid,
      change_pct: b.change_percent, reason: (b.reason || '').slice(0, 80),
    }));

    const bidViolations = recentBidChanges.filter(b => b.new_bid < s.min_bid || b.new_bid > s.max_bid);

    const weekDecisions = decisions.filter(d => (d.created_at || '') >= sevenDaysAgo).slice(0, 30).map(d => ({
      action: d.action_type, status: d.status, reason: (d.reason || '').slice(0, 80), result: d.result_summary,
    }));

    const goalStatus = {
      acos: weekAcos === 0 ? 'no_data' : weekAcos <= s.target_acos ? 'ok' : weekAcos <= s.max_acos ? 'warning' : 'critical',
      roas: weekRoas === 0 ? 'no_data' : weekRoas >= s.target_roas ? 'ok' : weekRoas >= s.target_roas * 0.75 ? 'warning' : 'critical',
      tacos: tacos == null ? 'no_data' : tacos <= s.target_tacos ? 'ok' : tacos <= s.max_tacos ? 'warning' : 'critical',
      cpc: weekCpc === 0 ? 'no_data' : weekCpc <= s.target_cpc ? 'ok' : weekCpc <= s.max_cpc ? 'warning' : 'critical',
      budget: 'ok',
    };

    // ── 8. Preparar payload compacto para Claude ─────────────────────────
    const claudePayload = {
      context: 'Você é auditor estratégico semanal do motor de anúncios Amazon. Analise a semana e responda APENAS em JSON válido conforme o schema solicitado. NÃO invente keywords. Use apenas termos que aparecem nos dados fornecidos.',
      performance_goals: {
        target_acos: s.target_acos, max_acos: s.max_acos,
        target_roas: s.target_roas, target_tacos: s.target_tacos, max_tacos: s.max_tacos,
        daily_budget_cap: s.daily_budget_cap, target_cpc: s.target_cpc, max_cpc: s.max_cpc,
        min_bid: s.min_bid, max_bid: s.max_bid,
        top_of_search_limit: s.top_of_search_limit,
        rest_of_search_limit: s.rest_of_search_limit,
        product_page_limit: s.product_page_limit,
      },
      week: { start: weekStart, end: weekEnd },
      week_metrics: {
        spend: fmt2(weekTotals.spend), sales: fmt2(weekTotals.sales),
        orders: weekTotals.orders, clicks: weekTotals.clicks,
        acos: weekAcos, roas: weekRoas, cpc: weekCpc,
      },
      // Dados do dashboard (faturamento real sem viés de latência de atribuição)
      dashboard_revenue: dashboardRevenue,
      tacos_real: tacos,
      // Métricas unificadas (qualidade de tráfego — halo, inválidos, parcela de impressões)
      unified_week_totals: unifiedTotals.cost > 0 ? {
        cost: fmt2(unifiedTotals.cost),
        purchases: unifiedTotals.purchases,
        sales: fmt2(unifiedTotals.sales),
        halo_sales: fmt2(unifiedTotals.halo_sales),
        invalid_clicks: unifiedTotals.invalid_clicks,
        invalid_click_pct: unifiedTotals.clicks > 0 ? fmt2(unifiedTotals.invalid_clicks / unifiedTotals.clicks * 100) : 0,
      } : null,
      // Relatórios disponíveis no catálogo (o que foi sincronizado)
      available_reports: availableReports,
      data_sync_health: dataSyncHealth,
      goal_status: goalStatus,
      top_campaigns_by_spend: topCampsBySpend,
      top_campaigns_by_sales: topCampsBySales,
      losing_campaigns: losingCampaigns,
      winning_terms: winningTerms,
      losing_terms: losingTerms,
      active_products_with_stock: activeProducts.slice(0, 50).map(p => ({ asin: p.asin, sku: p.sku, name: (p.product_name || '').slice(0,60), stock: p.fba_inventory, has_campaign: campaignsByAsin.has(p.asin || '') })),
      out_of_stock_asins: outOfStockProducts.map(p => p.asin).filter(Boolean).slice(0, 20),
      asins_without_campaign: asinsWithoutCampaign.slice(0, 10),
      incomplete_campaigns_count: incompleteCampaigns.length,
      paused_campaigns_count: pausedCampaigns.length,
      paused_campaigns_with_sales: pausedWithSales,
      strong_winning_terms: strongWinningTerms,
      recent_bid_changes: recentBidChanges.slice(0, 20),
      bid_violations: bidViolations,
      week_decisions: weekDecisions.slice(0, 20),
      strategy_logs: strategyLogs.slice(0, 20).map(l => ({ strategy: l.strategy_id, action: l.action_type, status: l.status, success: l.success })),
      active_rules: activeRules.map(r => ({ key: r.rule_key, name: r.name, scope: r.scope })).slice(0, 30),
    };

    // ── 9. Chamar Claude (sem timeout forçado — deixar completar) ─────────
    let aiResponse: any = null;
    let rawAiText = '';
    if (!dryRun) {
      const client = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });
      const systemPrompt = `Você é o auditor estratégico semanal do motor de anúncios Amazon Sponsored Products.

REGRAS ABSOLUTAS (violações são descartadas automaticamente pelo sistema):
- Nunca invente keywords — use APENAS termos de winning_terms ou asins_without_campaign fornecidos
- Bid entre R$${s.min_bid} e R$${s.max_bid}
- Budget mínimo por campanha: R$15
- Budget diário geral máximo: R$${s.daily_budget_cap}
- Placement (top_of_search, rest_of_search, product_pages): limite é ${s.top_of_search_limit}% — se 0, NÃO recomendar execução automática
- Produto sem estoque: NÃO recomendar campanha
- Campanha incompleta: NÃO recomendar otimização
- Proposta de regra: confidence mínima 0.95 para aprovação automática
- Use os dados do dashboard_revenue para calcular TACoS real (não estime sem dados)
- Se unified_week_totals disponível, considere halo_sales e invalid_click_pct nas decisões de bid
- strong_winning_terms: termos com >= 3 pedidos — DEVEM ser incluídos em manual_campaigns_to_create com match_type EXACT se não existir campanha manual para o mesmo ASIN+termo
- paused_campaigns_with_sales: campanhas pausadas que ainda geraram vendas nesta semana — avalie se devem ir para campaigns_to_reactivate

Responda APENAS com JSON válido, sem markdown, sem explicações fora do JSON. Schema obrigatório:
{
  "week_summary": "string",
  "goal_status": {"acos": "ok|warning|critical", "roas": "ok|warning|critical", "tacos": "ok|warning|critical|no_data", "cpc": "ok|warning|critical", "budget": "ok|warning|critical"},
  "winning_terms": [{"asin": "string", "search_term": "string", "reason": "string", "confidence": 0.0, "recommended_action": "string", "bid": 0.0, "budget": 15}],
  "losing_campaigns": [{"campaign_id": "string", "reason": "string", "confidence": 0.0, "recommended_action": "string"}],
  "rule_change_proposals": [{"rule_name": "string", "current_rule": "string", "proposed_rule": "string", "evidence": "string", "confidence": 0.0, "risk": "low|medium|high", "auto_implement": false}],
  "manual_campaigns_to_create": [{"asin": "string", "keyword": "string", "match_type": "EXACT", "bid": 0.0, "budget": 15, "confidence": 0.0}],
  "executive_summary": "string com no máximo 500 caracteres",
  "campaigns_to_reactivate": [{"campaign_id": "string", "reason": "string", "orders_last_7d": 0}]
}`;

      // Sem AbortSignal ou timeout — deixar Claude completar naturalmente
      const msg = await client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: JSON.stringify(claudePayload) }],
      });
      rawAiText = (msg.content[0] as any).text || '';
      try {
        aiResponse = JSON.parse(rawAiText);
      } catch {
        const match = rawAiText.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
        if (match) aiResponse = JSON.parse(match[1]);
      }
    } else {
      aiResponse = {
        week_summary: `Semana ${weekStart}–${weekEnd}: simulação dry_run. ACoS ${weekAcos}% vs meta ${s.target_acos}%.`,
        goal_status: goalStatus,
        winning_terms: winningTerms.slice(0, 5).map(t => ({ asin: t.asin, search_term: t.search_term, reason: t.classification, confidence: 0.90, recommended_action: 'create_manual_exact_campaign', bid: clampBid(t.cpc || 0.60, s), budget: 15 })),
        losing_campaigns: losingCampaigns.slice(0, 3).map(c => ({ campaign_id: c.cid, reason: `ACoS ${c.acos}% sem vendas`, confidence: 0.88, recommended_action: 'reduce_bid' })),
        rule_change_proposals: [],
        manual_campaigns_to_create: [],
        executive_summary: 'Dry run — sem execução real.',
      };
    }

    if (!aiResponse) {
      await base44.asServiceRole.entities.WeeklyMotorPrelection.update(prelectionId, { status: 'failed', completed_at: new Date().toISOString() });
      return Response.json({ ok: false, error: 'Claude não retornou JSON válido.', raw: rawAiText.slice(0, 500) });
    }

    // ── 10. Guardrails pós-Claude ─────────────────────────────────────────
    const realTermSet = new Set(winningTerms.map(t => t.search_term?.toLowerCase()));
    const validManualCampaigns = (aiResponse.manual_campaigns_to_create || []).filter((c: any) => {
      const keyword = (c.keyword || '').toLowerCase();
      if (!realTermSet.has(keyword)) return false;
      if (!productAsins.has(c.asin)) return false;
      if (c.bid < s.min_bid || c.bid > s.max_bid) c.bid = clampBid(c.bid, s);
      if (c.budget < s.min_campaign_budget) c.budget = s.min_campaign_budget;
      return (c.confidence || 0) >= 0.90;
    });
    const campaignsToCreate = validManualCampaigns.slice(0, s.weekly_campaign_capacity);

    const validProposals = (aiResponse.rule_change_proposals || []).filter((p: any) => {
      const conf = p.confidence || 0;
      if (conf < 0.90) return false;
      const ruleText = (p.proposed_rule || '').toLowerCase();
      if (s.top_of_search_limit === 0 && ruleText.includes('top_of_search')) return false;
      if (s.rest_of_search_limit === 0 && ruleText.includes('rest_of_search')) return false;
      return true;
    });

    // ── 11. Salvar MotorRuleChangeProposals ──────────────────────────────
    const savedProposals: any[] = [];
    for (const p of validProposals) {
      const conf = p.confidence || 0;
      const risk = p.risk || 'medium';
      const autoImplement = conf >= 0.95 && (risk === 'low' || risk === 'medium') && !dryRun && s.ai_auto_optimization;
      const status = autoImplement ? 'approved' : (conf >= 0.95 ? 'approved' : 'proposed');
      const proposal = await base44.asServiceRole.entities.MotorRuleChangeProposal.create({
        amazon_account_id: aid,
        weekly_prelection_id: prelectionId,
        rule_name: p.rule_name,
        current_rule: p.current_rule || '',
        proposed_rule: p.proposed_rule || '',
        reason: p.evidence || '',
        evidence: p.evidence || '',
        affected_metric: p.affected_metric || '',
        expected_impact: p.expected_impact || '',
        confidence: conf,
        risk_level: risk,
        status,
        requires_manual_approval: !autoImplement,
        created_at: new Date().toISOString(),
      });
      savedProposals.push(proposal);
    }

    // ── 12. Enfileirar campanhas manuais (janela Amazon) ─────────────────
    let campaignsCreated = 0;
    const campaignCreationResults: any[] = [];
    if (!dryRun && campaignsToCreate.length > 0) {
      const inWindow = isInAmazonWindow();
      for (const camp of campaignsToCreate) {
        if (inWindow) {
          try {
            const res = await base44.functions.invoke('createManualCampaignV2', {
              amazon_account_id: aid,
              asin: camp.asin,
              keyword: camp.keyword,
              match_type: 'EXACT',
              bid: clampBid(camp.bid || s.target_cpc, s),
              budget: Math.max(camp.budget || s.min_campaign_budget, s.min_campaign_budget),
              source: 'weekly_prelection',
            });
            if (res?.data?.ok) {
              campaignsCreated++;
              campaignCreationResults.push({ keyword: camp.keyword, asin: camp.asin, status: 'created', campaign_id: res.data.campaign_id });
            } else {
              campaignCreationResults.push({ keyword: camp.keyword, asin: camp.asin, status: 'failed', error: res?.data?.error });
            }
          } catch (e: any) {
            campaignCreationResults.push({ keyword: camp.keyword, asin: camp.asin, status: 'error', error: e.message });
          }
        } else {
          await base44.asServiceRole.entities.AmazonActionQueue.create({
            amazon_account_id: aid,
            action_type: 'create_manual_campaign',
            payload: JSON.stringify({ asin: camp.asin, keyword: camp.keyword, match_type: 'EXACT', bid: clampBid(camp.bid || s.target_cpc, s), budget: Math.max(camp.budget || 15, 15), source: 'weekly_prelection' }),
            status: 'pending',
            created_at: new Date().toISOString(),
          }).catch(() => {});
          campaignCreationResults.push({ keyword: camp.keyword, asin: camp.asin, status: 'queued' });
        }
      }
    }

    // ── 12b. Retroativamente criar campanhas manuais de strong_winning_terms ──
    if (!dryRun && strongWinningTerms.length > 0) {
      const alreadyManualKws = new Set(
        keywords.filter((k: any) => (k.match_type||'').toLowerCase() === 'exact').map((k: any) => `${k.asin||''}:${(k.keyword_text||'').toLowerCase().trim()}`)
      );
      for (const t of strongWinningTerms.slice(0, s.weekly_campaign_capacity)) {
        const termKey = `${t.asin||''}:${(t.search_term||'').toLowerCase().trim()}`;
        if (alreadyManualKws.has(termKey)) continue;
        if (!productAsins.has(t.asin)) continue;
        const bid = clampBid(t.cpc || s.target_cpc || 0.60, s);
        base44.functions.invoke('createManualCampaignV2', {
          amazon_account_id: aid, asin: t.asin,
          keyword: t.search_term, match_type: 'EXACT',
          bid, budget: s.min_campaign_budget,
          source: 'weekly_prelection_strong_term',
        }).then((res: any) => {
          if (res?.data?.ok && t.asin && t.search_term) {
            // Negativar na AUTO correspondente
            base44.functions.invoke('negateKeywordInAutoCampaign', {
              amazon_account_id: aid, asin: t.asin,
              keyword_text: t.search_term,
              manual_campaign_id: res.data.campaign_id,
              triggered_by: 'weekly_prelection_strong_term',
            }).catch(() => {});
          }
        }).catch(() => {});
      }
    }

    // ── 12c. Reativar campanhas pausadas com vendas (aprovadas pelo Claude) ──
    let reactivated = 0;
    if (!dryRun) {
      const toReactivate = (aiResponse.campaigns_to_reactivate || []).slice(0, 5);
      for (const rec of toReactivate) {
        const campRecord = pausedCampaignsAll.find((c: any) => {
          const cids = [c.campaign_id, c.amazon_campaign_id, c.id].filter(Boolean);
          return cids.includes(rec.campaign_id);
        });
        if (!campRecord) continue;
        // Reativar localmente
        await base44.asServiceRole.entities.Campaign.update(campRecord.id, { state: 'enabled', status: 'enabled' }).catch(() => {});
        // Enfileirar reativação na Amazon
        await base44.asServiceRole.entities.AmazonActionQueue.create({
          amazon_account_id: aid,
          action_type: 'enable_campaign',
          payload: JSON.stringify({ campaign_id: campRecord.campaign_id || campRecord.amazon_campaign_id, reason: rec.reason }),
          status: 'pending',
          created_at: new Date().toISOString(),
        }).catch(() => {});
        reactivated++;
      }
    }

    // ── 13. Métricas finais e save ────────────────────────────────────────
    const allConfs = [...(aiResponse.winning_terms || []), ...(aiResponse.losing_campaigns || [])].map((x: any) => x.confidence || 0);
    const avgConfidence = allConfs.length > 0 ? fmt2(allConfs.reduce((acc, c) => acc + c, 0) / allConfs.length) : 0;
    const requiresManualReview = savedProposals.some(p => p.requires_manual_approval) || (aiResponse.winning_terms || []).some((t: any) => (t.confidence || 0) < 0.95);

    const completedAt = new Date().toISOString();
    await base44.asServiceRole.entities.WeeklyMotorPrelection.update(prelectionId, {
      status: 'completed',
      completed_at: completedAt,
      summary: aiResponse.week_summary || '',
      executive_summary: aiResponse.executive_summary || '',
      total_spend: fmt2(weekTotals.spend),
      total_sales: fmt2(weekTotals.sales),
      total_orders: weekTotals.orders,
      acos: weekAcos,
      roas: weekRoas,
      avg_cpc: weekCpc,
      campaigns_analyzed: activeCampaigns.length,
      products_analyzed: products.length,
      keywords_analyzed: keywords.length,
      winning_terms_count: (aiResponse.winning_terms || []).length,
      losing_terms_count: losingTerms.length,
      new_manual_campaigns_recommended: campaignsToCreate.length,
      new_manual_campaigns_created: campaignsCreated,
      campaigns_to_pause: (aiResponse.losing_campaigns || []).filter((c: any) => c.recommended_action === 'pause').length,
      campaigns_to_archive: (aiResponse.losing_campaigns || []).filter((c: any) => c.recommended_action === 'archive').length,
      rules_reviewed: validProposals.length,
      rules_changed: savedProposals.filter(p => p.status === 'approved').length,
      confidence: avgConfidence,
      requires_manual_review: requiresManualReview,
      goal_status: aiResponse.goal_status || goalStatus,
      winning_terms: aiResponse.winning_terms || [],
      losing_campaigns: aiResponse.losing_campaigns || [],
      manual_campaigns_created: campaignCreationResults,
      raw_ai_response: rawAiText.slice(0, 10000),
    });

    await base44.asServiceRole.entities.StrategyExecutionLog.create({
      strategy_id: 'weekly_prelection',
      amazon_account_id: aid,
      action_type: 'weekly_ai_audit',
      before_metrics: { acos: weekAcos, roas: weekRoas, cpc: weekCpc, spend: weekTotals.spend, tacos },
      action_taken: { prelection_id: prelectionId, campaigns_created: campaignsCreated, proposals: savedProposals.length },
      maturation_hours: 168,
      maturation_until: new Date(Date.now() + 7 * 86400000).toISOString(),
      risk_level: 'low',
      status: 'maturing',
      created_at: completedAt,
    }).catch(() => {});

    return Response.json({
      ok: true,
      prelection_id: prelectionId,
      dry_run: dryRun,
      week: { start: weekStart, end: weekEnd },
      settings_source: s.settings_source,
      week_metrics: { spend: weekTotals.spend, sales: weekTotals.sales, orders: weekTotals.orders, acos: weekAcos, roas: weekRoas, cpc: weekCpc, tacos },
      goal_status: aiResponse.goal_status || goalStatus,
      winning_terms_found: (aiResponse.winning_terms || []).length,
      losing_campaigns_found: (aiResponse.losing_campaigns || []).length,
      rule_proposals: savedProposals.length,
      rules_auto_approved: savedProposals.filter(p => p.status === 'approved').length,
      campaigns_recommended: campaignsToCreate.length,
      campaigns_created: campaignsCreated,
      campaign_results: campaignCreationResults,
      paused_campaigns_with_sales: pausedWithSales.length,
      campaigns_reactivated: reactivated,
      strong_winning_terms_found: strongWinningTerms.length,
      requires_manual_review: requiresManualReview,
      executive_summary: aiResponse.executive_summary || '',
    });

  } catch (error: any) {
    console.error('[runWeeklyMotorPrelection]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});