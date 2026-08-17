/**
 * reconcileUnifiedVsLegacyMetrics
 * Compara UnifiedAdsMetricsDaily com CampaignMetricsDaily por campanha/data.
 * Salva resultado em UnifiedMetricsReconciliation.
 * Gera alertas se diferença > 3%.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    let account = null;
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
    const days = body.days || 14;
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const now = new Date().toISOString();

    const [unifiedRaw, legacyRaw] = await Promise.all([
      base44.asServiceRole.entities.UnifiedAdsMetricsDaily.filter({ amazon_account_id: aid }, '-date', 500),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 500),
    ]);

    // Agregar unified por campaign_id + date
    const unifiedMap = new Map();
    for (const r of unifiedRaw) {
      if (!r.date || r.date < cutoff) continue;
      const k = `${r.campaign_id}|${r.date}`;
      if (!unifiedMap.has(k)) unifiedMap.set(k, { spend: 0, sales: 0, purchases: 0, clicks: 0, impressions: 0, campaign_id: r.campaign_id, date: r.date });
      const e = unifiedMap.get(k);
      e.spend += r.cost || 0;
      e.sales += r.sales || 0;
      e.purchases += r.purchases || 0;
      e.clicks += r.clicks || 0;
      e.impressions += r.impressions || 0;
    }

    // Agregar legacy por campaign_id + date
    const legacyMap = new Map();
    for (const r of legacyRaw) {
      if (!r.date || r.date < cutoff) continue;
      const k = `${r.campaign_id}|${r.date}`;
      if (!legacyMap.has(k)) legacyMap.set(k, { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0, campaign_id: r.campaign_id, date: r.date });
      const e = legacyMap.get(k);
      e.spend += r.spend || 0;
      e.sales += r.sales || 0;
      e.orders += r.orders || 0;
      e.clicks += r.clicks || 0;
      e.impressions += r.impressions || 0;
    }

    const reconciliations: any[] = [];
    let warnings = 0, ok = 0, critical = 0;

    for (const [k, legacy] of legacyMap.entries()) {
      const unified = unifiedMap.get(k);
      if (!unified) continue; // sem dados unificados para comparar

      const spendDiff = legacy.spend > 0 ? Math.abs(unified.spend - legacy.spend) / legacy.spend * 100 : 0;
      const salesDiff = legacy.sales > 0 ? Math.abs(unified.sales - legacy.sales) / legacy.sales * 100 : 0;
      const clicksDiff = legacy.clicks > 0 ? Math.abs(unified.clicks - legacy.clicks) / legacy.clicks * 100 : 0;
      const maxDiff = Math.max(spendDiff, salesDiff, clicksDiff);

      let status = 'ok';
      if (maxDiff > 10) { status = 'critical'; critical++; }
      else if (maxDiff > 3) { status = 'warning'; warnings++; }
      else ok++;

      reconciliations.push({
        amazon_account_id: aid,
        date: legacy.date,
        campaign_id: legacy.campaign_id,
        legacy_spend: legacy.spend,
        unified_spend: unified.spend,
        spend_diff: spendDiff,
        legacy_sales: legacy.sales,
        unified_sales: unified.sales,
        sales_diff: salesDiff,
        legacy_orders: legacy.orders,
        unified_purchases: unified.purchases,
        orders_diff: legacy.orders > 0 ? Math.abs(unified.purchases - legacy.orders) / legacy.orders * 100 : 0,
        legacy_clicks: legacy.clicks,
        unified_clicks: unified.clicks,
        clicks_diff: clicksDiff,
        legacy_impressions: legacy.impressions,
        unified_impressions: unified.impressions,
        impressions_diff: legacy.impressions > 0 ? Math.abs(unified.impressions - legacy.impressions) / legacy.impressions * 100 : 0,
        difference_percent: maxDiff,
        status,
        created_at: now,
      });
    }

    // Save reconciliations in batches
    for (let i = 0; i < reconciliations.length; i += 100) {
      await base44.asServiceRole.entities.UnifiedMetricsReconciliation.bulkCreate(reconciliations.slice(i, i + 100)).catch(() => {});
    }

    // Create alert if many warnings/criticals
    if (warnings + critical > 0) {
      await base44.asServiceRole.entities.Alert.create({
        amazon_account_id: aid,
        type: 'unified_reconciliation',
        severity: critical > 0 ? 'high' : 'medium',
        title: `Divergência entre relatórios Unificados e Legados`,
        message: `${critical} campanhas com divergência crítica (>10%) e ${warnings} com alerta (>3%) nos últimos ${days} dias. Verifique janela de atribuição e data de tráfego.`,
        created_at: now,
      }).catch(() => {});
    }

    return Response.json({
      ok: true,
      reconciled: reconciliations.length,
      status_summary: { ok, warnings, critical },
      divergence_threshold_pct: 3,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});