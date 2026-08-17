/**
 * evaluateDecisionOutcomes
 *
 * Avalia o resultado das decisões executadas após o período de janela.
 * Compara métricas ANTES e DEPOIS da decisão.
 * Ajusta o confidence score das regras (DecisionRulePerformance).
 * Registra LearningEvent para aprendizado futuro.
 *
 * NÃO usa IA. NÃO chama Amazon. Apenas lê banco, compara e salva.
 * Execução: diária via automação agendada.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function safe(v: unknown): number {
  const n = Number(v);
  return isNaN(n) || !isFinite(n) ? 0 : n;
}

function safeDiv(a: number, b: number): number {
  return b > 0 ? a / b : 0;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function aggregate(rows: Record<string, unknown>[]): {
  spend: number; sales: number; orders: number; clicks: number; impressions: number;
  acos: number; roas: number; cpc: number; ctr: number; cvr: number;
} {
  const spend = rows.reduce((s, r) => s + safe(r.spend), 0);
  const sales = rows.reduce((s, r) => s + safe(r.sales), 0);
  const orders = rows.reduce((s, r) => s + safe(r.orders), 0);
  const clicks = rows.reduce((s, r) => s + safe(r.clicks), 0);
  const impressions = rows.reduce((s, r) => s + safe(r.impressions), 0);
  return {
    spend, sales, orders, clicks, impressions,
    acos: safeDiv(spend, sales) * 100,
    roas: safeDiv(sales, spend),
    cpc: safeDiv(spend, clicks),
    ctr: safeDiv(clicks, impressions) * 100,
    cvr: safeDiv(orders, clicks) * 100,
  };
}

// Calcular impacto: positivo, neutro, negativo
function calcImpact(before: ReturnType<typeof aggregate>, after: ReturnType<typeof aggregate>, decision_type: string): {
  result_status: 'positive' | 'neutral' | 'negative' | 'insufficient_data';
  impact_score: number;
  success: boolean;
  notes: string[];
} {
  const notes: string[] = [];

  // Dados insuficientes
  if (after.clicks < 5 && after.orders === 0 && after.impressions < 50) {
    return { result_status: 'insufficient_data', impact_score: 0, success: false, notes: ['Dados insuficientes após decisão'] };
  }

  // Para decisões de redução de bid
  const isReduction = ['reduce_bid', 'bid_decrease', 'daypart_bid_decrease', 'budget_decrease'].includes(decision_type);
  const isIncrease = ['increase_bid', 'bid_increase', 'daypart_bid_increase', 'budget_increase'].includes(decision_type);
  const isNegative = decision_type === 'negative_keyword';

  let impact_score = 0;

  if (isReduction) {
    // Sucesso: ACoS reduziu ou gasto reduziu sem perder vendas
    const acosDelta = before.acos > 0 ? (before.acos - after.acos) / before.acos : 0;
    const salesDelta = before.sales > 0 ? (after.sales - before.sales) / before.sales : 0;
    const spendDelta = before.spend > 0 ? (after.spend - before.spend) / before.spend : 0;

    if (acosDelta > 0.10 && salesDelta > -0.20) {
      notes.push(`ACoS reduziu ${(acosDelta * 100).toFixed(1)}% mantendo vendas`);
      impact_score = Math.min(100, 60 + acosDelta * 200);
      return { result_status: 'positive', impact_score, success: true, notes };
    }
    if (spendDelta < -0.10 && salesDelta > -0.10) {
      notes.push(`Gasto reduziu ${Math.abs(spendDelta * 100).toFixed(1)}% sem queda proporcional de vendas`);
      impact_score = 50;
      return { result_status: 'positive', impact_score, success: true, notes };
    }
    // Falha: vendas caíram significativamente
    if (salesDelta < -0.30) {
      notes.push(`Vendas caíram ${Math.abs(salesDelta * 100).toFixed(1)}% — possível redução excessiva`);
      impact_score = -40;
      return { result_status: 'negative', impact_score, success: false, notes };
    }
    // Neutro
    notes.push('Impacto marginal — dentro da margem de variação natural');
    impact_score = 0;
    return { result_status: 'neutral', impact_score, success: false, notes };
  }

  if (isIncrease) {
    // Sucesso: vendas aumentaram com ACoS mantido ou melhorado
    const salesDelta = before.sales > 0 ? (after.sales - before.sales) / before.sales : (after.sales > 0 ? 1 : 0);
    const acosDelta = before.acos > 0 ? (after.acos - before.acos) / before.acos : 0; // positivo = piorou

    if (salesDelta > 0.10 && acosDelta < 0.20) {
      notes.push(`Vendas aumentaram ${(salesDelta * 100).toFixed(1)}% com ACoS estável`);
      impact_score = Math.min(100, 60 + salesDelta * 150);
      return { result_status: 'positive', impact_score, success: true, notes };
    }
    // Falha: ACoS piorou muito
    if (acosDelta > 0.30 && after.acos > 0) {
      notes.push(`ACoS piorou ${(acosDelta * 100).toFixed(1)}% após aumento de bid`);
      impact_score = -50;
      return { result_status: 'negative', impact_score, success: false, notes };
    }
    // Falha: impressões caíram (bid ineficaz)
    const impDelta = before.impressions > 0 ? (after.impressions - before.impressions) / before.impressions : 0;
    if (impDelta < -0.50) {
      notes.push(`Impressões caíram ${Math.abs(impDelta * 100).toFixed(1)}% — bid pode estar fora do leilão`);
      impact_score = -20;
      return { result_status: 'negative', impact_score, success: false, notes };
    }
    notes.push('Impacto positivo moderado ou neutro');
    impact_score = 20;
    return { result_status: 'neutral', impact_score, success: salesDelta > 0.05, notes };
  }

  if (isNegative) {
    // Sucesso: gasto reduziu sem queda proporcional de vendas
    const spendDelta = before.spend > 0 ? (after.spend - before.spend) / before.spend : 0;
    const salesDelta = before.sales > 0 ? (after.sales - before.sales) / before.sales : 0;
    if (spendDelta < -0.05 && salesDelta > -0.10) {
      notes.push(`Negativação eliminou gasto irrelevante — spend -${Math.abs(spendDelta * 100).toFixed(1)}%`);
      return { result_status: 'positive', impact_score: 70, success: true, notes };
    }
    if (salesDelta < -0.20) {
      notes.push('Queda de vendas após negativação — termo era relevante');
      return { result_status: 'negative', impact_score: -60, success: false, notes };
    }
    return { result_status: 'neutral', impact_score: 10, success: true, notes };
  }

  return { result_status: 'neutral', impact_score: 0, success: false, notes: ['Tipo de decisão sem avaliação definida'] };
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role) {
      const auth = await base44.auth.isAuthenticated().catch(() => false);
      if (!auth) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    let amazonAccountId = body.amazon_account_id;
    if (!amazonAccountId) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      if (!accs.length) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });
      amazonAccountId = accs[0].id;
    }

    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const yesterday = daysAgo(1);

    // ── 1. Buscar decisões executadas com janela vencida ──────────────────
    // Busca: executadas, com evaluation_due_at no passado, sem outcome final
    const executed = await base44.asServiceRole.entities.OptimizationDecision.filter(
      { amazon_account_id: amazonAccountId, status: 'executed' }, '-executed_at', 500
    );

    const due = executed.filter(d => {
      if (!d.evaluation_due_at) return false;
      if (d.outcome === 'positive' || d.outcome === 'negative') return false; // já avaliada
      return new Date(d.evaluation_due_at as string) <= new Date();
    });

    if (due.length === 0) {
      return Response.json({ ok: true, evaluated: 0, message: 'Nenhuma decisão vencida para avaliar', duration_ms: Date.now() - startTime });
    }

    // ── 2. Carregar métricas diárias para período de comparação ──────────
    const metrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: amazonAccountId }, '-date', 2000
    );

    // Deduplicar
    const metricMap = new Map<string, Record<string, unknown>>();
    for (const m of metrics) {
      const k = `${m.campaign_id}|${m.date}`;
      if (!metricMap.has(k)) metricMap.set(k, m);
    }
    const dedupedMetrics = Array.from(metricMap.values());

    // Índice por campaign_id e data
    const metricsByCampaign: Record<string, Record<string, unknown>[]> = {};
    for (const m of dedupedMetrics) {
      const cid = String(m.campaign_id || '');
      if (!metricsByCampaign[cid]) metricsByCampaign[cid] = [];
      metricsByCampaign[cid].push(m);
    }

    // ── 3. Carregar histórico de performance das regras ───────────────────
    const rulePerfsRaw = await base44.asServiceRole.entities.DecisionRule.filter(
      { amazon_account_id: amazonAccountId }, null, 200
    );
    const rulePerfMap = new Map(rulePerfsRaw.map((r: Record<string, unknown>) => [r.rule_key as string, r]));

    // ── 4. Avaliar cada decisão vencida ───────────────────────────────────
    const stats = { evaluated: 0, positive: 0, neutral: 0, negative: 0, insufficient_data: 0, errors: 0 };
    const ruleAdjustments: Record<string, { success: number; failure: number }> = {};

    for (const decision of due) {
      try {
        const campaignId = String(decision.campaign_id || '');
        const executedAt = String(decision.executed_at || decision.created_at || '');
        if (!campaignId || !executedAt) continue;

        // Definir janela de avaliação
        const evalWindowDays = Number(decision.evaluation_window_hours || 0) > 0
          ? Math.ceil(Number(decision.evaluation_window_hours) / 24)
          : 7;

        const execDate = executedAt.slice(0, 10);
        const beforeStart = addDays(execDate, -evalWindowDays);
        const beforeEnd = addDays(execDate, -1);
        const afterStart = execDate;
        const afterEnd = addDays(execDate, evalWindowDays);

        const campMetrics = metricsByCampaign[campaignId] || [];

        const beforeRows = campMetrics.filter(m => {
          const d = String(m.date || '');
          return d >= beforeStart && d <= beforeEnd;
        });
        const afterRows = campMetrics.filter(m => {
          const d = String(m.date || '');
          return d >= afterStart && d <= afterEnd && d <= yesterday;
        });

        if (afterRows.length === 0) {
          // Ainda sem dados suficientes após — pular por ora
          continue;
        }

        const beforeAgg = aggregate(beforeRows);
        const afterAgg = aggregate(afterRows);

        const decisionType = String(decision.decision_type || decision.action || '');
        const { result_status, impact_score, success, notes } = calcImpact(beforeAgg, afterAgg, decisionType);

        // Salvar outcome na decisão
        await base44.asServiceRole.entities.OptimizationDecision.update(decision.id as string, {
          outcome: result_status,
          impact_score,
          before_metrics: JSON.stringify(beforeAgg),
          after_metrics: JSON.stringify(afterAgg),
          evaluation_notes: notes.join(' | '),
          evaluated_at: now,
        }).catch(() => {});

        // Registrar LearningEvent
        await base44.asServiceRole.entities.LearningEvent.create({
          amazon_account_id: amazonAccountId,
          event_type: 'decision_outcome_evaluated',
          entity_type: String(decision.entity_type || 'keyword'),
          entity_id: String(decision.entity_id || decision.keyword_id || campaignId),
          asin: decision.asin || null,
          keyword: decision.keyword_text || null,
          outcome: result_status,
          source: 'evaluateDecisionOutcomes',
          metadata: JSON.stringify({
            decision_id: decision.id,
            decision_type: decisionType,
            impact_score,
            success,
            notes,
            before: beforeAgg,
            after: afterAgg,
            eval_window_days: evalWindowDays,
          }),
        }).catch(() => {});

        // Acumular ajuste de confiança por regra
        const ruleKey = String(decision.rule_key || decision.source_function || 'unknown');
        if (!ruleAdjustments[ruleKey]) ruleAdjustments[ruleKey] = { success: 0, failure: 0 };
        if (success || result_status === 'positive') ruleAdjustments[ruleKey].success++;
        else if (result_status === 'negative') ruleAdjustments[ruleKey].failure++;

        stats.evaluated++;
        if (result_status === 'positive') stats.positive++;
        else if (result_status === 'negative') stats.negative++;
        else if (result_status === 'insufficient_data') stats.insufficient_data++;
        else stats.neutral++;

      } catch (err) {
        stats.errors++;
        console.warn('[evaluateDecisionOutcomes] erro em decisão', decision.id, (err as Error).message);
      }
    }

    // ── 5. Atualizar times_triggered/times_succeeded nas regras ──────────
    for (const [ruleKey, adj] of Object.entries(ruleAdjustments)) {
      const rule = rulePerfMap.get(ruleKey);
      if (!rule) continue;
      const times_triggered = safe(rule.times_triggered) + adj.success + adj.failure;
      const times_succeeded = safe(rule.times_succeeded) + adj.success;
      await base44.asServiceRole.entities.DecisionRule.update(rule.id as string, {
        times_triggered,
        times_succeeded,
        last_triggered_at: now,
      }).catch(() => {});
    }

    return Response.json({
      ok: true,
      due_count: due.length,
      evaluated: stats.evaluated,
      positive: stats.positive,
      neutral: stats.neutral,
      negative: stats.negative,
      insufficient_data: stats.insufficient_data,
      errors: stats.errors,
      rule_adjustments: Object.keys(ruleAdjustments).length,
      duration_ms: Date.now() - startTime,
    });

  } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
});