/**
 * syncAmazonKeywordSuggestionsByAsin
 *
 * Busca sugestões oficiais de keywords da Amazon Ads API por ASIN.
 * Endpoint principal: POST /sp/targets/keywords/recommendations (v4)
 * Fallback: POST /v2/sp/asins/suggested/keywords
 *
 * REGRA: A IA NÃO gera keywords. Apenas a Amazon Ads API fornece os termos.
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
  // v4 format may have nested per-ASIN
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

async function fetchWithRetry(url: string, opts: RequestInit, maxRetries = 2, delayMs = 5000): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, opts);
    if (res.status !== 429) return res;
    if (attempt < maxRetries) await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
  }
  return fetch(url, opts); // last attempt
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
      asin,
      competitor_asins = [],
      max_suggestions_per_asin = 50,
      match_types = ['EXACT', 'PHRASE', 'BROAD'],
    } = body;

    if (!asin) return Response.json({ ok: false, error: 'asin obrigatório' });

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

    // Buscar concorrentes
    let allCompetitorAsins = [...competitor_asins];
    try {
      const stored = await base44.asServiceRole.entities.CompetitorAsinMap.filter({
        amazon_account_id: aid, asin, status: 'active',
      });
      for (const c of stored) {
        if (c.competitor_asin && !allCompetitorAsins.includes(c.competitor_asin)) {
          allCompetitorAsins.push(c.competitor_asin);
        }
      }
    } catch {}

    const token = await getAdsToken(refreshToken, clientId, clientSecret);

    const authHeaders = {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': String(profileId),
    };

    // Deduplicação
    const existingSuggestions = await base44.asServiceRole.entities.KeywordSuggestion.filter({
      amazon_account_id: aid, asin,
    }, null, 500).catch(() => []);

    const existingIndex = new Set(
      existingSuggestions.map((s: any) =>
        `${normalizeKeyword(s.keyword)}|${(s.match_type || '').toUpperCase()}|${s.source_asin || ''}`
      )
    );

    const asinsToQuery = [
      { asin_val: asin, type: 'own' },
      ...allCompetitorAsins.map((a: string) => ({ asin_val: a, type: 'competitor' })),
    ];

    let totalCreated = 0;
    let totalSkipped = 0;
    const errors: string[] = [];

    for (const { asin_val, type } of asinsToQuery) {
      let recommendations: any[] = [];

      // ── Endpoint primário: v4 ASIN-based (com retry em 429) ──────────────────
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
              asins: [asin_val],
              maxRecommendations: max_suggestions_per_asin,
              filterOptions: { keywordMatchTypeFilter: match_types },
            }),
          },
          3, // 3 retries
          4000 // 4s delay
        );

        if (res.ok) {
          const data = await res.json();
          recommendations = extractRecommendations(data);
        } else if (res.status !== 429) {
          const errText = await res.text().catch(() => '');
          errors.push(`v4 HTTP ${res.status} para ${asin_val}: ${errText.slice(0, 200)}`);
        }
      } catch (e: any) {
        errors.push(`v4 erro para ${asin_val}: ${e.message}`);
      }

      // ── Fallback: v2 POST (sem suggestBids para evitar 422) ──────────────────
      if (recommendations.length === 0) {
        try {
          const res2 = await fetchWithRetry(
            `${baseUrl}/v2/sp/asins/suggested/keywords`,
            {
              method: 'POST',
              headers: { ...authHeaders, 'Content-Type': 'application/json', 'Accept': 'application/json' },
              body: JSON.stringify({ asins: [asin_val], maxNumSuggestions: max_suggestions_per_asin }),
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

      if (recommendations.length === 0) {
        if (!errors.find(e => e.includes(asin_val))) {
          errors.push(`${asin_val}: sem recomendações retornadas`);
        }
        // Continuar — não abortar os outros ASINs
        if (asinsToQuery.length > 1) await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      // ── Processar e salvar ───────────────────────────────────────────────────
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

          const dedupKey = `${normalized}|${matchType}|${asin_val}`;
          if (existingIndex.has(dedupKey)) { totalSkipped++; continue; }
          existingIndex.add(dedupKey);

          const bid = extractBid(rec);
          const bidMin = rec.suggestedBid?.rangeStart ?? rec.suggestedBid?.minimum ?? null;
          const bidMax = rec.suggestedBid?.rangeEnd ?? rec.suggestedBid?.maximum ?? null;

          toCreate.push({
            amazon_account_id: aid,
            asin,
            source_asin: asin_val,
            source_asin_type: type,
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
        totalCreated += batch.length;
      }

      if (asinsToQuery.length > 1) await new Promise(r => setTimeout(r, 800));
    }

    // Registrar concorrentes fornecidos pelo usuário
    for (const competitorAsin of competitor_asins) {
      const exists = await base44.asServiceRole.entities.CompetitorAsinMap.filter({
        amazon_account_id: aid, asin, competitor_asin: competitorAsin,
      }).catch(() => []);
      if (!exists.length) {
        await base44.asServiceRole.entities.CompetitorAsinMap.create({
          amazon_account_id: aid, asin, competitor_asin: competitorAsin,
          source: 'user_input', status: 'active', created_at: now, updated_at: now,
        }).catch(() => {});
      }
    }

    return Response.json({
      ok: true,
      asin,
      competitor_asins_used: allCompetitorAsins,
      total_created: totalCreated,
      total_skipped: totalSkipped,
      errors,
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});