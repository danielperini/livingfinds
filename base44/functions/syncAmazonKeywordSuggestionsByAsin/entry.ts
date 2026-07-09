/**
 * syncAmazonKeywordSuggestionsByAsin
 *
 * Consulta a Amazon Ads API (Keyword Recommendations) para obter sugestões
 * oficiais de keywords por ASIN próprio e ASINs concorrentes.
 *
 * REGRA: A IA NÃO gera keywords. Apenas a Amazon Ads API fornece os termos.
 * Salva em KeywordSuggestion com source = AMAZON_ADS_SUGGESTED_KEYWORD ou AMAZON_ADS_SUGGESTED_TARGET.
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

    // Buscar concorrentes da entidade CompetitorAsinMap se não vieram no body
    let allCompetitorAsins = [...competitor_asins];
    try {
      const storedCompetitors = await base44.asServiceRole.entities.CompetitorAsinMap.filter({
        amazon_account_id: aid,
        asin,
        status: 'active',
      });
      for (const c of storedCompetitors) {
        if (c.competitor_asin && !allCompetitorAsins.includes(c.competitor_asin)) {
          allCompetitorAsins.push(c.competitor_asin);
        }
      }
    } catch {}

    const token = await getAdsToken(refreshToken, clientId, clientSecret);

    // Buscar sugestões existentes para deduplicação
    const existingSuggestions = await base44.asServiceRole.entities.KeywordSuggestion.filter({
      amazon_account_id: aid,
      asin,
    }, null, 200).catch(() => []);

    // Índice de deduplicação: normalized_keyword + match_type + source_asin
    const existingIndex = new Set(
      existingSuggestions.map((s: any) => `${s.normalized_keyword}|${(s.match_type || '').toUpperCase()}|${s.source_asin || ''}`)
    );

    const asinsToQuery = [
      { asin_val: asin, type: 'own' },
      ...allCompetitorAsins.map((a: string) => ({ asin_val: a, type: 'competitor' })),
    ];

    let totalCreated = 0;
    let totalSkipped = 0;
    const errors: string[] = [];

    for (const { asin_val, type } of asinsToQuery) {
      try {
        // Amazon Ads API v3 — Keyword Recommendations by ASIN
        const payload = {
          asins: [asin_val],
          maxRecommendations: max_suggestions_per_asin,
          filterOptions: {
            keywordMatchTypeFilter: match_types,
          },
        };

        const res = await fetch(`${baseUrl}/sp/targets/keywords/recommendations`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Amazon-Advertising-API-ClientId': clientId,
            'Amazon-Advertising-API-Scope': String(profileId),
            'Content-Type': 'application/vnd.spkeywordsrecommendation.v4+json',
            'Accept': 'application/vnd.spkeywordsrecommendation.v4+json',
          },
          body: JSON.stringify(payload),
        });

        if (res.status === 429) {
          await new Promise(r => setTimeout(r, 5000));
          errors.push(`Rate limit para ASIN ${asin_val}`);
          continue;
        }
        if (!res.ok) {
          const errText = await res.text();
          errors.push(`HTTP ${res.status} para ASIN ${asin_val}: ${errText.slice(0, 200)}`);
          continue;
        }

        const data = await res.json();
        const recommendations = data?.keywordRecommendations || data?.recommendations || [];

        const toCreate: any[] = [];

        for (const rec of recommendations) {
          const keywordText = rec.keyword || rec.keywordText || rec.recommendedKeyword;
          if (!keywordText) continue;

          const matchType = (rec.matchType || 'EXACT').toUpperCase();
          const normalized = normalizeKeyword(keywordText);

          if (!normalized || normalized.length < 2) continue;

          const dedupKey = `${normalized}|${matchType}|${asin_val}`;
          if (existingIndex.has(dedupKey)) {
            totalSkipped++;
            continue;
          }
          existingIndex.add(dedupKey);

          const bid = rec.suggestedBid?.suggested || rec.bid || null;
          const bidMin = rec.suggestedBid?.rangeStart || null;
          const bidMax = rec.suggestedBid?.rangeEnd || null;

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
            amazon_suggested_bid_min: bidMin,
            amazon_suggested_bid_max: bidMax,
            amazon_relevance_score: rec.rankingScore || rec.score || 0,
            amazon_impression_estimate: rec.impressions || null,
            amazon_click_estimate: rec.clicks || null,
            amazon_order_estimate: rec.orders || null,
            amazon_raw_payload: JSON.stringify(rec).slice(0, 1000),
            status: 'suggested',
            target_type: 'keyword',
            synced_at: now,
            created_at: now,
          });
        }

        // Criar em lotes de 50
        for (let i = 0; i < toCreate.length; i += 50) {
          await base44.asServiceRole.entities.KeywordSuggestion.bulkCreate(toCreate.slice(i, i + 50));
          totalCreated += toCreate.slice(i, i + 50).length;
        }

        // Pausa entre ASINs
        await new Promise(r => setTimeout(r, 800));

      } catch (e: any) {
        errors.push(`Erro para ASIN ${asin_val}: ${e.message}`);
      }
    }

    // Atualizar CompetitorAsinMap com concorrentes fornecidos
    for (const competitorAsin of competitor_asins) {
      const existing = await base44.asServiceRole.entities.CompetitorAsinMap.filter({
        amazon_account_id: aid, asin, competitor_asin: competitorAsin,
      }).catch(() => []);
      if (!existing.length) {
        await base44.asServiceRole.entities.CompetitorAsinMap.create({
          amazon_account_id: aid,
          asin,
          competitor_asin: competitorAsin,
          source: 'user_input',
          status: 'active',
          created_at: now,
          updated_at: now,
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