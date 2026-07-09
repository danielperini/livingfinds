/**
 * syncAdGroupsAndKeywords — Sincroniza Ad Groups + Keywords SP (API v3)
 *
 * Causas corrigidas do erro "Not authorized":
 *  1. Usa ads_refresh_token e ads_profile_id da conta (não da env var global)
 *  2. Headers Content-Type e Accept com vendor MIME type correto para cada endpoint
 *  3. Suporte a _service_role para chamadas de automações internas
 *  4. Bulk upsert para performance e evitar timeout
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function adsBase(region: string): string {
  const r = String(region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAdsToken(account: any): Promise<string> {
  // Sempre usar o refresh token da conta, não a env var global
  const refresh = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN');
  if (!refresh) throw new Error('ads_refresh_token não encontrado na conta');
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const secret = Deno.env.get('ADS_CLIENT_SECRET') || '';
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId, client_secret: secret }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || `Token falhou HTTP ${res.status}`);
  return data.access_token;
}

async function adsPost(base: string, token: string, clientId: string, profileId: string, path: string, body: any, vendorType: string): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': vendorType,
      'Accept': vendorType,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    // Aceitar tanto sessão de usuário quanto chamada interna via _service_role
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const amazonAccountId = body.amazon_account_id;
    if (!amazonAccountId) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    // Carregar conta para obter credenciais corretas
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazonAccountId }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' });

    // Profile ID da conta tem prioridade sobre env var
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID');
    if (!profileId) return Response.json({ ok: false, error: 'ads_profile_id ausente na conta' });

    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const token = await getAdsToken(account);
    const base = adsBase(account.region || Deno.env.get('ADS_REGION') || 'NA');

    let agReceived = 0, agUpserted = 0, kwReceived = 0, kwUpserted = 0;
    const errors: string[] = [];

    // ── Ad Groups SP ──────────────────────────────────────────────────────
    try {
      const agData = await adsPost(base, token, clientId, profileId, '/sp/adGroups/list',
        { stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 500 },
        'application/vnd.spAdGroup.v3+json'
      );
      const agList: any[] = agData?.adGroups || (Array.isArray(agData) ? agData : []);
      agReceived = agList.length;
      console.log(`[syncAGKW] adGroups recebidos: ${agReceived}`);

      if (agList.length > 0) {
        const existingAGs = await base44.asServiceRole.entities.AdGroup.filter(
          { amazon_account_id: amazonAccountId }, null, 5000
        ).catch(() => []);
        const agMap = new Map<string, any>(existingAGs.map((r: any) => [String(r.ad_group_id), r]));

        const toCreate: any[] = [], toUpdate: any[] = [];
        const now = new Date().toISOString();
        for (const ag of agList) {
          const rec = {
            amazon_account_id: amazonAccountId,
            campaign_id: String(ag.campaignId),
            ad_group_id: String(ag.adGroupId),
            name: ag.name,
            state: (ag.state || 'ENABLED').toLowerCase(),
            default_bid: ag.defaultBid?.amount ?? ag.defaultBid ?? 0,
            synced_at: now,
          };
          const cur = agMap.get(String(ag.adGroupId));
          cur ? toUpdate.push({ id: cur.id, ...rec }) : toCreate.push(rec);
        }

        const BATCH = 100;
        for (let i = 0; i < toCreate.length; i += BATCH)
          await base44.asServiceRole.entities.AdGroup.bulkCreate(toCreate.slice(i, i + BATCH));
        for (let i = 0; i < toUpdate.length; i += BATCH)
          await base44.asServiceRole.entities.AdGroup.bulkUpdate(toUpdate.slice(i, i + BATCH));
        agUpserted = toCreate.length + toUpdate.length;
      }
    } catch (e: any) {
      console.error(`[syncAGKW] AdGroups erro: ${e.message}`);
      errors.push(`AdGroups: ${e.message}`);
    }

    // ── Keywords SP ───────────────────────────────────────────────────────
    try {
      const kwData = await adsPost(base, token, clientId, profileId, '/sp/keywords/list',
        { stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 1000 },
        'application/vnd.spKeyword.v3+json'
      );
      const kwList: any[] = kwData?.keywords || (Array.isArray(kwData) ? kwData : []);
      kwReceived = kwList.length;
      console.log(`[syncAGKW] keywords recebidas: ${kwReceived}`);

      if (kwList.length > 0) {
        const existingKWs = await base44.asServiceRole.entities.Keyword.filter(
          { amazon_account_id: amazonAccountId }, null, 10000
        ).catch(() => []);
        const kwMap = new Map<string, any>(existingKWs.map((r: any) => [String(r.keyword_id), r]));

        const toCreate: any[] = [], toUpdate: any[] = [];
        const now = new Date().toISOString();
        for (const kw of kwList) {
          const bid = kw.bid?.amount ?? kw.bid ?? 0;
          const rec = {
            amazon_account_id: amazonAccountId,
            campaign_id: String(kw.campaignId),
            ad_group_id: String(kw.adGroupId),
            keyword_id: String(kw.keywordId),
            keyword_text: kw.keywordText,
            keyword: kw.keywordText,
            match_type: (kw.matchType || 'BROAD').toLowerCase(),
            state: (kw.state || 'ENABLED').toLowerCase(),
            status: (kw.state || 'ENABLED').toLowerCase(),
            bid,
            current_bid: bid,
            synced_at: now,
            last_seen_at: now,
          };
          const cur = kwMap.get(String(kw.keywordId));
          cur ? toUpdate.push({ id: cur.id, ...rec }) : toCreate.push(rec);
        }

        const BATCH = 100;
        for (let i = 0; i < toCreate.length; i += BATCH)
          await base44.asServiceRole.entities.Keyword.bulkCreate(toCreate.slice(i, i + BATCH));
        for (let i = 0; i < toUpdate.length; i += BATCH)
          await base44.asServiceRole.entities.Keyword.bulkUpdate(toUpdate.slice(i, i + BATCH));
        kwUpserted = toCreate.length + toUpdate.length;
      }
    } catch (e: any) {
      console.error(`[syncAGKW] Keywords erro: ${e.message}`);
      errors.push(`Keywords: ${e.message}`);
    }

    // ── Negative Keywords SP ──────────────────────────────────────────────
    try {
      const negData = await adsPost(base, token, clientId, profileId, '/sp/negativeKeywords/list',
        { stateFilter: { include: ['ENABLED'] }, maxResults: 500 },
        'application/vnd.spNegativeKeyword.v3+json'
      );
      const negList: any[] = negData?.negativeKeywords || (Array.isArray(negData) ? negData : []);
      console.log(`[syncAGKW] negative keywords recebidas: ${negList.length}`);

      if (negList.length > 0) {
        const existingNeg = await base44.asServiceRole.entities.Keyword.filter(
          { amazon_account_id: amazonAccountId, match_type: { $in: ['negative_exact', 'negative_phrase'] } }, null, 5000
        ).catch(() => []);
        const negIds = new Set(existingNeg.map((r: any) => r.keyword_id));
        const toCreate: any[] = [];
        const now = new Date().toISOString();
        for (const kw of negList) {
          const kid = `neg_${kw.keywordId}`;
          if (!negIds.has(kid)) {
            toCreate.push({
              amazon_account_id: amazonAccountId,
              campaign_id: String(kw.campaignId),
              ad_group_id: String(kw.adGroupId),
              keyword_id: kid,
              keyword_text: kw.keywordText,
              keyword: kw.keywordText,
              match_type: `negative_${(kw.matchType || 'exact').toLowerCase()}`,
              state: 'archived',
              status: 'archived',
              bid: 0,
              current_bid: 0,
              synced_at: now,
              last_seen_at: now,
            });
          }
        }
        const BATCH = 100;
        for (let i = 0; i < toCreate.length; i += BATCH)
          await base44.asServiceRole.entities.Keyword.bulkCreate(toCreate.slice(i, i + BATCH));
        kwUpserted += toCreate.length;
      }
    } catch (e: any) {
      console.error(`[syncAGKW] NegKW erro: ${e.message}`);
      errors.push(`NegKW: ${e.message}`);
    }

    const duration = Date.now() - startTime;
    const status = errors.length > 0 && agUpserted + kwUpserted === 0 ? 'error' : errors.length > 0 ? 'partial' : 'success';

    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: amazonAccountId,
      operation: 'ads_sync',
      trigger_type: body.trigger_type || 'manual',
      status,
      execution_date: new Date().toISOString().slice(0, 10),
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: duration,
      records_processed: agUpserted + kwUpserted,
      error_message: errors.join('; ') || null,
    }).catch(() => {});

    return Response.json({
      ok: true,
      adGroups: { received: agReceived, upserted: agUpserted },
      keywords: { received: kwReceived, upserted: kwUpserted },
      errors,
      duration_ms: duration,
    });

  } catch (error: any) {
    console.error('[syncAGKW] erro crítico:', error?.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});