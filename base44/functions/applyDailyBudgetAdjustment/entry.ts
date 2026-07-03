/**
 * applyDailyBudgetAdjustment
 *
 * Ajusta o daily_budget de cada campanha ativa com base no gasto real
 * dos últimos 30 dias (média × 1.25), distribuído proporcionalmente.
 * Também aplica o novo budget via Amazon Ads API (v3) para garantir
 * que o erro de falta de budget não ocorra.
 *
 * Guardrails:
 *  - Budget mínimo por campanha: R$5,00
 *  - Budget máximo por campanha: AutopilotConfig.maximum_campaign_budget (default R$200)
 *  - Variação máxima por execução: ±30% do atual (evita choques bruscos)
 *  - Só aplica se novo valor diferir > 5% do atual (evita micro-ajustes)
 *  - Salva histórico em CampaignChangeHistory
 *  - Envia atualização para Amazon Ads API (v3)
 *
 * Payload:
 *   amazon_account_id — obrigatório
 *   dry_run           — opcional (default false)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const PAGE = 200;
const MIN_CAMPAIGN_BUDGET = 5;
const MAX_CHANGE_PCT = 0.30;

// Cache de token LWA
const tokenCache: Record<string, { access_token: string; expires_at: number }> = {};

async function getAdsToken(refreshToken: string): Promise<string> {
  const cached = tokenCache['ads'];
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: Deno.env.get('ADS_CLIENT_ID') || '',
    client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Falha ao obter token LWA');
  tokenCache['ads'] = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  };
  return data.access_token;
}

function getAdsBaseUrl(account: any): string {
  const r = (account?.region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function updateCampaignBudgetOnAmazon(
  account: any,
  amazonCampaignId: string,
  newBudget: number
): Promise<{ ok: boolean; error?: string }> {
  try {
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
    if (!refreshToken) return { ok: false, error: 'Sem refresh token' };
    const token = await getAdsToken(refreshToken);
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    const baseUrl = getAdsBaseUrl(account);

    const res = await fetch(`${baseUrl}/sp/campaigns`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
        'Amazon-Advertising-API-Scope': String(profileId),
        'Content-Type': 'application/vnd.spCampaign.v3+json',
        'Accept': 'application/vnd.spCampaign.v3+json',
      },
      body: JSON.stringify({
        campaigns: [{
          campaignId: amazonCampaignId,
          budget: { budgetType: 'DAILY', budget: newBudget },
        }],
      }),
    });
    const data = await res.json().catch(() => ({}));
    const success = data?.campaigns?.success?.[0] || data?.success?.[0];
    if (success) return { ok: true };
    const err = data?.campaigns?.error?.[0]?.description || data?.error || JSON.stringify(data).slice(0, 100);
    return { ok: false, error: err };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

async function loadAll(entity: any, query: any, sort: string, limit: number) {
  const all: any[] = [];
  let offset = 0;
  while (true) {
    const page = await entity.filter(query, sort, limit, offset);
    all.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  return all;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false } = body;

    if (!amazon_account_id) {
      return Response.json({ ok: false, error: 'amazon_account_id é obrigatório.' }, { status: 400 });
    }

    const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id });
    const account = accs[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada.' });

    const aid = account.id;
    const now = new Date().toISOString();
    const sym = account.currency_symbol || 'R$';

    // ── AutopilotConfig ──────────────────────────────────────────────────────
    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid });
    const cfg = configs[0] || {};
    const MAX_CAMPAIGN_BUDGET = cfg.maximum_campaign_budget || 200;

    // ── Janela: últimos 30 dias (excluindo hoje) ─────────────────────────────
    const today = now.slice(0, 10);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

    // ── Carregar métricas diárias dos últimos 30 dias ────────────────────────
    const metricsRaw = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: aid },
      '-date',
      5000
    );

    // Spend por campanha nos últimos 30 dias (deduplicado por campaign_id+date)
    const spendByCampaign: Record<string, { total: number; days: Set<string> }> = {};
    const seenDayKeys = new Set<string>();
    const spendByDay: Record<string, number> = {};

    for (const m of metricsRaw) {
      if (!m.date || m.date < thirtyDaysAgo || m.date >= today) continue;
      const cid = m.campaign_id;
      const key = `${cid || ''}-${m.date}`;
      if (seenDayKeys.has(key)) continue;
      seenDayKeys.add(key);

      // Por campanha
      if (cid) {
        if (!spendByCampaign[cid]) spendByCampaign[cid] = { total: 0, days: new Set() };
        spendByCampaign[cid].total += m.spend || 0;
        spendByCampaign[cid].days.add(m.date);
      }

      // Por dia (conta total)
      spendByDay[m.date] = (spendByDay[m.date] || 0) + (m.spend || 0);
    }

    const spendDays = Object.values(spendByDay);
    const numDays = spendDays.length;

    // ── Carregar campanhas ativas ────────────────────────────────────────────
    const allCampaigns = await loadAll(
      base44.asServiceRole.entities.Campaign,
      { amazon_account_id: aid },
      '-created_date',
      PAGE
    );

    const activeCampaigns = allCampaigns.filter((c: any) =>
      (c.state === 'enabled' || c.status === 'enabled') &&
      c.state !== 'archived' &&
      !c.archived
    );

    if (activeCampaigns.length === 0) {
      return Response.json({ ok: true, message: 'Nenhuma campanha ativa encontrada.', adjustments: [] });
    }

    // ── Spend médio diário da conta nos últimos 30 dias ──────────────────────
    let avgDailySpendAccount: number;
    let dataSource: string;

    if (numDays >= 3) {
      avgDailySpendAccount = spendDays.reduce((s, v) => s + v, 0) / numDays;
      dataSource = `CampaignMetricsDaily (${numDays} dias, janela 30d)`;
    } else {
      // Fallback: campaign.spend / 30
      const totalCampSpend = activeCampaigns.reduce((s: number, c: any) => s + (c.spend || 0), 0);
      avgDailySpendAccount = totalCampSpend / 30;
      dataSource = 'Campaign.spend (fallback 30d)';
    }

    if (avgDailySpendAccount <= 0) {
      return Response.json({
        ok: false,
        message: 'Sem dados de spend suficientes. Execute um sync primeiro.',
        data_source: dataSource,
      });
    }

    // ── Budget total alvo = média 30d × 1.25 ─────────────────────────────────
    const targetTotalBudget = Math.max(MIN_CAMPAIGN_BUDGET * activeCampaigns.length, avgDailySpendAccount * 1.25);
    const totalBudgetCurrent = activeCampaigns.reduce((s: number, c: any) => s + (c.daily_budget || 0), 0);

    // ── Calcular ajuste por campanha ─────────────────────────────────────────
    const adjustments: any[] = [];
    const dbUpdates: any[] = [];
    const amazonUpdates: Array<{ campaign: any; newBudget: number }> = [];

    for (const campaign of activeCampaigns) {
      const cid = campaign.campaign_id;
      const currentBudget = campaign.daily_budget || MIN_CAMPAIGN_BUDGET;

      // Spend médio desta campanha
      const campData = spendByCampaign[cid];
      let campAvgSpend: number;

      if (campData && campData.days.size >= 2) {
        campAvgSpend = campData.total / campData.days.size;
      } else if (totalBudgetCurrent > 0) {
        campAvgSpend = (currentBudget / totalBudgetCurrent) * avgDailySpendAccount;
      } else {
        campAvgSpend = avgDailySpendAccount / activeCampaigns.length;
      }

      // Budget alvo: spend médio × 1.25
      let targetBudget = campAvgSpend * 1.25;

      // Guardrail: mínimo R$5
      targetBudget = Math.max(targetBudget, MIN_CAMPAIGN_BUDGET);
      // Guardrail: máximo configurado
      targetBudget = Math.min(targetBudget, MAX_CAMPAIGN_BUDGET);
      // Guardrail: variação máxima ±30% por execução
      const maxUp   = currentBudget * (1 + MAX_CHANGE_PCT);
      const maxDown = currentBudget * (1 - MAX_CHANGE_PCT);
      targetBudget  = Math.min(targetBudget, maxUp);
      targetBudget  = Math.max(targetBudget, maxDown);
      targetBudget  = Math.max(targetBudget, MIN_CAMPAIGN_BUDGET);
      // Arredondar 2 casas
      targetBudget = Math.round(targetBudget * 100) / 100;

      // Só ajusta se diferença > 5%
      const changePct = Math.abs((targetBudget - currentBudget) / currentBudget);
      if (changePct < 0.05) {
        adjustments.push({
          campaign_id: cid,
          campaign_name: campaign.name || campaign.campaign_name,
          current_budget: currentBudget,
          target_budget: targetBudget,
          change_pct: 0,
          action: 'skipped_no_change',
        });
        continue;
      }

      const direction = targetBudget > currentBudget ? '↑' : '↓';
      adjustments.push({
        campaign_id: cid,
        amazon_campaign_id: campaign.campaign_id,
        campaign_name: campaign.name || campaign.campaign_name,
        current_budget: currentBudget,
        target_budget: targetBudget,
        change_pct: Number(((targetBudget - currentBudget) / currentBudget * 100).toFixed(1)),
        camp_avg_spend_30d: Number(campAvgSpend.toFixed(2)),
        action: dry_run ? 'dry_run' : `applied_${direction}`,
      });

      if (!dry_run) {
        dbUpdates.push({ id: campaign.id, daily_budget: targetBudget });
        // Só envia para Amazon se a campanha tem ID Amazon
        if (campaign.campaign_id) {
          amazonUpdates.push({ campaign, newBudget: targetBudget });
        }
      }
    }

    // ── Aplicar no banco local ───────────────────────────────────────────────
    let appliedDb = 0;
    let appliedAmazon = 0;
    let amazonErrors = 0;

    if (!dry_run) {
      if (dbUpdates.length > 0) {
        for (let i = 0; i < dbUpdates.length; i += 50) {
          await base44.asServiceRole.entities.Campaign.bulkUpdate(dbUpdates.slice(i, i + 50));
        }
        appliedDb = dbUpdates.length;
      }

      // ── Aplicar na Amazon Ads API (com backoff) ──────────────────────────
      // Processar em lotes de 10 para não sobrecarregar a API
      for (let i = 0; i < amazonUpdates.length; i += 10) {
        const batch = amazonUpdates.slice(i, i + 10);
        await Promise.all(batch.map(async ({ campaign, newBudget }) => {
          const amazonId = campaign.campaign_id; // campo campaign_id = amazon campaign id
          const result = await updateCampaignBudgetOnAmazon(account, amazonId, newBudget);
          if (result.ok) {
            appliedAmazon++;
          } else {
            amazonErrors++;
            console.warn(`[applyDailyBudgetAdjustment] Amazon API erro campanha ${amazonId}: ${result.error}`);
            // Marcar na decisão mas não reverter o banco — banco é source of truth local
          }
        }));
        // Backoff entre lotes para evitar rate limit
        if (i + 10 < amazonUpdates.length) {
          await new Promise(r => setTimeout(r, 1500));
        }
      }

      // ── Registrar histórico ──────────────────────────────────────────────
      const accountBudgetAfter = activeCampaigns.reduce((s: number, c: any) => {
        const adj = adjustments.find(a => a.campaign_id === c.campaign_id && a.action?.startsWith('applied'));
        return s + (adj ? adj.target_budget : (c.daily_budget || 0));
      }, 0);

      await base44.asServiceRole.entities.CampaignChangeHistory.create({
        amazon_account_id: aid,
        campaign_id: 'account_level',
        change_type: 'BUDGET_RULE',
        entity_type: 'account',
        entity_id: aid,
        field_name: 'daily_budget_adjustment_30d',
        old_value: String(Number(totalBudgetCurrent.toFixed(2))),
        new_value: String(Number(accountBudgetAfter.toFixed(2))),
        source: 'PERFORMANCE_RULE',
        source_function: 'applyDailyBudgetAdjustment',
        reason: `Ajuste automático 30d: média ${sym}${avgDailySpendAccount.toFixed(2)}/dia × 1.25 = alvo ${sym}${targetTotalBudget.toFixed(2)}. Fonte: ${dataSource}. DB: ${appliedDb} ajustadas. Amazon: ${appliedAmazon} OK, ${amazonErrors} erros.`,
        changed_at: now,
        changed_by: 'autopilot',
      }).catch(() => {});

      // ── Atualizar AutopilotConfig ────────────────────────────────────────
      if (configs.length > 0) {
        await base44.asServiceRole.entities.AutopilotConfig.update(configs[0].id, {
          ai_suggested_daily_budget: Number(targetTotalBudget.toFixed(2)),
          ai_budget_reasoning: `Média real ${dataSource}: ${sym}${avgDailySpendAccount.toFixed(2)}/dia × 1.25 = ${sym}${targetTotalBudget.toFixed(2)}. ${appliedDb} de ${activeCampaigns.length} campanhas ajustadas (${appliedAmazon} aplicadas na Amazon API).`,
          ai_budget_confidence: numDays >= 14 ? 92 : numDays >= 7 ? 80 : numDays >= 3 ? 65 : 50,
          ai_budget_generated_at: now,
          ai_budget_breakdown: JSON.stringify({
            avg_spend_30d: Number(avgDailySpendAccount.toFixed(2)),
            num_days_sampled: numDays,
            multiplier: 1.25,
            target_total: Number(targetTotalBudget.toFixed(2)),
            campaigns_adjusted_db: appliedDb,
            campaigns_applied_amazon: appliedAmazon,
            amazon_errors: amazonErrors,
            data_source: dataSource,
          }),
        }).catch(() => {});
      }
    }

    const appliedCount = adjustments.filter(a => a.action?.startsWith('applied')).length;
    const skippedCount = adjustments.filter(a => a.action === 'skipped_no_change').length;

    console.log(`[applyDailyBudgetAdjustment] janela=30d avg=${sym}${avgDailySpendAccount.toFixed(2)}/dia target=${sym}${targetTotalBudget.toFixed(2)} db=${appliedDb} amazon=${appliedAmazon} errors=${amazonErrors} skipped=${skippedCount} dry_run=${dry_run}`);

    return Response.json({
      ok: true,
      dry_run,
      data_source: dataSource,
      window_days: 30,
      num_days_with_data: numDays,
      avg_daily_spend_30d: Number(avgDailySpendAccount.toFixed(2)),
      target_total_budget: Number(targetTotalBudget.toFixed(2)),
      active_campaigns: activeCampaigns.length,
      campaigns_adjusted: appliedCount,
      campaigns_applied_amazon: appliedAmazon,
      amazon_errors: amazonErrors,
      campaigns_skipped: skippedCount,
      adjustments,
    });

  } catch (error: any) {
    console.error('[applyDailyBudgetAdjustment]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});