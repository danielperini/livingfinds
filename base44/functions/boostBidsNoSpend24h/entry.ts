/**
 * boostBidsNoSpend24h — Aumentar bids para R$0.60 quando não houver gasto após 24h
 *
 * Regra: Para toda keyword com bid < R$0.60 e spend == 0 nos últimos 30 dias
 * (indicando que a keyword nunca gastou desde a criação ou está sem tráfego),
 * aumentar o bid para R$0.60.
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
  return { status: res.status, data, requestId: res.headers.get('x-amzn-requestid') || '' };
}

const TARGET_BID = 0.60;

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const now = new Date();

    // Suporta chamada manual com amazon_account_id específico
    let payload = {};
    try { payload = await req.clone().json(); } catch {}

    const accounts = payload.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: payload.amazon_account_id })
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });

    const summary = {
      accounts_processed: 0,
      keywords_analyzed: 0,
      keywords_boosted: 0,
      keywords_already_ok: 0,
      keywords_skipped: 0,
      errors: [],
    };

    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    for (const account of accounts) {
      try {
        const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
        const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
        if (!refreshToken || !profileId) continue;

        // Buscar keywords ativas com spend == 0 e bid < 0.60
        const keywords = await base44.asServiceRole.entities.Keyword.filter({
          amazon_account_id: account.id,
          state: 'enabled',
        }, '-created_date', 500);

        summary.keywords_analyzed += keywords.length;

        // Filtrar: sem gasto E bid abaixo de R$0.60 E criada há mais de 24h
        const eligible = keywords.filter(kw => {
          const spend = kw.spend || 0;
          const bid = kw.current_bid || kw.bid || 0;
          const createdAt = kw.first_seen_at ? new Date(kw.first_seen_at) : new Date(kw.synced_at || 0);
          const isOldEnough = createdAt < twentyFourHoursAgo;
          return spend === 0 && bid < TARGET_BID && isOldEnough;
        });

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
              bid: TARGET_BID,
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
            // Atualizar no banco local em paralelo
            const updates = batch.map(kw =>
              base44.asServiceRole.entities.Keyword.update(kw.id, {
                current_bid: TARGET_BID,
                bid: TARGET_BID,
                last_seen_at: now.toISOString(),
              })
            );
            await Promise.allSettled(updates);

            // Log dos bids alterados
            const logs = batch.map(kw => ({
              amazon_account_id: account.id,
              user_id: 'scheduler',
              operation_type: 'update_bid',
              entity_type: 'keyword',
              entity_id: kw.keyword_id,
              keyword_id: kw.keyword_id,
              keyword_text: kw.keyword_text || kw.keyword || '',
              campaign_id: kw.campaign_id || '',
              old_bid: kw.current_bid || kw.bid || 0,
              new_bid: TARGET_BID,
              rationale: `Keyword sem gasto após 24h — bid aumentado para R$${TARGET_BID.toFixed(2)}`,
              rule_applied: 'no_spend_24h_boost_to_060',
              status: 'success',
              created_at: now.toISOString(),
            }));
            await base44.asServiceRole.entities.CampaignCreationLog.bulkCreate(logs);

            summary.keywords_boosted += batch.length;
          } else {
            summary.errors.push(`Falha lote ${i}-${i + batch.length}: HTTP ${resp.status} — ${JSON.stringify(resp.data).slice(0, 200)}`);
            summary.keywords_skipped += batch.length;
          }
        }

        // Contar keywords que já estão acima do target
        summary.keywords_already_ok += keywords.length - eligible.length;
        summary.accounts_processed++;
      } catch (accError) {
        summary.errors.push(`Conta ${account.id}: ${accError.message}`);
      }
    }

    return Response.json({
      ok: true,
      summary,
      target_bid: TARGET_BID,
      rule: 'no_spend_24h_boost_to_060',
      executed_at: now.toISOString(),
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});