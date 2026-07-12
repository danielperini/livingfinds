/**
 * runManualCampaignBidLifecycle
 *
 * Gerencia o ciclo de vida de bids para campanhas manuais SP:
 *
 * Fase 0 (criação): bid inicial R$0,50 — default bid do grupo e keyword bid
 * Fase 1 (0-48h): monitoramento + contenção emergencial
 * Fase 2 (48h): consulta sugestão Amazon → aplica menor valor seguro
 * Fase 3 (72h): reavaliação pós-ajuste
 * Fase 4 (+): entrega ao runUnifiedDecisionEngine
 *
 * Nunca altera budget de campanha. Distingue:
 *   - campaign_budget (orçamento diário)
 *   - ad_group_default_bid (lance padrão do grupo)
 *   - keyword_bid (lance individual)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const INITIAL_BID = 0.50;
const HOURS_48 = 48;
const HOURS_72 = 72;
// Contenção emergencial: >10 cliques + gasto >= R$12 + zero compras
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
  const region = account.region || Deno.env.get('ADS_REGION') || 'na';
  return { na: 'https://advertising-api.amazon.com', eu: 'https://advertising-api-eu.amazon.com', fe: 'https://advertising-api-fe.amazon.com' }[region] || 'https://advertising-api.amazon.com';
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

// Verificar sugestão de bid para uma keyword (bid recommendations)
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
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    // ── Resolver conta ──────────────────────────────────────────────────────
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter(
      { status: 'connected' }, '-updated_date', 1
    ).catch(() => []);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });
    const aid = account.id;
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';

    // ── Carregar configurações de performance (meta ACoS, safe_max_cpc) ────
    const perfSettings = await base44.asServiceRole.entities.PerformanceSettings.filter(
      { amazon_account_id: aid }, '-updated_at', 1
    ).catch(() => []);
    const settings = perfSettings[0] || {};
    const globalMaxBid = num(settings.max_bid || 5.0);
    const globalMinBid = num(settings.min_bid || 0.40);
    const globalMaxCpc = num(settings.max_cpc || 0);

    // ── Carregar dados ─────────────────────────────────────────────────────
    const [campaigns, adGroups, keywords, productEconomics, lifecycles] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 300).catch(() => []),
      base44.asServiceRole.entities.AdGroup.filter({ amazon_account_id: aid }, null, 500).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, null, 1000).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: aid }, null, 200).catch(() => []),
      base44.asServiceRole.entities.ManualCampaignBidLifecycle.filter({ amazon_account_id: aid }, null, 1000).catch(() => []),
    ]);

    // ── Índices ────────────────────────────────────────────────────────────
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

    // Mapear keywords por ad_group_id E por campaign_id (fallback quando ag não sincronizado)
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

    // Índice de lifecycles existentes: campaign_id + ad_group_id + keyword_id
    const lifecycleKey = (cid: string, agid: string, kwid: string) => `${cid}::${agid}::${kwid}`;
    const existingLC: Record<string, any> = {};
    for (const lc of lifecycles) {
      const k = lifecycleKey(lc.campaign_id, lc.ad_group_id, lc.keyword_id);
      existingLC[k] = lc;
    }

    // ── Obter token Amazon (uma vez só) ──────────────────────────────────
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
      audit_rows: [] as any[],
    };

    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    // ── Processar cada campanha manual ─────────────────────────────────────
    for (const campaign of manualCampaigns) {
      const campaignId = campaign.campaign_id || campaign.amazon_campaign_id || '';
      if (!campaignId) continue;

      const campAgeH = ageHours(campaign.created_at || campaign.created_date);
      const campAsin = campaign.asin || '';
      const campEcon = econByAsin[campAsin] || null;
      const safeMaxCpc = campEcon?.safe_max_cpc || globalMaxCpc || 0;
      const targetAcos = campEcon?.target_acos || num(settings.target_acos) || 0;
      const targetAcosSource = campEcon ? 'product_economics' : settings.target_acos ? 'performance_settings' : 'none';

      // Ad groups desta campanha
      // Se não houver ad groups sincronizados, processar as keywords diretamente pela campanha
      // criando um grupo sintético com os dados disponíveis nas keywords
      const groups = agByCampaignId[campaignId] || [];

      // Verificar se há keywords diretas para esta campanha (ad groups não sincronizados)
      const kwsForCampaign = kwByCampaignId[campaignId] || [];
      if (groups.length === 0 && kwsForCampaign.length > 0) {
        // Agrupar keywords pelo ad_group_id para simular os grupos
        const syntheticGroups: Record<string, { agId: string; kws: any[] }> = {};
        for (const kw of kwsForCampaign) {
          const agId = kw.ad_group_id || '';
          if (!syntheticGroups[agId]) syntheticGroups[agId] = { agId, kws: [] };
          syntheticGroups[agId].kws.push(kw);
        }
        for (const sg of Object.values(syntheticGroups)) {
          // Criar grupo sintético
          groups.push({
            ad_group_id: sg.agId,
            campaign_id: campaignId,
            name: `AG | EXACT | ${campAsin}`,
            default_bid: INITIAL_BID,
            state: 'enabled',
            _synthetic: true,
            _kws: sg.kws,
          });
        }
      }

      report.ad_groups_found += groups.length;

      for (const ag of groups) {
        const agId = ag.ad_group_id || ag.amazon_ad_group_id || '';
        if (!agId) continue;

        // Buscar keywords: grupo sintético já tem as keywords; senão buscar por ad_group_id
        const syntheticKws: any[] = (ag as any)._synthetic ? ((ag as any)._kws || []) : [];
        const groupKwsByAg = syntheticKws.length > 0 ? syntheticKws : (kwByAdGroupId[agId] || []);
        const groupKws = groupKwsByAg.filter((k: any) => {
          const mt = (k.match_type || '').toLowerCase();
          return mt === 'exact' || mt === 'phrase' || mt === 'broad';
        });
        report.keywords_found += groupKws.length;

        const agDefaultBid = num(ag.default_bid || INITIAL_BID);
        const kwCount = groupKws.length;

        // ── Verificar reconciliação real com Amazon ────────────────────
        let amazonAGBid: number | null = null;
        if (hasAdsAccess) {
          const agData = await fetchAdGroupFromAmazon(adsEndpoint, adsToken!, profileId, agId);
          amazonAGBid = agData.defaultBid;
          // Reconciliar divergência local
          if (amazonAGBid !== null && Math.abs(amazonAGBid - agDefaultBid) > 0.01) {
            await base44.asServiceRole.entities.AdGroup.update(ag.id, {
              default_bid: amazonAGBid,
              updated_at: now,
            }).catch(() => {});
          }
        }
        const reconciledAGBid = amazonAGBid ?? agDefaultBid;

        for (const kw of groupKws) {
          const kwId = kw.keyword_id || kw.amazon_keyword_id || '';
          if (!kwId) continue;

          const lcKey = lifecycleKey(campaignId, agId, kwId);
          const existLC = existingLC[lcKey];

          const kwBid = num(kw.bid || kw.current_bid || INITIAL_BID);

          // ── Verificar bid real da keyword na Amazon ──────────────────
          let amazonKwBid: number | null = null;
          if (hasAdsAccess) {
            const kwData = await fetchKeywordFromAmazon(adsEndpoint, adsToken!, profileId, kwId);
            amazonKwBid = kwData.bid;
            // Reconciliar
            if (amazonKwBid !== null && Math.abs(amazonKwBid - kwBid) > 0.01) {
              await base44.asServiceRole.entities.Keyword.update(kw.id, {
                bid: amazonKwBid,
                current_bid: amazonKwBid,
                updated_at: now,
              }).catch(() => {});
            }
          }
          const reconciledKwBid = amazonKwBid ?? kwBid;

          // ── CRIAR lifecycle se não existe ────────────────────────────
          if (!existLC) {
            const first48hEndsAt = new Date(
              new Date(campaign.created_at || campaign.created_date || now).getTime() + HOURS_48 * 3600000
            ).toISOString();
            const review72hAt = new Date(
              new Date(campaign.created_at || campaign.created_date || now).getTime() + HOURS_72 * 3600000
            ).toISOString();

            // Aplicar bid inicial R$0,50 se ainda não aplicado
            // Só aplica se a campanha é nova (<1h) ou o bid estiver acima do inicial sem justificativa
            const isVeryNew = campAgeH < 2;
            let kwBidToSet = reconciledKwBid;
            let agBidToSet = reconciledAGBid;
            let bidApplied = false;
            let requestId = '';

            if (isVeryNew && hasAdsAccess) {
              // Campanha nova: aplicar R$0,50 se ainda não está correto
              if (Math.abs(reconciledKwBid - INITIAL_BID) > 0.01) {
                const kwRes = await updateKeywordBidOnAmazon(adsEndpoint, adsToken!, profileId, kwId, INITIAL_BID);
                requestId = kwRes.requestId;
                if (kwRes.success) {
                  kwBidToSet = INITIAL_BID;
                  bidApplied = true;
                  report.bids_applied_to_amazon++;
                } else {
                  report.bids_failed++;
                }
              }
              if (Math.abs(reconciledAGBid - INITIAL_BID) > 0.01 && kwCount === 1) {
                // Grupo com 1 keyword: alinhar default bid também
                const agRes = await updateAdGroupBidOnAmazon(adsEndpoint, adsToken!, profileId, agId, INITIAL_BID);
                if (agRes.success) agBidToSet = INITIAL_BID;
              }
            }

            const iKey = `lifecycle_init|${aid}|${campaignId}|${agId}|${kwId}`;
            const newLC = {
              amazon_account_id: aid,
              campaign_id: campaignId,
              ad_group_id: agId,
              keyword_id: kwId,
              asin: campAsin,
              sku: kw.sku || '',
              keyword_text: kw.keyword_text || '',
              match_type: kw.match_type || 'exact',
              campaign_name: campaign.campaign_name || campaign.name || '',
              ad_group_name: ag.name || ag.ad_group_name || '',
              campaign_created_at: campaign.created_at || campaign.created_date || now,
              initial_bid: INITIAL_BID,
              ad_group_initial_bid: agBidToSet,
              keyword_initial_bid: kwBidToSet,
              current_ad_group_default_bid: agBidToSet,
              current_keyword_bid: kwBidToSet,
              amazon_confirmed_at: bidApplied ? now : null,
              amazon_request_id: requestId,
              ad_group_keywords_count: kwCount,
              keyword_has_individual_bid: kwBid > 0,
              management_source: 'launch_lifecycle',
              status: campAgeH < HOURS_48 ? 'launch_0_48h' : 'waiting_48h_review',
              first_48h_ends_at: first48hEndsAt,
              review_72h_at: review72hAt,
              next_review_at: campAgeH < HOURS_48 ? first48hEndsAt : now,
              target_acos: targetAcos,
              target_acos_source: targetAcosSource,
              current_acos: num(kw.acos),
              current_spend: num(kw.spend),
              current_sales: num(kw.sales),
              current_orders: num(kw.orders),
              impressions: num(kw.impressions),
              clicks: num(kw.clicks),
              idempotency_key: iKey,
              last_action: bidApplied ? 'initial_bid_applied' : 'lifecycle_registered',
              last_action_at: now,
              created_at: now,
              updated_at: now,
            };

            await base44.asServiceRole.entities.ManualCampaignBidLifecycle.create(newLC).catch(() => {});
            existingLC[lcKey] = newLC;
            report.lifecycles_created++;

            report.audit_rows.push({
              campaign: campaign.campaign_name || campaign.name,
              ad_group: ag.name,
              asin: campAsin,
              keyword: kw.keyword_text,
              age_h: Math.round(campAgeH),
              ag_default_bid: round2(agBidToSet),
              kw_bid: round2(kwBidToSet),
              amazon_suggested: null,
              status: newLC.status,
              action: bidApplied ? 'initial_bid_applied' : 'lifecycle_registered',
            });

          } else {
            // ── Processar lifecycle existente ────────────────────────────
            const lc = existLC;
            const lcStatus = lc.status;

            // Atualizar métricas do banco
            const metricsUpdate: any = {
              current_ad_group_default_bid: reconciledAGBid,
              current_keyword_bid: reconciledKwBid,
              current_acos: num(kw.acos),
              current_spend: num(kw.spend),
              current_sales: num(kw.sales),
              current_orders: num(kw.orders),
              impressions: num(kw.impressions),
              clicks: num(kw.clicks),
              updated_at: now,
            };

            // ── FASE: within_48h ─────────────────────────────────────────
            if (lcStatus === 'launch_0_48h') {
              const isStillIn48h = campAgeH < HOURS_48;

              // Verificar risco emergencial (exceção permitida antes de 48h)
              const kwClicks = num(kw.clicks);
              const kwSpend = num(kw.spend);
              const kwOrders = num(kw.orders);
              const maxProfitableCpa = campEcon?.maximum_profitable_ad_spend || EMERGENCY_MIN_SPEND;

              const emergencyTrigger = !lc.emergency_triggered
                && kwOrders === 0
                && kwClicks >= EMERGENCY_MIN_CLICKS
                && (kwSpend >= EMERGENCY_MIN_SPEND || kwSpend >= maxProfitableCpa * 0.5);

              if (emergencyTrigger && hasAdsAccess) {
                // Reduzir bid 10% — contenção emergencial
                const newKwBid = round2(Math.max(globalMinBid, reconciledKwBid * 0.90));
                const res = await updateKeywordBidOnAmazon(adsEndpoint, adsToken!, profileId, kwId, newKwBid);
                if (res.success) {
                  metricsUpdate.current_keyword_bid = newKwBid;
                  metricsUpdate.emergency_triggered = true;
                  metricsUpdate.emergency_reason = `${kwClicks} cliques, R$${kwSpend.toFixed(2)} gastos, zero compras`;
                  metricsUpdate.status = 'emergency_reduction';
                  metricsUpdate.last_action = 'emergency_bid_reduction_10pct';
                  metricsUpdate.last_action_at = now;
                  metricsUpdate.amazon_request_id = res.requestId;
                  metricsUpdate.cooldown_until = new Date(Date.now() + HOURS_48 * 3600000).toISOString();
                  report.emergency_reductions++;
                  report.bids_applied_to_amazon++;

                  // Reduzir default bid do grupo se kwCount===1
                  if (kwCount === 1) {
                    const agRes = await updateAdGroupBidOnAmazon(adsEndpoint, adsToken!, profileId, agId, newKwBid);
                    if (agRes.success) metricsUpdate.current_ad_group_default_bid = newKwBid;
                  }

                  // Registrar na fila oficial de decisões para rastreabilidade
                  await base44.asServiceRole.entities.OptimizationDecision.create({
                    amazon_account_id: aid,
                    decision_type: 'bid_change',
                    entity_type: 'keyword',
                    entity_id: kwId,
                    campaign_id: campaignId,
                    keyword_id: kwId,
                    keyword_text: kw.keyword_text,
                    asin: campAsin,
                    action: 'set_bid',
                    value_before: reconciledKwBid,
                    value_after: newKwBid,
                    rationale: `🚨 CONTENÇÃO EMERGENCIAL: ${kwClicks} cliques, R$${kwSpend.toFixed(2)} gastos, zero compras nas primeiras 48h. Bid reduzido 10% de R$${reconciledKwBid} para R$${newKwBid}.`,
                    status: 'executed',
                    idempotency_key: `emergency_launch|${aid}|${kwId}|${now.slice(0, 10)}`,
                    source_function: 'runManualCampaignBidLifecycle',
                    created_at: now,
                  }).catch(() => {});
                } else {
                  report.bids_failed++;
                  metricsUpdate.status = 'pending_confirmation';
                }
              } else if (!isStillIn48h && lcStatus === 'launch_0_48h') {
                // Passou 48h → mover para revisão
                metricsUpdate.status = 'waiting_48h_review';
                metricsUpdate.next_review_at = now;
              } else {
                report.within_48h_protected++;
              }
            }

            // ── FASE: waiting_48h_review ─────────────────────────────────
            else if (lcStatus === 'waiting_48h_review') {
              // Consultar sugestão Amazon
              let suggestion = { suggested: null as number | null, lower: null as number | null, upper: null as number | null, valid: false };
              if (hasAdsAccess) {
                suggestion = await fetchKeywordBidSuggestion(
                  adsEndpoint, adsToken!, profileId,
                  kwId, agId, campaignId
                );
                await sleep(300); // Throttle para evitar rate limit
              }

              metricsUpdate.amazon_suggested_bid = suggestion.suggested;
              metricsUpdate.amazon_suggested_bid_lower = suggestion.lower;
              metricsUpdate.amazon_suggested_bid_upper = suggestion.upper;
              metricsUpdate.amazon_suggestion_valid = suggestion.valid;
              metricsUpdate.amazon_suggestion_fetched_at = now;

              if (suggestion.valid && suggestion.suggested !== null) {
                // Calcular bid seguro:
                // post_48h_bid = min(amazon_lower_range, safe_max_cpc, configured_max_cpc)
                const useLower = suggestion.lower ?? suggestion.suggested;
                const limits = [useLower];
                if (safeMaxCpc > 0) limits.push(safeMaxCpc);
                if (globalMaxCpc > 0) limits.push(globalMaxCpc);
                if (globalMaxBid > 0) limits.push(globalMaxBid);
                const effectiveBid = round2(Math.min(...limits));
                const wasLimited = effectiveBid < useLower;
                const isSameAsCurrent = Math.abs(effectiveBid - reconciledKwBid) < 0.01;

                if (!isSameAsCurrent && hasAdsAccess && effectiveBid >= globalMinBid) {
                  // Aplicar bid na keyword
                  const kwRes = await updateKeywordBidOnAmazon(adsEndpoint, adsToken!, profileId, kwId, effectiveBid);
                  if (kwRes.success) {
                    metricsUpdate.post_48h_bid = effectiveBid;
                    metricsUpdate.post_48h_bid_source = wasLimited ? 'safe_max_cpc_limited' : 'amazon_lower_range';
                    metricsUpdate.amazon_suggestion_limited_by_guardrail = wasLimited;
                    metricsUpdate.post_48h_adjusted_at = now;
                    metricsUpdate.current_keyword_bid = effectiveBid;
                    metricsUpdate.amazon_confirmed_at = now;
                    metricsUpdate.amazon_request_id = kwRes.requestId;
                    metricsUpdate.status = wasLimited ? 'amazon_bid_limited' : 'amazon_bid_applied';
                    metricsUpdate.last_action = `post_48h_bid_${wasLimited ? 'limited' : 'applied'}_R$${effectiveBid}`;
                    metricsUpdate.last_action_at = now;
                    metricsUpdate.review_72h_at = new Date(Date.now() + HOURS_48 * 3600000).toISOString();
                    metricsUpdate.next_review_at = metricsUpdate.review_72h_at;
                    metricsUpdate.management_source = 'launch_lifecycle'; // ainda não entregou ao motor

                    // Alinhar default bid do grupo SE grupo tem 1 keyword
                    if (kwCount === 1) {
                      const agRes = await updateAdGroupBidOnAmazon(adsEndpoint, adsToken!, profileId, agId, effectiveBid);
                      if (agRes.success) metricsUpdate.current_ad_group_default_bid = effectiveBid;
                    }

                    // Registrar na fila de decisões
                    await base44.asServiceRole.entities.OptimizationDecision.create({
                      amazon_account_id: aid,
                      decision_type: 'bid_change',
                      entity_type: 'keyword',
                      entity_id: kwId,
                      campaign_id: campaignId,
                      keyword_id: kwId,
                      keyword_text: kw.keyword_text,
                      asin: campAsin,
                      action: 'set_bid',
                      value_before: reconciledKwBid,
                      value_after: effectiveBid,
                      rationale: `⏱️ AJUSTE 48H: Sugestão Amazon R$${suggestion.suggested} (faixa R$${suggestion.lower}–R$${suggestion.upper}). ${wasLimited ? `Limitado por guardrail: safe_max_cpc R$${safeMaxCpc}.` : `Menor faixa R$${useLower} aplicada.`} Bid anterior: R$${reconciledKwBid}.`,
                      status: 'executed',
                      idempotency_key: `post_48h_bid|${aid}|${kwId}|${now.slice(0, 13)}`,
                      source_function: 'runManualCampaignBidLifecycle',
                      created_at: now,
                    }).catch(() => {});

                    report.post_48h_adjustments++;
                    report.bids_applied_to_amazon++;
                  } else {
                    metricsUpdate.status = 'pending_confirmation';
                    report.bids_failed++;
                  }
                } else {
                  // Bid já está no valor correto ou sem acesso à API
                  metricsUpdate.post_48h_bid = effectiveBid;
                  metricsUpdate.post_48h_bid_source = wasLimited ? 'safe_max_cpc_limited' : 'amazon_lower_range';
                  metricsUpdate.status = wasLimited ? 'amazon_bid_limited' : 'amazon_bid_applied';
                  metricsUpdate.post_48h_adjusted_at = now;
                  metricsUpdate.review_72h_at = new Date(Date.now() + HOURS_48 * 3600000).toISOString();
                  metricsUpdate.next_review_at = metricsUpdate.review_72h_at;
                }
              } else {
                // Sem sugestão válida → entregar ao motor
                metricsUpdate.post_48h_bid_source = 'no_suggestion';
                metricsUpdate.status = 'no_amazon_suggestion';
                metricsUpdate.management_source = 'unified_decision_engine';
                metricsUpdate.review_72h_at = new Date(Date.now() + HOURS_48 * 3600000).toISOString();
                metricsUpdate.next_review_at = metricsUpdate.review_72h_at;
              }
            }

            // ── FASE: waiting_72h_review / amazon_bid_applied / amazon_bid_limited ──
            else if (['waiting_72h_review', 'amazon_bid_applied', 'amazon_bid_limited'].includes(lcStatus)) {
              const review72hAt = lc.review_72h_at ? new Date(lc.review_72h_at).getTime() : 0;
              const reviewDue = Date.now() >= review72hAt;

              if (reviewDue) {
                const kwAcos = num(kw.acos);
                const kwSpend = num(kw.spend);
                const kwOrders = num(kw.orders);
                const kwImpressions = num(kw.impressions);
                const currentAppliedBid = lc.post_48h_bid || reconciledKwBid;
                const cooldownUntil = lc.cooldown_until ? new Date(lc.cooldown_until).getTime() : 0;
                const inCooldown = Date.now() < cooldownUntil;

                report.post_72h_reviews++;

                if (inCooldown) {
                  // Não agir durante cooldown
                  metricsUpdate.status = 'waiting_72h_review';
                } else if (kwSpend < 1 || kwImpressions < 10) {
                  // Dados insuficientes — aguardar motor
                  metricsUpdate.status = 'no_amazon_suggestion';
                  metricsUpdate.management_source = 'unified_decision_engine';
                  report.delivered_to_engine++;
                } else {
                  // Entregar gestão ao motor agora
                  metricsUpdate.status = 'unified_engine_management';
                  metricsUpdate.management_source = 'unified_decision_engine';
                  metricsUpdate.next_review_at = new Date(Date.now() + HOURS_48 * 3600000).toISOString();
                  report.delivered_to_engine++;
                }
              }
            }

            // ── FASE: unified_engine_management / stabilized ─────────────
            else if (lcStatus === 'unified_engine_management') {
              // Motor gerencia — apenas atualizar métricas
              metricsUpdate.management_source = 'unified_decision_engine';
              // Marcar próxima revisão periódica
              metricsUpdate.next_review_at = new Date(Date.now() + HOURS_48 * 3600000).toISOString();
            }

            // ── Salvar atualização do lifecycle ────────────────────────────
            if (lc.id) {
              await base44.asServiceRole.entities.ManualCampaignBidLifecycle.update(lc.id, metricsUpdate).catch(() => {});
              report.lifecycles_updated++;
            }

            report.audit_rows.push({
              campaign: campaign.campaign_name || campaign.name,
              ad_group: ag.name,
              asin: campAsin,
              keyword: kw.keyword_text,
              age_h: Math.round(campAgeH),
              ag_default_bid: round2(metricsUpdate.current_ad_group_default_bid ?? reconciledAGBid),
              kw_bid: round2(metricsUpdate.current_keyword_bid ?? reconciledKwBid),
              amazon_suggested: metricsUpdate.amazon_suggested_bid ?? lc.amazon_suggested_bid ?? null,
              amazon_lower: metricsUpdate.amazon_suggested_bid_lower ?? lc.amazon_suggested_bid_lower ?? null,
              status: metricsUpdate.status || lcStatus,
              action: metricsUpdate.last_action || 'metrics_updated',
            });
          }

          await sleep(100); // Throttle entre keywords para não saturar rate limit
        }
      }
    }

    // ── Log de execução ─────────────────────────────────────────────────────
    const today = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'run_manual_campaign_bid_lifecycle',
      trigger_type: body._service_role ? 'automatic' : 'manual',
      status: 'success',
      execution_date: today,
      started_at: now,
      completed_at: nowIso(),
      records_processed: report.lifecycles_created + report.lifecycles_updated,
      result_summary: JSON.stringify({
        campaigns: report.campaigns_analyzed,
        ad_groups: report.ad_groups_found,
        keywords: report.keywords_found,
        created: report.lifecycles_created,
        updated: report.lifecycles_updated,
        bids_applied: report.bids_applied_to_amazon,
        emergency: report.emergency_reductions,
        post_48h: report.post_48h_adjustments,
        delivered_to_engine: report.delivered_to_engine,
        within_48h_protected: report.within_48h_protected,
      }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      amazon_access: hasAdsAccess,
      summary: {
        campaigns_analyzed: report.campaigns_analyzed,
        ad_groups_found: report.ad_groups_found,
        keywords_found: report.keywords_found,
        lifecycles_created: report.lifecycles_created,
        lifecycles_updated: report.lifecycles_updated,
        bids_applied_to_amazon: report.bids_applied_to_amazon,
        bids_failed: report.bids_failed,
        within_48h_protected: report.within_48h_protected,
        emergency_reductions: report.emergency_reductions,
        post_48h_adjustments: report.post_48h_adjustments,
        post_72h_reviews: report.post_72h_reviews,
        delivered_to_engine: report.delivered_to_engine,
      },
      audit_table: report.audit_rows.slice(0, 50),
    });

  } catch (error: any) {
    console.error('[runManualCampaignBidLifecycle]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});