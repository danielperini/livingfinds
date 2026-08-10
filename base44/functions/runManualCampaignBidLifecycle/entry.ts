/**
 * runManualCampaignBidLifecycle
 *
 * Gerencia o ciclo de vida de bids para campanhas manuais SP:
 *
 * Fase 0 (criaÃ§Ã£o): bid inicial R$0,50 â€” default bid do grupo e keyword bid
 * Fase 1 (0-48h): monitoramento + contenÃ§Ã£o emergencial
 * Fase 2 (48h): consulta sugestÃ£o Amazon â†’ aplica menor valor seguro
 * Fase 3 (72h): reavaliaÃ§Ã£o pÃ³s-ajuste
 * Fase 4 (+): entrega ao runUnifiedDecisionEngine
 *
 * Nunca altera budget de campanha. Distingue:
 *   - campaign_budget (orÃ§amento diÃ¡rio)
 *   - ad_group_default_bid (lance padrÃ£o do grupo)
 *   - keyword_bid (lance individual)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import {
  calculateTrafficSufficiency,
  shouldProtectServingManual,
} from '../../shared/servingCampaignGrowthPolicy.ts';

const INITIAL_BID = 0.60; // fallback se sem sugestÃ£o Amazon
const HOURS_48 = 48;
const HOURS_72 = 72;
// ContenÃ§Ã£o emergencial: >10 cliques + gasto >= R$12 + zero compras
const EMERGENCY_MIN_CLICKS = 10;
const EMERGENCY_MIN_SPEND = 12.0;

function nowIso() { return new Date().toISOString(); }
function num(v: unknown): number { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; }

function round2(v: number): number { return Math.round(v * 100) / 100; }

function ageHours(createdAt: string | null | undefined): number {
  if (!createdAt) return 0;
  return (Date.now() - new Date(createdAt).getTime()) / 3600000;
}

// Obter token Amazon Ads
async function getAdsToken(account: any): Promise<string | null> {
  const rt = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
  const cid = Deno.env.get('ADS_CLIENT_ID') || '';
  const csec = Deno.env.get('ADS_CLIENT_SECRET') || '';
  if (!rt || !cid) return null;
  try {
    const r = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: cid, client_secret: csec }).toString(),
    });
    if (!r.ok) return null;
    return (await r.json()).access_token || null;
  } catch { return null; }
}

function getAdsEndpoint(account: any): string {
  const region = String(account.region || Deno.env.get('ADS_REGION') || 'na');
  const endpoints: Record<string, string> = {
    na: 'https://advertising-api.amazon.com',
    eu: 'https://advertising-api-eu.amazon.com',
    fe: 'https://advertising-api-fe.amazon.com',
  };
  return endpoints[region] || endpoints.na;
}

// Consultar ad group na Amazon para obter default bid real
async function fetchAdGroupFromAmazon(endpoint: string, token: string, profileId: string, adGroupId: string): Promise<{ defaultBid: number | null; state: string | null; requestId: string }> {
  try {
    const r = await fetch(`${endpoint}/sp/adGroups`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
        'Amazon-Advertising-API-Scope': profileId,
        'Content-Type': 'application/vnd.spAdGroup.v3+json',
        'Accept': 'application/vnd.spAdGroup.v3+json',
      },
      body: JSON.stringify({ adGroupIdFilter: { include: [adGroupId] } }),
    });
    const requestId = r.headers.get('x-amzn-requestid') || '';
    if (!r.ok) return { defaultBid: null, state: null, requestId };
    const data = await r.json();
    const ag = (data?.adGroups || [])[0];
    return {
      defaultBid: ag?.defaultBid != null ? num(ag.defaultBid) : null,
      state: ag?.state || null,
      requestId,
    };
  } catch { return { defaultBid: null, state: null, requestId: '' }; }
}

// Consultar keyword na Amazon para obter bid real
async function fetchKeywordFromAmazon(endpoint: string, token: string, profileId: string, keywordId: string): Promise<{ bid: number | null; state: string | null; requestId: string }> {
  try {
    const r = await fetch(`${endpoint}/sp/keywords`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
        'Amazon-Advertising-API-Scope': profileId,
        'Content-Type': 'application/vnd.spKeyword.v3+json',
        'Accept': 'application/vnd.spKeyword.v3+json',
      },
      body: JSON.stringify({ keywordIdFilter: { include: [keywordId] } }),
    });
    const requestId = r.headers.get('x-amzn-requestid') || '';
    if (!r.ok) return { bid: null, state: null, requestId };
    const data = await r.json();
    const kw = (data?.keywords || [])[0];
    return {
      bid: kw?.bid != null ? num(kw.bid) : null,
      state: kw?.state || null,
      requestId,
    };
  } catch { return { bid: null, state: null, requestId: '' }; }
}

// Atualizar bid de keyword na Amazon (v3)
async function updateKeywordBidOnAmazon(
  endpoint: string, token: string, profileId: string,
  keywordId: string, newBid: number
): Promise<{ success: boolean; confirmedBid: number | null; requestId: string; error: string | null }> {
  try {
    const r = await fetch(`${endpoint}/sp/keywords`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
        'Amazon-Advertising-API-Scope': profileId,
        'Content-Type': 'application/vnd.spKeyword.v3+json',
        'Accept': 'application/vnd.spKeyword.v3+json',
      },
      body: JSON.stringify({ keywords: [{ keywordId, bid: newBid }] }),
    });
    const requestId = r.headers.get('x-amzn-requestid') || '';
    if (r.status === 429) return { success: false, confirmedBid: null, requestId, error: 'rate_limited_429' };
    if (!r.ok) return { success: false, confirmedBid: null, requestId, error: `http_${r.status}` };
    const data = await r.json();
    const success = (data?.keywords?.success || []).find((s: any) => s.keywordId === keywordId);
    const err = (data?.keywords?.error || []).find((e: any) => e.keywordId === keywordId);
    if (success) return { success: true, confirmedBid: newBid, requestId, error: null };
    if (err) return { success: false, confirmedBid: null, requestId, error: err.errorType || 'amazon_error' };
    return { success: false, confirmedBid: null, requestId, error: 'no_success_in_response' };
  } catch (e: any) {
    return { success: false, confirmedBid: null, requestId: '', error: e.message };
  }
}

// Atualizar default bid do ad group na Amazon (v3)
async function updateAdGroupBidOnAmazon(
  endpoint: string, token: string, profileId: string,
  adGroupId: string, newBid: number
): Promise<{ success: boolean; requestId: string; error: string | null }> {
  try {
    const r = await fetch(`${endpoint}/sp/adGroups`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
        'Amazon-Advertising-API-Scope': profileId,
        'Content-Type': 'application/vnd.spAdGroup.v3+json',
        'Accept': 'application/vnd.spAdGroup.v3+json',
      },
      body: JSON.stringify({ adGroups: [{ adGroupId, defaultBid: newBid }] }),
    });
    const requestId = r.headers.get('x-amzn-requestid') || '';
    if (r.status === 429) return { success: false, requestId, error: 'rate_limited_429' };
    if (!r.ok) return { success: false, requestId, error: `http_${r.status}` };
    const data = await r.json();
    const success = (data?.adGroups?.success || []).find((s: any) => s.adGroupId === adGroupId);
    const err = (data?.adGroups?.error || []).find((e: any) => e.adGroupId === adGroupId);
    if (success) return { success: true, requestId, error: null };
    if (err) return { success: false, requestId, error: err.errorType || 'amazon_error' };
    return { success: false, requestId, error: 'no_success_in_response' };
  } catch (e: any) {
    return { success: false, requestId: '', error: e.message };
  }
}

// Verificar sugestÃ£o de bid para uma keyword (bid recommendations)
async function fetchKeywordBidSuggestion(
  endpoint: string, token: string, profileId: string,
  keywordId: string, adGroupId: string, campaignId: string
): Promise<{ suggested: number | null; lower: number | null; upper: number | null; valid: boolean }> {
  try {
    const r = await fetch(`${endpoint}/sp/targets/bid/recommendations`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
        'Amazon-Advertising-API-Scope': profileId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetingExpressionRequests: [{
          type: 'KEYWORD_BID',
          adGroupId,
          campaignId,
          keywordId,
        }],
      }),
    });
    if (!r.ok) return { suggested: null, lower: null, upper: null, valid: false };
    const data = await r.json();
    const rec = (data?.recommendations || [])[0];
    const sugg = rec?.suggestedBid?.suggested;
    const lower = rec?.suggestedBid?.rangeLower;
    const upper = rec?.suggestedBid?.rangeUpper;
    if (sugg == null) return { suggested: null, lower: null, upper: null, valid: false };
    return {
      suggested: round2(num(sugg)),
      lower: lower != null ? round2(num(lower)) : null,
      upper: upper != null ? round2(num(upper)) : null,
      valid: num(sugg) > 0,
    };
  } catch { return { suggested: null, lower: null, upper: null, valid: false }; }
}

Deno.serve(async (req) => {
  const now = nowIso();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const isAuth = await base44.auth.isAuthenticated().catch(() => false);
    if (!isAuth && !body._service_role) {
      return Response.json({ ok: false, error: 'NÃ£o autorizado' }, { status: 401 });
    }

    // â”€â”€ Resolver conta â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(
      { status: 'connected' }, '-updated_date', 1
    ).catch(() => []);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });
    const aid = account.id;
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';

    // â”€â”€ Carregar configuraÃ§Ãµes de performance (meta ACoS, safe_max_cpc) â”€â”€â”€â”€
    const perfSettings = await base44.asServiceRole.entities.PerformanceSettings.filter(
      { amazon_account_id: aid }, '-updated_at', 1
    ).catch(() => []);
    const settings = perfSettings[0] || {};
    const globalMaxBid = num(settings.max_bid || 5.0);
    const globalMinBid = num(settings.min_bid || 0.40);
    const globalMaxCpc = num(settings.max_cpc || 0);

    // â”€â”€ Carregar dados â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const [campaigns, adGroups, keywords, productEconomics, lifecycles] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, undefined, 300).catch(() => []),
      base44.asServiceRole.entities.AdGroup.filter({ amazon_account_id: aid }, undefined, 500).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, undefined, 1000).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, undefined, 200).catch(() => []),
      base44.asServiceRole.entities.ManualCampaignBidLifecycle.filter({ amazon_account_id: aid }, undefined, 1000).catch(() => []),
    ]);

    // â”€â”€ Ãndices â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const manualCampaigns = campaigns.filter((c: any) => {
      const name = (c.campaign_name || c.name || '').toUpperCase();
      const state = (c.state || c.status || '').toLowerCase();
      return (name.includes('MANUAL') || name.includes('EXACT') || name.includes('PHRASE'))
        && state !== 'archived';
    });

    const agByCampaignId: Record<string, any[]> = {};
    for (const ag of adGroups) {
      const cid = ag.campaign_id || '';
      if (!agByCampaignId[cid]) agByCampaignId[cid] = [];
      agByCampaignId[cid].push(ag);
    }

    // Mapear keywords por ad_group_id E por campaign_id (fallback quando ag nÃ£o sincronizado)
    const kwByAdGroupId: Record<string, any[]> = {};
    const kwByCampaignId: Record<string, any[]> = {};
    for (const kw of keywords) {
      const agid = kw.ad_group_id || '';
      const cid = kw.campaign_id || '';
      const mt = (kw.match_type || '').toLowerCase();
      if (mt.startsWith('negative') || (kw.keyword_id || '').startsWith('neg_')) continue;
      if ((kw.state || kw.status || '').toLowerCase() === 'archived') continue;
      if (agid) { if (!kwByAdGroupId[agid]) kwByAdGroupId[agid] = []; kwByAdGroupId[agid].push(kw); }
      if (cid) { if (!kwByCampaignId[cid]) kwByCampaignId[cid] = []; kwByCampaignId[cid].push(kw); }
    }

    const econByAsin: Record<string, any> = {};
    for (const e of productEconomics) {
      if (e.asin) econByAsin[e.asin] = e;
    }

    // Ãndice de lifecycles existentes: campaign_id + ad_group_id + keyword_id
    const lifecycleKey = (cid: string, agid: string, kwid: string) => `${cid}::${agid}::${kwid}`;
    const existingLC: Record<string, any> = {};
    for (const lc of lifecycles) {
      const k = lifecycleKey(lc.campaign_id, lc.ad_group_id, lc.keyword_id);
      existingLC[k] = lc;
    }

    // â”€â”€ Obter token Amazon (uma vez sÃ³) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const adsToken = await getAdsToken(account);
    const adsEndpoint = getAdsEndpoint(account);
    const hasAdsAccess = !!adsToken && !!profileId;

    const report = {
      campaigns_analyzed: manualCampaigns.length,
      ad_groups_found: 0,
      keywords_found: 0,
      lifecycles_created: 0,
      lifecycles_updated: 0,
      bids_applied_to_amazon: 0,
      bids_failed: 0,
      emergency_reductions: 0,
      post_48h_adjustments: 0,
      post_72h_reviews: 0,
      delivered_to_engine: 0,
      within_48h_protected: 0,
      serving_learning_protected: 0,
      audit_rows: [] as any[],
    };

    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    // â”€â”€ ProÛ­ù¶‰ËkºwµçMĞ°4(€€€€€€€€€€€€€É•Ù¥•İ|ÜÉ¡}…ĞèÉ•Ù¥•ÜÜÉ¡Ğ°4(€€€€€€€€€€€€€¹•áÑ}É•Ù¥•İ}…Ğè…µÁ• €ğ!=UIM|Ğà€ü™¥ÉÍĞĞá¡¹‘ÍĞ€è¹½Ü°4(€€€€€€€€€€€€€Ñ…É•Ñ}…½ÌèÑ…É•Ñ½Ì°4(€€€€€€€€€€€€€Ñ…É•Ñ}…½Í}Í½ÕÉ”èÑ…É•Ñ½ÍM½ÕÉ”°4(€€€€€€€€€€€€€ÕÉÉ•¹Ñ}…½Ìè¹Õ´¡­Ü¹…½Ì¤°4(€€€€€€€€€€€€€ÕÉÉ•¹Ñ}ÍÁ•¹è¹Õ´¡­Ü¹ÍÁ•¹¤°4(€€€€€€€€€€€€€ÕÉÉ•¹Ñ}Í…±•Ìè¹Õ´¡­Ü¹Í…±•Ì¤°4(€€€€€€€€€€€€€ÕÉÉ•¹Ñ}½É‘•ÉÌè¹Õ´¡­Ü¹½É‘•ÉÌ¤°4(€€€€€€€€€€€€€¥µÁÉ•ÍÍ¥½¹Ìè¹Õ´¡­Ü¹¥µÁÉ•ÍÍ¥½¹Ì¤°4(€€€€€€€€€€€€€±¥­Ìè¹Õ´¡­Ü¹±¥­Ì¤°4(€€€€€€€€€€€€€¥‘•µÁ½Ñ•¹å}­•äè¥-•ä°4(€€€€€€€€€€€€€±…ÍÑ}…Ñ¥½¸è‰¥‘ÁÁ±¥•€ü€¥¹¥Ñ¥…±}‰¥‘}…ÁÁ±¥•œ€è€±¥™•å±•}É•¥ÍÑ•É•œ°4(€€€€€€€€€€€€€±…ÍÑ}…Ñ¥½¹}…Ğè¹½Ü°4(€€€€€€€€€€€€€É•…Ñ•‘}…Ğè¹½Ü°4(€€€€€€€€€€€€€ÕÁ‘…Ñ•‘}…Ğè¹½Ü°4(€€€€€€€€€€€ôì4(4(€€€€€€€€€€€…İ…¥Ğ‰…Í”ĞĞ¹…ÍM•ÉÙ¥•I½±”¹•¹Ñ¥Ñ¥•Ì¹5…¹Õ…±…µÁ…¥¹	¥‘1¥™•å±”¹É•…Ñ”¡¹•İ1¤¹…Ñ   ¤€ôøíô¤ì4(€€€€€€€€€€€•á¥ÍÑ¥¹1m±-•åt€ô¹•İ1ì4(€€€€€€€€€€€É•Á½ÉĞ¹±¥™•å±•Í}É•…Ñ•¬¬ì4(4(€€€€€€€€€€€É•Á½ÉĞ¹…Õ‘¥Ñ}É½İÌ¹ÁÕÍ ¡ì4(€€€€€€€€€€€€€…µÁ…¥¸è…µÁ…¥¸¹…µÁ…¥¹}¹…µ”ñğ…µÁ…¥¸¹¹…µ”°4(€€€€€€€€€€€€€…‘}É½ÕÀè…œ¹¹…µ”°4(€€€€€€€€€€€€€…Í¥¸è…µÁÍ¥¸°4(€€€€€€€€€€€€€­•åİ½Éè­Ü¹­•åİ½É‘}Ñ•áĞ°4(€€€€€€€€€€€€€…•} è5…Ñ ¹É½Õ¹¡…µÁ• ¤°4(€€€€€€€€€€€€€…}‘•™…Õ±Ñ}‰¥èÉ½Õ¹È¡…	¥‘Q½M•Ğ¤°4(€€€€€€€€€€€€€­İ}‰¥èÉ½Õ¹È¡­İ	¥‘Q½M•Ğ¤°4(€€€€€€€€€€€€€…µ…é½¹}ÍÕ•ÍÑ•è¹Õ±°°4(€€€€€€€€€€€€€ÍÑ…ÑÕÌè¹•İ1¹ÍÑ…ÑÕÌ°4(€€€€€€€€€€€€€…Ñ¥½¸è‰¥‘ÁÁ±¥•€ü€¥¹¥Ñ¥…±}‰¥‘}…ÁÁ±¥•œ€è€±¥™•å±•}É•¥ÍÑ•É•œ°4(€€€€€€€€€€€ô¤ì4(4(€€€€€€€€€ô•±Í”ì4(€€€€€€€€€€€€¼¼ƒŠRŠR AÉ½•ÍÍ…È±¥™•å±”•á¥ÍÑ•¹Ñ”ƒŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠR 4(€€€€€€€€€€€½¹ÍĞ±Œ€ô•á¥ÍÑ1ì4(€€€€€€€€€€€½¹ÍĞ±MÑ…ÑÕÌ€ô±Œ¹ÍÑ…ÑÕÌì4(4(€€€€€€€€€€€€¼¼ÑÕ…±¥é…È·¥ÑÉ¥…Ì‘¼‰…¹¼4(€€€€€€€€€€€½¹ÍĞµ•ÑÉ¥ÍUÁ‘…Ñ”è…¹ä€ôì4(€€€€€€€€€€€€€ÕÉÉ•¹Ñ}…‘}É½ÕÁ}‘•™…Õ±Ñ}‰¥èÉ•½¹¥±•‘	¥°4(€€€€€€€€€€€€€ÕÉÉ•¹Ñ}­•åİ½É‘}‰¥èÉ•½¹¥±•‘-İ	¥°4(€€€€€€€€€€€€€ÕÉÉ•¹Ñ}…½Ìè¹Õ´¡­Ü¹…½Ì¤°4(€€€€€€€€€€€€€ÕÉÉ•¹Ñ}ÍÁ•¹è¹Õ´¡­Ü¹ÍÁ•¹¤°4(€€€€€€€€€€€€€ÕÉÉ•¹Ñ}Í…±•Ìè¹Õ´¡­Ü¹Í…±•Ì¤°4(€€€€€€€€€€€€€ÕÉÉ•¹Ñ}½É‘•ÉÌè¹Õ´¡­Ü¹½É‘•ÉÌ¤°4(€€€€€€€€€€€€€¥µÁÉ•ÍÍ¥½¹Ìè¹Õ´¡­Ü¹¥µÁÉ•ÍÍ¥½¹Ì¤°4(€€€€€€€€€€€€€±¥­Ìè¹Õ´¡­Ü¹±¥­Ì¤°4(€€€€€€€€€€€€€ÕÁ‘…Ñ•‘}…Ğè¹½Ü°4(€€€€€€€€€€€ôì4(4(€€€€€€€€€€€€¼¼ƒŠRŠR Mèİ¥Ñ¡¥¹|Ğá ƒŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠR 4(€€€€€€€€€€€¥˜€¡±MÑ…ÑÕÌ€ôôô€±…Õ¹¡|Á|Ğá œ¤ì4(€€€€€€€€€€€€€½¹ÍĞ¥ÍMÑ¥±±%¸Ğá €ô…µÁ• €ğ!=UIM|Ğàì4(4(€€€€€€€€€€€€€€¼¼Y•É¥™¥…ÈÉ¥Í¼•µ•É•¹¥…°€¡•á—Ÿ¼Á•Éµ¥Ñ¥‘„…¹Ñ•Ì‘”€Ğá ¤4(€€€€€€€€€€€€€½¹ÍĞ­İ±¥­Ì€ô¹Õ´¡­Ü¹±¥­Ì¤ì4(€€€€€€€€€€€€€½¹ÍĞ­İMÁ•¹€ô¹Õ´¡­Ü¹ÍÁ•¹¤ì4(€€€€€€€€€€€€€½¹ÍĞ­İ=É‘•ÉÌ€ô¹Õ´¡­Ü¹½É‘•ÉÌ¤ì4(€€€€€€€€€€€€€½¹ÍĞµ…áAÉ½™¥Ñ…‰±•Á„€ô…µÁ½¸ü¹µ…á¥µÕµ}ÁÉ½™¥Ñ…‰±•}…‘}ÍÁ•¹ñğ5I9e}5%9}MA9ì4(4(€€€€€€€€€€€€€½¹ÍĞ•µ•É•¹åQÉ¥•È€ô€…±Œ¹•µ•É•¹å}ÑÉ¥•É•4(€€€€€€€€€€€€€€€€˜˜­İ=É‘•ÉÌ€ôôô€À4(€€€€€€€€€€€€€€€€˜˜­İ±¥­Ì€øô5I9e}5%9}1%-L4(€€€€€€€€€€€€€€€€˜˜€¡­İMÁ•¹€øô5I9e}5%9}MA9ñğ­İMÁ•¹€øôµ…áAÉ½™¥Ñ…‰±•Á„€¨€À¸Ô¤ì4(4(€€€€€€€€€€€€€¥˜€¡•µ•É•¹åQÉ¥•È€˜˜¡…Í‘Í•ÍÌ¤ì4(€€€€€€€€€€€€€€€€¼¼I•‘Õé¥È‰¥€ÄÀ”ƒŠP½¹Ñ•»Ÿ¼•µ•É•¹¥…°4(€€€€€€€€€€€€€€€½¹ÍĞ¹•İ-İ	¥€ôÉ½Õ¹È¡5…Ñ ¹µ…à¡±½‰…±5¥¹	¥°É•½¹¥±•‘-İ	¥€¨€À¸äÀ¤¤ì4(€€€€€€€€€€€€€€€½¹ÍĞÉ•Ì€ô…İ…¥ĞÕÁ‘…Ñ•-•åİ½É‘	¥‘=¹µ…é½¸¡…‘Í¹‘Á½¥¹Ğ°…‘ÍQ½­•¸„°ÁÉ½™¥±•%°­İ%°¹•İ-İ	¥¤ì4(€€€€€€€€€€€€€€€¥˜€¡É•Ì¹ÍÕ•ÍÌ¤ì4(€€€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹ÕÉÉ•¹Ñ}­•åİ½É‘}‰¥€ô¹•İ-İ	¥ì4(€€€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹•µ•É•¹å}ÑÉ¥•É•€ôÑÉÕ”ì4(€€€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹•µ•É•¹å}É•…Í½¸€ô€‘í­İ±¥­Íô±¥ÅÕ•Ì°H‘í­İMÁ•¹¹Ñ½¥á• È¥ô…ÍÑ½Ì°é•É¼½µÁÉ…Í€ì4(€€€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹ÍÑ…ÑÕÌ€ô€•µ•É•¹å}É•‘ÕÑ¥½¸œì4(€€€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹±…ÍÑ}…Ñ¥½¸€ô€•µ•É•¹å}‰¥‘}É•‘ÕÑ¥½¹|ÄÁÁĞœì4(€€€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹±…ÍÑ}…Ñ¥½¹}…Ğ€ô¹½Üì4(€€€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹…µ…é½¹}É•ÅÕ•ÍÑ}¥€ôÉ•Ì¹É•ÅÕ•ÍÑ%ì4(€€€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹½½±‘½İ¹}Õ¹Ñ¥°€ô¹•Ü…Ñ”¡…Ñ”¹¹½Ü ¤€¬!=UIM|Ğà€¨€ÌØÀÀÀÀÀ¤¹Ñ½%M=MÑÉ¥¹œ ¤ì4(€€€€€€€€€€€€€€€€€É•Á½ÉĞ¹•µ•É•¹å}É•‘ÕÑ¥½¹Ì¬¬ì4(€€€€€€€€€€€€€€€€€É•Á½ÉĞ¹‰¥‘Í}…ÁÁ±¥•‘}Ñ½}…µ…é½¸¬¬ì4(4(€€€€€€€€€€€€€€€€€€¼¼I•‘Õé¥È‘•™…Õ±Ğ‰¥‘¼ÉÕÁ¼Í”­İ½Õ¹ĞôôôÄ4(€€€€€€€€€€€€€€€€€¥˜€¡­İ½Õ¹Ğ€ôôô€Ä¤ì4(€€€€€€€€€€€€€€€€€€€½¹ÍĞ…I•Ì€ô…İ…¥ĞÕÁ‘…Ñ•‘É½ÕÁ	¥‘=¹µ…é½¸¡…‘Í¹‘Á½¥¹Ğ°…‘ÍQ½­•¸„°ÁÉ½™¥±•%°…%°¹•İ-İ	¥¤ì4(€€€€€€€€€€€€€€€€€€€¥˜€¡…I•Ì¹ÍÕ•ÍÌ¤µ•ÑÉ¥ÍUÁ‘…Ñ”¹ÕÉÉ•¹Ñ}…‘}É½ÕÁ}‘•™…Õ±Ñ}‰¥€ô¹•İ-İ	¥ì4(€€€€€€€€€€€€€€€€€ô4(4(€€€€€€€€€€€€€€€€€€¼¼I•¥ÍÑÉ…È¹„™¥±„½™¥¥…°‘”‘•¥ÏÕ•ÌÁ…É„É…ÍÑÉ•…‰¥±¥‘…‘”4(€€€€€€€€€€€€€€€€€…İ…¥Ğ‰…Í”ĞĞ¹…ÍM•ÉÙ¥•I½±”¹•¹Ñ¥Ñ¥•Ì¹=ÁÑ¥µ¥é…Ñ¥½¹•¥Í¥½¸¹É•…Ñ”¡ì4(€€€€€€€€€€€€€€€€€€€…µ…é½¹}…½Õ¹Ñ}¥è…¥°4(€€€€€€€€€€€€€€€€€€€‘•¥Í¥½¹}ÑåÁ”è€‰¥‘}¡…¹”œ°4(€€€€€€€€€€€€€€€€€€€•¹Ñ¥Ñå}ÑåÁ”è€­•åİ½Éœ°4(€€€€€€€€€€€€€€€€€€€•¹Ñ¥Ñå}¥è­İ%°4(€€€€€€€€€€€€€€€€€€€…µÁ…¥¹}¥è…µÁ…¥¹%°4(€€€€€€€€€€€€€€€€€€€­•åİ½É‘}¥è­İ%°4(€€€€€€€€€€€€€€€€€€€­•åİ½É‘}Ñ•áĞè­Ü¹­•åİ½É‘}Ñ•áĞ°4(€€€€€€€€€€€€€€€€€€€…Í¥¸è…µÁÍ¥¸°4(€€€€€€€€€€€€€€€€€€€…Ñ¥½¸è€Í•Ñ}‰¥œ°4(€€€€€€€€€€€€€€€€€€€Ù…±Õ•}‰•™½É”èÉ•½¹¥±•‘-İ	¥°4(€€€€€€€€€€€€€€€€€€€Ù…±Õ•}…™Ñ•Èè¹•İ-İ	¥°4(€€€€€€€€€€€€€€€€€€€É…Ñ¥½¹…±”èƒÂ~j =9Q;<5I9%0è€‘í­İ±¥­Íô±¥ÅÕ•Ì°H‘í­İMÁ•¹¹Ñ½¥á• È¥ô…ÍÑ½Ì°é•É¼½µÁÉ…Ì¹…ÌÁÉ¥µ•¥É…Ì€Ğá ¸	¥É•‘Õé¥‘¼€ÄÀ”‘”H‘íÉ•½¹¥±•‘-İ	¥‘ôÁ…É„H‘í¹•İ-İ	¥‘ô¹€°4(€€€€€€€€€€€€€€€€€€€ÍÑ…ÑÕÌè€•á•ÕÑ•œ°4(€€€€€€€€€€€€€€€€€€€¥‘•µÁ½Ñ•¹å}­•äè•µ•É•¹å}±…Õ¹¡ğ‘í…¥‘õğ‘í­İ%‘õğ‘í¹½Ü¹Í±¥” À°€ÄÀ¥õ€°4(€€€€€€€€€€€€€€€€€€€Í½ÕÉ•}™Õ¹Ñ¥½¸è€ÉÕ¹5…¹Õ…±…µÁ…¥¹	¥‘1¥™•å±”œ°4(€€€€€€€€€€€€€€€€€€€É•…Ñ•‘}…Ğè¹½Ü°4(€€€€€€€€€€€€€€€€€ô¤¹…Ñ   ¤€ôøíô¤ì4(€€€€€€€€€€€€€€€ô•±Í”ì4(€€€€€€€€€€€€€€€€€É•Á½ÉĞ¹‰¥‘Í}™…¥±•¬¬ì4(€€€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹ÍÑ…ÑÕÌ€ô€Á•¹‘¥¹}½¹™¥Éµ…Ñ¥½¸œì4(€€€€€€€€€€€€€€€ô4(€€€€€€€€€€€€€ô•±Í”¥˜€ …¥ÍMÑ¥±±%¸Ğá €˜˜±MÑ…ÑÕÌ€ôôô€±…Õ¹¡|Á|Ğá œ¤ì4(€€€€€€€€€€€€€€€€¼¼A…ÍÍ½Ô€Ğá ƒŠHµ½Ù•ÈÁ…É„É•Ù¥Ï¼4(€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹ÍÑ…ÑÕÌ€ô€İ…¥Ñ¥¹|Ğá¡}É•Ù¥•Üœì4(€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹¹•áÑ}É•Ù¥•İ}…Ğ€ô¹½Üì4(€€€€€€€€€€€€€ô•±Í”ì4(€€€€€€€€€€€€€€€É•Á½ÉĞ¹İ¥Ñ¡¥¹|Ğá¡}ÁÉ½Ñ•Ñ•¬¬ì4(€€€€€€€€€€€€€ô4(€€€€€€€€€€€ô4(4(€€€€€€€€€€€€¼¼ƒŠRŠR Mèİ…¥Ñ¥¹|Ğá¡}É•Ù¥•ÜƒŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠR 4(€€€€€€€€€€€€¼¼•±•…‘¼„…ÁÁ±å%¹¥Ñ¥…±	¥‘ÍQ½±±…µÁ…¥¹Ì€¡•Ù¥Ñ„Ñ¥µ•½ÕĞ¤¸4(€€€€€€€€€€€€¼¼ÅÕ¤…Á•¹…ÌÍ¥¹…±¥é…µ½ÌÅÕ”•ÍÓ„ÁÉ½¹Ñ¼Á…É„¼…©ÕÍÑ”¥¹¥¥…°¸4(€€€€€€€€€€€•±Í”¥˜€¡±MÑ…ÑÕÌ€ôôô€İ…¥Ñ¥¹|Ğá¡}É•Ù¥•Üœ¤ì4(€€€€€€€€€€€€€€¼¼;¼™…é•È¡…µ…‘…Ì‘”ÍÕ•ÍÓ¼…ÅÕ¤ƒŠP…ÁÁ±å%¹¥Ñ¥…±	¥‘ÍQ½±±…µÁ…¥¹Ì4(€€€€€€€€€€€€€€¼¼ƒ¤¡…µ…‘¼Á•±¼½ÉÅÕ•ÍÑÉ…‘½È”ÁÉ½•ÍÍ„Õµ„­•åİ½ÉÁ½ÈÙ•è½´Ñ¡É½ÑÑ±”¸4(€€€€€€€€€€€€€€¼¼Á•¹…Ì…É…¹Ñ¥ÈÅÕ”µ…¹…•µ•¹Ñ}Í½ÕÉ”•ÍÓ„µ…É…‘¼½ÉÉ•Ñ…µ•¹Ñ”¸4(€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹µ…¹…•µ•¹Ñ}Í½ÕÉ”€ô€±…Õ¹¡}±¥™•å±”œì4(€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹¹•áÑ}É•Ù¥•İ}…Ğ€ô¹½Üì€¼¼ÁÉ½¹Ñ¼Á…É„ÁÉ½•ÍÍ…È…½É„4(€€€€€€€€€€€€€É•Á½ÉĞ¹Á½ÍÑ|Ğá¡}…‘©ÕÍÑµ•¹ÑÌ¬¬ì4(€€€€€€€€€€€ô4(4(€€€€€€€€€€€€¼¼ƒŠRŠR Mèİ…¥Ñ¥¹|ÜÉ¡}É•Ù¥•Ü€¼…µ…é½¹}‰¥‘}…ÁÁ±¥•€¼…µ…é½¹}‰¥‘}±¥µ¥Ñ•ƒŠRŠR 4(€€€€€€€€€€€•±Í”¥˜€¡lİ…¥Ñ¥¹|ÜÉ¡}É•Ù¥•Üœ°€…µ…é½¹}‰¥‘}…ÁÁ±¥•œ°€…µ…é½¹}‰¥‘}±¥µ¥Ñ•œ°€Í•ÉÙ¥¹}±•…É¹¥¹œt¹¥¹±Õ‘•Ì¡±MÑ…ÑÕÌ¤¤ì(€€€€€€€€€€€€€½¹ÍĞÉ•Ù¥•ÜÜÉ¡Ğ€ô±Œ¹É•Ù¥•İ|ÜÉ¡}…Ğ€ü¹•Ü…Ñ”¡±Œ¹É•Ù¥•İ|ÜÉ¡}…Ğ¤¹•ÑQ¥µ” ¤€è€Àì4(€€€€€€€€€€€€€½¹ÍĞÉ•Ù¥•İÕ”€ô…Ñ”¹¹½Ü ¤€øôÉ•Ù¥•ÜÜÉ¡Ğì4(4(€€€€€€€€€€€€€¥˜€¡É•Ù¥•İÕ”¤ì4(€€€€€€€€€€€€€€€½¹ÍĞ­İ½Ì€ô¹Õ´¡­Ü¹…½Ì¤ì4(€€€€€€€€€€€€€€€½¹ÍĞ­İMÁ•¹€ô¹Õ´¡­Ü¹ÍÁ•¹¤ì(€€€€€€€€€€€€€€€½¹ÍĞ­İ=É‘•ÉÌ€ô¹Õ´¡­Ü¹½É‘•ÉÌ¤ì(€€€€€€€€€€€€€€€½¹ÍĞ­İ%µÁÉ•ÍÍ¥½¹Ì€ô¹Õ´¡­Ü¹¥µÁÉ•ÍÍ¥½¹Ì¤ì(€€€€€€€€€€€€€€€½¹ÍĞ­İ±¥­Ì€ô¹Õ´¡­Ü¹±¥­Ì¤ì(€€€€€€€€€€€€€€€½¹ÍĞ­İM…±•Ì€ô¹Õ´¡­Ü¹Í…±•Ì¤ì(€€€€€€€€€€€€€€€½¹ÍĞÕÉÉ•¹ÑÁÁ±¥•‘	¥€ô±Œ¹Á½ÍÑ|Ğá¡}‰¥ñğÉ•½¹¥±•‘-İ	¥ì(€€€€€€€€€€€€€€€½¹ÍĞ½½±‘½İ¹U¹Ñ¥°€ô±Œ¹½½±‘½İ¹}Õ¹Ñ¥°€ü¹•Ü…Ñ”¡±Œ¹½½±‘½İ¹}Õ¹Ñ¥°¤¹•ÑQ¥µ” ¤€è€Àì(€€€€€€€€€€€€€€€½¹ÍĞ¥¹½½±‘½İ¸€ô…Ñ”¹¹½Ü ¤€ğ½½±‘½İ¹U¹Ñ¥°ì(€€€€€€€€€€€€€€€½¹ÍĞÉ…İÙÈ€ô¹Õ´¡…µÁ½¸ü¹½¹Ù•ÉÍ¥½¹}É…Ñ•|ÌÁ€üü…µÁ½¸ü¹¡¥ÍÑ½É¥…±}ÙÈ€üüÍ•ÑÑ¥¹Ì¹½¹Ù•ÉÍ¥½¹}É…Ñ”€üü€À¸ÀÔ¤ì(€€€€€€€€€€€€€€€½¹ÍĞ½¹Í•ÉÙ…Ñ¥Ù•ÙÈ€ô5…Ñ ¹µ…à À¸ÀÀÔ°5…Ñ ¹µ¥¸ À¸ÔÀ°É…İÙÈ€ø€Ä€üÉ…İÙÈ€¼€ÄÀÀ€èÉ…İÙÈñğ€À¸ÀÔ¤¤ì(€€€€€€€€€€€€€€€½¹ÍĞÑÉ…™™¥Œ€ô…±Õ±…Ñ•QÉ…™™¥MÕ™™¥¥•¹ä¡ì(€€€€€€€€€€€€€€€€€±¥­Ìè­İ±¥­Ì°(€€€€€€€€€€€€€€€€€½¹Í•ÉÙ…Ñ¥Ù•ÙÈ°(€€€€€€€€€€€€€€€€€•Ù…±Õ…Ñ¥½¹½¹™¥‘•¹”è€À¸àÀ°(€€€€€€€€€€€€€€€ô¤ì(€€€€€€€€€€€€€€€½¹ÍĞµ…áAÉ½™¥Ñ…‰±•MÁ•¹€ô¹Õ´¡…µÁ½¸ü¹µ…á¥µÕµ}ÁÉ½™¥Ñ…‰±•}…‘}ÍÁ•¹ñğ5I9e}5%9}MA9¤ì(€€€€€€€€€€€€€€€½¹ÍĞ±½ÍÍ	Õ‘•Ğ€ô5…Ñ ¹µ…à È¸ÔÀ°5…Ñ ¹µ¥¸ ÄÔ°µ…áAÉ½™¥Ñ…‰±•MÁ•¹€¨€À¸ÈÔ¤¤ì(€€€€€€€€€€€€€€€½¹ÍĞ…±±½İ•‘MÁ•¹€ô­İM…±•Ì€ø€À€ü­İM…±•Ì€¨€¡Ñ…É•Ñ½Ì€¼€ÄÀÀ¤€è€Àì(€€€€€€€€€€€€€€€½¹ÍĞÍ•ÉÙ¥¹1•…É¹¥¹AÉ½Ñ•Ñ•€ôÍ¡½Õ±‘AÉ½Ñ•ÑM•ÉÙ¥¹5…¹Õ…°¡ì(€€€€€€€€€€€€€€€€€µ…¹Õ…°èÑÉÕ”°(€€€€€€€€€€€€€€€€€¥µÁÉ•ÍÍ¥½¹Ìè­İ%µÁÉ•ÍÍ¥½¹Ì°(€€€€€€€€€€€€€€€€€±¥­Ìè­İ±¥­Ì°(€€€€€€€€€€€€€€€€€ÍÁ•¹è­İMÁ•¹°(€€€€€€€€€€€€€€€€€½É‘•ÉÌè­İ=É‘•ÉÌ°(€€€€€€€€€€€€€€€€€½¹Í•ÉÙ…Ñ¥Ù•ÙÈ°(€€€€€€€€€€€€€€€€€•Ù…±Õ…Ñ¥½¹½¹™¥‘•¹”è€À¸àÀ°(€€€€€€€€€€€€€€€€€±½ÍÌè5…Ñ ¹µ…à À°­İMÁ•¹€´…±±½İ•‘MÁ•¹¤°(€€€€€€€€€€€€€€€€€±½ÍÍ	Õ‘•Ğ°(€€€€€€€€€€€€€€€ô¤ì(4(€€€€€€€€€€€€€€€É•Á½ÉĞ¹Á½ÍÑ|ÜÉ¡}É•Ù¥•İÌ¬¬ì4(4(€€€€€€€€€€€€€€€¥˜€¡¥¹½½±‘½İ¸¤ì(€€€€€€€€€€€€€€€€€€¼¼;¼…¥È‘ÕÉ…¹Ñ”½½±‘½İ¸(€€€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹ÍÑ…ÑÕÌ€ô€İ…¥Ñ¥¹|ÜÉ¡}É•Ù¥•Üœì(€€€€€€€€€€€€€€€ô•±Í”¥˜€¡Í•ÉÙ¥¹1•…É¹¥¹AÉ½Ñ•Ñ•¤ì(€€€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹ÍÑ…ÑÕÌ€ô€Í•ÉÙ¥¹}±•…É¹¥¹œœì(€€€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹µ…¹…•µ•¹Ñ}Í½ÕÉ”€ô€Õ¹¥™¥•‘}‘•¥Í¥½¹}•¹¥¹”œì(€€€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹¹•áÑ}É•Ù¥•İ}…Ğ€ô¹•Ü…Ñ”¡…Ñ”¹¹½Ü ¤€¬€ÈĞ€¨€ÌØÀÀÀÀÀ¤¹Ñ½%M=MÑÉ¥¹œ ¤ì(€€€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹ÑÉ…™™¥}ÍÕ™™¥¥•¹ä€ôÑÉ…™™¥Œ¹ÑÉ…™™¥}ÍÕ™™¥¥•¹äì(€€€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹ÑÉ…™™¥}É•ÅÕ¥É•‘}±¥­Ì€ôÑÉ…™™¥Œ¹É•ÅÕ¥É•‘}±¥­Ìì(€€€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹ÑÉ…™™¥}é•É½}½É‘•É}ÁÉ½‰…‰¥±¥Ñä€ôÑÉ…™™¥Œ¹é•É½}½É‘•É}ÁÉ½‰…‰¥±¥Ñäì(€€€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹±…ÍÑ}…Ñ¥½¸€ô€¡½±‘}™½É}ÑÉ…™™¥}ÍÕ™™¥¥•¹äœì(€€€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹±…ÍÑ}…Ñ¥½¹}…Ğ€ô¹½Üì(€€€€€€€€€€€€€€€€€É•Á½ÉĞ¹Í•ÉÙ¥¹}±•…É¹¥¹}ÁÉ½Ñ•Ñ•¬¬ì(€€€€€€€€€€€€€€€ô•±Í”¥˜€¡­İMÁ•¹€ğ€Äñğ­İ%µÁÉ•ÍÍ¥½¹Ì€ğ€ÄÀ¤ì(€€€€€€€€€€€€€€€€€€¼¼…‘½Ì¥¹ÍÕ™¥¥•¹Ñ•ÌƒŠP…Õ…É‘…Èµ½Ñ½È4(€€€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹ÍÑ…ÑÕÌ€ô€¹½}…µ…é½¹}ÍÕ•ÍÑ¥½¸œì4(€€€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹µ…¹…•µ•¹Ñ}Í½ÕÉ”€ô€Õ¹¥™¥•‘}‘•¥Í¥½¹}•¹¥¹”œì4(€€€€€€€€€€€€€€€€€É•Á½ÉĞ¹‘•±¥Ù•É•‘}Ñ½}•¹¥¹”¬¬ì4(€€€€€€€€€€€€€€€ô•±Í”ì4(€€€€€€€€€€€€€€€€€€¼¼¹ÑÉ•…È•ÍÓ¼…¼µ½Ñ½È…½É„4(€€€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹ÍÑ…ÑÕÌ€ô€Õ¹¥™¥•‘}•¹¥¹•}µ…¹…•µ•¹Ğœì4(€€€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹µ…¹…•µ•¹Ñ}Í½ÕÉ”€ô€Õ¹¥™¥•‘}‘•¥Í¥½¹}•¹¥¹”œì4(€€€€€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹¹•áÑ}É•Ù¥•İ}…Ğ€ô¹•Ü…Ñ”¡…Ñ”¹¹½Ü ¤€¬!=UIM|Ğà€¨€ÌØÀÀÀÀÀ¤¹Ñ½%M=MÑÉ¥¹œ ¤ì4(€€€€€€€€€€€€€€€€€É•Á½ÉĞ¹‘•±¥Ù•É•‘}Ñ½}•¹¥¹”¬¬ì4(€€€€€€€€€€€€€€€ô4(€€€€€€€€€€€€€ô4(€€€€€€€€€€€ô4(4(€€€€€€€€€€€€¼¼ƒŠRŠR MèÕ¹¥™¥•‘}•¹¥¹•}µ…¹…•µ•¹Ğ€¼ÍÑ…‰¥±¥é•ƒŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠR 4(€€€€€€€€€€€•±Í”¥˜€¡±MÑ…ÑÕÌ€ôôô€Õ¹¥™¥•‘}•¹¥¹•}µ…¹…•µ•¹Ğœ¤ì4(€€€€€€€€€€€€€€¼¼5½Ñ½È•É•¹¥„ƒŠP…Á•¹…Ì…ÑÕ…±¥é…È·¥ÑÉ¥…Ì4(€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹µ…¹…•µ•¹Ñ}Í½ÕÉ”€ô€Õ¹¥™¥•‘}‘•¥Í¥½¹}•¹¥¹”œì4(€€€€€€€€€€€€€€¼¼5…É…ÈÁËÍá¥µ„É•Ù¥Ï¼Á•É§Í‘¥„4(€€€€€€€€€€€€€µ•ÑÉ¥ÍUÁ‘…Ñ”¹¹•áÑ}É•Ù¥•İ}…Ğ€ô¹•Ü…Ñ”¡…Ñ”¹¹½Ü ¤€¬!=UIM|Ğà€¨€ÌØÀÀÀÀÀ¤¹Ñ½%M=MÑÉ¥¹œ ¤ì4(€€€€€€€€€€€ô4(4(€€€€€€€€€€€€¼¼ƒŠRŠR M…±Ù…È…ÑÕ…±¥é‡Ÿ¼‘¼±¥™•å±”ƒŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠR 4(€€€€€€€€€€€¥˜€¡±Œ¹¥¤ì4(€€€€€€€€€€€€€…İ…¥Ğ‰…Í”ĞĞ¹…ÍM•ÉÙ¥•I½±”¹•¹Ñ¥Ñ¥•Ì¹5…¹Õ…±…µÁ…¥¹	¥‘1¥™•å±”¹ÕÁ‘…Ñ”¡±Œ¹¥°µ•ÑÉ¥ÍUÁ‘…Ñ”¤¹…Ñ   ¤€ôøíô¤ì4(€€€€€€€€€€€€€É•Á½ÉĞ¹±¥™•å±•Í}ÕÁ‘…Ñ•¬¬ì4(€€€€€€€€€€€ô4(4(€€€€€€€€€€€É•Á½ÉĞ¹…Õ‘¥Ñ}É½İÌ¹ÁÕÍ ¡ì4(€€€€€€€€€€€€€…µÁ…¥¸è…µÁ…¥¸¹…µÁ…¥¹}¹…µ”ñğ…µÁ…¥¸¹¹…µ”°4(€€€€€€€€€€€€€…‘}É½ÕÀè…œ¹¹…µ”°4(€€€€€€€€€€€€€…Í¥¸è…µÁÍ¥¸°4(€€€€€€€€€€€€€­•åİ½Éè­Ü¹­•åİ½É‘}Ñ•áĞ°4(€€€€€€€€€€€€€…•} è5…Ñ ¹É½Õ¹¡…µÁ• ¤°4(€€€€€€€€€€€€€…}‘•™…Õ±Ñ}‰¥èÉ½Õ¹È¡µ•ÑÉ¥ÍUÁ‘…Ñ”¹ÕÉÉ•¹Ñ}…‘}É½ÕÁ}‘•™…Õ±Ñ}‰¥€üüÉ•½¹¥±•‘	¥¤°4(€€€€€€€€€€€€€­İ}‰¥èÉ½Õ¹È¡µ•ÑÉ¥ÍUÁ‘…Ñ”¹ÕÉÉ•¹Ñ}­•åİ½É‘}‰¥€üüÉ•½¹¥±•‘-İ	¥¤°4(€€€€€€€€€€€€€…µ…é½¹}ÍÕ•ÍÑ•èµ•ÑÉ¥ÍUÁ‘…Ñ”¹…µ…é½¹}ÍÕ•ÍÑ•‘}‰¥€üü±Œ¹…µ…é½¹}ÍÕ•ÍÑ•‘}‰¥€üü¹Õ±°°4(€€€€€€€€€€€€€…µ…é½¹}±½İ•Èèµ•ÑÉ¥ÍUÁ‘…Ñ”¹…µ…é½¹}ÍÕ•ÍÑ•‘}‰¥‘}±½İ•È€üü±Œ¹…µ…é½¹}ÍÕ•ÍÑ•‘}‰¥‘}±½İ•È€üü¹Õ±°°4(€€€€€€€€€€€€€ÍÑ…ÑÕÌèµ•ÑÉ¥ÍUÁ‘…Ñ”¹ÍÑ…ÑÕÌñğ±MÑ…ÑÕÌ°4(€€€€€€€€€€€€€…Ñ¥½¸èµ•ÑÉ¥ÍUÁ‘…Ñ”¹±…ÍÑ}…Ñ¥½¸ñğ€µ•ÑÉ¥Í}ÕÁ‘…Ñ•œ°4(€€€€€€€€€€€ô¤ì4(€€€€€€€€€ô4(4(€€€€€€€€€…İ…¥ĞÍ±••À ÔÀÀ¤ì€¼¼Q¡É½ÑÑ±”•¹ÑÉ”­•åİ½É‘ÌÁ…É„»¼Í…ÑÕÉ…ÈÉ…Ñ”±¥µ¥Ğµ…é½¸4(€€€€€€€ô4(€€€€€ô4(€€€ô4(4(€€€€¼¼ƒŠRŠR 1½œ‘”•á•×Ÿ¼ƒŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠRŠR 4(€€€½¹ÍĞÑ½‘…ä€ô¹•Ü…Ñ”¡…Ñ”¹¹½Ü ¤€´€Ì€¨€ÌØÀÀÀÀÀ¤¹Ñ½%M=MÑÉ¥¹œ ¤¹Í±¥” À°€ÄÀ¤ì4(€€€…İ…¥Ğ‰…Í”ĞĞ¹…ÍM•ÉÙ¥•I½±”¹•¹Ñ¥Ñ¥•Ì¹Må¹á•ÕÑ¥½¹1½œ¹É•…Ñ”¡ì4(€€€€€…µ…é½¹}…½Õ¹Ñ}¥è…¥°4(€€€€€½Á•É…Ñ¥½¸è€ÉÕ¹}µ…¹Õ…±}…µÁ…¥¹}‰¥‘}±¥™•å±”œ°4(€€€€€ÑÉ¥•É}ÑåÁ”è‰½‘ä¹}Í•ÉÙ¥•}É½±”€ü€…ÕÑ½µ…Ñ¥Œœ€è€µ…¹Õ…°œ°4(€€€€€ÍÑ…ÑÕÌè€ÍÕ•ÍÌœ°4(€€€€€•á•ÕÑ¥½¹}‘…Ñ”èÑ½‘…ä°4(€€€€€ÍÑ…ÉÑ•‘}…Ğè¹½Ü°4(€€€€€½µÁ±•Ñ•‘}…Ğè¹½İ%Í¼ ¤°4(€€€€€É•½É‘Í}ÁÉ½•ÍÍ•èÉ•Á½ÉĞ¹±¥™•å±•Í}É•…Ñ•€¬É•Á½ÉĞ¹±¥™•å±•Í}ÕÁ‘…Ñ•°4(€€€€€É•ÍÕ±Ñ}ÍÕµµ…Éäè)M=8¹ÍÑÉ¥¹¥™ä¡ì4(€€€€€€€…µÁ…¥¹ÌèÉ•Á½ÉĞ¹…µÁ…¥¹Í}…¹…±åé•°4(€€€€€€€…‘}É½ÕÁÌèÉ•Á½ÉĞ¹…‘}É½ÕÁÍ}™½Õ¹°4(€€€€€€€­•åİ½É‘ÌèÉ•Á½ÉĞ¹­•åİ½É‘Í}™½Õ¹°4(€€€€€€€É•…Ñ•èÉ•Á½ÉĞ¹±¥™•å±•Í}É•…Ñ•°4(€€€€€€€ÕÁ‘…Ñ•èÉ•Á½ÉĞ¹±¥™•å±•Í}ÕÁ‘…Ñ•°4(€€€€€€€‰¥‘Í}…ÁÁ±¥•èÉ•Á½ÉĞ¹‰¥‘Í}…ÁÁ±¥•‘}Ñ½}…µ…é½¸°4(€€€€€€€•µ•É•¹äèÉ•Á½ÉĞ¹•µ•É•¹å}É•‘ÕÑ¥½¹Ì°4(€€€€€€€Á½ÍÑ|Ğá èÉ•Á½ÉĞ¹Á½ÍÑ|Ğá¡}…‘©ÕÍÑµ•¹ÑÌ°4(€€€€€€€‘•±¥Ù•É•‘}Ñ½}•¹¥¹”èÉ•Á½ÉĞ¹‘•±¥Ù•É•‘}Ñ½}•¹¥¹”°(€€€€€€€İ¥Ñ¡¥¹|Ğá¡}ÁÉ½Ñ•Ñ•èÉ•Á½ÉĞ¹İ¥Ñ¡¥¹|Ğá¡}ÁÉ½Ñ•Ñ•°(€€€€€€€Í•ÉÙ¥¹}±•…É¹¥¹}ÁÉ½Ñ•Ñ•èÉ•Á½ÉĞ¹Í•ÉÙ¥¹}±•…É¹¥¹}ÁÉ½Ñ•Ñ•°(€€€€€ô¤°4(€€€ô¤¹…Ñ   ¤€ôøíô¤ì4(4(€€€É•ÑÕÉ¸I•ÍÁ½¹Í”¹©Í½¸¡ì4(€€€€€½¬èÑÉÕ”°4(€€€€€…µ…é½¹}…•ÍÌè¡…Í‘Í•ÍÌ°4(€€€€€ÍÕµµ…Éäèì4(€€€€€€€…µÁ…¥¹Í}…¹…±åé•èÉ•Á½ÉĞ¹…µÁ…¥¹Í}…¹…±åé•°4(€€€€€€€…‘}É½ÕÁÍ}™½Õ¹èÉ•Á½ÉĞ¹…‘}É½ÕÁÍ}™½Õ¹°4(€€€€€€€­•åİ½É‘Í}™½Õ¹èÉ•Á½ÉĞ¹­•åİ½É‘Í}™½Õ¹°4(€€€€€€€±¥™•å±•Í}É•…Ñ•èÉ•Á½ÉĞ¹±¥™•å±•Í}É•…Ñ•°4(€€€€€€€±¥™•å±•Í}ÕÁ‘…Ñ•èÉ•Á½ÉĞ¹±¥™•å±•Í}ÕÁ‘…Ñ•°4(€€€€€€€‰¥‘Í}…ÁÁ±¥•‘}Ñ½}…µ…é½¸èÉ•Á½ÉĞ¹‰¥‘Í}…ÁÁ±¥•‘}Ñ½}…µ…é½¸°4(€€€€€€€‰¥‘Í}™…¥±•èÉ•Á½ÉĞ¹‰¥‘Í}™…¥±•°4(€€€€€€€İ¥Ñ¡¥¹|Ğá¡}ÁÉ½Ñ•Ñ•èÉ•Á½ÉĞ¹İ¥Ñ¡¥¹|Ğá¡}ÁÉ½Ñ•Ñ•°4(€€€€€€€•µ•É•¹å}É•‘ÕÑ¥½¹ÌèÉ•Á½ÉĞ¹•µ•É•¹å}É•‘ÕÑ¥½¹Ì°4(€€€€€€€Á½ÍÑ|Ğá¡}…‘©ÕÍÑµ•¹ÑÌèÉ•Á½ÉĞ¹Á½ÍÑ|Ğá¡}…‘©ÕÍÑµ•¹ÑÌ°4(€€€€€€€Á½ÍÑ|ÜÉ¡}É•Ù¥•İÌèÉ•Á½ÉĞ¹Á½ÍÑ|ÜÉ¡}É•Ù¥•İÌ°(€€€€€€€‘•±¥Ù•É•‘}Ñ½}•¹¥¹”èÉ•Á½ÉĞ¹‘•±¥Ù•É•‘}Ñ½}•¹¥¹”°(€€€€€€€Í•ÉÙ¥¹}±•…É¹¥¹}ÁÉ½Ñ•Ñ•èÉ•Á½ÉĞ¹Í•ÉÙ¥¹}±•…É¹¥¹}ÁÉ½Ñ•Ñ•°(€€€€€ô°4(€€€€€…Õ‘¥Ñ}Ñ…‰±”èÉ•Á½ÉĞ¹…Õ‘¥Ñ}É½İÌ¹Í±¥” À°€ÔÀ¤°4(€€€ô¤ì4(4(€ô…Ñ €¡•ÉÉ½Èè…¹ä¤ì4(€€€½¹Í½±”¹•ÉÉ½È mÉÕ¹5…¹Õ…±…µÁ…¥¹	¥‘1¥™•å±•tœ°•ÉÉ½È¹µ•ÍÍ…”¤ì4(€€€É•ÑÕÉ¸I•ÍÁ½¹Í”¹©Í½¸¡ì½¬è™…±Í”°•ÉÉ½Èè•ÉÉ½È¹µ•ÍÍ…”ô°ìÍÑ…ÑÕÌè€ÔÀÀô¤ì4(€ô4)ô¤ì(