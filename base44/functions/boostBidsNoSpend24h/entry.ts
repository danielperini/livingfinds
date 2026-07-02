/**
 * boostBidsNoSpend24h — Aumentar bids de keywords sem gasto nas últimas 24h
 *
 * Regra: Para toda keyword enabled com spend == 0 nas últimas 24h
 * e criada há mais de 24h, aumentar o bid em +20% (mínimo +R$0.10),
 * com teto máximo de R$3.00.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

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

  tokenCache['ads'] = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  };
  return data.access_token;
}

function getAdsBaseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsRequest(method, path, body, refreshToken, profileId, contentType = 'application/json') {
  const token = await getAdsToken(refreshToken);
  const res = await fetch(`${getAdsBaseUrl()}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': contentType,
      'Accept': contentType,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: res.status, data };
}

const MAX_BID = 3.00;
const MIN_BOOST = 0.10;
const BOOST_PCT = 0.20; // +20%

function calcNewBid(currentBid) {
  const boost = Math.max(currentBid * BOOST_PCT, MIN_BOOST);
  return Math.min(parseFloat((currentBid + boost).toFixed(2)), MAX_BID);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const todayStr = now.toISOString().slice(0, 10);
    const yesterdayStr = twentyFourHoursAgo.toISOString().slice(0, 10);

    let payload = {};
    try { payload = await req.clone().json(); } catch {}

    const accounts = payload.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: payload.amazon_account_id })
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });

    const summary = {
      accounts_processed: 0,
      keywords_analyzed: 0,
      keywords_boosted: 0,
      keywords_at_max: 0,
      keywords_skipped: 0,
      errors: [],
      boosted_details: [],
    };

    for (const account of accounts) {
      try {
        const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
        const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
        if (!refreshToken || !profileId) continue;

        // Buscar keywords ativas
        const keywords = await base44.asServiceRole.entities.Keyword.filter({
          amazon_account_id: account.id,
          state: 'enabled',
        }, '-created_date', 500);

        summary.keywords_analyzed += keywords.length;

        // Buscar métricas de hoje e ontem para identificar spend real nas últimas 24h
        const [metricsToday, metricsYesterday] = await Promise.all([
          base44.asServiceRole.entities.AdsMetricsHistory.filter({
            amazon_account_id: account.id,
            date: todayStr,
            report_type: 'campaigns',
          }, '-created_date', 500),
          base44.asServiceRole.entities.AdsMetricsHistory.filter({
            amazon_account_id: account.id,
            date: yesterdayStr,
            report_type: 'campaigns',
          }, '-created_date', 500),
        ]);

        // Mapear campaign_id → spend recente
        const spendByCampaign = {};
        [...metricsToday, ...metricsYesterday].forEach(m => {
          const cid = m.campaign_id;
          if (!cid) return;
          spendByCampaign[cid] = (spendByCampaign[cid] || 0) + (m.spend || 0);
        });

        // Filtrar keywords elegíveis:
        // 1. Criada há mais de 24h
        // 2. spend acumulado da campanha nas últimas 24h == 0 (ou keyword sem gasto próprio)
        // 3. bid abaixo do teto
        const eligible = keywords.filter(kw => {
          const bid = kw.current_bid || kw.bid || 0;
          if (bid >= MAX_BID) return false;

          const createdAt = kw.first_seen_at
            ? new Date(kw.first_seen_at)
            : new Date(kw.synced_at || 0);
          if (createdAt >= twentyFourHoursAgo) return false;

          // Se temos métricas por campanha, usar; senão, usar spend da keyword
          const campaignSpend24h = spendByCampaign[kw.campaign_id] ?? null;
          if (campaignSpend24h !== null) {
            return campaignSpend24h === 0;
          }
          // Fallback: spend acumulado da keyword == 0
          return (kw.spend || 0) === 0;
        });

        // Separar as que já estão no teto
        const atMax = keywords.filter(kw => (kw.current_bid || kw.bid || 0) >= MAX_BID);
        summary.keywords_at_max += atMax.length;

        if (eligible.length === 0) {
          summary.accounts_processed++;
          continue;
        }

        // Enviar para Amazon em lotes de 100
        const BATCH_SIZE = 100;
        for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
          const batch = eligible.slice(i, i + BATCH_SIZE);

          const updatePayload = {
            keywords: batch.map(kw => ({
              keywordId: kw.keyword_id,
              bid: calcNewBid(kw.current_bid || kw.bid || 0.25),
            })),
          };

          const resp = await adsRequest(
            'PUT',
            '/sp/keywords',
            updatePayload,
            refreshToken,
            profileId,
            'application/vnd.spKeyword.v3+json'
          );

          if ([200, 207].includes(resp.status)) {
            // Atualizar banco local e criar logs
            const updates = batch.map(kw => {
              const newBid = calcNewBid(kw.current_bid || kw.bid || 0.25);
              return base44.asServiceRole.entities.Keyword.update(kw.id, {
                current_bid: newBid,
                bid: newBid,
                last_seen_at: now.toISOString(),
              });
            });
            await Promise.allSettled(updates);

            const logs = batch.map(kw => {
              const oldBid = kw.current_bid || kw.bid || 0;
              const newBid = calcNewBid(oldBid);
              return {
                amazon_account_id: account.id,
                keyword_id: kw.keyword_id,
                keyword: kw.keyword_text || kw.keyword || '',
                campaign_id: kw.campaign_id || '',
                old_bid: oldBid,
                new_bid: newBid,
                change_amount: parseFloat((newBid - oldBid).toFixed(2)),
                change_percent: parseFloat((((newBid - oldBid) / Math.max(oldBid, 0.01)) * 100).toFixed(1)),
                direction: 'increase',
                reason: `0 spend nas últimas 24h — bid aumentado +${BOOST_PCT * 100}%`,
                ai_confidence: 70,
                risk_level: 'low',
                status: 'executed',
                created_at: now.toISOString(),
              };
            });
            await base44.asServiceRole.entities.AdsBidChangeLog.bulkCreate(logs);

            summary.keywords_boosted += batch.length;
            summary.boosted_details.push(...batch.map(kw => ({
              keyword: kw.keyword_text || kw.keyword,
              old_bid: kw.current_bid || kw.bid,
              new_bid: calcNewBid(kw.current_bid || kw.bid || 0.25),
            })));
          } else {
            summary.errors.push(`Lote ${i}-${i + batch.length}: HTTP ${resp.status} — ${JSON.stringify(resp.data).slice(0, 200)}`);
            summary.keywords_skipped += batch.length;
          }

          // Intervalo entre lotes para respeitar rate limits
          if (i + BATCH_SIZE < eligible.length) {
            await new Promise(r => setTimeout(r, 500));
          }
        }

        summary.accounts_processed++;
      } catch (accError) {
        summary.errors.push(`Conta ${account.id}: ${accError.message}`);
      }
    }

    return Response.json({
      ok: true,
      summary,
      rule: 'no_spend_24h_boost_20pct',
      max_bid: MAX_BID,
      executed_at: now.toISOString(),
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});