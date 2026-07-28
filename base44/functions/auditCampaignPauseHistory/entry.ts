/**
 * auditCampaignPauseHistory — Auditoria de Causa Raiz de Pausas
 *
 * Varre os últimos 30 dias de OptimizationDecision (decision_type=pause),
 * SyncExecutionLog e CampaignChangeHistory para reconstruir a sequência de eventos
 * que levou ao incidente de zero campanhas ativas.
 *
 * Output: lista de campanhas afetadas com:
 *   campaign_id, campaign_name, ASIN, state_before, state_after,
 *   timestamp, function_name, rule_key, reason, orders_14d, acos_14d, stock
 *
 * Registra resultado em SyncExecutionLog com
 * operation='zero_campaign_root_cause_audit'.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role) {
      const user = await base44.auth.me();
      if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    // Resolver conta
    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1);
      account = accs[0] || null;
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada.' });

    const aid = account.id;
    const now = new Date().toISOString();
    const cutoff30d = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const cutoff14d = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);

    // ── 1. Carregar todas as fontes de dados ──────────────────────────────────
    const [
      pauseDecisions,
      campaignChanges,
      syncLogs,
      campaigns,
      products,
      metrics14dRaw,
    ] = await Promise.all([
      // Decisões de pausa dos últimos 30 dias
      base44.asServiceRole.entities.OptimizationDecision.filter(
        { amazon_account_id: aid, decision_type: 'pause' }, '-created_at', 500
      ).catch(() => []),
      // Histórico de mudanças de campanhas
      base44.asServiceRole.entities.CampaignChangeHistory.filter(
        { amazon_account_id: aid }, '-created_at', 500
      ).catch(() => []),
      // Logs de sincronização
      base44.asServiceRole.entities.SyncExecutionLog.filter(
        { amazon_account_id: aid }, '-started_at', 200
      ).catch(() => []),
      // Estado atual das campanhas
      base44.asServiceRole.entities.Campaign.filter(
        { amazon_account_id: aid }, null, 300
      ).catch(() => []),
      // Estado atual dos produtos
      base44.asServiceRole.entities.Product.filter(
        { amazon_account_id: aid }, null, 200
      ).catch(() => []),
      // Métricas 14d para contexto de performance
      base44.asServiceRole.entities.CampaignMetricsDaily.filter(
        { amazon_account_id: aid }, '-date', 500
      ).catch(() => []),
    ]);

    // ── 2. Filtrar por janela de 30 dias ──────────────────────────────────────
    const recentPauses = pauseDecisions.filter((d: any) =>
      (d.created_at || d.created_date || '') >= cutoff30d
    );

    const recentChanges = campaignChanges.filter((c: any) =>
      (c.created_at || c.created_date || '') >= cutoff30d &&
      (String(c.new_state || c.new_status || '').toLowerCase().includes('paused') ||
       String(c.new_state || c.new_status || '').toLowerCase().includes('archived'))
    );

    // ── 3. Indexar métricas 14d por campaign_id ───────────────────────────────
    const metrics14dFiltered = metrics14dRaw.filter((m: any) => (m.date || '') >= cutoff14d);
    const metricsByCampaign = new Map<string, { orders: number; spend: number; sales: number; impressions: number }>();
    for (const m of metrics14dFiltered) {
      if (!m.campaign_id) continue;
      const ex = metricsByCampaign.get(m.campaign_id) || { orders: 0, spend: 0, sales: 0, impressions: 0 };
      ex.orders += m.orders || 0;
      ex.spend += m.spend || 0;
      ex.sales += m.sales || 0;
      ex.impressions += m.impressions || 0;
      metricsByCampaign.set(m.campaign_id, ex);
    }

    // ── 4. Indexar produtos por ASIN ──────────────────────────────────────────
    const productByAsin = new Map<string, any>();
    for (const p of products) { if (p.asin) productByAsin.set(p.asin, p); }

    // ── 5. Indexar campanhas ──────────────────────────────────────────────────
    const campaignById = new Map<string, any>();
    for (const c of campaigns) {
      if (c.campaign_id) campaignById.set(c.campaign_id, c);
      if (c.amazon_campaign_id) campaignById.set(c.amazon_campaign_id, c);
      if (c.id) campaignById.set(c.id, c);
    }

    // ── 6. Reconstruir timeline de pausas ─────────────────────────────────────
    const pauseEvents: any[] = [];

    // Processar decisões de pausa
    for (const d of recentPauses) {
      const cid = d.campaign_id || d.entity_id;
      const camp = cid ? campaignById.get(cid) : null;
      const asin = d.asin || camp?.asin;
      const product = asin ? productByAsin.get(asin) : null;
      const metrics = cid ? metricsByCampaign.get(cid) : null;
      const acos14d = metrics && metrics.sales > 0 ? (metrics.spend / metrics.sales) * 100 : null;

      // Classificar o evento
      const isWinnerViolation = (metrics?.orders ?? 0) > 0 && acos14d !== null && acos14d <= 15;
      const hasStock = Number(product?.fba_inventory || 0) > 0;

      pauseEvents.push({
        event_type: 'optimization_decision',
        campaign_id: cid,
        campaign_name: camp?.campaign_name || camp?.name || d.campaign_id || d.entity_id,
        asin,
        state_before: d.value_before || 'enabled',
        state_after: 'paused',
        timestamp: d.created_at || d.created_date,
        function_name: d.source_function || 'unknown',
        rule_key: d.rule_key || d.decision_type,
        reason: d.rationale?.slice(0, 200) || d.action,
        orders_14d: metrics?.orders ?? 0,
        acos_14d: acos14d !== null ? Math.round(acos14d * 10) / 10 : null,
        stock: Number(product?.fba_inventory || 0),
        decision_status: d.status,
        is_winner_violation: isWinnerViolation,
        has_stock_but_paused: hasStock,
        risk: d.risk || 'unknown',
      });
    }

    // Processar mudanças de histórico de campanhas
    for (const ch of recentChanges) {
      const cid = ch.campaign_id || ch.entity_id;
      if (recentPauses.some((d: any) => d.campaign_id === cid)) continue; // já processado
      const camp = cid ? campaignById.get(cid) : null;
      const asin = ch.asin || camp?.asin;
      const product = asin ? productByAsin.get(asin) : null;
      const metrics = cid ? metricsByCampaign.get(cid) : null;
      const acos14d = metrics && metrics.sales > 0 ? (metrics.spend / metrics.sales) * 100 : null;
      const hasStock = Number(product?.fba_inventory || 0) > 0;

      pauseEvents.push({
        event_type: 'campaign_change_history',
        campaign_id: cid,
        campaign_name: ch.campaign_name || camp?.campaign_name || cid,
        asin,
        state_before: ch.old_state || ch.old_status || 'enabled',
        state_after: ch.new_state || ch.new_status,
        timestamp: ch.created_at || ch.created_date,
        function_name: ch.changed_by || ch.source_function || 'unknown',
        rule_key: ch.rule_key || 'campaign_change_history',
        reason: ch.reason?.slice(0, 200),
        orders_14d: metrics?.orders ?? 0,
        acos_14d: acos14d !== null ? Math.round(acos14d * 10) / 10 : null,
        stock: Number(product?.fba_inventory || 0),
        decision_status: 'executed',
        is_winner_violation: (metrics?.orders ?? 0) > 0 && acos14d !== null && acos14d <= 15,
        has_stock_but_paused: hasStock,
        risk: 'unknown',
      });
    }

    // Ordenar por timestamp descendente
    pauseEvents.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());

    // ── 7. Análise de causa raiz ───────────────────────────────────────────────
    const totalPauses = pauseEvents.length;
    const winnerViolations = pauseEvents.filter(e => e.is_winner_violation);
    const pausedWithStock = pauseEvents.filter(e => e.has_stock_but_paused && e.stock > 0);
    const currentActiveCampaigns = campaigns.filter(c => {
      const s = String(c.state || c.status || '').toLowerCase();
      return s === 'enabled';
    }).length;
    const currentArchivedCount = campaigns.filter(c => {
      const s = String(c.state || c.status || '').toLowerCase();
      return s === 'archived';
    }).length;

    // Funções que mais causaram pausas
    const pausesByFunction = pauseEvents.reduce((acc: any, e) => {
      const fn = e.function_name || 'unknown';
      acc[fn] = (acc[fn] || 0) + 1;
      return acc;
    }, {});

    // Regras que mais causaram pausas
    const pausesByRule = pauseEvents.reduce((acc: any, e) => {
      const rk = e.rule_key || 'unknown';
      acc[rk] = (acc[rk] || 0) + 1;
      return acc;
    }, {});

    const rootCauseAnalysis = {
      total_pause_events_30d: totalPauses,
      winner_violations: winnerViolations.length,
      paused_with_stock: pausedWithStock.length,
      current_active_campaigns: currentActiveCampaigns,
      current_archived_campaigns: currentArchivedCount,
      top_functions_causing_pauses: Object.entries(pausesByFunction)
        .sort((a: any, b: any) => b[1] - a[1])
        .slice(0, 10)
        .map(([fn, count]) => ({ function: fn, count })),
      top_rules_causing_pauses: Object.entries(pausesByRule)
        .sort((a: any, b: any) => b[1] - a[1])
        .slice(0, 10)
        .map(([rule, count]) => ({ rule, count })),
      severity: winnerViolations.length > 5 || currentActiveCampaigns === 0 ? 'critical'
        : winnerViolations.length > 0 || pausedWithStock.length > 2 ? 'high'
        : totalPauses > 10 ? 'medium' : 'low',
      recommendations: [
        currentActiveCampaigns === 0 ? '🚨 ZERO CAMPANHAS ATIVAS: reativar imediatamente via checkAndEnableCampaigns' : null,
        winnerViolations.length > 0 ? `⚠️ ${winnerViolations.length} vencedor(es) pausado(s) erroneamente — reativar via reactivateWinnerCampaign` : null,
        pausedWithStock.length > 0 ? `📦 ${pausedWithStock.length} campanha(s) pausada(s) com estoque disponível — revisar via reactivatePausedWithStock` : null,
      ].filter(Boolean),
    };

    // ── 8. Registrar auditoria no SyncExecutionLog ────────────────────────────
    const summary = JSON.stringify({
      total_pauses: totalPauses,
      winner_violations: winnerViolations.length,
      paused_with_stock: pausedWithStock.length,
      active_now: currentActiveCampaigns,
      severity: rootCauseAnalysis.severity,
      top_function: rootCauseAnalysis.top_functions_causing_pauses[0]?.function || 'unknown',
    });

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'zero_campaign_root_cause_audit',
      status: 'completed',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      execution_date: now.slice(0, 10),
      started_at: new Date(t0).toISOString(),
      completed_at: now,
      duration_ms: Date.now() - t0,
      records_processed: totalPauses,
      result_summary: summary,
    }).catch(() => {});

    return Response.json({
      ok: true,
      audit_period: `${cutoff30d} → ${now.slice(0, 10)}`,
      root_cause_analysis: rootCauseAnalysis,
      pause_events: pauseEvents.slice(0, 100), // limitar output a 100 eventos
      winner_violation_events: winnerViolations.slice(0, 20),
      duration_ms: Date.now() - t0,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});