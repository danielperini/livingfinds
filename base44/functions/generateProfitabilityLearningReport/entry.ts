/**
 * generateProfitabilityLearningReport
 *
 * Gera relatório consolidado de lucratividade por produto.
 * Lista: produtos com prejuízo, saudáveis, escaláveis, ações tomadas e bloqueadas.
 * NÃO chama Amazon. NÃO altera dados.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function safe(v: unknown): number {
  const n = Number(v);
  return isNaN(n) || !isFinite(n) ? 0 : n;
}

Deno.serve(async (req) => {
  const start = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const auth = await base44.auth.isAuthenticated().catch(() => false);
    if (!auth && !body._service_role) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    let amazonAccountId = body.amazon_account_id;
    if (!amazonAccountId) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      if (!accs.length) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });
      amazonAccountId = accs[0].id;
    }

    const learnings = await base44.asServiceRole.entities.ProductProfitabilityLearning.filter(
      { amazon_account_id: amazonAccountId }, '-gross_revenue', 100
    );

    const actions = await base44.asServiceRole.entities.AmazonActionQueue.filter(
      { amazon_account_id: amazonAccountId, rule_applied: 'PRODUCT_LOSS_GUARD' }, '-created_date', 200
    ).catch(() => []);

    const rows = learnings as Record<string, unknown>[];

    const grossLoss = rows.filter(r => r.profitability_status === 'gross_loss');
    const blockedForAds = rows.filter(r => r.profitability_status === 'blocked_for_ads');
    const postAdsLoss = rows.filter(r => r.profitability_status === 'post_ads_loss');
    const breakEven = rows.filter(r => r.profitability_status === 'break_even');
    const lowProfit = rows.filter(r => r.profitability_status === 'low_profit');
    const healthy = rows.filter(r => r.profitability_status === 'healthy_profit');
    const strong = rows.filter(r => r.profitability_status === 'strong_profit');

    const tacosBiggerThanMargin = rows.filter(r =>
      safe(r.tacos_pct) > safe(r.gross_margin_pct) && safe(r.gross_margin_pct) > 0
    );
    const adsBiggerThanProfit = rows.filter(r =>
      safe(r.ads_cost) > safe(r.gross_profit) && safe(r.gross_profit) > 0
    );

    const scalable = rows.filter(r =>
      ['strong_profit', 'healthy_profit'].includes(String(r.profitability_status || '')) &&
      safe(r.mpa_pct) >= 10
    );

    // Economia estimada por produtos com bid_increase_blocked
    const blockedBidProds = rows.filter(r => r.bid_increase_blocked === true);
    const estimatedSavings = blockedBidProds.reduce((s, r) => s + safe(r.ads_cost) * 0.20, 0);

    // Ações tomadas
    const actionsApproved = (actions as Record<string, unknown>[]).filter(a => a.status === 'approved' || a.status === 'executed');
    const actionsBlocked = blockedBidProds.length;

    const report = {
      generated_at: new Date().toISOString(),
      period: rows.length > 0 ? { start: rows[0].period_start, end: rows[0].period_end } : null,
      summary: {
        total_products: rows.length,
        gross_loss: grossLoss.length,
        blocked_for_ads: blockedForAds.length,
        post_ads_loss: postAdsLoss.length,
        break_even: breakEven.length,
        low_profit: lowProfit.length,
        healthy_profit: healthy.length,
        strong_profit: strong.length,
        tacos_bigger_than_margin: tacosBiggerThanMargin.length,
        ads_bigger_than_gross_profit: adsBiggerThanProfit.length,
      },
      deficit_products: [...grossLoss, ...blockedForAds, ...postAdsLoss].map(r => ({
        sku: r.sku,
        product_name: r.product_name,
        profitability_status: r.profitability_status,
        gross_revenue: r.gross_revenue,
        gross_profit: r.gross_profit,
        ads_cost: r.ads_cost,
        profit_after_ads: r.profit_after_ads,
        mpa_pct: r.mpa_pct,
        tacos_pct: r.tacos_pct,
        gross_margin_pct: r.gross_margin_pct,
        decision_recommendation: r.decision_recommendation,
        ads_blocked: r.ads_blocked,
        bid_increase_blocked: r.bid_increase_blocked,
      })),
      healthy_products: [...healthy, ...strong].map(r => ({
        sku: r.sku,
        product_name: r.product_name,
        profitability_status: r.profitability_status,
        gross_revenue: r.gross_revenue,
        profit_after_ads: r.profit_after_ads,
        mpa_pct: r.mpa_pct,
        tacos_pct: r.tacos_pct,
        decision_recommendation: r.decision_recommendation,
      })),
      scalable_products: scalable.map(r => ({
        sku: r.sku,
        product_name: r.product_name,
        mpa_pct: r.mpa_pct,
        gross_revenue: r.gross_revenue,
        profit_after_ads: r.profit_after_ads,
        performance_class: r.performance_class,
      })),
      tacos_bigger_than_margin_list: tacosBiggerThanMargin.map(r => ({
        sku: r.sku,
        tacos_pct: r.tacos_pct,
        gross_margin_pct: r.gross_margin_pct,
        ads_cost: r.ads_cost,
      })),
      actions_taken: actionsApproved.length,
      actions_blocked_increase: actionsBlocked,
      estimated_savings_per_period: Math.round(estimatedSavings * 100) / 100,
      rules_applied: ['PROFIT_AFTER_ADS_RULE', 'PRODUCT_LOSS_GUARD'],
      recommendations: [
        grossLoss.length > 0 ? `${grossLoss.length} produto(s) com margem bruta negativa: não anunciar até corrigir preço/custo.` : null,
        blockedForAds.length > 0 ? `${blockedForAds.length} produto(s) onde Ads supera lucro bruto: reduzir Ads agressivamente.` : null,
        postAdsLoss.length > 0 ? `${postAdsLoss.length} produto(s) com prejuízo pós Ads: revisar keywords e bids.` : null,
        scalable.length > 0 ? `${scalable.length} produto(s) com MPA >= 10% e prontos para escala controlada.` : null,
        tacosBiggerThanMargin.length > 0 ? `${tacosBiggerThanMargin.length} produto(s) com TACOS > margem bruta: Ads destrói lucro.` : null,
      ].filter(Boolean),
    };

    return Response.json({ ok: true, report, duration_ms: Date.now() - start });

  } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
});