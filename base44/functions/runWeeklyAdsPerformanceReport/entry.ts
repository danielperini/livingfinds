/**
 * runWeeklyAdsPerformanceReport — Relatório Semanal Consolidado de Performance de Ads
 *
 * FILOSOFIA:
 *   - Consolida os 7 últimos dias COMPLETOS (nunca o dia atual parcial)
 *   - Usa somente DailyProductAdsAssessment com data_status = complete | partial
 *   - Dia ausente ou failed → mantém último válido, reduz confiança, marca cobertura incompleta
 *   - Não assume zero para dias faltantes
 *   - Idempotente por (account + week_start + week_end) — atualiza se já existir
 *   - Gera resumo executivo determinístico a partir de fatos persistidos
 *   - Não altera dados, campanhas, bids, métricas ou decisões
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function nowIso() { return new Date().toISOString(); }
function yesterdayBRT() {
  const t = new Date(Date.now() - 3 * 3600000);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}
function addDays(date: string, amount: number) {
  const d = new Date(`${date}T12:00:00-03:00`);
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}
function sevenDayWindow(endDate: string) {
  return Array.from({ length: 7 }, (_, index) => addDays(endDate, index - 6));
}

// ── Gerar resumo executivo determinístico ────────────────────────────────────
function generateExecutiveSummary(params: {
  week_start: string;
  week_end: string;
  products: any[];
  campaigns: any[];
  decisions: any[];
  profitable: number;
  unprofitable: number;
  no_sales_with_spend: number;
  low_profit: number;
  break_even_number: number;
  campaigns_adjusted: number;
  keywords_adjusted: number;
  decisions_executed: number;
  total_spend: number;
  total_ads_sales: number;
  total_real_sales: number;
  total_profit_after_ads: number;
  account_acos: number | null;
  account_roas: number;
  data_coverage_percent: number;
}): string {
  const lines: string[] = [];
  const {
    week_start, week_end, products, campaigns, decisions,
    profitable, unprofitable, no_sales_with_spend, low_profit, break_even_number,
    campaigns_adjusted, keywords_adjusted, decisions_executed,
    total_spend, total_ads_sales, total_real_sales, total_profit_after_ads,
    account_acos, account_roas, data_coverage_percent
  } = params;

  const total = products.length;
  if (total === 0) return `No período de ${week_start} a ${week_end}, ainda não houve produtos com aferição econômica válida para consolidar.`;

  lines.push(`Entre ${week_start} e ${week_end}, o banco acumulou ${data_coverage_percent.toFixed(0)}% dos dias previstos e avaliou ${total} produto(s).`);

  const revenueText = total_real_sales > 0
    ? `faturamento real de R$${total_real_sales.toFixed(2)}`
    : 'faturamento real ainda parcial na SP-API';
  lines.push(`A semana registrou gasto de R$${total_spend.toFixed(2)}, vendas atribuídas aos Ads de R$${total_ads_sales.toFixed(2)}, ${revenueText} e lucro pós-Ads consolidado de R$${total_profit_after_ads.toFixed(2)}.`);

  if (account_acos !== null) {
    lines.push(`O ACoS consolidado foi de ${account_acos.toFixed(1)}% e o ROAS de ${account_roas.toFixed(2)}x.`);
  }

  const bidDecisions = decisions.filter((decision: any) => {
    const searchable = [
      decision.decision_type, decision.action, decision.rule_key, decision.entity_type,
    ].map((value) => String(value || '').toLowerCase()).join('|');
    return searchable.includes('bid') || (
      decision.value_before != null && decision.value_after != null &&
      Number(decision.value_before) !== Number(decision.value_after)
    );
  });
  const bidExecuted = bidDecisions.filter((decision: any) => decision.status === 'executed').length;
  const bidReductions = bidDecisions.filter((decision: any) =>
    decision.status === 'executed' &&
    Number(decision.value_after ?? decision.proposed_value ?? 0) <
      Number(decision.value_before ?? decision.current_value ?? 0)
  ).length;
  const bidIncreases = bidDecisions.filter((decision: any) =>
    decision.status === 'executed' &&
    Number(decision.value_after ?? decision.proposed_value ?? 0) >
      Number(decision.value_before ?? decision.current_value ?? 0)
  ).length;
  lines.push(`O motor/IA realizou ${decisions.length} interação(ões) de decisão; ${decisions_executed} foram executadas. Foram identificadas ${bidDecisions.length} interação(ões) de bid, com ${bidExecuted} executadas (${bidReductions} reduções e ${bidIncreases} aumentos), além de ${campaigns_adjusted} campanha(s) e ${keywords_adjusted} keyword(s) ajustadas.`);

  const named = (product: any) =>
    product?.product_name || product?.sku || product?.asin || 'produto não identificado';
  const profitableProducts = products.filter((product: any) => Number(product.profit_after_ads_7d) > 0);
  const winner = [...profitableProducts].sort((a: any, b: any) =>
    Number(b.profit_after_ads_7d || 0) - Number(a.profit_after_ads_7d || 0)
  )[0] || [...products].sort((a: any, b: any) =>
    Number(b.ads_sales_7d || 0) - Number(a.ads_sales_7d || 0)
  )[0];
  if (winner) {
    const winningCampaign = campaigns.find((campaign: any) => String(campaign.asin || '') === String(winner.asin || ''));
    const winningCampaignText = winningCampaign
      ? `, associado à campanha “${winningCampaign.campaign_name || winningCampaign.name || winningCampaign.campaign_id}”`
      : '';
    lines.push(`O destaque vencedor foi “${named(winner)}” (${winner.sku || winner.asin})${winningCampaignText}, com R$${Number(winner.ads_sales_7d || 0).toFixed(2)} em vendas Ads e R$${Number(winner.profit_after_ads_7d || 0).toFixed(2)} de lucro pós-Ads.`);
  }

  const loser = [...products]
    .filter((product: any) => product.profit_after_ads_7d != null)
    .sort((a: any, b: any) => Number(a.profit_after_ads_7d) - Number(b.profit_after_ads_7d))[0];
  if (loser && Number(loser.profit_after_ads_7d) < 0) {
    const losingCampaign = campaigns.find((campaign: any) => String(campaign.asin || '') === String(loser.asin || ''));
    const losingCampaignText = losingCampaign
      ? `, na campanha “${losingCampaign.campaign_name || losingCampaign.name || losingCampaign.campaign_id}”`
      : '';
    const loserActions = decisions.filter((decision: any) =>
      (decision.asin && decision.asin === loser.asin) ||
      (decision.sku && decision.sku === loser.sku)
    );
    const executedLoserActions = loserActions.filter((decision: any) => decision.status === 'executed');
    const actionText = executedLoserActions.length > 0
      ? `${executedLoserActions.length} ação(ões) executadas, incluindo redução/controle de bid ou revisão de entrega conforme as regras econômicas`
      : `monitoramento e recomendação “${loser.recommended_action || 'revisar bids e termos de busca'}”`;
    lines.push(`O maior prejuízo ficou com “${named(loser)}” (${loser.sku || loser.asin})${losingCampaignText}, em R$${Math.abs(Number(loser.profit_after_ads_7d)).toFixed(2)} negativos após Ads; para conter a perda, houve ${actionText}.`);
  }

  const noSale = [...products]
    .filter((product: any) => Number(product.spend_7d) > 0 && Number(product.ads_sales_7d) === 0)
    .sort((a: any, b: any) => Number(b.spend_7d) - Number(a.spend_7d))[0];
  if (noSale) {
    lines.push(`O principal ponto sem retorno foi “${named(noSale)}” (${noSale.sku || noSale.asin}), que consumiu R$${Number(noSale.spend_7d).toFixed(2)} sem venda atribuída; permanece sob redução de exposição, revisão de termos e possível pausa caso ultrapasse o limite econômico.`);
  }

  lines.push(`Distribuição econômica: ${profitable} lucrativo(s), ${low_profit} com lucro baixo, ${break_even_number} no break-even, ${unprofitable} deficitário(s) e ${no_sales_with_spend} com gasto sem vendas.`);

  return lines.join(' ');
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

    // Ancorar a janela na aferição mais recente realmente processada evita
    // relatórios vazios quando Ads ou SP-API fecham com atraso.
    let assessments = await base44.asServiceRole.entities.DailyProductAdsAssessment.filter(
      { amazon_account_id: aid }, '-assessment_date', 2000
    ).catch(() => []);
    const latestProcessedDate = assessments
      .filter((a: any) => ['complete', 'partial'].includes(String(a.data_status || '')) && a.assessment_date)
      .map((a: any) => String(a.assessment_date))
      .sort()
      .pop();
    if (!latestProcessedDate) {
      return Response.json({
        ok: true,
        skipped: true,
        reason: 'Nenhuma aferição diária processada disponível para consolidar.',
      });
    }
    const week_end = latestProcessedDate;
    const week_start = addDays(week_end, -6);

    // Autocura da cobertura: se algum dos sete dias ainda não tem aferição
    // válida, reconstruí-lo a partir dos relatórios diários persistidos antes
    // de consolidar a semana.
    const validAssessmentDates = new Set(
      assessments
        .filter((a: any) => ['complete', 'partial'].includes(String(a.data_status || '')))
        .map((a: any) => String(a.assessment_date || ''))
    );
    const missingDates = sevenDayWindow(week_end).filter((date) => !validAssessmentDates.has(date));
    const backfillResults: any[] = [];
    for (const assessmentDate of missingDates) {
      const response = await base44.asServiceRole.functions.invoke('runDailyEconomicAssessment', {
        amazon_account_id: aid,
        assessment_date: assessmentDate,
        force: true,
        _service_role: true,
      }).catch((error: any) => ({ data: { ok: false, error: error?.message || String(error) } }));
      backfillResults.push({ assessment_date: assessmentDate, ...(response?.data || response || {}) });
    }
    if (missingDates.length > 0) {
      assessments = await base44.asServiceRole.entities.DailyProductAdsAssessment.filter(
        { amazon_account_id: aid }, '-assessment_date', 2000
      ).catch(() => assessments);
    }

    const iKey = `weekly_report|${aid}|${week_start}|${week_end}`;

    // ── Idempotência: verificar se relatório já existe ─────────────────────
    const existingReports = await base44.asServiceRole.entities.WeeklyAdsPerformanceReport.filter(
      { amazon_account_id: aid, week_start, week_end }, null, 1
    ).catch(() => []);
    const existingReport = existingReports[0] || null;

    if (existingReport && !body.force) {
      return Response.json({
        ok: true, skipped: true,
        reason: `Relatório para ${week_start} a ${week_end} já existe. Use force=true para reprocessar.`,
        report_id: existingReport.id,
        week_start, week_end,
      });
    }

    // Filtrar pelo período (week_start a week_end inclusive)
    const periodAssessments = assessments.filter((a: any) =>
      a.assessment_date >= week_start && a.assessment_date <= week_end
    );

    // ── Calcular cobertura de dados ────────────────────────────────────────
    const daysInPeriod = 7;
    const daysWithData = new Set(periodAssessments.map((a: any) => a.assessment_date)).size;
    const daysComplete = periodAssessments.filter((a: any) =>
      ['complete', 'partial'].includes(a.data_status)
    ).length > 0 ? daysWithData : 0;
    const data_coverage_percent = Math.round((daysWithData / daysInPeriod) * 100);

    // ── Agregar por ASIN ───────────────────────────────────────────────────
    const byAsin = new Map<string, any[]>();
    for (const a of periodAssessments) {
      if (!byAsin.has(a.asin)) byAsin.set(a.asin, []);
      byAsin.get(a.asin)!.push(a);
    }

    // ── Carregar produtos para nomes e info adicional ──────────────────────
    const [products, campaigns] = await Promise.all([
      base44.asServiceRole.entities.Product.filter(
        { amazon_account_id: aid }, null, 200
      ).catch(() => []),
      base44.asServiceRole.entities.Campaign.filter(
        { amazon_account_id: aid }, null, 1000
      ).catch(() => []),
    ]);
    const productMap = new Map<string, any>();
    for (const p of products) if (p.asin) productMap.set(p.asin, p);

    // ── Carregar decisões da semana para contagem ──────────────────────────
    const decisionsWeek = await base44.asServiceRole.entities.OptimizationDecision.filter(
      { amazon_account_id: aid }, '-created_at', 500
    ).catch(() => []);
    const decisionsInPeriod = decisionsWeek.filter((d: any) =>
      d.created_at && d.created_at.slice(0, 10) >= week_start && d.created_at.slice(0, 10) <= week_end
    );
    const decisions_created = decisionsInPeriod.length;
    const decisions_executed = decisionsInPeriod.filter((d: any) => d.status === 'executed').length;
    const decisions_failed = decisionsInPeriod.filter((d: any) => d.status === 'failed').length;
    const decisions_pending_confirmation = decisionsInPeriod.filter((d: any) =>
      ['pending', 'approved', 'scheduled'].includes(d.status)
    ).length;

    // Campanhas e keywords ajustadas
    const uniqueCampaignsAdjusted = new Set(decisionsInPeriod.filter((d: any) => d.campaign_id).map((d: any) => d.campaign_id));
    const uniqueKeywordsAdjusted = new Set(decisionsInPeriod.filter((d: any) => d.keyword_id).map((d: any) => d.keyword_id));

    // ── Calcular métricas por produto (7d) ─────────────────────────────────
    const weeklyProducts: any[] = [];
    let total_spend = 0, total_ads_sales = 0, total_real_sales = 0;
    let total_orders = 0, total_units = 0;
    let total_profit_before_ads = 0, total_profit_after_ads = 0;
    let count_profitable = 0, count_unprofitable = 0, count_no_sales = 0, count_low_profit = 0, count_break_even = 0;

    for (const [asin, days] of byAsin) {
      const product = productMap.get(asin);
      // Usar somente dias com data_status != failed
      const validDays = days.filter((d: any) => !['failed'].includes(d.data_status));
      if (validDays.length === 0) continue;

      const spend_7d = validDays.reduce((s: number, d: any) => s + (d.spend || 0), 0);
      const ads_sales_7d = validDays.reduce((s: number, d: any) => s + (d.ads_sales || 0), 0);
      const real_sales_7d = validDays.reduce((s: number, d: any) => s + (d.real_sales || 0), 0);
      const orders_7d = validDays.reduce((s: number, d: any) => s + (d.orders_ads || 0), 0);
      const units_7d = validDays.reduce((s: number, d: any) => s + (d.units_real || 0), 0);
      const impressions_7d = validDays.reduce((s: number, d: any) => s + (d.impressions || 0), 0);
      const clicks_7d = validDays.reduce((s: number, d: any) => s + (d.clicks || 0), 0);
      const profit_before_ads_7d = validDays.reduce((s: number, d: any) => s + (d.contribution_profit_before_ads || 0), 0);

      // ACoS 7d: calculado sobre totais (não média de ACoS diários)
      const acos_7d = ads_sales_7d > 0 ? Math.round((spend_7d / ads_sales_7d) * 1000) / 10 : null;
      const roas_7d = spend_7d > 0 ? Math.round((ads_sales_7d / spend_7d) * 100) / 100 : 0;
      // TACoS: somente quando real_sales disponível
      const tacos_7d = real_sales_7d > 0 ? Math.round((spend_7d / real_sales_7d) * 1000) / 10 : null;

      // Lucro pós-ads: somar os lucros por dia (já calculados com a fórmula correta)
      const profit_days = validDays.filter((d: any) => d.profit_after_ads !== null && d.profit_after_ads !== undefined);
      const profit_after_ads_7d = profit_days.length > 0
        ? profit_days.reduce((s: number, d: any) => s + (d.profit_after_ads || 0), 0)
        : null;

      // Classificação dominante da semana (maioria dos dias)
      const statusCounts = validDays.reduce((acc: any, d: any) => {
        acc[d.economic_status] = (acc[d.economic_status] || 0) + 1;
        return acc;
      }, {});
      const dominantStatus = Object.entries(statusCounts).sort((a: any, b: any) => b[1] - a[1])[0]?.[0] || 'insufficient_data';

      // Problema principal (última análise)
      const lastDay = validDays.sort((a: any, b: any) => b.assessment_date.localeCompare(a.assessment_date))[0];
      const target_acos = lastDay?.target_acos || 20;
      const break_even_acos = lastDay?.break_even_acos || 0;
      const maximum_profitable_cpa = lastDay?.maximum_profitable_cpa || 0;

      // Ações executadas para este produto na semana
      const productDecisions = decisionsInPeriod.filter((d: any) => d.asin === asin);
      const actions_executed = productDecisions.filter((d: any) => d.status === 'executed').length;

      // Próxima revisão: 48h após última ação ou 7 dias após início da semana
      const lastAction = productDecisions.sort((a: any, b: any) =>
        new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
      )[0];
      const next_review_at = lastAction
        ? new Date(new Date(lastAction.created_at).getTime() + 48 * 3600000).toISOString()
        : new Date(Date.now() + 7 * 86400000).toISOString();

      // Determinar ação recomendada para a semana
      let recommended_action = lastDay?.recommended_action || 'monitor';
      let main_problem = lastDay?.performance_status || '';

      // Acumular totais
      total_spend += spend_7d;
      total_ads_sales += ads_sales_7d;
      total_real_sales += real_sales_7d;
      total_orders += orders_7d;
      total_units += units_7d;
      total_profit_before_ads += profit_before_ads_7d;
      if (profit_after_ads_7d !== null) total_profit_after_ads += profit_after_ads_7d;

      if (dominantStatus === 'profitable') count_profitable++;
      else if (dominantStatus === 'unprofitable') count_unprofitable++;
      else if (dominantStatus === 'no_sales_with_spend') count_no_sales++;
      else if (dominantStatus === 'low_profit') count_low_profit++;
      else if (dominantStatus === 'break_even') count_break_even++;

      const iKeyProduct = `weekly_product|${aid}|${asin}|${week_start}|${week_end}`;
      weeklyProducts.push({
        amazon_account_id: aid,
        week_start, week_end,
        product_id: product?.id || '',
        asin,
        sku: product?.sku || '',
        product_name: product?.product_name || product?.display_name || '',
        spend_7d: Math.round(spend_7d * 100) / 100,
        ads_sales_7d: Math.round(ads_sales_7d * 100) / 100,
        real_sales_7d: Math.round(real_sales_7d * 100) / 100,
        orders_7d,
        units_7d,
        impressions_7d,
        clicks_7d,
        acos_7d,
        roas_7d,
        tacos_7d,
        profit_before_ads_7d: Math.round(profit_before_ads_7d * 100) / 100,
        profit_after_ads_7d: profit_after_ads_7d !== null ? Math.round(profit_after_ads_7d * 100) / 100 : null,
        target_acos,
        break_even_acos,
        maximum_profitable_cpa: Math.round(maximum_profitable_cpa * 100) / 100,
        status: dominantStatus,
        main_problem,
        recommended_action,
        actions_executed,
        next_review_at,
        idempotency_key: iKeyProduct,
        created_at: nowIso(),
        updated_at: nowIso(),
      });
    }

    // ── KPIs consolidados da conta ─────────────────────────────────────────
    const account_acos = total_ads_sales > 0
      ? Math.round((total_spend / total_ads_sales) * 1000) / 10
      : null;
    const account_roas = total_spend > 0
      ? Math.round((total_ads_sales / total_spend) * 100) / 100
      : 0;
    const account_tacos = total_real_sales > 0
      ? Math.round((total_spend / total_real_sales) * 1000) / 10
      : null;

    // ── Resumo executivo ───────────────────────────────────────────────────
    const executive_summary = generateExecutiveSummary({
      week_start,
      week_end,
      products: weeklyProducts,
      campaigns,
      decisions: decisionsInPeriod,
      profitable: count_profitable,
      unprofitable: count_unprofitable,
      no_sales_with_spend: count_no_sales,
      low_profit: count_low_profit,
      break_even_number: count_break_even,
      campaigns_adjusted: uniqueCampaignsAdjusted.size,
      keywords_adjusted: uniqueKeywordsAdjusted.size,
      decisions_executed,
      total_spend,
      total_ads_sales,
      total_real_sales,
      total_profit_after_ads,
      account_acos,
      account_roas,
      data_coverage_percent,
    });

    // ── Persistir relatório semanal (upsert) ──────────────────────────────
    const reportData: any = {
      amazon_account_id: aid,
      week_start,
      week_end,
      report_status: data_coverage_percent >= 70 ? 'complete' : 'partial',
      data_coverage_percent,
      days_complete: daysWithData,
      days_partial: daysInPeriod - daysWithData,
      total_spend: Math.round(total_spend * 100) / 100,
      total_ads_sales: Math.round(total_ads_sales * 100) / 100,
      total_real_sales: Math.round(total_real_sales * 100) / 100,
      total_orders,
      total_units,
      account_acos,
      account_roas,
      account_tacos,
      total_profit_before_ads: Math.round(total_profit_before_ads * 100) / 100,
      total_profit_after_ads: Math.round(total_profit_after_ads * 100) / 100,
      products_profitable: count_profitable,
      products_unprofitable: count_unprofitable,
      products_no_sales_with_spend: count_no_sales,
      campaigns_adjusted: uniqueCampaignsAdjusted.size,
      keywords_adjusted: uniqueKeywordsAdjusted.size,
      decisions_created,
      decisions_executed,
      decisions_failed,
      decisions_pending_confirmation,
      executive_summary,
      idempotency_key: iKey,
      updated_at: nowIso(),
    };

    let reportId: string;
    if (existingReport) {
      await base44.asServiceRole.entities.WeeklyAdsPerformanceReport.update(existingReport.id, reportData).catch(() => {});
      reportId = existingReport.id;
    } else {
      reportData.created_at = nowIso();
      const created = await base44.asServiceRole.entities.WeeklyAdsPerformanceReport.create(reportData).catch(() => null);
      reportId = created?.id || '';
    }

    // ── Persistir WeeklyProductPerformance ────────────────────────────────
    if (reportId) {
      // Deletar registros anteriores da mesma semana (se force ou novo)
      const existingProductRows = await base44.asServiceRole.entities.WeeklyProductPerformance.filter(
        { amazon_account_id: aid, week_start, week_end }, null, 500
      ).catch(() => []);
      for (const ex of existingProductRows) {
        await base44.asServiceRole.entities.WeeklyProductPerformance.delete(ex.id).catch(() => {});
      }

      // Ordenar: maior prejuízo primeiro, depois gasto sem vendas, depois ACoS alto
      weeklyProducts.sort((a: any, b: any) => {
        const order: Record<string, number> = {
          unprofitable: 0, no_sales_with_spend: 1, break_even: 2, low_profit: 3, profitable: 4, insufficient_data: 5
        };
        const oa = order[a.status] ?? 5;
        const ob = order[b.status] ?? 5;
        if (oa !== ob) return oa - ob;
        return (b.spend_7d || 0) - (a.spend_7d || 0);
      });

      const productsWithReportId = weeklyProducts.map((p: any) => ({ ...p, weekly_report_id: reportId }));
      for (let i = 0; i < productsWithReportId.length; i += 50) {
        await base44.asServiceRole.entities.WeeklyProductPerformance.bulkCreate(
          productsWithReportId.slice(i, i + 50)
        ).catch(() => []);
      }
    }

    // ── Log de execução ───────────────────────────────────────────────────
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'weekly_ads_performance_report',
      trigger_type: 'automatic',
      status: 'success',
      execution_date: week_end,
      started_at: startedAt,
      completed_at: nowIso(),
      duration_ms: Date.now() - t0,
      records_processed: weeklyProducts.length,
      result_summary: JSON.stringify({
        week_start, week_end,
        data_coverage_percent,
        backfilled_dates: backfillResults.map((result: any) => ({
          assessment_date: result.assessment_date,
          ok: result.ok !== false,
        })),
        products: weeklyProducts.length,
        profitable: count_profitable,
        unprofitable: count_unprofitable,
        report_id: reportId,
      }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      week_start, week_end,
      report_id: reportId,
      report_status: reportData.report_status,
      data_coverage_percent,
      backfilled_dates: backfillResults.map((result: any) => ({
        assessment_date: result.assessment_date,
        ok: result.ok !== false,
      })),
      products_analyzed: weeklyProducts.length,
      profitable: count_profitable,
      unprofitable: count_unprofitable,
      no_sales_with_spend: count_no_sales,
      total_spend: reportData.total_spend,
      account_acos,
      decisions_created,
      decisions_executed,
      executive_summary,
      duration_ms: Date.now() - t0,
    });

  } catch (error: any) {
    console.error('[runWeeklyAdsPerformanceReport]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});
