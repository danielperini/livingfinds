/**
 * smartBidFromCpc — Ajuste inteligente de bid baseado no CPC real
 *
 * Regras:
 * 1. Quando uma keyword começa a gerar gasto (spend > 0), o bid é ajustado para 50% do CPC real
 *    Exemplo: CPC = R$1.20 → bid alvo = R$0.60
 * 2. A cada execução (diária), o bid é recalibrado para manter o mínimo viável
 * 3. Se parar de ter impressões → calibrateBidsNoImpressions toma o controle (+R$0.10/24h)
 * 4. Teto: R$5.00 | Piso: R$0.10
 *
 * CPC_BID_RATIO = 0.50 (bid = 50% do CPC médio observado)
 * Tolerância: só ajusta se a diferença for > R$0.05 para evitar micro-oscilações
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MAX_BID = 5.00;
const MIN_BID = 0.25; // piso mínimo — bid nunca cai abaixo de R$0.25
const CPC_BID_RATIO = 0.50;   // bid = 50% do CPC real
const MIN_DELTA = 0.05;        // só ajusta se diferença > R$0.05

const tokenCache = {};

async function getAdsToken(refreshToken) {
  const cached = tokenCache['smart'];
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
  tokenCache['smart'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
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

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const now = new Date();

    let payload = {};
    try { payload = await req.clone().json(); } catch {}

    const accounts = payload.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: payload.amazon_account_id })
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });

    const summary = {
      accounts_processed: 0,
      keywords_analyzed: 0,
      keywords_adjusted: 0,
      keywords_skipped_no_cpc: 0,
      keywords_skipped_small_delta: 0,
      errors: [],
      adjustments: [],
    };

    for (const account of accounts) {
      try {
        const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
        const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
        if (!refreshToken || !profileId) continue;

        // Buscar keywords ativas com gasto (cpc > 0 e spend > 0)
        const keywords = await base44.asServiceRole.entities.Keyword.filter(
          { amazon_account_id: account.id, state: 'enabled' },
          '-spend',
          500
        );

        summary.keywords_analyzed += keywords.length;

        for (const kw of keywords) {
          const cpc = kw.cpc || 0;
          const spend = kw.spend || 0;
          const clicks = kw.clicks || 0;

          // Só ajusta quando há CPC real (keyword com histórico de gasto)
          if (cpc <= 0 || spend <= 0 || clicks < 2) {
            summary.keywords_skipped_no_cpc++;
            continue;
          }

          const currentBid = kw.current_bid || kw.bid || 0.25;
          // Bid alvo = 50% do CPC real, respeitando piso e teto
          const targetBid = parseFloat(
            Math.min(Math.max(cpc * CPC_BID_RATIO, MIN_BID), MAX_BID).toFixed(2)
          );

          // Só ajusta se a diferença for relevante (> R$0.05)
          if (Math.abs(targetBid - currentBid) < MIN_DELTA) {
            summary.keywords_skipped_small_delta++;
            continue;
          }

          const direction = targetBid > currentBid ? 'increase' : 'decrease';
          const reason = `CPC real R$${cpc.toFixed(2)} → bid alvo ${(CPC_BID_RATIO * 100).toFixed(0)}% do CPC = R$${targetBid.toFixed(2)} (era R$${currentBid.toFixed(2)})`;

          // Enviar para Amazon
          const resp = await adsRequest(
            'PUT', '/sp/keywords',
            { keywords: [{ keywordId: kw.keyword_id, bid: targetBid }] },
            refreshToken, profileId
          );

          if ([200, 207].includes(resp.status)) {
            await base44.asServiceRole.entities.Keyword.update(kw.id, {
              current_bid: targetBid,
              bid: targetBid,
              last_seen_at: now.toISOString(),
            });

            await base44.asServiceRole.entities.AdsBidChangeLog.create({
              amazon_account_id: account.id,
              keyword_id: kw.keyword_id,
              keyword: kw.keyword_text || kw.keyword || '',
              campaign_id: kw.campaign_id || '',
              old_bid: currentBid,
              new_bid: targetBid,
              change_amount: parseFloat((targetBid - currentBid).toFixed(2)),
              change_percent: parseFloat((((targetBid - currentBid) / Math.max(currentBid, 0.01)) * 100).toFixed(1)),
              direction,
              reason,
              evidence: `clicks=${clicks} spend=${spend.toFixed(2)} cpc=${cpc.toFixed(2)} ratio=${CPC_BID_RATIO}`,
              ai_confidence: 85,
              risk_level: 'low',
              status: 'executed',
              created_at: now.toISOString(),
            });

            summary.keywords_adjusted++;
            summary.adjustments.push({
              keyword: kw.keyword_text || kw.keyword,
              cpc,
              old_bid: currentBid,
              new_bid: targetBid,
              direction,
            });
          } else {
            summary.errors.push(`kw ${kw.keyword_id}: HTTP ${resp.status}`);
          }

          // Pausa para rate limits
          await new Promise(r => setTimeout(r, 300));
        }

        summary.accounts_processed++;
      } catch (accError) {
        summary.errors.push(`Conta ${account.id}: ${accError.message}`);
      }
    }

    return Response.json({
      ok: true,
      rule: 'smart_bid_50pct_cpc',
      cpc_bid_ratio: CPC_BID_RATIO,
      summary,
      executed_at: now.toISOString(),
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});