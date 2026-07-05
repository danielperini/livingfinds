// v3 — lógica de reparo inlinada (sem invoke intermediário para evitar 403)
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hourBR() {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === 'hour')?.value || 0);
}

function due(item: any) {
  if (!item?.scheduled_at) return true;
  const t = new Date(item.scheduled_at).getTime();
  return Number.isNaN(t) || t <= Date.now();
}

function adsBase(region: string | undefined) {
  const v = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (v.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (v.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAccessToken(account: any): Promise<string> {
  const tok = account.ads_refresh_token;
  if (!tok || !tok.startsWith('Atzr|')) throw new Error('Token Amazon Ads não configurado.');
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const secret = Deno.env.get('ADS_CLIENT_SECRET') || '';
  if (!clientId || !secret) throw new Error('Credenciais ADS_CLIENT_ID/ADS_CLIENT_SECRET ausentes');
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok, client_id: clientId, client_secret: secret }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || 'Falha no token Amazon Ads');
  return data.access_token;
}

async function adsCall(base: string, token: string, clientId: string, profileId: string, method: string, path: string, ct: string, payload: any): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': ct,
      Accept: ct,
    },
    signal: controller.signal,
    body: payload == null || method === 'GET' ? undefined : JSON.stringify(payload),
  }).finally(() => clearTimeout(timeout));
  const text = await response.text().catch(() => '');
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  const ok = response.status >= 200 && response.status < 300;
  return { ok, status: response.status, payload: parsed, errors: ok ? [] : [{ code: String(response.status), message: text.slice(0, 300) }] };
}

function listOf(result: any, key: string): any[] {
  const p = result?.payload || result || {};
  if (Array.isArray(p?.[key])) return p[key];
  if (Array.isArray(p)) return p;
  return [];
}

function createdId(result: any, group: string, field: string): string | null {
  const p = result?.payload || result || {};
  return p?.[group]?.success?.[0]?.[field] || p?.success?.[0]?.[field] || p?.[group]?.[0]?.[field] || null;
}

async function repairCampaign(base44: any, item: any): Promise<{ ok: boolean; complete: boolean; repaired: string[]; error?: string }> {
  const accountId = item.amazon_account_id;
  const campaignId = String(item.campaign_id || '').trim();
  const asin = String(item.asin || '').trim().toUpperCase();
  const sku = String(item.sku || '').trim();

  if (!accountId || !campaignId || (!asin && !sku)) {
    throw new Error(`Dados insuficientes: accountId=${accountId}, campaignId=${campaignId}, asin=${asin}`);
  }

  const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
  const account = accounts[0];
  if (!account) throw new Error('Conta Amazon não encontrada');

  const token = await getAccessToken(account);
  const profileId = String(account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '');
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const base = adsBase(account.region);
  const CT_C = 'application/vnd.spCampaign.v3+json';
  const CT_AG = 'application/vnd.spAdGroup.v3+json';
  const CT_PA = 'application/vnd.spProductAd.v3+json';

  // 1. Verificar campanha na Amazon
  const campRes = await adsCall(base, token, clientId, profileId, 'POST', '/sp/campaigns/list', CT_C, {
    campaignIdFilter: { include: [campaignId] },
    stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
    maxResults: 10,
  });
  const campaign = listOf(campRes, 'campaigns').find((c: any) => String(c.campaignId) === campaignId);
  if (!campaign) throw new Error(`Campanha ${campaignId} não encontrada na Amazon (ASIN: ${asin})`);

  const repaired: string[] = [];

  // 2. Ativar campanha se necessário
  if (String(campaign.state || '').toUpperCase() !== 'ENABLED') {
    const r = await adsCall(base, token, clientId, profileId, 'PUT', '/sp/campaigns', CT_C, { campaigns: [{ campaignId, state: 'ENABLED' }] });
    if (!r?.ok && r?.status !== 207) throw new Error(r?.errors?.[0]?.message || 'Falha ao ativar campanha');
    repaired.push('campaign_enabled');
    await wait(14000);
  }

  // 3. Verificar/criar ad group
  const agRes = await adsCall(base, token, clientId, profileId, 'POST', '/sp/adGroups/list', CT_AG, {
    campaignIdFilter: { include: [campaignId] },
    stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
    maxResults: 100,
  });
  if (!agRes?.ok) throw new Error(agRes?.errors?.[0]?.message || 'Falha ao listar ad groups');

  let adGroup = listOf(agRes, 'adGroups').find((g: any) => String(g.state || '').toUpperCase() === 'ENABLED')
    || listOf(agRes, 'adGroups').find((g: any) => String(g.state || '').toUpperCase() !== 'ARCHIVED');

  if (!adGroup) {
    const r = await adsCall(base, token, clientId, profileId, 'POST', '/sp/adGroups', CT_AG, {
      adGroups: [{ name: `AG | AUTO | ${asin || sku}`, campaignId, defaultBid: 0.5, state: 'ENABLED' }],
    });
    const id = createdId(r, 'adGroups', 'adGroupId');
    if (!id) throw new Error(r?.errors?.[0]?.message || 'Amazon não retornou adGroupId');
    adGroup = { adGroupId: String(id), state: 'ENABLED' };
    repaired.push('ad_group_created');
    await wait(14000);
  } else if (String(adGroup.state || '').toUpperCase() !== 'ENABLED') {
    const r = await adsCall(base, token, clientId, profileId, 'PUT', '/sp/adGroups', CT_AG, { adGroups: [{ adGroupId: String(adGroup.adGroupId), state: 'ENABLED' }] });
    if (!r?.ok && r?.status !== 207) throw new Error(r?.errors?.[0]?.message || 'Falha ao ativar ad group');
    repaired.push('ad_group_enabled');
    await wait(14000);
  }

  const adGroupId = String(adGroup.adGroupId);

  // 4. Verificar/criar product ad
  const paRes = await adsCall(base, token, clientId, profileId, 'POST', '/sp/productAds/list', CT_PA, {
    campaignIdFilter: { include: [campaignId] },
    adGroupIdFilter: { include: [adGroupId] },
    stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
    maxResults: 100,
  });
  if (!paRes?.ok) throw new Error(paRes?.errors?.[0]?.message || 'Falha ao listar product ads');

  let productAd = listOf(paRes, 'productAds').find((ad: any) =>
    String(ad.state || '').toUpperCase() === 'ENABLED' &&
    ((asin && String(ad.asin || '').toUpperCase() === asin) || (sku && String(ad.sku || '').toLowerCase() === sku.toLowerCase()))
  ) || listOf(paRes, 'productAds').find((ad: any) => String(ad.state || '').toUpperCase() !== 'ARCHIVED');

  if (!productAd) {
    const r = await adsCall(base, token, clientId, profileId, 'POST', '/sp/productAds', CT_PA, {
      productAds: [{ campaignId, adGroupId, ...(sku ? { sku } : { asin }), state: 'ENABLED' }],
    });
    const id = createdId(r, 'productAds', 'adId') || createdId(r, 'productAds', 'productAdId');
    if (!id && !r?.ok && r?.status !== 207) throw new Error(r?.errors?.[0]?.message || 'Falha ao criar product ad');
    productAd = { adId: id || null, state: 'ENABLED' };
    repaired.push('product_ad_created');
    await wait(14000);
  } else if (String(productAd.state || '').toUpperCase() !== 'ENABLED') {
    const r = await adsCall(base, token, clientId, profileId, 'PUT', '/sp/productAds', CT_PA, { productAds: [{ adId: String(productAd.adId || productAd.productAdId), state: 'ENABLED' }] });
    if (!r?.ok && r?.status !== 207) throw new Error(r?.errors?.[0]?.message || 'Falha ao ativar product ad');
    repaired.push('product_ad_enabled');
    await wait(14000);
  }

  // 5. Atualizar banco local
  const localRows = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId, campaign_id: campaignId }, '-updated_date', 1).catch(() => []);
  const localCampaign = localRows[0] || null;
  if (localCampaign) {
    await base44.asServiceRole.entities.Campaign.update(localCampaign.id, {
      asin: asin || localCampaign.asin || null,
      state: 'enabled', status: 'enabled',
      is_operational: true, requires_attention: false,
      repair_status: repaired.length ? 'repaired' : 'verified',
      repaired_at: new Date().toISOString(),
      last_repair_error: null,
    }).catch(() => {});
  }

  return { ok: true, complete: true, repaired };
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    const hour = Number.isFinite(Number(body.hour)) ? Number(body.hour) : hourBR();
    const forceRun = body.force === true;
    if (!forceRun && ![0, 1, 2, 3, 13].includes(hour)) {
      return Response.json({ ok: true, skipped: true, hour, reason: 'Fora da janela Amazon' });
    }

    const scheduled = await base44.asServiceRole.entities.AutoCampaignRepairQueue.filter({
      ...(body.amazon_account_id ? { amazon_account_id: body.amazon_account_id } : {}),
      status: 'scheduled',
    }, 'scheduled_at', 100).catch(() => []);

    // Processar apenas 1 item por invocação para evitar Rate Limit
    const rows = scheduled.filter(due).slice(0, 1);
    const results: any[] = [];

    for (const item of rows) {
      const attempts = Number(item.attempt_count || 0) + 1;
      await base44.asServiceRole.entities.AutoCampaignRepairQueue.update(item.id, {
        status: 'processing',
        started_at: new Date().toISOString(),
        attempt_count: attempts,
        last_error: null,
      });

      try {
        const result = await repairCampaign(base44, item);
        const complete = result.ok === true && result.complete === true;
        const retry = !complete && attempts < Number(item.max_attempts || 5);

        await base44.asServiceRole.entities.AutoCampaignRepairQueue.update(item.id, {
          status: complete ? 'completed' : retry ? 'scheduled' : 'failed',
          attempt_count: attempts,
          scheduled_at: retry ? new Date(Date.now() + 60000).toISOString() : item.scheduled_at,
          completed_at: complete || !retry ? new Date().toISOString() : null,
          last_error: complete ? null : String(result.error || 'Campanha ainda incompleta').slice(0, 500),
        });

        results.push({ id: item.id, asin: item.asin, campaign_id: item.campaign_id || null, ok: complete, retry_scheduled: retry, repaired: result.repaired });
      } catch (error: any) {
        const retry = attempts < Number(item.max_attempts || 5);
        await base44.asServiceRole.entities.AutoCampaignRepairQueue.update(item.id, {
          status: retry ? 'scheduled' : 'failed',
          attempt_count: attempts,
          scheduled_at: retry ? new Date(Date.now() + 120000).toISOString() : item.scheduled_at,
          completed_at: retry ? null : new Date().toISOString(),
          last_error: String(error?.message || error).slice(0, 500),
        }).catch(() => {});
        results.push({ id: item.id, asin: item.asin, campaign_id: item.campaign_id || null, ok: false, retry_scheduled: retry, error: error?.message || String(error) });
      }

      await wait(500); // pausa mínima (só 1 item por invocação agora)
    }

    return Response.json({
      ok: true, hour, scheduled_found: scheduled.length,
      overdue_processed: results.length, spacing_seconds: 2, results,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro no processador AUTO V2' }, { status: 500 });
  }
});