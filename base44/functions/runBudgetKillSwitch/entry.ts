/**
 * runBudgetKillSwitch — v2
 *
 * Correções PRD:
 * 1. dailyBudget lido de PerformanceSettings.daily_budget_limit como fonte primária
 * 2. confirmedSpend calculado de CampaignMetricsDaily (data BRT atual), fallback Campaign.spend
 * 3. Threshold = dailyBudget × 0.97 (não 0.975 nem dynamic buffer)
 * 4. Recovery: se kill_switch ativo MAS confirmed_spend < dailyBudget × 0.80 → reset automático
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function r2(v: any) { return parseFloat((v || 0).toFixed(2)); }

const MANUAL_STOP_REASONS = ['USER_MANUAL', 'STOCK_ZERO', 'ABOVE_BREAK_EVEN', 'NO_SALES_HARD', 'LISTING_BLOCKED', 'POLICY', 'LOW_INTENT', 'CONFIGURATION_ERROR'];

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, force_check = false } = body;

    // Resolver conta
    let account: any;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
      account = accs[0];
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({}, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta configurada' }, { status: 404 });

    const accountId = account.id;
    const now = new Date().toISOString();
    const brtDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const todayBRT = brtDate.toISOString().slice(0, 10);
    const currentHourBRT = brtDate.getHours();

    // ── 1. Carregar controller atual do dia ──
    const controllers = await base44.asServiceRole.entities.AccountDailySpendController.filter(
      { amazon_account_id: accountId, spend_date: todayBRT }, null, 1
    ).catch(() => [] as any[]);
    const controller = controllers[0];

    // ── Cap: effective_daily_spend_cap do controller (fonte primária) → PerformanceSettings → default ──
    let dailyBudget = 70;
    if (controller?.effective_daily_spend_cap > 0) {
      dailyBudget = Number(controller.effective_daily_spend_cap);
    } else {
      try {
        const psList = await base44.asServiceRole.entities.PerformanceSettings.filter(
          { amazon_account_id: accountId }, '-updated_at', 1
        );
        if (psList[0]?.daily_budget_limit > 0) dailyBudget = Number(psList[0].daily_budget_limit);
      } catch {}
    }

    // ── 2. Calcular gasto confirmado via CampaignMetricsDaily (data BRT) ──
    const metricsToday = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: accountId, date: todayBRT }, null, 500
    ).catch(() => [] as any[]);

    let confirmedSpend = 0;
    let spendSource = 'metrics_daily';

    if (metricsToday.length > 0) {
      confirmedSpend = metricsToday.reduce((s: number, m: any) => s + Number(m.spend || 0), 0);
    } else {
      // Fallback: Campaign.current_spend (gasto diário do sync de API — NUNCA Campaign.spend que é acumulado 30d)
      const campaigns = await base44.asServiceRole.entities.Campaign.filter(
        { amazon_account_id: accountId }, null, 500
      ).catch(() => [] as any[]);
      confirmedSpend = campaigns.reduce((s: number, c: any) => s + Number(c.current_spend || 0), 0);
      spendSource = 'campaign_spend_fallback';
    }

    // Se fallback e confirmedSpend=0, não há dados diários confiáveis → não acionar kill switch
    if (spendSource === 'campaign_spend_fallback' && confirmedSpend === 0) {
      return Response.json({ ok: true, skipped: true, reason: 'no_daily_spend_data', confirmed_spend: 0, daily_budget: dailyBudget, duration_ms: Date.now() - t0 });
    }

    // ── 3. Threshold = 97% do cap ──
    const threshold = r2(dailyBudget * 0.97);
    const recoveryThreshold = r2(dailyBudget * 0.80);

    // ── 4. Recovery automático do kill switch ──
    if (controller?.global_kill_switch && !force_check) {
      if (confirmedSpend < recoveryThreshold) {
        // Resetar kill switch — gasto voltou abaixo de 80%
        await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
          global_kill_switch: false,
          global_stop_event_id: null,
          kill_switch_reason: `Recovery automático: R$${r2(confirmedSpend)} < 80% do cap (R$${r2(recoveryThreshold)})`,
          confirmed_spend: r2(confirmedSpend),
          cap_status: 'safe',
          last_kill_switch_check_at: now,
          updated_at: now,
        }).catch(() => {});

        // Reativar campanhas pausadas EXCLUSIVAMENTE por DAILY_BUDGET_CAP_REACHED
        const pausedCamps = await base44.asServiceRole.entities.Campaign.filter(
          { amazon_account_id: accountId, last_pause_reason: 'DAILY_BUDGET_CAP_REACHED' }, null, 200
        ).catch(() => [] as any[]);

        let reactivated = 0;
        for (let i = 0; i < pausedCamps.length; i += 20) {
          const batch = pausedCamps.slice(i, i + 20).map((c: any) => ({
            campaignId: String(c.amazon_campaign_id || c.campaign_id),
            state: 'ENABLED',
          })).filter((p: any) => p.campaignId && p.campaignId !== 'undefined');
          if (!batch.length) continue;
          await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
            _service_role: true,
            amazon_account_id: accountId,
            path: '/sp/campaigns',
            method: 'PUT',
            content_type: 'application/vnd.spCampaign.v3+json',
            payload: { campaigns: batch },
          }).catch(() => {});
          for (const c of pausedCamps.slice(i, i + 20)) {
            await base44.asServiceRole.entities.Campaign.update(c.id, {
              status: 'enabled',
              state: 'enabled',
              last_pause_reason: null,
              archive_reason: null,
            }).catch(() => {});
            reactivated++;
          }
          await sleep(300);
        }

        return Response.json({
          ok: true,
          action: 'kill_switch_reset',
          confirmed_spend: r2(confirmedSpend),
          recovery_threshold: r2(recoveryThreshold),
          daily_budget: dailyBudget,
          reactivated_campaigns: reactivated,
          duration_ms: Date.now() - t0,
        });
      }

      // Kill switch ainda ativo — gasto ainda alto
      return Response.json({
        ok: true,
        kill_switch_active: true,
        reason: 'Kill Switch ativo e gasto ainda acima de 80% do cap',
        confirmed_spend: r2(confirmedSpend),
        recovery_threshold: r2(recoveryThreshold),
        daily_budget: dailyBudget,
        activated_at: controller.kill_switch_activated_at,
        duration_ms: Date.now() - t0,
      });
    }

    if (!controller) {
      return Response.json({ ok: true, skipped: true, reason: 'Sem controller para hoje — rode runDailyBudgetPacingEngine primeiro' });
    }

    // ── Carregar campanhas para pausa ──
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: accountId }, null, 500
    ).catch(() => [] as any[]);

    const activeCampaigns = allCampaigns.filter((c: any) => {
      const s = (c.state || c.status || '').toLowerCase();
      return s === 'enabled' || s === 'active';
    });

    const totalBudgetNominal = allCampaigns.reduce((s: number, c: any) => s + Number(c.daily_budget || 0), 0);
    const spendVelocity = Number(controller.spend_velocity_per_hour || 0);

    // Estimativa de gasto não reportado
    const estimatedUnreported = spendVelocity > 0
      ? spendVelocity * 0.25
      : confirmedSpend * 0.05;

    const totalProjected = r2(confirmedSpend + estimatedUnreported);

    // ── Verificar se deve ativar Kill Switch ──
    const shouldActivate = totalProjected >= threshold;

    if (!shouldActivate) {
      const utilizationPct = dailyBudget > 0 ? confirmedSpend / dailyBudget * 100 : 0;
      let capStatus = 'safe';
      if (utilizationPct >= 100) capStatus = 'cap_reached';
      else if (utilizationPct >= 95) capStatus = 'cap_imminent';
      else if (utilizationPct >= 85) capStatus = 'critical';
      else if (utilizationPct >= 70) capStatus = 'attention';

      await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
        confirmed_spend: r2(confirmedSpend),
        estimated_pending_spend: r2(estimatedUnreported),
        projected_total_spend: totalProjected,
        remaining_spend: r2(Math.max(0, dailyBudget - totalProjected)),
        cap_status: capStatus,
        user_daily_spend_cap: dailyBudget,
        effective_daily_spend_cap: dailyBudget,
        spend_velocity_per_hour: r2(spendVelocity),
        total_campaign_budget_nominal: r2(totalBudgetNominal),
        last_kill_switch_check_at: now,
        updated_at: now,
      }).catch(() => {});

      return Response.json({
        ok: true,
        kill_switch_activated: false,
        confirmed_spend: r2(confirmedSpend),
        spend_source: spendSource,
        threshold: r2(threshold),
        daily_budget: dailyBudget,
        cap_status: capStatus,
        duration_ms: Date.now() - t0,
      });
    }

    // ── ATIVAR KILL SWITCH ──
    // Idempotência: por dia + hora BRT
    const eventId = `killswitch:${accountId}:${todayBRT}:${currentHourBRT}`;
    if (controller.global_stop_event_id === eventId) {
      return Response.json({
        ok: true,
        kill_switch_activated: false,
        skipped_idempotent: true,
        event_id: eventId,
        reason: 'Kill Switch já executado nesta hora',
        duration_ms: Date.now() - t0,
      });
    }

    // Snapshot do estado atual
    const snapshot: Record<string, string> = {};
    for (const c of activeCampaigns) {
      const campId = c.campaign_id || c.amazon_campaign_id || c.id;
      snapshot[campId] = c.state || c.status || 'enabled';
    }

    // Filtrar elegíveis para pausa
    const toPause = activeCampaigns.filter((c: any) => {
      const reason = c.archive_reason || c.last_pause_reason || '';
      if (MANUAL_STOP_REASONS.some(r => reason.includes(r))) return false;
      const campaignSpend = Number(c.spend || c.current_spend || 0);
      const createdAt = c.created_at ? new Date(c.created_at).getTime() : 0;
      const ageHours = createdAt > 0 ? (Date.now() - createdAt) / 3600000 : 999;
      if (c.created_by_app === true && campaignSpend === 0 && ageHours < 72) return false;
      return true;
    });

    let pausedCount = 0;
    const pausedIds: string[] = [];

    const batchPayload = toPause.map((c: any) => ({
      campaignId: String(c.amazon_campaign_id || c.campaign_id),
      state: 'PAUSED',
    }));

    for (let i = 0; i < batchPayload.length; i += 20) {
      const batch = batchPayload.slice(i, i + 20);
      const res = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        _service_role: true,
        amazon_account_id: accountId,
        path: '/sp/campaigns',
        method: 'PUT',
        content_type: 'application/vnd.spCampaign.v3+json',
        payload: { campaigns: batch },
      }).catch((e: any) => ({ ok: false, error: e.message }));

      const ok = (res as any)?.ok !== false;
      for (let j = 0; j < batch.length; j++) {
        const camp = toPause[i + j];
        if (!camp) continue;
        if (ok) {
          pausedIds.push(camp.campaign_id || camp.amazon_campaign_id);
          await base44.asServiceRole.entities.Campaign.update(camp.id, {
            status: 'paused',
            state: 'paused',
            archive_reason: 'DAILY_BUDGET_CAP_REACHED',
            last_pause_reason: 'DAILY_BUDGET_CAP_REACHED',
          }).catch(() => {});
          pausedCount++;
        }
      }
      await sleep(300);
    }

    await base44.asServiceRole.entities.AdsBidChangeLog.create({
      amazon_account_id: accountId,
      action: 'kill_switch_activated',
      reason: `Hard Cap atingido: R$${r2(confirmedSpend)} / R$${dailyBudget} (threshold 97% = R$${r2(threshold)}) | fonte: ${spendSource}`,
      source: 'budget_pacing_engine',
      campaigns_affected: pausedCount,
      stop_type: 'DAILY_CAP_STOP',
      created_at: now,
    }).catch(() => {});

    // Alerta na Sala de Comando
    const existingCapAlert = await base44.asServiceRole.entities.Alert.filter(
      { amazon_account_id: accountId, alert_type: 'daily_cap_reached', status: 'active' }, '-created_at', 1
    ).catch(() => []);
    if (existingCapAlert.length === 0) {
      await base44.asServiceRole.entities.Alert.create({
        amazon_account_id: accountId,
        alert_type: 'daily_cap_reached',
        alert_family: 'budget',
        severity: 'high',
        status: 'active',
        title: 'Teto diário atingido — campanhas pausadas',
        message: `Gasto de R$${r2(confirmedSpend)} atingiu o teto de R$${dailyBudget}. ${pausedCount} campanha(s) foram pausadas. Retomada automática às 00h BRT.`,
        entity_type: 'account',
        first_detected_at: now,
        last_detected_at: now,
        created_at: now,
      }).catch(() => {});
    }

    // Log de execução
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'budget_kill_switch',
      status: 'success',
      trigger_type: 'automatic',
      started_at: now,
      completed_at: now,
      records_processed: pausedCount,
      result_summary: `Kill switch ativado. Gasto: R$${r2(confirmedSpend)} / R$${dailyBudget}. Campanhas pausadas: ${pausedCount}.`,
    }).catch(() => {});

    await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
      confirmed_spend: r2(confirmedSpend),
      estimated_pending_spend: r2(estimatedUnreported),
      projected_total_spend: totalProjected,
      remaining_spend: 0,
      cap_status: 'cap_reached',
      global_kill_switch: true,
      global_stop_event_id: eventId,
      global_stop_snapshot: JSON.stringify(snapshot),
      kill_switch_activated_at: now,
      kill_switch_reason: `Gasto projetado R$${r2(totalProjected)} >= 97% do cap R$${r2(threshold)} | fonte: ${spendSource}`,
      last_pause_reason: 'DAILY_BUDGET_CAP_REACHED',
      campaigns_paused_today: pausedIds,
      campaigns_paused_count: pausedCount,
      stop_type: 'DAILY_CAP_STOP',
      user_daily_spend_cap: dailyBudget,
      effective_daily_spend_cap: dailyBudget,
      spend_velocity_per_hour: r2(spendVelocity),
      last_kill_switch_check_at: now,
      updated_at: now,
    }).catch(() => {});

    return Response.json({
      ok: true,
      kill_switch_activated: true,
      event_id: eventId,
      confirmed_spend: r2(confirmedSpend),
      spend_source: spendSource,
      estimated_unreported: r2(estimatedUnreported),
      total_projected: r2(totalProjected),
      threshold: r2(threshold),
      daily_budget: dailyBudget,
      campaigns_paused: pausedCount,
      paused_ids: pausedIds.slice(0, 20),
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});