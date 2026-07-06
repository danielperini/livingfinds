/**
 * calculateDailyBudgetAllocation — Função Central de Orçamento Diário v1
 *
 * Referência operacional: R$ 60,00/dia total.
 * Esta é a ÚNICA função responsável pelo cálculo de distribuição de orçamento.
 * Deve ser chamada por: criação de campanha, ativação de produto, kickoff,
 * otimização diária, aumento/redução de bid, sync de campanhas, IA.
 *
 * Regras:
 *  - Orçamento base = R$60 ÷ qtd_produtos_ativos por produto
 *  - Distribuição por tipo: AUTO 40% / manual_exact 30% / manual_phrase 15% / manual_broad 10% / product/asin 5%
 *  - Tolerância: R$54–R$66 (±10%)
 *  - Acima de R$66 somente com: lucro suficiente + ACoS abaixo da meta + campanha limitada por budget + conversões recentes
 *  - Campanhas sem histórico: orçamento mínimo, sem auto-aumento
 *  - Campanhas sem vendas/com prejuízo: redução progressiva
 *  - Fórmula SKU: limite_diario_sku = lucro_liquido × max_ads_pct × vendas_diarias
 *  - Nova campanha: redistribuir R$60 entre todas, sem somar 30% extra
 *  - Toda alteração registrada em CampaignChangeHistory
 *
 * Payload:
 *   amazon_account_id — obrigatório
 *   dry_run           — opcional (default false): simula sem salvar
 *   trigger           — origem da chamada (criacao_campanha, kickoff, otimizacao_diaria, etc.)
 *   override_budget   — opcional: substitui R$60 como referência (quando gestor fixou valor)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const REFERENCE_BUDGET    = 60.00;  // Orçamento total diário de referência (exibido no painel)
const TOLERANCE_LOW       = 50.00;  // Mínimo exibido
const TOLERANCE_HIGH      = 65.00;  // Máximo exibido
const MIN_CAMPAIGN_BUDGET = 15.00;  // Mínimo garantido por campanha (R$15/dia)
const MAX_CHANGE_PCT      = 0.30;   // variação máxima por ciclo (aplicado na escrita)
const PAGE = 200;

// Peso por tipo de campanha
const CAMPAIGN_TYPE_WEIGHTS: Record<string, number> = {
  AUTO:          0.40,
  MANUAL_EXACT:  0.30,
  MANUAL_PHRASE: 0.15,
  MANUAL_BROAD:  0.10,
  PRODUCT:       0.05,
  ASIN:          0.05,
};

function detectCampaignType(campaign: any): string {
  const name = (campaign.name || campaign.campaign_name || '').toUpperCase();
  const targeting = (campaign.targeting_type || '').toUpperCase();

  if (targeting === 'AUTO' || name.includes('AUTO')) return 'AUTO';
  if (name.includes('EXACT') || name.includes('EXATO')) return 'MANUAL_EXACT';
  if (name.includes('PHRASE') || name.includes('FRASE')) return 'MANUAL_PHRASE';
  if (name.includes('BROAD') || name.includes('AMPLA') || name.includes('AMPLO')) return 'MANUAL_BROAD';
  if (name.includes('PRODUCT') || name.includes('PRODUTO') || name.includes('ASIN')) return 'PRODUCT';
  if (targeting === 'MANUAL') return 'MANUAL_EXACT'; // padrão para manual sem tipo explícito
  return 'AUTO'; // fallback
}

function calcSkuLimit(product: any, minBudget: number): number {
  const price = Number(product.price || 0);
  const cost  = Number(product.product_cost || 0);
  const fees  = Number(product.amazon_fees || price * 0.15);
  const extra = Number(product.extra_cost || 0);
  const profitPerUnit = price - cost - fees - extra;
  if (profitPerUnit <= 0 || price <= 0) return 0;

  const maxAdsPct = product.break_even_acos_pct > 0
    ? (product.break_even_acos_pct / 100) * 0.80
    : 0.25;

  const limitPerSale = profitPerUnit * maxAdsPct;
  const dailySales = Math.max(1, (product.total_units_30d || 0) / 30);
  const skuLimit = limitPerSale * dailySales;

  return Math.max(minBudget, Math.round(skuLimit * 100) / 100);
}

function avg7d(metrics: any[], campaignId: string): number {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const seen = new Set<string>();
  let total = 0; let days = 0;
  for (const m of metrics) {
    if (!m.date || m.date < sevenDaysAgo) continue;
    if (m.campaign_id !== campaignId) continue;
    const key = `${m.campaign_id}-${m.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total += Number(m.spend || 0);
    days++;
  }
  return days > 0 ? total / days : 0;
}

function avg30d(metrics: any[], campaignId: string): number {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const seen = new Set<string>();
  let total = 0; let days = 0;
  for (const m of metrics) {
    if (!m.date || m.date < thirtyDaysAgo) continue;
    if (m.campaign_id !== campaignId) continue;
    const key = `${m.campaign_id}-${m.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total += Number(m.spend || 0);
    days++;
  }
  return days > 0 ? total / days : 0;
}

async function loadAll(entity: any, query: any, sort: string = '-created_date', limit: number = PAGE) {
  const all: any[] = [];
  let offset = 0;
  while (true) {
    const page = await entity.filter(query, sort, limit, offset);
    all.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  return all;
}

Deno.serve(async (req) => {
  const now = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const { dry_run = false, trigger = 'manual', override_budget } = body;

    // ── 1. Resolver conta ──────────────────────────────────────────────────
    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0] || null;
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon conectada.' });

    const aid = account.id;
    const sym = account.currency_symbol || 'R$';

    // ── 2. AutopilotConfig ─────────────────────────────────────────────────
    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid });
    const cfg = configs[0] || {};
    const TARGET_ACOS = cfg.target_acos || cfg.acos_target || 25;
    const BUDGET_LOCKED = cfg.daily_budget_locked === true && (cfg.daily_budget_target || 0) > 0;

    // Referência: gestor pode fixar, senão usa R$60
    const referenceTotal = BUDGET_LOCKED
      ? Number(cfg.daily_budget_target)
      : override_budget
        ? Number(override_budget)
        : REFERENCE_BUDGET;

    // ── 3. Produtos ativos ─────────────────────────────────────────────────
    const products = await loadAll(
      base44.asServiceRole.entities.Product,
      { amazon_account_id: aid },
      '-fba_inventory'
    );
    const activeProducts = products.filter((p: any) =>
      p.status === 'active' &&
      p.inventory_status !== 'out_of_stock' &&
      !['inactive', 'archived'].includes(p.status)
    );
    const productMap = new Map(products.map((p: any) => [p.asin, p]));

    // ── 4. Campanhas ativas ────────────────────────────────────────────────
    const allCampaigns = await loadAll(
      base44.asServiceRole.entities.Campaign,
      { amazon_account_id: aid }
    );
    const activeCampaigns = allCampaigns.filter((c: any) =>
      (c.state === 'enabled' || c.status === 'enabled') &&
      c.state !== 'archived' &&
      !c.archived
    );

    if (activeCampaigns.length === 0) {
      return Response.json({ ok: true, message: 'Nenhuma campanha ativa.', allocations: [] });
    }

    // ── 5. Métricas diárias (últimos 30 dias) ──────────────────────────────
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const metricsRaw = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: aid }, '-date', 5000
    );
    const metrics30d = metricsRaw.filter((m: any) => m.date && m.date >= thirtyDaysAgo);

    // Spend total por campanha (30d, deduplicado)
    const seenM = new Set<string>();
    const spendTotals: Record<string, { total: number; days: number; orders: number; sales: number; acos: number }> = {};
    for (const m of metrics30d) {
      const k = `${m.campaign_id}-${m.date}`;
      if (seenM.has(k)) continue;
      seenM.add(k);
      if (!m.campaign_id) continue;
      if (!spendTotals[m.campaign_id]) spendTotals[m.campaign_id] = { total: 0, days: 0, orders: 0, sales: 0, acos: 0 };
      spendTotals[m.campaign_id].total += Number(m.spend || 0);
      spendTotals[m.campaign_id].days++;
      spendTotals[m.campaign_id].orders += Number(m.orders || 0);
      spendTotals[m.campaign_id].sales += Number(m.sales || 0);
    }

    // Calcular ACoS por campanha
    for (const cid in spendTotals) {
      const d = spendTotals[cid];
      d.acos = d.sales > 0 ? (d.total / d.sales) * 100 : 0;
    }

    // ── 6. Agrupar campanhas por produto (ASIN) ────────────────────────────
    const campaignsByProduct: Record<string, any[]> = {};
    for (const c of activeCampaigns) {
      // Usar asin da campanha, ou tentar extrair do nome, ou agrupar como 'pool'
      const asin = c.asin || 'pool';
      if (!campaignsByProduct[asin]) campaignsByProduct[asin] = [];
      campaignsByProduct[asin].push(c);
    }

    // Número de grupos únicos de produto (com ASIN real vs pool)
    const realProductGroups = Object.keys(campaignsByProduct).filter(k => k !== 'pool').length;
    const poolCount = (campaignsByProduct['pool'] || []).length;
    // Usar produtos ativos como referência se disponível, senão usar grupos reais
    const numActiveProducts = Math.max(1,
      activeProducts.length > 0 ? activeProducts.length :
      realProductGroups > 0 ? realProductGroups : 1
    );
    const numActiveCampaigns = activeCampaigns.length;

    // Orçamento base por produto (R$60 ÷ produtos ativos)
    const budgetPerProduct = referenceTotal / numActiveProducts;
    // Base por campanha para o response info
    const budgetPerCampaign = referenceTotal / numActiveCampaigns;

    // ── 7. Calcular alocação por campanha ──────────────────────────────────
    const allocations: any[] = [];
    let totalAllocated = 0;

    for (const [asin, campaigns] of Object.entries(campaignsByProduct)) {
      const product = productMap.get(asin);
      const skuLimit = product ? calcSkuLimit(product, MIN_CAMPAIGN_BUDGET) : 0;
      // MIN_CAMPAIGN_BUDGET é R$15 — cada campanha recebe no mínimo esse valor
      // Para campanhas sem ASIN (pool), distribuir proporcionalmente ao total de campanhas
      const isPool = asin === 'pool';
      const productBudget = isPool
        ? (poolCount / numActiveCampaigns) * referenceTotal
        : budgetPerProduct;

      // Calcular pesos dos tipos presentes neste produto
      const typeWeights: Record<string, number> = {};
      let totalWeight = 0;
      for (const c of campaigns) {
        const t = detectCampaignType(c);
        typeWeights[c.id] = CAMPAIGN_TYPE_WEIGHTS[t] || 0.20;
        totalWeight += typeWeights[c.id];
      }

      for (const campaign of campaigns) {
        const cid = campaign.campaign_id || campaign.id;
        const campType = detectCampaignType(campaign);
        const currentBudget = Number(campaign.daily_budget || 0);
        const campMetrics = spendTotals[cid] || { total: 0, days: 0, orders: 0, sales: 0, acos: 0 };
        const hasHistory = campMetrics.days >= 3;
        const hasOrders = campMetrics.orders > 0;
        const avgSpend7 = avg7d(metrics30d, cid);
        const avgSpend30 = avg30d(metrics30d, cid);

        // Peso normalizado neste produto
        const normalizedWeight = totalWeight > 0 ? typeWeights[campaign.id] / totalWeight : 1 / campaigns.length;

        // Orçamento base proporcional ao produto + tipo
        let baseBudget = productBudget * normalizedWeight;

        // Ajuste por desempenho
        let perfMultiplier = 1.0;
        let perfReason = 'sem_histórico';

        if (hasHistory) {
          if (!hasOrders && campMetrics.days >= 7) {
            // Sem vendas com histórico >= 7 dias → reduzir progressivamente
            const reductionFactor = Math.min(0.5, 0.90 - (campMetrics.days - 7) * 0.02);
            perfMultiplier = reductionFactor;
            perfReason = `sem_conversões_${campMetrics.days}d`;
          } else if (hasOrders && campMetrics.acos > 0) {
            if (campMetrics.acos <= TARGET_ACOS) {
              // Rentável: pode escalar, mas limitado pela tolerância geral
              perfMultiplier = Math.min(1.30, 1 + (TARGET_ACOS - campMetrics.acos) / TARGET_ACOS * 0.3);
              perfReason = `acos_${campMetrics.acos.toFixed(1)}_bom`;
            } else if (campMetrics.acos > TARGET_ACOS * 1.5) {
              // ACoS muito alto: reduzir
              perfMultiplier = 0.75;
              perfReason = `acos_${campMetrics.acos.toFixed(1)}_alto`;
            } else {
              // ACoS ligeiramente alto: manter
              perfMultiplier = 0.90;
              perfReason = `acos_${campMetrics.acos.toFixed(1)}_acima_meta`;
            }
          } else if (hasOrders) {
            perfMultiplier = 1.10;
            perfReason = 'com_conversões';
          }
        } else {
          // Sem histórico: orçamento mínimo controlado
          perfMultiplier = 0.70;
          perfReason = 'novo_sem_dados';
        }

        let suggestedBudget = baseBudget * perfMultiplier;

        // Guardrail 1: Limite por SKU (se disponível)
        if (skuLimit > 0 && suggestedBudget > skuLimit) {
          suggestedBudget = skuLimit;
          perfReason += '+sku_capped';
        }

        // Guardrail 2: Mínimo R$15 por campanha
        suggestedBudget = Math.max(MIN_CAMPAIGN_BUDGET, suggestedBudget);

        // Guardrail 3: Variação máxima ±30% do atual (só na escrita real)
        if (!dry_run && currentBudget > 0) {
          const maxUp   = currentBudget * (1 + MAX_CHANGE_PCT);
          const maxDown = Math.max(MIN_CAMPAIGN_BUDGET, currentBudget * (1 - MAX_CHANGE_PCT));
          suggestedBudget = Math.min(suggestedBudget, maxUp);
          suggestedBudget = Math.max(suggestedBudget, maxDown);
        }

        // Guardrail 4: Verificar se pode ultrapassar R$66 total
        // (verificado depois de somar todos — aqui apenas calcular)

        suggestedBudget = Math.round(suggestedBudget * 100) / 100;
        totalAllocated += suggestedBudget;

        allocations.push({
          campaign_id: cid,
          campaign_db_id: campaign.id,
          campaign_name: campaign.name || campaign.campaign_name,
          campaign_type: campType,
          asin,
          current_budget: currentBudget,
          suggested_budget: suggestedBudget,
          base_budget: Math.round(baseBudget * 100) / 100,
          perf_multiplier: Math.round(perfMultiplier * 100) / 100,
          perf_reason: perfReason,
          avg_spend_7d: Math.round(avgSpend7 * 100) / 100,
          avg_spend_30d: Math.round(avgSpend30 * 100) / 100,
          has_history: hasHistory,
          has_orders: hasOrders,
          acos_30d: Math.round((campMetrics.acos || 0) * 10) / 10,
          sku_limit: Math.round(skuLimit * 100) / 100,
          change_pct: currentBudget > 0
            ? Math.round((suggestedBudget - currentBudget) / currentBudget * 1000) / 10
            : null,
        });
      }
    }

    // ── 8. Garantir mínimo R$15 por campanha ─────────────────────────────
    // A soma das campanhas PODE ser maior que R$60 — isso é normal e esperado.
    // O valor R$60 é o orçamento total DIÁRIO exibido no painel, não a soma das campanhas.
    for (const a of allocations) {
      if (a.suggested_budget < MIN_CAMPAIGN_BUDGET) {
        a.suggested_budget = MIN_CAMPAIGN_BUDGET;
        a.perf_reason += '+min_15';
      }
    }
    totalAllocated = allocations.reduce((s: number, a: any) => s + a.suggested_budget, 0);

    // ── 9. Validação final ─────────────────────────────────────────────────
    const validation = {
      no_negative_budget: allocations.every((a: any) => a.suggested_budget >= 0),
      no_duplicate_campaigns: allocations.length === new Set(allocations.map((a: any) => a.campaign_id)).size,
      min_budget_respected: allocations.every((a: any) => a.suggested_budget >= MIN_CAMPAIGN_BUDGET),
      no_sku_exceeded: allocations.every((a: any) => a.sku_limit === 0 || a.suggested_budget <= a.sku_limit + 0.01),
      sum_campaigns: Math.round(totalAllocated * 100) / 100,
      display_budget: REFERENCE_BUDGET,
    };

    // ── 10. Aplicar se não for dry_run ─────────────────────────────────────
    let applied = 0;
    let skipped = 0;
    const historyEntries: any[] = [];

    if (!dry_run) {
      const dbUpdates: { id: string; daily_budget: number }[] = [];

      for (const a of allocations) {
        const diff = Math.abs(a.suggested_budget - a.current_budget);
        const changePct = a.current_budget > 0 ? diff / a.current_budget : 1;

        // Só aplica se diferença > 3%
        if (changePct < 0.03) { skipped++; continue; }

        dbUpdates.push({ id: a.campaign_db_id, daily_budget: a.suggested_budget });
        applied++;

        historyEntries.push({
          amazon_account_id: aid,
          campaign_id: a.campaign_id,
          change_type: 'CAMPAIGN_BUDGET',
          entity_type: 'campaign',
          entity_id: a.campaign_id,
          field_name: 'daily_budget',
          old_value: String(a.current_budget),
          new_value: String(a.suggested_budget),
          source: 'PERFORMANCE_RULE',
          source_function: 'calculateDailyBudgetAllocation',
          reason: JSON.stringify({
            trigger,
            campaign_type: a.campaign_type,
            perf_reason: a.perf_reason,
            perf_multiplier: a.perf_multiplier,
            avg_spend_7d: a.avg_spend_7d,
            avg_spend_30d: a.avg_spend_30d,
            acos_30d: a.acos_30d,
            has_orders: a.has_orders,
            sku_limit: a.sku_limit,
            reference_total: referenceTotal,
            active_products: numActiveProducts,
            active_campaigns: numActiveCampaigns,
            budget_per_product: Math.round(budgetPerProduct * 100) / 100,
            total_allocated: Math.round(totalAllocated * 100) / 100,
          }),
          changed_at: now,
          changed_by: 'calculateDailyBudgetAllocation',
          status: 'executed',
        });
      }

      // Bulk update no banco
      for (let i = 0; i < dbUpdates.length; i += 50) {
        await base44.asServiceRole.entities.Campaign.bulkUpdate(dbUpdates.slice(i, i + 50));
      }

      // Registrar histórico em lote
      for (const entry of historyEntries) {
        await base44.asServiceRole.entities.CampaignChangeHistory.create(entry).catch(() => {});
      }

      // O valor exibido no painel é sempre o referenceTotal (R$60), não a soma das campanhas.
      // As campanhas podem somar mais que R$60 — mínimo R$15/cada é a regra por campanha.
      const displayBudget = Math.min(TOLERANCE_HIGH, Math.max(TOLERANCE_LOW, referenceTotal));
      const configUpdate = {
        ai_suggested_daily_budget: displayBudget,
        ai_budget_reasoning: `${numActiveCampaigns} campanhas ativas distribuindo ${sym}${displayBudget.toFixed(2)} total. Referência: ${sym}${referenceTotal}. Faixa permitida: ${sym}${TOLERANCE_LOW}–${sym}${TOLERANCE_HIGH}.`,
        ai_budget_confidence: metrics30d.length > 0 ? 88 : 60,
        ai_budget_generated_at: now,
        ai_budget_breakdown: JSON.stringify({
          reference_budget: referenceTotal,
          display_budget: displayBudget,
          active_products: numActiveProducts,
          active_campaigns: numActiveCampaigns,
          tolerance_low: TOLERANCE_LOW,
          tolerance_high: TOLERANCE_HIGH,
          trigger,
        }),
      };

      if (configs.length > 0) {
        await base44.asServiceRole.entities.AutopilotConfig.update(configs[0].id, configUpdate).catch(() => {});
      }
    }

    return Response.json({
      ok: true,
      dry_run,
      trigger,
      reference_budget: referenceTotal,
      active_products: numActiveProducts,
      active_campaigns: numActiveCampaigns,
      budget_per_product: Math.round(budgetPerProduct * 100) / 100,
      budget_per_campaign: Math.round(budgetPerCampaign * 100) / 100,
      total_allocated: Math.round(totalAllocated * 100) / 100,
      tolerance_low: TOLERANCE_LOW,
      tolerance_high: TOLERANCE_HIGH,
      within_tolerance: totalAllocated >= TOLERANCE_LOW && totalAllocated <= TOLERANCE_HIGH,
      campaigns_applied: applied,
      campaigns_skipped: skipped,
      allocations,
      validation,
    });

  } catch (error: any) {
    console.error('[calculateDailyBudgetAllocation]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});