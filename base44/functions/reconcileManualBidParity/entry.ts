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

    const campaignsResponse = await ads(base44, accountId, 'listManualCampaignsForBidParity', 'POST', '/sp/campaigns/list', {
      stateFilter: { include: ['ENABLED', 'PAUSED'] },
      targetingTypeFilter: ['MANUAL'],
      maxResults: 500,
    }, 'application/vnd.spCampaign.v3+json');
    if (!campaignsResponse?.ok) return Response.json({ ok: false, error: 'Falha ao listar campanhas manuais', detail: campaignsResponse });

    const campaigns = listOf(campaignsResponse, 'campaigns');
    const results: any[] = [];

    for (const campaign of campaigns) {
      const campaignId = String(campaign.campaignId || '');
      if (!campaignId) continue;

      const groupsResponse = await ads(base44, accountId, 'listAdGroupsForBidParity', 'POST', '/sp/adGroups/list', {
        campaignIdFilter: [campaignId],
        stateFilter: { include: ['ENABLED', 'PAUSED'] },
        maxResults: 100,
      }, 'application/vnd.spAdGroup.v3+json');
      const groups = listOf(groupsResponse, 'adGroups');

      for (const group of groups) {
        const adGroupId = String(group.adGroupId || '');
        if (!adGroupId) continue;

        const keywordsResponse = await ads(base44, accountId, 'listKeywordsForBidParity', 'POST', '/sp/keywords/list', {
          campaignIdFilter: [campaignId],
          adGroupIdFilter: [adGroupId],
          stateFilter: { include: ['ENABLED'] },
          matchTypeFilter: ['EXACT'],
          maxResults: 100,
        }, 'application/vnd.spKeyword.v3+json');
        const keywords = listOf(keywordsResponse, 'keywords');

        if (keywords.length !== 1) {
          results.push({ campaign_id: campaignId, ad_group_id: adGroupId, ok: true, skipped: true, reason: `grupo possui ${keywords.length} keywords ativas` });
          continue;
        }

        const keyword = keywords[0];
        const keywordId = String(keyword.keywordId || '');
        const keywordBid = Number(keyword?.bid?.value ?? keyword?.bid ?? 0);
        const groupBid = Number(group.defaultBid || 0);
        const targetBid = bidOf(keyword, group);

        if (!keywordId || targetBid <= 0) {
          results.push({ campaign_id: campaignId, ad_group_id: adGroupId, ok: false, error: 'Keyword ou bid inválido' });
          continue;
        }

        if (Math.abs(keywordBid - groupBid) < 0.001) {
          results.push({ campaign_id: campaignId, ad_group_id: adGroupId, keyword_id: keywordId, ok: true, already_equal: true, bid: targetBid });
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

        if (!updateKeyword?.ok) {
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
          reason: 'Reconciliação automática: keyword e ad group estavam com bids divergentes.',
          applied_by: 'bid_parity_reconciler',
          executed_at: now,
          created_at: now,
        }).catch(() => {});

        results.push({ campaign_id: campaignId, ad_group_id: adGroupId, keyword_id: keywordId, ok: true, corrected: true, keyword_bid_before: keywordBid, group_bid_before: groupBid, bid_after: targetBid });
        await wait(1200);
      }
    }

    return Response.json({
      ok: results.every((item) => item.ok || item.skipped),
      checked: results.length,
      corrected: results.filter((item) => item.corrected).length,
      already_equal: results.filter((item) => item.already_equal).length,
      failed: results.filter((item) => item.ok === false).length,
      results,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao reconciliar bids manuais' }, { status: 500 });
  }
});
