/**
 * bulkSetAllBids — reduz somente bids acima do teto informado.
 * Nunca aumenta um bid existente. Teto absoluto: R$1,00.
 * Payload: { amazon_account_id, bid? (default 1.00), _service_role? }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { winnerBidEligibility } from '../../shared/winnerBidPolicy.ts';

const tokenCache = {};

async function getToken() {
  const cached = tokenCache['ads'];
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
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
  tokenCache['ads'] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function baseUrl() {
  const r = (Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsCall(method, path, body, contentType = 'application/json') {
  const token = await getToken();
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(Deno.env.get('ADS_PROFILE_ID')),
      'Content-Type': contentType,
      'Accept': contentType,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

async function listAll(path, key, contentType) {
  const rows = [];
  let nextToken;
  for (let page = 0; page < 100; page++) {
    const response = await adsCall('POST', path, {
      stateFilter: { include: ['ENABLED', 'PAUSED'] },
      maxResults: 100,
      ...(nextToken ? { nextToken } : {}),
    }, contentType);
    if (!response.ok) return { ok: false, status: response.status, data: response.data, rows };
    rows.push(...(response.data?.[key] || (Array.isArray(response.data) ? response.data : [])));
    nextToken = response.data?.nextToken;
    if (!nextToken) return { ok: true, rows };
  }
  return { ok: false, status: 508, data: { error: 'Limite de paginação excedido' }, rows };
}

// chunk array into batches of N
function chunk(arr, size) {
  const result = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const user = body._service_role === true ? { role: 'service' } : await base44.auth.me().catch(() => null);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    let amazonAccountId = body.amazon_account_id;
    const targetBid = Math.max(0.02, Math.min(1, typeof body.bid === 'number' ? body.bid : 1));

    if (!amazonAccountId) {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.list('-updated_date', 50);
      amazonAccountId = accounts.find(account => account.ads_profile_id)?.id || accounts[0]?.id;
    }
    if (!amazonAccountId) return Response.json({ error: 'Nenhuma conta Amazon configurada' }, { status: 400 });

    const now = new Date().toISOString();
    const [performanceRows, localKeywordRows] = await Promise.all([
      base44.asServiceRole.entities.PerformanceSettings.filter(
        { amazon_account_id: amazonAccountId }, '-updated_at', 10,
      ).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter(
        { amazon_account_id: amazonAccountId }, '-synced_at', 10000,
      ).catch(() => []),
    ]);
    const targetAcos = Number(performanceRows[0]?.target_acos || 0);
    const localKeywordById = new Map();
    for (const row of localKeywordRows) {
      const id = String(row.keyword_id || '');
      if (id && !localKeywordById.has(id)) localKeywordById.set(id, row);
    }
    let kwTotal = 0, kwOk = 0, kwFailed = 0;
    let agTotal = 0, agOk = 0, agFailed = 0;
    let targetTotal = 0, targetOk = 0, targetFailed = 0;
    const errors = [];

    // ─────────────────────────────────────────────────────────────
    // 1. Buscar keywords SP ativas/pausadas da Amazon API
    // ─────────────────────────────────────────────────────────────
    const kwRes = await listAll('/sp/keywords/list', 'keywords', 'application/vnd.spKeyword.v3+json');

    if (!kwRes.ok) {
      return Response.json({ ok: false, error: `Falha ao listar keywords: ${JSON.stringify(kwRes.data).slice(0, 300)}` }, { status: 500 });
    }

    const allKeywords = kwRes.rows;
    const keywordCeilings = allKeywords.map(kw => {
      const keywordId = String(kw.keywordId || '');
      const eligibility = winnerBidEligibility(localKeywordById.get(keywordId), targetAcos);
      return { ...kw, keywordId, economicCeiling: eligibility.ceiling, winnerEligibility: eligibility };
    });
    const winnerExceptions = keywordCeilings.filter(kw => kw.winnerEligibility.eligible && Number(kw.bid) > targetBid && Number(kw.bid) <= kw.economicCeiling);
    const kwList = keywordCeilings.filter(kw => Number(kw.bid) > kw.economicCeiling);
    kwTotal = kwList.length;

    // 2. Atualizar na Amazon API em batches de 100
    const kwBatches = chunk(kwList, 100);
    for (const batch of kwBatches) {
      const payload = { keywords: batch.map(kw => ({ keywordId: kw.keywordId, bid: kw.economicCeiling })) };
      const r = await adsCall('PUT', '/sp/keywords', payload, 'application/vnd.spKeyword.v3+json');
      if (r.ok) {
        kwOk += batch.length;
      } else {
        kwFailed += batch.length;
        errors.push(`KW batch PUT failed: ${JSON.stringify(r.data).slice(0, 200)}`);
      }
      // Rate limit safety
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    // 3. Atualizar banco local (keyword_id list)
    const correctedKeywords = kwFailed === 0 ? kwList : [];
    for (const keyword of correctedKeywords) {
      await base44.asServiceRole.entities.Keyword.updateMany(
        { amazon_account_id: amazonAccountId, keyword_id: String(keyword.keywordId) },
        { $set: { bid: keyword.economicCeiling, current_bid: keyword.economicCeiling, synced_at: now } }
      ).catch(() => {});
    }

    // ─────────────────────────────────────────────────────────────
    // 4. Buscar ad groups e atualizar default_bid
    // ─────────────────────────────────────────────────────────────
    const agRes = await listAll('/sp/adGroups/list', 'adGroups', 'application/vnd.spAdGroup.v3+json');

    if (agRes.ok) {
      const allAdGroups = agRes.rows;
      const agList = allAdGroups.filter(ag => Number(ag.defaultBid) > targetBid);
      agTotal = agList.length;

      const agBatches = chunk(agList, 100);
      for (const batch of agBatches) {
        const payload = { adGroups: batch.map(ag => ({ adGroupId: ag.adGroupId, defaultBid: targetBid })) };
        const r = await adsCall('PUT', '/sp/adGroups', payload, 'application/vnd.spAdGroup.v3+json');
        if (r.ok) {
          agOk += batch.length;
        } else {
          agFailed += batch.length;
          errors.push(`AG batch PUT failed: ${JSON.stringify(r.data).slice(0, 200)}`);
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      // Atualizar banco local ad groups
      for (const ag of agFailed === 0 ? agList : []) {
        await base44.asServiceRole.entities.AdGroup.updateMany(
          { amazon_account_id: amazonAccountId, ad_group_id: String(ag.adGroupId) },
          { $set: { default_bid: targetBid, synced_at: now } }
        ).catch(() => {});
      }
    } else {
      errors.push(`AdGroups list failed: ${JSON.stringify(agRes.data).slice(0, 200)}`);
      agFailed++;
    }

    // Targets automáticos e por produto também possuem bid próprio.
    const targetRes = await listAll('/sp/targets/list', 'targetingClauses', 'application/vnd.spTargetingClause.v3+json');
    if (targetRes.ok) {
      const targetList = targetRes.rows.filter(target => Number(target.bid) > targetBid);
      targetTotal = targetList.length;
      for (const batch of chunk(targetList, 100)) {
        const payload = { targetingClauses: batch.map(target => ({ targetId: target.targetId, bid: targetBid })) };
        const result = await adsCall('PUT', '/sp/targets', payload, 'application/vnd.spTargetingClause.v3+json');
        if (result.ok) targetOk += batch.length;
        else {
          targetFailed += batch.length;
          errors.push(`Target batch PUT failed: ${JSON.stringify(result.data).slice(0, 200)}`);
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      for (const target of targetFailed === 0 ? targetList : []) {
        await base44.asServiceRole.entities.ProductTarget.updateMany(
          { amazon_account_id: amazonAccountId, target_id: String(target.targetId) },
          { $set: { bid: targetBid, synced_at: now } },
        ).catch(() => {});
      }
    } else {
      targetFailed++;
      errors.push(`Targets list failed: ${JSON.stringify(targetRes.data).slice(0, 200)}`);
    }

    // ─────────────────────────────────────────────────────────────
    // 5. Registrar no log de mudanças
    // ─────────────────────────────────────────────────────────────
    await base44.asServiceRole.entities.CampaignChangeHistory.create({
      amazon_account_id: amazonAccountId,
      campaign_id: 'ALL',
      change_type: 'BASE_BID',
      entity_type: 'keyword',
      field_name: 'bid',
      old_value: 'various',
      new_value: `${targetBid};winner_max=1.50`,
      source: 'USER',
      source_function: 'bulkSetAllBids',
      reason: `Teto econômico R$${targetBid.toFixed(2)}; exceção até R$1,50 somente para keyword winner com vendas, ACoS real dentro da meta e métricas confirmadas nas últimas 72h`,
      status: kwFailed + agFailed + targetFailed === 0 ? 'executed' : 'failed',
      changed_at: now,
    }).catch(() => {});

    return Response.json({
      ok: kwFailed + agFailed + targetFailed === 0,
      target_bid: targetBid,
      keywords: { total: kwTotal, ok: kwOk, failed: kwFailed },
      winner_keyword_exceptions: {
        preserved: winnerExceptions.length,
        ceiling: 1.5,
        target_acos: targetAcos,
        items: winnerExceptions.slice(0, 100).map(kw => ({
          keyword_id: kw.keywordId,
          bid: Number(kw.bid),
          acos: kw.winnerEligibility.acos,
          orders: kw.winnerEligibility.orders,
        })),
      },
      ad_groups: { total: agTotal, ok: agOk, failed: agFailed },
      targets: { total: targetTotal, ok: targetOk, failed: targetFailed },
      errors: errors.length > 0 ? errors : undefined,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});
