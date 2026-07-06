// v2 — lógica de reparo inlinada (sem invoke intermediário para evitar 403 na cadeia asServiceRole)
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function repairItem(b: any, item: any): Promise<{ ok: boolean; complete: boolean; error?: string; details?: any }> {
  const accountId = item.amazon_account_id;
  const asin = String(item.asin || '').trim().toUpperCase();
  const campaignId = String(item.campaign_id || '').trim();

  if (!accountId || !asin || !campaignId) throw new Error(`Dados inválidos: accountId=${accountId} asin=${asin} campaignId=${campaignId}`);

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

  const products = await b.asServiceRole.entities.Product.filter({ amazon_account_id: accountId, asin }, '-updated_date', 1).catch(() => []);
  const product = products[0] || {};

  // Buscar ad groups EXACT na campanha
  const gr = await adsCall(base, token, clientId, profileId, 'POST', '/sp/adGroups/list', CT_AG, {
    campaignIdFilter: { include: [campaignId] },
    stateFilter: { include: ['ENABLED', 'PAUSED'] },
    maxResults: 100,
  });
  let adGroups = list(gr, 'adGroups').filter((v: any) => String(v.name || '').toUpperCase().includes('EXACT'));

  // Se não houver ad group EXACT, criar
  if (!adGroups.length) {
    const cr = await adsCall(base, token, clientId, profileId, 'POST', '/sp/adGroups', CT_AG, {
      adGroups: [{ name: `AG | EXACT | ${asin}`, campaignId, defaultBid: 0.5, state: 'ENABLED' }],
    });
    const newId = createdId(cr, 'adGroups', 'adGroupId');
    if (!newId) throw new Error(cr?.errors?.[0]?.message || 'Falha ao criar ad group EXACT');
    adGroups = [{ adGroupId: newId, state: 'ENABLED' }];
    await wait(14000);
  }

  const adGroupId = String(adGroups[0].adGroupId);

  // Verificar/criar product ad
  const par = await adsCall(base, token, clientId, profileId, 'POST', '/sp/productAds/list', CT_PA, {
    campaignIdFilter: { include: [campaignId] }, adGroupIdFilter: { include: [adGroupId] },
    stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] }, maxResults: 100,
  });
  const activeAds = list(par, 'productAds').filter((v: any) => String(v.state || '').toUpperCase() === 'ENABLED');

  if (!activeAds.length) {
    const created = await adsCall(base, token, clientId, profileId, 'POST', '/sp/productAds', CT_PA, {
      productAds: [{ campaignId, adGroupId, ...(product?.sku ? { sku: product.sku } : { asin }), state: 'ENABLED' }],
    });
    if (!created?.ok && created?.status !== 207) throw new Error(created?.errors?.[0]?.message || 'Falha ao criar product ad');
    await wait(14000);
  }

  // Verificar/criar keywords EXACT
  const kr = await adsCall(base, token, clientId, profileId, 'POST', '/sp/keywords/list', CT_KW, {
    campaignIdFilter: { include: [campaignId] }, adGroupIdFilter: { include: [adGroupId] },
    stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] }, matchTypeFilter: ['EXACT'], maxResults: 100,
  });
  let activeKw = list(kr, 'keywords').filter((v: any) => String(v.state || '').toUpperCase() === 'ENABLED');

  const addedKeywords: string[] = [];
  if (!activeKw.length) {
    const terms = await b.asServiceRole.entities.TermBank.filter({ amazon_account_id: accountId, asin }, '-performance_score', 10).catch(() => []);
    const candidates = terms.map((t: any) => String(t.term || '').trim()).filter(Boolean).slice(0, 4);
    if (!candidates.length) {
      // Usar primeiras 4 palavras do título, removendo caracteres especiais, max 80 chars
      const rawName = String(product?.product_name || product?.display_name || asin);
      const cleanName = rawName.replace(/[,;:!?@#$%^&*()+={}[\]|\\<>]/g, ' ').replace(/\s+/g, ' ').trim();
      const shortName = cleanName.split(' ').slice(0, 4).join(' ').slice(0, 80);
      candidates.push(shortName || asin);
    }

    for (const keyword of candidates) {
      const created = await adsCall(base, token, clientId, profileId, 'POST', '/sp/keywords', CT_KW, {
        keywords: [{ campaignId, adGroupId, keywordText: keyword, matchType: 'EXACT', state: 'ENABLED', bid: 0.5 }],
      });
      if (created?.ok || createdId(created, 'keywords', 'keywordId')) addedKeywords.push(keyword);
      await wait(14000);
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

  // Atualizar banco local
  const local = await b.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId, campaign_id: campaignId }, '-updated_date', 1).catch(() => []);
  if (local[0]) {
    await b.asServiceRole.entities.Campaign.update(local[0].id, {
      is_incomplete: !complete,
      keyword_count: activeKw.length,
      product_ad_count: finalAds.length,
      last_repair_error: complete ? null : 'Grupo EXACT sem keyword ou anúncio ativo após reparo',
    }).catch(() => {});
  }

  return { ok: complete, complete, details: { adGroupId, active_keywords: activeKw.length, active_product_ads: finalAds.length, added_keywords: addedKeywords } };
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

    const rows = scheduled.filter(isDue).slice(0, 10);
    const results: any[] = [];

    for (const item of rows) {
      const attempts = Number(item.attempt_count || 0) + 1;
      await b.asServiceRole.entities.KeywordRepairQueue.update(item.id, {
        status: 'processing', attempt_count: attempts, started_at: new Date().toISOString(), last_error: null,
      });

      try {
        const result = await repairItem(b, item);
        const retry = !result.complete && attempts < Number(item.max_attempts || 5);

        await b.asServiceRole.entities.KeywordRepairQueue.update(item.id, {
          status: result.complete ? 'completed' : retry ? 'scheduled' : 'failed',
          attempt_count: attempts,
          scheduled_at: retry ? new Date(Date.now() + 60000).toISOString() : item.scheduled_at,
          completed_at: result.complete || !retry ? new Date().toISOString() : null,
          last_error: result.complete ? null : String(result.error || 'Incompleto após reparo').slice(0, 500),
        });

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
      ok: true, hour, scheduled_found: scheduled.length,
      overdue_processed: results.length, results,
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || 'Erro na fila de reparo EXACT' }, { status: 500 });
  }
});