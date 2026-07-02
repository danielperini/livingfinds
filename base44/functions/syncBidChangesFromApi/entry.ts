/**
 * syncBidChangesFromApi — Busca bids atuais das keywords via Amazon Ads API
 * e compara com os valores anteriores para registrar alterações no AdsBidChangeLog.
 * Detecta mudanças feitas tanto pelo Autopilot quanto manualmente no console Amazon.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const TOKEN_CACHE = {};

async function getAdsToken() {
  const c = TOKEN_CACHE['ads'];
  if (c && c.expires_at > Date.now()) return c.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: Deno.env.get('ADS_REFRESH_TOKEN'),
    client_id: Deno.env.get('ADS_CLIENT_ID'),
    client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token refresh failed');
  TOKEN_CACHE['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function baseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsCall(method, path, body, ct = 'application/json') {
  const token = await getAdsToken();
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
      'Content-Type': ct,
      'Accept': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl()}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`ADS ${res.status} ${path}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  const base44 = createClientFromRequest(req);
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  try {
    const body = await req.json().catch(() => ({}));
    let amazonAccountId = body.amazon_account_id;

    let account = null;
    if (amazonAccountId) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazonAccountId });
      account = accs[0] || null;
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
      if (account) amazonAccountId = account.id;
    }
    if (!account) return Response.json({ ok: false, message: 'Nenhuma conta conectada' });

    const sym = account.currency_symbol || 'R$';

    // 1. Buscar keywords atuais da Amazon Ads API
    let kwFromApi = [];
    try {
      const data = await adsCall(
        'POST', '/sp/keywords/list',
        { stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 1000 },
        'application/vnd.spKeyword.v3+json'
      );
      kwFromApi = data?.keywords || (Array.isArray(data) ? data : []);
    } catch (e) {
      return Response.json({ ok: false, error: `Falha na API Amazon Ads: ${e.message}` });
    }

    if (kwFromApi.length === 0) {
      return Response.json({ ok: true, changes: 0, message: 'Nenhuma keyword retornada pela API.' });
    }

    // 2. Buscar keywords locais para comparar bid anterior
    const localKws = await base44.asServiceRole.entities.Keyword.filter(
      { amazon_account_id: amazonAccountId }, null, 2000
    );
    const localKwMap = new Map(localKws.map(k => [k.keyword_id, k]));

    // 3. Buscar campanhas para enriquecer o log
    const campaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: amazonAccountId }, null, 500
    );
    const campMap = new Map(campaigns.map(c => [c.campaign_id, c]));

    // 4. Detectar alterações de bid
    const logsToCreate = [];
    const kwsToUpdate = [];
    let changes = 0, increases = 0, decreases = 0;

    for (const apiKw of kwFromApi) {
      const kwId = String(apiKw.keywordId);
      const newBid = apiKw.bid || 0;
      const local = localKwMap.get(kwId);
      const oldBid = local ? (local.current_bid || local.bid || 0) : null;

      // Atualizar keyword local com bid atual da API
      if (local) {
        kwsToUpdate.push({ id: local.id, bid: newBid, current_bid: newBid, synced_at: now });
      } else {
        // Nova keyword encontrada na API - criar local
        const camp = campMap.get(String(apiKw.campaignId));
        await base44.asServiceRole.entities.Keyword.create({
          amazon_account_id: amazonAccountId,
          campaign_id: String(apiKw.campaignId),
          ad_group_id: String(apiKw.adGroupId),
          keyword_id: kwId,
          keyword_text: apiKw.keywordText || '',
          keyword: apiKw.keywordText || '',
          match_type: (apiKw.matchType || 'broad').toLowerCase(),
          state: (apiKw.state || 'enabled').toLowerCase(),
          bid: newBid,
          current_bid: newBid,
          synced_at: now,
        });
        continue; // sem histórico para comparar
      }

      // Só registrar alteração se houver diferença significativa (> R$0.01)
      if (oldBid === null || Math.abs(newBid - oldBid) < 0.01) continue;

      const direction = newBid > oldBid ? 'increase' : 'decrease';
      const camp = campMap.get(String(apiKw.campaignId));
      const changePct = oldBid > 0 ? ((newBid - oldBid) / oldBid * 100) : 0;

      logsToCreate.push({
        amazon_account_id: amazonAccountId,
        date: today,
        campaign_id: String(apiKw.campaignId),
        campaign_name: camp?.name || camp?.campaign_name || '',
        ad_group_id: String(apiKw.adGroupId),
        keyword_id: kwId,
        keyword: apiKw.keywordText || local?.keyword_text || local?.keyword || '',
        asin: camp?.asin || local?.asin || '',
        old_bid: oldBid,
        new_bid: newBid,
        change_amount: Number((newBid - oldBid).toFixed(4)),
        change_percent: Number(changePct.toFixed(2)),
        direction,
        reason: `Alteração detectada via sync Amazon Ads API (${today})`,
        evidence: `Bid anterior: ${sym}${oldBid.toFixed(2)} → Bid atual: ${sym}${newBid.toFixed(2)}`,
        ai_confidence: 0,
        risk_level: 'low',
        status: 'executed',
        created_at: now,
      });

      if (direction === 'increase') increases++;
      else decreases++;
      changes++;
    }

    // 5. Bulk update keywords locais em lotes
    for (let i = 0; i < kwsToUpdate.length; i += 50) {
      await base44.asServiceRole.entities.Keyword.bulkUpdate(kwsToUpdate.slice(i, i + 50));
    }

    // 6. Criar logs de alteração em lotes
    for (let i = 0; i < logsToCreate.length; i += 50) {
      await base44.asServiceRole.entities.AdsBidChangeLog.bulkCreate(logsToCreate.slice(i, i + 50));
    }

    return Response.json({
      ok: true,
      keywords_synced: kwFromApi.length,
      changes,
      increases,
      decreases,
      duration_ms: Date.now() - startTime,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});