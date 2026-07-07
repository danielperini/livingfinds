/**
 * recalibrateKeywordMLModel — Recalibração semanal do modelo
 * Compara previsões com resultados reais e atualiza feedback.
 * Payload: { amazon_account_id }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id } = body;
    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id obrigatório' }, { status: 400 });

    // Buscar predições com status monitoring/created
    const [monitoringPreds, keywords, searchTerms] = await Promise.all([
      base44.asServiceRole.entities.KeywordPrediction.filter({ amazon_account_id, status: { $in: ['monitoring', 'created'] } }, '-created_at', 300),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id }, '-spend', 500),
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id }, '-orders_14d', 500),
    ]);

    // Map de keyword text → métricas reais
    const kwMetrics = new Map<string, any>();
    for (const kw of keywords as any[]) {
      const text = (kw.keyword_text || kw.keyword || '').toLowerCase();
      if (!text) continue;
      const cur = kwMetrics.get(text) || { clicks: 0, spend: 0, orders: 0, sales: 0, impressions: 0 };
      cur.clicks += Number(kw.clicks || 0);
      cur.spend += Number(kw.spend || 0);
      cur.orders += Number(kw.orders || 0);
      cur.sales += Number(kw.sales || 0);
      cur.impressions += Number(kw.impressions || 0);
      kwMetrics.set(text, cur);
    }

    let updated = 0, successful = 0, underperforming = 0;
    const updates: any[] = [];

    for (const pred of monitoringPreds as any[]) {
      const actual = kwMetrics.get((pred.keyword || '').toLowerCase());
      if (!actual) continue;

      const actualConvRate = actual.clicks > 0 ? actual.orders / actual.clicks : 0;
      const actualAcos = actual.sales > 0 ? (actual.spend / actual.sales) * 100 : 0;
      const actualRoas = actual.spend > 0 ? actual.sales / actual.spend : 0;
      const predError = Math.abs((pred.conversion_probability || 0) - actualConvRate);

      const isSuccessful = actual.orders >= 1 && (actualAcos <= (pred.expected_acos || 35) * 1.3 || actualRoas >= (pred.expected_roas || 2) * 0.7);
      const isUnderperforming = actual.clicks >= 10 && actual.orders === 0;

      updates.push({
        id: pred.id,
        actual_orders: actual.orders,
        actual_sales: actual.sales,
        actual_conversion_rate: actualConvRate,
        actual_acos: actualAcos,
        actual_roas: actualRoas,
        prediction_error: Math.round(predError * 100) / 100,
        outcome_status: isSuccessful ? 'successful' : isUnderperforming ? 'underperforming' : 'monitoring',
        status: isSuccessful ? 'successful' : isUnderperforming ? 'underperforming' : pred.status,
      });

      if (isSuccessful) successful++;
      if (isUnderperforming) underperforming++;
      updated++;
    }

    // Atualizar em lotes
    for (let i = 0; i < updates.length; i += 20) {
      const batch = updates.slice(i, i + 20);
      await Promise.all(batch.map((u: any) => {
        const { id, ...data } = u;
        return base44.asServiceRole.entities.KeywordPrediction.update(id, data).catch(() => {});
      }));
      if (i + 20 < updates.length) await new Promise(r => setTimeout(r, 200));
    }

    // Calcular métricas do modelo
    const allPreds = await base44.asServiceRole.entities.KeywordPrediction.filter({ amazon_account_id }, '-created_at', 500);
    const withOutcome = (allPreds as any[]).filter(p => ['successful', 'underperforming'].includes(p.status));
    const precision = withOutcome.length > 0 ? (allPreds as any[]).filter(p => p.status === 'successful').length / withOutcome.length : 0;
    const avgPredError = withOutcome.length > 0
      ? withOutcome.reduce((s: number, p: any) => s + (p.prediction_error || 0), 0) / withOutcome.length : 0;

    // Buscar versão atual e atualizar métricas
    const versions = await base44.asServiceRole.entities.MLModelVersion.filter({ amazon_account_id }, '-training_date', 1);
    if ((versions as any[]).length > 0) {
      const v = (versions as any[])[0];
      await base44.asServiceRole.entities.MLModelVersion.update(v.id, {
        total_with_sales: (allPreds as any[]).filter(p => p.actual_orders > 0).length,
        precision: Math.round(precision * 100) / 100,
        conversion_prediction_accuracy: Math.max(0, Math.round((1 - avgPredError) * 100) / 100),
        acos_prediction_error: Math.round(avgPredError * 100) / 100,
        profit_generated: (allPreds as any[]).filter(p => p.status === 'successful').reduce((s: number, p: any) => s + (p.actual_profit || 0), 0),
      }).catch(() => {});
    }

    return Response.json({
      ok: true,
      monitoring_found: (monitoringPreds as any[]).length,
      updated, successful, underperforming,
      model_precision: Math.round(precision * 100) / 100,
      avg_prediction_error: Math.round(avgPredError * 100) / 100,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err?.message }, { status: 500 });
  }
});