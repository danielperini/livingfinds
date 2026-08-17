import {
  aggregateIntradaySnapshots,
  buildPacingCurve,
  expectedFraction,
  pacingClassification,
  readConfirmedTodaySpend,
  resolveDailyCap,
} from './portfolioBudgetMath.ts';

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test('usa PerformanceSettings como fonte canônica do teto', () => {
  const result = resolveDailyCap({ daily_budget_limit: 115 }, { total_daily_budget: 80 }, {});
  assert(result.cap === 115, `cap esperado 115, recebido ${result.cap}`);
  assert(result.source === 'PerformanceSettings.daily_budget_limit', `fonte inesperada ${result.source}`);
});

Deno.test('fallback diário é R$ 115 sem sobrescrever configuração positiva', () => {
  const fallback = resolveDailyCap({}, {}, {});
  const configured = resolveDailyCap({}, { total_daily_budget: 90 }, {});
  assert(fallback.cap === 115, `fallback esperado 115, recebido ${fallback.cap}`);
  assert(configured.cap === 90, `configuração positiva deveria ser preservada, recebido ${configured.cap}`);
});

Deno.test('controller do dia prevalece sobre PerformanceSettings', () => {
  const result = resolveDailyCap(
    { daily_budget_limit: 80 },
    { total_daily_budget: 70 },
    { max_daily_budget_limit: 60 },
    { effective_daily_spend_cap: 115, user_daily_spend_cap: 115 },
  );
  assert(result.cap === 115, `controller deveria preservar 115, recebido ${result.cap}`);
  assert(result.source === 'AccountDailySpendController.effective_daily_spend_cap', `fonte inesperada ${result.source}`);
});

Deno.test('target bloqueado prevalece sobre demais campos do autopilot', () => {
  const result = resolveDailyCap({}, {
    daily_budget_locked: true,
    daily_budget_target: 115,
    total_daily_budget: 200,
  }, {});
  assert(result.cap === 115, `target bloqueado deveria ser 115, recebido ${result.cap}`);
});

Deno.test('curva cumulativa termina em 100%', () => {
  const curve = buildPacingCurve([], 1);
  assert(curve.curve['23'].cumulative_pct === 100, 'curva deve terminar em 100%');
  const noon = expectedFraction(curve.weights, 12 * 60);
  assert(noon > 0.20 && noon < 0.60, `acumulado ao meio-dia fora da faixa: ${noon}`);
});

Deno.test('snapshot cumulativo usa o lote mais recente e estima atraso', () => {
  const now = Date.now();
  const rows = [
    { report_id: 'old', campaign_id: '1', spend: 10, observed_at: new Date(now - 120 * 60_000).toISOString(), source: 'AMAZON_ADS_SAME_DAY_REPORT' },
    { report_id: 'new', campaign_id: '1', spend: 20, observed_at: new Date(now - 30 * 60_000).toISOString(), source: 'AMAZON_ADS_SAME_DAY_REPORT' },
  ];
  const result = aggregateIntradaySnapshots(rows, now);
  assert(result.available === true, 'snapshot recente deveria estar disponível');
  assert(result.confirmedSpend === 20, `gasto confirmado esperado 20, recebido ${result.confirmedSpend}`);
  assert(result.estimatedCurrentSpend >= 20, 'estimativa atual não pode ser menor que o confirmado');
});

Deno.test('gasto confirmado de hoje ignora agregado de campanha', () => {
  const now = Date.now();
  const result = readConfirmedTodaySpend({
    spendDate: '2026-07-28',
    nowMs: now,
    snapshots: [{
      spend_date: '2026-07-28',
      report_id: 'today',
      campaign_id: '1',
      spend: 50,
      observed_at: new Date(now - 10 * 60_000).toISOString(),
    }],
  });
  assert(result.confirmedSpend === 50, `deveria usar gasto intradiário R$ 50, recebido ${result.confirmedSpend}`);
});

Deno.test('dado intradiário acima de 60 minutos é stale e bloqueia ação', () => {
  const now = Date.now();
  const result = readConfirmedTodaySpend({
    spendDate: '2026-07-28',
    nowMs: now,
    snapshots: [{
      spend_date: '2026-07-28',
      report_id: 'stale',
      campaign_id: '1',
      spend: 50,
      observed_at: new Date(now - 61 * 60_000).toISOString(),
    }],
  });
  assert(result.available === false, 'snapshot stale não pode liberar escrita');
  assert(result.stale === true, 'snapshot deveria estar marcado stale');
  assert(result.confidence === 'low', 'snapshot stale deveria ter baixa confiança');
});

Deno.test('hard cap tem prioridade sobre underpacing', () => {
  const status = pacingClassification(0.5, 112, 111.55, 120, 115);
  assert(status === 'critical_overpacing', `status esperado critical_overpacing, recebido ${status}`);
});
