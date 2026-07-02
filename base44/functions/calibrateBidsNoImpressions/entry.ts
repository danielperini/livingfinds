/**
 * calibrateBidsNoImpressions — Calibração automática de bids para keywords sem impressões
 *
 * Regras:
 * 1. Keyword sem impressão nas últimas 48h → cria alerta + aumenta bid +R$0.10 a cada 24h
 * 2. Keyword que voltou a ter impressão → reduz bid -R$0.05 (calibração suave)
 * 3. Keyword que perdeu impressão novamente → retoma ciclo de +R$0.10
 * 4. Teto máximo: R$5.00 | Piso mínimo: R$0.10
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MAX_BID = 5.00;
const MIN_BID = 0.10;
const BOOST_AMOUNT = 0.10;   // +R$0.10 sem impressão
const REDUCE_AMOUNT = 0.05;  // -R$0.05 ao ganhar impressão

const tokenCache = {};

async function getAdsToken(refreshToken) {
  const cached = tokenCache['ads'];
  if (cached && cached.expires_at > Date.now() + 5000) return cached.access_token;
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
  if (!res.ok) throw new Error(data.error_description || data.error || 'Token failed');
  tokenCache['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBaseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsRequest(method, path, body, refreshToken, profileId) {
  const token = await getAdsToken(refreshToken);
  const res = await fetch(`${getAdsBaseUrl()}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': 'application/vnd.spKeyword.v3+json',
      'Accept': 'application/vnd.spKeyword.v3+json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

async function updateKeywordBid(base44, account, kw, newBid, direction, reason, refreshToken, profileId, now) {
  const clampedBid = parseFloat(Math.min(Math.max(newBid, MIN_BID), MAX_BID).toFixed(2));
  const oldBid = kw.current_bid || kw.bid || 0.25;

  // Enviar para Amazon
  const resp = await adsRequest('PUT', '/sp/keywords', { keywords: [{ keywordId: kw.keyword_id, bid: clampedBid }] }, refreshToken, profileId);
  if (![200, 207].includes(resp.status)) {
    return { ok: false, error: `HTTP ${resp.status}` };
  }

  // Atualizar banco local
  await base44.asServiceRole.entities.Keyword.update(kw.id, {
    current_bid: clampedBid,
    bid: clampedBid,
    last_seen_at: now.toISOString(),
  });

  // Log da mudança
  await base44.asServiceRole.entities.AdsBidChangeLog.create({
    amazon_account_id: account.id,
    keyword_id: kw.keyword_id,
    keyword: kw.keyword_text || kw.keyword || '',
    campaign_id: kw.campaign_id || '',
    old_bid: oldBid,
    new_bid: clampedBid,
    change_amount: parseFloat((clampedBid - oldBid).toFixed(2)),
    change_percent: parseFloat((((clampedBid - oldBid) / Math.max(oldBid, 0.01)) * 100).toFixed(1)),
    direction,
    reason,
    ai_confidence: 80,
    risk_level: 'low',
    status: 'executed',
    created_at: now.toISOString(),
  });

  return { ok: true, old_bid: oldBid, new_bid: clampedBid };
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const now = new Date();

    // Janelas de tempo
    const h48Ago = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const dates48h = [];
    for (let d = 0; d < 3; d++) {
      const dt = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
      dates48h.push(dt.toISOString().slice(0, 10));
    }

    let payload = {};
    try { payload = await req.clone().json(); } catch {}

    const accounts = payload.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: payload.amazon_account_id })
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });

    const summary = {
      accounts_processed: 0,
      keywords_analyzed: 0,
      keywords_boosted: 0,      // sem impressão → +R$0.10
      keywords_reduced: 0,      // voltou a ter impressão → -R$0.05
      alerts_created: 0,
      errors: [],
    };

    for (const account of accounts) {
      try {
        const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
        const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
        if (!refreshToken || !profileId) continue;

        // Buscar todas as keywords ativas
        const keywords = await base44.asServiceRole.entities.Keyword.filter(
          { amazon_account_id: account.id, state: 'enabled' },
          '-created_date',
          500
        );
        summary.keywords_analyzed += keywords.length;

        // Buscar métricas das últimas 48h (hoje + ontem + anteontem)
        const metricsPromises = dates48h.map(date =>
          base44.asServiceRole.entities.AdsMetricsHistory.filter(
            { amazon_account_id: account.id, date },
            '-created_date',
            500
          )
        );
        const metricsArrays = await Promise.all(metricsPromises);
        const allMetrics = metricsArrays.flat();

        // Mapear keyword_id → impressões nas últimas 48h
        // Usar campaign_id como proxy se não houver keyword_id nas métricas
        const impressionsByKeyword = {};
        const impressionsByCampaign = {};
        for (const m of allMetrics) {
          if (m.keyword_id) {
            impressionsByKeyword[m.keyword_id] = (impressionsByKeyword[m.keyword_id] || 0) + (m.impressions || 0);
          }
          if (m.campaign_id) {
            impressionsByCampaign[m.campaign_id] = (impressionsByCampaign[m.campaign_id] || 0) + (m.impressions || 0);
          }
        }

        // Buscar alertas existentes para evitar duplicatas
        const existingAlerts = await base44.asServiceRole.entities.Alert.filter(
          { amazon_account_id: account.id, alert_type: 'no_impressions', status: 'active' },
          '-created_at',
          500
        );
        const alertedKeywordIds = new Set(existingAlerts.map(a => a.keyword_id));

        // Classificar cada keyword
        for (const kw of keywords) {
          // Ignorar keywords muito recentes (criadas há menos de 48h)
          const createdAt = kw.first_seen_at ? new Date(kw.first_seen_at) : new Date(kw.synced_at || 0);
          if (createdAt >= h48Ago) continue;

          const kwImpressions = impressionsByKeyword[kw.keyword_id] ?? impressionsByCampaign[kw.campaign_id] ?? null;
          const hasImpressions = kwImpressions !== null && kwImpressions > 0;
          const currentBid = kw.current_bid || kw.bid || 0.25;

          if (!hasImpressions) {
            // ─── SEM IMPRESSÃO ───────────────────────────────────────────
            // Aumentar bid +R$0.10 (se ainda não atingiu o teto)
            if (currentBid < MAX_BID) {
              const newBid = parseFloat(Math.min(currentBid + BOOST_AMOUNT, MAX_BID).toFixed(2));
              const result = await updateKeywordBid(
                base44, account, kw, newBid,
                'increase',
                `Sem impressões nas últimas 48h — calibração +R$${BOOST_AMOUNT.toFixed(2)}`,
                refreshToken, profileId, now
              );
              if (result.ok) summary.keywords_boosted++;
              else summary.errors.push(`Boost ${kw.keyword_id}: ${result.error}`);
            }

            // Criar alerta se ainda não existe para esta keyword
            if (!alertedKeywordIds.has(kw.keyword_id)) {
              await base44.asServiceRole.entities.Alert.create({
                amazon_account_id: account.id,
                alert_type: 'no_impressions',
                severity: 'high',
                title: 'Keyword sem impressões há 48h',
                message: `Keyword "${kw.keyword_text || kw.keyword}" (bid atual: R$${currentBid.toFixed(2)}) não recebeu nenhuma impressão nas últimas 48h. Revisão recomendada.`,
                entity_type: 'keyword',
                entity_id: kw.id,
                keyword_id: kw.keyword_id,
                campaign_id: kw.campaign_id,
                asin: kw.asin,
                current_value: 0,
                threshold_value: 1,
                status: 'active',
                created_at: now.toISOString(),
              }).catch(() => {});
              summary.alerts_created++;
              alertedKeywordIds.add(kw.keyword_id);
            }

          } else {
            // ─── TEM IMPRESSÃO ────────────────────────────────────────────
            // Calibrar para baixo -R$0.05 (voltou a aparecer)
            if (currentBid > MIN_BID + REDUCE_AMOUNT) {
              const newBid = parseFloat(Math.max(currentBid - REDUCE_AMOUNT, MIN_BID).toFixed(2));
              const result = await updateKeywordBid(
                base44, account, kw, newBid,
                'decrease',
                `Primeira impressão detectada — calibração -R$${REDUCE_AMOUNT.toFixed(2)}`,
                refreshToken, profileId, now
              );
              if (result.ok) summary.keywords_reduced++;
              else summary.errors.push(`Reduce ${kw.keyword_id}: ${result.error}`);
            }

            // Resolver alerta ativo se existia
            if (alertedKeywordIds.has(kw.keyword_id)) {
              const alertToResolve = existingAlerts.find(a => a.keyword_id === kw.keyword_id);
              if (alertToResolve) {
                await base44.asServiceRole.entities.Alert.update(alertToResolve.id, {
                  status: 'resolved',
                  resolved_at: now.toISOString(),
                }).catch(() => {});
              }
            }
          }

          // Pausa entre keywords para respeitar rate limits da Amazon
          await new Promise(r => setTimeout(r, 300));
        }

        summary.accounts_processed++;
      } catch (accError) {
        summary.errors.push(`Conta ${account.id}: ${accError.message}`);
      }
    }

    return Response.json({
      ok: true,
      rule: 'calibrate_bids_no_impressions_48h',
      boost_amount: BOOST_AMOUNT,
      reduce_amount: REDUCE_AMOUNT,
      max_bid: MAX_BID,
      summary,
      executed_at: now.toISOString(),
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});