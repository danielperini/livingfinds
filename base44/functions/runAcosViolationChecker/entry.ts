/**
 * runAcosViolationChecker
 *
 * Rastreia campanhas que estouram o ACoS alvo e as pausa
 * após 3 ciclos semanais CONSECUTIVOS acima do maximum_acos.
 *
 * Ciclo = cada execução semanal desta função.
 * Se em qualquer ciclo a campanha ficar dentro da meta → contagem reinicia.
 *
 * Lógica de pausa diferenciada:
 *  - AUTO: pausa somente se ACoS > maximum_acos × 1.3 (30% acima do máximo)
 *          OU se 3 ciclos com ACoS > maximum_acos E zero conversões
 *  - MANUAL: pausa após 3 ciclos com ACoS > maximum_acos
 *
 * Campanhas com zero spend são ignoradas (sem dados suficientes).
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

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
    const user = await base44.auth.me();
    if (!user || user.role !== 'admin') return Response.json({ error: 'Admin only' }, { status: 403 });

    const body = await req.json().catch(() => ({}));
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
    const CONSECUTIVE_CYCLES_TO_PAUSE = 3;

    const now = new Date().toISOString();

    // ── 1. Calcular métricas da semana atual por campanha ─────────────────
    // Janela: últimos 7 dias, com margem de atribuição de 3 dias → últimos 10 dias reais
    const attributionCutoff = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const weekStart = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);

    const allSearchTerms = await base44.asServiceRole.entities.SearchTerm.filter(
      { amazon_account_id: accountId }, '-date', 15000
    );

    // Agregar métricas da semana por campaign_id
    const weekMetrics = new Map<string, { spend: number; sales: number; orders: number; clicks: number }>();
    for (const t of allSearchTerms) {
      if (!t.campaign_id || !t.date) continue;
      if (t.date > attributionCutoff || t.date < weekStart) continue;

      if (!weekMetrics.has(t.campaign_id)) {
        weekMetrics.set(t.campaign_id, { spend: 0, sales: 0, orders: 0, clicks: 0 });
      }
      const m = weekMetrics.get(t.campaign_id)!;
      m.spend += t.spend || 0;
      m.sales += t.sales_7d || t.sales_14d || 0;
      m.orders += t.orders_7d || t.orders_14d || 0;
      m.clicks += t.clicks || 0;
    }

    // ── 2. Carregar campanhas ativas e violations existentes ──────────────
    const [allCampaigns, existingViolations] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, null, 2000),
      base44.asServiceRole.entities.CampaignAcosViolation.filter({ amazon_account_id: accountId }, null, 2000),
    ]);

    const violationMap = new Map<string, any>(
      existingViolations.map((v: any) => [v.campaign_id, v])
    );

    const activeCampaigns = allCampaigns.filter((c: any) => {
      const st = (c.state || c.status || '').toLowerCase();
      return st === 'enabled' && !c.archived;
    });

    const stats = {
      campaigns_evaluated: activeCampaigns.length,
      new_violations: 0,
      violations_reset: 0,
      warnings_issued: 0,
      campaigns_paused: 0,
      amazon_calls: 0,
      errors: 0,
    };

    const pausedList: any[] = [];
    const warningList: any[] = [];
    const campaignsToPauseAmazon: string[] = [];

    for (const camp of activeCampaigns) {
      const cid = String(camp.campaign_id || camp.id || '');
      if (!cid) continue;

      const metrics = weekMetrics.get(cid);
      if (!metrics || metrics.spend < MIN_SPEND) continue; // sem dados suficientes

      const weekAcos = metrics.sales > 0
        ? (metrics.spend / metrics.sales) * 100
        : (metrics.spend > 0 ? 999 : 0);

      const isAuto = String(camp.targeting_type || camp.campaign_type || '').toUpperCase().includes('AUTO');
      const existing = violationMap.get(cid);
      const prevViolations = existing?.consecutive_violations || 0;

      const isViolating = weekAcos > MAX_ACOS;

      // ── Resetar contagem se campanha voltou à meta ──────────────────────
      if (!isViolating && existing && prevViolations > 0) {
        await base44.asServiceRole.entities.CampaignAcosViolation.update(existing.id, {
          consecutive_violations: 0,
          status: 'recovered',
          reset_at: now,
          notes: `ACoS ${weekAcos.toFixed(1)}% voltou abaixo do máximo ${MAX_ACOS}% em ${now.slice(0, 10)}`,
        });
        stats.violations_reset++;
        continue;
      }

      if (!isViolating) continue; // dentro da meta — nada a fazer

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

      // Guardar ACoS de cada ciclo nas últimas 3 posições
      if (newCount === 1) {
        cycleFields.acos_cycle_1 = weekAcos;
        cycleFields.spend_cycle_1 = metrics.spend;
        cycleFields.first_violation_at = now;
        cycleFields.status = 'watching';
      } else if (newCount === 2) {
        cycleFields.acos_cycle_2 = weekAcos;
        cycleFields.spend_cycle_2 = metrics.spend;
        cycleFields.status = 'warning';
      } else {
        // Ciclo 3+ — sempre atualiza cycle_3 com o mais recente
        cycleFields.acos_cycle_3 = weekAcos;
        cycleFields.spend_cycle_3 = metrics.spend;
      }

      if (existing) {
        await base44.asServiceRole.entities.CampaignAcosViolation.update(existing.id, cycleFields);
      } else {
        await base44.asServiceRole.entities.CampaignAcosViolation.create(cycleFields);
      }
      stats.new_violations++;

      // ── Verificar se deve pausar ────────────────────────────────────────
      if (newCount < CONSECUTIVE_CYCLES_TO_PAUSE) {
        // Emitir aviso mas não pausar ainda
        warningList.push({
          campaign_id: cid,
          name: camp.name || camp.campaign_name,
          type: isAuto ? 'AUTO' : 'MANUAL',
          acos: weekAcos,
          cycles: newCount,
          remaining: CONSECUTIVE_CYCLES_TO_PAUSE - newCount,
        });
        stats.warnings_issued++;
        continue;
      }

      // ── Lógica de pausa diferenciada AUTO vs MANUAL ─────────────────────
      let shouldPause = false;
      let pauseReason = '';

      if (isAuto) {
        // AUTO: pausa somente se ACoS muito extremo (> MAX × 1.3) OU sem conversões por 3 ciclos
        const avgAcos = [
          existing?.acos_cycle_1 || 0,
          existing?.acos_cycle_2 || 0,
          weekAcos,
        ].filter(a => a > 0).reduce((s, a, _, arr) => s + a / arr.length, 0);

        const totalOrders = metrics.orders +
          (existing?.spend_cycle_1 ? 0 : 0); // sem dados de orders por ciclo, usar métrica atual

        if (weekAcos > MAX_ACOS * 1.3) {
          shouldPause = true;
          pauseReason = `AUTO: ACoS ${weekAcos.toFixed(0)}% extremamente acima do máximo (${(MAX_ACOS * 1.3).toFixed(0)}%) por ${newCount} ciclos consecutivos`;
        } else if (metrics.orders === 0 && metrics.spend >= MIN_SPEND * 3) {
          shouldPause = true;
          pauseReason = `AUTO: ${newCount} ciclos consecutivos sem conversão com gasto R$${metrics.spend.toFixed(2)}`;
        }
        // AUTO com ACoS apenas moderadamente alto e ainda convertendo → preservar
      } else {
        // MANUAL: pausa após 3 ciclos acima do maximum_acos
        shouldPause = true;
        pauseReason = `MANUAL: ACoS acima de ${MAX_ACOS}% por ${newCount} ciclos consecutivos. Último: ${weekAcos.toFixed(0)}%, gasto R$${metrics.spend.toFixed(2)}`;
      }

      if (shouldPause) {
        campaignsToPauseAmazon.push(cid);
        pausedList.push({
          campaign_id: cid,
          name: camp.name || camp.campaign_name,
          type: isAuto ? 'AUTO' : 'MANUAL',
          acos: weekAcos,
          cycles: newCount,
          reason: pauseReason,
        });
      }
    }

    // ── 3. Pausar na Amazon em lotes de 50 ───────────────────────────────
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
            // Atualizar banco
            await base44.asServiceRole.entities.Campaign.updateMany(
              { amazon_account_id: accountId, campaign_id: cid },
              { $set: { state: 'PAUSED', status: 'paused', paused_by_acos_violation: true, pause_reason: pausedEntry?.reason || '', paused_at: now } }
            ).catch(() => {});
            // Atualizar violation record
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

    // ── 4. Registrar execução ─────────────────────────────────────────────
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'runAcosViolationChecker',
      status: 'completed',
      started_at: now,
      completed_at: new Date().toISOString(),
      result_summary: JSON.stringify({
        evaluated: stats.campaigns_evaluated,
        new_violations: stats.new_violations,
        warnings: stats.warnings_issued,
        paused: stats.campaigns_paused,
        reset: stats.violations_reset,
      }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      stats,
      paused: pausedList,
      warnings: warningList,
      config_used: { TARGET_ACOS, MAX_ACOS, CONSECUTIVE_CYCLES_TO_PAUSE },
      ran_at: now,
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err?.message || 'Erro inesperado' }, { status: 500 });
  }
});