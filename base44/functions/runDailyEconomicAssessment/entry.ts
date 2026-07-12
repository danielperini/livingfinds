/**
 * runDailyEconomicAssessment — Aferição Econômica Diária por Produto/Campanha/Keyword
 *
 * FILOSOFIA:
 *   - Usa exclusivamente dados persistidos e confirmados (CampaignMetricsDaily, SalesDaily, ProductEconomics)
 *   - Nunca zera métricas quando relatório falhar — preserva último conjunto válido
 *   - Não executa ações diretamente — gera sinais para o runUnifiedDecisionEngine
 *   - Idempotente: mesma chave (account + date + asin) não duplica
 *   - Somente data_status = complete ou dias com dados válidos (>= yesterday)
 *
 * FÓRMULAS:
 *   ACoS = spend / ads_sales * 100  (quando ads_sales > 0, senão acos_status = no_sales)
 *   ROAS = ads_sales / spend
 *   TACoS = spend / real_sales * 100 (quando real_sales > 0 de SP-API, senão tacos_data_partial = true)
 *   profit_after_ads = real_sales - product_cost - amazon_fees - taxes - logistics - other_costs - spend
 *
 * CLASSIFICAÇÃO ECONÔMICA:
 *   profitable          = profit_after_ads > 0 AND acos <= target_acos
 *   low_profit          = profit_after_ads > 0 AND acos > target_acos AND acos < break_even_acos
 *   break_even          = profit_after_ads próximo de zero OR acos próximo de break_even
 *   unprofitable        = profit_after_ads < 0 OR acos > break_even_acos
 *   no_sales_with_spend = spend > 0 AND ads_sales = 0
 *   insufficient_data   = dados incompletos / stale / sem evidência mínima
 *   stock_blocked       = produto sem estoque
 *   listing_blocked     = produto com listing suprimido/inativo
 *
 * DECISÕES GERADAS (via runUnifiedDecisionEngine):
 *   Baixo risco (imediatas): redução ≤10%, sugestão Amazon menor, bid calibração
 *   Alto risco (aprovação): aumento >10%, redução >25% acumulado, pausa de campanha, alteração estrutural
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function nowIso() { return new Date().toISOString(); }
function todayBRT() { return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10); }
function yesterdayBRT() {
  const t = new Date(Date.now() - 3 * 3600000);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}
function daysAgo(n: number) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

// ── Classificação econômica ───────────────────────────────────────────────────
function classifyEconomicStatus(params: {
  spend: number;
  ads_sales: number;
  profit_after_ads: number | null;
  acos: number | null;
  target_acos: number;
  break_even_acos: number;
  stock_qty: number;
  listing_buyable: boolean;
  has_economics: boolean;
}): { status: string; acos_status: string; main_problem: string; confidence: number } {
  const { spend, ads_sales, profit_after_ads, acos, target_acos, break_even_acos, stock_qty, listing_buyable, has_economics } = params;

  if (!listing_buyable) return { status: 'listing_blocked', acos_status: 'unavailable', main_problem: 'Listing suprimido ou inativo', confidence: 0.9 };
  if (stock_qty <= 0) return { status: 'stock_blocked', acos_status: 'unavailable', main_problem: 'Estoque zero — campanha bloqueada pelo sistema', confidence: 1.0 };

  if (spend > 0 && ads_sales === 0) return { status: 'no_sales_with_spend', acos_status: 'no_sales', main_problem: `Gasto R$${spend.toFixed(2)} sem vendas atribuídas`, confidence: 0.85 };

  if (!has_economics || profit_after_ads === null) {
    return { status: 'insufficient_data', acos_status: 'unavailable', main_problem: 'Dados econômicos incompletos (custo não cadastrado)', confidence: 0.3 };
  }

  const acosV = acos ?? 0;
  let acos_status = 'unavailable';
  if (ads_sales > 0 && acosV > 0) {
    if (acosV <= target_acos) acos_status = 'below_target';
    else if (acosV <= target_acos * 1.10) acos_status = 'slightly_above';
    else if (acosV <= break_even_acos) acos_status = 'above_break_even';
    else acos_status = 'above_break_even';
  } else if (ads_sales === 0) {
    acos_status = 'no_sales';
  }

  const ZERO_THRESHOLD = 0.5; // R$0.50 considera break-even
  if (profit_after_ads > ZERO_THRESHOLD && acosV <= target_acos) {
    return { status: 'profitable', acos_status, main_problem: '', confidence: 0.9 };
  }
  if (profit_after_ads > ZERO_THRESHOLD && acosV > target_acos && acosV < break_even_acos) {
    return { status: 'low_profit', acos_status, main_problem: `ACoS ${acosV.toFixed(1)}% acima da meta ${target_acos}%`, confidence: 0.85 };
  }
  if (Math.abs(profit_after_ads) <= ZERO_THRESHOLD || Math.abs(acosV - break_even_acos) <= 2) {
    return { status: 'break_even', acos_status, main_problem: `Produto no limite do break-even (ACoS ${acosV.toFixed(1)}%)`, confidence: 0.8 };
  }
  if (profit_after_ads < -ZERO_THRESHOLD || acosV > break_even_acos) {
    return {
      status: 'unprofitable', acos_status,
      main_problem: profit_after_ads < 0
        ? `Lucro negativo: R$${profit_after_ads.toFixed(2)}/pedido`
        : `ACoS ${acosV.toFixed(1)}% acima do break-even ${break_even_acos.toFixed(1)}%`,
      confidence: 0.9
    };
  }

  return { status: 'insufficient_data', acos_status: 'unavailable', main_problem: 'Dados insuficientes para classificação definitiva', confidence: 0.4 };
}

// ── Recomendar ação com base na classificação ────────────────────────────────
function recommendAction(params: {
  status: string;
  acos: number | null;
  acos_status: string;
  target_acos: number;
  break_even_acos: number;
  spend: number;
  clicks: number;
  orders: number;
  maximum_profitable_cpa: number;
  cost_per_order: number;
  profit_after_ads: number | null;
}): string {
  const { status, acos, acos_status, target_acos, break_even_acos, spend, clicks, orders, maximum_profitable_cpa, cost_per_order, profit_after_ads } = params;

  if (status === 'profitable') return 'hold_or_scale_visibility';
  if (status === 'stock_blocked') return 'pause_campaigns_stock_zero';
  if (status === 'listing_blocked') return 'fix_listing_then_resume';

  if (status === 'no_sales_with_spend') {
    if (spend >= maximum_profitable_cpa && clicks >= 20) return 'pause_deficient_keywords_and_review_search_terms';
    if (clicks >= 10 || spend >= 6) return 'review_search_terms_and_reduce_bid_10pct';
    return 'monitor_72h_then_review';
  }

  if (status === 'unprofitable') {
    if (acos !== null && acos > break_even_acos * 1.5) return 'reduce_bid_10pct_check_amazon_suggestion';
    return 'reduce_bid_10pct_review_keywords';
  }

  if (status === 'low_profit') {
    if (acos_status === 'slightly_above') return 'hold_slight_above_with_positive_trend';
    return 'reduce_bid_10pct_check_amazon_suggestion';
  }

  if (status === 'break_even') return 'hold_monitor_48h';

  return 'monitor_collect_more_data';
}

// ── HANDLER PRINCIPAL ─────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const t0 = Date.now();
  const startedAt = nowIso();

  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role) {
      const authenticated = await base44.auth.isAuthenticated().catch(() => false);
      if (!authenticated) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const forceDate: string | null = body.assessment_date || null; // permite forçar uma data específica
    const dry_run = body.dry_run === true;

    // ── Resolver conta ─────────────────────────────────────────────────────
    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada.' });
    const aid = account.id;

    // ── Determinar data de aferição: último dia fechado com dados válidos ──
    // Nunca usar o dia atual parcial. Usar yesterdayBRT como padrão.
    const assessmentDate = forceDate || yesterdayBRT();

    // ── Verificar freshness dos dados ──────────────────────────────────────
    const dataAgeH = account.last_sync_at
      ? (Date.now() - new Date(account.last_sync_at).getTime()) / 3600000 : 999;
    if (dataAgeH > 48 && !body._service_role) {
      return Response.json({
        ok: false, skipped: true,
        reason: `Dados desatualizados (${Math.round(dataAgeH)}h). Execute sync primeiro.`
      });
    }

    // ── Verificar idempotência de hoje ─────────────────────────────────────
    // Não criar dois relatórios para a mesma data a menos que force=true
    if (!body.force && !dry_run) {
      const existing = await base44.asServiceRole.entities.DailyProductAdsAssessment.filter(
        { amazon_account_id: aid, assessment_date: assessmentDate },
        null, 1
      ).catch(() => []);
      if (existing.length > 0) {
        return Response.json({
          ok: true, skipped: true,
          reason: `Aferição para ${assessmentDate} já existe (${existing.length} registros). Use force=true para reprocessar.`,
          assessment_date: assessmentDate,
        });
      }
    }

    // ── Carregar todos os dados necessários em paralelo ────────────────────
    const cutoff14d = daysAgo(14);
    const cutoff7d = daysAgo(7);

    const [
      campaigns, products, productEconomics, metricsRaw, salesDailyRaw, keywordsRaw, perfSettings
    ] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 300),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 200),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, null, 200).catch(() => []),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter(
        { amazon_account_id: aid }, '-date', 500
      ).catch(() => []),
      base44.asServiceRole.entities.SalesDaily.filter(
        { amazon_account_id: aid }, '-date', 500
      ).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter(
        { amazon_account_id: aid }, '-spend', 500
      ).catch(() => []),
      base44.asServiceRole.entities.PerformanceSettings.filter(
        { amazon_account_id: aid }, '-updated_at', 1
      ).catch(() => []),
    ]);

    const ps = perfSettings[0] || null;
    const accountTargetAcos = Number(ps?.target_acos || 20);

    // ── Construir índices ─────────────────────────────────────────────────
    const normSku = (s: string) => (s || '').trim().toUpperCase().replace(/\s+/g, '-').replace(/-{2,}/g, '-');

    const econByAsin = new Map<string, any>();
    const econBySku = new Map<string, any>();
    for (const e of productEconomics) {
      if (e.asin) econByAsin.set(e.asin, e);
      if (e.sku) econBySku.set(normSku(e.sku), e);
    }

    // Mapear campaign_id → asin
    const campaignAsinMap = new Map<string, string>();
    for (const c of campaigns) {
      const a = c.asin || '';
      if (a && c.campaign_id) campaignAsinMap.set(c.campaign_id, a);
      if (a && c.amazon_campaign_id) campaignAsinMap.set(c.amazon_campaign_id, a);
    }

    // Métricas do dia de aferição (filtrar pelo assessmentDate)
    const metricsOnDate = metricsRaw.filter((m: any) => m.date === assessmentDate);
    const metrics14d = metricsRaw.filter((m: any) => m.date >= cutoff14d);

    // Agregar métricas por ASIN (dia de aferição)
    const adsByAsin = new Map<string, { spend: number; sales: number; orders: number; clicks: number; impressions: number }>();
    for (const m of metricsOnDate) {
      const asin = campaignAsinMap.get(m.campaign_id) || '';
      if (!asin) continue;
      if (!adsByAsin.has(asin)) adsByAsin.set(asin, { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 });
      const e = adsByAsin.get(asin)!;
      e.spend += m.spend || 0;
      e.sales += m.sales || 0;
      e.orders += m.orders || 0;
      e.clicks += m.clicks || 0;
      e.impressions += m.impressions || 0;
    }

    // Vendas reais por ASIN no dia (SP-API → SalesDaily)
    const realSalesByAsin = new Map<string, { revenue: number; units: number }>();
    for (const s of salesDailyRaw) {
      if (!s.asin || s.date !== assessmentDate) continue;
      if (!realSalesByAsin.has(s.asin)) realSalesByAsin.set(s.asin, { revenue: 0, units: 0 });
      const e = realSalesByAsin.get(s.asin)!;
      e.revenue += s.ordered_product_sales || 0;
      e.units += s.units_ordered || 0;
    }

    // ── Processar cada produto com campanha ativa ─────────────────────────
    const assessments: any[] = [];
    const decisionSignals: any[] = [];
    const stats = {
      products_evaluated: 0,
      profitable: 0,
      low_profit: 0,
      break_even: 0,
      unprofitable: 0,
      no_sales_with_spend: 0,
      insufficient_data: 0,
      stock_blocked: 0,
      listing_blocked: 0,
      decisions_signals_generated: 0,
      assessments_saved: 0,
    };

    // ASINs que têm métricas no dia de aferição ou nos últimos 14 dias
    const asinsToAssess = new Set<string>();
    for (const [asin] of adsByAsin) asinsToAssess.add(asin);
    // Incluir todos os produtos com campanha
    for (const p of products) {
      if (p.asin && p.has_campaign) asinsToAssess.add(p.asin);
    }

    for (const asin of asinsToAssess) {
      stats.products_evaluated++;

      const product = products.find((p: any) => p.asin === asin) || null;
      const sku = product?.sku || '';
      const econ = econByAsin.get(asin) || econBySku.get(normSku(sku)) || null;

      const adsData = adsByAsin.get(asin) || { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 };
      const realData = realSalesByAsin.get(asin) || null;

      // Verificar se o dia tem dados válidos — se não tiver métricas no dia,
      // tentar usar os últimos dados disponíveis (não zerar)
      let data_status: string = 'complete';
      if (adsData.spend === 0 && adsData.impressions === 0) {
        // Checar se há dados recentes (últimos 3 dias)
        const recent = metrics14d.filter((m: any) => {
          const a = campaignAsinMap.get(m.campaign_id);
          return a === asin && m.date >= daysAgo(3);
        });
        if (recent.length === 0) {
          data_status = 'stale';
          // Manter os últimos dados — buscar do assessmentDate anterior
        } else {
          data_status = 'partial'; // produto ativo mas sem gasto no dia
        }
      }

      // Verificar se relatório falhou — preservar last_valid
      if (data_status === 'stale') {
        // Buscar último assessment válido e preservar
        const lastValid = await base44.asServiceRole.entities.DailyProductAdsAssessment.filter(
          { amazon_account_id: aid, asin, data_status: 'complete' },
          '-assessment_date', 1
        ).catch(() => []);
        if (lastValid[0]) {
          // Atualizar somente o data_status, não zerar métricas
          if (!dry_run) {
            await base44.asServiceRole.entities.DailyProductAdsAssessment.create({
              amazon_account_id: aid,
              assessment_date: assessmentDate,
              asin,
              sku,
              spend: lastValid[0].spend,
              ads_sales: lastValid[0].ads_sales,
              real_sales: lastValid[0].real_sales,
              orders_ads: lastValid[0].orders_ads,
              units_real: lastValid[0].units_real,
              impressions: lastValid[0].impressions,
              clicks: lastValid[0].clicks,
              ctr: lastValid[0].ctr,
              cpc: lastValid[0].cpc,
              cvr: lastValid[0].cvr,
              acos: lastValid[0].acos,
              acos_status: lastValid[0].acos_status,
              roas: lastValid[0].roas,
              tacos: lastValid[0].tacos,
              tacos_data_partial: true,
              profit_after_ads: lastValid[0].profit_after_ads,
              break_even_acos: lastValid[0].break_even_acos,
              target_acos: lastValid[0].target_acos,
              economic_status: lastValid[0].economic_status,
              data_status: 'stale',
              confidence: Math.max(0, (lastValid[0].confidence || 0.5) - 0.2),
              recommended_action: 'stale_data_sync_required',
              idempotency_key: `daily_assess|${aid}|${asin}|${assessmentDate}`,
              created_at: nowIso(),
              updated_at: nowIso(),
            }).catch(() => {});
          }
          continue;
        }
      }

      // Indicadores econômicos
      const has_economics = !!(econ && econ.unit_cost > 0);
      const product_cost = Number(econ?.unit_cost || 0);
      const amazon_fees = Number(econ?.amazon_fee_amount || 0);
      const estimated_taxes = Number(econ?.tax_per_unit || 0);
      const logistics_cost = Number(econ?.logistics_cost_per_unit || econ?.inbound_freight_per_unit || 0);
      const other_variable_costs = Number(econ?.other_variable_cost_per_unit || 0);
      const selling_price = Number(econ?.current_price || product?.price || 0);
      const contribution_margin = Number(econ?.contribution_margin_amount || 0);
      const break_even_acos = Number(econ?.break_even_acos || product?.break_even_acos_pct || 0);
      const target_acos = Number(econ?.target_acos || product?.break_even_acos_pct || accountTargetAcos);
      const safe_max_cpc = Number(econ?.safe_max_cpc || 0);
      const maximum_profitable_cpa = contribution_margin > 0 ? contribution_margin * 0.8 : 0;

      const spend = adsData.spend;
      const ads_sales = adsData.sales;
      const orders_ads = adsData.orders;
      const clicks = adsData.clicks;
      const impressions = adsData.impressions;
      const real_sales = realData?.revenue || 0;
      const units_real = realData?.units || 0;

      // ACoS: apenas quando há vendas
      const acos = ads_sales > 0 ? Math.round((spend / ads_sales) * 1000) / 10 : null;
      const roas = spend > 0 && ads_sales > 0 ? Math.round((ads_sales / spend) * 100) / 100 : 0;
      const ctr = impressions > 0 ? Math.round((clicks / impressions) * 10000) / 100 : 0;
      const cpc = clicks > 0 ? Math.round((spend / clicks) * 100) / 100 : 0;
      const cvr = clicks > 0 && orders_ads > 0 ? Math.round((orders_ads / clicks) * 10000) / 100 : 0;
      const average_order_value = orders_ads > 0 ? Math.round((ads_sales / orders_ads) * 100) / 100 : 0;
      const revenue_per_click = clicks > 0 ? Math.round((ads_sales / clicks) * 100) / 100 : 0;
      const cost_per_order = orders_ads > 0 ? Math.round((spend / orders_ads) * 100) / 100 : 0;
      const contribution_profit_before_ads = contribution_margin;

      // TACoS: somente quando há vendas reais da SP-API
      // Nunca substituir por zero quando real_sales ausente
      const tacos_data_partial = realData === null || real_sales === 0;
      const tacos = (!tacos_data_partial && real_sales > 0)
        ? Math.round((spend / real_sales) * 1000) / 10
        : null;

      // Lucro pós-Ads: formula completa
      // profit_after_ads = real_sales - (product_cost + amazon_fees + taxes + logistics + other) - spend
      // Usar vendas reais quando disponíveis, senão ads_sales como proxy conservador
      let profit_after_ads: number | null = null;
      if (has_economics) {
        const effective_sales = real_sales > 0 ? real_sales : (ads_sales > 0 ? ads_sales : 0);
        const orders_for_calc = orders_ads > 0 ? orders_ads : (real_sales > 0 && average_order_value > 0 ? Math.round(real_sales / average_order_value) : 0);
        if (orders_for_calc > 0 && effective_sales > 0) {
          const total_variable_cost = (product_cost + amazon_fees + estimated_taxes + logistics_cost + other_variable_costs) * orders_for_calc;
          profit_after_ads = Math.round((effective_sales - total_variable_cost - spend) * 100) / 100;
        } else if (spend > 0) {
          // Sem vendas: lucro = -spend (perdendo apenas o custo do anúncio)
          profit_after_ads = -spend;
        }
      }

      // Classificação
      const stock_qty = product?.fba_inventory || 0;
      const listing_buyable = product?.listing_buyable !== false;
      const { status: economic_status, acos_status, main_problem, confidence } = classifyEconomicStatus({
        spend, ads_sales,
        profit_after_ads,
        acos,
        target_acos,
        break_even_acos,
        stock_qty,
        listing_buyable,
        has_economics,
      });

      const recommended_action = recommendAction({
        status: economic_status,
        acos,
        acos_status,
        target_acos,
        break_even_acos,
        spend,
        clicks,
        orders: orders_ads,
        maximum_profitable_cpa,
        cost_per_order,
        profit_after_ads,
      });

      // Atualizar contadores
      const statKey = economic_status as keyof typeof stats;
      if (statKey in stats) (stats as any)[statKey]++;

      const iKey = `daily_assess|${aid}|${asin}|${assessmentDate}`;
      const record: any = {
        amazon_account_id: aid,
        assessment_date: assessmentDate,
        product_id: product?.id || '',
        asin,
        sku,
        spend: Math.round(spend * 100) / 100,
        ads_sales: Math.round(ads_sales * 100) / 100,
        real_sales: Math.round(real_sales * 100) / 100,
        orders_ads,
        units_real,
        impressions,
        clicks,
        ctr,
        cpc,
        cvr,
        acos,
        acos_status,
        roas,
        tacos,
        tacos_data_partial,
        average_order_value,
        revenue_per_click,
        cost_per_order,
        product_cost: Math.round(product_cost * 100) / 100,
        amazon_fees: Math.round(amazon_fees * 100) / 100,
        estimated_taxes: Math.round(estimated_taxes * 100) / 100,
        logistics_cost: Math.round(logistics_cost * 100) / 100,
        other_variable_costs: Math.round(other_variable_costs * 100) / 100,
        contribution_profit_before_ads: Math.round(contribution_profit_before_ads * 100) / 100,
        profit_after_ads: profit_after_ads !== null ? Math.round(profit_after_ads * 100) / 100 : null,
        break_even_acos: Math.round(break_even_acos * 10) / 10,
        target_acos: Math.round(target_acos * 10) / 10,
        maximum_profitable_cpa: Math.round(maximum_profitable_cpa * 100) / 100,
        safe_max_cpc: Math.round(safe_max_cpc * 100) / 100,
        economic_status,
        performance_status: main_problem,
        data_status: real_sales === 0 && ads_sales === 0 ? 'partial' : data_status,
        confidence: Math.round(confidence * 100) / 100,
        recommended_action,
        idempotency_key: iKey,
        created_at: nowIso(),
        updated_at: nowIso(),
      };

      assessments.push(record);

      // ── Gerar sinais de decisão para o motor ──────────────────────────────
      // Apenas sinalizar — o motor determinístico decide se e como agir
      const shouldSignal = (
        economic_status === 'unprofitable' ||
        economic_status === 'no_sales_with_spend' ||
        economic_status === 'stock_blocked'
      ) && spend > 0 && confidence >= 0.7;

      if (shouldSignal) {
        decisionSignals.push({
          asin,
          sku,
          economic_status,
          acos,
          target_acos,
          break_even_acos,
          profit_after_ads,
          spend,
          clicks,
          orders: orders_ads,
          recommended_action,
          confidence,
        });
        stats.decisions_signals_generated++;
      }
    }

    // ── Persistir assessments em lotes ────────────────────────────────────
    if (!dry_run && assessments.length > 0) {
      // Deletar assessments do dia (se force=true) e reinserir
      if (body.force) {
        const existing = await base44.asServiceRole.entities.DailyProductAdsAssessment.filter(
          { amazon_account_id: aid, assessment_date: assessmentDate }, null, 500
        ).catch(() => []);
        for (const ex of existing) {
          await base44.asServiceRole.entities.DailyProductAdsAssessment.delete(ex.id).catch(() => {});
        }
      }

      for (let i = 0; i < assessments.length; i += 50) {
        await base44.asServiceRole.entities.DailyProductAdsAssessment.bulkCreate(
          assessments.slice(i, i + 50)
        ).catch(() => []);
        stats.assessments_saved += Math.min(50, assessments.length - i);
      }
    }

    // ── Registrar log de execução ─────────────────────────────────────────
    if (!dry_run) {
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: aid,
        operation: 'daily_economic_assessment',
        trigger_type: 'automatic',
        status: 'success',
        execution_date: assessmentDate,
        started_at: startedAt,
        completed_at: nowIso(),
        duration_ms: Date.now() - t0,
        records_processed: assessments.length,
        result_summary: JSON.stringify({
          assessment_date: assessmentDate,
          products_evaluated: stats.products_evaluated,
          profitable: stats.profitable,
          unprofitable: stats.unprofitable,
          no_sales_with_spend: stats.no_sales_with_spend,
          decisions_signals: stats.decisions_signals_generated,
        }),
      }).catch(() => {});
    }

    return Response.json({
      ok: true,
      dry_run,
      assessment_date: assessmentDate,
      account_id: aid,
      stats,
      assessments_saved: stats.assessments_saved,
      decisions_signals: decisionSignals.length,
      decision_signals_summary: decisionSignals.slice(0, 10).map(s => ({
        asin: s.asin,
        status: s.economic_status,
        acos: s.acos,
        spend: s.spend,
        recommended_action: s.recommended_action,
      })),
      duration_ms: Date.now() - t0,
      note: 'Aferição diária concluída. Sinais gerados para o runUnifiedDecisionEngine. Nenhuma ação direta executada aqui.',
    });

  } catch (error: any) {
    console.error('[runDailyEconomicAssessment]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});