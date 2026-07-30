/**
 * runAcosTrendMonitor
 *
 * Calcula a evolução do ACoS nos últimos 15d e 30d a partir de CampaignMetricsDaily,
 * classifica a tendência, cria/resolve Alerts e dispara ação corretiva automática
 * se ai_auto_optimization=true no AutopilotConfig.
 *
 * Idempotente: verifica SyncExecutionLog do dia para evitar execução duplicada.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

function r2(v) { return parseFloat((Number(v) || 0).toFixed(2)); }

function classifyTrend(delta) {
  if (delta > 20)  return 'STRONGLY_DEGRADING';
  if (delta > 10)  return 'DEGRADING';
  if (delta < -20) return 'STRONGLY_IMPROVING';
  if (delta < -10) return 'IMPROVING';
  return 'STABLE';
}

// Agrupa registros de CampaignMetricsDaily por data e retorna ACoS da janela
// acos = SUM(spend) / SUM(sales) * 100
function calcWindowAcos(records, fromDate, toDate) {
  const byDate = {};
  for (const r of records) {
    const d = (r.date || '').slice(0, 10);
    if (d < fromDate || d > toDate) continue;
    if (!byDate[d]) byDate[d] = { spend: 0, sales: 0 };
    byDate[d].spend += Number(r.spend) || 0;
    byDate[d].sales += Number(r.sales) || 0;
  }
  const dates = Object.keys(byDate);
  const daysWithSales = dates.filter(d => byDate[d].sales > 0);
  const totalSpend = dates.reduce((s, d) => s + byDate[d].spend, 0);
  const totalSales = dates.reduce((s, d) => s + byDate[d].sales, 0);
  return {
    acos: totalSales > 0 ? r2(totalSpend / totalSales * 100) : null,
    days_with_sales: daysWithSales.length,
    total_spend: r2(totalSpend),
    total_sales: r2(totalSales),
    days_total: dates.length,
  };
}

function dateOffset(baseDate, daysBack) {
  const d = new Date(baseDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d.toISOString().slice(0, 10);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    const body = await req.json().catch(() => ({}));

    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const { amazon_account_id } = body;

    // Resolver conta
    let account;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
      account = accs[0];
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({}, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });

    const accountId = account.id;
    const now = new Date().toISOString();
    // Data BRT (UTC-3)
    const todayBRT = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);

    // ── IDEMPOTÊNCIA: verificar se já rodou hoje ──
    const logsToday = await base44.asServiceRole.entities.SyncExecutionLog.filter({
      amazon_account_id: accountId,
      operation: 'acos_trend_monitor',
      execution_date: todayBRT,
    }, '-started_at', 1).catch(() => []);

    if (logsToday.length > 0 && logsToday[0].status === 'success') {
      return Response.json({
        ok: true,
        skipped: true,
        reason: 'already_ran_today',
        execution_date: todayBRT,
        previous_run: logsToday[0].started_at,
      });
    }

    // ── Buscar 33 dias de CampaignMetricsDaily (30d janela + 3d buffer) ──
    const startDate = dateOffset(todayBRT, 33);
    const endDate   = dateOffset(todayBRT, 1); // excluir hoje (dados incompletos)

    const metrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: accountId }, null, 500
    ).catch(() => []);

    // Filtrar apenas no range necessário
    const inRange = metrics.filter(m => {
      const d = (m.date || '').slice(0, 10);
      return d >= startDate && d <= endDate;
    });

    // Janelas:
    // 15d: últimos 15 dias (ontem - 14 dias)
    const w15start = dateOffset(todayBRT, 15);
    const w15end   = endDate;
    // 30d: últimos 30 dias
    const w30start = dateOffset(todayBRT, 30);
    const w30end   = endDate;

    const win15 = calcWindowAcos(inRange, w15start, w15end);
    const win30 = calcWindowAcos(inRange, w30start, w30end);

    const MIN_DAYS_WITH_SALES = 7;
    const hasSufficientData = win15.days_with_sales >= MIN_DAYS_WITH_SALES && win30.days_with_sales >= MIN_DAYS_WITH_SALES;

    let trendClassification = 'INSUFFICIENT_DATA';
    let trendDelta = null;

    if (hasSufficientData && win15.acos !== null && win30.acos !== null && win30.acos > 0) {
      trendDelta = r2((win15.acos - win30.acos) / win30.acos * 100);
      trendClassification = classifyTrend(trendDelta);
    }

    // ── Buscar/criar PerformanceTrendSnapshot do dia ──
    const snapshots = await base44.asServiceRole.entities.PerformanceTrendSnapshot.filter({
      amazon_account_id: accountId,
    }, '-snapshot_date', 1).catch(() => []);

    const todaySnapshot = snapshots.find(s => (s.snapshot_date || '').slice(0, 10) === todayBRT);

    const snapshotPayload = {
      amazon_account_id: accountId,
      snapshot_date: todayBRT,
      acos_15d: win15.acos,
      acos_30d: win30.acos,
      spend_14d: win15.total_spend,  // compatibilidade
      orders_14d: null,               // não calculado aqui
      trend_classification: trendClassification,
      trend_delta_14d_vs_80d: trendDelta, // campo existente reutilizado para 15d vs 30d
      account_acos_14d: win15.acos,
      updated_at: now,
    };

    if (todaySnapshot) {
      await base44.asServiceRole.entities.PerformanceTrendSnapshot.update(todaySnapshot.id, snapshotPayload).catch(() => {});
    } else {
      await base44.asServiceRole.entities.PerformanceTrendSnapshot.create({
        ...snapshotPayload,
        created_at: now,
      }).catch(() => {});
    }

    // ── Atualizar trend_classification no AccountDailySpendController do dia ──
    const controllers = await base44.asServiceRole.entities.AccountDailySpendController.filter({
      amazon_account_id: accountId,
      spend_date: todayBRT,
    }, null, 1).catch(() => []);
    if (controllers[0]) {
      await base44.asServiceRole.entities.AccountDailySpendController.update(controllers[0].id, {
        trend_classification: trendClassification,
        acos_14d_at_last_check: win15.acos || 0,
        updated_at: now,
      }).catch(() => {});
    }

    // ── Gestão de Alertas ──
    let alertCreated = false;
    const dedupKey = `acos_trend_degrading:${accountId}:${todayBRT}`;

    const isDegrading = trendClassification === 'DEGRADING' || trendClassification === 'STRONGLY_DEGRADING';
    const isImproving = trendClassification === 'IMPROVING' || trendClassification === 'STRONGLY_IMPROVING';

    if (isDegrading && hasSufficientData) {
      // Verificar se já existe alerta ativo com este dedup key hoje
      const existingAlerts = await base44.asServiceRole.entities.Alert.filter({
        amazon_account_id: accountId,
        alert_type: 'high_acos',
        deduplication_key: dedupKey,
        status: 'active',
      }, null, 1).catch(() => []);

      if (existingAlerts.length === 0) {
        const severity = trendClassification === 'STRONGLY_DEGRADING' ? 'high' : 'medium';
        await base44.asServiceRole.entities.Alert.create({
          amazon_account_id: accountId,
          alert_type: 'high_acos',
          alert_family: 'performance',
          severity,
          status: 'active',
          entity_type: 'account',
          title: `ACoS em degradação (${trendClassification})`,
          message: `ACoS 15d: ${win15.acos}% vs ACoS 30d: ${win30.acos}% — variação: ${trendDelta > 0 ? '+' : ''}${trendDelta?.toFixed(1)}%. Tendência: ${trendClassification}.`,
          details: JSON.stringify({ acos_15d: win15.acos, acos_30d: win30.acos, delta_pct: trendDelta, days_15d: win15.days_with_sales, days_30d: win30.days_with_sales }),
          metric_name: 'acos_trend',
          metric_value: win15.acos,
          threshold_value: win30.acos,
          deduplication_key: dedupKey,
          first_detected_at: now,
          last_detected_at: now,
          cooldown_until: new Date(Date.now() + 24 * 3600000).toISOString(),
          source_function: 'runAcosTrendMonitor',
          created_at: now,
        }).catch(() => {});
        alertCreated = true;
      }
    }

    if (isImproving) {
      // Resolver alertas ativos de degradação de ACoS desta conta
      const activeAlerts = await base44.asServiceRole.entities.Alert.filter({
        amazon_account_id: accountId,
        alert_type: 'high_acos',
        status: 'active',
      }, null, 20).catch(() => []);
      const trendAlerts = activeAlerts.filter(a => (a.source_function || '') === 'runAcosTrendMonitor' || (a.deduplication_key || '').includes('acos_trend_degrading'));
      for (const a of trendAlerts) {
        await base44.asServiceRole.entities.Alert.update(a.id, {
          status: 'resolved',
          resolved_at: now,
          resolution_reason: `ACoS em melhora: ${trendClassification} (delta ${trendDelta?.toFixed(1)}%)`,
        }).catch(() => {});
      }
    }

    // ── Ação automática corretiva ──
    let autoActionTriggered = false;
    if (isDegrading && hasSufficientData) {
      // Verificar AutopilotConfig
      const apCfgs = await base44.asServiceRole.entities.AutopilotConfig.filter({
        amazon_account_id: accountId,
      }, null, 1).catch(() => []);
      const aiAutoOptimization = apCfgs[0]?.ai_auto_optimization === true;

      if (aiAutoOptimization) {
        // Idempotência: verificar se já disparou ação automática hoje via SyncExecutionLog
        const autoActionLogs = await base44.asServiceRole.entities.SyncExecutionLog.filter({
          amazon_account_id: accountId,
          operation: 'acos_trend_shadow_signal',
          execution_date: todayBRT,
        }, null, 1).catch(() => []);

        if (autoActionLogs.length === 0) {
          await base44.asServiceRole.entities.SyncExecutionLog.create({
            amazon_account_id: accountId,
            operation: 'acos_trend_shadow_signal',
            status: 'skipped',
            trigger_type: 'observe_only',
            execution_date: todayBRT,
            started_at: now,
            completed_at: now,
            result_summary: 'Tendência degradante registrada; escrita delegada exclusivamente ao motor canônico.',
          }).catch(() => {});

          // Observe-only: o monitor não pode disparar um motor de redução
          // paralelo. O próximo ciclo canônico consumirá o alerta e os dados.
        }
      }
    }

    // ── SyncExecutionLog final ──
    const summary = [
      `acos_15d=${win15.acos ?? 'n/a'}%`,
      `acos_30d=${win30.acos ?? 'n/a'}%`,
      `delta=${trendDelta != null ? (trendDelta > 0 ? '+' : '') + trendDelta.toFixed(1) + '%' : 'n/a'}`,
      `trend=${trendClassification}`,
      `alerta=${alertCreated ? 'criado' : 'não'}`,
      `auto_action=${autoActionTriggered ? 'disparado' : 'não'}`,
      `days_15d=${win15.days_with_sales}`,
      `days_30d=${win30.days_with_sales}`,
    ].join(' | ');

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'acos_trend_monitor',
      status: 'success',
      trigger_type: body.trigger || 'automatic',
      execution_date: todayBRT,
      started_at: now,
      completed_at: new Date().toISOString(),
      result_summary: summary,
    }).catch(() => {});

    return Response.json({
      ok: true,
      acos_15d: win15.acos,
      acos_30d: win30.acos,
      trend_delta_pct: trendDelta,
      trend_classification: trendClassification,
      sufficient_data: hasSufficientData,
      days_with_sales_15d: win15.days_with_sales,
      days_with_sales_30d: win30.days_with_sales,
      alert_created: alertCreated,
      auto_action_triggered: autoActionTriggered,
      campaigns_evaluated: inRange.length,
      spend_date: todayBRT,
    });

  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});
