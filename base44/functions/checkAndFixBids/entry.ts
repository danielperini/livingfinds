/**
 * checkAndFixBids — Verifica ad groups e keywords das campanhas ENABLED
 * e garante bid mínimo de R$0,50 em tudo que estiver abaixo.
 * Payload: { amazon_account_id, dry_run?: boolean, min_bid?: number }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

async function getToken(base44: any) {
  const accounts = await base44.asServiceRole.entities.AmazonAccount.list();
  const refreshToken = accounts[0]?.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: Deno.env.get('ADS_CLIENT_ID'),
      client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
    }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token failed');
  return data.access_token;
}

async function apiPost(url: string, headers: any, body: any) {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

async function apiPut(url: string, headers: any, body: any) {
  const res = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false, min_bid = 0.50 } = body;

    const baseUrl = 'https://advertising-api.amazon.com';
    const clientId = Deno.env.get('ADS_CLIENT_ID');
    const profileId = Deno.env.get('ADS_PROFILE_ID');
    const token = await getToken(base44);

    const spHeaders = {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': 'application/vnd.spCampaign.v3+json',
      'Accept': 'application/vnd.spCampaign.v3+json',
    };

    // 1. Buscar TODAS campanhas ENABLED
    let allCampaigns: any[] = [];
    let nextToken: string | null = null;
    do {
      const reqBody: any = { stateFilter: { include: ['ENABLED'] }, maxResults: 100 };
      if (nextToken) reqBody.nextToken = nextToken;
      const r = await apiPost(`${baseUrl}/sp/campaigns/list`, spHeaders, reqBody);
      allCampaigns = allCampaigns.concat(r.data?.campaigns || []);
      nextToken = r.data?.nextToken || null;
    } while (nextToken);

    const campaignIds = allCampaigns.map((c: any) => c.campaignId);
    if (campaignIds.length === 0) {
      return Response.json({ ok: true, message: 'Nenhuma campanha ENABLED encontrada', campaigns: 0 });
    }

    // 2. Buscar ad groups dessas campanhas
    const adGroupHeaders = {
      ...spHeaders,
      'Content-Type': 'application/vnd.spAdGroup.v3+json',
      'Accept': 'application/vnd.spAdGroup.v3+json',
    };

    let allAdGroups: any[] = [];
    // Processar em lotes de 50 campaign IDs
    for (let i = 0; i < campaignIds.length; i += 50) {
      const chunk = campaignIds.slice(i, i + 50);
      let agNext: string | null = null;
      do {
        const agBody: any = { campaignIdFilter: { include: chunk }, stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 100 };
        if (agNext) agBody.nextToken = agNext;
        const r = await apiPost(`${baseUrl}/sp/adGroups/list`, adGroupHeaders, agBody);
        allAdGroups = allAdGroups.concat(r.data?.adGroups || []);
        agNext = r.data?.nextToken || null;
      } while (agNext);
      if (i + 50 < campaignIds.length) await new Promise(r => setTimeout(r, 300));
    }

    // 3. Verificar ad groups com defaultBid < min_bid
    const lowBidAdGroups = allAdGroups.filter((ag: any) => (ag.defaultBid || 0) < min_bid);

    // 4. Buscar keywords de todas as campanhas ENABLED
    const kwHeaders = {
      ...spHeaders,
      'Content-Type': 'application/vnd.spKeyword.v3+json',
      'Accept': 'application/vnd.spKeyword.v3+json',
    };

    let allKeywords: any[] = [];
    for (let i = 0; i < campaignIds.length; i += 50) {
      const chunk = campaignIds.slice(i, i + 50);
      let kwNext: string | null = null;
      do {
        const kwBody: any = { campaignIdFilter: { include: chunk }, stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 100 };
        if (kwNext) kwBody.nextToken = kwNext;
        const r = await apiPost(`${baseUrl}/sp/keywords/list`, kwHeaders, kwBody);
        allKeywords = allKeywords.concat(r.data?.keywords || []);
        kwNext = r.data?.nextToken || null;
      } while (kwNext);
      if (i + 50 < campaignIds.length) await new Promise(r => setTimeout(r, 300));
    }

    const lowBidKeywords = allKeywords.filter((kw: any) => (kw.bid || 0) < min_bid);

    if (dry_run) {
      return Response.json({
        ok: true,
        dry_run: true,
        campaigns_enabled: allCampaigns.length,
        ad_groups_total: allAdGroups.length,
        ad_groups_low_bid: lowBidAdGroups.length,
        keywords_total: allKeywords.length,
        keywords_low_bid: lowBidKeywords.length,
        min_bid,
        sample_low_adgroups: lowBidAdGroups.slice(0, 10).map((ag: any) => ({
          id: ag.adGroupId, name: ag.name, current_bid: ag.defaultBid, campaign_id: ag.campaignId
        })),
        sample_low_keywords: lowBidKeywords.slice(0, 10).map((kw: any) => ({
          id: kw.keywordId, text: kw.keywordText, current_bid: kw.bid, match_type: kw.matchType
        })),
      });
    }

    // 5. Atualizar ad groups com bid baixo
    let agFixed = 0, agFailed = 0;
    const BATCH = 20;
    for (let i = 0; i < lowBidAdGroups.length; i += BATCH) {
      const batch = lowBidAdGroups.slice(i, i + BATCH);
      const payload = { adGroups: batch.map((ag: any) => ({ adGroupId: ag.adGroupId, defaultBid: min_bid })) };
      const r = await apiPut(`${baseUrl}/sp/adGroups`, adGroupHeaders, payload);
      const success = r.data?.adGroups?.success || [];
      agFixed += success.length;
      agFailed += batch.length - success.length;
      if (i + BATCH < lowBidAdGroups.length) await new Promise(r => setTimeout(r, 400));
    }

    // 6. Atualizar keywords com bid baixo
    let kwFixed = 0, kwFailed = 0;
    for (let i = 0; i < lowBidKeywords.length; i += BATCH) {
      const batch = lowBidKeywords.slice(i, i + BATCH);
      const payload = { keywords: batch.map((kw: any) => ({ keywordId: kw.keywordId, bid: min_bid })) };
      const r = await apiPut(`${baseUrl}/sp/keywords`, kwHeaders, payload);
      const success = r.data?.keywords?.success || [];
      kwFixed += success.length;
      kwFailed += batch.length - success.length;
      if (i + BATCH < lowBidKeywords.length) await new Promise(r => setTimeout(r, 400));
    }

    // 7. Atualizar banco local
    if (amazon_account_id && (agFixed + kwFixed) > 0) {
      const allLocalKws = await base44.asServiceRole.entities.Keyword.filter(
        { amazon_account_id, bid: { $lt: min_bid } }, null, 500
      );
      if (allLocalKws.length > 0) {
        await base44.asServiceRole.entities.Keyword.updateMany(
          { amazon_account_id, bid: { $lt: min_bid } },
          { $set: { bid: min_bid, current_bid: min_bid } }
        );
      }
    }

    return Response.json({
      ok: true,
      campaigns_enabled: allCampaigns.length,
      ad_groups_total: allAdGroups.length,
      ad_groups_low_bid: lowBidAdGroups.length,
      ad_groups_fixed: agFixed,
      ad_groups_failed: agFailed,
      keywords_total: allKeywords.length,
      keywords_low_bid: lowBidKeywords.length,
      keywords_fixed: kwFixed,
      keywords_failed: kwFailed,
      min_bid,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err?.message || 'Erro inesperado' }, { status: 500 });
  }
});