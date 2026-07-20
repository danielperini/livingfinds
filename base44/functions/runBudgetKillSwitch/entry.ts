/**
 * runBudgetKillSwitch
 *
 * Hard Cap Kill Switch — pausa TODAS as campanhas imediatamente quando
 * confirmed_spend + estimated_unreported >= daily_budget - safety_buffer.
 *
 * Idempotência via global_stop_event_id — não repete pausa para o mesmo evento.
 * Bloqueia qualquer mutação (bid up, budget increase) enquanto ativo.
 * Safety buffer = max(spend_velocity_per_15min × 2, daily_budget × 0.025)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function r2(v) { return parseFloat((v || 0).toFixed(2)); }

// Stop types que NUNCA devem ser reativados automaticamente
const MANUAL_STOP_REASONS = ['USER_MANUAL', 'STOCK_ZERO', 'ABOVE_BREAK_EVEN', 'NO_SALES_HARD', 'LISTING_BLOCKED', 'POLICY', 'LOW_INTENT', 'CONFIGURATION_ERROR'];

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, force_check = false } = body;

    // Resolver conta
    let account;
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

    // Carregar controller atual
    const controllers = await base44.asServiceRole.entities.AccountDailySpendController.filter(
      { amazon_account_id: accountId, spend_date: todayBRT }, null, 1
    ).catch(() => []);

    const controller = controllers[0];
    if (!controller) {
      return Response.json({ ok: true, skipped: true, reason: 'Sem controller para hoje — rode runDailyBudgetPacingEngine primeiro' });
    }

    const dailyBudget = Number(controller.effective_daily_spend_cap || controller.user_daily_spend_cap || 70);

    // Se Kill Switch já está ativo, verificar se deve manter ou resetar
    if (controller.global_kill_switch && !force_check) {
      return Response.json({
        ok: true,
        kill_switch_active: true,
        reason: 'Kill Switch já ativo',
        activated_at: controller.kill_switch_activated_at,
        daily_budget: dailyBudget,
        confirmed_spend: controller.confirmed_spend,
        duration_ms: Date.now() - t0,
      });
    }

    // ── Calcular gasto atual ───────────────────────────────────────────
    const campaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: accountId }, null, 500
    ).catch(() => []);

    const activeCampaigns = campaigns.filter(c => {
      const s = (c.state || c.status || '').toLowerCase();
      return s === 'enabled' || s === 'active';
    });

    const confirmedSpend = campaigns.reduce((s, c) => s + Number(c.spend || c.current_spend || 0), 0);
    const totalBudgetNominal = campaigns.reduce((s, c) => s + Number(c.daily_budget || 0), 0);

    // Estimativa de gasto não reportado (latência Amazon)
    // Usa spend_velocity do controller se disponível
    const spendVelocity = Number(controller.spend_velocity_per_hour || 0);
    const estimatedUnreportedHours = 0.25; // 15 minutos de latência estimada
    const estimatedUnreported = spendVelocity > 0
      ? spendVelocity * estimatedUnreportedHours
      : confirmedSpend * 0.05; // fallback: 5% do gasto confirmado

    // ── Calcular safety_buffer dinâmico ───────────────────────────────
    const velocityBuffer = spendVelocity > 0 ? (spendVelocity / 4) * 2 : 0; // 15min × 2
    const pctBuffer = dailyBudget * 0.025;
    const safetyBuffer = r2(Math.max(velocityBuffer, pctBuffer, 2));

    const totalProjected = r2(confirmedSpend + estimatedUnreported);
    const threshold = dailyBudget - safetyBuffer;

    // ── Verificar se deve ativar Kill Switch ──────────────────────────
    const shouldActivate = totalProjected >= threshold;

    if (!shouldActivate) {
      // Atualizar controller sem ativar
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
        safety_buffer: safetyBuffer,
        spend_velocity_per_hour: r2(spendVelocity),
        total_campaign_budget_nominal: r2(totalBudgetNominal),
        last_kill_switch_check_at: now,
        updated_at: now,
      }).catch(() => {});

      return Response.json({
        ok: true,
        kill_switch_activated: false,
        confirmed_spend: r2(confirmedSpend),
        threshold: r2(threshold),
        safety_buffer: safetyBuffer,
        daily_budget: dailyBudget,
        cap_status: capStatus,
        duration_ms: Date.now() - t0,
      });
    }

    // ── ATIVAR KILL SWITCH ─────────────────────────────────────────────
    // Idempotência: gerar event_id único para hoje + hora
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

    // Salvar GLOBAL_STOP_SNAPSHOT (estado atual de cada campanha gerenciada)
    const snapshot = {};
    for (const c of activeCampaigns) {
      const campId = c.campaign_id || c.amazon_campaign_id || c.id;
      snapshot[campId] = c.state || c.status || 'enabled';
    }

    // Filtrar campanhas elegíveis para pausa
    // REGRA CRÍTICA: campanhas MANUAL EXACT criadas pelo app com spend=0 são imunes ao kill switch
    // — elas não contribuem para o gasto real e pausá-las impede que campanhãs vencedoras rodem
    const toPause = activeCampaigns.filter(c => {
      const reason = c.archive_reason || c.last_pause_reason || '';
      const isManual = MANUAL_STOP_REASONS.some(r => reason.includes(r));
      if (isManual) return false;

      // Imunidade: campanha criada pelo app (search term winner) com spend=0 e < 72h de vida
      const campaignSpend = Number(c.spend || c.current_spend || 0);
      const createdAt = c.created_at ? new Date(c.created_at).getTime() : 0;
      const ageHours = createdAt > 0 ? (Date.now() - createdAt) / 3600000 : 999;
      if (c.created_by_app === true && campaignSpend === 0 && ageHours < 72) return false;

      return true;
    });

    // Pausar via Amazon Ads API em batch de 20
    let pausedCount = 0;
    const pausedIds = [];

    const batchPayload = toPause.map(c => ({
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
      }).catch(e => ({ ok: false, error: e.message }));

      const ok = res?.ok !== false;
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

    // Registrar em AdsBidChangeLog
    await base44.asServiceRole.entities.AdsBidChangeLog.create({
      amazon_account_id: accountId,
      action: 'kill_switch_activated',
      reason: `Hard Cap atingido: R$${r2(confirmedSpend)} / R$${dailyBudget} (threshold R$${r2(threshold)})`,
      source: 'budget_pacing_engine',
      campaigns_affected: pausedCount,
      stop_type: 'DAILY_CAP_STOP',
      created_at: now,
    }).catch(() => {});

    // Atualizar AccountDailySpendController
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
      kill_switch_reason: `Gasto projetado R$${r2(totalProjected)} >= threshold R$${r2(threshold)}`,
      last_pause_reason: 'DAILY_BUDGET_CAP_REACHED',
      campaigns_paused_today: pausedIds,
      campaigns_paused_count: pausedCount,
      stop_type: 'DAILY_CAP_STOP',
      safety_buffer: safetyBuffer,
      spend_velocity_per_hour: r2(spendVelocity),
      last_kill_switch_check_at: now,
      updated_at: now,
    }).catch(() => {});

    return Response.json({
      ok: true,
      kill_switch_activated: true,
      event_id: eventId,
      confirmed_spend: r2(confirmedSpend),
      estimated_unreported: r2(estimatedUnreported),
      total_projected: r2(totalProjected),
      threshold: r2(threshold),
      safety_buffer: safetyBuffer,
      daily_budget: dailyBudget,
      campaigns_paused: pausedCount,
      paused_ids: pausedIds.slice(0, 20),
      duration_ms: Date.now() - t0,
    });

  } catch (err) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});