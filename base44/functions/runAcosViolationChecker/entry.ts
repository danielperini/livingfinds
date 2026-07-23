/**
 * runAcosViolationChecker v2
 *
 * Ciclo 1 — 1ª violação (ACoS > max_acos):
 *   → Registra status='optimizing', dispara reduções de bid e dayparting (fire-and-forget)
 *   → Grava optimization_cooldown_until = now + 2 dias
 *   → NÃO pausa ainda
 *
 * Ciclo 2 — 2ª violação consecutiva:
 *   → Se cooldown ainda não passou → adia (status='warning')
 *   → Se cooldown passou → avalia pausa com thresholds diferenciados:
 *       MANUAL: pausa se ACoS > max_acos
 *       AUTO com orders > 0: pausa apenas se ACoS > max_acos × 1.5
 *       AUTO sem conversões: pausa se spend ≥ min_spend × 3
 *
 * Proteção winner: qualquer campanha com orders_14d > 0 E acos_14d ≤ target_acos → nunca pausa.
 * Métricas: CampaignMetricsDaily (mais confiável que SearchTerm).
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.38';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function adsBase(region: string | undefined) {
  const v = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (v.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (v.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getToken(account: any) {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: account.ads_refresh_token,
      client_id: Deno.env.get('ADS_CLIENT_ID') || '',
      client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || 'Falha no token');
  return data.access_token;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user || user.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });
    }

    const accountId = body.amazon_account_id;
    if (!accountId) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });

    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: accountId }, null, 1);
    const config = configs[0] || {};

    const TARGET_ACOS = config.target_acos || config.acos_target || 25;
    const MAX_ACOS = config.maximum_acos || 45;
    const MIN_SPEND = config.min_spend_for_decision || 5;
    const CONSECUTIVE_CYCLES_TO_PAUSE = 2; // reduzido de 3 para 2
    const COOLDOWN_DAYS = 2;

    const now = new Date().toISOString();
    const nowMs = Date.now();

    // ── 1. Calcular métricas da semana por campanha via CampaignMetricsDaily ──
    const weekStart = new Date(nowMs - 10 * 86400000).toISOString().slice(0, 10);
    const attributionCutoff = new Date(nowMs - 3 * 86400000).toISOString().slice(0, 10);

    const dailyMetrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: accountId }, '-date', 5000
    );

    // Agregar por campaign_id dentro da janela
    const weekMetrics = new Map<string, { spend: number; sales: number; orders: number; clicks: number }>();
    for (const row of dailyMetrics) {
      if (!row.campaign_id || !row.date) continue;
      if (row.date > attributionCutoff || row.date < weekStart) continue;
      if (!weekMetrics.has(row.campaign_id)) {
        weekMetrics.set(row.campaign_id, { spend: 0, sales: 0, orders: 0, clicks: 0 });
      }
      const m = weekMetrics.get(row.campaign_id)!;
      m.spend  += row.spend  || 0;
      m.sales  += row.sales  || 0;
      m.orders += row.orders || 0;
      m.clicks += row.clicks || 0;
    }

    // ── 2. Carregar campanhas ativas e violations existentes ──────────────
    const [allCampaigns, existingViolations] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, null, 2000),
      base44.asServiceRole.entities.CampaignAcosViolation.filter({ amazon_account_id: accountId }, null, 2000),
    ]);

    const violationMap = new Map<string, any>(existingViolations.map((v: any) => [v.campaign_id, v]));

    const activeCampaigns = allCampaigns.filter((c: any) => {
      const st = (c.state || c.status || '').toLowerCase();
      return st === 'enabled' && !c.archived;
    });

    const stats = {
      campaigns_evaluated: activeCampaigns.length,
      new_violations: 0,
      violations_reset: 0,
      optimizations_triggered: 0,
      cooldown_deferred: 0,
      warnings_issued: 0,
      campaigns_paused: 0,
      winner_protected: 0,
      amazon_calls: 0,
      errors: 0,
    };

    const pausedList: any[] = [];
    const warningList: any[] = [];
    const optimizingList: any[] = [];
    const campaignsToPauseAmazon: string[] = [];

    for (const camp of activeCampaigns) {
      const cid = String(camp.campaign_id || camp.id || '');
      if (!cid) continue;

      // Tentar ambos os IDs (campaign_id Amazon e id interno)
      const metrics = weekMetrics.get(cid) || weekMetrics.get(String(camp.id || ''));
      if (!metrics || metrics.spend < MIN_SPEND) continue;

      const weekAcos = metrics.sales > 0
        ? (metrics.spend / metrics.sales) * 100
        : (metrics.spend > 0 ? 999 : 0);

      const isAuto = String(camp.targeting_type || '').toUpperCase().includes('AUTO');
      const existing = violationMap.get(cid);
      const prevViolations = existing?.consecutive_violations || 0;
      const isViolating = weekAcos > MAX_ACOS;

      // ── Proteção winner: orders_14d > 0 AND acos_14d ≤ target_acos ─────
      const orders14d = camp.orders || 0;
      const acos14d = camp.acos || 0;
      if (orders14d > 0 && acos14d > 0 && acos14d <= TARGET_ACOS) {
        // Campanha vencedora — garantir que violation está limpa
        if (existing && existing.status !== 'exempt' && prevViolations > 0) {
          await base44.asServiceRole.entities.CampaignAcosViolation.update(existing.id, {
            status: 'exempt',
            notes: `Winner protection: ${orders14d} pedidos, ACoS ${acos14d.toFixed(1)}% ≤ target ${TARGET_ACOS}%`,
          }).catch(() => {});
        }
        stats.winner_protected++;
        continue;
      }

      // ── Resetar se voltou à meta ─────────────────────────────────────────
      if (!isViolating && existing && prevViolations > 0) {
        await base44.asServiceRole.entities.CampaignAcosViolation.update(existing.id, {
          consecutive_violations: 0,
          status: 'recovered',
          reset_at: now,
          bids_reduced: false,
          dayparting_evaluated: false,
          optimization_attempted_at: null,
          optimization_cooldown_until: null,
          notes: `ACoS ${weekAcos.toFixed(1)}% voltou abaixo do máximo ${MAX_ACOS}% em ${now.slice(0, 10)}`,
        });
        stats.violations_reset++;
        continue;
      }

      if (!isViolating) continue;

      // ── Registrar nova violação ─────────────────────────────────────────
      const newCount = prevViolations + 1;
      const cycleFields: any = {
        amazon_account_id: accountId,
        campaign_id: cid,
        campaign_name: camp.name || camp.campaign_name || cid,
        campaign_type: isAuto ? 'AUTO' : 'MANUAL',
        asin: camp.asin || '',
        consecutive_violations: newCount,
        target_acos: TARGET_ACOS,
        maximum_acos: MAX_ACOS,
        last_violation_at: now,
      };

      if (newCount === 1) {
        // ── CICLO 1: otimizar, não pausar ───────────────────────────────
        const cooldownUntil = new Date(nowMs + COOLDOWN_DAYS * 86400000).toISOString();
        cycleFields.acos_cycle_1 = weekAcos;
        cycleFields.spend_cycle_1 = metrics.spend;
        cycleFields.first_violation_at = now;
        cycleFields.status = 'optimizing';
        cycleFields.optimization_attempted_at = now;
        cycleFields.optimization_cooldown_until = cooldownUntil;
        cycleFields.bids_reduced = true;
        cycleFields.dayparting_evaluated = true;

        // Fire-and-forget: redução de bids
        base44.asServiceRole.functions.invoke('runDeterministicDecisionEngine', {
          amazon_account_id: accountId,
          campaign_filter: [cid],
          _service_role: true,
        }).catch(() => {});

        // Fire-and-forget: análise de dayparting
        base44.asServiceRole.functions.invoke('runDailyDayparting', {
          amazon_account_id: accountId,
          campaign_id: cid,
          _service_role: true,
        }).catch(() => {});

        optimizingList.push({
          campaign_id: cid,
          name: camp.name || camp.campaign_name,
          type: isAuto ? 'AUTO' : 'MANUAL',
          acos: weekAcos,
          cooldown_until: cooldownUntil,
        });
        stats.optimizations_triggered++;

      } else {
        // ── CICLO 2+: verificar cooldown ────────────────────────────────
        cycleFields.acos_cycle_2 = weekAcos;
        cycleFields.spend_cycle_2 = metrics.spend;

        const cooldownUntil = existing?.optimization_cooldown_until;
        const cooldownPassed = !cooldownUntil || new Date(cooldownUntil).getTime() <= nowMs;

        if (!cooldownPassed) {
          // Cooldown ainda ativo — adiar decisão de pausa
          cycleFields.status = 'warning';
          warningList.push({
            campaign_id: cid,
            name: camp.name || camp.campaign_name,
            type: isAuto ? 'AUTO' : 'MANUAL',
            acos: weekAcos,
            cycles: newCount,
            cooldown_until: cooldownUntil,
            reason: 'cooldown_active',
          });
          stats.cooldown_deferred++;
        } else {
          // ── Cooldown passou — avaliar pausa ──────────────────────────
          let shouldPause = false;
          let pauseReason = '';

          if (isAuto) {
            if (weekAcos > MAX_ACOS * 1.5) {
              shouldPause = true;
              pauseReason = `AUTO: ACoS ${weekAcos.toFixed(0)}% extremamente acima do máximo (${(MAX_ACOS * 1.5).toFixed(0)}%) após ${newCount} ciclos + otimização sem efeito`;
            } else if (metrics.orders === 0 && metrics.spend >= MIN_SPEND * 3) {
              shouldPause = true;
              pauseReason = `AUTO: ${newCount} ciclos consecutivos sem conversão, gasto R$${metrics.spend.toFixed(2)}`;
            }
          } else {
            // MANUAL: pausa direta após cooldown
            shouldPause = true;
            pauseReason = `MANUAL: ACoS ${weekAcos.toFixed(0)}% > ${MAX_ACOS}% após ${newCount} ciclos consecutivos. Otimização tentada em ${existing?.optimization_attempted_at?.slice(0, 10) || 'ciclo anterior'} sem recuperação.`;
          }

          if (shouldPause) {
            cycleFields.status = 'paused';
            campaignsToPauseAmazon.push(cid);
            pausedList.push({
              campaign_id: cid,
              name: camp.name || camp.campaign_name,
              type: isAuto ? 'AUTO' : 'MANUAL',
              acos: weekAcos,
              cycles: newCount,
              reason: pauseReason,
            });
          } else {
            cycleFields.status = 'warning';
            warningList.push({
              campaign_id: cid,
              name: camp.name || camp.campaign_name,
              type: isAuto ? 'AUTO' : 'MANUAL',
              acos: weekAcos,
              cycles: newCount,
              reason: 'auto_threshold_not_met',
            });
            stats.warnings_issued++;
          }
        }
      }

      if (existing) {
        await base44.asServiceRole.entities.CampaignAcosViolation.update(existing.id, cycleFields);
      } else {
        await base44.asServiceRole.entities.CampaignAcosViolation.create(cycleFields);
      }
      stats.new_violations++;
    }

    // ── 3. Batch guard: não pausar > 30% das campanhas ativas de uma vez ─
    const maxPauseAllowed = Math.floor(activeCampaigns.length * 0.30);
    if (campaignsToPauseAmazon.length > maxPauseAllowed) {
      const excess = campaignsToPauseAmazon.splice(maxPauseAllowed);
      // Marcar excedentes como warning ao invés de pausar
      for (const cid of excess) {
        const viol = violationMap.get(cid);
        if (viol) {
          await base44.asServiceRole.entities.CampaignAcosViolation.update(viol.id, {
            status: 'warning',
            notes: `Pausa adiada: batch_guard ativado (máx ${maxPauseAllowed} campanhas por execução)`,
          }).catch(() => {});
        }
        const entry = pausedList.find(p => p.campaign_id === cid);
        if (entry) { entry.deferred_batch_guard = true; warningList.push({ ...entry, reason: 'batch_guard' }); }
      }
    }

    // ── 4. Pausar na Amazon em lotes de 50 ───────────────────────────────
    if (campaignsToPauseAmazon.length > 0) {
      const token = await getToken(account);
      const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
      const baseUrl = adsBase(account.region);
      const authHeaders = {
        Authorization: `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
        'Amazon-Advertising-API-Scope': String(profileId),
        'Content-Type': 'application/vnd.spCampaign.v3+json',
        Accept: 'application/vnd.spCampaign.v3+json',
      };

      for (let i = 0; i < campaignsToPauseAmazon.length; i += 50) {
        const batch = campaignsToPauseAmazon.slice(i, i + 50);
        const payload = { campaigns: batch.map(cid => ({ campaignId: cid, state: 'PAUSED' })) };

        const res = await fetch(`${baseUrl}/sp/campaigns`, {
          method: 'PUT',
          headers: authHeaders,
          body: JSON.stringify(payload),
        });
        stats.amazon_calls++;
        const text = await res.text().catch(() => '');
        let parsed: any = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch {}
        const ok = res.status >= 200 && res.status < 300 || res.status === 207;

        for (const cid of batch) {
          const pausedEntry = pausedList.find(p => p.campaign_id === cid);
          if (ok) {
            await base44.asServiceRole.entities.Campaign.updateMany(
              { amazon_account_id: accountId, campaign_id: cid },
              { $set: { state: 'PAUSED', status: 'paused', paused_by_acos_violation: true, pause_reason: pausedEntry?.reason || '', paused_at: now } }
            ).catch(() => {});
            const viol = violationMap.get(cid);
            if (viol) {
              await base44.asServiceRole.entities.CampaignAcosViolation.update(viol.id, {
                status: 'paused',
                paused_at: now,
                pause_reason: pausedEntry?.reason || '',
              }).catch(() => {});
            }
            stats.campaigns_paused++;
          } else {
            stats.errors++;
          }
        }
        await wait(2000);
      }
    }

    // ── 5. Registrar execução ─────────────────────────────────────────────
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'runAcosViolationChecker',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: 'completed',
      started_at: now,
      completed_at: new Date().toISOString(),
      result_summary: JSON.stringify({
        evaluated: stats.campaigns_evaluated,
        new_violations: stats.new_violations,
        optimizations_triggered: stats.optimizations_triggered,
        cooldown_deferred: stats.cooldown_deferred,
        warnings: stats.warnings_issued,
        paused: stats.campaigns_paused,
        winner_protected: stats.winner_protected,
        reset: stats.violations_reset,
      }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      stats,
      paused: pausedList,
      optimizing: optimizingList,
      warnings: warningList,
      config_used: { TARGET_ACOS, MAX_ACOS, CONSECUTIVE_CYCLES_TO_PAUSE, COOLDOWN_DAYS },
      ran_at: now,
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err?.message || 'Erro inesperado' }, { status: 500 });
  }
});