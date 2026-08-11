// v3 — reparo 1:1 com ativação de componentes existentes e bid econômico explícito.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const upper = (value: unknown) => String(value || '').trim().toUpperCase();
const numeric = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function keywordFromCampaignName(value: unknown): string {
  const parts = String(value || '').split('|').map((part) => part.trim());
  return parts.length >= 5 ? parts.slice(4).join(' | ').replace(/\s+\+\d+\s*$/i, '').trim().slice(0, 80) : '';
}

function hourBR() {
  const p = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).formatToParts(new Date());
  return Number(p.find((x) => x.type === 'hour')?.value || 0);
}

function isDue(item: any) {
  if (!item?.scheduled_at) return true;
  const ts = new Date(item.scheduled_at).getTime();
  return Number.isNaN(ts) || ts <= Date.now();
}

function adsBase(region: string | undefined) {
  const v = String(region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (v.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (v.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getToken(account: any): Promise<string> {
  const tok = account.ads_refresh_token;
  if (!tok || !tok.startsWith('Atzr|')) throw new Error('Token Amazon Ads não configurado.');
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const secret = Deno.env.get('ADS_CLIENT_SECRET') || '';
  if (!clientId || !secret) throw new Error('ADS_CLIENT_ID/ADS_CLIENT_SECRET ausentes');
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok, client_id: clientId, client_secret: secret }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || 'Falha no token');
  return data.access_token;
}

async function adsCall(base: string, token: string, clientId: string, profileId: string, method: string, path: string, ct: string, payload: any) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': ct, Accept: ct,
    },
    signal: ctrl.signal,
    body: method === 'GET' || payload == null ? undefined : JSON.stringify(payload),
  }).finally(() => clearTimeout(t));
  const text = await res.text().catch(() => '');
  let parsed: any = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  const ok = res.status >= 200 && res.status < 300;
  return { ok, status: res.status, payload: parsed, errors: ok ? [] : [{ code: String(res.status), message: text.slice(0, 300) }] };
}

function list(r: any, k: string): any[] {
  const p = r?.payload || r || {};
  if (Array.isArray(p?.[k])) return p[k];
  if (Array.isArray(p)) return p;
  return [];
}

function createdId(r: any, group: string, field: string): string | null {
  const p = r?.payload || r || {};
  return p?.[group]?.success?.[0]?.[field] || p?.success?.[0]?.[field] || p?.[group]?.[0]?.[field] || null;
}

async function repairItem(b: any, item: any, bidCap: number): Promise<{ ok: boolean; complete: boolean; error?: string; details?: any }> {
  const accountId = item.amazon_account_id;
  const asin = String(item.asin || '').trim().toUpperCase();
  const campaignId = String(item.campaign_id || '').trim();

  if (!accountId || !asin || !campaignId) throw new Error(`Dados inválidos: accountId=${accountId} asin=${asin} campaignId=${campaignId}`);
  const safeBidCap = Math.round(Math.max(0, numeric(bidCap)) * 100) / 100;
  if (safeBidCap < 0.02) throw new Error('SAFE_BID_CAP_REQUIRED');
  const repairBid = Math.max(0.02, Math.min(0.50, safeBidCap));

  const accounts = await b.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
  const account = accounts[0];
  if (!account) throw new Error('Conta Amazon não encontrada');

  const token = await getToken(account);
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const profileId = String(account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '');
  const base = adsBase(account.region);
  const CT_AG = 'application/vnd.spAdGroup.v3+json';
  const CT_PA = 'application/vnd.spProductAd.v3+json';
  const CT_KW = 'application/vnd.spKeyword.v3+json';

  const [products, localCampaigns] = await Promise.all([
    b.asServiceRole.entities.Product.filter({ amazon_account_id: accountId, asin }, '-updated_date', 1).catch(() => []),
    b.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId, campaign_id: campaignId }, '-updated_date', 100).catch(() => []),
  ]);
  const product = products[0] || {};
  const localCampaign = localCampaigns[0] || {};
  const productStock = numeric(product?.fba_inventory ?? product?.available_quantity, -1);
  if (productStock === 0 || ['out_of_stock', 'not_buyable', 'offer_inactive'].includes(String(product?.ads_eligibility_status || product?.inventory_status || '').toLowerCase())) {
    throw new Error('PRODUCT_NOT_ELIGIBLE_FOR_REPAIR');
  }

  // Buscar ad groups EXACT na campanha
  const gr = await adsCall(base, token, clientId, profileId, 'POST', '/sp/adGroups/list', CT_AG, {
    campaignIdFilter: { include: [campaignId] },
    stateFilter: { include: ['ENABLED', 'PAUSED'] },
    maxResults: 100,
  });
  if (!gr.ok) throw new Error(gr?.errors?.[0]?.message || 'Falha ao listar ad groups');
  let adGroups = list(gr, 'adGroups').filter((v: any) => upper(v.name).includes('EXACT'));

  // Se não houver ad group EXACT, criar
  if (!adGroups.length) {
    const cr = await adsCall(base, token, clientId, profileId, 'POST', '/sp/adGroups', CT_AG, {
      adGroups: [{ name: `AG | EXACT | ${asin}`, campaignId, defaultBid: repairBid, state: 'ENABLED' }],
    });
    const newId = createdId(cr, 'adGroups', 'adGroupId');
    if (!newId) throw new Error(cr?.errors?.[0]?.message || 'Falha ao criar ad group EXACT');
    adGroups = [{ adGroupId: newId, state: 'ENABLED' }];
    await wait(14000);
  } else if (upper(adGroups[0].state) !== 'ENABLED') {
    const enabledGroup = await adsCall(base, token, clientId, profileId, 'PUT', '/sp/adGroups', CT_AG, {
      adGroups: [{ adGroupId: String(adGroups[0].adGroupId), state: 'ENABLED', defaultBid: repairBid }],
    });
    if (!enabledGroup.ok && enabledGroup.status !== 207) throw new Error(enabledGroup?.errors?.[0]?.message || 'Falha ao ativar ad group EXACT');
    adGroups[0].state = 'ENABLED';
    await wait(3000);
  }

  const adGroupId = String(adGroups[0].adGroupId);

  // Verificar/criar product ad
  const par = await adsCall(base, token, clientId, profileId, 'POST', '/sp/productAds/list', CT_PA, {
    campaignIdFilter: { include: [campaignId] }, adGroupIdFilter: { include: [adGroupId] },
    stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] }, maxResults: 100,
  });
  if (!par.ok) throw new Error(par?.errors?.[0]?.message || 'Falha ao listar product ads');
  const remoteAds = list(par, 'productAds');
  const activeAds = remoteAds.filter((v: any) => upper(v.state) === 'ENABLED');

  if (!activeAds.length) {
    const pausedAd = remoteAds.find((v: any) => upper(v.state) === 'PAUSED');
    if (pausedAd) {
      const enabledAd = await adsCall(base, token, clientId, profileId, 'PUT', '/sp/productAds', CT_PA, {
        productAds: [{ adId: String(pausedAd.adId || pausedAd.productAdId), state: 'ENABLED' }],
      });
      if (!enabledAd.ok && enabledAd.status !== 207) throw new Error(enabledAd?.errors?.[0]?.message || 'Falha ao ativar product ad');
      await wait(3000);
    } else {
      const created = await adsCall(base, token, clientId, profileId, 'POST', '/sp/productAds', CT_PA, {
        productAds: [{ campaignId, adGroupId, ...(product?.sku ? { sku: product.sku } : { asin }), state: 'ENABLED' }],
      });
      if (!created?.ok && created?.status !== 207) throw new Error(created?.errors?.[0]?.message || 'Falha ao criar product ad');
      await wait(14000);
    }
  }

  // Verificar/criar keywords EXACT
  const kr = await adsCall(base, token, clientId, profileId, 'POST', '/sp/keywords/list', CT_KW, {
    campaignIdFilter: { include: [campaignId] }, adGroupIdFilter: { include: [adGroupId] },
    stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] }, matchTypeFilter: ['EXACT'], maxResults: 100,
  });
  if (!kr.ok) throw new Error(kr?.errors?.[0]?.message || 'Falha ao listar keywords EXACT');
  const remoteExact = list(kr, 'keywords').filter((v: any) => upper(v.matchType || v.match_type) === 'EXACT');
  let activeKw = remoteExact.filter((v: any) => upper(v.state) === 'ENABLED');

  const addedKeywords: string[] = [];
  if (!activeKw.length) {
    const pausedKeyword = remoteExact.find((v: any) => upper(v.state) === 'PAUSED');
    if (pausedKeyword) {
      const currentBid = Math.max(0.02, numeric(pausedKeyword.bid, repairBid));
      const targetBid = Math.min(currentBid, safeBidCap);
      const enabledKeyword = await adsCall(base, token, clientId, profileId, 'PUT', '/sp/keywords', CT_KW, {
        keywords: [{ keywordId: String(pausedKeyword.keywordId), state: 'ENABLED', bid: targetBid }],
      });
      if (!enabledKeyword.ok && enabledKeyword.status !== 207) throw new Error(enabledKeyword?.errors?.[0]?.message || 'Falha ao ativar keyword EXACT');
      await wait(3000);
    } else {
      const terms = await b.asServiceRole.entities.TermBank.filter({ amazon_account_id: accountId, asin, status: 'active' }, '-performance_score', 10).catch(() => []);
      const keyword = keywordFromCampaignName(localCampaign.name || localCampaign.campaign_name) ||
        terms.map((t: any) => String(t.term || '').trim()).find(Boolean) || '';
      if (!keyword) throw new Error('NO_CONFIRMED_ONE_TO_ONE_KEYWORD');
      const created = await adsCall(base, token, clientId, profileId, 'POST', '/sp/keywords', CT_KW, {
        keywords: [{ campaignId, adGroupId, keywordText: keyword, matchType: 'EXACT', state: 'ENABLED', bid: repairBid }],
      });
      if (!created?.ok && !createdId(created, 'keywords', 'keywordId')) throw new Error(created?.errors?.[0]?.message || 'Falha ao criar keyword EXACT 1:1');
      addedKeywords.push(keyword);
      await wait(14000);
    }
  } else {
    const aboveCap = activeKw.filter((v: any) => numeric(v.bid) > safeBidCap + 0.0001);
    for (const keyword of aboveCap) {
      const reduced = await adsCall(base, token, clientId, profileId, 'PUT', '/sp/keywords', CT_KW, {
        keywords: [{ keywordId: String(keyword.keywordId), state: 'ENABLED', bid: safeBidCap }],
      });
      if (!reduced.ok && reduced.status !== 207) throw new Error(reduced?.errors?.[0]?.message || 'Falha ao aplicar safe_max_cpc');
    }
  }

  // Verificação final
  const vk = await adsCall(base, token, clientId, profileId, 'POST', '/sp/keywords/list', CT_KW, {
    campaignIdFilter: { include: [campaignId] }, adGroupIdFilter: { include: [adGroupId] },
    stateFilter: { include: ['ENABLED'] }, matchTypeFilter: ['EXACT'], maxResults: 100,
  });
  const va = await adsCall(base, token, clientId, profileId, 'POST', '/sp/productAds/list', CT_PA, {
    campaignIdFilter: { include: [campaignId] }, adGroupIdFilter: { include: [adGroupId] },
    stateFilter: { include: ['ENABLED'] }, maxResults: 100,
  });
  activeKw = list(vk, 'keywords').filter((v: any) => String(v.state || '').toUpperCase() === 'ENABLED');
  const finalAds = list(va, 'productAds').filter((v: any) => String(v.state || '').toUpperCase() === 'ENABLED');

  const complete = activeKw.length > 0 && finalAds.length > 0;

  // Atualizar o espelho local somente depois da confirmação remota.
  if (complete) {
    const localGroups = await b.asServiceRole.entities.AdGroup.filter({ amazon_account_id: accountId, campaign_id: campaignId }, '-updated_date', 100).catch(() => []);
    for (const localGroup of localGroups.filter((row: any) => String(row.ad_group_id || '') === adGroupId)) {
      await b.asServiceRole.entities.AdGroup.update(localGroup.id, { state: 'enabled', status: 'enabled', synced_at: new Date().toISOString() }).catch(() => {});
    }

    for (const remoteKeyword of activeKw) {
      const keywordId = String(remoteKeyword.keywordId || remoteKeyword.keyword_id || '');
      if (!keywordId) continue;
      const localKeywords = await b.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId, keyword_id: keywordId }, '-updated_date', 100).catch(() => []);
      if (localKeywords.length) {
        for (const localKeyword of localKeywords) {
          await b.asServiceRole.entities.Keyword.update(localKeyword.id, {
            state: 'enabled', status: 'enabled', current_bid: numeric(remoteKeyword.bid, repairBid), bid: numeric(remoteKeyword.bid, repairBid),
            synced_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
          }).catch(() => {});
        }
      } else {
        await b.asServiceRole.entities.Keyword.create({
          amazon_account_id: accountId, campaign_id: campaignId, ad_group_id: adGroupId, keyword_id: keywordId, asin,
          keyword: String(remoteKeyword.keywordText || remoteKeyword.keyword || keywordFromCampaignName(localCampaign.name || localCampaign.campaign_name)),
          keyword_text: String(remoteKeyword.keywordText || remoteKeyword.keyword || keywordFromCampaignName(localCampaign.name || localCampaign.campaign_name)),
          match_type: 'exact', state: 'enabled', status: 'enabled', current_bid: numeric(remoteKeyword.bid, repairBid), bid: numeric(remoteKeyword.bid, repairBid),
          source: 'manual', synced_at: new Date().toISOString(), last_seen_at: new Date().toISOString(),
        }).catch(() => {});
      }
    }

    const localAds = await b.asServiceRole.entities.ProductAd.filter({ amazon_account_id: accountId, campaign_id: campaignId }, '-updated_date', 100).catch(() => []);
    for (const remoteAd of finalAds) {
      const productAdId = String(remoteAd.adId || remoteAd.productAdId || '');
      const matchingLocal = localAds.filter((row: any) => String(row.product_ad_id || row.ad_id || '') === productAdId);
      if (matchingLocal.length) {
        for (const localAd of matchingLocal) {
          await b.asServiceRole.entities.ProductAd.update(localAd.id, { state: 'enabled', status: 'enabled', synced_at: new Date().toISOString() }).catch(() => {});
        }
      } else if (productAdId) {
        await b.asServiceRole.entities.ProductAd.create({
          amazon_account_id: accountId, product_ad_id: productAdId, campaign_id: campaignId, ad_group_id: adGroupId,
          asin, sku: product?.sku || null, state: 'enabled', status: 'enabled', synced_at: new Date().toISOString(),
        }).catch(() => {});
      }
    }
  }

  for (const local of localCampaigns) {
    await b.asServiceRole.entities.Campaign.update(local.id, {
      is_incomplete: !complete,
      completion_status: complete ? 'complete' : 'incomplete',
      repair_status: complete ? 'repaired_confirmed' : 'failed',
      repaired_at: complete ? new Date().toISOString() : null,
      keyword_count: activeKw.length,
      product_ad_count: finalAds.length,
      last_repair_error: complete ? null : 'Grupo EXACT sem keyword ou anúncio ativo após reparo',
    }).catch(() => {});
  }

  return { ok: complete, complete, details: { adGroupId, active_keywords: activeKw.length, active_product_ads: finalAds.length, added_keywords: addedKeywords, safe_bid_cap: safeBidCap, repair_bid: repairBid } };
}

Deno.serve(async (req) => {
  try {
    const b = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    const hour = Number.isFinite(Number(body.hour)) ? Number(body.hour) : hourBR();
    const forceRun = body.force === true;
    if (!forceRun && ![0, 1, 2, 3, 13].includes(hour)) {
      return Response.json({ ok: true, skipped: true, hour, reason: 'Fora da janela Amazon' });
    }

    const scheduled = await b.asServiceRole.entities.KeywordRepairQueue.filter({
      ...(body.amazon_account_id ? { amazon_account_id: body.amazon_account_id } : {}),
      status: 'scheduled',
    }, 'scheduled_at', 100).catch(() => []);

    const campaignIds = new Set((Array.isArray(body.campaign_ids) ? body.campaign_ids : []).map(String).filter(Boolean));
    const maximumItems = Math.max(1, Math.min(10, Math.floor(numeric(body.max_items, 10))));
    const bidCaps = body.repair_bid_caps && typeof body.repair_bid_caps === 'object' ? body.repair_bid_caps : {};
    const uniqueByCampaign = new Map<string, any>();
    for (const item of scheduled.filter(isDue)) {
      const campaignId = String(item.campaign_id || '');
      if (!campaignId || (campaignIds.size && !campaignIds.has(campaignId)) || uniqueByCampaign.has(campaignId)) continue;
      uniqueByCampaign.set(campaignId, item);
    }
    const rows = [...uniqueByCampaign.values()].slice(0, maximumItems);
    const results: any[] = [];

    for (const item of rows) {
      const attempts = Number(item.attempt_count || 0) + 1;
      await b.asServiceRole.entities.KeywordRepairQueue.update(item.id, {
        status: 'processing', attempt_count: attempts, started_at: new Date().toISOString(), last_error: null,
      });

      try {
        const result = await repairItem(b, item, numeric(bidCaps[String(item.campaign_id || '')]));
        const retry = !result.complete && attempts < Number(item.max_attempts || 5);

        await b.asServiceRole.entities.KeywordRepairQueue.update(item.id, {
          status: result.complete ? 'completed' : retry ? 'scheduled' : 'failed',
          attempt_count: attempts,
          scheduled_at: retry ? new Date(Date.now() + 60000).toISOString() : item.scheduled_at,
          completed_at: result.complete || !retry ? new Date().toISOString() : null,
          last_error: result.complete ? null : String(result.error || 'Incompleto após reparo').slice(0, 500),
        });

        if (result.complete) {
          const duplicates = await b.asServiceRole.entities.KeywordRepairQueue.filter({
            amazon_account_id: item.amazon_account_id,
            campaign_id: String(item.campaign_id || ''),
            status: 'scheduled',
          }, '-created_date', 100).catch(() => []);
          for (const duplicate of duplicates) {
            await b.asServiceRole.entities.KeywordRepairQueue.update(duplicate.id, {
              status: 'completed',
              completed_at: new Date().toISOString(),
              last_error: null,
            }).catch(() => {});
          }
        }

        results.push({ id: item.id, asin: item.asin, campaign_id: item.campaign_id, ok: result.complete, retry_scheduled: retry, ...result.details });
      } catch (e: any) {
        const retry = attempts < Number(item.max_attempts || 5);
        await b.asServiceRole.entities.KeywordRepairQueue.update(item.id, {
          status: retry ? 'scheduled' : 'failed',
          attempt_count: attempts,
          scheduled_at: retry ? new Date(Date.now() + 120000).toISOString() : item.scheduled_at,
          completed_at: retry ? null : new Date().toISOString(),
          last_error: String(e?.message || e).slice(0, 500),
        }).catch(() => {});
        results.push({ id: item.id, asin: item.asin, campaign_id: item.campaign_id, ok: false, retry_scheduled: retry, error: e?.message || String(e) });
      }

      await wait(500);
    }

    return Response.json({
      ok: results.every((row) => row.ok), hour, scheduled_found: scheduled.length,
      targeted_campaigns: campaignIds.size,
      overdue_processed: results.length, results,
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || 'Erro na fila de reparo EXACT' }, { status: 500 });
  }
});
