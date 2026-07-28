/**
 * validateDecisionDataScope
 *
 * DATA_SCOPE_GUARDRAIL — Valida se os períodos de dados usados por uma decisão
 * são consistentes entre si. Bloqueia mutações quando há mismatch de janela.
 *
 * Também detecta STRONGLY_IMPROVING trend e ativa PROTECT_RECENT_STRATEGY.
 *
 * Resultados possíveis:
 *  VALID                    — tudo consistente, pode executar
 *  PERIOD_SCOPE_MISMATCH    — janelas incompatíveis (ex: recomendação 14D vs dados 80D)
 *  DATA_SCOPE_MISSING       — campos obrigatórios ausentes
 *  PROTECT_RECENT_STRATEGY  — trend recente muito melhor que histórico → bloquear mudanças baseadas em dado antigo
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const STRONGLY_IMPROVING_ACOS_14D_MAX = 16;   // 14D ACoS <= 16%
const STRONGLY_IMPROVING_ACOS_80D_MIN = 22;   // 80D ACoS >= 22%
const PERIOD_MISMATCH_TOLERANCE_DAYS = 7;     // tolerância de 7 dias entre janelas

function daysFromWindow(windowStr: string): number | null {
  if (!windowStr) return null;
  const m = windowStr.match(/(\d+)[dD]/);
  return m ? parseInt(m[1]) : null;
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const {
      amazon_account_id,
      metric_window,          // ex: "14D", "28D", "80D"
      recommendation_window,  // ex: "14D" (janela Amazon)
      attribution_window,     // ex: "7D" (atribuição de pedidos)
      decision_window,        // ex: "14D" (o que o motor considerou recente)
      baseline_window,        // ex: "28D" (comparativo histórico)
      decision_type,          // para contextualizar o log
      skip_recency_check = false,
    } = body;

    if (!amazon_account_id) {
      return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });
    }

    const now = new Date().toISOString();
    const result: any = {
      ok: true,
      amazon_account_id,
      decision_type: decision_type || 'unknown',
      metric_window,
      recommendation_window,
      attribution_window,
      decision_window,
      baseline_window,
      data_scope_status: 'VALID',
      recency_protection_active: false,
      blocked: false,
      reason: null,
      duration_ms: 0,
    };

    // ── 1. Verificar campos obrigatórios ───────────────────────────────
    const requiredFields = { metric_window, decision_window, baseline_window };
    const missingFields = Object.entries(requiredFields)
      .filter(([, v]) => !v)
      .map(([k]) => k);

    if (missingFields.length > 0) {
      result.data_scope_status = 'DATA_SCOPE_MISSING';
      result.blocked = true;
      result.reason = `Campos obrigatórios ausentes: ${missingFields.join(', ')}`;
      result.duration_ms = Date.now() - t0;
      return Response.json(result);
    }

    // ── 2. Verificar mismatch de janelas ───────────────────────────────
    const metricDays = daysFromWindow(metric_window);
    const decisionDays = daysFromWindow(decision_window);
    const baselineDays = daysFromWindow(baseline_window);
    const recoDays = recommendation_window ? daysFromWindow(recommendation_window) : null;

    // metric_window e decision_window devem ser compatíveis (delta <= 7 dias)
    if (metricDays !== null && decisionDays !== null) {
      const delta = Math.abs(metricDays - decisionDays);
      if (delta > PERIOD_MISMATCH_TOLERANCE_DAYS) {
        result.data_scope_status = 'PERIOD_SCOPE_MISMATCH';
        result.blocked = true;
        result.reason = `Mismatch: metric_window=${metric_window} vs decision_window=${decision_window} (delta=${delta}d > tolerância ${PERIOD_MISMATCH_TOLERANCE_DAYS}d)`;
        result.duration_ms = Date.now() - t0;
        return Response.json(result);
      }
    }

    // recommendation_window e decision_window — se recommendation usa janela mais antiga que decision, bloquear
    if (recoDays !== null && decisionDays !== null && recoDays > decisionDays + PERIOD_MISMATCH_TOLERANCE_DAYS) {
      result.data_scope_status = 'PERIOD_SCOPE_MISMATCH';
      result.blocked = true;
      result.reason = `Recomendação usa janela ${recommendation_window} mais antiga que decisão ${decision_window} — pode contaminar com dado histórico`;
      result.duration_ms = Date.now() - t0;
      return Response.json(result);
    }

    // ── 3. RECENCY PROTECTION — verificar STRONGLY_IMPROVING ──────────
    if (!skip_recency_check) {
      // Buscar último PerformanceTrendSnapshot
      const snapshots = await base44.asServiceRole.entities.PerformanceTrendSnapshot.filter(
        { amazon_account_id },
        '-snapshot_date',
        1
      ).catch(() => []);

      const snap = snapshots[0];

      if (snap) {
        const acos14d = Number(snap.acos_14d || 0);
        const acos80d = Number(snap.acos_80d || 0);

        const stronglyImproving = (
          acos14d > 0 &&
          acos80d > 0 &&
          acos14d <= STRONGLY_IMPROVING_ACOS_14D_MAX &&
          acos80d >= STRONGLY_IMPROVING_ACOS_80D_MIN
        );

        if (stronglyImproving) {
          result.recency_protection_active = true;
          result.trend_classification = 'STRONGLY_IMPROVING';
          result.acos_14d = acos14d;
          result.acos_80d = acos80d;

          // Se a decisão usa dados de janela longa (>21D) E é um BID_DOWN ou PAUSE → bloquear
          const isLongWindowDecision = metricDays !== null && metricDays > 21;
          const isDestructiveAction = ['BID_DOWN_ACOS', 'BID_DOWN_CVR', 'NO_SALES_HARD', 'pause_campaign', 'bid_decrease'].includes(decision_type || '');

          if (isLongWindowDecision && isDestructiveAction) {
            result.data_scope_status = 'PROTECT_RECENT_STRATEGY';
            result.blocked = true;
            result.reason = `RECENCY PROTECTION: ACoS 14D=${acos14d.toFixed(1)}% vs 80D=${acos80d.toFixed(1)}% — trend STRONGLY_IMPROVING. Decisão baseada em janela ${metric_window} foi bloqueada para preservar performance recente.`;
            result.duration_ms = Date.now() - t0;
            return Response.json(result);
          }
        }

        result.trend_classification = snap.trend_classification || 'INSUFFICIENT_DATA';
        result.acos_14d = snap.acos_14d;
        result.acos_80d = snap.acos_80d;
      } else {
        result.trend_classification = 'INSUFFICIENT_DATA';
      }
    }

    result.duration_ms = Date.now() - t0;
    return Response.json(result);

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message, data_scope_status: 'DATA_SCOPE_MISSING', blocked: true, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});