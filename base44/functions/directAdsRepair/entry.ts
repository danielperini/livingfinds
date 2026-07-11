import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms:number) => new Promise(r => setTimeout(r, ms));
const norm = (v:any) => String(v || '').toLowerCase().trim().replace(/\s+/g, ' ');

async function ads(base44:any, accountId:string, operation:string, method:string, path:string, payload:any, contentType='application/vnd.spCampaign.v3+json') {
  const r = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
    amazon_account_id: accountId, operation, method, path, payload,
    content_type: contentType, accept: contentType, _service_role: true,
  });
  return r?.data || r || {};
}

function listOf(data:any, key:string) {
  const p = data?.payload || data || {};
  if (Array.isArray(p?.[key])) return p[key];
  if (Array.isArray(p)) return p;
  return [];
}

function idFrom(data:any, group:string, field:string) {
  const p = data?.payload || data || {};
  return p?.[group]?.success?.[0]?.[field] || p?.success?.[0]?.[field] || p?.[group]?.[0]?.[field] || null;
}

function extractAsin(c:any) {
  const text = `${c?.name || ''} ${c?.campaignName || ''}`;
  const m = text.match(/\b(B0[A-Z0-9]{8}|B[0-9]{2}[A-Z0-9]{7})\b/i);
  return m ? m[1].toUpperCase() : null;
}

function hasStock(p:any) {
  if (!p) return false;
  if (String(p.inventory_status || '').toLowerCase() === 'out_of_stock') return false;
  const values = [p.fba_inventory, p.available_quantity, p.fulfillable_quantity, p.stock, p.quantity]
    .map(Number).filter(Number.isFinite);
  return values.some(v => v > 0);
}

async function setLocal(base44:any, accountId:string, campaignId:string, patch:any) {
  const rows = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId, campaign_id: campaignId }, '-updated_at', 5).catch(() => []);
  for (const row of rows) await base44.asServiceRole.entities.Campaign.update(row.id, patch).catch(() => {});
}

async function archiveCampaign(base44:any, accountId:string, campaignId:string, reason:string) {
  const r = await ads(base44, accountId, 'archiveIncompleteCampaign', 'PUT', '/sp/campaigns', {
    campaigns: [{ campaignId, state: 'ARCHIVED' }],
  });
  await setLocal(base44, accountId, campaignId, {
    state: 'archived', status: 'archived', archived: true, is_operational: false,
    is_incomplete: false, completion_status: 'archived', repair_status: 'archived',
    last_repair_error: reason, archived_at: new Date().toISOString(),
  });
  return r;
}

async function chooseTerm(base44:any, accountId:string, asin:string, used:Set<string>) {
  const bank = await base44.asServiceRole.entities.TermBank.filter({ amazon_account_id: accountId, asin }, '-performance_score', 200).catch(() => []);
  const rankedBank = bank
    .filter((t:any) => !['negative','archived','blocked'].includes(String(t.status || '').toLowerCase()))
    .filter((t:any) => String(t.term || '').trim())
    .sort((a:any,b:any) => (Number(b.orders || 0) - Number(a.orders || 0)) || (Number(b.performance_score || b.score || 0) - Number(a.performance_score || a.score || 0)));
  for (const t of rankedBank) {
    const keyword = String(t.term).trim();
    if (!used.has(norm(keyword))) return { keyword, source: 'term_bank', row: t };
  }

  const suggestions = await base44.asServiceRole.entities.KeywordSuggestion.filter({ amazon_account_id: accountId, asin }, '-confidence', 500).catch(() => []);
  const rankedSuggestions = suggestions
    .filter((s:any) => !['applied','archived','rejected'].includes(String(s.status || '').toLowerCase()))
    .filter((s:any) => String(s.keyword || '').trim())
    .sort((a:any,b:any) => Number(b.confidence || b.score || 0) - Number(a.confidence || a.score || 0));
  for (const s of rankedSuggestions) {
    const keyword = String(s.keyword).trim();
    if (!used.has(norm(keyword))) return { keyword, source: 'amazon_ads_suggestion', row: s };
  }
  return null;
}

Deno.serve(async (request) => {
  const base44 = createClientFromRequest(request);
  try {
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    const body = await request.json().catch(() => ({}));
    if (!authenticated && !body._service_role) return Response.json({ ok:false, error:'Não autorizado' }, { status:401 });
    const accountId = body.amazon_account_id;
    if (!accountId) return Response.json({ ok:false, error:'amazon_account_id obrigatório' }, { status:400 });

    const remoteResp = await ads(base44, accountId, 'listCampaignsForDefinitiveRepair', 'POST', '/sp/campaigns/list', {
      stateFilter: { include: ['INCOMPLETE','ENABLED','PAUSED'] }, maxResults: 500,
    });
    if (!remoteResp?.ok) return Response.json({ ok:false, stage:'list_campaigns', error:remoteResp?.errors?.[0]?.message || remoteResp?.error || 'Falha ao listar campanhas' });

    const remote = listOf(remoteResp, 'campaigns');
    const targets = remote.filter((c:any) => String(c.state || '').toUpperCase() === 'INCOMPLETE');
    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []);
    const productByAsin = new Map(products.map((p:any) => [String(p.asin || '').toUpperCase(), p]));
    const results:any[] = [];

    for (const campaign of targets) {
      const campaignId = String(campaign.campaignId);
      const asin = extractAsin(campaign);
      const product = asin ? productByAsin.get(asin) : null;
      const item:any = { campaign_id: campaignId, campaign_name: campaign.name, asin, action:null, repaired:[], errors:[] };

      if (!asin || !product) {
        await archiveCampaign(base44, accountId, campaignId, 'Campanha incompleta sem produto/ASIN correspondente no app');
        item.action = 'archived'; item.reason = 'product_not_found'; results.push(item); continue;
      }
      if (!hasStock(product)) {
        await archiveCampaign(base44, accountId, campaignId, 'Campanha incompleta arquivada por ausência de estoque');
        item.action = 'archived'; item.reason = 'out_of_stock'; results.push(item); continue;
      }

      try {
        const groupsResp = await ads(base44, accountId, 'listAdGroupsForDefinitiveRepair', 'POST', '/sp/adGroups/list', {
          campaignIdFilter:[campaignId], stateFilter:{ include:['ENABLED','PAUSED','ARCHIVED'] }, maxResults:100,
        }, 'application/vnd.spAdGroup.v3+json');
        let group = listOf(groupsResp, 'adGroups').find((g:any) => String(g.state || '').toUpperCase() !== 'ARCHIVED');
        if (!group) {
          const created = await ads(base44, accountId, 'createAdGroupForDefinitiveRepair', 'POST', '/sp/adGroups', {
            adGroups:[{ name:`AG | ${String(campaign.targetingType || 'MANUAL').toUpperCase()} | ${asin}`, campaignId, defaultBid:0.5, state:'ENABLED' }],
          }, 'application/vnd.spAdGroup.v3+json');
          const adGroupId = idFrom(created, 'adGroups', 'adGroupId');
          if (!adGroupId) throw new Error(created?.errors?.[0]?.message || 'Amazon não retornou adGroupId');
          group = { adGroupId:String(adGroupId), state:'ENABLED' }; item.repaired.push('ad_group_created'); await wait(14000);
        }
        const adGroupId = String(group.adGroupId);

        const adsResp = await ads(base44, accountId, 'listProductAdsForDefinitiveRepair', 'POST', '/sp/productAds/list', {
          campaignIdFilter:[campaignId], adGroupIdFilter:[adGroupId], stateFilter:{ include:['ENABLED','PAUSED','ARCHIVED'] }, maxResults:100,
        }, 'application/vnd.spProductAd.v3+json');
        let productAd = listOf(adsResp, 'productAds').find((a:any) => String(a.state || '').toUpperCase() !== 'ARCHIVED');
        if (!productAd) {
          const created = await ads(base44, accountId, 'createProductAdForDefinitiveRepair', 'POST', '/sp/productAds', {
            productAds:[{ campaignId, adGroupId, ...(product.sku ? { sku:product.sku } : { asin }), state:'ENABLED' }],
          }, 'application/vnd.spProductAd.v3+json');
          const adId = idFrom(created, 'productAds', 'adId') || idFrom(created, 'productAds', 'productAdId');
          if (!adId && !created?.ok) throw new Error(created?.errors?.[0]?.message || 'Falha ao criar anúncio do produto');
          item.repaired.push('product_ad_created'); await wait(14000);
        }

        let keywordCount = 0;
        if (String(campaign.targetingType || '').toUpperCase() === 'MANUAL') {
          const kwResp = await ads(base44, accountId, 'listKeywordsForDefinitiveRepair', 'POST', '/sp/keywords/list', {
            campaignIdFilter:[campaignId], adGroupIdFilter:[adGroupId], stateFilter:{ include:['ENABLED','PAUSED','ARCHIVED'] }, maxResults:100,
          }, 'application/vnd.spKeyword.v3+json');
          const existing = listOf(kwResp, 'keywords');
          const active = existing.filter((k:any) => String(k.state || '').toUpperCase() === 'ENABLED');
          keywordCount = active.length;
          if (!keywordCount) {
            const used = new Set(existing.map((k:any) => norm(k.keywordText || k.keyword)));
            const chosen = await chooseTerm(base44, accountId, asin, used);
            if (!chosen) throw new Error('Sem termos disponíveis no TermBank nem em Amazon Ads Suggestions');
            const created = await ads(base44, accountId, 'createKeywordForDefinitiveRepair', 'POST', '/sp/keywords', {
              keywords:[{ campaignId, adGroupId, keywordText:chosen.keyword, matchType:'EXACT', state:'ENABLED', bid:0.5 }],
            }, 'application/vnd.spKeyword.v3+json');
            const keywordId = idFrom(created, 'keywords', 'keywordId');
            if (!keywordId && !created?.ok) throw new Error(created?.errors?.[0]?.message || 'Falha ao criar palavra-chave');
            await base44.asServiceRole.entities.Keyword.create({
              amazon_account_id:accountId, campaign_id:campaignId, ad_group_id:adGroupId,
              keyword_id:keywordId ? String(keywordId) : `kw_${Date.now()}`, asin,
              keyword_text:chosen.keyword, keyword:chosen.keyword, match_type:'exact', state:'enabled', status:'enabled',
              current_bid:0.5, bid:0.5, source:chosen.source, first_seen_at:new Date().toISOString(), last_seen_at:new Date().toISOString(), synced_at:new Date().toISOString(),
            }).catch(() => {});
            if (chosen.source === 'amazon_ads_suggestion' && chosen.row?.id) {
              await base44.asServiceRole.entities.KeywordSuggestion.update(chosen.row.id, { status:'applied', applied_at:new Date().toISOString(), campaign_id:campaignId }).catch(() => {});
            }
            item.repaired.push(`keyword_created:${chosen.source}:${chosen.keyword}`); await wait(14000);
          }
        }

        const enable = await ads(base44, accountId, 'enableCompletedCampaign', 'PUT', '/sp/campaigns', { campaigns:[{ campaignId, state:'ENABLED' }] });
        if (!enable?.ok && Number(enable?.status) !== 207) throw new Error(enable?.errors?.[0]?.message || 'Falha ao ativar campanha reparada');
        await wait(5000);

        const verifyCampaigns = await ads(base44, accountId, 'verifyCompletedCampaign', 'POST', '/sp/campaigns/list', {
          campaignIdFilter:[campaignId], stateFilter:{ include:['ENABLED','PAUSED','INCOMPLETE','ARCHIVED'] }, maxResults:10,
        });
        const verifiedCampaign = listOf(verifyCampaigns, 'campaigns').find((c:any) => String(c.campaignId) === campaignId);
        const remoteState = String(verifiedCampaign?.state || '').toUpperCase();
        if (remoteState !== 'ENABLED') throw new Error(`Campanha não ficou ENABLED na Amazon; estado final: ${remoteState || 'desconhecido'}`);

        await setLocal(base44, accountId, campaignId, {
          state:'enabled', status:'enabled', archived:false, is_operational:true, is_incomplete:false,
          completion_status:'complete', repair_status:'repaired', repaired_at:new Date().toISOString(),
          last_repair_error:null, keyword_count:Math.max(1, keywordCount), ad_group_id:adGroupId,
        });
        item.action = 'completed'; item.ok = true; item.remote_state = remoteState;
      } catch (e:any) {
        item.errors.push(e?.message || String(e));
        await archiveCampaign(base44, accountId, campaignId, `Falha ao completar: ${e?.message || String(e)}`);
        item.action = 'archived'; item.reason = 'repair_failed'; item.ok = false;
      }
      results.push(item);
      await wait(3000);
    }

    const localIncomplete = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id:accountId, is_incomplete:true }, '-updated_at', 500).catch(() => []);
    for (const c of localIncomplete) {
      const remoteMatch = remote.find((r:any) => String(r.campaignId) === String(c.campaign_id));
      if (!remoteMatch || String(remoteMatch.state || '').toUpperCase() !== 'ENABLED') {
        await base44.asServiceRole.entities.Campaign.update(c.id, {
          state:String(remoteMatch?.state || 'archived').toLowerCase(), status:String(remoteMatch?.state || 'archived').toLowerCase(),
          is_operational:false, completion_status:String(remoteMatch?.state || 'archived').toLowerCase(),
        }).catch(() => {});
      }
    }

    return Response.json({
      ok: results.every(r => r.ok !== false), checked: targets.length,
      completed: results.filter(r => r.action === 'completed').length,
      archived: results.filter(r => r.action === 'archived').length,
      results,
    });
  } catch (error:any) {
    return Response.json({ ok:false, error:error?.message || 'Erro no reparo definitivo' }, { status:500 });
  }
});