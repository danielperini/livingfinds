/**
 * enforceCampaignSpendLimits — v2
 *
 * Correções PRD:
 * 1. globalCap lido de PerformanceSettings.daily_budget_limit como fonte primária
 * 2. gasto confirmado de CampaignMetricsDaily (data BRT), fallback Campaign.spend
 * 3. threshold = 97% do cap (não 97.5%)
 * 4. Cria controller do dia se não existir antes de aplicar o guardrail
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function r2(v: any) { return parseFloat((v || 0).toFixed(2)); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Resolver conta
    let account: any;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1);
      account = accs[0];
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' }, { status: 404 });

    const aid = account.id;
    const now = new Date().toISOString();
    const brtDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const todayBRT = brtDate.toISOString().slice(0, 10);
    const currencySymbol = account.currency_symbol || 'R$';

    // ── 1. Ler cap de PerformanceSettings (fonte primária) ──
    let globalCap = 70;
    try {
      const psList = await base44.asServiceRole.entities.PerformanceSettings.filter(
        { amazon_account_id: aid }, '-updated_at', 1
      );
      if (psList[0]?.daily_budget_limit > 0) globalCap = Number(psList[0].daily_budget_limit);
    } catch {}

    // Buscar controller do dia (fallback de cap se PS não retornou)
    const controllers = await base44.asServiceRole.entities.AccountDailySpendController.filter(
      { amazon_account_id: aid, spend_date: todayBRT }, null, 1
    ).catch(() => [] as any[]);
    let controller = controllers[0];

    if (globalCap <= 0 && controller) {
      globalCap = Number(controller.user_daily_spend_cap || controller.effective_daily_spend_cap || 70);
    }

    // Se controller não existe para hoje, criar um mínimo para garantir idempotência
    if (!controller) {
      try {
        controller = await base44.asServiceRole.entities.AccountDailySpendController.create({
          amazon_account_id: aid,
          marketplace_id: account.marketplace_id || 'A2Q3Y263D00KWC',
          spend_date: todayBRT,
          timezone: 'America/Sao_Paulo',
          user_daily_spend_cap: globalCap,
          effective_daily_spend_cap: globalCap,
          cap_status: 'safe',
          created_at: now,
          updated_at: now,
        });
      } catch {}
    } else if (controller.user_daily_spend_cap !== globalCap) {
      // Sincronizar cap no controller com PerformanceSettings
      await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
        user_daily_spend_cap: globalCap,
        effective_daily_spend_cap: globalCap,
        updated_at: now,
      }).catch(() => {});
    }

    const THRESHOLD_PCT = 0.97; // 97% do cap
    const globalThreshold = r2(globalCap * THRESHOLD_PCT);

    // Buscar todas as campanhas
    const campaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: aid }, null, 500
    ).catch(() => [] as any[]);

    const activeCampaigns = campaigns.filter((c: any) => {
      const s = (c.state || c.status || '').toLowerCase();
      return s === 'enabled' || s === 'active';
    });

    // ── 2. Gasto confirmado via CampaignMetricsDaily (data BRT) ──
    const metricsToday = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: aid, date: todayBRT }, null, 500
    ).catch(() => [] as any[]);

    let totalSpend = 0;
    let spendSource = 'metrics_daily';
    if (metricsToday.length > 0) {
      totalSpend = metricsToday.reduce((s: number, m: any) => s + Number(m.spend || 0), 0);
    } else {
      totalSpend = campaigns.reduce((s: number, c: any) => s + Number(c.current_spend || 0), 0);
      spendSource = 'campaign_spend_fallback';
    }

    // Se fallback de gasto e totalSpend=0, não há dados diários confiáveis → abortar sem acionar cap
    if (spendSource === 'campaign_spend_fallback' && totalSpend === 0) {
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: aid,
        operation: 'enforceCampaignSpendLimits',
        status: 'skipped',
        trigger_type: 'automatic',
        started_at: now,
        completed_at: new Date().toISOString(),
        result_summary: 'Skipped: sem dados de gasto diário (CampaignMetricsDaily vazio e current_spend=0)',
      }).catch(() => {});
      return Response.json({ ok: true, skipped: true, reason: 'no_daily_spend_data', total_spend: 0, duration_ms: Date.now() - t0 });
    }

    const pausedByCampaignLimit: string[] = [];
    const pausedByGlobalLimit: string[] = [];
    const skipped: string[] = [];

    // ── CAMADA 1: Verificar limite por campanha ──
    for (const c of activeCampaigns) {
      const campaignBudget = Number(c.daily_budget || 0);
      const campaignSpend = Number(c.current_spend || c.spend || 0);

      if (campaignBudget <= 0) continue;
      if (campaignSpend < campaignBudget) continue;

      const campaignId = String(c.amazon_campaign_id || c.campaign_id);
      if (!campaignId || campaignId === 'undefined') { skipped.push(c.id); continue; }
      if (c.last_pause_reason === 'CAMPAIGN_BUDGET_EXCEEDED') { skipped.push(campaignId); continue; }

      const pauseRes = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        _service_role: true,
        amazon_account_id: aid,
        path: '/sp/campaigns',
        method: 'PUT',
        content_type: 'application/vnd.spCampaign.v3+json',
        payload: { campaigns: [{ campaignId, state: 'PAUSED' }] },
      }).catch((e: any) => ({ ok: false, error: e.message }));

      if ((pauseRes as any)?.ok !== false) {
        await base44.asServiceRole.entities.Campaign.update(c.id, {
          status: 'paused',
          state: 'paused',
          last_pause_reason: 'CAMPAIGN_BUDGET_EXCEEDED',
          archive_reason: 'CAMPAIGN_BUDGET_EXCEEDED',
        }).catch(() => {});
        pausedByCampaignLimit.push(campaignId);
      }
      await sleep(150);
    }

    // ── CAMADA 2: Verificar cap global da conta ──
    if (totalSpend >= globalThreshold && activeCampaigns.length > 0) {
      const stillActive = activeCampaigns.filter((c: any) => {
        if (pausedByCampaignLimit.includes(String(c.amazon_campaign_id || c.campaign_id))) return false;
        if (c.last_pause_reason === 'DAILY_BUDGET_CAP_REACHED') return false;
        if (c.last_pause_reason === 'CAMPAIGN_BUDGET_EXCEEDED') return false;
        const spend = Number(c.spend || c.current_spend || 0);
        const createdAt = c.created_at ? new Date(c.created_at).getTime() : 0;
        const ageHours = createdAt > 0 ? (Date.now() - createdAt) / 3600000 : 999;
        if (c.created_by_app === true && spend === 0 && ageHours < 72) return false;
        return true;
      });

      const batchPayload = stillActive.map((c: any) => ({
        campaignId: String(c.amazon_campaign_id || c.campaign_id),
        state: 'PAUSED',
      })).filter((p: any) => p.campaignId && p.campaignId !== 'undefined');

      for (let i = 0; i < batchPayload.length; i += 20) {
        const batch = batchPayload.slice(i, i + 20);
        const res = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
          _service_role: true,
          amazon_account_id: aid,
          path: '/sp/campaigns',
          method: 'PUT',
          content_type: 'application/vnd.spCampaign.v3+json',
          payload: { campaigns: batch },
        }).catch(() => ({ ok: false }));

        if ((res as any)?.ok !== false) {
          for (let j = 0; j < batch.length; j++) {
            const camp = stillActive[i + j];
            if (!camp) continue;
            await base44.asServiceRole.entities.Campaign.update(camp.id, {
              status: 'paused',
              state: 'paused',
              last_pause_reason: 'DAILY_BUDGET_CAP_REACHED',
              archive_reason: 'DAILY_BUDGET_CAP_REACHED',
            }).catch(() => {});
            pausedByGlobalLimit.push(batch[j].campaignId);
          }
        }
        await sleep(300);
      }

      if (controller) {
        await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
          global_kill_switch: true,
          kill_switch_activated_at: now,
          kill_switch_reason: `Gasto total ${currencySymbol}${r2(totalSpend)} >= 97% do cap (${currencySymbol}${r2(globalThreshold)}) | fonte: ${spendSource}`,
          confirmed_spend: r2(totalSpend),
          remaining_spend: 0,
          cap_status: 'cap_reached',
          user_daily_spend_cap: globalCap,
          effective_daily_spend_cap: globalCap,
          campaigns_paused_count: (controller.campaigns_paused_count || 0) + pausedByGlobalLimit.length,
          last_action_at: now,
          last_kill_switch_check_at: now,
          updated_at: now,
        }).catch(() => {});
      }

      const existingAlert = await base44.asServiceRole.entities.Alert.filter({
        amazon_account_id: aid,
        alert_type: 'budget_exhausted',
        status: 'active',
      }, '-created_at', 1).catch(() => [] as any[]);

      if (existingAlert.length === 0) {
        await base44.asServiceRole.entities.Alert.create({
          amazon_account_id: aid,
          alert_type: 'budget_exhausted',
          severity: 'critical',
          title: 'Cap diário atingido — campanhas pausadas',
          message: `Gasto de ${currencySymbol}${r2(totalSpend)} atingiu 97% do limite diário de ${currencySymbol}${r2(globalCap)} (fonte: ${spendSource}). ${pausedByGlobalLimit.length + pausedByCampaignLimit.length} campanha(s) pausada(s).`,
          entity_type: 'account',
          status: 'active',
          current_value: r2(totalSpend),
          threshold_value: r2(globalCap),
          created_at: now,
        }).catch(() => {});
      }

      console.log(`[SpendLimits] CAP GLOBAL atingido: ${currencySymbol}${r2(totalSpend)} >= ${currencySymbol}${r2(globalThreshold)} (97% de ${currencySymbol}${r2(globalCap)}) | fonte: ${spendSource}`);
    } else if (controller) {
      // Atualizar gasto confirmado no controller mesmo sem acionar cap
      await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
        confirmed_spend: r2(totalSpend),
        user_daily_spend_cap: globalCap,
        effective_daily_spend_cap: globalCap,
        last_kill_switch_check_at: now,
        updated_at: now,
      }).catch(() => {});
    }

    const totalPaused = pausedByCampaignLimit.length + pausedByGlobalLimit.length;
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'enforceCampaignSpendLimits',
      status: 'success',
      trigger_type: 'automatic',
      started_at: now,
      completed_at: new Date().toISOString(),
      records_processed: totalPaused,
      result_summary: JSON.stringify({
        total_spend: r2(totalSpend),
        spend_source: spendSource,
        global_cap: r2(globalCap),
        global_threshold: r2(globalThreshold),
        paused_by_campaign_limit: pausedByCampaignLimit.length,
        paused_by_global_limit: pausedByGlobalLimit.length,
        skipped: skipped.length,
      }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      total_spend: r2(totalSpend),
      spend_source: spendSource,
      global_cap: r2(globalCap),
      global_threshold: r2(globalThreshold),
      paused_by_campaign_limit: pausedByCampaignLimit.length,
      paused_by_global_limit: pausedByGlobalLimit.length,
      paused_campaign_ids: [...pausedByCampaignLimit, ...pausedByGlobalLimit],
      global_cap_triggered: totalSpend >= globalThreshold,
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});