import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getToken() {
  const refresh = Deno.env.get('ADS_REFRESH_TOKEN') || '';
  const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
  const secret = Deno.env.get('ADS_CLIENT_SECRET') || '';
  const resp = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId, client_secret: secret }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) throw new Error(data.error_description || data.error || 'Falha token');
  return data.access_token;
}

async function adsCall(token: string, method: string, path: string, payload?: any, contentType = 'application/vnd.spCampaign.v3+json') {
  const profileId = Deno.env.get('ADS_PROFILE_ID') || '';
  const base = 'https://advertising-api.amazon.com';
  const resp = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': profileId,
      'Content-Type': contentType,
      'Accept': contentType,
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await resp.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: resp.status, ok: resp.ok, data };
}

function idFrom(data: any, group: string, field: string) {
  const p = data?.payload || data || {};
  return p?.[group]?.success?.[0]?.[field] || p?.success?.[0]?.[field] || p?.[group]?.[0]?.[field] || null;
}

function listOf(data: any, key: string) {
  const p = data?.payload || data || {};
  if (Array.isArray(p?.[key])) return p[key];
  if (Array.isArray(p)) return p;
  return [];
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    const body = await request.json().catch(() => ({}));
    if (!authenticated && !body._service_role) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });

    const accountId = body.amazon_account_id;
    if (!accountId) return Response.json({ ok: false, error: 'amazon_account_id obrigatório' }, { status: 400 });

    let token: string;
    try {
      token = await getToken();
    } catch (tokenErr: any) {
      return Response.json({ ok: false, stage: 'get_token', error: tokenErr.message });
    }

    // 1. Buscar campanhas INCOMPLETE na Amazon
    // Primeiro testar com um endpoint simples para confirmar que o token funciona
    const profileResp = await fetch('https://advertising-api.amazon.com/v2/profiles', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      }
    });
    const profileData = await profileResp.json().catch(() => ({}));
    if (!profileResp.ok) {
      return Response.json({ ok: false, error: `Profiles falhou ${profileResp.status}`, detail: profileData });
    }

    const listResp = await adsCall(token, 'POST', '/sp/campaigns/list', {
      stateFilter: { include: ['INCOMPLETE', 'ENABLED', 'PAUSED'] },
      maxResults: 200,
    });

    if (!listResp.ok) {
      return Response.json({ ok: false, error: `Amazon retornou ${listResp.status}`, detail: listResp.data, profiles_ok: true, profile_count: profileData.length });
    }

    const allCampaigns = listOf(listResp.data, 'campaigns');
    const incomplete = allCampaigns.filter((c: any) => String(c.state || '').toUpperCase() === 'INCOMPLETE');

    if (body.diagnose_only) {
      return Response.json({
        ok: true,
        total_campaigns: allCampaigns.length,
        incomplete_count: incomplete.length,
        incomplete: incomplete.map((c: any) => ({ campaignId: c.campaignId, name: c.name, state: c.state, targetingType: c.targetingType })),
      });
    }

    // 2. Reparar cada campanha incompleta
    const results: any[] = [];

    for (const campaign of incomplete) {
      const campaignId = String(campaign.campaignId);
      const item: any = { campaignId, name: campaign.name, repaired: [], errors: [] };

      try {
        // Buscar produto pelo nome (extrai ASIN do nome da campanha)
        const asinMatch = campaign.name?.match(/\b(B0[A-Z0-9]{8}|B[0-9]{2}[A-Z0-9]{7})\b/i);
        const asin = asinMatch ? asinMatch[1].toUpperCase() : null;
        item.asin = asin;

        // Verificar/criar AdGroup
        const agResp = await adsCall(token, 'POST', '/sp/adGroups/list', {
          campaignIdFilter: [campaignId],
          stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
          maxResults: 50,
        }, 'application/vnd.spAdGroup.v3+json');

        let adGroups = listOf(agResp.data, 'adGroups');
        let adGroup = adGroups.find((g: any) => String(g.state || '').toUpperCase() !== 'ARCHIVED') || null;

        if (!adGroup) {
          const createAg = await adsCall(token, 'POST', '/sp/adGroups', {
            adGroups: [{ name: `AG | ${campaign.targetingType || 'AUTO'} | ${asin || campaignId.slice(-6)}`, campaignId, defaultBid: 0.5, state: 'ENABLED' }],
          }, 'application/vnd.spAdGroup.v3+json');
          const adGroupId = idFrom(createAg.data, 'adGroups', 'adGroupId');
          if (!adGroupId) throw new Error(`Falha ao criar AdGroup: ${JSON.stringify(createAg.data).slice(0, 200)}`);
          adGroup = { adGroupId: String(adGroupId), state: 'ENABLED' };
          item.repaired.push('ad_group_created');
          await wait(8000);
        }

        const adGroupId = String(adGroup.adGroupId);

        // Verificar/criar ProductAd
        const paResp = await adsCall(token, 'POST', '/sp/productAds/list', {
          campaignIdFilter: [campaignId],
          adGroupIdFilter: [adGroupId],
          stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
          maxResults: 50,
        }, 'application/vnd.spProductAd.v3+json');

        const productAds = listOf(paResp.data, 'productAds');
        const existingAd = productAds.find((ad: any) => String(ad.state || '').toUpperCase() !== 'ARCHIVED');

        if (!existingAd && asin) {
          const createPa = await adsCall(token, 'POST', '/sp/productAds', {
            productAds: [{ campaignId, adGroupId, asin, state: 'ENABLED' }],
          }, 'application/vnd.spProductAd.v3+json');
          const adId = idFrom(createPa.data, 'productAds', 'adId') || idFrom(createPa.data, 'productAds', 'productAdId');
          if (!adId) throw new Error(`Falha ao criar ProductAd: ${JSON.stringify(createPa.data).slice(0, 200)}`);
          item.repaired.push('product_ad_created');
          item.product_ad_id = String(adId);
          await wait(8000);
        } else if (existingAd) {
          item.repaired.push('product_ad_exists');
        }

        // Para campanhas MANUAL — verificar keywords
        if (String(campaign.targetingType || '').toUpperCase() === 'MANUAL') {
          const kwResp = await adsCall(token, 'POST', '/sp/keywords/list', {
            campaignIdFilter: [campaignId],
            stateFilter: { include: ['ENABLED', 'PAUSED'] },
            maxResults: 100,
          }, 'application/vnd.spKeyword.v3+json');
          const kws = listOf(kwResp.data, 'keywords');
          item.keyword_count = kws.length;
          if (kws.length === 0) item.errors.push('MANUAL sem keywords — adicione keywords manualmente ou via Kick-off');
        }

        // Activar a campanha na Amazon
        const enableResp = await adsCall(token, 'PUT', '/sp/campaigns', {
          campaigns: [{ campaignId, state: 'ENABLED' }],
        });
        if (enableResp.ok || enableResp.status === 207) {
          item.repaired.push('campaign_enabled');
        } else {
          item.errors.push(`Falha ao activar: ${JSON.stringify(enableResp.data).slice(0, 200)}`);
        }
        await wait(8000);

        // Actualizar estado local
        const localRows = await base44.asServiceRole.entities.Campaign.filter({
          amazon_account_id: accountId, campaign_id: campaignId,
        }, '-updated_at', 1).catch(() => []);
        if (localRows[0]) {
          await base44.asServiceRole.entities.Campaign.update(localRows[0].id, {
            state: 'enabled', status: 'enabled', is_operational: true,
            is_incomplete: false, repair_status: 'repaired', repaired_at: new Date().toISOString(),
          }).catch(() => {});
        }

        item.ok = true;
      } catch (e: any) {
        item.ok = false;
        item.errors.push(e.message || String(e));
      }

      results.push(item);
    }

    return Response.json({
      ok: results.every(r => r.ok),
      total_incomplete: incomplete.length,
      repaired: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length,
      results,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro no reparo directo' }, { status: 500 });
  }
});