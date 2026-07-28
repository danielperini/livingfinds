/**
 * runBudgetKillSwitch — v3 (PRD: propagação 100% confiável)
 *
 * Melhorias:
 * 1. Filtra campanhas sem amazon_campaign_id válido ANTES de montar payload → nunca envia "undefined"
 * 2. Inspeciona payload.campaigns.success[] e payload.campaigns.error[] individualmente (v3 JSON)
 * 3. Marca no banco APENAS campanhas confirmadas via success[], não todas do batch
 * 4. Persiste pause_failed_ids no controller
 * 5. RETRY automático após 5 min para pause_failed_ids com backoff de 10s
 * 6. VERIFICAÇÃO via GET /sp/campaigns/list ~2 min após pausa principal → re-pausa divergências
 * 7. global_stop_snapshot inclui: paused_confirmed, paused_local_only, pause_failed, unconfirmed_after_get, reconciled
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function r2(v: any) { return parseFloat((v || 0).toFixed(2)); }

// amazon_campaign_id válido: não vazio, não 'undefined', não 'null'
function isValidAmazonId(id: any): boolean {
  if (!id) return false;
  const s = String(id).trim();
  return s.length > 0 && s !== 'undefined' && s !== 'null';
}

const MANUAL_STOP_REASONS = ['USER_MANUAL', 'STOCK_ZERO', 'ABOVE_BREAK_EVEN', 'NO_SALES_HARD', 'LISTING_BLOCKED', 'POLICY', 'LOW_INTENT', 'CONFIGURATION_ERROR'];

// Pausa um batch via amazonAdsCommand e retorna {success: string[], failed: string[]}
async function pauseBatch(base44: any, accountId: string, batch: Array<{dbId: string; amazonId: string}>): Promise<{success: string[]; failed: string[]}> {
  const payload = batch.map(b => ({ campaignId: b.amazonId, state: 'PAUSED' }));
  const res = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
    _service_role: true,
    amazon_account_id: accountId,
    path: '/sp/campaigns',
    method: 'PUT',
    content_type: 'application/vnd.spCampaign.v3+json',
    payload: { campaigns: payload },
  }).catch((e: any) => ({ ok: false, error: e.message }));

  const data = (res as any)?.data ?? res;

  // Resposta v3: { payload: { campaigns: { success: [...], error: [...] } } }
  const successList: any[] = data?.payload?.campaigns?.success ?? data?.campaigns?.success ?? [];
  const errorList: any[]   = data?.payload?.campaigns?.error   ?? data?.campaigns?.error   ?? [];

  const successIds = new Set<string>(successList.map((s: any) => String(s.campaignId)));
  const errorIds   = new Set<string>(errorList.map((e: any) => String(e.campaignId)));

  // Se a API não retornou nenhuma lista detalhada mas ok=true, considerar tudo ok
  const httpOk = (res as any)?.ok !== false && !data?.error;
  const noDetail = successList.length === 0 && errorList.length === 0;

  const success: string[] = [];
  const failed: string[] = [];

  for (const b of batch) {
    if (successIds.has(b.amazonId)) {
      success.push(b.amazonId);
    } else if (errorIds.has(b.amazonId)) {
      failed.push(b.amazonId);
    } else if (noDetail && httpOk) {
      // Sem lista detalhada + HTTP ok → assumir sucesso
      success.push(b.amazonId);
    } else {
      // Sem confirmação explícita → falha
      failed.push(b.amazonId);
    }
  }

  return { success, failed };
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, force_check = false } = body;

    // ── Resolver conta ──
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

    // ── Cap ──
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
      const campaigns = await base44.asServiceRole.entities.Campaign.filter(
        { amazon_account_id: accountId }, null, 500
      ).catch(() => [] as any[]);
      confirmedSpend = campaigns.reduce((s: number, c: any) => s + Number(c.current_spend || 0), 0);
      spendSource = 'campaign_spend_fallback';
    }

    if (spendSource === 'campaign_spend_fallback' && confirmedSpend === 0) {
      return Response.json({ ok: true, skipped: true, reason: 'no_daily_spend_data', confirmed_spend: 0, daily_budget: dailyBudget, duration_ms: Date.now() - t0 });
    }

    const threshold = r2(dailyBudget * 0.97);
    const recoveryThreshold = r2(dailyBudget * 0.80);

    // ── 3. Recovery automático do kill switch ──
    if (controller?.global_kill_switch && !force_check) {
      if (confirmedSpend < recoveryThreshold) {
        await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
          global_kill_switch: false,
          global_stop_event_id: null,
          kill_switch_reason: `Recovery automático: R$${r2(confirmedSpend)} < 80% do cap (R$${r2(recoveryThreshold)})`,
          confirmed_spend: r2(confirmedSpend),
          cap_status: 'safe',
          last_kill_switch_check_at: now,
          updated_at: now,
        }).catch(() => {});

        const pausedCamps = await base44.asServiceRole.entities.Campaign.filter(
          { amazon_account_id: accountId, last_pause_reason: 'DAILY_BUDGET_CAP_REACHED' }, null, 200
        ).catch(() => [] as any[]);

        let reactivated = 0;
        for (let i = 0; i < pausedCamps.length; i += 20) {
          const batch = pausedCamps.slice(i, i + 20)
            .filter((c: any) => isValidAmazonId(c.amazon_campaign_id || c.campaign_id))
            .map((c: any) => ({ campaignId: String(c.amazon_campaign_id || c.campaign_id), state: 'ENABLED' }));
          if (batch.length) {
            await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
              _service_role: true, amazon_account_id: accountId,
              path: '/sp/campaigns', method: 'PUT',
              content_type: 'application/vnd.spCampaign.v3+json',
              payload: { campaigns: batch },
            }).catch(() => {});
          }
          for (const c of pausedCamps.slice(i, i + 20)) {
            await base44.asServiceRole.entities.Campaign.update(c.id, {
              status: 'enabled', state: 'enabled', last_pause_reason: null, archive_reason: null,
            }).catch(() => {});
            reactivated++;
          }
          await sleep(300);
        }

        return Response.json({
          ok: true, action: 'kill_switch_reset',
          confirmed_spend: r2(confirmedSpend), recovery_threshold: r2(recoveryThreshold),
          daily_budget: dailyBudget, reactivated_campaigns: reactivated, duration_ms: Date.now() - t0,
        });
      }

      return Response.json({
        ok: true, kill_switch_active: true,
        reason: 'Kill Switch ativo e gasto ainda acima de 80% do cap',
        confirmed_spend: r2(confirmedSpend), recovery_threshold: r2(recoveryThreshold),
        daily_budget: dailyBudget, activated_at: controller.kill_switch_activated_at, duration_ms: Date.now() - t0,
      });
    }

    if (!controller) {
      return Response.json({ ok: true, skipped: true, reason: 'Sem controller para hoje — rode runDailyBudgetPacingEngine primeiro' });
    }

    // ── Carregar campanhas ──
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: accountId }, null, 500
    ).catch(() => [] as any[]);

    const activeCampaigns = allCampaigns.filter((c: any) => {
      const s = (c.state || c.status || '').toLowerCase();
      return s === 'enabled' || s === 'active';
    });

    const totalBudgetNominal = allCampaigns.reduce((s: number, c: any) => s + Number(c.daily_budget || 0), 0);
    const spendVelocity = Number(controller.spend_velocity_per_hour || 0);
    const estimatedUnreported = spendVelocity > 0 ? spendVelocity * 0.25 : confirmedSpend * 0.05;
    const totalProjected = r2(confirmedSpend + estimatedUnreported);
    const shouldActivate = totalProjected >= threshold;

    if (!shouldActivate) {
      const utilizationPct = dailyBudget > 0 ? confirmedSpend / dailyBudget * 100 : 0;
      let capStatus = 'safe';
      if (utilizationPct >= 100) capStatus = 'cap_reached';
      else if (utilizationPct >= 95) capStatus = 'cap_imminent';
      else if (utilizationPct >= 85) capStatus = 'critical';
      else if (utilizationPct >= 70) capStatus = 'attention';

      await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
        confirmed_spend: r2(confirmedSpend), estimated_pending_spend: r2(estimatedUnreported),
        projected_total_spend: totalProjected, remaining_spend: r2(Math.max(0, dailyBudget - totalProjected)),
        cap_status: capStatus, user_daily_spend_cap: dailyBudget, effective_daily_spend_cap: dailyBudget,
        spend_velocity_per_hour: r2(spendVelocity), total_campaign_budget_nominal: r2(totalBudgetNominal),
        last_kill_switch_check_at: now, updated_at: now,
      }).catch(() => {});

      return Response.json({
        ok: true, kill_switch_activated: false, confirmed_spend: r2(confirmedSpend),
        spend_source: spendSource, threshold: r2(threshold), daily_budget: dailyBudget,
        cap_status: capStatus, duration_ms: Date.now() - t0,
      });
    }

    // ── ATIVAR KILL SWITCH ──
    const eventId = `killswitch:${accountId}:${todayBRT}:${currentHourBRT}`;
    if (controller.global_stop_event_id === eventId) {
      return Response.json({
        ok: true, kill_switch_activated: false, skipped_idempotent: true,
        event_id: eventId, reason: 'Kill Switch já executado nesta hora', duration_ms: Date.now() - t0,
      });
    }

    // ── Filtrar elegíveis para pausa ──
    const toPause = activeCampaigns.filter((c: any) => {
      const reason = c.archive_reason || c.last_pause_reason || '';
      if (MANUAL_STOP_REASONS.some(r => reason.includes(r))) return false;
      const campaignSpend = Number(c.spend || c.current_spend || 0);
      const createdAt = c.created_at ? new Date(c.created_at).getTime() : 0;
      const ageHours = createdAt > 0 ? (Date.now() - createdAt) / 3600000 : 999;
      if (c.created_by_app === true && campaignSpend === 0 && ageHours < 72) return false;
      return true;
    });

    // ── Separar com e sem amazon_campaign_id válido ──
    const withValidId: Array<{dbId: string; amazonId: string; campaign: any}> = [];
    const localOnlyIds: string[] = []; // sem ID válido — pausa apenas local

    for (const c of toPause) {
      const rawId = c.amazon_campaign_id || c.campaign_id;
      if (isValidAmazonId(rawId)) {
        withValidId.push({ dbId: c.id, amazonId: String(rawId), campaign: c });
      } else {
        localOnlyIds.push(c.id);
        // Marcar como pausa local com alerta
        await base44.asServiceRole.entities.Campaign.update(c.id, {
          status: 'paused', state: 'paused',
          archive_reason: 'DAILY_BUDGET_CAP_REACHED_LOCAL_ONLY',
          last_pause_reason: 'DAILY_BUDGET_CAP_REACHED_LOCAL_ONLY',
        }).catch(() => {});
      }
    }

    if (localOnlyIds.length > 0) {
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: accountId,
        operation: 'kill_switch_local_only_pause',
        status: 'warning',
        trigger_type: 'automatic',
        started_at: now,
        completed_at: now,
        records_processed: localOnlyIds.length,
        result_summary: `${localOnlyIds.length} campanha(s) sem amazon_campaign_id válido — pausadas apenas localmente.`,
      }).catch(() => {});
    }

    // ── FASE 1: Pausa principal em batches de 20 ──
    const pausedConfirmedIds: string[] = [];
    const pauseFailedIds: string[] = [];
    const dbIdByAmazonId: Record<string, string> = {};
    const campaignByAmazonId: Record<string, any> = {};

    for (const w of withValidId) {
      dbIdByAmazonId[w.amazonId] = w.dbId;
      campaignByAmazonId[w.amazonId] = w.campaign;
    }

    for (let i = 0; i < withValidId.length; i += 20) {
      const batchItems = withValidId.slice(i, i + 20);
      const { success, failed } = await pauseBatch(base44, accountId, batchItems);

      for (const amazonId of success) {
        pausedConfirmedIds.push(amazonId);
        const dbId = dbIdByAmazonId[amazonId];
        if (dbId) {
          await base44.asServiceRole.entities.Campaign.update(dbId, {
            status: 'paused', state: 'paused',
            archive_reason: 'DAILY_BUDGET_CAP_REACHED',
            last_pause_reason: 'DAILY_BUDGET_CAP_REACHED',
          }).catch(() => {});
        }
      }
      for (const amazonId of failed) {
        pauseFailedIds.push(amazonId);
      }

      await sleep(300);
    }

    // Salvar estado inicial do snapshot no controller
    const snapshotPhase1 = {
      paused_confirmed: pausedConfirmedIds,
      paused_local_only: localOnlyIds,
      pause_failed: pauseFailedIds,
      unconfirmed_after_get: [] as string[],
      reconciled: [] as string[],
      phase: 'main_pause_done',
      updated_at: new Date().toISOString(),
    };

    await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
      confirmed_spend: r2(confirmedSpend), estimated_pending_spend: r2(estimatedUnreported),
      projected_total_spend: totalProjected, remaining_spend: 0, cap_status: 'cap_reached',
      global_kill_switch: true, global_stop_event_id: eventId,
      global_stop_snapshot: JSON.stringify(snapshotPhase1),
      kill_switch_activated_at: now,
      kill_switch_reason: `Gasto projetado R$${r2(totalProjected)} >= 97% do cap R$${r2(threshold)} | fonte: ${spendSource}`,
      last_pause_reason: 'DAILY_BUDGET_CAP_REACHED',
      campaigns_paused_today: pausedConfirmedIds,
      campaigns_paused_count: pausedConfirmedIds.length,
      stop_type: 'DAILY_CAP_STOP',
      user_daily_spend_cap: dailyBudget, effective_daily_spend_cap: dailyBudget,
      spend_velocity_per_hour: r2(spendVelocity),
      last_kill_switch_check_at: now, updated_at: now,
    }).catch(() => {});

    // ── FASE 2: RETRY das falhas após 5 minutos ──
    let retriedSuccess: string[] = [];
    let retriedFailed: string[] = [];

    if (pauseFailedIds.length > 0) {
      await sleep(300000); // 5 min

      const failedItems = pauseFailedIds
        .filter(id => isValidAmazonId(id))
        .map(id => ({ dbId: dbIdByAmazonId[id], amazonId: id }))
        .filter(b => !!b.dbId);

      for (let i = 0; i < failedItems.length; i += 10) {
        const batchItems = failedItems.slice(i, i + 10);
        const { success, failed } = await pauseBatch(base44, accountId, batchItems);

        for (const amazonId of success) {
          retriedSuccess.push(amazonId);
          const dbId = dbIdByAmazonId[amazonId];
          if (dbId) {
            await base44.asServiceRole.entities.Campaign.update(dbId, {
              status: 'paused', state: 'paused',
              archive_reason: 'DAILY_BUDGET_CAP_REACHED',
              last_pause_reason: 'DAILY_BUDGET_CAP_REACHED',
            }).catch(() => {});
          }
        }
        retriedFailed.push(...failed);
        await sleep(10000); // 10s backoff entre batches
      }
    }

    // ── FASE 3: VERIFICAÇÃO via GET ~2 min após pausa principal ──
    // (Como o retry já esperou 5min, fazemos a verificação logo em seguida — 2min é o mínimo para propagação)
    let unconfirmedAfterGet: string[] = [];
    let reconciledIds: string[] = [];

    const allPausedIds = [...pausedConfirmedIds, ...retriedSuccess];

    if (allPausedIds.length > 0) {
      await sleep(120000); // 2 min

      // GET /sp/campaigns/list para verificar estado real na Amazon
      for (let i = 0; i < allPausedIds.length; i += 50) {
        const chunkIds = allPausedIds.slice(i, i + 50);
        const getRes = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
          _service_role: true, amazon_account_id: accountId,
          path: '/sp/campaigns/list',
          method: 'POST',
          content_type: 'application/vnd.spCampaign.v3+json',
          payload: {
            campaignIdFilter: { include: chunkIds },
            stateFilter: { include: ['ENABLED', 'PAUSED'] },
            maxResults: 50,
          },
        }).catch(() => null);

        const getdata = (getRes as any)?.data ?? getRes;
        const returnedCampaigns: any[] = getdata?.campaigns ?? getdata?.payload?.campaigns ?? [];

        // Identificar campanhas que Amazon ainda retorna como ENABLED (não propagaram)
        const stillEnabled = returnedCampaigns
          .filter((rc: any) => (rc.state || '').toUpperCase() === 'ENABLED')
          .map((rc: any) => String(rc.campaignId));

        unconfirmedAfterGet.push(...stillEnabled);

        // Re-pausar divergências
        if (stillEnabled.length > 0) {
          const reconciledBatch = stillEnabled
            .filter(id => isValidAmazonId(id))
            .map(id => ({ dbId: dbIdByAmazonId[id], amazonId: id }))
            .filter(b => !!b.dbId);

          if (reconciledBatch.length > 0) {
            const { success: recSuccess } = await pauseBatch(base44, accountId, reconciledBatch);
            reconciledIds.push(...recSuccess);

            for (const amazonId of recSuccess) {
              const dbId = dbIdByAmazonId[amazonId];
              if (dbId) {
                await base44.asServiceRole.entities.Campaign.update(dbId, {
                  status: 'paused', state: 'paused',
                  archive_reason: 'DAILY_BUDGET_CAP_REACHED',
                  last_pause_reason: 'DAILY_BUDGET_CAP_REACHED',
                }).catch(() => {});
              }
            }
          }
        }

        await sleep(500);
      }
    }

    // ── SNAPSHOT final ──
    const finalSnapshot = {
      paused_confirmed: pausedConfirmedIds,
      paused_local_only: localOnlyIds,
      pause_failed: [...retriedFailed],
      unconfirmed_after_get: unconfirmedAfterGet,
      reconciled: reconciledIds,
      retry_success: retriedSuccess,
      phase: 'complete',
      updated_at: new Date().toISOString(),
    };

    const totalPaused = pausedConfirmedIds.length + retriedSuccess.length + reconciledIds.length;

    await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
      global_stop_snapshot: JSON.stringify(finalSnapshot),
      campaigns_paused_today: allPausedIds,
      campaigns_paused_count: totalPaused,
      updated_at: new Date().toISOString(),
    }).catch(() => {});

    // ── Alerta ──
    const existingCapAlert = await base44.asServiceRole.entities.Alert.filter(
      { amazon_account_id: accountId, alert_type: 'daily_cap_reached', status: 'active' }, '-created_at', 1
    ).catch(() => []);
    if (existingCapAlert.length === 0) {
      await base44.asServiceRole.entities.Alert.create({
        amazon_account_id: accountId,
        alert_type: 'daily_cap_reached', alert_family: 'budget', severity: 'high', status: 'active',
        title: 'Teto diário atingido — campanhas pausadas',
        message: `Gasto R$${r2(confirmedSpend)} atingiu teto R$${dailyBudget}. ${totalPaused} pausada(s) confirmadas. ${retriedFailed.length} falhas persistentes. ${localOnlyIds.length} local-only.`,
        entity_type: 'account',
        first_detected_at: now, last_detected_at: now, created_at: now,
      }).catch(() => {});
    }

    // ── Log ──
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'budget_kill_switch',
      status: retriedFailed.length > 0 ? 'warning' : 'success',
      trigger_type: 'automatic',
      started_at: now, completed_at: new Date().toISOString(),
      records_processed: totalPaused,
      result_summary: `Kill switch v3. Gasto: R$${r2(confirmedSpend)}/R$${dailyBudget}. Pausadas: ${pausedConfirmedIds.length} (fase1) + ${retriedSuccess.length} (retry) + ${reconciledIds.length} (reconciliação). Falhas: ${retriedFailed.length}. Local-only: ${localOnlyIds.length}.`,
    }).catch(() => {});

    return Response.json({
      ok: true,
      kill_switch_activated: true,
      event_id: eventId,
      confirmed_spend: r2(confirmedSpend),
      spend_source: spendSource,
      daily_budget: dailyBudget,
      threshold: r2(threshold),
      paused_confirmed: pausedConfirmedIds.length,
      paused_local_only: localOnlyIds.length,
      pause_failed_after_retry: retriedFailed.length,
      unconfirmed_after_get: unconfirmedAfterGet.length,
      reconciled: reconciledIds.length,
      total_paused: totalPaused,
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});