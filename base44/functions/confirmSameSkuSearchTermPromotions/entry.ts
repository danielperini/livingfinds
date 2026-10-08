import {promotionConfirmation} from '../../shared/promotionConfirmation.ts';
/**
 * Probes accepted same-SKU Exact promotions without replaying any mutation.
 * A slow Amazon propagation is kept in confirming; it never triggers creation again.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const unwrap = (value: any) => value?.data || value || {};
const idOf = (value: any, ...keys: string[]) => keys.map((key) => String(value?.[key] || '')).find(Boolean) || '';

async function remoteList(base44: any, accountId: string, path: string, contentType: string, filter: Record<string,unknown>) {
  const response = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
    _service_role: true, amazon_account_id: accountId,
    operation: 'confirmSameSkuSearchTermPromotionProbe', method: 'POST', path,
    payload: { maxResults: 1000, ...filter }, content_type: contentType, accept: contentType,
  });
  const data = unwrap(response);
  if (data.ok === false) throw new Error(data.error || data.errors?.[0]?.message || `Amazon probe failed: ${path}`);
  const payload = data.payload || data;
  return Object.values(payload).find(Array.isArray) as any[] || [];
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) {
      const authenticated = await base44.auth.isAuthenticated().catch(() => false);
      if (!authenticated) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }
    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, undefined, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-updated_at', 50);
    const results: any[] = [];
    for (const account of accounts) {
      const aid = String(account.id);
      const promotions = await base44.asServiceRole.entities.SearchTermPromotion.filter({ amazon_account_id: aid }, '-updated_at', 10000);
      const pending = promotions.filter((row: any) => row.promotion_status === 'confirming').slice(0, Math.max(1, Math.min(100, Number(body.max_promotions || 100))));
      if (!pending.length) { results.push({ amazon_account_id: aid, checked: 0, confirmed: 0, propagating: 0 }); continue; }
      const ids = (field:string) => [...new Set(pending.map((p:any)=>String(p[field]||'')).filter(Boolean))];
      const probe = (path:string, type:string, field:string, filterKey:string) => ids(field).length ? remoteList(base44,aid,path,type,{[filterKey]:{include:ids(field)}}) : Promise.resolve([]);
      const [campaigns, adGroups, keywords, ads] = await Promise.all([
        probe('/sp/campaigns/list','application/vnd.spCampaign.v3+json','destination_campaign_id','campaignIdFilter'),
        probe('/sp/adGroups/list','application/vnd.spAdGroup.v3+json','destination_ad_group_id','adGroupIdFilter'),
        probe('/sp/keywords/list','application/vnd.spKeyword.v3+json','destination_keyword_id','keywordIdFilter'),
        probe('/sp/productAds/list','application/vnd.spProductAd.v3+json','destination_ad_id','adIdFilter'),
      ]);
      let confirmed = 0, propagating = 0;
      for (const promo of pending) {
        const result = promotionConfirmation(promo,
          campaigns.find(r=>idOf(r,'campaignId')===String(promo.destination_campaign_id||'')),
          adGroups.find(r=>idOf(r,'adGroupId')===String(promo.destination_ad_group_id||'')),
          keywords.find(r=>idOf(r,'keywordId')===String(promo.destination_keyword_id||'')),
          ads.find(r=>idOf(r,'adId')===String(promo.destination_ad_id||'')));
        const complete = result.confirmed;
        const now = new Date().toISOString();
        await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, complete ? {
          promotion_status: 'confirmed', completion_status: 'confirmed_remote_probe', amazon_confirmation_status: 'confirmed', completed_at: now, last_error: null, updated_at: now,
        } : {
          promotion_status: 'confirming', completion_status: result.reason, amazon_confirmation_status: 'unconfirmed', last_error: result.reason, updated_at: now,
        });
        if (complete) confirmed++; else propagating++;
      }
      results.push({ amazon_account_id: aid, checked: pending.length, confirmed, propagating });
    }
    return Response.json({ ok: true, mode: 'probe_only_no_mutation_replay', results });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || String(error) }, { status: 500 });
  }
});
