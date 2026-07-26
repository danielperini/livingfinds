/**
 * redistributeCampaignBudgets
 * Redistribui orçamentos de campanhas enabled proporcionalmente ao spend 7D,
 * respeitando o daily_budget_limit do AutopilotConfig.
 * Suporta dry_run:true para preview sem aplicar mudanças.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const MIN_BUDGET = 5;
const SLEEP_MS = 250;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const dryRun = body.dry_run === true;
    const db = base44.asServiceRole;

    // 1. Resolver conta
    const accounts = await db.entities.AmazonAccount.filter({ user_id: user.id }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });
    const accountId = account.id;

    // 2. Buscar AutopilotConfig para saber o cap diário
    const configs = await db.entities.AutopilotConfig.filter({ amazon_account_id: accountId }, null, 1);
    const config = configs[0] || {};
    const dailyBudgetLimit = Number(config.daily_budget_limit || config.total_daily_budget || 115);

    // 3. Buscar todas as campanhas enabled (não arquivadas, não pausadas)
    const allCampaigns = await db.entities.Campaign.filter(
      { amazon_account_id: accountId }, null, 500
    ).catch(() => []);

    const enabledCampaigns = allCampaigns.filter(c => {
      const s = (c.state || c.status || '').toLowerCase();
      return s === 'enabled';
    });

    if (enabledCampaigns.length === 0) {
      return Response.json({ ok: true, dry_run: dryRun, message: 'Nenhuma campanha enabled encontrada', adjusted: 0, duration_ms: Date.now() - t0 });
    }

    // 4. Buscar métricas dos últimos 7 dias para ponderar o spend
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600000).toISOString().slice(0, 10);
    const metrics = await db.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: accountId, date: { $gte: sevenDaysAgo } }, null, 2000
    ).catch(() => []);

    // Somar spend 7D por campaign_id
    const spendByCampaignId = new Map();
    for (const m of metrics) {
      const cid = m.campaign_id;
      if (!cid) continue;
      spendByCampaignId.set(cid, (spendByCampaignId.get(cid) || 0) + Number(m.spend || 0));
    }

    // Mapear spend para campanhas enabled
    const campaignSpends = enabledCampaigns.map(c => {
      const cid = c.campaign_id || c.amazon_campaign_id || c.id;
      const spend7d = spendByCampaignId.get(cid) || spendByCampaignId.get(c.amazon_campaign_id) || spendByCampaignId.get(c.campaign_id) || 0;
      return { ...c, _spend7d: spend7d };
    });

    const totalSpend7d = campaignSpends.reduce((s, c) => s + c._spend7d, 0);

    // 5. Calcular novo budget proporcional ao spend 7D
    // Se não há histórico, dividir igualmente
    const computeNewBudget = (c) => {
      let share;
      if (totalSpend7d > 0 && c._spend7d > 0) {
        share = c._spend7d / totalSpend7d;
      } else {
        share = 1 / enabledCampaigns.length;
      }
      const raw = dailyBudgetLimit * share;
      return Math.max(MIN_BUDGET, Math.round(raw * 100) / 100);
    };

    // Calcular budgets propostos e normalizar para que a soma não ultrapasse o cap
    let proposed = campaignSpends.map(c => ({ ...c, _new_budget: computeNewBudget(c) }));
    const proposedSum = proposed.reduce((s, c) => s + c._new_budget, 0);

    // Escalar proporcionalmente se a soma exceder o limit
    if (proposedSum > dailyBudgetLimit) {
      const scale = dailyBudgetLimit / proposedSum;
      proposed = proposed.map(c => ({
        ...c,
        _new_budget: Math.max(MIN_BUDGET, Math.round(c._new_budget * scale * 100) / 100),
      }));
    }

    const currentSum = enabledCampaigns.reduce((s, c) => s + Number(c.daily_budget || 0), 0);
    const newSum = proposed.reduce((s, c) => s + c._new_budget, 0);

    // 6. Preview para dry_run
    const preview = proposed.map(c => ({
      campaign_id: c.campaign_id || c.amazon_campaign_id,
      name: c.name || c.campaign_name,
      targeting_type: c.targeting_type,
      current_budget: Number(c.daily_budget || 0),
      new_budget: c._new_budget,
      spend_7d: Math.round(c._spend7d * 100) / 100,
    }));

    if (dryRun) {
      return Response.json({
        ok: true,
        dry_run: true,
        daily_budget_limit: dailyBudgetLimit,
        current_sum: Math.round(currentSum * 100) / 100,
        new_sum: Math.round(newSum * 100) / 100,
        campaigns_count: enabledCampaigns.length,
        preview,
        duration_ms: Date.now() - t0,
      });
    }

    // 7. Aplicar: atualizar Amazon + banco local
    // Obter access token
    let accessToken = null;
    try {
      const tokenRes = await db.functions.invoke('amazonAdsTokenManager', {
        amazon_account_id: accountId,
        _service_role: true,
      });
      const td = (tokenRes?.data || tokenRes || {});
      if (td.ok && td.access_token) accessToken = td.access_token;
    } catch (e) {
      console.warn('[redistribute] Falha ao obter token:', e.message);
    }

    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
    const region = account.region || Deno.env.get('ADS_REGION') || 'NA';

    function adsBase(r) {
      r = (r || 'NA').toUpperCase();
      if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
      if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
      return 'https://advertising-api.amazon.com';
    }

    const baseUrl = adsBase(region);
    let adjusted = 0;
    let failed = 0;
    const results = [];

    for (const c of proposed) {
      const oldBudget = Number(c.daily_budget || 0);
      const newBudget = c._new_budget;

      // Só atualizar se mudou significativamente (diferença > R$0.50)
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
            const body = await res.text().catch(() => '');
            console.warn(`[redistribute] Amazon PUT ${amazonId} → ${res.status}: ${body.slice(0, 100)}`);
          }
        } catch (e) {
          console.warn(`[redistribute] Fetch error for ${amazonId}:`, e.message);
        }
        await sleep(SLEEP_MS);
      }

      // Atualizar banco local sempre
      await db.entities.Campaign.update(c.id, { daily_budget: newBudget }).catch(() => {});
      adjusted++;

      results.push({
        campaign_id: c.campaign_id,
        name: c.name || c.campaign_name,
        status: amazonOk ? 'updated' : 'updated_local_only',
        old_budget: oldBudget,
        new_budget: newBudget,
        amazon_ok: amazonOk,
      });
    }

    // Log
    const now = new Date().toISOString();
    await db.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'redistributeCampaignBudgets',
      status: failed === 0 ? 'success' : 'warning',
      trigger_type: 'manual',
      started_at: now,
      completed_at: new Date().toISOString(),
      records_processed: adjusted,
      result_summary: JSON.stringify({ adjusted, daily_budget_limit: dailyBudgetLimit, current_sum: currentSum, new_sum: newSum }).slice(0, 2000),
    }).catch(() => {});

    return Response.json({
      ok: true,
      dry_run: false,
      daily_budget_limit: dailyBudgetLimit,
      current_sum: Math.round(currentSum * 100) / 100,
      new_sum: Math.round(newSum * 100) / 100,
      adjusted,
      failed,
      campaigns_count: enabledCampaigns.length,
      results,
      duration_ms: Date.now() - t0,
    });

  } catch (err) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});