/**
 * autoBidAdjustRules — Ajuste automático de lances por regras de performance
 *
 * Regra 1 — SEM GASTO 24h:
 *   Se uma campanha não registrou nenhum gasto nas últimas 24h,
 *   aumenta o bid de todas as suas keywords ativas em +R$0.10
 *   (cap: R$2.00 por keyword).
 *
 * Regra 2 — OVERSPEND 2 DIAS:
 *   Se o gasto acumulado dos últimos 2 dias de uma campanha superou
 *   o orçamento diário × 2 (ou seja, gastou mais do que o planejado),
 *   reduz o bid de todas as suas keywords ativas em -R$0.05
 *   (floor: R$0.05 por keyword).
 *
 * As duas regras são mutuamente exclusivas por campanha — overspend
 * tem prioridade (não faz sentido botar mais dinheiro numa campanha
 * que já excedeu o orçamento).
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const TOKEN_CACHE = {};

async function getAdsToken(refreshToken) {
  const c = TOKEN_CACHE['ads'];
  if (c && c.expires_at > Date.now() + 5000) return c.access_token;
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: Deno.env.get('ADS_CLIENT_ID') || '',
      client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
    }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token failed');
  TOKEN_CACHE['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBase() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function updateKeywordBids(keywords, refreshToken, profileId) {
  if (keywords.length === 0) return { ok: true };
  const token = await getAdsToken(refreshToken);
  const res = await fetch(`${getAdsBase()}/sp/keywords`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': 'application/vnd.spKeyword.v3+json',
      Accept: 'application/vnd.spKeyword.v3+json',
    },
    body: JSON.stringify({ keywords: keywords.map(k => ({ keywordId: k.keyword_id, bid: k.new_bid })) }),
  });
  return { ok: [200, 207].includes(res.status), status: res.status };
}

function fmt(d) { return new Date(d).toISOString().slice(0, 10); }

Deno.serve(async (req) => {
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);

    let payload = {};
    try { payload = await req.clone().json(); } catch {}

    const accounts = payload.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: payload.amazon_account_id })
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });

    const now = new Date();
    const nowIso = now.toISOString();
    // Datas para análise
    const yesterday = fmt(Date.now() - 1 * 86400000);
    const twoDaysAgo = fmt(Date.now() - 2 * 86400000);

    const summary = {
      accounts: 0,
      no_spend_campaigns: 0,
      overspend_campaigns: 0,
      bids_increased: 0,
      bids_reduced: 0,
      errors: [],
    };

    for (const account of accounts) {
      try {
        const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
        const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
        if (!refreshToken || !profileId) continue;

        // Buscar campanhas ativas
        const campaigns = await base44.asServiceRole.entities.Campaign.filter({
          amazon_account_id: account.id,
          state: 'enabled',
        }, null, 1000);

        // Buscar métricas dos últimos 2 dias
        const metrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter({
          amazon_account_id: account.id,
        }, '-date', 2000);

        // Indexar métricas por campanha_id → [registros dos últimos 2 dias]
        const metricsByCampaign = new Map();
        for (const m of metrics) {
          if (!m.date || m.date < twoDaysAgo) continue;
          if (!metricsByCampaign.has(m.campaign_id)) metricsByCampaign.set(m.campaign_id, []);
          metricsByCampaign.get(m.campaign_id).push(m);
        }

        // Classificar campanhas
        const noSpendCampaignIds = new Set();
        const overspendCampaignIds = new Set();

        for (const campaign of campaigns) {
          const campaignMetrics = metricsByCampaign.get(campaign.campaign_id) || [];
          const budget = campaign.daily_budget || 0;

          // Regra 1: sem gasto nas últimas 24h (ontem ou hoje sem métricas)
          const recentMetrics = campaignMetrics.filter(m => m.date >= yesterday);
          const spend24h = recentMetrics.reduce((s, m) => s + (m.spend || 0), 0);
          if (spend24h === 0) {
            noSpendCampaignIds.add(campaign.campaign_id);
          }

          // Regra 2: overspend nos últimos 2 dias (spend > budget × 2)
          if (budget > 0) {
            const spend2d = campaignMetrics.reduce((s, m) => s + (m.spend || 0), 0);
            const budgetLimit = budget * 2;
            if (spend2d > budgetLimit) {
              overspendCampaignIds.add(campaign.campaign_id);
              // Overspend tem prioridade — remover do no-spend se lá estiver
              noSpendCampaignIds.delete(campaign.campaign_id);
            }
          }
        }

        summary.no_spend_campaigns += noSpendCampaignIds.size;
        summary.overspend_campaigns += overspendCampaignIds.size;

        if (noSpendCampaignIds.size === 0 && overspendCampaignIds.size === 0) {
          summary.accounts++;
          continue;
        }

        // Buscar keywords ativas das campanhas elegíveis
        const eligibleCampaignIds = [...noSpendCampaignIds, ...overspendCampaignIds];
        const keywords = await base44.asServiceRole.entities.Keyword.filter({
          amazon_account_id: account.id,
          state: 'enabled',
        }, null, 2000);

        const eligibleKeywords = keywords.filter(kw => eligibleCampaignIds.includes(kw.campaign_id));

        // Separar por regra
        const toIncrease = [];
        const toReduce = [];

        for (const kw of eligibleKeywords) {
          const currentBid = kw.current_bid || kw.bid || 0.25;
          if (overspendCampaignIds.has(kw.campaign_id)) {
            const newBid = Math.max(0.05, Math.round((currentBid - 0.05) * 100) / 100);
            if (newBid < currentBid) {
              toReduce.push({ ...kw, new_bid: newBid, old_bid: currentBid, rule: 'overspend_reduce' });
            }
          } else if (noSpendCampaignIds.has(kw.campaign_id)) {
            const newBid = Math.min(2.00, Math.round((currentBid + 0.10) * 100) / 100);
            if (newBid > currentBid) {
              toIncrease.push({ ...kw, new_bid: newBid, old_bid: currentBid, rule: 'no_spend_boost' });
            }
          }
        }

        // Enviar para Amazon em lotes de 100
        const BATCH = 100;

        // Aumentos
        for (let i = 0; i < toIncrease.length; i += BATCH) {
          const batch = toIncrease.slice(i, i + BATCH);
          const result = await updateKeywordBids(batch, refreshToken, profileId);
          if (result.ok) {
            const dbUpdates = batch.map(kw =>
              base44.asServiceRole.entities.Keyword.update(kw.id, { current_bid: kw.new_bid, bid: kw.new_bid })
            );
            await Promise.allSettled(dbUpdates);

            const logs = batch.map(kw => ({
              amazon_account_id: account.id,
              user_id: 'scheduler',
              operation_type: 'update_bid',
              entity_type: 'keyword',
              entity_id: kw.keyword_id,
              keyword_id: kw.keyword_id,
              keyword_text: kw.keyword_text || kw.keyword || '',
              campaign_id: kw.campaign_id || '',
              old_bid: kw.old_bid,
              new_bid: kw.new_bid,
              rationale: `Campanha sem gasto nas últimas 24h — bid aumentado +R$0.10 (${kw.old_bid.toFixed(2)} → ${kw.new_bid.toFixed(2)})`,
              rule_applied: 'no_spend_24h_increase_010',
              status: 'success',
              created_at: nowIso,
            }));
            await base44.asServiceRole.entities.CampaignCreationLog.bulkCreate(logs);
            summary.bids_increased += batch.length;
          } else {
            summary.errors.push(`Aumento: HTTP ${result.status}`);
          }
        }

        // Reduções
        for (let i = 0; i < toReduce.length; i += BATCH) {
          const batch = toReduce.slice(i, i + BATCH);
          const result = await updateKeywordBids(batch, refreshToken, profileId);
          if (result.ok) {
            const dbUpdates = batch.map(kw =>
              base44.asServiceRole.entities.Keyword.update(kw.id, { current_bid: kw.new_bid, bid: kw.new_bid })
            );
            await Promise.allSettled(dbUpdates);

            const logs = batch.map(kw => ({
              amazon_account_id: account.id,
              user_id: 'scheduler',
              operation_type: 'update_bid',
              entity_type: 'keyword',
              entity_id: kw.keyword_id,
              keyword_text: kw.keyword_text || kw.keyword || '',
              campaign_id: kw.campaign_id || '',
              old_bid: kw.old_bid,
              new_bid: kw.new_bid,
              rationale: `Campanha com gasto superior ao orçamento (2 dias) — bid reduzido -R$0.05 (${kw.old_bid.toFixed(2)} → ${kw.new_bid.toFixed(2)})`,
              rule_applied: 'overspend_2d_reduce_005',
              status: 'success',
              created_at: nowIso,
            }));
            await base44.asServiceRole.entities.CampaignCreationLog.bulkCreate(logs);
            summary.bids_reduced += batch.length;
          } else {
            summary.errors.push(`Redução: HTTP ${result.status}`);
          }
        }

        summary.accounts++;
      } catch (err) {
        summary.errors.push(`Conta ${account.id}: ${err.message}`);
      }
    }

    return Response.json({
      ok: true,
      summary,
      rules: [
        { name: 'no_spend_24h', action: '+R$0.10 por keyword (cap R$2.00)' },
        { name: 'overspend_2d', action: '-R$0.05 por keyword (floor R$0.05), prioridade sobre no_spend' },
      ],
      duration_ms: Date.now() - startTime,
      executed_at: nowIso,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});