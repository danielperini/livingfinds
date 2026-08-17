/**
 * redistributeCampaignBudgets
 * 
 * mode='fix_below_minimum' (padrão): eleva campanhas com daily_budget < R$15 para R$15.
 *   Não altera campanhas que já estão em R$15+.
 *   É o comportamento correto: R$15 é o mínimo Amazon real.
 * 
 * mode='proportional': redistribui orçamentos proporcionalmente ao spend 7D.
 *   Nota: a soma dos budgets por campanha PODE e DEVE ser maior que o daily_budget_limit.
 *   O daily_budget_limit é o CAP de GASTO REAL (controlado pelo pacing engine/kill switch),
 *   não a soma máxima de budgets de campanha.
 * 
 * Suporta dry_run:true para preview sem aplicar mudanças.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const AMAZON_MIN_BUDGET = 15;
const SLEEP_MS = 250;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const serviceRun = body._service_role === true;
    const user = serviceRun ? null : await base44.auth.me();
    if (!serviceRun && !user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const dryRun = body.dry_run === true;
    const mode = String(body.mode || 'fix_below_minimum');
    const db = base44.asServiceRole;

    // 1. Resolver conta
    const accountFilter = body.amazon_account_id
      ? { id: body.amazon_account_id }
      : serviceRun ? { status: 'connected' } : { user_id: user.id };
    const accounts = await db.entities.AmazonAccount.filter(accountFilter, '-updated_at', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });
    const accountId = account.id;

    // 2. Buscar campanhas enabled
    const allCampaigns = await db.entities.Campaign.filter(
      { amazon_account_id: accountId }, null, 500
    ).catch(() => [] as any[]);

    const enabledCampaigns = allCampaigns.filter((c: any) => {
      const s = (c.state || c.status || '').toLowerCase();
      return s === 'enabled';
    });

    if (enabledCampaigns.length === 0) {
      return Response.json({ ok: true, dry_run: dryRun, message: 'Nenhuma campanha enabled encontrada', adjusted: 0, duration_ms: Date.now() - t0 });
    }

    // ── MODE: fix_below_minimum ──────────────────────────────────────────────
    if (mode === 'fix_below_minimum') {
      const candidates = enabledCampaigns.filter((c: any) => Number(c.daily_budget || 0) < AMAZON_MIN_BUDGET);

      const preview = candidates.map((c: any) => ({
        campaign_id: c.campaign_id || c.amazon_campaign_id,
        name: c.name || c.campaign_name,
        targeting_type: c.targeting_type,
        current_budget: Number(c.daily_budget || 0),
        new_budget: AMAZON_MIN_BUDGET,
      }));

      if (dryRun) {
        return Response.json({ ok: true, dry_run: true, mode, candidates_count: candidates.length, preview, duration_ms: Date.now() - t0 });
      }

      if (candidates.length === 0) {
        return Response.json({ ok: true, dry_run: false, mode, adjusted: 0, message: 'Nenhuma campanha abaixo do mínimo', duration_ms: Date.now() - t0 });
      }

      // Obter token
      let accessToken: string | null = null;
      try {
        const tokenRes = await db.functions.invoke('amazonAdsTokenManager', { amazon_account_id: accountId, _service_role: true });
        const td = (tokenRes?.data || tokenRes || {}) as any;
        if (td.ok && td.access_token) accessToken = td.access_token;
      } catch (e: any) {
        console.warn('[redistribute] Falha ao obter token:', e.message);
      }

      const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
      const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
      const region = account.region || Deno.env.get('ADS_REGION') || 'NA';
      const baseUrl = region.toUpperCase().includes('EU')
        ? 'https://advertising-api-eu.amazon.com'
        : region.toUpperCase().includes('FE')
          ? 'https://advertising-api-fe.amazon.com'
          : 'https://advertising-api.amazon.com';

      let adjusted = 0;
      const results: any[] = [];

      for (const c of candidates) {
        const amazonId = c.amazon_campaign_id || c.campaign_id;
        let amazonOk = false;

        if (amazonId && accessToken) {
          try {
            const res = await fetch(`${baseUrl}/sp/campaigns`, {
              method: 'PUT',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Amazon-Advertising-API-ClientId': clientId,
                'Amazon-Advertising-API-Scope': profileId,
                'Content-Type': 'application/vnd.spCampaign.v3+json',
                'Accept': 'application/vnd.spCampaign.v3+json',
              },
              body: JSON.stringify({ campaigns: [{ campaignId: String(amazonId), budget: { budget: AMAZON_MIN_BUDGET, budgetType: 'DAILY' } }] }),
            });
            amazonOk = res.ok || res.status < 400;
            if (!amazonOk) {
              const text = await res.text().catch(() => '');
              console.warn(`[redistribute] Amazon PUT ${amazonId} → ${res.status}: ${text.slice(0, 100)}`);
            }
          } catch (e: any) {
            console.warn(`[redistribute] Fetch error for ${amazonId}:`, e.message);
          }
          await sleep(SLEEP_MS);
        }

        // Nunca refletir um orçamento como aplicado sem confirmação da Amazon.
        if (!amazonOk) {
          results.push({
            campaign_id: c.campaign_id || c.amazon_campaign_id,
            name: c.name || c.campaign_name,
            old_budget: Number(c.daily_budget || 0), new_budget: AMAZON_MIN_BUDGET,
            amazon_ok: false, status: 'unconfirmed',
          });
          continue;
        }
        await db.entities.Campaign.update(c.id, { daily_budget: AMAZON_MIN_BUDGET, budget: AMAZON_MIN_BUDGET, synced_at: new Date().toISOString() }).catch(() => {});
        adjusted++;

        results.push({
          campaign_id: c.campaign_id,
          name: c.name || c.campaign_name,
          old_budget: Number(c.daily_budget || 0),
          new_budget: AMAZON_MIN_BUDGET,
          amazon_ok: amazonOk,
        });
      }

      // Log
      await db.entities.SyncExecutionLog.create({
        amazon_account_id: accountId,
        operation: 'redistributeCampaignBudgets_fix_below_minimum',
        status: 'success',
        trigger_type: 'manual',
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        records_processed: adjusted,
        result_summary: JSON.stringify({ adjusted, minimum: AMAZON_MIN_BUDGET, candidates: candidates.length }).slice(0, 2000),
      }).catch(() => {});

      return Response.json({ ok: true, dry_run: false, mode, adjusted, unconfirmed: candidates.length - adjusted, campaigns_count: enabledCampaigns.length, results, duration_ms: Date.now() - t0 });
    }

    // ── MODE: proportional ───────────────────────────────────────────────────
    // Nota: este modo não escala para o cap — a soma dos budgets pode ser maior que o cap.
    // O gasto real é controlado pelo pacing engine, não pela soma de budgets de campanha.
    const configs = await db.entities.AutopilotConfig.filter({ amazon_account_id: accountId }, null, 1);
    const config = (configs[0] || {}) as any;
    const dailyBudgetLimit = Number(config.daily_budget_limit || config.total_daily_budget || 115);

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600000).toISOString().slice(0, 10);
    const metrics = await db.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: accountId, date: { $gte: sevenDaysAgo } }, null, 2000
    ).catch(() => [] as any[]);

    const spendByCampaignId = new Map<string, number>();
    for (const m of metrics) {
      const cid = m.campaign_id;
      if (!cid) continue;
      spendByCampaignId.set(cid, (spendByCampaignId.get(cid) || 0) + Number(m.spend || 0));
    }

    const campaignSpends = enabledCampaigns.map((c: any) => {
      const cid = c.campaign_id || c.amazon_campaign_id || c.id;
      const spend7d = spendByCampaignId.get(cid) || spendByCampaignId.get(c.amazon_campaign_id) || spendByCampaignId.get(c.campaign_id) || 0;
      return { ...c, _spend7d: spend7d };
    });

    const totalSpend7d = campaignSpends.reduce((s: number, c: any) => s + c._spend7d, 0);

    const computeNewBudget = (c: any) => {
      let share;
      if (totalSpend7d > 0 && c._spend7d > 0) {
        share = c._spend7d / totalSpend7d;
      } else {
        share = 1 / enabledCampaigns.length;
      }
      const raw = dailyBudgetLimit * share;
      return Math.max(AMAZON_MIN_BUDGET, Math.round(raw * 100) / 100);
    };

    const proposed = campaignSpends.map((c: any) => ({ ...c, _new_budget: computeNewBudget(c) }));
    const currentSum = enabledCampaigns.reduce((s: number, c: any) => s + Number(c.daily_budget || 0), 0);
    const newSum = proposed.reduce((s: number, c: any) => s + c._new_budget, 0);

    const preview = proposed.map((c: any) => ({
      campaign_id: c.campaign_id || c.amazon_campaign_id,
      name: c.name || c.campaign_name,
      targeting_type: c.targeting_type,
      current_budget: Number(c.daily_budget || 0),
      new_budget: c._new_budget,
      spend_7d: Math.round(c._spend7d * 100) / 100,
    }));

    if (dryRun) {
      return Response.json({ ok: true, dry_run: true, mode, daily_budget_limit: dailyBudgetLimit, current_sum: Math.round(currentSum * 100) / 100, new_sum: Math.round(newSum * 100) / 100, campaigns_count: enabledCampaigns.length, preview, duration_ms: Date.now() - t0 });
    }

    // Obter token
    let accessToken: string | null = null;
    try {
      const tokenRes = await db.functions.invoke('amazonAdsTokenManager', { amazon_account_id: accountId, _service_role: true });
      const td = (tokenRes?.data || tokenRes || {}) as any;
      if (td.ok && td.access_token) accessToken = td.access_token;
    } catch (e: any) {
      console.warn('[redistribute] Falha ao obter token:', e.message);
    }

    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
    const region = account.region || Deno.env.get('ADS_REGION') || 'NA';
    const baseUrl = region.toUpperCase().includes('EU')
      ? 'https://advertising-api-eu.amazon.com'
      : region.toUpperCase().includes('FE')
        ? 'https://advertising-api-fe.amazon.com'
        : 'https://advertising-api.amazon.com';

    let adjusted = 0;
    let failed = 0;
    const results: any[] = [];

    for (const c of proposed) {
      const oldBudget = Number(c.daily_budget || 0);
      const newBudget = c._new_budget;

      if (Math.abs(newBudget - oldBudget) < 0.50) {
        results.push({ campaign_id: c.campaign_id, name: c.name || c.campaign_name, status: 'unchanged', old_budget: oldBudget, new_budget: newBudget });
        continue;
      }

      const amazonId = c.amazon_campaign_id || c.campaign_id;
      let amazonOk = false;

      if (amazonId && accessToken) {
        try {
          const res = await fetch(`${baseUrl}/sp/campaigns`, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Amazon-Advertising-API-ClientId': clientId,
              'Amazon-Advertising-API-Scope': profileId,
              'Content-Type': 'application/vnd.spCampaign.v3+json',
              'Accept': 'application/vnd.spCampaign.v3+json',
            },
            body: JSON.stringify({ campaigns: [{ campaignId: String(amazonId), budget: { budget: newBudget, budgetType: 'DAILY' } }] }),
          });
          amazonOk = res.ok || res.status < 400;
          if (!amazonOk) {
            const text = await res.text().catch(() => '');
            console.warn(`[redistribute] Amazon PUT ${amazonId} → ${res.status}: ${text.slice(0, 100)}`);
            failed++;
          }
        } catch (e: any) {
          console.warn(`[redistribute] Fetch error for ${amazonId}:`, e.message);
          failed++;
        }
        await sleep(SLEEP_MS);
      }

      await db.entities.Campaign.update(c.id, { daily_budget: newBudget }).catch(() => {});
      adjusted++;

      results.push({ campaign_id: c.campaign_id, name: c.name || c.campaign_name, status: amazonOk ? 'updated' : 'updated_local_only', old_budget: oldBudget, new_budget: newBudget, amazon_ok: amazonOk });
    }

    await db.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'redistributeCampaignBudgets_proportional',
      status: failed === 0 ? 'success' : 'warning',
      trigger_type: 'manual',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      records_processed: adjusted,
      result_summary: JSON.stringify({ adjusted, failed, daily_budget_limit: dailyBudgetLimit, current_sum: currentSum, new_sum: newSum }).slice(0, 2000),
    }).catch(() => {});

    return Response.json({ ok: true, dry_run: false, mode, daily_budget_limit: dailyBudgetLimit, current_sum: Math.round(currentSum * 100) / 100, new_sum: Math.round(newSum * 100) / 100, adjusted, failed, campaigns_count: enabledCampaigns.length, results, duration_ms: Date.now() - t0 });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});
