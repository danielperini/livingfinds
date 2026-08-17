/**
 * recalibrateKeywordMLModel — Recalibração standalone do modelo
 * A lógica core foi extraída para runCalibrationInline (usada também pelo pipeline v4).
 * Este endpoint mantém a API pública idêntica (mesmo payload, mesmo response).
 * Payload: { amazon_account_id }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── Lógica core de calibração (mesma usada pelo runKeywordMLPipeline v4) ─────
async function runCalibrationInline(
  base44: any,
  amazon_account_id: string,
  modelVersionId: string | null,
  allPreds: any[],
  kwMetrics: Map<string, any>
): Promise<{ updated: number; successful: number; underperforming: number; precision: number; avg_prediction_error: number; calibration_by_tail: any }> {
  const monitoringPreds = allPreds.filter(p => ['monitoring', 'created'].includes(p.status));
  const updates: any[] = [];
  let successful = 0, underperforming = 0;

  for (const pred of monitoringPreds) {
    const actual = kwMetrics.get((pred.keyword || '').toLowerCase());
    if (!actual) continue;
    const hasRealData = (actual.orders || 0) > 0 || (actual.clicks || 0) >= 10;
    if (!hasRealData) continue;

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
  const withOutcome = allPreds.filter(p => ['successful', 'underperforming'].includes(p.status));
  const precision = withOutcome.length > 0
    ? allPreds.filter(p => p.status === 'successful').length / withOutcome.length : 0;
  const avgPredError = withOutcome.length > 0
    ? withOutcome.reduce((s: number, p: any) => s + (p.prediction_error || 0), 0) / withOutcome.length : 0;

  const calibration_by_tail: Record<string, any> = {};
  for (const tail of ['short', 'medium', 'long']) {
    const tailGroup = withOutcome.filter((p: any) => (p.tail_type || 'medium') === tail);
    if (tailGroup.length === 0) continue;
    const successfulTail = tailGroup.filter((p: any) => p.status === 'successful');
    const underperformingTail = tailGroup.filter((p: any) => p.status === 'underperforming');
    const withSales = tailGroup.filter((p: any) => (p.actual_orders || 0) > 0);
    const withAcos = tailGroup.filter((p: any) => (p.actual_acos || 0) > 0 && (p.actual_orders || 0) > 0);
    calibration_by_tail[tail] = {
      count: tailGroup.length,
      precision: Math.round((successfulTail.length / tailGroup.length) * 100) / 100,
      false_positive_rate: Math.round((underperformingTail.length / tailGroup.length) * 100) / 100,
      false_negative_rate: 0,
      conversion_rate: withSales.length > 0 ? Math.round((withSales.reduce((s: number, p: any) => s + (p.actual_conversion_rate || 0), 0) / withSales.length) * 1000) / 1000 : 0,
      avg_acos: withAcos.length > 0 ? Math.round((withAcos.reduce((s: number, p: any) => s + (p.actual_acos || 0), 0) / withAcos.length) * 10) / 10 : null,
      avg_roas: withSales.length > 0 ? Math.round((withSales.reduce((s: number, p: any) => s + (p.actual_roas || 0), 0) / withSales.length) * 100) / 100 : 0,
      avg_orders: withSales.length > 0 ? Math.round((withSales.reduce((s: number, p: any) => s + (p.actual_orders || 0), 0) / withSales.length) * 100) / 100 : 0,
    };
  }

  // Atualizar MLModelVersion com métricas de calibração
  const targetVersionId = modelVersionId;
  if (targetVersionId) {
    try {
      const v = await base44.asServiceRole.entities.MLModelVersion.get(targetVersionId).catch(() => null);
      if (v) {
        let existingWeights: any = {};
        try { existingWeights = JSON.parse(v.weights_json || '{}'); } catch {}
        await base44.asServiceRole.entities.MLModelVersion.update(targetVersionId, {
          total_with_sales: allPreds.filter((p: any) => (p.actual_orders || 0) > 0).length,
          precision: Math.round(precision * 100) / 100,
          conversion_prediction_accuracy: Math.max(0, Math.round((1 - avgPredError) * 100) / 100),
          acos_prediction_error: Math.round(avgPredError * 100) / 100,
          profit_generated: allPreds.filter((p: any) => p.status === 'successful').reduce((s: number, p: any) => s + (p.actual_profit || 0), 0),
          weights_json: JSON.stringify({
            ...existingWeights,
            calibration_by_tail,
            calibration_updated_at: new Date().toISOString(),
          }),
        }).catch(() => {});
      }
    } catch {}
  } else {
    // Fallback: buscar a versão mais recente
    try {
      const versions = await base44.asServiceRole.entities.MLModelVersion.filter({ amazon_account_id }, '-training_date', 1);
      if ((versions as any[]).length > 0) {
        const v = (versions as any[])[0];
        let existingWeights: any = {};
        try { existingWeights = JSON.parse(v.weights_json || '{}'); } catch {}
        await base44.asServiceRole.entities.MLModelVersion.update(v.id, {
          total_with_sales: allPreds.filter((p: any) => (p.actual_orders || 0) > 0).length,
          precision: Math.round(precision * 100) / 100,
          conversion_prediction_accuracy: Math.max(0, Math.round((1 - avgPredError) * 100) / 100),
          acos_prediction_error: Math.round(avgPredError * 100) / 100,
          profit_generated: allPreds.filter((p: any) => p.status === 'successful').reduce((s: number, p: any) => s + (p.actual_profit || 0), 0),
          weights_json: JSON.stringify({
            ...existingWeights,
            calibration_by_tail,
            calibration_updated_at: new Date().toISOString(),
          }),
        }).catch(() => {});
      }
    } catch {}
  }

  return { updated: updates.length, successful, underperforming, precision: Math.round(precision * 100) / 100, avg_prediction_error: Math.round(avgPredError * 100) / 100, calibration_by_tail };
}

// ── HANDLER ───────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id } = body;
    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id obrigatório' }, { status: 400 });

    // Buscar predições e métricas
    const [allPreds, keywords] = await Promise.all([
      base44.asServiceRole.entities.KeywordPrediction.filter({ amazon_account_id }, '-created_at', 500),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id }, '-spend', 500),
    ]);

    // Construir mapa de métricas reais
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

    const result = await runCalibrationInline(base44, amazon_account_id, null, allPreds as any[], kwMetrics);

    return Response.json({
      ok: true,
      monitoring_found: (allPreds as any[]).filter(p => ['monitoring', 'created'].includes(p.status)).length,
      updated: result.updated,
      successful: result.successful,
      underperforming: result.underperforming,
      model_precision: result.precision,
      avg_prediction_error: result.avg_prediction_error,
      calibration_by_tail: result.calibration_by_tail,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err?.message }, { status: 500 });
  }
});