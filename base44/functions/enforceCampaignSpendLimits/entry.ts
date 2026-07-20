/**
 * enforceCampaignSpendLimits — Trava de segurança por campanha + conta
 *
 * Verifica duas camadas de proteção:
 *
 * CAMADA 1 — Por campanha individual:
 *   Se current_spend >= daily_budget de uma campanha → pausar imediatamente
 *   (protege contra campanhas que ignoram o orçamento da Amazon)
 *
 * CAMADA 2 — Por conta (Hard Cap global):
 *   Se soma de gastos de todas as campanhas >= user_daily_spend_cap - buffer → pausar todas
 *   (trava de segurança global para evitar qualquer desperdício fora do planejado)
 *
 * Idempotente: não repete pausas se a campanha já está paused.
 * Registra todas as ações em SyncExecutionLog + Alert.
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

    // Buscar cap global do dia
    const controllers = await base44.asServiceRole.entities.AccountDailySpendController.filter(
      { amazon_account_id: aid, spend_date: todayBRT }, null, 1
    ).catch(() => []);
    const controller = controllers[0];
    const globalCap = Number(controller?.user_daily_spend_cap || controller?.effective_daily_spend_cap || 70);
    const GLOBAL_BUFFER_PCT = 0.025; // 2.5% de buffer de segurança
    const globalThreshold = globalCap * (1 - GLOBAL_BUFFER_PCT);

    // Buscar todas as campanhas ativas
    const campaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: aid }, null, 500
    ).catch(() => []);

    const activeCampaigns = campaigns.filter(c => {
      const s = (c.state || c.status || '').toLowerCase();
      return s === 'enabled' || s === 'active';
    });

    const pausedByCampaignLimit: string[] = [];
    const pausedByGlobalLimit: string[] = [];
    const skipped: string[] = [];

    // ── CAMADA 1: Verificar limite por campanha ────────────────────────────
    for (const c of activeCampaigns) {
      const campaignBudget = Number(c.daily_budget || 0);
      const campaignSpend = Number(c.current_spend || c.spend || 0);

      if (campaignBudget <= 0) continue; // sem limite definido, pular
      if (campaignSpend < campaignBudget) continue; // dentro do limite

      // Campanha ultrapassou o próprio daily_budget → pausar
      const campaignId = String(c.amazon_campaign_id || c.campaign_id);
      if (!campaignId || campaignId === 'undefined') { skipped.push(c.id); continue; }

      // Já pausada por este motivo hoje? (idempotência por archive_reason)
      if (c.last_pause_reason === 'CAMPAIGN_BUDGET_EXCEEDED') {
        skipped.push(campaignId);
        continue;
      }

      // Enviar pausa para Amazon Ads API
      const pauseRes = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        _service_role: true,
        amazon_account_id: aid,
        path: '/sp/campaigns',
        method: 'PUT',
        content_type: 'application/vnd.spCampaign.v3+json',
        payload: { campaigns: [{ campaignId, state: 'PAUSED' }] },
      }).catch((e: any) => ({ ok: false, error: e.message }));

      if (pauseRes?.ok !== false) {
        await base44.asServiceRole.entities.Campaign.update(c.id, {
          status: 'paused',
          state: 'paused',
          last_pause_reason: 'CAMPAIGN_BUDGET_EXCEEDED',
          archive_reason: 'CAMPAIGN_BUDGET_EXCEEDED',
        }).catch(() => {});
        pausedByCampaignLimit.push(campaignId);
        console.log(`[SpendLimits] Campanha ${campaignId} pausada: R$${r2(campaignSpend)} >= R$${r2(campaignBudget)} (limite diário)`);
      }
      await sleep(150);
    }

    // ── CAMADA 2: Verificar cap global da conta ────────────────────────────
    // Recalcular gasto total com os dados mais atuais
    const totalSpend = campaigns.reduce((s, c) => s + Number(c.current_spend || c.spend || 0), 0);

    if (totalSpend >= globalThreshold && activeCampaigns.length > 0) {
      // Hard cap atingido — pausar todas as campanhas ainda ativas
      const stillActive = activeCampaigns.filter(c =>
        !pausedByCampaignLimit.includes(String(c.amazon_campaign_id || c.campaign_id)) &&
        c.last_pause_reason !== 'DAILY_BUDGET_CAP_REACHED' &&
        c.last_pause_reason !== 'CAMPAIGN_BUDGET_EXCEEDED'
      );

      const batchPayload = stillActive.map(c => ({
        campaignId: String(c.amazon_campaign_id || c.campaign_id),
        state: 'PAUSED',
      })).filter(p => p.campaignId && p.campaignId !== 'undefined');

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

        if (res?.ok !== false) {
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

      // Atualizar controller com kill switch ativo
      if (controller) {
        await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
          global_kill_switch: true,
          kill_switch_activated_at: now,
          kill_switch_reason: `Gasto total R$${r2(totalSpend)} >= threshold R$${r2(globalThreshold)} (cap R$${r2(globalCap)})`,
          confirmed_spend: r2(totalSpend),
          remaining_spend: 0,
          cap_status: 'cap_reached',
          campaigns_paused_count: (controller.campaigns_paused_count || 0) + pausedByGlobalLimit.length,
          last_action_at: now,
          updated_at: now,
        }).catch(() => {});
      }

      // Criar alerta crítico (idempotente por dia)
      const existingAlert = await base44.asServiceRole.entities.Alert.filter({
        amazon_account_id: aid,
        alert_type: 'budget_exhausted',
        status: 'active',
      }, '-created_at', 1).catch(() => []);

      if (existingAlert.length === 0) {
        await base44.asServiceRole.entities.Alert.create({
          amazon_account_id: aid,
          alert_type: 'budget_exhausted',
          severity: 'critical',
          title: 'Cap diário atingido — campanhas pausadas',
          message: `Gasto de ${currencySymbol}${r2(totalSpend)} atingiu o limite diário de ${currencySymbol}${r2(globalCap)}. ${pausedByGlobalLimit.length + pausedByCampaignLimit.length} campanha(s) pausada(s) automaticamente para proteger o orçamento.`,
          entity_type: 'account',
          status: 'active',
          current_value: r2(totalSpend),
          threshold_value: r2(globalCap),
          created_at: now,
        }).catch(() => {});
      }

      console.log(`[SpendLimits] CAP GLOBAL atingido: R$${r2(totalSpend)} >= R$${r2(globalThreshold)}. ${pausedByGlobalLimit.length} campanhas pausadas.`);
    }

    // Registrar execução
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