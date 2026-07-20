/**
 * reactivateNewManualCampaigns — Roda toda manhã (06:00 BRT)
 *
 * Reativa campanhas SP | MANUAL | EXACT criadas pelo motor que foram pausadas
 * pelo kill switch de budget diário, desde que passem nas REGRAS DE PERFORMANCE do motor.
 *
 * CRITÉRIOS DE ELEGIBILIDADE (prazo + estoque):
 * 1. targeting_type = MANUAL, created_by_app = true, status = paused
 * 2. archive_reason = DAILY_BUDGET_CAP_REACHED | CAMPAIGN_BUDGET_EXCEEDED | BUDGET_CAP
 * 3. ASIN com fba_inventory > 0
 * 4. Não arquivada
 *
 * AVALIAÇÃO DE PERFORMANCE DO MOTOR (aplicada sobre dados históricos da campanha):
 *  → spend = 0           → APPROVED (sem dados, nova — reativa para coletar)
 *  → spend > 0, orders >= 1, ACoS <= target_acos * 1.5   → APPROVED (rentável ou aceitável)
 *  → spend > 0, orders >= 1, ACoS <= break_even_acos     → APPROVED_MARGINAL (reativa com alerta)
 *  → spend >= R$5, orders = 0                             → BLOCKED_NO_SALES (não reativa)
 *  → ACoS > break_even_acos                               → BLOCKED_ABOVE_BREAK_EVEN (não reativa)
 *  → CVR < 2% com clicks >= 30                           → BLOCKED_LOW_CVR (não reativa)
 *
 * NÃO reativa: OUT_OF_STOCK, USER_MANUAL, POLICY, ABOVE_BREAK_EVEN, LISTING_BLOCKED
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

const REACTIVATE_REASONS = new Set(['DAILY_BUDGET_CAP_REACHED', 'CAMPAIGN_BUDGET_EXCEEDED', 'BUDGET_CAP']);
const BLOCK_REASONS = ['OUT_OF_STOCK', 'USER_MANUAL', 'POLICY', 'ABOVE_BREAK_EVEN', 'LISTING_BLOCKED', 'NO_SALES_HARD'];

// Avalia a campanha pelas regras de performance do motor
function evaluatePerformance(c: any, targetAcos: number, breakEvenAcos: number): { approved: boolean; verdict: string; reason: string } {
  const spend       = Number(c.spend || c.current_spend || 0);
  const sales       = Number(c.sales || 0);
  const orders      = Number(c.orders || 0);
  const clicks      = Number(c.clicks || 0);
  const impressions = Number(c.impressions || 0);

  // Sem dados suficientes → reativa para coletar
  if (spend === 0 || impressions < 200) {
    return { approved: true, verdict: 'APPROVED_NO_DATA', reason: `Dados insuficientes (spend=R$${spend.toFixed(2)}, impressões=${impressions}) — reativar para coleta` };
  }

  const acos = spend > 0 && sales > 0 ? (spend / sales) * 100 : null;
  const cvr  = clicks > 0 ? orders / clicks : 0;

  // Gasto real sem nenhuma venda → bloquear
  if (spend >= 5 && orders === 0) {
    return { approved: false, verdict: 'BLOCKED_NO_SALES', reason: `R$${spend.toFixed(2)} gasto sem vendas` };
  }

  // CVR muito baixo com amostra relevante → bloquear
  if (clicks >= 30 && cvr < 0.02) {
    return { approved: false, verdict: 'BLOCKED_LOW_CVR', reason: `CVR=${(cvr * 100).toFixed(1)}% com ${clicks} cliques` };
  }

  // ACoS acima do break-even → bloquear
  if (acos !== null && acos > breakEvenAcos) {
    return { approved: false, verdict: 'BLOCKED_ABOVE_BREAK_EVEN', reason: `ACoS=${acos.toFixed(1)}% > break-even ${breakEvenAcos.toFixed(1)}%` };
  }

  // ACoS dentro de 1.5× target → aprovado
  if (acos !== null && acos <= targetAcos * 1.5) {
    return { approved: true, verdict: 'APPROVED', reason: `ACoS=${acos.toFixed(1)}%, orders=${orders}` };
  }

  // ACoS entre 1.5× e break-even → aprovado marginal
  if (acos !== null) {
    return { approved: true, verdict: 'APPROVED_MARGINAL', reason: `ACoS=${acos.toFixed(1)}% abaixo do break-even (${breakEvenAcos.toFixed(1)}%)` };
  }

  return { approved: true, verdict: 'APPROVED_LOW_DATA', reason: 'Dados marginais — reativar para observação' };
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const force = body.force === true;

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
    // Exceção: se force=true, ignora a trava e reativa mesmo assim
    if (controller?.global_kill_switch && !force) {
      const confirmedSpend = Number(controller.confirmed_spend || 0);
      const dailyCap = Number(controller.user_daily_spend_cap || controller.effective_daily_spend_cap || 70);
      if (confirmedSpend >= dailyCap * 0.90) {
        return Response.json({
          ok: true, skipped: true,
          reason: `Kill switch ativo com gasto R$${confirmedSpend.toFixed(2)} (${((confirmedSpend/dailyCap)*100).toFixed(0)}% do cap). Aguardando reset diário.`,
        });
      }
    }
    // Resetar kill switch para permitir reativação (force ou gasto baixo)
    if (controller?.global_kill_switch) {
      await base44.asServiceRole.entities.AccountDailySpendController.update(controller.id, {
        global_kill_switch: false,
        global_stop_event_id: null,
        kill_switch_reason: null,
        updated_at: now,
      }).catch(() => {});
    }

    // Carregar configurações de performance e produtos em estoque
    const [perfList, products] = await Promise.all([
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, null, 1).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid, status: 'active' }, null, 500).catch(() => []),
    ]);
    const perf = perfList[0] || {};
    const TARGET_ACOS    = Number(perf.target_acos || 15);
    const BREAK_EVEN_ACOS = Number(perf.max_acos || TARGET_ACOS * 2);

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

    // Pré-filtro: elegibilidade por prazo/motivo/estoque
    const eligible = pausedCampaigns.filter((c: any) => {
      if (c.archived === true) return false;
      if ((c.targeting_type || '').toUpperCase() !== 'MANUAL') return false;
      const pauseReason = c.archive_reason || c.last_pause_reason || '';
      if (!REACTIVATE_REASONS.has(pauseReason)) return false;
      if (BLOCK_REASONS.some(r => pauseReason.includes(r))) return false;
      if (c.asin && !inStockAsins.has(c.asin)) return false;
      return true;
    });

    // Avaliação de performance do motor sobre cada candidato elegível
    const performanceBlocked: any[] = [];
    const candidates = eligible.filter((c: any) => {
      const { approved, verdict, reason } = evaluatePerformance(c, TARGET_ACOS, BREAK_EVEN_ACOS);
      if (!approved) {
        performanceBlocked.push({
          name: c.name || c.campaign_name || c.campaign_id,
          asin: c.asin,
          verdict,
          reason,
          spend: Number(c.spend || c.current_spend || 0),
          orders: Number(c.orders || 0),
          acos: (() => { const s = Number(c.spend || 0), sa = Number(c.sales || 0); return s > 0 && sa > 0 ? Math.round((s/sa)*100*10)/10 : null; })(),
        });
      }
      return approved;
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

    // Log de execução com histórico de performance
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
        eligible: eligible.length,
        performance_blocked: performanceBlocked.length,
        candidates: candidates.length,
        reactivated,
        failed,
        config: { TARGET_ACOS, BREAK_EVEN_ACOS },
        reactivated_names: reactivatedNames.slice(0, 20),
        blocked_by_performance: performanceBlocked,
      }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      eligible: eligible.length,
      performance_blocked: performanceBlocked.length,
      candidates: candidates.length,
      reactivated,
      failed,
      reactivated_names: reactivatedNames,
      blocked_by_performance: performanceBlocked,
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});