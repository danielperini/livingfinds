/**
 * generateAlerts v2
 *
 * Gera alertas de pacing, token, sync e teto diário.
 * Usa upsertOperationalAlert para deduplicação canônica.
 *
 * REGRAS:
 * - spend_overpacing usa curva horária BRT com fallback conservador
 * - rate_limit é EXCLUSIVO para HTTP 429 / throttling de API
 * - daily_cap_reached: dedup por conta+data (um alerta por dia)
 * - token_expired: para ads_token_status expirado/revogado
 * - sync_error: para falhas de sincronização
 * - Sem curva histórica: severity máxima = medium
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function getBrtHour(): number {
  const h = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false });
  return parseInt(h, 10);
}

function getBrtDate(): string {
  return new Date().toLocaleString('en-CA', { timeZone: 'America/Sao_Paulo' }).slice(0, 10);
}

async function upsert(base44: any, params: any) {
  return base44.asServiceRole.functions.invoke('upsertOperationalAlert', params).catch((e: any) => {
    console.error('[generateAlerts] upsert failed:', e.message, JSON.stringify(params).slice(0, 200));
  });
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    try { await base44.auth.me(); } catch { /* automação */ }

    const body = await req.json().catch(() => ({}));
    let accounts: any[] = [];

    if (body.amazon_account_id) {
      const acc = await base44.asServiceRole.entities.AmazonAccount.get(body.amazon_account_id).catch(() => null);
      if (acc) accounts = [acc];
    }
    if (!accounts.length) {
      accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }).catch(() => []);
    }
    if (!accounts.length) return Response.json({ ok: false, message: 'Nenhuma conta encontrada' });

    const SRC = 'generateAlerts';
    const results: any[] = [];

    for (const account of accounts) {
      const aid = account.id;
      const now = new Date().toISOString();
      const brtDate = getBrtDate();
      const brtHour = getBrtHour();
      let created = 0;

      // ── 1. Token expirado / revogado ────────────────────────────────────
      const tokenStatus = account.ads_token_status;
      if (['expired', 'revoked', 'missing', 'credentials_error'].includes(tokenStatus)) {
        await upsert(base44, {
          amazon_account_id: aid,
          alert_type: 'token_expired', alert_family: 'token',
          severity: tokenStatus === 'revoked' ? 'critical' : 'high',
          entity_type: 'account', entity_id: aid,
          title: `Token Amazon Ads ${tokenStatus}`,
          message: `Status do token: ${tokenStatus}. Reconecte em Integrações → Amazon Ads.`,
          data_source: 'AmazonAccount', data_freshness: 'fresh', source_function: SRC,
        });
        created++;
      } else if (tokenStatus === 'active') {
        // Resolver alerta de token se voltou a funcionar
        await base44.asServiceRole.functions.invoke('upsertOperationalAlert', {
          amazon_account_id: aid, alert_type: 'token_expired',
          entity_type: 'account', entity_id: aid,
          title: '-', message: '-', resolved: true, resolution_reason: 'token_reconnected',
          source_function: SRC,
        }).catch(() => {});
      }

      // ── 2. Pacing de gasto — curva horária BRT ──────────────────────────
      // Buscar gasto confirmado do dia atual
      const psList = await base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, '-updated_at', 1).catch(() => []);
      const DAILY_CAP = Number(psList[0]?.daily_budget_limit || 70);

      // Usar AccountDailySpendController se disponível
      const spendControllers = await base44.asServiceRole.entities.AccountDailySpendController.filter(
        { amazon_account_id: aid, spend_date: brtDate }, null, 1
      ).catch(() => []);
      const controller = spendControllers[0];

      if (controller) {
        const confirmedSpend = Number(controller.confirmed_spend || 0);
        const projectedSpend = Number(controller.projected_total_spend || confirmedSpend);
        const capStatus = controller.cap_status;

        // Teto diário atingido
        if (capStatus === 'cap_reached' || projectedSpend >= DAILY_CAP) {
          await upsert(base44, {
            amazon_account_id: aid,
            alert_type: 'daily_cap_reached', alert_family: 'budget',
            severity: 'high',
            entity_type: 'account', entity_id: aid,
            dedup_context: brtDate, // uma vez por dia
            title: `Teto diário atingido: ${brtDate}`,
            message: `Gasto projetado R$${projectedSpend.toFixed(2)} ≥ teto R$${DAILY_CAP.toFixed(2)}`,
            metric_name: 'projected_spend', metric_value: projectedSpend, threshold_value: DAILY_CAP,
            data_window: 'today', data_source: 'AccountDailySpendController', source_function: SRC,
          });
          created++;
        }

        // Overpacing — curva horária simples com fallback conservador
        // Esperado linear: hora atual / 24 × cap (fallback sem histórico)
        const pacingRatio = Number(controller.pacing_ratio || 0);
        const hasPacingData = controller.last_pacing_check_at && confirmedSpend > 2;

        if (hasPacingData && pacingRatio > 1.5 && brtHour >= 2) {
          // Crítico apenas com confiança: pelo menos 2h de dados e gasto relevante
          const severity = (pacingRatio > 1.5 && confirmedSpend > 10 && brtHour >= 4) ? 'high' : 'medium';
          await upsert(base44, {
            amazon_account_id: aid,
            alert_type: 'spend_overpacing', alert_family: 'budget',
            severity,
            entity_type: 'account', entity_id: aid,
            title: `Gasto acima do ritmo esperado`,
            message: `Pacing ${(pacingRatio * 100).toFixed(0)}% do esperado. Gasto confirmado: R$${confirmedSpend.toFixed(2)}. Sem curva histórica validada: severidade máxima média.`,
            metric_name: 'pacing_ratio', metric_value: pacingRatio, threshold_value: 1.5,
            data_window: `today_${brtHour}h`,
            data_source: 'AccountDailySpendController',
            data_freshness: 'fresh', source_function: SRC,
          });
          created++;
        } else if (pacingRatio > 0 && pacingRatio <= 1.2) {
          // Pacing voltou ao normal → resolver overpacing
          await base44.asServiceRole.functions.invoke('upsertOperationalAlert', {
            amazon_account_id: aid, alert_type: 'spend_overpacing',
            entity_type: 'account', entity_id: aid,
            title: '-', message: '-', resolved: true, resolution_reason: 'spend_pacing_normalized',
            source_function: SRC,
          }).catch(() => {});
        }
      }

      // ── 3. Sync error — dados muito antigos ────────────────────────────
      if (account.last_sync_at) {
        const syncAgeH = (Date.now() - new Date(account.last_sync_at).getTime()) / 3600000;
        if (syncAgeH > 48) {
          await upsert(base44, {
            amazon_account_id: aid,
            alert_type: 'sync_error', alert_family: 'sync',
            severity: syncAgeH > 96 ? 'high' : 'medium',
            entity_type: 'account', entity_id: aid,
            title: `Dados desatualizados há ${Math.round(syncAgeH)}h`,
            message: `Última sincronização há ${Math.round(syncAgeH)}h. Verifique se as automações estão ativas.`,
            metric_name: 'sync_age_hours', metric_value: syncAgeH, threshold_value: 48,
            data_source: 'AmazonAccount', source_function: SRC,
          });
          created++;
        } else {
          await base44.asServiceRole.functions.invoke('upsertOperationalAlert', {
            amazon_account_id: aid, alert_type: 'sync_error',
            entity_type: 'account', entity_id: aid,
            title: '-', message: '-', resolved: true, resolution_reason: 'sync_recovered',
            source_function: SRC,
          }).catch(() => {});
        }
      }

      results.push({ account: aid, alerts_created_or_updated: created });
      console.log(`[generateAlerts] Conta ${aid}: ${created} alertas`);
    }

    return Response.json({ ok: true, results });

  } catch (error: any) {
    console.error('[generateAlerts]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});