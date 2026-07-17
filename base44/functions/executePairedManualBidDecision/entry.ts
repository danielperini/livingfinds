import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const BID_ACTIONS = new Set(['reduce_bid', 'increase_bid', 'update_bid', 'set_bid']);
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

function message(data: any) {
  return String(data?.errors?.[0]?.message || data?.message || data?.error || 'Resposta Amazon inválida').slice(0, 500);
}

async function markDecision(base44: any, decision: any, ok: boolean, detail: any) {
  const now = new Date().toISOString();
  await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
    status: ok ? 'executed' : 'failed',
    queue_status: ok ? 'completed' : 'failed',
    queue_processed_at: now,
    executed_at: ok ? now : null,
    error_message: ok ? null : message(detail),
    amazon_response: JSON.stringify(detail).slice(0, 4000),
    updated_at: now,
  });
}

async function executeOne(base44: any, decision: any) {
  const accountId = decision.amazon_account_id;
  const targetBid = Number(decision.value_after);
  if (!Number.isFinite(targetBid) || targetBid <= 0) throw new Error('Bid de destino inválido');

  const keywordId = String(decision.keyword_id || (decision.entity_type === 'keyword' ? decision.entity_id : '') || '');
  let campaignId = String(decision.campaign_id || '');
  let adGroupId = String(decision.ad_group_id || (decision.entity_type === 'ad_group' ? decision.entity_id : '') || '');
  let keyword: any = null;

  if (keywordId) {
    const kwRows = await base44.asServiceRole.entities.Keyword.filter({
      amazon_account_id: accountId,
      keyword_id: keywordId,
    }, '-updated_at', 1).catch(() => []);
    keyword = kwRows[0] || null;
    campaignId ||= String(keyword?.campaign_id || '');
    adGroupId ||= String(keyword?.ad_group_id || '');
  }

  if ((!campaignId || !adGroupId) && decision.asin) {
    const kwRows = await base44.asServiceRole.entities.Keyword.filter({
      amazon_account_id: accountId,
      asin: decision.asin,
      keyword_text: decision.keyword_text,
    }, '-updated_at', 10).catch(() => []);
    keyword = keyword || kwRows.find((row: any) => String(row.state || row.status).toLowerCase() === 'enabled') || kwRows[0] || null;
    campaignId ||= String(keyword?.campaign_id || '');
    adGroupId ||= String(keyword?.ad_group_id || '');
  }

  if (!campaignId || !adGroupId) throw new Error('Não foi possível resolver campaign_id e ad_group_id para sincronizar os dois bids');

  const groupsResponse = await ads(base44, accountId, 'readAdGroupBeforePairedBid', 'POST', '/sp/adGroups/list', {
    campaignIdFilter: [campaignId],
    adGroupIdFilter: [adGroupId],
    stateFilter: { include: ['ENABLED', 'PAUSED'] },
    maxResults: 10,
  }, 'application/vnd.spAdGroup.v3+json');
  const remoteGroup = listOf(groupsResponse, 'adGroups')[0];
  const previousGroupBid = Number(remoteGroup?.defaultBid || 0);

  let resolvedKeywordId = keywordId;
  if (!resolvedKeywordId) {
    const keywordsResponse = await ads(base44, accountId, 'readKeywordBeforePairedBid', 'POST', '/sp/keywords/list', {
      campaignIdFilter: [campaignId],
      adGroupIdFilter: [adGroupId],
      stateFilter: { include: ['ENABLED', 'PAUSED'] },
      matchTypeFilter: ['EXACT'],
      maxResults: 100,
    }, 'application/vnd.spKeyword.v3+json');
    const remoteKeywords = listOf(keywordsResponse, 'keywords');
    const match = remoteKeywords.find((item: any) => !decision.keyword_text || String(item.keywordText || '').toLowerCase() === String(decision.keyword_text).toLowerCase()) || remoteKeywords[0];
    resolvedKeywordId = String(match?.keywordId || '');
  }
  if (!resolvedKeywordId) throw new Error('Keyword não encontrada na Amazon para sincronização do bid');

  const groupUpdate = await ads(base44, accountId, 'pairedBidUpdateAdGroup', 'PUT', '/sp/adGroups', {
    adGroups: [{ adGroupId, defaultBid: targetBid }],
  }, 'application/vnd.spAdGroup.v3+json');
  if (!groupUpdate?.ok) throw new Error(`Falha ao atualizar bid do grupo: ${message(groupUpdate)}`);

  await wait(1200);
  const keywordUpdate = await ads(base44, accountId, 'pairedBidUpdateKeyword', 'PUT', '/sp/keywords', {
    keywords: [{ keywordId: resolvedKeywordId, bid: targetBid }],
  }, 'application/vnd.spKeyword.v3+json');

  if (!keywordUpdate?.ok) {
    if (previousGroupBid > 0) {
      await ads(base44, accountId, 'pairedBidRollbackAdGroup', 'PUT', '/sp/adGroups', {
        adGroups: [{ adGroupId, defaultBid: previousGroupBid }],
      }, 'application/vnd.spAdGroup.v3+json').catch(() => null);
    }
    throw new Error(`Falha ao atualizar bid da keyword; grupo revertido: ${message(keywordUpdate)}`);
  }

  const now = new Date().toISOString();
  const localKeywords = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId, keyword_id: resolvedKeywordId }, null, 5).catch(() => []);
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
    entity_id: `${resolvedKeywordId}|${adGroupId}`,
    entity_name: decision.keyword_text || campaignId,
    campaign_id: campaignId,
    bid_before: decision.value_before ?? previousGroupBid ?? null,
    bid_after: targetBid,
    change_pct: decision.change_pct,
    reason: `${decision.rationale || 'Ajuste IA'} | Bid sincronizado simultaneamente em keyword e ad group.`.slice(0, 500),
    applied_by: 'paired_manual_bid',
    decision_id: decision.id,
    executed_at: now,
    created_at: now,
  }).catch(() => {});

  return { ok: true, status: 'executed', decision_id: decision.id, campaign_id: campaignId, ad_group_id: adGroupId, keyword_id: resolvedKeywordId, bid: targetBid };
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    const ids = body.decision_ids || (body.decision_id ? [body.decision_id] : []);
    const results: any[] = [];

    for (const id of ids) {
      const rows = await base44.asServiceRole.entities.OptimizationDecision.filter({ id }, null, 1).catch(() => []);
      const decision = rows[0];
      if (!decision || !BID_ACTIONS.has(decision.action)) {
        results.push({ id, ok: false, skipped: true, reason: 'Decisão inexistente ou não é ajuste de bid' });
        continue;
      }
      if (!['approved', 'executing'].includes(decision.status)) {
        results.push({ id, ok: false, skipped: true, reason: `status ${decision.status}` });
        continue;
      }

      await base44.asServiceRole.entities.OptimizationDecision.update(decision.id, {
        status: 'executing',
        queue_status: 'processing',
        last_attempt_at: new Date().toISOString(),
        attempt_count: Number(decision.attempt_count || 0) + 1,
      });

      try {
        const result = await executeOne(base44, decision);
        await markDecision(base44, decision, true, result);
        results.push(result);
      } catch (error: any) {
        const detail = { ok: false, error: error?.message || String(error) };
        await markDecision(base44, decision, false, detail);
        results.push({ id, ...detail, status: 'failed' });
      }
    }

    return Response.json({ ok: results.every((item) => item.ok || item.skipped), results });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao sincronizar bids de keyword e ad group' }, { status: 500 });
  }
});
