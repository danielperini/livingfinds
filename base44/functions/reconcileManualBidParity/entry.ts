import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function ads(base44: any, accountId: string, operation: string, method: string, path: string, payload: any, contentType: string) {
  const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
    amazon_account_id: accountId,
    operation,
    method,
    path,
    payload,
    content_type: contentType,
    accept: contentType,
    max_attempts: 3,
    _service_role: true,
  });
  return response?.data || response || {};
}

function listOf(data: any, key: string) {
  const payload = data?.payload || data || {};
  if (Array.isArray(payload?.[key])) return payload[key];
  if (Array.isArray(payload)) return payload;
  return [];
}

function bidOf(keyword: any, group: any) {
  const keywordBid = Number(keyword?.bid?.value ?? keyword?.bid ?? 0);
  const groupBid = Number(group?.defaultBid ?? 0);
  return keywordBid > 0 ? keywordBid : groupBid;
}

function norm(value: any) {
  return String(value || '').toLowerCase().trim();
}

function localCampaignId(row: any) {
  return String(row?.campaign_id || row?.amazon_campaign_id || '');
}

function quantity(product: any) {
  return Number(product?.fba_inventory ?? product?.available_quantity ?? product?.fulfillable_quantity ?? product?.stock ?? 0);
}

function productEligible(product: any) {
  if (!product) return false;
  const status = norm(product.status || product.product_status || product.listing_status);
  if (['inactive', 'archived', 'deleted', 'suppressed'].includes(status)) return false;
  if (norm(product.inventory_status) === 'out_of_stock' || quantity(product) <= 0) return false;
  const scope = norm(product.ads_scope_status);
  if (scope && scope !== 'authorized') return false;
  const eligibility = norm(product.ads_eligibility_status);
  if (eligibility && eligibility !== 'eligible') return false;
  return true;
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    let accountId = body.amazon_account_id;
    if (!accountId) {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 1).catch(() => []);
      accountId = accounts[0]?.id;
    }
    if (!accountId) return Response.json({ ok: false, error: 'Conta Amazon não encontrada' });

    // Estados locais são usados apenas como vínculo ASIN/produto. A lista remota abaixo
    // é a autoridade para dizer se a campanha/ad group está realmente ENABLED na Amazon.
    const [localCampaigns, products] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []),
    ]);
    const localCampaignById = new Map(localCampaigns.map((row: any) => [localCampaignId(row), row]).filter(([id]: any) => Boolean(id)));
    const productByAsin = new Map(products.filter((row: any) => row.asin).map((row: any) => [String(row.asin), row]));

    // REGRA: reconciliação de bid só atua sobre campanhas MANUAL realmente ENABLED.
    // PAUSED/ARCHIVED ficam fora do ciclo e preservam apenas histórico.
    const campaignsResponse = await ads(base44, accountId, 'listManualCampaignsForBidParity', 'POST', '/sp/campaigns/list', {
      stateFilter: { include: ['ENABLED'] },
      targetingTypeFilter: ['MANUAL'],
      maxResults: 500,
    }, 'application/vnd.spCampaign.v3+json');
    if (!campaignsResponse?.ok) return Response.json({ ok: false, error: 'Falha ao listar campanhas manuais', detail: campaignsResponse });

    const campaigns = listOf(campaignsResponse, 'campaigns');
    const results: any[] = [];

    for (const campaign of campaigns) {
      const campaignId = String(campaign.campaignId || '');
      if (!campaignId) continue;

      const localCampaign = localCampaignById.get(campaignId);
      const localState = norm(localCampaign?.state || localCampaign?.status);
      const asin = String(localCampaign?.asin || '');
      const product = asin ? productByAsin.get(asin) : null;

      // Não tenta "consertar" registros históricos sem ASIN/produto ativo.
      if (!localCampaign || !['enabled', 'active'].includes(localState)) {
        results.push({ campaign_id: campaignId, ok: true, skipped: true, reason: 'campanha não está ativa no estado persistido atual' });
        continue;
      }
      if (!asin || !productEligible(product)) {
        results.push({ campaign_id: campaignId, asin: asin || null, ok: true, skipped: true, reason: !asin ? 'ASIN não resolvido' : 'ASIN/produto inativo, inelegível ou sem estoque' });
        continue;
      }

      const groupsResponse = await ads(base44, accountId, 'listAdGroupsForBidParity', 'POST', '/sp/adGroups/list', {
        campaignIdFilter: [campaignId],
        stateFilter: { include: ['ENABLED'] },
        maxResults: 100,
      }, 'application/vnd.spAdGroup.v3+json');
      const groups = listOf(groupsResponse, 'adGroups');

      for (const group of groups) {
        const adGroupId = String(group.adGroupId || '');
        if (!adGroupId) continue;

        // CRÍTICO: listar TODAS as keywords ENABLED primeiro. O código antigo filtrava EXACT
        // na consulta e podia enxergar 1 EXACT em um grupo que, na realidade, tinha dezenas
        // de BROAD/PHRASE, alterando o defaultBid de um grupo multi-keyword antigo.
        const keywordsResponse = await ads(base44, accountId, 'listAllKeywordsForBidParity', 'POST', '/sp/keywords/list', {
          campaignIdFilter: [campaignId],
          adGroupIdFilter: [adGroupId],
          stateFilter: { include: ['ENABLED'] },
          maxResults: 100,
        }, 'application/vnd.spKeyword.v3+json');
        const allEnabledKeywords = listOf(keywordsResponse, 'keywords');

        if (allEnabledKeywords.length !== 1) {
          results.push({
            campaign_id: campaignId,
            asin,
            ad_group_id: adGroupId,
            ok: true,
            skipped: true,
            reason: `grupo não canônico: ${allEnabledKeywords.length} keywords ativas; fora do ciclo de bid até migração 1 campanha = 1 EXACT`,
          });
          continue;
        }

        const keyword = allEnabledKeywords[0];
        if (norm(keyword.matchType || keyword.match_type) !== 'exact') {
          results.push({ campaign_id: campaignId, asin, ad_group_id: adGroupId, ok: true, skipped: true, reason: `keyword ${keyword.matchType || keyword.match_type || 'sem match'} não é EXACT` });
          continue;
        }

        const keywordId = String(keyword.keywordId || '');
        const keywordBid = Number(keyword?.bid?.value ?? keyword?.bid ?? 0);
        const groupBid = Number(group.defaultBid || 0);
        const targetBid = bidOf(keyword, group);

        if (!keywordId || targetBid <= 0) {
          results.push({ campaign_id: campaignId, ad_group_id: adGroupId, keyword_id: keywordId || null, ok: false, error: 'Keyword ou bid inválido' });
          continue;
        }

        if (Math.abs(keywordBid - groupBid) < 0.001) {
          results.push({ campaign_id: campaignId, asin, ad_group_id: adGroupId, keyword_id: keywordId, ok: true, already_equal: true, bid: targetBid });
          continue;
        }

        const updateGroup = await ads(base44, accountId, 'reconcileAdGroupBid', 'PUT', '/sp/adGroups', {
          adGroups: [{ adGroupId, defaultBid: targetBid }],
        }, 'application/vnd.spAdGroup.v3+json');
        if (!updateGroup?.ok) {
          results.push({ campaign_id: campaignId, ad_group_id: adGroupId, keyword_id: keywordId, ok: false, error: 'Falha ao ajustar bid do grupo' });
          continue;
        }

        await wait(1200);
        const updateKeyword = await ads(base44, accountId, 'reconcileKeywordBid', 'PUT', '/sp/keywords', {
          keywords: [{ keywordId, bid: targetBid }],
        }, 'application/vnd.spKeyword.v3+json');

        if (!keywordUpdateSucceeded(keywordUpdate)) {
          if (groupBid > 0) {
            await ads(base44, accountId, 'rollbackReconcileAdGroupBid', 'PUT', '/sp/adGroups', {
              adGroups: [{ adGroupId, defaultBid: groupBid }],
            }, 'application/vnd.spAdGroup.v3+json').catch(() => null);
          }
          results.push({ campaign_id: campaignId, ad_group_id: adGroupId, keyword_id: keywordId, ok: false, error: 'Falha ao ajustar keyword; grupo revertido' });
          continue;
        }

        const now = new Date().toISOString();
        const localKeywords = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId, keyword_id: keywordId }, null, 5).catch(() => []);
        for (const row of localKeywords) {
          await base44.asServiceRole.entities.Keyword.update(row.id, { current_bid: targetBid, bid: targetBid, synced_at: now }).catch(() => {});
        }

        const localGroups = await base44.asServiceRole.entities.AdGroup?.filter?.({ amazon_account_id: accountId, ad_group_id: adGroupId }, null, 5).catch(() => []) || [];
        for (const row of localGroups) {
          await base44.asServiceRole.entities.AdGroup.update(row.id, { default_bid: targetBid, bid: targetBid, synced_at: now }).catch(() => {});
        }

        await base44.asServiceRole.entities.BidHistory.create({
          amazon_account_id: accountId,
          entity_type: 'keyword_and_ad_group',
          entity_id: `${keywordId}|${adGroupId}`,
          entity_name: keyword.keywordText || campaign.name || campaignId,
          campaign_id: campaignId,
          bid_before: keywordBid !== groupBid ? groupBid : keywordBid,
          bid_after: targetBid,
          reason: 'Reconciliação automática: keyword e ad group ativos estavam com bids divergentes.',
          applied_by: 'bid_parity_reconciler',
          executed_at: now,
          created_at: now,
        }).catch(() => {});

        results.push({ campaign_id: campaignId, asin, ad_group_id: adGroupId, keyword_id: keywordId, ok: true, corrected: true, keyword_bid_before: keywordBid, group_bid_before: groupBid, bid_after: targetBid });
        await wait(1200);
      }
    }

    return Response.json({
      ok: results.every((item) => item.ok || item.skipped),
      checked: results.length,
      corrected: results.filter((item) => item.corrected).length,
      already_equal: results.filter((item) => item.already_equal).length,
      skipped_inactive_or_noncanonical: results.filter((item) => item.skipped).length,
      failed: results.filter((item) => item.ok === false).length,
      policy: 'enabled_campaign_enabled_group_one_enabled_exact_keyword_active_asin_only',
      results,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao reconciliar bids manuais' }, { status: 500 });
  }
});

function keywordUpdateSucceeded(response: any) {
  if (!response) return false;
  if (response.ok === true) return true;
  const payload = response?.payload || response;
  return Array.isArray(payload?.keywords?.success) && payload.keywords.success.length > 0;
}
