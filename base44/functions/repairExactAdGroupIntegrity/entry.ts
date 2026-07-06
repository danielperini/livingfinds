// v2 — chamadas Amazon inlinadas (sem invoke intermediário para evitar 403 na cadeia asServiceRole)
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

Deno.serve(async (req) => {
  try {
    const b = createClientFromRequest(req);
    const x = await req.json().catch(() => ({}));
    if (!x._service_role || !x.amazon_account_id || !x.asin) {
      return Response.json({ ok: false, error: 'Parâmetros inválidos' }, { status: 400 });
    }

    const accountId = x.amazon_account_id;
    const asin = String(x.asin).trim().toUpperCase();
    const forceCampaignId = x.campaign_id ? String(x.campaign_id) : null;

    const accounts = await b.asServiceRole.entities.AmazonAccount.filter({ id: accountId }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' }, { status: 404 });

    const token = await getToken(account);
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const profileId = String(account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '');
    const base = adsBase(account.region);
    const CT_C = 'application/vnd.spCampaign.v3+json';
    const CT_AG = 'application/vnd.spAdGroup.v3+json';
    const CT_PA = 'application/vnd.spProductAd.v3+json';
    const CT_KW = 'application/vnd.spKeyword.v3+json';

    const products = await b.asServiceRole.entities.Product.filter({ amazon_account_id: accountId, asin }, '-updated_date', 1).catch(() => []);
    const product = products[0] || {};

    // Buscar campanhas MANUAL — por ID específico ou pelo nome contendo ASIN
    let campaigns: any[] = [];
    if (forceCampaignId) {
      const cr = await adsCall(base, token, clientId, profileId, 'POST', '/sp/campaigns/list', CT_C, {
        campaignIdFilter: { include: [forceCampaignId] },
        stateFilter: { include: ['ENABLED', 'PAUSED'] },
        maxResults: 10,
      });
      campaigns = list(cr, 'campaigns');
    } else {
      const cr = await adsCall(base, token, clientId, profileId, 'POST', '/sp/campaigns/list', CT_C, {
        stateFilter: { include: ['ENABLED', 'PAUSED'] },
        targetingTypeFilter: ['MANUAL'],
        maxResults: 500,
      });
      campaigns = list(cr, 'campaigns').filter((v: any) => String(v.name || '').includes(asin));
    }

    if (!campaigns.length) {
      return Response.json({ ok: false, asin, error: `Nenhuma campanha MANUAL encontrada para ASIN ${asin}`, checked: 0, results: [] });
    }

    const results: any[] = [];

    for (const c of campaigns) {
      const campaignId = String(c.campaignId);
      const item: any = { campaign_id: campaignId, asin, added_keywords: [], product_ad_created: false };

      // Buscar ad groups EXACT
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
        if (!newId) { item.ok = false; item.error = cr?.errors?.[0]?.message || 'Falha ao criar ad group EXACT'; results.push(item); continue; }
        item.ad_group_created = true;
        adGroups = [{ adGroupId: newId, state: 'ENABLED' }];
        await wait(14000);
      }

      for (const g of adGroups) {
        const adGroupId = String(g.adGroupId);
        item.ad_group_id = adGroupId;

        // Verificar/criar product ad
        const par = await adsCall(base, token, clientId, profileId, 'POST', '/sp/productAds/list', CT_PA, {
          campaignIdFilter: { include: [campaignId] },
          adGroupIdFilter: { include: [adGroupId] },
          stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
          maxResults: 100,
        });
        let activeAds = list(par, 'productAds').filter((v: any) => String(v.state || '').toUpperCase() === 'ENABLED');

        if (!activeAds.length) {
          const created = await adsCall(base, token, clientId, profileId, 'POST', '/sp/productAds', CT_PA, {
            productAds: [{ campaignId, adGroupId, ...(product?.sku ? { sku: product.sku } : { asin }), state: 'ENABLED' }],
          });
          if (!created?.ok && created?.status !== 207) {
            item.ok = false;
            item.error = created?.errors?.[0]?.message || 'Falha ao criar product ad';
            results.push(item);
            continue;
          }
          item.product_ad_created = true;
          await wait(14000);
        }

        // Verificar/criar keywords EXACT
        const kr = await adsCall(base, token, clientId, profileId, 'POST', '/sp/keywords/list', CT_KW, {
          campaignIdFilter: { include: [campaignId] },
          adGroupIdFilter: { include: [adGroupId] },
          stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
          matchTypeFilter: ['EXACT'],
          maxResults: 100,
        });
        let activeKw = list(kr, 'keywords').filter((v: any) => String(v.state || '').toUpperCase() === 'ENABLED');

        if (!activeKw.length) {
          const terms = await b.asServiceRole.entities.TermBank.filter({ amazon_account_id: accountId, asin }, '-performance_score', 10).catch(() => []);
          const candidates = terms.map((t: any) => String(t.term || '').trim()).filter(Boolean).slice(0, 4);
          if (!candidates.length) candidates.push(String(product?.product_name || product?.display_name || asin).slice(0, 80));

          for (const keyword of candidates) {
            const created = await adsCall(base, token, clientId, profileId, 'POST', '/sp/keywords', CT_KW, {
              keywords: [{ campaignId, adGroupId, keywordText: keyword, matchType: 'EXACT', state: 'ENABLED', bid: 0.5 }],
            });
            const kwId = createdId(created, 'keywords', 'keywordId');
            if (created?.ok || kwId) {
              item.added_keywords.push(keyword);
            } else {
              item.keyword_create_error = created?.errors?.[0]?.message || JSON.stringify(created?.payload || {}).slice(0, 200);
            }
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
        activeAds = list(va, 'productAds').filter((v: any) => String(v.state || '').toUpperCase() === 'ENABLED');

        item.active_keywords = activeKw.length;
        item.active_product_ads = activeAds.length;
        item.ok = activeKw.length > 0 && activeAds.length > 0;
        item.complete = item.ok;

        const local = await b.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId, campaign_id: campaignId }, '-updated_date', 1).catch(() => []);
        if (local[0]) {
          await b.asServiceRole.entities.Campaign.update(local[0].id, {
            is_incomplete: !item.ok,
            keyword_count: activeKw.length,
            product_ad_count: activeAds.length,
            last_repair_error: item.ok ? null : 'Grupo EXACT sem keyword ativa ou anúncio ativo',
          }).catch(() => {});
        }
        results.push(item);
        await wait(14000);
      }
    }

    return Response.json({
      ok: results.every((r: any) => r.ok),
      asin, checked: results.length,
      complete: results.filter((r: any) => r.ok).length,
      incomplete: results.filter((r: any) => !r.ok).length,
      results,
    });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || 'Erro no reparo EXACT' }, { status: 500 });
  }
});