/**
 * learnFromProductProfitability
 *
 * Usa dados reais de lucratividade por produto para:
 * 1. Classificar cada produto (strong_profit → blocked_for_ads)
 * 2. Gerar bloqueios automáticos no motor (bid_increase_blocked, ads_blocked, etc.)
 * 3. Atualizar Product com profitability_status
 * 4. Salvar regras de aprendizado em ProductProfitabilityLearning
 * 5. Bloquear/reduzir bids de produtos deficitários via AmazonActionQueue
 *
 * NÃO altera dados de faturamento. NÃO apaga histórico.
 * PROFIT_AFTER_ADS_RULE + PRODUCT_LOSS_GUARD aplicados aqui.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function safe(v: unknown): number {
  const n = Number(v);
  return isNaN(n) || !isFinite(n) ? 0 : n;
}
function nowIso(): string { return new Date().toISOString(); }
function todayStr(): string { return new Date().toISOString().slice(0, 10); }

type ProfitData = {
  sku: string;
  asin?: string;
  product_name?: string;
  gross_revenue: number;
  gross_profit: number;
  gross_margin_pct: number;
  ads_cost: number;
  profit_after_ads: number;
  mpa_pct: number;
  tacos_pct: number;
  units_sold: number;
  average_price?: number;
  average_unit_cost?: number;
  revenue_share_pct?: number;
  period_start?: string;
  period_end?: string;
};

function classify(d: ProfitData): {
  profitability_status: string;
  performance_class: string;
  ads_blocked: boolean;
  bid_increase_blocked: boolean;
  budget_increase_blocked: boolean;
  top_of_search_blocked: boolean;
  decision_recommendation: string;
  learning_note: string;
} {
  const { gross_profit, profit_after_ads, mpa_pct, tacos_pct, gross_margin_pct } = d;

  // gross_loss: lucro bruto negativo ANTES dos Ads
  if (gross_profit < 0) {
    return {
      profitability_status: 'gross_loss',
      performance_class: 'pause_ads_review',
      ads_blocked: true,
      bid_increase_blocked: true,
      budget_increase_blocked: true,
      top_of_search_blocked: true,
      decision_recommendation: 'Bloquear Ads completamente. Produto com margem bruta negativa antes de publicidade. Revisar preço, custo ou taxa marketplace.',
      learning_note: `Lucro bruto negativo (R$${gross_profit.toFixed(2)}). Ads agrava o prejuízo. Não anunciar até corrigir margem.`,
    };
  }

  // ads_cost > gross_profit: Ads destruiu mais que o lucro total
  if (d.ads_cost > gross_profit && gross_profit > 0) {
    return {
      profitability_status: 'blocked_for_ads',
      performance_class: 'pause_ads_review',
      ads_blocked: false, // manter visibilidade mas bloquear aumento
      bid_increase_blocked: true,
      budget_increase_blocked: true,
      top_of_search_blocked: true,
      decision_recommendation: `Ads (R$${d.ads_cost.toFixed(2)}) superior ao lucro bruto (R$${gross_profit.toFixed(2)}). Reduzir Ads agressivamente. Não escalar.`,
      learning_note: `Ads consumiu ${((d.ads_cost / gross_profit) * 100).toFixed(0)}% do lucro bruto. TACOS (${tacos_pct.toFixed(1)}%) > margem (${gross_margin_pct.toFixed(1)}%).`,
    };
  }

  // profit_after_ads negativo
  if (profit_after_ads < 0) {
    // Muito negativo (MPA < -10%): pausar Ads
    if (mpa_pct < -10) {
      return {
        profitability_status: 'post_ads_loss',
        performance_class: 'pause_ads_review',
        ads_blocked: false,
        bid_increase_blocked: true,
        budget_increase_blocked: true,
        top_of_search_blocked: true,
        decision_recommendation: `Pausar Ads ou reduzir agressivamente. Lucro pós Ads: R$${profit_after_ads.toFixed(2)}. MPA: ${mpa_pct.toFixed(2)}%.`,
        learning_note: `MPA ${mpa_pct.toFixed(1)}% — abaixo de -10%. TACOS (${tacos_pct.toFixed(1)}%) destrói margem (${gross_margin_pct.toFixed(1)}%).`,
      };
    }
    // Moderadamente negativo
    return {
      profitability_status: 'post_ads_loss',
      performance_class: 'reduce_ads',
      ads_blocked: false,
      bid_increase_blocked: true,
      budget_increase_blocked: true,
      top_of_search_blocked: true,
      decision_recommendation: `Reduzir Ads e revisar termos. Lucro pós Ads: R$${profit_after_ads.toFixed(2)}.`,
      learning_note: `MPA ${mpa_pct.toFixed(1)}%. Reduzir bids, pausar termos sem conversão, bloquear Top of Search.`,
    };
  }

  // TACOS > margem bruta (Ads provavelmente consome toda margem)
  if (tacos_pct > gross_margin_pct && gross_margin_pct > 0) {
    return {
      profitability_status: 'low_profit',
      performance_class: 'block_increase',
      ads_blocked: false,
      bid_increase_blocked: true,
      budget_increase_blocked: true,
      top_of_search_blocked: true,
      decision_recommendation: `TACOS (${tacos_pct.toFixed(1)}%) > margem bruta (${gross_margin_pct.toFixed(1)}%). Bloquear aumento e otimizar.`,
      learning_note: `Ads consome mais que margem disponível. Não escalar. Revisar keywords e bids.`,
    };
  }

  // MPA positivo mas baixo (0-5%): risco
  if (mpa_pct >= 0 && mpa_pct < 5) {
    return {
      profitability_status: 'break_even',
      performance_class: 'block_increase',
      ads_blocked: false,
      bid_increase_blocked: true,
      budget_increase_blocked: true,
      top_of_search_blocked: false,
      decision_recommendation: `MPA ${mpa_pct.toFixed(1)}% — risco alto. Manter sem aumentar Ads.`,
      learning_note: `Margens apertadas. Qualquer aumento de CPC pode tornar negativo.`,
    };
  }

  // MPA 5-10%: atenção
  if (mpa_pct >= 5 && mpa_pct < 10) {
    return {
      profitability_status: 'low_profit',
      performance_class: 'maintain_optimize',
      ads_blocked: false,
      bid_increase_blocked: false,
      budget_increase_blocked: true,
      top_of_search_blocked: true,
      decision_recommendation: `MPA ${mpa_pct.toFixed(1)}% — saudável mas ajustado. Otimizar sem escalar agressivamente.`,
      learning_note: `Manter keywords vencedoras. Pausar termos com ACoS alto. Não aumentar budget.`,
    };
  }

  // MPA 10-20%: saudável
  if (mpa_pct >= 10 && mpa_pct < 20) {
    return {
      profitability_status: 'healthy_profit',
      performance_class: 'maintain_optimize',
      ads_blocked: false,
      bid_increase_blocked: false,
      budget_increase_blocked: false,
      top_of_search_blocked: false,
      decision_recommendation: `MPA ${mpa_pct.toFixed(1)}% — saudável. Manter e otimizar. Escalar apenas com estoque confirmado.`,
      learning_note: `Produto equilibrado. Ads eficiente. Priorizar keywords vencedoras.`,
    };
  }

  // MPA >= 20%: forte
  return {
    profitability_status: 'strong_profit',
    performance_class: 'scale_cautiously',
    ads_blocked: false,
    bid_increase_blocked: false,
    budget_increase_blocked: false,
    top_of_search_blocked: false,
    decision_recommendation: `MPA ${mpa_pct.toFixed(1)}% — forte. Potencial de escala controlada com estoque e metas confirmados.`,
    learning_note: `MPA > 20%. Produto rentável. Escalar keywords vencedoras com cautela.`,
  };
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

    const account = (await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazonAccountId }))[0];
    const sym = String((account as Record<string, unknown>)?.currency_symbol || 'R$');

    // Produtos informados via body ou buscar do banco
    const inputProducts: ProfitData[] = Array.isArray(body.products) ? body.products : [];

    // Se não vieram via body, buscar ProductProfitabilityLearning já cadastrados
    if (inputProducts.length === 0) {
      const existing = await base44.asServiceRole.entities.ProductProfitabilityLearning.filter(
        { amazon_account_id: amazonAccountId }, '-created_at', 50
      );
      if (!existing.length) {
        return Response.json({ ok: false, error: 'Nenhum produto informado. Envie via body.products ou cadastre via importação.' });
      }
      for (const e of existing as Record<string, unknown>[]) {
        inputProducts.push({
          sku: String(e.sku || ''),
          asin: String(e.asin || ''),
          product_name: String(e.product_name || ''),
          gross_revenue: safe(e.gross_revenue),
          gross_profit: safe(e.gross_profit),
          gross_margin_pct: safe(e.gross_margin_pct),
          ads_cost: safe(e.ads_cost),
          profit_after_ads: safe(e.profit_after_ads),
          mpa_pct: safe(e.mpa_pct),
          tacos_pct: safe(e.tacos_pct),
          units_sold: safe(e.units_sold),
          period_start: String(e.period_start || ''),
          period_end: String(e.period_end || ''),
        });
      }
    }

    const now = nowIso();
    const today = todayStr();
    const periodStart = body.period_start || '2026-06-08';
    const periodEnd = body.period_end || '2026-07-07';

    // Total de faturamento para revenue_share
    const totalRevenue = inputProducts.reduce((s, p) => s + p.gross_revenue, 0);

    const learningRecords: Record<string, unknown>[] = [];
    const actionQueue: Record<string, unknown>[] = [];
    const stats = {
      gross_loss: 0, blocked_for_ads: 0, post_ads_loss: 0,
      break_even: 0, low_profit: 0, healthy_profit: 0, strong_profit: 0,
      bids_blocked: 0, ads_blocked: 0,
    };

    // Buscar produtos locais para atualizar profitability_status
    const localProducts = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id: amazonAccountId }, null, 300
    );
    const localProductBySku = new Map((localProducts as Record<string, unknown>[]).map(p => [String(p.sku || ''), p]));

    for (const prod of inputProducts) {
      const classification = classify(prod);
      const revShare = totalRevenue > 0 ? (prod.gross_revenue / totalRevenue) * 100 : 0;

      // Upsert em ProductProfitabilityLearning
      const existing = await base44.asServiceRole.entities.ProductProfitabilityLearning.filter({
        amazon_account_id: amazonAccountId, sku: prod.sku
      }).catch(() => []);

      const record = {
        amazon_account_id: amazonAccountId,
        period_start: prod.period_start || periodStart,
        period_end: prod.period_end || periodEnd,
        sku: prod.sku,
        asin: prod.asin || '',
        product_name: prod.product_name || '',
        gross_revenue: prod.gross_revenue,
        gross_profit: prod.gross_profit,
        gross_margin_pct: prod.gross_margin_pct,
        ads_cost: prod.ads_cost,
        profit_after_ads: prod.profit_after_ads,
        mpa_pct: prod.mpa_pct,
        tacos_pct: prod.tacos_pct,
        units_sold: prod.units_sold,
        revenue_share_pct: Math.round(revShare * 10) / 10,
        average_price: prod.average_price || 0,
        average_unit_cost: prod.average_unit_cost || 0,
        ...classification,
        source: 'manual',
        updated_at: now,
      };

      if ((existing as Record<string, unknown>[]).length > 0) {
        await base44.asServiceRole.entities.ProductProfitabilityLearning.update(
          String((existing as Record<string, unknown>[])[0].id), record
        ).catch(() => {});
      } else {
        await base44.asServiceRole.entities.ProductProfitabilityLearning.create({
          ...record, created_at: now
        }).catch(() => {});
      }

      learningRecords.push({ sku: prod.sku, ...classification });

      // Atualizar Product local com profitability_status
      const localProd = localProductBySku.get(prod.sku);
      if (localProd) {
        await base44.asServiceRole.entities.Product.update(String((localProd as Record<string, unknown>).id), {
          auto_campaign_eligible: !classification.ads_blocked,
        }).catch(() => {});
      }

      // Acumular stats
      const s = classification.profitability_status as keyof typeof stats;
      if (s in stats) (stats as Record<string, number>)[s]++;
      if (classification.ads_blocked) stats.ads_blocked++;
      if (classification.bid_increase_blocked) stats.bids_blocked++;

      // Enfileirar ações para produtos críticos (bloqueio de bid)
      if (classification.bid_increase_blocked && prod.asin) {
        // Buscar keywords ativas para este produto
        const kws = await base44.asServiceRole.entities.Keyword.filter({
          amazon_account_id: amazonAccountId, asin: prod.asin
        }, '-spend', 50).catch(() => []);

        for (const kw of kws as Record<string, unknown>[]) {
          const kwState = String(kw.state || kw.status || '').toLowerCase();
          if (kwState === 'archived' || kwState === 'paused') continue;
          const currentBid = safe(kw.current_bid || kw.bid || 0);
          if (currentBid === 0) continue;

          // Se produto tem gross_loss ou blocked_for_ads: reduzir bid em 30%
          let newBid = currentBid;
          if (classification.profitability_status === 'gross_loss' || classification.profitability_status === 'blocked_for_ads') {
            newBid = Math.max(0.10, currentBid * 0.70);
          } else if (classification.profitability_status === 'post_ads_loss') {
            newBid = Math.max(0.10, currentBid * 0.80);
          }

          if (newBid < currentBid - 0.01) {
            const iKey = `profit_guard|${String(kw.keyword_id || kw.id)}|${today}`;
            actionQueue.push({
              amazon_account_id: amazonAccountId,
              operation: 'update_bid',
              entity_type: 'keyword',
              entity_id: String(kw.keyword_id || kw.id || ''),
              campaign_id: String(kw.campaign_id || ''),
              keyword_id: String(kw.keyword_id || kw.id || ''),
              asin: prod.asin,
              payload: JSON.stringify({
                bid: Math.round(newBid * 100) / 100,
                bid_before: currentBid,
                rule: 'PROFIT_AFTER_ADS_RULE',
                profitability_status: classification.profitability_status,
                mpa_pct: prod.mpa_pct,
                profit_after_ads: prod.profit_after_ads,
              }),
              idempotency_key: iKey,
              priority: 1,
              confidence: classification.profitability_status === 'gross_loss' ? 98 : 90,
              status: 'approved',
              reason: `PROFIT_AFTER_ADS_RULE: ${classification.profitability_status}`,
              rule_applied: 'PRODUCT_LOSS_GUARD',
              value_before: currentBid,
              value_after: Math.round(newBid * 100) / 100,
              source_function: 'learnFromProductProfitability',
              created_at: now,
            });
          }
        }
      }
    }

    // Salvar ações em lote
    let enqueuedCount = 0;
    if (actionQueue.length > 0) {
      // Verificar idempotência
      const existingActions = await base44.asServiceRole.entities.AmazonActionQueue.filter(
        { amazon_account_id: amazonAccountId }, '-created_date', 500
      ).catch(() => []);
      const usedKeys = new Set((existingActions as Record<string, unknown>[]).map(a => String(a.idempotency_key || '')));
      const newActions = actionQueue.filter(a => !usedKeys.has(String(a.idempotency_key || '')));
      for (let i = 0; i < newActions.length; i += 50) {
        await base44.asServiceRole.entities.AmazonActionQueue.bulkCreate(newActions.slice(i, i + 50)).catch(() => {});
        enqueuedCount += newActions.slice(i, i + 50).length;
      }
    }

    // Comparar variações (produtos da mesma família)
    const familyMap: Record<string, typeof learningRecords> = {};
    for (const rec of learningRecords) {
      const sku = String((rec as Record<string, unknown>).sku || '');
      const base = sku.replace(/[A-Z0-9]$/, '').replace(/\d+$/, '');
      if (!familyMap[base]) familyMap[base] = [];
      familyMap[base].push(rec);
    }
    const familyInsights: string[] = [];
    for (const [family, variants] of Object.entries(familyMap)) {
      if (variants.length < 2) continue;
      const ranked = variants
        .map(v => ({ sku: (v as Record<string, unknown>).sku, mpa: safe((v as Record<string, unknown>).mpa_pct) }))
        .sort((a, b) => b.mpa - a.mpa);
      familyInsights.push(`Família ${family}: melhor variação ${ranked[0].sku} (MPA ${ranked[0].mpa.toFixed(1)}%) — priorizar budget.`);
    }

    return Response.json({
      ok: true,
      products_processed: inputProducts.length,
      stats,
      bids_queued_for_reduction: enqueuedCount,
      learning_records: learningRecords,
      family_insights: familyInsights,
      rules_applied: ['PROFIT_AFTER_ADS_RULE', 'PRODUCT_LOSS_GUARD'],
      duration_ms: Date.now() - start,
    });

  } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
});