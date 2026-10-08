export function promotionConfirmation(p: any, campaign: any, group: any, keyword: any, ad: any): {confirmed:boolean;reason:string} {
 const id=(v:any)=>String(v||'');
 const enabled=(v:any)=>String(v||'').toUpperCase()==='ENABLED';
 if (![p.destination_campaign_id,p.destination_ad_group_id,p.destination_keyword_id,p.destination_ad_id].every(Boolean)) return {confirmed:false,reason:'missing_destination_ids'};
 if (!campaign||!group||!keyword||!ad) return {confirmed:false,reason:'remote_entity_not_found'};
 if (id(campaign.campaignId)!==id(p.destination_campaign_id)||id(group.adGroupId)!==id(p.destination_ad_group_id)||id(keyword.keywordId)!==id(p.destination_keyword_id)||id(ad.adId)!==id(p.destination_ad_id)) return {confirmed:false,reason:'identity_mismatch'};
 if ([group,keyword,ad].some(r=>id(r.campaignId)!==id(campaign.campaignId)) || [keyword,ad].some(r=>id(r.adGroupId)!==id(group.adGroupId))) return {confirmed:false,reason:'parent_relationship_mismatch'};
 if (!p.sku || String(ad.sku||'').trim().toUpperCase()!==String(p.sku).trim().toUpperCase() || id(ad.asin)!==id(p.asin)) return {confirmed:false,reason:'advertised_product_mismatch'};
 const term=(v:any)=>String(v||'').trim().toLowerCase().replace(/\s+/g,' ');
 if(String(keyword.matchType).toUpperCase()!=='EXACT'||term(keyword.keywordText)!==term(p.source_search_term||p.normalized_search_term)) return {confirmed:false,reason:'keyword_mismatch'};
 if([campaign,group,keyword,ad].some(r=>!enabled(r.state))) return {confirmed:false,reason:'remote_entity_not_enabled'};
 return {confirmed:true,reason:'all_entities_verified'};
}
