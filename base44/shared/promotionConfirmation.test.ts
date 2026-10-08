import {assertEquals} from 'jsr:@std/assert';
import {promotionConfirmation} from './promotionConfirmation.ts';
const p={destination_campaign_id:'c',destination_ad_group_id:'g',destination_keyword_id:'k',destination_ad_id:'a',sku:'SKU',asin:'ASIN',source_search_term:'microfone usb'};
const c={campaignId:'c',state:'ENABLED'},g={adGroupId:'g',campaignId:'c',state:'ENABLED'},k={keywordId:'k',adGroupId:'g',campaignId:'c',state:'ENABLED',matchType:'EXACT',keywordText:'microfone usb'},a={adId:'a',adGroupId:'g',campaignId:'c',sku:'SKU',asin:'ASIN',state:'ENABLED'};
Deno.test('promotion requires the entire enabled hierarchy for the correct product',()=>{
 assertEquals(promotionConfirmation(p,c,g,k,a).confirmed,true);
 assertEquals(promotionConfirmation(p,c,g,k,null).confirmed,false);
 assertEquals(promotionConfirmation(p,c,g,k,{...a,state:'PAUSED'}).confirmed,false);
 assertEquals(promotionConfirmation(p,c,g,{...k,campaignId:'other'},a).reason,'parent_relationship_mismatch');
 assertEquals(promotionConfirmation(p,c,g,k,{...a,sku:'OTHER'}).reason,'advertised_product_mismatch');
 assertEquals(promotionConfirmation(p,c,g,{...k,keywordText:'title fragment'},a).reason,'keyword_mismatch');
});
