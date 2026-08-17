import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

/**
 * runEndOfDayCpcLearning — Aprendizado de CPC ao final do dia (23:30 BRT)
 *
 * Lê o CPC médio realizado do dia (UnifiedAdsMetricsHourly),
 * compara com target_cpc em PerformanceSettings,
 * e atualiza com suavização: 70% CPC realizado + 30% target anterior.
 * Salva histórico em PerformanceSettingsHistory e log em SyncExecutionLog.
 * Também zera cpc_intraday_override para o dia seguinte.
 */

const r2 = (v: number) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

function brtClock() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)?.value || '';
  return {
    iso: now.toISOString(),
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour') || 0) % 24,
  };
}

Deno.serve(async (request) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));

    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const clock = brtClock();
    const dryRun = body.dry_run === true;

    // Buscar todas as contas conectadas
    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, null, 10);

    if (!accounts.length) return Response.json({ ok: false, error: 'Nenhuma conta conectada' }, { status: 404 });

    const results: any[] = [];

    for (const account of accounts) {
      const accountId = account.id;

      try {
        // 1. Buscar PerformanceSettings
        const perfList = await base44.asServiceRole.entities.PerformanceSettings.filter(
          { amazon_account_id: accountId }, null, 1
        ).catch(() => []);
        const perf = perfList[0];
        if (!perf) { results.push({ accountId, skipped: true, reason: 'Sem PerformanceSettings' }); continue; }

        const previousTargetCpc = Number(perf.target_cpc || 0);

        // 2. Calcular CPC médio realizado hoje (UnifiedAdsMetricsHourly)
        const hourlyMetrics = await base44.asServiceRole.entities.UnifiedAdsMetricsHourly.filter(
          { amazon_account_id: accountId, date: clock.date }, null, 500
        ).catch(() => []);

        let totalSpend = 0;
        let totalClicks = 0;
        for (const m of hourlyMetrics) {
          totalSpend += Number(m.cost || 0);
          totalClicks += Number(m.clicks || 0);
        }

        // Fallback: CampaignMetricsDaily
        if (totalClicks === 0) {
          const dailyMetrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
            { amazon_account_id: accountId, date: clock.date }, null, 500
          ).catch(() => []);
          for (const m of dailyMetrics) {
            totalSpend += Number(m.spend || 0);
            totalClicks += Number(m.clicks || 0);
          }
        }

        const realizedCpc = totalClicks > 0 ? r2(totalSpend / totalClicks) : 0;

        if (realizedCpc === 0) {
          results.push({ accountId, skipped: true, reason: 'Sem dados de cliques hoje', totalSpend, totalClicks });
          continue;
        }

        // 3. Calcular CPC ótimo com suavização: 70% realizado + 30% anterior
        let newTargetCpc = previousTargetCpc;
        let smoothed: number;

        if (previousTargetCpc === 0) {
          // Primeira vez: usar 100% do realizado
          smoothed = realizedCpc;
        } else {
          smoothed = r2(realizedCpc * 0.70 + previousTargetCpc * 0.30);
        }

        // Guardrails: não variar mais que 30% em um dia
        const maxIncrease = previousTargetCpc > 0 ? previousTargetCpc * 1.30 : realizedCpc * 1.50;
        const minDecrease = previousTargetCpc > 0 ? previousTargetCpc * 0.70 : 0;
        newTargetCpc = Math.min(maxIncrease, Math.max(minDecrease, smoothed));
        newTargetCpc = r2(newTargetCpc);

        const changePct = previousTargetCpc > 0 ? ((newTargetCpc - previousTargetCpc) / previousTargetCpc) * 100 : 0;

        // Não atualizar se variação < 1%
        if (Math.abs(changePct) < 1 && previousTargetCpc > 0) {
          results.push({
            accountId, skipped: true,
            reason: `Variação < 1% (${r2(changePct)}%) — sem atualização necessária`,
            realized_cpc: realizedCpc, previous_cpc: previousTargetCpc, new_cpc: newTargetCpc,
          });
          continue;
        }

        if (!dryRun) {
          // 4. Atualizar PerformanceSettings
          await base44.asServiceRole.entities.PerformanceSettings.update(perf.id, {
            target_cpc: newTargetCpc,
            cpc_intraday_override: 0, // Zerar override intraday para o dia seguinte
            updated_at: clock.iso,
          }).catch(() => {});

          // 5. Sincronizar AutopilotConfig
          const apList = await base44.asServiceRole.entities.AutopilotConfig.filter(
            { amazon_account_id: accountId }, null, 1
          ).catch(() => []);
          if (apList[0]) {
            await base44.asServiceRole.entities.AutopilotConfig.update(apList[0].id, {
              target_cpc: newTargetCpc,
              maximum_cpc: newTargetCpc > 0 ? r2(newTargetCpc * 1.30) : apList[0].maximum_cpc,
            }).catch(() => {});
          }

          // 6. Salvar no histórico
          await base44.asServiceRole.entities.PerformanceSettingsHistory.create({
            amazon_account_id: accountId,
            changed_by_id: 'motor_intraday',
            changed_by_name: 'Motor Intraday CPC',
            changed_by_email: '',
            snapshot: {
              target_cpc: newTargetCpc,
              cpc_intraday_override: 0,
              realized_cpc_today: realizedCpc,
              total_spend: r2(totalSpend),
              total_clicks: totalClicks,
              smoothing: '70% realizado + 30% anterior',
            },
            changed_fields: [{
              field: 'target_cpc',
              old_value: previousTargetCpc,
              new_value: newTargetCpc,
            }],
            changed_at: clock.iso,
          }).catch(() => {});

          // 7. Log de execução
          await base44.asServiceRole.entities.SyncExecutionLog.create({
            amazon_account_id: accountId,
            operation: 'cpc_daily_learning',
            trigger_type: 'scheduler',
            status: 'success',
            started_at: new Date(startedAt).toISOString(),
            completed_at: new Date().toISOString(),
            duration_ms: Date.now() - startedAt,
            records_processed: 1,
            result_summary: JSON.stringify({
              date: clock.date,
              realized_cpc: realizedCpc,
              previous_target_cpc: previousTargetCpc,
              new_target_cpc: newTargetCpc,
              change_pct: r2(changePct),
              total_spend: r2(totalSpend),
              total_clicks: totalClicks,
              smoothing_formula: '70/30',
            }),
          }).catch(() => {});
        }

        results.push({
          accountId,
          ok: true,
          dry_run: dryRun,
          date: clock.date,
          realized_cpc: realizedCpc,
          previous_target_cpc: previousTargetCpc,
          new_target_cpc: newTargetCpc,
          change_pct: r2(changePct),
          total_spend: r2(totalSpend),
          total_clicks: totalClicks,
          direction: newTargetCpc > previousTargetCpc ? 'increase' : 'decrease',
        });

      } catch (err: any) {
        results.push({ accountId, ok: false, error: err?.message || 'Erro no aprendizado de CPC' });
      }
    }

    return Response.json({
      ok: true,
      accounts_processed: results.length,
      results,
      duration_ms: Date.now() - startedAt,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro interno' }, { status: 500 });
  }
});