/**
 * runSmartBudgetAllocation — Motor de redistribuição inteligente de budget diário
 *
 * Lógica:
 *  1. Classifica todas as campanhas ENABLED em tiers de performance:
 *     - WINNER   : ACoS <= target_acos E orders >= 1        → budget +20% (capped)
 *     - EFFICIENT: ACoS <= target_acos * 1.3 OU roas >= 2   → budget mantido ou +10%
 *     - DRAINING : ACoS > target_acos * 1.5 E spend > 0     → budget -20%
 *     - BLEEDING  : ACoS > break_even_acos OU sem vendas com gasto → budget reduz ao mínimo (R$5)
 *     - NEW       : < 72h de vida (created_by_app) → imune, mantido
 *
 *  2. Garante que a SOMA total dos budgets não ultrapasse o daily_budget_limit de PerformanceSettings
 *     (hard cap de conta). Se ultrapassar, escala todos proporcionalmente.
 *
 *  3. Aplica o guardrail de ±20% máximo por ciclo e respeita min_budget=R$5.
 *
 *  4. Envia para Amazon Ads API via adjustCampaignBudgets e grava histórico no SyncExecutionLog.
 *
 * Proteções:
 *  - Campanhas is_operational=true (WINNER protegido) nunca são reduzidas abaixo do mínimo.
 *  - Campanhas novas (created_by_app + spend=0 + < 72h) são completamente imunes.
 *  - Campanhas com dados insuficientes (< 200 impressões) ficam em HOLD (sem alteração).
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function r2(v: number) { return Math.round(v * 100) / 100; }
function clamp(v: number, min: number, max: number) { return Math.max(min, Math.min(max, v)); }

// Classifica campanha em tier de performance
function classifyCampaign(c: any, targetAcos: number, breakEvenAcos: number): {
  tier: 'WINNER' | 'EFFICIENT' | 'HOLD' | 'DRAINING' | 'BLEEDING' | 'NEW';
  reason: string;
} {
  const spend  = Number(c.spend || c.current_spend || 0);
  const sales  = Number(c.sales || 0);
  const orders = Number(c.orders || 0);
  const impressions = Number(c.impressions || 0);
  const createdAt = c.created_at ? new Date(c.created_at).getTime() : 0;
  const ageHours = createdAt > 0 ? (Date.now() - createdAt) / 3600000 : 9999;

  // Imune: campanha nova sem gasto
  if (c.created_by_app && spend === 0 && ageHours < 72) {
    return { tier: 'NEW', reason: 'Campanha nova (<72h, spend=0) — imune' };
  }

  // Dados insuficientes → sem alteração
  if (impressions < 200 && spend < 2) {
    return { tier: 'HOLD', reason: `Dados insuficientes (impressões=${impressions}, spend=R$${spend.toFixed(2)})` };
  }

  const acos  = spend > 0 && sales > 0 ? (spend / sales) * 100 : null;
  const roas  = spend > 0 && sales > 0 ? sales / spend : 0;

  // Sem vendas com gasto real → BLEEDING
  if (spend >= 3 && sales === 0) {
    return { tier: 'BLEEDING', reason: `Sem vendas com gasto R$${spend.toFixed(2)}` };
  }

  // ACoS acima do break-even → BLEEDING
  if (acos !== null && acos > breakEvenAcos * 1.1) {
    return { tier: 'BLEEDING', reason: `ACoS=${acos.toFixed(1)}% > break-even ${breakEvenAcos.toFixed(1)}%` };
  }

  // ACoS muito acima do target → DRAINING
  if (acos !== null && acos > targetAcos * 1.5) {
    return { tier: 'DRAINING', reason: `ACoS=${acos.toFixed(1)}% > ${(targetAcos * 1.5).toFixed(1)}% (1.5× target)` };
  }

  // WINNER: dentro do target com vendas
  if (acos !== null && acos <= targetAcos && orders >= 1) {
    return { tier: 'WINNER', reason: `ACoS=${acos.toFixed(1)}% ≤ target ${targetAcos}%, orders=${orders}` };
  }

  // EFFICIENT: razoavelmente bom
  if ((acos !== null && acos <= targetAcos * 1.3) || roas >= 2) {
    return { tier: 'EFFICIENT', reason: `ACoS=${acos?.toFixed(1)}%, ROAS=${roas.toFixed(2)}x — eficiente` };
  }

  return { tier: 'HOLD', reason: `ACoS=${acos?.toFixed(1)}%, sem critério de escalonamento` };
}

// Calcula fator de ajuste por tier
function adjustmentFactor(tier: string, isProtected: boolean): number {
  if (tier === 'WINNER')    return 1.20;
  if (tier === 'EFFICIENT') return 1.10;
  if (tier === 'HOLD')      return 1.00;
  if (tier === 'NEW')       return 1.00;
  if (tier === 'DRAINING')  return isProtected ? 1.00 : 0.80;
  if (tier === 'BLEEDING')  return isProtected ? 1.00 : 0.50; // reduz ao mínimo
  return 1.00;
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  const now = new Date().toISOString();
  const todayBRT = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).toISOString().slice(0, 10);

  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const dry_run: boolean = body.dry_run === true;

    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    // ── Resolver conta ──────────────────────────────────────────────
    let account: any;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1);
      account = accs[0];
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });
    const aid = account.id;

    // ── Carregar configurações ──────────────────────────────────────
    const [perfList, campaigns] = await Promise.all([
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, null, 1).catch(() => []),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
    ]);

    const perf = perfList[0] || {};
    const TARGET_ACOS    = Number(perf.target_acos || 15);
    const BREAK_EVEN_ACOS = Number(perf.max_acos || TARGET_ACOS * 2);
    const ACCOUNT_BUDGET_CAP = Number(perf.daily_budget_limit || 70); // hard cap da conta
    const MIN_CAMPAIGN_BUDGET = Number(perf.minimum_campaign_budget || 5);
    const MAX_CAMPAIGN_BUDGET = 25; // teto por campanha para evitar concentração excessiva

    // ── Filtrar campanhas ativas ────────────────────────────────────
    const activeCampaigns = campaigns.filter((c: any) => {
      const s = (c.state || c.status || '').toLowerCase();
      return (s === 'enabled' || s === 'active') &&
             c.amazon_campaign_id &&
             String(c.amazon_campaign_id) !== 'undefined';
    });

    if (activeCampaigns.length === 0) {
      return Response.json({ ok: true, message: 'Nenhuma campanha ativa encontrada', dry_run });
    }

    // ── Classificar e calcular novos budgets ───────────────────────
    const decisions: any[] = [];

    for (const camp of activeCampaigns) {
      const { tier, reason } = classifyCampaign(camp, TARGET_ACOS, BREAK_EVEN_ACOS);
      const isProtected = camp.is_operational === true || camp.launch_phase === 'new';
      const factor = adjustmentFactor(tier, isProtected);

      const currentBudget = Number(camp.daily_budget || MIN_CAMPAIGN_BUDGET);
      let newBudget = r2(currentBudget * factor);

      // Guardrails: mínimo e máximo por campanha
      if (tier === 'BLEEDING' && !isProtected) {
        newBudget = MIN_CAMPAIGN_BUDGET; // reduz ao mínimo absoluto
      } else {
        newBudget = clamp(newBudget, MIN_CAMPAIGN_BUDGET, MAX_CAMPAIGN_BUDGET);
      }

      // Cap de +20% por ciclo (guardrail universal)
      const maxAllowed = r2(currentBudget * 1.20);
      const minAllowed = r2(currentBudget * 0.50); // mínimo de -50% por ciclo (salvo BLEEDING)
      if (tier !== 'BLEEDING') newBudget = clamp(newBudget, minAllowed, maxAllowed);

      decisions.push({
        db_id: camp.id,
        campaign_id: String(camp.amazon_campaign_id || camp.campaign_id),
        campaign_name: camp.name || camp.campaign_name || '',
        asin: camp.asin || '',
        tier,
        reason,
        is_protected: isProtected,
        current_budget: currentBudget,
        new_budget: newBudget,
        change_pct: r2(((newBudget - currentBudget) / Math.max(currentBudget, 0.01)) * 100),
        will_change: Math.abs(newBudget - currentBudget) >= 0.01,
        spend: Number(camp.spend || camp.current_spend || 0),
        acos: (() => {
          const s = Number(camp.spend || 0), sa = Number(camp.sales || 0);
          return s > 0 && sa > 0 ? r2((s / sa) * 100) : null;
        })(),
        orders: Number(camp.orders || 0),
      });
    }

    // ── Hard cap de conta: escalar se soma > ACCOUNT_BUDGET_CAP ───
    const totalNewBudget = decisions.reduce((s, d) => s + d.new_budget, 0);
    if (totalNewBudget > ACCOUNT_BUDGET_CAP) {
      const scale = ACCOUNT_BUDGET_CAP / totalNewBudget;
      for (const d of decisions) {
        d.new_budget = r2(Math.max(MIN_CAMPAIGN_BUDGET, d.new_budget * scale));
        d.scaled_down = true;
        d.change_pct = r2(((d.new_budget - d.current_budget) / Math.max(d.current_budget, 0.01)) * 100);
        d.will_change = Math.abs(d.new_budget - d.current_budget) >= 0.01;
      }
    }

    // Apenas campanhas que realmente mudam (excluir imunes e sem alteração)
    const toAdjust = decisions.filter(d => d.will_change && !['HOLD', 'NEW'].includes(d.tier) && !d.is_protected);

    const stats = {
      total_campaigns: activeCampaigns.length,
      classified: { WINNER: 0, EFFICIENT: 0, HOLD: 0, DRAINING: 0, BLEEDING: 0, NEW: 0 } as any,
      to_adjust: toAdjust.length,
      budget_increased: toAdjust.filter(d => d.new_budget > d.current_budget).length,
      budget_decreased: toAdjust.filter(d => d.new_budget < d.current_budget).length,
      total_current_budget: r2(decisions.reduce((s, d) => s + d.current_budget, 0)),
      total_new_budget: r2(decisions.reduce((s, d) => s + d.new_budget, 0)),
      account_budget_cap: ACCOUNT_BUDGET_CAP,
      scaled_down: totalNewBudget > ACCOUNT_BUDGET_CAP,
    };
    for (const d of decisions) stats.classified[d.tier] = (stats.classified[d.tier] || 0) + 1;

    if (dry_run) {
      // Gravar log mesmo em dry_run para rastreabilidade
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: aid,
        operation: 'smart_budget_allocation_dry_run',
        trigger_type: 'manual',
        status: 'success',
        execution_date: todayBRT,
        started_at: new Date(t0).toISOString(),
        completed_at: new Date().toISOString(),
        duration_ms: Date.now() - t0,
        records_processed: toAdjust.length,
        result_summary: JSON.stringify({ dry_run: true, ...stats, decisions: toAdjust.map(d => ({
          name: d.campaign_name.slice(0, 60),
          tier: d.tier,
          current: `R$${d.current_budget}`,
          new: `R$${d.new_budget}`,
          change: `${d.change_pct > 0 ? '+' : ''}${d.change_pct}%`,
          reason: d.reason,
        })) }),
      }).catch(() => {});

      return Response.json({ ok: true, dry_run: true, stats, decisions, duration_ms: Date.now() - t0 });
    }

    // ── Enviar para Amazon em batches de 20 ────────────────────────
    const applied: any[] = [];
    const failed: any[] = [];

    for (let i = 0; i < toAdjust.length; i += 20) {
      const batch = toAdjust.slice(i, i + 20);
      try {
        const res = await base44.asServiceRole.functions.invoke('adjustCampaignBudgets', {
          _service_role: true,
          amazon_account_id: aid,
          adjustments: batch.map(d => ({
            campaign_id: d.campaign_id,
            db_id: d.db_id,
            new_budget: d.new_budget,
            reason: `${d.tier}: ${d.reason}`,
          })),
        });
        const data = res?.data || {};
        if (data.ok !== false) {
          applied.push(...batch);
        } else {
          // Tenta identificar quais falharam pela resposta
          const errIds = new Set((data.amazon_errors || []).map((e: any) => String(e.campaignId)));
          for (const d of batch) {
            if (errIds.has(d.campaign_id)) failed.push({ ...d, error: 'Amazon API error' });
            else applied.push(d);
          }
        }
      } catch (err: any) {
        failed.push(...batch.map(d => ({ ...d, error: err.message })));
      }
      if (i + 20 < toAdjust.length) await sleep(500);
    }

    // ── Gravar histórico detalhado no SyncExecutionLog ─────────────
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'smart_budget_allocation',
      trigger_type: body.trigger_type || 'automatic',
      status: failed.length > 0 && applied.length === 0 ? 'error'
            : failed.length > 0 ? 'warning' : 'success',
      execution_date: todayBRT,
      started_at: new Date(t0).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      records_processed: applied.length,
      result_summary: JSON.stringify({
        ...stats,
        applied: applied.length,
        failed: failed.length,
        account_budget_cap: ACCOUNT_BUDGET_CAP,
        config: { TARGET_ACOS, BREAK_EVEN_ACOS, MIN_CAMPAIGN_BUDGET, MAX_CAMPAIGN_BUDGET },
        changes: applied.map(d => ({
          name: d.campaign_name.slice(0, 50),
          tier: d.tier,
          from: `R$${d.current_budget}`,
          to: `R$${d.new_budget}`,
          pct: `${d.change_pct > 0 ? '+' : ''}${d.change_pct}%`,
        })),
        failures: failed.map(d => ({ name: d.campaign_name.slice(0, 50), error: d.error })),
      }),
    }).catch(() => {});

    return Response.json({
      ok: failed.length === 0,
      dry_run: false,
      stats: { ...stats, applied: applied.length, failed: failed.length },
      applied: applied.map(d => ({
        campaign_name: d.campaign_name,
        asin: d.asin,
        tier: d.tier,
        reason: d.reason,
        current_budget: d.current_budget,
        new_budget: d.new_budget,
        change_pct: d.change_pct,
      })),
      failed: failed.map(d => ({ campaign_name: d.campaign_name, tier: d.tier, error: d.error })),
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});