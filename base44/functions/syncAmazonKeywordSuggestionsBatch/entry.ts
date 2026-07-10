/**
 * syncAmazonKeywordSuggestionsBatch
 *
 * Busca sugestões de keywords da Amazon Ads API em LOTE
 * para todos os produtos elegíveis:
 * - Ativos com estoque (in_stock ou low_stock)
 * - Novos produtos (is_new_asin = true)
 * - Produtos com estoque recém recebido (previous_inventory_status = out_of_stock e fba_inventory > 0)
 *
 * Processa em sequência com delay entre ASINs para evitar rate limit.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function getAdsBaseUrl(region: string) {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function getAdsToken(refreshToken: string, clientId: string, clientSecret: string) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token refresh failed');
  return data.access_token as string;
}

function normalizeKeyword(kw: string): string {
  return (kw || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function extractRecommendations(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (data?.keywordRecommendations && Array.isArray(data.keywordRecommendations)) return data.keywordRecommendations;
  if (data?.recommendations && Array.isArray(data.recommendations)) return data.recommendations;
  if (data?.suggestedKeywords && Array.isArray(data.suggestedKeywords)) return data.suggestedKeywords;
  if (data?.keywords && Array.isArray(data.keywords)) return data.keywords;
  if (data?.keywordsByAsin) {
    const all: any[] = [];
    for (const v of Object.values(data.keywordsByAsin) as any[]) {
      if (Array.isArray(v)) all.push(...v);
      else if (v?.keywords) all.push(...v.keywords);
    }
    return all;
  }
  return [];
}

function extractKeywordText(rec: any): string {
  return rec?.keyword || rec?.keywordText || rec?.recommendedKeyword || rec?.value || rec?.keyword_text || '';
}

function extractBid(rec: any): number | null {
  const bid = rec?.suggestedBid?.suggested ?? rec?.suggestedBid?.median ?? rec?.bid ?? rec?.suggestedCpcBid ?? null;
  return bid != null ? Number(bid) : null;
}

async function fetchWithRetry(url: string, opts: RequestInit, maxRetries = 2, delayMs = 4000): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, opts);
    if (res.status !== 429) return res;
    if (attempt < maxRetries) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
  }
  return fetch(url, opts);
}

async function fetchSuggestionsForAsin(
  asin: string,
  authHeaders: Record<string, string>,
  baseUrl: string,
  matchTypes: string[],
  maxSuggestions: number
): Promise<any[]> {
  let recommendations: any[] = [];

  // Endpoint primário: v4
  try {
    const res = await fetchWithRetry(
      `${baseUrl}/sp/targets/keywords/recommendations`,
      {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/vnd.spkeywordsrecommendation.v4+json',
          'Accept': 'application/vnd.spkeywordsrecommendation.v4+json',
        },
        body: JSON.stringify({
          asins: [asin],
          maxRecommendations: maxSuggestions,
          filterOptions: { keywordMatchTypeFilter: matchTypes },
        }),
      },
      3,
      4000
    );
    if (res.ok) {
      const data = await res.json();
      recommendations = extractRecommendations(data);
    }
  } catch {}

  // Fallback: v2
  if (recommendations.length === 0) {
    try {
      const res2 = await fetchWithRetry(
        `${baseUrl}/v2/sp/asins/suggested/keywords`,
        {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ asins: [asin], maxNumSuggestions: maxSuggestions }),
        },
        2,
        3000
      );
      if (res2.ok) {
        const d2 = await res2.json();
        recommendations = extractRecommendations(d2);
      }
    } catch {}
  }

  return recommendations;
}

Deno.serve(async (req) => {
  const now = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const {
      amazon_account_id,
      max_suggestions_per_asin = 50,
      match_types = ['EXACT', 'PHRASE', 'BROAD'],
      delay_between_asins_ms = 1200,
      max_asins = 100,
    } = body;

    // Resolver conta
    let account: any = null;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id });
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' });

    const aid = account.id;
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
    const region = account.region || Deno.env.get('ADS_REGION') || 'NA';
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';
    const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
    const baseUrl = getAdsBaseUrl(region);

    if (!profileId) return Response.json({ ok: false, error: 'Ads Profile ID não configurado' });
    if (!clientId || !clientSecret) return Response.json({ ok: false, error: 'Credenciais ADS não configuradas' });
    if (!refreshToken) return Response.json({ ok: false, error: 'Refresh token não configurado' });

    // Buscar produtos elegíveis
    const allProducts = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id: aid, status: 'active' },
      '-created_date',
      500
    );

    // Filtro: com estoque, novos, ou recém reabastecidos
    const eligibleProducts = allProducts.filter((p: any) => {
      const hasStock = p.inventory_status === 'in_stock' || p.inventory_status === 'low_stock';
      const isNew = p.is_new_asin === true;
      const isRestocked = p.fba_inventory > 0 && p.previous_inventory_status === 'out_of_stock';
      return hasStock || isNew || isRestocked;
    });

    // Verificar quais já têm sugestões recentes (última semana)
    const existingSuggestionsAll = await base44.asServiceRole.entities.KeywordSuggestion.filter(
      { amazon_account_id: aid },
      '-synced_at',
      1000
    ).catch(() => []);

    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 3600000).toISOString();
    const asinsWithRecentSync = new Set(
      existingSuggestionsAll
        .filter((s: any) => s.synced_at && s.synced_at > oneWeekAgo)
        .map((s: any) => s.asin)
    );

    // Priorizar ASINs sem sugestões, depois com sugestões antigas
    const withoutSuggestions = eligibleProducts.filter((p: any) => !asinsWithRecentSync.has(p.asin));
    const withOldSuggestions = eligibleProducts.filter((p: any) => asinsWithRecentSync.has(p.asin));
    const orderedProducts = [...withoutSuggestions, ...withOldSuggestions].slice(0, max_asins);

    if (orderedProducts.length === 0) {
      return Response.json({
        ok: true,
        message: 'Nenhum produto elegível encontrado',
        eligible_count: 0,
        total_created: 0,
        total_skipped: 0,
        results: [],
      });
    }

    // Token único para todos os ASINs
    const token = await getAdsToken(refreshToken, clientId, clientSecret);
    const authHeaders = {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': String(profileId),
    };

    // Índice global de sugestões existentes para deduplicação
    const globalExistingIndex = new Set(
      existingSuggestionsAll.map((s: any) =>
        `${normalizeKeyword(s.keyword)}|${(s.match_type || '').toUpperCase()}|${s.asin}`
      )
    );

    const results: any[] = [];
    let totalCreated = 0;
    let totalSkipped = 0;

    for (const product of orderedProducts) {
      const asin = product.asin;
      if (!asin) continue;

      let asinCreated = 0;
      let asinSkipped = 0;
      let asinError: string | null = null;

      try {
        const recommendations = await fetchSuggestionsForAsin(
          asin, authHeaders, baseUrl, match_types, max_suggestions_per_asin
        );

        if (recommendations.length === 0) {
          asinError = 'Sem recomendações retornadas';
        } else {
          const toCreate: any[] = [];

          for (const rec of recommendations) {
            const keywordText = extractKeywordText(rec);
            if (!keywordText) continue;

            const recMatchType = (rec.matchType || rec.match_type || '').toUpperCase();
            const matchTypesToUse = recMatchType && match_types.includes(recMatchType)
              ? [recMatchType]
              : match_types;

            for (const matchType of matchTypesToUse) {
              const normalized = normalizeKeyword(keywordText);
              if (!normalized || normalized.length < 2) continue;

              const dedupKey = `${normalized}|${matchType}|${asin}`;
              if (globalExistingIndex.has(dedupKey)) { asinSkipped++; continue; }
              globalExistingIndex.add(dedupKey);

              const bid = extractBid(rec);
              const bidMin = rec.suggestedBid?.rangeStart ?? rec.suggestedBid?.minimum ?? null;
              const bidMax = rec.suggestedBid?.rangeEnd ?? rec.suggestedBid?.maximum ?? null;

              toCreate.push({
                amazon_account_id: aid,
                asin,
                source_asin: asin,
                source_asin_type: 'own',
                keyword: keywordText,
                normalized_keyword: normalized,
                match_type: matchType,
                source: 'AMAZON_ADS_SUGGESTED_KEYWORD',
                amazon_suggested_bid: bid,
                amazon_suggested_bid_min: bidMin != null ? Number(bidMin) : null,
                amazon_suggested_bid_max: bidMax != null ? Number(bidMax) : null,
                amazon_relevance_score: rec.rankingScore || rec.score || rec.relevanceScore || 0,
                amazon_impression_estimate: rec.impressions ?? rec.estimatedImpressions ?? null,
                amazon_click_estimate: rec.clicks ?? rec.estimatedClicks ?? null,
                amazon_order_estimate: rec.orders ?? rec.estimatedOrders ?? null,
                amazon_raw_payload: JSON.stringify(rec).slice(0, 1000),
                status: 'suggested',
                target_type: 'keyword',
                synced_at: now,
                created_at: now,
              });
            }
          }

          for (let i = 0; i < toCreate.length; i += 50) {
            const batch = toCreate.slice(i, i + 50);
            await base44.asServiceRole.entities.KeywordSuggestion.bulkCreate(batch);
            asinCreated += batch.length;
          }

          asinSkipped += toCreate.length === 0 ? 0 : 0; // já contado
        }
      } catch (e: any) {
        asinError = e.message;
      }

      results.push({
        asin,
        product_name: (product.product_name || product.display_name || '').slice(0, 60),
        created: asinCreated,
        skipped: asinSkipped,
        error: asinError,
        reason: product.is_new_asin ? 'new_product'
          : (product.fba_inventory > 0 && product.previous_inventory_status === 'out_of_stock') ? 'restocked'
          : 'in_stock',
      });

      totalCreated += asinCreated;
      totalSkipped += asinSkipped;

      // Delay entre ASINs para respeitar rate limit da Amazon
      await new Promise(r => setTimeout(r, delay_between_asins_ms));
    }

    return Response.json({
      ok: true,
      eligible_count: orderedProducts.length,
      processed: results.length,
      total_created: totalCreated,
      total_skipped: totalSkipped,
      without_suggestions_before: withoutSuggestions.length,
      results,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});