/**
 * applyBiddingStrategyByCampaign — Motor de Bidding Strategy automático para campanhas MANUAL SP
 *
 * Matriz de decisão:
 * ┌─────────────────────────┬──────────────────────────────────┐
 * │ Fase / ACoS             │ Estratégia                       │
 * ├─────────────────────────┼──────────────────────────────────┤
 * │ new ou learning         │ Down Only (legacyForSales)        │
 * │ optimizing/stable       │                                   │
 * │   + ACoS < target       │ Up & Down (autoForSales)          │
 * │   + ACoS >= target      │ Down Only (legacyForSales)        │
 * │ sem dados (spend < R$5) │ Down Only (legacyForSales)        │
 * │ novo < 48h sem ACoS     │ Fixed (manual)                    │
 * └─────────────────────────┴──────────────────────────────────┘
 *
 * Multiplicador Top of Search:
 *   - Se ACoS < target E fase >= optimizing:
 *     boost = clamp(20 + (target_acos - current_acos) / target_acos * 30, 20, 50)
 *   - Caso contrário: 0%
 *
 * Cooldown: 24h por campanha (via CampaignChangeHistory idempotency_key)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function daysSince(dateStr: string | null | undefined): number {
  if (!dateStr) return 0;
  const ts = new Date(dateStr).getTime();
  if (!Number.isFinite(ts)) return 0;
  return Math.max(0, (Date.now() - ts) / 86400000);
}

// Mapeamento para API v3 da Amazon
const STRATEGY_MAP: Record<string, string> = {
  'down_only':  'LEGACY_FOR_SALES',    // Down Only
  'up_and_down': 'AUTO_FOR_SALES',     // Up & Down
  'fixed':      'MANUAL',              // Fixed
};

type Strategy = 'down_only' | 'up_and_down' | 'fixed';

function classifyStrategy(campaign: any, targetAcos: number): { strategy: Strategy; tosBoost: number; reason: string } {
  const phase      = campaign.launch_phase || 'new';
  const spend      = Number(campaign.spend || campaign.current_spend || 0);
  const acos       = Number(campaign.acos || 0);
  const hoursSinceStart = daysSince(campaign.start_date || campaign.created_at) * 24;

  // Proteção: campanha novíssima (< 48h) sem dados de ACoS → Fixed
  if (hoursSinceStart < 48 && acos === 0) {
    return { strategy: 'fixed', tosBoost: 0, reason: 'Campanha com menos de 48h sem dados de ACoS — Fixed para não limitar visibilidade inicial.' };
  }

  // Sem dados suficientes (spend < R$5) → Down Only
  if (spend < 5) {
    return { strategy: 'down_only', tosBoost: 0, reason: `Dados insuficientes (gasto R$${spend.toFixed(2)} < R$5) — Down Only conservador.` };
  }

  // Fase new, learning ou não estabelecida → Down Only
  const conservativePhases = ['new', 'learning', 'under_review'];
  const aggressivePhases   = ['optimizing', 'stable', 'active'];
  if (conservativePhases.includes(phase) || !aggressivePhases.includes(phase)) {
    return { strategy: 'down_only', tosBoost: 0, reason: `Fase ${phase} — Down Only para proteger budget no aprendizado.` };
  }

  // Fase optimizing, stable ou active
  const hasGoodAcos = targetAcos > 0 && acos > 0 && acos < targetAcos;

  if (!hasGoodAcos) {
    const reason = targetAcos > 0 && acos >= targetAcos
      ? `ACoS ${acos.toFixed(1)}% >= meta ${targetAcos.toFixed(1)}% — Down Only para proteger margem.`
      : 'ACoS não disponível — Down Only conservador.';
    return { strategy: 'down_only', tosBoost: 0, reason };
  }

  // Up & Down + boost ToS proporcional
  const rawBoost = 20 + ((targetAcos - acos) / targetAcos) * 30;
  const tosBoost = Math.round(Math.min(Math.max(rawBoost, 20), 50));
  return {
    strategy: 'up_and_down',
    tosBoost,
    reason: `Fase ${phase}, ACoS ${acos.toFixed(1)}% < meta ${targetAcos.toFixed(1)}% — Up & Down com boost ToS ${tosBoost}%.`,
  };
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false } = body;

    // ── Resolver conta ───────────────────────────────────────────────────
    let account: any;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
      account = accs[0];
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: true, skipped: true, reason: 'Nenhuma conta conectada' });

    const accountId = account.id;
    const now = new Date().toISOString();
    const today = now.slice(0, 10);

    // ── target_acos via PerformanceSettings ─────────────────────────────
    const perfSettings = await base44.asServiceRole.entities.PerformanceSettings.filter(
      { amazon_account_id: accountId }, null, 1
    ).catch(() => []);
    const targetAcos = Number(perfSettings[0]?.target_acos || 15);

    // ── Campanhas MANUAL SP habilitadas ──────────────────────────────────
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: accountId }, '-spend', 1000
    );
    const candidates = allCampaigns.filter((c: any) =>
      (c.state || c.status) === 'enabled' &&
      c.archived !== true &&
      c.targeting_type === 'MANUAL' &&
      c.campaign_type === 'SP' &&
      (c as any).ads_protected !== true
    );

    // ── Cooldown: campanhas já atualizadas hoje ───────────────────────────
    const recentChanges = await base44.asServiceRole.entities.CampaignChangeHistory.filter(
      { amazon_account_id: accountId, change_type: 'bidding_strategy_auto' },
      '-created_date', 500
    ).catch(() => []);
    const updatedToday = new Set<string>(
      recentChanges
        .filter((ch: any) => (ch.created_at || ch.created_date || '').slice(0, 10) === today)
        .map((ch: any) => ch.campaign_id)
    );

    const results: any[] = [];
    let applied = 0;
    let skipped_cooldown = 0;
    let skipped_protected = 0;
    let errors = 0;

    for (const campaign of candidates) {
      const camId = campaign.campaign_id || campaign.id;

      // Cooldown 24h
      if (updatedToday.has(camId)) {
        skipped_cooldown++;
        continue;
      }

      const { strategy, tosBoost, reason } = classifyStrategy(campaign, targetAcos);

      // Verificar se houve mudança efetiva
      const prevStrategy = campaign.bidding_strategy || '';
      const prevTos = Number(campaign.top_of_search_adjustment || 0);

      // Mapear estratégia salva localmente para nossa nomenclatura
      const prevStrategyNorm = prevStrategy.includes('AUTO') || prevStrategy === 'up_and_down' ? 'up_and_down'
        : prevStrategy === 'manual' || prevStrategy === 'fixed' ? 'fixed'
        : 'down_only';

      const noChange = prevStrategyNorm === strategy && prevTos === tosBoost;

      if (dry_run) {
        results.push({
          campaign_id: camId,
          name: campaign.name || campaign.campaign_name,
          phase: campaign.launch_phase,
          acos: campaign.acos,
          target_acos: targetAcos,
          strategy,
          tos_boost: tosBoost,
          prev_strategy: prevStrategyNorm,
          prev_tos: prevTos,
          change: !noChange,
          reason,
        });
        continue;
      }

      if (noChange) {
        results.push({ campaign_id: camId, status: 'no_change', strategy, tos_boost: tosBoost });
        continue;
      }

      // ── PUT /sp/campaigns (bidding strategy) via amazonAdsCommand ───────
      const amazonStrategyCode = STRATEGY_MAP[strategy];
      const campaignPutRes = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
        _service_role: true,
        amazon_account_id: accountId,
        path: '/sp/campaigns',
        method: 'PUT',
        content_type: 'application/vnd.spCampaign.v3+json',
        payload: {
          campaigns: [{
            campaignId: campaign.amazon_campaign_id || camId,
            dynamicBidding: { strategy: amazonStrategyCode },
          }],
        },
      }).catch((e: any) => ({ ok: false, error: e.message }));

      const strategyOk = (campaignPutRes as any)?.ok === true || (campaignPutRes as any)?.status === 207;

      // ── PUT /sp/campaigns (Top of Search placement) ──────────────────────
      let tosOk = true;
      if (strategyOk) {
        const tosPutRes = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
          _service_role: true,
          amazon_account_id: accountId,
          path: '/sp/campaigns',
          method: 'PUT',
          content_type: 'application/vnd.spCampaign.v3+json',
          payload: {
            campaigns: [{
              campaignId: campaign.amazon_campaign_id || camId,
              placement: {
                placementBidAdjustment: [
                  { predicate: 'PLACEMENT_TOP', percentage: tosBoost },
                ],
              },
            }],
          },
        }).catch(() => ({ ok: false }));
        tosOk = (tosPutRes as any)?.ok === true || (tosPutRes as any)?.status === 207;
        await sleep(300);
      }

      if (!strategyOk) {
        errors++;
        results.push({ campaign_id: camId, status: 'error_amazon', error: JSON.stringify(campaignPutRes).slice(0, 200) });
        continue;
      }

      // ── Persistir localmente ─────────────────────────────────────────────
      await base44.asServiceRole.entities.Campaign.update(campaign.id, {
        bidding_strategy: strategy,
        top_of_search_adjustment: tosBoost,
        last_activity_at: now,
      }).catch(() => {});

      // ── Registrar CampaignChangeHistory ──────────────────────────────────
      await base44.asServiceRole.entities.CampaignChangeHistory.create({
        amazon_account_id: accountId,
        campaign_id: camId,
        asin: campaign.asin,
        change_type: 'bidding_strategy_auto',
        field_changed: 'bidding_strategy + top_of_search_adjustment',
        old_value: `${prevStrategyNorm} / ToS ${prevTos}%`,
        new_value: `${strategy} / ToS ${tosBoost}%`,
        reason,
        acos_at_change: campaign.acos || 0,
        target_acos_at_change: targetAcos,
        multiplier_applied: tosBoost,
        applied_at: now,
        created_at: now,
        source: 'applyBiddingStrategyByCampaign',
      }).catch(() => {});

      applied++;
      results.push({
        campaign_id: camId,
        name: campaign.name || campaign.campaign_name,
        status: 'applied',
        strategy,
        tos_boost: tosBoost,
        prev_strategy: prevStrategyNorm,
        prev_tos: prevTos,
        reason,
        tos_api_ok: tosOk,
      });

      await sleep(200); // throttle entre campanhas
    }

    return Response.json({
      ok: true,
      dry_run,
      target_acos: targetAcos,
      evaluated: candidates.length,
      applied,
      skipped_cooldown,
      skipped_protected,
      errors,
      results,
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});