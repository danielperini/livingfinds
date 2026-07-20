/**
 * reactivateNewManualCampaigns — Roda toda manhã (06:00 BRT)
 *
 * Reativa campanhas SP | MANUAL | EXACT criadas pelo motor (search term winners)
 * que foram pausadas pelo kill switch de budget diário com spend = R$0.
 *
 * CRITÉRIOS de reativação (TODAS devem ser atendidas):
 * 1. targeting_type = MANUAL
 * 2. status = paused
 * 3. created_by_app = true  (criada pelo motor a partir de search term winner)
 * 4. spend = 0  (nunca gastou nada — kill switch indevido)
 * 5. archive_reason = DAILY_BUDGET_CAP_REACHED ou CAMPAIGN_BUDGET_EXCEEDED
 * 6. asin do produto com fba_inventory > 0 (em estoque)
 * 7. Campanha não arquivada (archived ≠ true)
 *
 * NÃO reativa:
 * - Campanhas pausadas por OUT_OF_STOCK, USER_MANUAL, POLICY, ABOVE_BREAK_EVEN
 * - Campanhas com spend > 0 e orders = 0 e ACoS ruim (deixar o motor decidir)
 * - Campanhas de ASINs sem estoque
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

const REACTIVATE_REASONS = new Set(['DAILY_BUDGET_CAP_REACHED', 'CAMPAIGN_BUDGET_EXCEEDED', 'BUDGET_CAP']);
const BLOCK_REASONS = ['OUT_OF_STOCK', 'USER_MANUAL', 'POLICY', 'ABOVE_BREAK_EVEN', 'LISTING_BLOCKED', 'NO_SALES_HARD'];

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

    // Verificar se kill switch ainda está ativo hoje (não reativar se já atingiu o cap hoje)
    const controllers = await base44.asServiceRole.entities.AccountDailySpendController.filter(
      { amazon_account_id: aid, spend_date: todayBRT }, null, 1
    ).catch(() => []);
    const controller = controllers[0];

    // Se kill switch ativo E gasto confirmado alto, não reativar agora — aguardar amanhã
    if (controller?.global_kill_switch) {
      const confirmedSpend = Number(controller.confirmed_spend || 0);
      const dailyCap = Number(controller.user_daily_spend_cap || controller.effective_daily_spend_cap || 70);
      if (confirmedSpend >= dailyCap * 0.90) {
        return Response.json({
          ok: true, skipped: true,
          reason: `Kill switch ativo com gasto R$${confirmedSpend.toFixed(2)} (${((confirmedSpend/dailyCap)*100).toFixed(0)}% do cap). Aguardando reset diário.`,
        });
      }
      // Kill switch ativo mas gasto baixo = foi ativado por erro, pode reativar
      // Resetar o kill switch para o novo dia
      await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
        global_kill_switch: false,
        global_stop_event_id: null,
        kill_switch_reason: null,
        updated_at: now,
      }).catch(() => {});
    }

    // Carregar produtos com estoque (para validar elegibilidade)
    const products = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id: aid, status: 'active' }, null, 500
    ).catch(() => []);
    const inStockAsins = new Set<string>(
      products.filter((p: any) => Number(p.fba_inventory || 0) > 0).map((p: any) => p.asin)
    );

    // Buscar campanhas pausadas criadas pelo app com spend=0
    const pausedCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      {
        amazon_account_id: aid,
        created_by_app: true,
        status: 'paused',
      }, '-created_date', 500
    ).catch(() => []);

    const candidates = pausedCampaigns.filter((c: any) => {
      // Não arquivadas
      if (c.archived === true) return false;

      // Só MANUAL EXACT (criados pelo motor de search terms)
      if ((c.targeting_type || '').toUpperCase() !== 'MANUAL') return false;

      // Spend deve ser zero
      const spend = Number(c.spend || c.current_spend || 0);
      if (spend > 0) return false;

      // Motivo da pausa deve ser budget cap
      const reason = c.archive_reason || c.last_pause_reason || '';
      if (!REACTIVATE_REASONS.has(reason)) return false;

      // Não reativar se pausado por motivo manual/estoque/policy
      if (BLOCK_REASONS.some(r => reason.includes(r))) return false;

      // ASIN deve ter estoque (se tiver ASIN definido)
      if (c.asin && !inStockAsins.has(c.asin)) return false;

      return true;
    });

    if (candidates.length === 0) {
      return Response.json({
        ok: true,
        reactivated: 0,
        skipped: 0,
        reason: 'Nenhuma campanha elegível para reativação',
        duration_ms: Date.now() - t0,
      });
    }

    // Reativar em lotes de 10 na Amazon Ads API
    let reactivated = 0;
    let failed = 0;
    const reactivatedNames: string[] = [];

    for (let i = 0; i < candidates.length; i += 10) {
      const batch = candidates.slice(i, i + 10);
      const payload = batch
        .map((c: any) => ({ campaignId: String(c.amazon_campaign_id || c.campaign_id) }))
        .filter((p: any) => p.campaignId && p.campaignId !== 'undefined' && p.campaignId !== 'null');

      if (payload.length === 0) continue;

      const res = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        _service_role: true,
        amazon_account_id: aid,
        path: '/sp/campaigns',
        method: 'PUT',
        content_type: 'application/vnd.spCampaign.v3+json',
        payload: { campaigns: payload.map((p: any) => ({ ...p, state: 'ENABLED' })) },
      }).catch((e: any) => ({ ok: false, error: e.message }));

      const apiOk = res?.ok !== false;

      // Atualizar banco local
      for (let j = 0; j < batch.length; j++) {
        const c = batch[j];
        if (apiOk) {
          await base44.asServiceRole.entities.Campaign.update(c.id, {
            status: 'enabled',
            state: 'enabled',
            archive_reason: null,
            last_pause_reason: null,
            is_operational: true,
          }).catch(() => {});
          reactivated++;
          reactivatedNames.push(c.name || c.campaign_name || c.campaign_id);
        } else {
          failed++;
        }
      }

      await sleep(500);
    }

    // Log de execução
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'reactivateNewManualCampaigns',
      status: failed > 0 && reactivated === 0 ? 'error' : 'success',
      trigger_type: 'automatic',
      started_at: new Date(t0).toISOString(),
      completed_at: now,
      duration_ms: Date.now() - t0,
      records_processed: reactivated,
      result_summary: JSON.stringify({
        candidates: candidates.length,
        reactivated,
        failed,
        reactivated_names: reactivatedNames.slice(0, 20),
      }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      candidates: candidates.length,
      reactivated,
      failed,
      reactivated_names: reactivatedNames,
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});