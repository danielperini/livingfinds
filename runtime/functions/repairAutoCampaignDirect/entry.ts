// Função pública para diagnóstico e reparo direto de campanha AUTO por ASIN
// Pode ser chamada pelo frontend ou por test_backend_function sem _service_role
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  return { ok, status: response.status, payload: parsed, errors: ok ? [] : [{ code: String(response.status), message: text.slice(0, 400) }] };
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

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    const asin = String(body.asin || '').trim().toUpperCase();
    const sku = String(body.sku || '').trim();
    const dryRun = body.dry_run === true;

    if (!asin && !sku) return Response.json({ ok: false, error: 'asin ou sku é obrigatório' }, { status: 400 });

    // Buscar conta Amazon
    const me = user;
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: me.id }, null, 1);
    const account = accounts[0] || (await base44.asServiceRole.entities.AmazonAccount.filter({}, null, 1))[0];
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });

    const accountId = account.id;

    // Buscar todas campanhas AUTO do ASIN no banco local
    const localCampaigns = await base44.asServiceRole.entities.Campaign.filter({
      amazon_account_id: accountId,
      ...(asin ? { asin } : {}),
      targeting_type: 'AUTO',
    }, '-created_date', 10);

    const autoCampaigns = localCampaigns.filter((c: any) =>
      !c.archived && c.status !== 'archived' && c.amazon_status !== 'ARCHIVED'
    );

    if (autoCampaigns.length === 0) {
      return Response.json({ ok: false, error: `Nenhuma campanha AUTO encontrada localmente para ASIN ${asin}` }, { status: 404 });
    }

    // Usar a campanha mais recente (criada pelo app)
    const target = autoCampaigns.find((c: any) => c.created_by_app) || autoCampaigns[0];
    const campaignId = String(target.campaign_id || target.amazon_campaign_id || '').trim();

    if (!campaignId) return Response.json({ ok: false, error: 'campaign_id inválido na campanha local' }, { status: 400 });

    const token = await getAccessToken(account);
    const profileId = String(account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '');
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const base = adsBase(account.region);
    const CT_C = 'application/vnd.spCampaign.v3+json';
    const CT_AG = 'application/vnd.spAdGroup.v3+json';
    const CT_PA = 'application/vnd.spProductAd.v3+json';

    const diagnosis: Record<string, any> = {
      asin,
      sku: sku || null,
      campaign_id: campaignId,
      campaign_name: target.name || target.campaign_name,
      dry_run: dryRun,
    };

    // 1. Verificar campanha na Amazon
    const campRes = await adsCall(base, token, clientId, profileId, 'POST', '/sp/campaigns/list', CT_C, {
      campaignIdFilter: { include: [campaignId] },
      stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
      maxResults: 10,
    });

    if (!campRes.ok) {
      return Response.json({ ok: false, error: `Erro na API Amazon ao listar campanha: ${campRes.errors?.[0]?.message}`, diagnosis }, { status: 500 });
    }

    const amazonCampaign = listOf(campRes, 'campaigns').find((c: any) => String(c.campaignId) === campaignId);
    diagnosis.amazon_campaign_found = !!amazonCampaign;
    diagnosis.amazon_campaign_state = amazonCampaign?.state || 'NOT_FOUND';

    if (!amazonCampaign) {
      return Response.json({ ok: false, error: `Campanha ${campaignId} não existe na Amazon. É necessário recriar.`, diagnosis });
    }

    const repaired: string[] = [];
    const verified: string[] = [];

    // 2. Ativar campanha se pausada
    if (String(amazonCampaign.state || '').toUpperCase() !== 'ENABLED') {
      if (!dryRun) {
        const r = await adsCall(base, token, clientId, profileId, 'PUT', '/sp/campaigns', CT_C, {
          campaigns: [{ campaignId, state: 'ENABLED' }],
        });
        if (!r?.ok && r?.status !== 207) {
          return Response.json({ ok: false, error: `Falha ao ativar campanha: ${r?.errors?.[0]?.message}`, diagnosis });
        }
        await wait(10000);
      }
      repaired.push('campaign_activated');
    } else {
      verified.push('campaign_enabled');
    }

    // 3. Verificar/criar ad group
    const agRes = await adsCall(base, token, clientId, profileId, 'POST', '/sp/adGroups/list', CT_AG, {
      campaignIdFilter: { include: [campaignId] },
      stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
      maxResults: 100,
    });

    const adGroups = listOf(agRes, 'adGroups');
    let adGroup = adGroups.find((g: any) => String(g.state || '').toUpperCase() === 'ENABLED')
      || adGroups.find((g: any) => String(g.state || '').toUpperCase() !== 'ARCHIVED');

    diagnosis.ad_groups_found = adGroups.length;
    diagnosis.ad_group_state = adGroup?.state || 'MISSING';

    if (!adGroup) {
      if (!dryRun) {
        const r = await adsCall(base, token, clientId, profileId, 'POST', '/sp/adGroups', CT_AG, {
          adGroups: [{ name: `AG | AUTO | ${asin || sku}`, campaignId, defaultBid: 0.5, state: 'ENABLED' }],
        });
        const id = createdId(r, 'adGroups', 'adGroupId');
        if (!id) return Response.json({ ok: false, error: `Falha ao criar ad group: ${r?.errors?.[0]?.message}`, diagnosis });
        adGroup = { adGroupId: String(id), state: 'ENABLED' };
        await wait(10000);
      } else {
        adGroup = { adGroupId: 'DRY_RUN', state: 'WOULD_CREATE' };
      }
      repaired.push('ad_group_created');
    } else if (String(adGroup.state || '').toUpperCase() !== 'ENABLED') {
      if (!dryRun) {
        const r = await adsCall(base, token, clientId, profileId, 'PUT', '/sp/adGroups', CT_AG, {
          adGroups: [{ adGroupId: String(adGroup.adGroupId), state: 'ENABLED' }],
        });
        if (!r?.ok && r?.status !== 207) return Response.json({ ok: false, error: `Falha ao ativar ad group: ${r?.errors?.[0]?.message}`, diagnosis });
        await wait(10000);
      }
      repaired.push('ad_group_activated');
    } else {
      verified.push('ad_group_enabled');
    }

    const adGroupId = String(adGroup.adGroupId);
    diagnosis.ad_group_id = adGroupId;

    // 4. Verificar/criar product ad
    const paRes = await adsCall(base, token, clientId, profileId, 'POST', '/sp/productAds/list', CT_PA, {
      campaignIdFilter: { include: [campaignId] },
      adGroupIdFilter: adGroupId !== 'DRY_RUN' ? { include: [adGroupId] } : undefined,
      stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
      maxResults: 100,
    });

    const productAds = listOf(paRes, 'productAds');
    let productAd = productAds.find((ad: any) =>
      String(ad.state || '').toUpperCase() === 'ENABLED' &&
      ((asin && String(ad.asin || '').toUpperCase() === asin) || (sku && String(ad.sku || '').toLowerCase() === sku.toLowerCase()))
    ) || productAds.find((ad: any) => String(ad.state || '').toUpperCase() !== 'ARCHIVED');

    diagnosis.product_ads_found = productAds.length;
    diagnosis.product_ad_state = productAd?.state || 'MISSING';

    if (!productAd) {
      if (!dryRun && adGroupId !== 'DRY_RUN') {
        const r = await adsCall(base, token, clientId, profileId, 'POST', '/sp/productAds', CT_PA, {
          productAds: [{ campaignId, adGroupId, ...(sku ? { sku } : { asin }), state: 'ENABLED' }],
        });
        const id = createdId(r, 'productAds', 'adId') || createdId(r, 'productAds', 'productAdId');
        if (!id && !r?.ok && r?.status !== 207) {
          return Response.json({ ok: false, error: `Falha ao criar product ad: ${r?.errors?.[0]?.message}`, diagnosis });
        }
        productAd = { adId: id || null, state: 'ENABLED' };
        await wait(10000);
      }
      repaired.push('product_ad_created');
    } else if (String(productAd.state || '').toUpperCase() !== 'ENABLED') {
      if (!dryRun) {
        const r = await adsCall(base, token, clientId, profileId, 'PUT', '/sp/productAds', CT_PA, {
          productAds: [{ adId: String(productAd.adId || productAd.productAdId), state: 'ENABLED' }],
        });
        if (!r?.ok && r?.status !== 207) return Response.json({ ok: false, error: `Falha ao ativar product ad: ${r?.errors?.[0]?.message}`, diagnosis });
        await wait(10000);
      }
      repaired.push('product_ad_activated');
    } else {
      verified.push('product_ad_enabled');
    }

    diagnosis.product_ad_id = String(productAd?.adId || productAd?.productAdId || '') || null;

    // 5. Atualizar AutoCampaignLearning com ad_group_id se estiver vazio
    if (!dryRun && adGroupId && adGroupId !== 'DRY_RUN') {
      const learnings = await base44.asServiceRole.entities.AutoCampaignLearning.filter({
        amazon_account_id: accountId,
        campaign_id: campaignId,
      }, null, 1);
      if (learnings.length > 0 && !learnings[0].ad_group_id) {
        await base44.asServiceRole.entities.AutoCampaignLearning.update(learnings[0].id, {
          ad_group_id: adGroupId,
          confirmed_at: new Date().toISOString(),
        });
        repaired.push('learning_ad_group_updated');
      }
    }

    // 6. Atualizar produto local se necessário
    if (!dryRun && repaired.length > 0) {
      const products = await base44.asServiceRole.entities.Product.filter({
        amazon_account_id: accountId,
        asin,
      }, null, 1);
      if (products.length > 0) {
        await base44.asServiceRole.entities.Product.update(products[0].id, {
          has_campaign: true,
          campaign_status: 'active',
          linked_campaign_id: campaignId,
          linked_campaign_name: target.name || target.campaign_name || null,
          auto_campaign_eligible: true,
          auto_campaign_created_at: target.created_date || new Date().toISOString(),
        });
        repaired.push('product_record_updated');
      }
    }

    const isComplete = verified.includes('campaign_enabled') || repaired.includes('campaign_activated');
    const campaignReady = isComplete &&
      (verified.includes('ad_group_enabled') || repaired.includes('ad_group_created') || repaired.includes('ad_group_activated')) &&
      (verified.includes('product_ad_enabled') || repaired.includes('product_ad_created') || repaired.includes('product_ad_activated'));

    return Response.json({
      ok: true,
      campaign_ready: campaignReady,
      dry_run: dryRun,
      repaired,
      verified,
      diagnosis,
      summary: dryRun
        ? `[DRY RUN] Campanha ${campaignId} — ${repaired.length} ações necessárias, ${verified.length} já OK`
        : campaignReady
          ? `✓ Campanha AUTO ${campaignId} operacional — ${repaired.length ? `${repaired.length} item(ns) reparado(s): ${repaired.join(', ')}` : 'tudo já estava OK'}`
          : `Parcialmente reparado. Repaired: ${repaired.join(', ')}`,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro no reparo direto' }, { status: 500 });
  }
});