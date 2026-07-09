/**
 * runBidDecisionEngineV2
 * Motor de decisão de bids com dados dos Relatórios Unificados.
 * Fonte primária: UnifiedAdsMetricsDaily
 * Fallback: CampaignMetricsDaily
 *
 * Considera: ROAS promovido, ACoS promovido, CTR, parcela de impressões,
 * topo de pesquisa, cliques inválidos, produto aura, orçamento em risco,
 * data de tráfego (janela de maturação 48h).
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MIN_BID = 0.10;
const MAX_BID = 5.0;
const MAX_BID_CHANGE_PCT = 0.20;
const MIN_IMPRESSIONS = 100;
const MIN_CLICKS = 5;
const MATURATION_HOURS = 48;
const MAX_INVALID_CLICK_RATE = 0.08; // 8%
const MAX_DIVERGENCE_PCT = 10; // não alterar se dados divergem >10%

function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }
function pctChange(old, pct) { return clamp(old * (1 + pct / 100), MIN_BID, MAX_BID); }

Deno.serve(async (req) => {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

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
    const hasUnified = account.unified_reports_access === true;

    // Configuração alvo
    const [apConfigs] = await Promise.all([
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, null, 1).catch(() => []),
    ]);
    const config = apConfigs[0] || {};
    const targetAcos = config.target_acos || 10;
    const targetRoas = config.target_roas || 4;
    const maxCpc = config.maximum_cpc || MAX_BID;

    // Dados
    const cutoff14 = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);

    const [keywords, campaigns, products, unifiedRaw, legacyRaw, reconciliations] = await Promise.all([
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-spend', 500),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 200),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 100),
      hasUnified
        ? base44.asServiceRole.entities.UnifiedAdsMetricsDaily.filter({ amazon_account_id: aid }, '-date', 500).catch(() => [])
        : Promise.resolve([]),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: aid }, '-date', 300).catch(() => []),
      base44.asServiceRole.entities.UnifiedMetricsReconciliation.filter({ amazon_account_id: aid }, '-date', 200).catch(() => []),
    ]);

    // Construir mapa de divergência por campanha
    const divergenceByCampaign = new Map();
    for (const r of reconciliations) {
      if (!r.campaign_id) continue;
      const existing = divergenceByCampaign.get(r.campaign_id) || 0;
      if (r.difference_percent > existing) divergenceByCampaign.set(r.campaign_id, r.difference_percent);
    }

    // Agregar métricas unificadas por campaign_id (14d)
    const unifiedMetrics = new Map();
    for (const r of unifiedRaw) {
      if (!r.campaign_id || !r.date || r.date < cutoff14) continue;
      if (!unifiedMetrics.has(r.campaign_id)) {
        unifiedMetrics.set(r.campaign_id, {
          cost: 0, sales: 0, purchases: 0, clicks: 0, impressions: 0,
          promoted_purchases: 0, promoted_sales: 0, promoted_roas: 0, promoted_acos: 0,
          halo_purchases: 0, halo_sales: 0,
          invalid_clicks: 0, invalid_click_rate_sum: 0, invalid_click_count: 0,
          impression_share_sum: 0, top_of_search_sum: 0, pacing_sum: 0, rows: 0,
          budget_at_risk: false,
        });
      }
      const e = unifiedMetrics.get(r.campaign_id);
      e.cost += r.cost || 0;
      e.sales += r.sales || 0;
      e.purchases += r.purchases || 0;
      e.clicks += r.clicks || 0;
      e.impressions += r.impressions || 0;
      e.promoted_purchases += r.promoted_purchases || 0;
      e.promoted_sales += r.promoted_sales || 0;
      e.halo_purchases += r.halo_purchases || 0;
      e.halo_sales += r.halo_sales || 0;
      e.invalid_clicks += r.invalid_clicks || 0;
      if (r.invalid_click_rate > 0) { e.invalid_click_rate_sum += r.invalid_click_rate; e.invalid_click_count++; }
      if (r.impression_share > 0) { e.impression_share_sum += r.impression_share; }
      if (r.top_of_search_impression_share > 0) { e.top_of_search_sum += r.top_of_search_impression_share; }
      if (r.budget_at_risk) e.budget_at_risk = true;
      e.rows++;
    }
    // Calcular médias
    for (const [, e] of unifiedMetrics.entries()) {
      e.avg_impression_share = e.rows > 0 ? e.impression_share_sum / e.rows : 0;
      e.avg_top_of_search = e.rows > 0 ? e.top_of_search_sum / e.rows : 0;
      e.avg_invalid_click_rate = e.invalid_click_count > 0 ? e.invalid_click_rate_sum / e.invalid_click_count : 0;
      e.promoted_roas_calc = e.cost > 0 ? e.promoted_sales / e.cost : 0;
      e.promoted_acos_calc = e.promoted_sales > 0 ? e.cost / e.promoted_sales * 100 : 0;
      e.ctr = e.impressions > 0 ? e.clicks / e.impressions : 0;
    }

    // Agregar legacy por campaign_id (14d fallback)
    const legacyMetrics = new Map();
    for (const r of legacyRaw) {
      if (!r.campaign_id || !r.date || r.date < cutoff14) continue;
      if (!legacyMetrics.has(r.campaign_id)) legacyMetrics.set(r.campaign_id, { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 });
      const e = legacyMetrics.get(r.campaign_id);
      e.spend += r.spend || 0; e.sales += r.sales || 0; e.orders += r.orders || 0; e.clicks += r.clicks || 0; e.impressions += r.impressions || 0;
    }

    // Maps de apoio
    const campaignAsinMap = new Map();
    const campaignStateMap = new Map();
    for (const c of campaigns) {
      if (c.campaign_id && c.asin) campaignAsinMap.set(c.campaign_id, c.asin);
      if (c.amazon_campaign_id && c.asin) campaignAsinMap.set(c.amazon_campaign_id, c.asin);
      if (c.campaign_id) campaignStateMap.set(c.campaign_id, c.state || c.status || '');
      if (c.amazon_campaign_id) campaignStateMap.set(c.amazon_campaign_id, c.state || c.status || '');
    }
    const productMap = new Map(products.map(p => [p.asin, p]));

    // Calcular CTR médio da conta (para comparação relativa)
    let totalClicks = 0, totalImpressions = 0;
    for (const [, e] of unifiedMetrics.entries()) { totalClicks += e.clicks; totalImpressions += e.impressions; }
    const accountAvgCtr = totalImpressions > 0 ? totalClicks / totalImpressions : 0.005;

    const decisions: any[] = [];
    const stats = { increase: 0, decrease: 0, hold: 0, skip: 0 };

    for (const kw of keywords) {
      const entityId = kw.keyword_id || kw.id;
      if (!entityId) continue;

      const campaignId = kw.campaign_id;
      const currentBid = kw.current_bid || kw.bid || 0.25;
      const asin = kw.asin || campaignAsinMap.get(campaignId) || null;
      const product = asin ? productMap.get(asin) : null;
      const campaignState = campaignStateMap.get(campaignId) || '';

      // SKIP: campanha incompleta, sem estoque, arquivada
      if (['archived', 'incomplete'].includes(campaignState.toLowerCase())) { stats.skip++; continue; }
      if (product?.inventory_status === 'out_of_stock' || (product?.fba_inventory || 0) === 0) { stats.skip++; continue; }

      // SKIP: divergência excessiva
      const divergence = divergenceByCampaign.get(campaignId) || 0;
      if (divergence > MAX_DIVERGENCE_PCT) { stats.skip++; continue; }

      // Buscar métricas — unificado com fallback para legado
      const unified = unifiedMetrics.get(campaignId);
      const legacy = legacyMetrics.get(campaignId);
      const useUnified = hasUnified && !!unified;
      const metrics = useUnified ? {
        cost: unified.cost,
        sales: unified.promoted_sales > 0 ? unified.promoted_sales : unified.sales,
        purchases: unified.promoted_purchases > 0 ? unified.promoted_purchases : unified.purchases,
        clicks: unified.clicks,
        impressions: unified.impressions,
        promoted_roas: unified.promoted_roas_calc,
        promoted_acos: unified.promoted_acos_calc,
        halo_purchases: unified.halo_purchases,
        halo_sales: unified.halo_sales,
        ctr: unified.ctr,
        avg_impression_share: unified.avg_impression_share,
        avg_top_of_search: unified.avg_top_of_search,
        avg_invalid_click_rate: unified.avg_invalid_click_rate,
        budget_at_risk: unified.budget_at_risk,
      } : legacy ? {
        cost: legacy.spend,
        sales: legacy.sales,
        purchases: legacy.orders,
        clicks: legacy.clicks,
        impressions: legacy.impressions,
        promoted_roas: legacy.sales > 0 ? legacy.sales / legacy.spend : 0,
        promoted_acos: legacy.sales > 0 ? legacy.spend / legacy.sales * 100 : 0,
        halo_purchases: 0, halo_sales: 0,
        ctr: legacy.impressions > 0 ? legacy.clicks / legacy.impressions : 0,
        avg_impression_share: 0, avg_top_of_search: 0, avg_invalid_click_rate: 0, budget_at_risk: false,
      } : null;

      if (!metrics) { stats.hold++; continue; }

      // HOLD: dados insuficientes
      if (metrics.impressions < MIN_IMPRESSIONS || metrics.clicks < MIN_CLICKS) { stats.hold++; continue; }

      // HOLD: campanha recém-criada (< 48h)
      const createdAt = (campaigns.find(c => c.campaign_id === campaignId || c.amazon_campaign_id === campaignId))?.created_at;
      if (createdAt) {
        const ageH = (Date.now() - new Date(createdAt).getTime()) / 3600000;
        if (ageH < MATURATION_HOURS) { stats.hold++; continue; }
      }

      // HOLD: tráfego inválido alto
      if (metrics.avg_invalid_click_rate > MAX_INVALID_CLICK_RATE) { stats.hold++; continue; }

      let action = 'hold';
      let newBid = currentBid;
      let reason = '';

      // INCREASE: ROAS promovido bom + baixa parcela de impressões + CPC abaixo do limite
      const hasGoodRoas = metrics.promoted_roas >= targetRoas;
      const hasGoodAcos = metrics.promoted_acos > 0 && metrics.promoted_acos <= targetAcos;
      const lowImpressionShare = metrics.avg_impression_share < 0.3 && metrics.avg_impression_share > 0;
      const lowTopSearch = metrics.avg_top_of_search < 0.2 && metrics.avg_top_of_search > 0;
      const goodCtr = metrics.ctr >= accountAvgCtr * 0.8;
      const positivePurchases = metrics.purchases >= 1;
      const cpcOk = (metrics.cost > 0 && metrics.clicks > 0 ? metrics.cost / metrics.clicks : 0) < maxCpc;

      if (hasGoodRoas && hasGoodAcos && positivePurchases && cpcOk && (lowImpressionShare || lowTopSearch)) {
        action = 'increase';
        newBid = pctChange(currentBid, Math.min(15, MAX_BID_CHANGE_PCT * 100));
        reason = `ROAS promovido=${metrics.promoted_roas.toFixed(2)}x (meta=${targetRoas}x) + ACoS=${metrics.promoted_acos.toFixed(1)}% + baixa parcela de impressões=${(metrics.avg_impression_share * 100).toFixed(1)}%. Bid +15%.`;
        stats.increase++;
      }
      // DECREASE: ACoS acima da meta OU tráfego inválido OU gasto sem compra
      else if (
        (metrics.promoted_acos > targetAcos * 1.2 && metrics.clicks >= MIN_CLICKS) ||
        (metrics.cost > 5 && metrics.purchases === 0 && metrics.halo_purchases === 0) ||
        (!goodCtr && metrics.avg_impression_share > 0.5)
      ) {
        action = 'decrease';
        const pct = metrics.promoted_acos > targetAcos * 1.5 ? -20 : -10;
        newBid = pctChange(currentBid, pct);
        reason = `ACoS promovido=${metrics.promoted_acos.toFixed(1)}% (meta=${targetAcos}%), compras=${metrics.purchases}, CTR=${(metrics.ctr * 100).toFixed(3)}%. Bid ${pct}%.`;
        stats.decrease++;
      } else {
        stats.hold++;
        reason = 'Dentro da meta ou dados insuficientes para decisão.';
      }

      if (action !== 'hold' && Math.abs(newBid - currentBid) > 0.01) {
        decisions.push({
          amazon_account_id: aid,
          date: today,
          entity_type: 'keyword',
          entity_id: entityId,
          campaign_id: campaignId,
          keyword_id: kw.keyword_id,
          asin,
          current_bid: currentBid,
          new_bid: newBid,
          action,
          reason,
          data_source: useUnified ? 'unified_reports' : 'legacy',
          promoted_roas: metrics.promoted_roas,
          promoted_acos: metrics.promoted_acos,
          impression_share: metrics.avg_impression_share,
          top_of_search_pct: metrics.avg_top_of_search,
          invalid_click_rate: metrics.avg_invalid_click_rate,
          halo_purchases: metrics.halo_purchases,
          budget_at_risk: metrics.budget_at_risk,
          status: 'pending',
          created_at: now,
        });
      }
    }

    // Salvar decisões como RuleExecution entries
    for (let i = 0; i < decisions.length; i += 50) {
      await base44.asServiceRole.entities.RuleExecution.bulkCreate(
        decisions.slice(i, i + 50).map(d => ({
          amazon_account_id: aid,
          rule_key: `bid_v2_${d.action}`,
          entity_type: d.entity_type,
          entity_id: d.entity_id,
          campaign_id: d.campaign_id,
          keyword_id: d.keyword_id,
          asin: d.asin,
          action_type: 'set_bid',
          value_before: d.current_bid,
          value_after: d.new_bid,
          idempotency_key: `bidv2|${aid}|${d.entity_id}|${today}`,
          status: 'pending',
          reason: d.reason,
          seasonal_context: JSON.stringify({ data_source: d.data_source, promoted_roas: d.promoted_roas }),
        }))
      ).catch(() => {});
    }

    return Response.json({
      ok: true,
      data_source: hasUnified ? 'unified_reports' : 'legacy_fallback',
      keywords_evaluated: keywords.length,
      decisions_made: decisions.length,
      stats,
      account_avg_ctr_pct: (accountAvgCtr * 100).toFixed(4),
      target_acos: targetAcos,
      target_roas: targetRoas,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});