/**
 * runFullAccountOptimizationWithNewLogic — Pipeline Consolidado de Otimização
 *
 * Orquestra todo o processo de otimização em etapas sequenciais:
 * 1. buildAuditedDecisionContext (contexto auditado)
 * 2. applyAmazonSuggestedBidReduction (ECONOMY_FIRST: bids sugeridos menores)
 * 3. runFullCampaignStandardsReview (revisão completa de campanhas e keywords)
 * 4. runDeterministicDecisionEngine (motor determinístico com regras do banco)
 * 5. evaluateDecisionOutcomes (avaliar decisões anteriores vencidas)
 * 6. Salvar relatório final em FullOptimizationRunReport
 *
 * Bloqueios:
 * - Se contexto retornar decision_ready=false → apenas Economy First é permitido.
 * - Nunca aumentar gasto se spend_spike_without_sales=true.
 * - Todas as ações passam por AmazonActionQueue.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function safe(v: unknown): number {
  const n = Number(v);
  return isNaN(n) || !isFinite(n) ? 0 : n;
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  const startedAt = new Date().toISOString();
  let runReport: Record<string, unknown> | null = null;

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

    const trigger = body.trigger || 'manual';

    // Criar relatório inicial
    runReport = await base44.asServiceRole.entities.FullOptimizationRunReport.create({
      amazon_account_id: amazonAccountId,
      started_at: startedAt,
      trigger,
      status: 'running',
      economy_first_applied: true,
    });

    const results: Record<string, unknown> = {};
    const warnings: string[] = [];
    const errors: string[] = [];

    // ── ETAPA 1: Contexto auditado ────────────────────────────────────────
    console.log('[Otimização] Etapa 1: buildAuditedDecisionContext');
    let context: Record<string, unknown> = {};
    try {
      const ctxRes = await base44.asServiceRole.functions.invoke('buildAuditedDecisionContext', {
        amazon_account_id: amazonAccountId,
        _service_role: true,
      });
      if (ctxRes?.data?.ok && ctxRes?.data?.context) {
        context = ctxRes.data.context;
        if (Array.isArray(context.warnings)) warnings.push(...(context.warnings as string[]));
        if (Array.isArray(context.blocked_reasons) && (context.blocked_reasons as string[]).length > 0) {
          warnings.push(`Contexto bloqueado: ${(context.blocked_reasons as string[]).join(', ')}`);
        }
        results.context = {
          data_quality_score: context.data_quality_score,
          decision_ready: context.decision_ready,
          spend_spike: context.spend_spike_detected,
          campaigns_active: context.campaigns_active,
          products_out_of_stock: context.products_out_of_stock,
        };
      } else {
        warnings.push(`Falha no contexto: ${ctxRes?.data?.error || 'erro desconhecido'}`);
      }
    } catch (e) {
      errors.push(`buildAuditedDecisionContext: ${(e as Error).message}`);
    }

    const spendSpike = context.spend_spike_without_sales === true;
    const decisionReady = context.decision_ready !== false; // permissivo se contexto falhou

    // ── ETAPA 2: Economy First — Bid sugerido Amazon ──────────────────────
    console.log('[Otimização] Etapa 2: applyAmazonSuggestedBidReduction');
    let bidReductionResult: Record<string, unknown> = {};
    try {
      const bidRes = await base44.asServiceRole.functions.invoke('applyAmazonSuggestedBidReduction', {
        amazon_account_id: amazonAccountId,
        _service_role: true,
      });
      if (bidRes?.data?.ok) {
        bidReductionResult = bidRes.data;
        results.bid_reduction = {
          actions_enqueued: bidRes.data.actions_enqueued || 0,
          total_expected_savings_per_day: bidRes.data.total_expected_savings_per_day || 0,
        };
      }
    } catch (e) {
      errors.push(`applyAmazonSuggestedBidReduction: ${(e as Error).message}`);
    }

    // ── ETAPA 3: Revisão completa de campanhas ────────────────────────────
    console.log('[Otimização] Etapa 3: runFullCampaignStandardsReview');
    let reviewResult: Record<string, unknown> = {};
    try {
      const rvRes = await base44.asServiceRole.functions.invoke('runFullCampaignStandardsReview', {
        amazon_account_id: amazonAccountId,
        _service_role: true,
      });
      if (rvRes?.data?.ok) {
        reviewResult = rvRes.data.stats || {};
        if (Array.isArray(rvRes.data.warnings)) warnings.push(...(rvRes.data.warnings as string[]));
        results.review = reviewResult;
      }
    } catch (e) {
      errors.push(`runFullCampaignStandardsReview: ${(e as Error).message}`);
    }

    // ── ETAPA 4: Motor determinístico (só se dados estiverem frescos e sem spike) ──
    console.log('[Otimização] Etapa 4: runDeterministicDecisionEngine');
    let deterministicResult: Record<string, unknown> = {};
    try {
      if (!spendSpike && decisionReady) {
        // O motor determinístico usa autenticação de usuário — chamar diretamente
        const detRes = await base44.functions.invoke('runDeterministicDecisionEngine', {
          amazon_account_id: amazonAccountId,
        });
        if (detRes?.data?.ok) {
          deterministicResult = detRes.data;
          results.deterministic = {
            active_rules: detRes.data.active_rules,
            actions_enqueued: detRes.data.actions_enqueued,
            stats: detRes.data.stats,
          };
        }
      } else {
        results.deterministic = { skipped: true, reason: spendSpike ? 'spend_spike_detected' : 'data_not_ready' };
        warnings.push('Motor determinístico ignorado: ' + (spendSpike ? 'spike de gasto detectado' : 'dados não prontos'));
      }
    } catch (e) {
      errors.push(`runDeterministicDecisionEngine: ${(e as Error).message}`);
    }

    // ── ETAPA 5: Avaliar decisões anteriores vencidas ─────────────────────
    console.log('[Otimização] Etapa 5: evaluateDecisionOutcomes');
    try {
      const evalRes = await base44.asServiceRole.functions.invoke('evaluateDecisionOutcomes', {
        amazon_account_id: amazonAccountId,
        _service_role: true,
      });
      if (evalRes?.data?.ok) {
        results.outcome_evaluation = {
          evaluated: evalRes.data.evaluated,
          positive: evalRes.data.positive,
          negative: evalRes.data.negative,
        };
      }
    } catch (e) {
      errors.push(`evaluateDecisionOutcomes: ${(e as Error).message}`);
    }

    // ── ETAPA 6: Atualizar catálogo de relatórios ─────────────────────────
    try {
      const reportCatalog = [
        { report_key: 'spCampaigns', report_type_id: 'spCampaigns', api_family: 'ads_v3', primary_source: true, implemented: true, freshness_hours: 24 },
        { report_key: 'spKeywords', report_type_id: 'spKeywords', api_family: 'ads_v3', primary_source: true, implemented: true, freshness_hours: 24 },
        { report_key: 'spSearchTerm', report_type_id: 'spSearchTerm', api_family: 'ads_v3', primary_source: true, implemented: true, freshness_hours: 24 },
        { report_key: 'spAdvertisedProduct', report_type_id: 'spAdvertisedProduct', api_family: 'ads_v3', primary_source: true, implemented: true, freshness_hours: 24 },
        { report_key: 'spProductAds', report_type_id: 'spProductAds', api_family: 'ads_v3', primary_source: false, duplicate_of: 'spAdvertisedProduct', implemented: true, notes: 'Usar spAdvertisedProduct como primário. spProductAds apenas para campos exclusivos.', freshness_hours: 24 },
        { report_key: 'spTargeting', report_type_id: 'spTargeting', api_family: 'ads_v3', primary_source: true, implemented: false, freshness_hours: 24 },
        { report_key: 'spNegativeKeywords', report_type_id: 'spNegativeKeywords', api_family: 'ads_v3', primary_source: true, implemented: false, freshness_hours: 24 },
        { report_key: 'spPlacement', report_type_id: 'spPlacement', api_family: 'ads_v3', primary_source: true, implemented: false, freshness_hours: 24 },
        { report_key: 'GET_MERCHANT_LISTINGS_ALL_DATA', report_type_id: 'GET_MERCHANT_LISTINGS_ALL_DATA', api_family: 'sp_api', primary_source: true, implemented: true, freshness_hours: 24 },
        { report_key: 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA', report_type_id: 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA', api_family: 'sp_api', primary_source: true, implemented: true, freshness_hours: 6 },
        { report_key: 'SalesDaily', report_type_id: 'SalesDaily', api_family: 'business_report', primary_source: true, implemented: false, freshness_hours: 24, notes: 'Para TACoS — vendas totais vs vendas Ads' },
        { report_key: 'BidRecommendations', report_type_id: 'BidRecommendations', api_family: 'ads_v3', primary_source: true, implemented: false, freshness_hours: 24, notes: 'amazon_suggested_bid por keyword' },
        { report_key: 'HourlyMetrics', report_type_id: 'HourlyMetrics', api_family: 'ads_v3', primary_source: true, implemented: true, freshness_hours: 168 },
      ];

      for (const cat of reportCatalog) {
        const existing = await base44.asServiceRole.entities.AmazonReportCatalog.filter({
          amazon_account_id: amazonAccountId, report_key: cat.report_key
        }).catch(() => []);
        if (!existing.length) {
          await base44.asServiceRole.entities.AmazonReportCatalog.create({
            amazon_account_id: amazonAccountId,
            ...cat,
          }).catch(() => {});
        }
      }
    } catch {}

    // ── Finalizar relatório ───────────────────────────────────────────────
    const finishedAt = new Date().toISOString();
    const rv = reviewResult as Record<string, number>;
    const bids_reduced = safe(rv.bids_reduced || 0) + safe((bidReductionResult as Record<string, number>).actions_enqueued || 0);
    const expectedSavings = safe((bidReductionResult as Record<string, number>).total_expected_savings_per_day || 0);
    const dataQuality = safe((context as Record<string, number>).data_quality_score || 0);

    const summary = [
      `Contexto: qualidade=${dataQuality}% | decisão_pronta=${context.decision_ready}`,
      `Bids reduzidos: ${bids_reduced} (ECONOMY_FIRST)`,
      `Campanhas revisadas: ${safe(rv.campaigns_reviewed)} | reparadas: ${safe(rv.campaigns_repaired)}`,
      `Keywords revisadas: ${safe(rv.keywords_reviewed)} | pausadas: ${safe(rv.keywords_paused)}`,
      `Fila de auto-campanhas: ${safe(rv.campaigns_created_auto)} | manuais: ${safe(rv.campaigns_created_manual)}`,
      `Economia estimada/dia: R$${expectedSavings.toFixed(2)}`,
      errors.length > 0 ? `Erros: ${errors.length}` : 'Sem erros',
    ].join(' | ');

    if (runReport?.id) {
      await base44.asServiceRole.entities.FullOptimizationRunReport.update(String(runReport.id), {
        finished_at: finishedAt,
        duration_ms: Date.now() - startTime,
        status: errors.length > 0 && Object.keys(results).length === 0 ? 'failed' : 'completed',
        campaigns_reviewed: safe(rv.campaigns_reviewed),
        campaigns_repaired: safe(rv.campaigns_repaired),
        campaigns_archived: safe(rv.campaigns_to_archive),
        campaigns_created_auto: safe(rv.campaigns_created_auto),
        campaigns_created_manual: safe(rv.campaigns_created_manual),
        keywords_reviewed: safe(rv.keywords_reviewed),
        keywords_repaired: safe(rv.keywords_repaired),
        keywords_paused: safe(rv.keywords_paused),
        bids_reduced,
        product_ads_paused_no_stock: safe(rv.product_ads_paused_no_stock),
        errors: errors.length,
        expected_savings_total: expectedSavings,
        data_quality_score: dataQuality,
        // Relatórios dentro do escopo MRC (API de relatórios programáticos — relatórios em massa)
        // Nota: dados de API são excluídos do escopo de credenciamento MRC para cliques,
        // mas são a única fonte disponível programaticamente. Métricas refletem cliques líquidos pós-GIVT/SIVT.
        reports_used: ['spCampaigns', 'spKeywords', 'spSearchTerm', 'spAdvertisedProduct', 'GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA', 'SalesDaily'],
        warnings: warnings.slice(0, 20),
        summary,
        actions_enqueued: safe(bids_reduced),
      }).catch(() => {});
    }

    return Response.json({
      ok: true,
      run_report_id: runReport?.id,
      stages_completed: Object.keys(results),
      summary,
      results,
      warnings: warnings.slice(0, 20),
      errors,
      economy_first_applied: true,
      duration_ms: Date.now() - startTime,
    });

  } catch (error) {
    if (runReport?.id) {
      const base44 = createClientFromRequest(req);
      await base44.asServiceRole.entities.FullOptimizationRunReport.update(String(runReport.id), {
        status: 'failed',
        finished_at: new Date().toISOString(),
        summary: `Erro fatal: ${(error as Error).message}`,
      }).catch(() => {});
    }
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
});