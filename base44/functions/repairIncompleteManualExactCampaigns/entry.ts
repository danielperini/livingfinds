/**
 * repairIncompleteManualExactCampaigns
 * 
 * Para campanhas SP | MANUAL | EXACT que estão Incompletas na Amazon:
 * 1. Busca ad groups de cada campanha
 * 2. Verifica se há product ads (ausência = motivo da "Incompleta")
 * 3. Cria product ads para o ASIN correto (extraído do nome da campanha)
 * 4. Garante keyword EXACT com bid R$0,50
 * 5. Ativa campanha + ad group
 * 
 * Payload: { amazon_account_id, dry_run?: boolean, campaign_ids?: string[] }
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

function extractAsinFromName(name: string): string | null {
  const match = name.match(/\|\s*(B0[A-Z0-9]{8})\s*\|/i);
  return match ? match[1] : null;
}

function extractKeywordFromName(name: string): string | null {
  // "SP | MANUAL | EXACT | ASIN | keyword text here truncated"
  const parts = name.split('|');
  if (parts.length >= 5) {
    return parts.slice(4).join('|').trim();
  }
  return null;
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

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false, campaign_ids } = body;

    const baseUrl = 'https://advertising-api.amazon.com';
    const clientId = Deno.env.get('ADS_CLIENT_ID');
    const profileId = Deno.env.get('ADS_PROFILE_ID');
    const token = await getToken(base44);

    const makeHeaders = (contentType: string) => ({
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': contentType,
      'Accept': contentType,
    });

    // 1. Buscar todas campanhas ENABLED + PAUSED da Amazon
    let allCampaigns: any[] = [];
    let nextToken: string | null = null;
    do {
      const reqBody: any = { stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 100 };
      if (nextToken) reqBody.nextToken = nextToken;
      const r = await apiPost(`${baseUrl}/sp/campaigns/list`, makeHeaders('application/vnd.spCampaign.v3+json'), reqBody);
      allCampaigns = allCampaigns.concat(r.data?.campaigns || []);
      nextToken = r.data?.nextToken || null;
    } while (nextToken);

    // 2. Filtrar campanhas MANUAL EXACT
    let targetCampaigns = allCampaigns.filter((c: any) => {
      const name = c.name || '';
      return name.includes('MANUAL') && name.includes('EXACT');
    });

    if (campaign_ids && campaign_ids.length > 0) {
      targetCampaigns = targetCampaigns.filter((c: any) => campaign_ids.includes(String(c.campaignId)));
    }

    if (targetCampaigns.length === 0) {
      return Response.json({ ok: true, message: 'Nenhuma campanha MANUAL EXACT encontrada', total: 0 });
    }

    // 3. Para cada campanha, buscar ad groups
    const campaignIds = targetCampaigns.map((c: any) => c.campaignId);
    let allAdGroups: any[] = [];
    for (let i = 0; i < campaignIds.length; i += 50) {
      const chunk = campaignIds.slice(i, i + 50);
      const r = await apiPost(`${baseUrl}/sp/adGroups/list`, makeHeaders('application/vnd.spAdGroup.v3+json'), {
        campaignIdFilter: { include: chunk },
        stateFilter: { include: ['ENABLED', 'PAUSED'] },
        maxResults: 100,
      });
      allAdGroups = allAdGroups.concat(r.data?.adGroups || []);
      if (i + 50 < campaignIds.length) await delay(300);
    }

    const adGroupsByCampaign: Record<string, any[]> = {};
    allAdGroups.forEach((ag: any) => {
      const cid = String(ag.campaignId);
      if (!adGroupsByCampaign[cid]) adGroupsByCampaign[cid] = [];
      adGroupsByCampaign[cid].push(ag);
    });

    // 4. Para cada ad group, buscar product ads existentes
    const adGroupIds = allAdGroups.map((ag: any) => ag.adGroupId);
    let allProductAds: any[] = [];
    if (adGroupIds.length > 0) {
      for (let i = 0; i < adGroupIds.length; i += 50) {
        const chunk = adGroupIds.slice(i, i + 50);
        const r = await apiPost(`${baseUrl}/sp/productAds/list`, makeHeaders('application/vnd.spProductAd.v3+json'), {
          adGroupIdFilter: { include: chunk },
          stateFilter: { include: ['ENABLED', 'PAUSED'] },
          maxResults: 100,
        });
        allProductAds = allProductAds.concat(r.data?.productAds || []);
        if (i + 50 < adGroupIds.length) await delay(300);
      }
    }

    const productAdsByAdGroup: Record<string, any[]> = {};
    allProductAds.forEach((pa: any) => {
      const agid = String(pa.adGroupId);
      if (!productAdsByAdGroup[agid]) productAdsByAdGroup[agid] = [];
      productAdsByAdGroup[agid].push(pa);
    });

    // 5. Para cada ad group, buscar keywords
    let allKeywords: any[] = [];
    if (adGroupIds.length > 0) {
      for (let i = 0; i < adGroupIds.length; i += 50) {
        const chunk = adGroupIds.slice(i, i + 50);
        const r = await apiPost(`${baseUrl}/sp/keywords/list`, makeHeaders('application/vnd.spKeyword.v3+json'), {
          adGroupIdFilter: { include: chunk },
          stateFilter: { include: ['ENABLED', 'PAUSED'] },
          maxResults: 100,
        });
        allKeywords = allKeywords.concat(r.data?.keywords || []);
        if (i + 50 < adGroupIds.length) await delay(300);
      }
    }

    const keywordsByAdGroup: Record<string, any[]> = {};
    allKeywords.forEach((kw: any) => {
      const agid = String(kw.adGroupId);
      if (!keywordsByAdGroup[agid]) keywordsByAdGroup[agid] = [];
      keywordsByAdGroup[agid].push(kw);
    });

    // 6. Identificar o que falta criar
    const repairs: any[] = [];
    for (const campaign of targetCampaigns) {
      const cid = String(campaign.campaignId);
      const asin = extractAsinFromName(campaign.name || '');
      const keywordText = extractKeywordFromName(campaign.name || '');
      
      if (!asin) continue; // Sem ASIN no nome, pular

      const adGroups = adGroupsByCampaign[cid] || [];
      
      for (const adGroup of adGroups) {
        const agid = String(adGroup.adGroupId);
        const existingAds = productAdsByAdGroup[agid] || [];
        const existingKws = keywordsByAdGroup[agid] || [];

        const needsProductAd = existingAds.length === 0;
        const needsKeyword = existingKws.length === 0 && !!keywordText;
        const needsBidFix = existingKws.some((kw: any) => (kw.bid || 0) < 0.50);
        const needsActivation = campaign.state === 'PAUSED' || adGroup.state === 'PAUSED';

        repairs.push({
          campaign_id: cid,
          campaign_name: campaign.name,
          ad_group_id: agid,
          ad_group_name: adGroup.name,
          asin,
          keyword_text: keywordText,
          campaign_state: campaign.state,
          ad_group_state: adGroup.state,
          existing_ads: existingAds.length,
          existing_kws: existingKws.length,
          needs_product_ad: needsProductAd,
          needs_keyword: needsKeyword,
          needs_bid_fix: needsBidFix,
          needs_activation: needsActivation,
        });
      }

      // Sem ad group — precisamos criar
      if (adGroups.length === 0) {
        repairs.push({
          campaign_id: cid,
          campaign_name: campaign.name,
          ad_group_id: null,
          asin,
          keyword_text: keywordText,
          campaign_state: campaign.state,
          needs_ad_group: true,
          needs_product_ad: true,
          needs_keyword: !!keywordText,
          needs_activation: true,
        });
      }
    }

    const needsWork = repairs.filter(r => r.needs_product_ad || r.needs_keyword || r.needs_bid_fix || r.needs_activation || r.needs_ad_group);

    if (dry_run) {
      return Response.json({
        ok: true,
        dry_run: true,
        total_campaigns: targetCampaigns.length,
        total_ad_groups: allAdGroups.length,
        repairs_needed: needsWork.length,
        breakdown: {
          needs_product_ad: repairs.filter(r => r.needs_product_ad).length,
          needs_keyword: repairs.filter(r => r.needs_keyword).length,
          needs_bid_fix: repairs.filter(r => r.needs_bid_fix).length,
          needs_activation: repairs.filter(r => r.needs_activation).length,
          needs_ad_group: repairs.filter(r => r.needs_ad_group).length,
        },
        sample: needsWork.slice(0, 10),
      });
    }

    // 7. EXECUTAR REPAROS
    const results: any[] = [];
    const MIN_BID = 0.50;
    const BATCH = 20;

    // 7a. Criar ad groups faltando
    const needAdGroups = needsWork.filter(r => r.needs_ad_group);
    if (needAdGroups.length > 0) {
      for (let i = 0; i < needAdGroups.length; i += BATCH) {
        const batch = needAdGroups.slice(i, i + BATCH);
        const payload = {
          adGroups: batch.map(r => ({
            campaignId: r.campaign_id,
            name: `AdGroup | ${r.asin}`,
            state: 'ENABLED',
            defaultBid: MIN_BID,
          })),
        };
        const res = await apiPost(`${baseUrl}/sp/adGroups`, makeHeaders('application/vnd.spAdGroup.v3+json'), payload);
        const created = res.data?.adGroups?.success || [];
        created.forEach((ag: any, idx: number) => {
          batch[idx].ad_group_id = String(ag.adGroupId);
          results.push({ type: 'ad_group_created', campaign_id: batch[idx].campaign_id, ad_group_id: batch[idx].ad_group_id });
        });
        if (i + BATCH < needAdGroups.length) await delay(400);
      }
    }

    // 7b. Criar product ads faltando
    const needProductAds = needsWork.filter(r => r.needs_product_ad && r.ad_group_id);
    if (needProductAds.length > 0) {
      for (let i = 0; i < needProductAds.length; i += BATCH) {
        const batch = needProductAds.slice(i, i + BATCH);
        const payload = {
          productAds: batch.map(r => ({
            campaignId: r.campaign_id,
            adGroupId: r.ad_group_id,
            asin: r.asin,
            state: 'ENABLED',
          })),
        };
        const res = await apiPost(`${baseUrl}/sp/productAds`, makeHeaders('application/vnd.spProductAd.v3+json'), payload);
        const success = (res.data?.productAds?.success || []).length;
        const errors = res.data?.productAds?.error || [];
        results.push({ type: 'product_ads_created', count: success, errors: errors.length, errors_sample: errors.slice(0, 3) });
        if (i + BATCH < needProductAds.length) await delay(400);
      }
    }

    // 7c. Criar keywords faltando
    const needKeywords = needsWork.filter(r => r.needs_keyword && r.ad_group_id && r.keyword_text);
    if (needKeywords.length > 0) {
      for (let i = 0; i < needKeywords.length; i += BATCH) {
        const batch = needKeywords.slice(i, i + BATCH);
        const payload = {
          keywords: batch.map(r => ({
            campaignId: r.campaign_id,
            adGroupId: r.ad_group_id,
            keywordText: r.keyword_text,
            matchType: 'EXACT',
            state: 'ENABLED',
            bid: MIN_BID,
          })),
        };
        const res = await apiPost(`${baseUrl}/sp/keywords`, makeHeaders('application/vnd.spKeyword.v3+json'), payload);
        const success = (res.data?.keywords?.success || []).length;
        const errors = res.data?.keywords?.error || [];
        results.push({ type: 'keywords_created', count: success, errors: errors.length, errors_sample: errors.slice(0, 3) });
        if (i + BATCH < needKeywords.length) await delay(400);
      }
    }

    // 7d. Corrigir bids abaixo de R$0,50
    const needBidFix = needsWork.filter(r => r.needs_bid_fix && r.ad_group_id);
    if (needBidFix.length > 0) {
      // Buscar keywords dos ad groups com bid baixo
      const agIds = [...new Set(needBidFix.map(r => r.ad_group_id))];
      let kwsToFix: any[] = [];
      for (const agid of agIds) {
        const kws = (keywordsByAdGroup[agid] || []).filter((kw: any) => (kw.bid || 0) < MIN_BID);
        kwsToFix = kwsToFix.concat(kws);
      }
      if (kwsToFix.length > 0) {
        const payload = { keywords: kwsToFix.map((kw: any) => ({ keywordId: kw.keywordId, bid: MIN_BID })) };
        const res = await apiPut(`${baseUrl}/sp/keywords`, makeHeaders('application/vnd.spKeyword.v3+json'), payload);
        const success = (res.data?.keywords?.success || []).length;
        results.push({ type: 'bids_fixed', count: success });
      }
    }

    // 7e. Ativar campanhas pausadas
    const campaignsToActivate = [...new Set(needsWork.filter(r => r.needs_activation && r.campaign_state === 'PAUSED').map(r => r.campaign_id))];
    if (campaignsToActivate.length > 0) {
      for (let i = 0; i < campaignsToActivate.length; i += BATCH) {
        const batch = campaignsToActivate.slice(i, i + BATCH);
        const payload = { campaigns: batch.map(id => ({ campaignId: id, state: 'ENABLED' })) };
        const res = await apiPut(`${baseUrl}/sp/campaigns`, makeHeaders('application/vnd.spCampaign.v3+json'), payload);
        const success = (res.data?.campaigns?.success || []).length;
        results.push({ type: 'campaigns_activated', count: success });
        if (i + BATCH < campaignsToActivate.length) await delay(400);
      }
    }

    // 7f. Ativar ad groups pausados
    const adGroupsToActivate = [...new Set(needsWork.filter(r => r.needs_activation && r.ad_group_state === 'PAUSED' && r.ad_group_id).map(r => r.ad_group_id))];
    if (adGroupsToActivate.length > 0) {
      const payload = { adGroups: adGroupsToActivate.map(id => ({ adGroupId: id, state: 'ENABLED' })) };
      const res = await apiPut(`${baseUrl}/sp/adGroups`, makeHeaders('application/vnd.spAdGroup.v3+json'), payload);
      const success = (res.data?.adGroups?.success || []).length;
      results.push({ type: 'ad_groups_activated', count: success });
    }

    // 7g. Atualizar banco local: marcar campanhas como enabled
    if (amazon_account_id) {
      const repairedCampaignIds = [...new Set(needsWork.map(r => r.campaign_id))];
      const localCamps = await base44.asServiceRole.entities.Campaign.filter({
        amazon_account_id,
        campaign_id: { $in: repairedCampaignIds },
      }, null, 200);
      await Promise.all(
        localCamps.map((c: any) =>
          base44.asServiceRole.entities.Campaign.update(c.id, { state: 'enabled', status: 'enabled' }).catch(() => {})
        )
      );
    }

    return Response.json({
      ok: true,
      total_campaigns_scanned: targetCampaigns.length,
      repairs_needed: needsWork.length,
      repairs_executed: results,
      summary: {
        product_ads_created: results.filter(r => r.type === 'product_ads_created').reduce((s, r) => s + (r.count || 0), 0),
        keywords_created: results.filter(r => r.type === 'keywords_created').reduce((s, r) => s + (r.count || 0), 0),
        bids_fixed: results.filter(r => r.type === 'bids_fixed').reduce((s, r) => s + (r.count || 0), 0),
        campaigns_activated: results.filter(r => r.type === 'campaigns_activated').reduce((s, r) => s + (r.count || 0), 0),
        ad_groups_created: results.filter(r => r.type === 'ad_group_created').length,
      },
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err?.message || 'Erro inesperado' }, { status: 500 });
  }
});