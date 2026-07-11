/**
 * enforceManualCampaignMinTerms
 *
 * Regras:
 * 1. Cada ASIN deve ter no mínimo 10 termos ativos em campanhas MANUAL EXACT.
 * 2. Campanhas MANUAL com 0 impressões após 48h → as 2 piores são substituídas por termos
 *    ranqueados que ainda não estão em uso:
 *      - Procura primeiro no TermBank (SearchTerm com conversões)
 *      - Depois em KeywordSuggestion (Amazon Ads suggestions)
 *      - Seleciona as 2 melhores por score
 * 3. Janela de avaliação antes de "zerar" (pausar) keyword = 72h sem impressões.
 *
 * Chamado diariamente pelo orquestrador ou manualmente via UI.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MIN_TERMS_PER_ASIN = 10;
const ZERO_IMPRESSION_HOURS = 48;   // horas sem impressão antes de substituir
const KEYWORD_PAUSE_HOURS   = 72;   // horas sem impressão antes de pausar definitivamente
const MIN_BID = 0.35;
const DEFAULT_BID = 0.50;
const MAX_BID = 3.00;

/**
 * Calcula bid ideal baseado nas metas cadastradas (PerformanceSettings).
 * Fórmula: bid = preço_produto * (target_acos / 100) * CVR_estimada
 * CVR estimada conservadora = 10% (1 venda a cada 10 cliques)
 * Fallback: amazon_suggested_bid → avg_cpc * 1.1 → DEFAULT_BID
 */
function calcBidFromGoals(settings: any, product: any, fallbackBid: number): number {
  const targetAcos = settings?.target_acos || 0;
  const maxBid = settings?.max_bid || MAX_BID;
  const minBid = settings?.min_bid || MIN_BID;
  const price = product?.price || 0;

  if (targetAcos > 0 && price > 0) {
    // bid = preço × (target_acos/100) × CVR_estimada (10%)
    const bid = price * (targetAcos / 100) * 0.10;
    return Math.min(maxBid, Math.max(minBid, Math.round(bid * 100) / 100));
  }
  return Math.min(maxBid, Math.max(minBid, fallbackBid || DEFAULT_BID));
}

/** Orçamento diário da campanha — usa o limite configurado nas metas */
function calcBudgetFromGoals(settings: any): number {
  // Budget por campanha individual: limit / 10 campanhas estimadas, mínimo R$5
  const dailyLimit = settings?.daily_budget_limit || 0;
  if (dailyLimit > 0) return Math.max(5, Math.round(dailyLimit / 10));
  return 5; // fallback conservador
}

function hoursAgo(dateStr: string): number {
  if (!dateStr) return 0;
  return (Date.now() - new Date(dateStr).getTime()) / 3600000;
}

async function getAdsToken(account: any): Promise<string> {
  const refreshToken = account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '';
  const clientId     = Deno.env.get('ADS_CLIENT_ID') || '';
  const clientSecret = Deno.env.get('ADS_CLIENT_SECRET') || '';
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token failed');
  return data.access_token;
}

function getAdsBaseUrl(account: any): string {
  const r = (account?.region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsCall(token: string, account: any, method: string, path: string, body?: any) {
  const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
  const baseUrl   = getAdsBaseUrl(account);
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID') || '',
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** Score de um termo do TermBank para substituição */
function termBankScore(st: any): number {
  return (st.orders_14d || st.orders || 0) * 50
    + (st.clicks || 0) * 2
    + (st.roas_14d || st.roas || 0) * 10
    - (st.acos_14d || st.acos || 0) * 2;
}

/** Score de uma sugestão Amazon */
function suggestionScore(s: any): number {
  const conf = s.ai_confidence != null ? (s.ai_confidence <= 1 ? s.ai_confidence : s.ai_confidence / 100) : 0;
  return conf * 200
    + (s.amazon_relevance_score || 0) * 100
    + (s.amazon_suggested_bid || 0) * 20
    + (s.ai_rank ? Math.max(0, 20 - s.ai_rank) * 10 : 0);
}

Deno.serve(async (req) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body   = await req.json().catch(() => ({}));

    // Auth
    if (!body._service_role) {
      const user = await base44.auth.me();
      if (!user) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const now = new Date().toISOString();
    const today = now.slice(0, 10);

    // Resolver conta
    let account: any = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0] || null;
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon conectada.' });
    const aid = account.id;

    // Obter token Amazon Ads
    let token: string;
    try { token = await getAdsToken(account); }
    catch (e: any) { return Response.json({ ok: false, error: `Token error: ${e.message}` }, { status: 500 }); }

    const stats = {
      asins_checked: 0,
      keywords_added: 0,
      keywords_paused: 0,
      campaigns_substituted: 0,
      terms_from_termbank: 0,
      terms_from_suggestions: 0,
      errors: [] as string[],
    };

    // ── 1. Buscar todas as campanhas MANUAL ativas ──────────────────────────
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: aid, targeting_type: 'MANUAL' }, '-spend', 500
    );
    const manualActive = allCampaigns.filter((c: any) => {
      const st = (c.state || c.status || '').toLowerCase();
      return st !== 'archived' && !c.archived;
    });

    // Agrupar por ASIN
    const byAsin = new Map<string, any[]>();
    for (const c of manualActive) {
      const asin = c.asin;
      if (!asin) continue;
      if (!byAsin.has(asin)) byAsin.set(asin, []);
      byAsin.get(asin)!.push(c);
    }

    // ── Carregar metas de performance (fonte única de verdade para bids/budget) ──
    const perfSettings = await base44.asServiceRole.entities.PerformanceSettings.filter(
      { amazon_account_id: aid }, null, 1
    ).then((r: any[]) => r[0] || null).catch(() => null);

    // Carregar produtos para calcular bid por preço
    const allProducts = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id: aid }, null, 500
    ).catch(() => []);
    const productByAsin = new Map<string, any>(allProducts.map((p: any) => [p.asin, p]));

    // Carregar TermBank e Sugestões uma vez para eficiência
    const allTermBank = await base44.asServiceRole.entities.SearchTerm.filter(
      { amazon_account_id: aid }, '-orders_14d', 2000
    );
    const allSuggestions = await base44.asServiceRole.entities.KeywordSuggestion.filter(
      { amazon_account_id: aid }, null, 2000
    );

    // ── 2. Por ASIN: verificar keywords ativas e fazer enforcement ──────────
    for (const [asin, camps] of byAsin.entries()) {
      stats.asins_checked++;
      const product = productByAsin.get(asin) || null;

      // Buscar keywords ativas via Amazon Ads API para todos as campanhas do ASIN
      const campaignIds = camps
        .map((c: any) => c.campaign_id || c.amazon_campaign_id)
        .filter(Boolean);

      if (campaignIds.length === 0) continue;

      // Buscar keywords em lote
      const kwRes = await adsCall(token, account, 'POST', '/sp/keywords/list', {
        stateFilter: { include: ['ENABLED', 'PAUSED'] },
        campaignIdFilter: { include: campaignIds },
        maxResults: 500,
      }).catch(() => ({ ok: false, data: {} }));

      const allKeywords: any[] = kwRes?.data?.keywords || [];
      const enabledKeywords = allKeywords.filter((k: any) => k.state === 'ENABLED');
      const activeKeywordTexts = new Set<string>(enabledKeywords.map((k: any) => (k.keywordText || '').toLowerCase().trim()));

      // ── 2a. REGRA: mínimo 10 termos por ASIN ─────────────────────────────
      const currentActiveCount = enabledKeywords.length;
      const deficit = MIN_TERMS_PER_ASIN - currentActiveCount;

      if (deficit > 0) {
        // Buscar termos para preencher o déficit — TermBank primeiro
        const termBankCandidates = allTermBank
          .filter((st: any) => st.asin === asin
            && !activeKeywordTexts.has((st.search_term || st.keyword_text || '').toLowerCase().trim())
            && (st.search_term || st.keyword_text || '').trim().length >= 3
          )
          .sort((a: any, b: any) => termBankScore(b) - termBankScore(a))
          .slice(0, deficit);

        let fillerTerms: { keyword: string; bid: number; source: string }[] = termBankCandidates.map((st: any) => ({
          keyword: (st.search_term || st.keyword_text || '').trim(),
          // bid orientado pelas metas → avg_cpc histórico como fallback
          bid: calcBidFromGoals(perfSettings, product, st.avg_cpc ? st.avg_cpc * 1.1 : DEFAULT_BID),
          source: 'termbank',
        }));

        // Complementar com sugestões Amazon se precisar
        if (fillerTerms.length < deficit) {
          const needed = deficit - fillerTerms.length;
          const usedTexts = new Set<string>([...activeKeywordTexts, ...fillerTerms.map(f => f.keyword.toLowerCase())]);
          const suggCandidates = allSuggestions
            .filter((s: any) => s.asin === asin
              && !['archived_by_policy', 'superseded', 'created'].includes(s.status || '')
              && !usedTexts.has((s.keyword || '').toLowerCase().trim())
              && (s.keyword || '').trim().length >= 3
            )
            .sort((a: any, b: any) => suggestionScore(b) - suggestionScore(a))
            .slice(0, needed);

          fillerTerms = fillerTerms.concat(suggCandidates.map((s: any) => ({
            keyword: (s.keyword || '').trim(),
            // bid orientado pelas metas → bid sugerido Amazon como fallback
            bid: calcBidFromGoals(perfSettings, product, s.amazon_suggested_bid || DEFAULT_BID),
            source: 'suggestion',
          })));
        }

        // Adicionar as keywords faltantes na campanha com maior spend do ASIN
        const bestCamp = camps.sort((a: any, b: any) => (b.spend || 0) - (a.spend || 0))[0];
        const campaignId = bestCamp.campaign_id || bestCamp.amazon_campaign_id;

        // Buscar adGroupId da melhor campanha
        const agRes = await adsCall(token, account, 'POST', '/sp/adGroups/list', {
          campaignIdFilter: { include: [campaignId] },
          stateFilter: { include: ['ENABLED'] },
          maxResults: 1,
        }).catch(() => ({ ok: false, data: {} }));
        const adGroupId = agRes?.data?.adGroups?.[0]?.adGroupId;

        if (adGroupId && fillerTerms.length > 0) {
          // Adicionar diretamente em lote — sem aprovação humana
          const addRes = await adsCall(token, account, 'POST', '/sp/keywords', {
            keywords: fillerTerms.map(t => ({
              campaignId,
              adGroupId,
              state: 'ENABLED',
              keywordText: t.keyword,
              matchType: 'EXACT',
              bid: t.bid,
            })),
          }).catch(() => ({ ok: false, data: {} }));

          const added = addRes?.data?.keywords?.success?.length || 0;
          stats.keywords_added += added;
          for (const t of fillerTerms.slice(0, added)) {
            if (t.source === 'termbank') stats.terms_from_termbank++;
            else stats.terms_from_suggestions++;
          }

          // Registrar decisões já executadas (sem aprovação)
          const goalInfo = perfSettings
            ? `Target ACoS: ${perfSettings.target_acos}% | Max bid: R$${(perfSettings.max_bid || MAX_BID).toFixed(2)}`
            : 'Sem metas configuradas — bid calculado via fallback';
          await Promise.all(fillerTerms.slice(0, added).map((t: any) =>
            base44.asServiceRole.entities.OptimizationDecision.create({
              amazon_account_id: aid,
              decision_type: 'create_keyword',
              entity_type: 'keyword',
              campaign_id: campaignId,
              keyword_text: t.keyword,
              asin,
              action: `Keyword "${t.keyword}" (EXACT, bid R$${t.bid.toFixed(2)}) adicionada automaticamente para mínimo ${MIN_TERMS_PER_ASIN} termos/ASIN`,
              rationale: `ASIN ${asin} tinha ${currentActiveCount} keywords ativas. ${goalInfo}. Fonte: ${t.source}. Executado sem aprovação humana.`,
              status: 'executed',
              risk: 'low',
              requires_approval: false,
              confidence: 80,
              source_function: 'enforceManualCampaignMinTerms',
              executed_at: now,
              created_at: now,
            }).catch(() => {})
          ));
        } else if (fillerTerms.length > 0 && !adGroupId) {
          // Não há adGroup — criar campanhas individuais via createManualCampaignV2
          // (uma campanha por keyword, sem aprovação, usando orçamento das metas)
          const budget = calcBudgetFromGoals(perfSettings);
          for (const t of fillerTerms) {
            const createRes = await base44.asServiceRole.functions.invoke('createManualCampaignV2', {
              _service_role: true,
              amazon_account_id: aid,
              asin,
              keyword: t.keyword,
              bid: t.bid,
              budget,
            }).catch(() => null);
            if (createRes?.data?.ok) {
              stats.keywords_added++;
              if (t.source === 'termbank') stats.terms_from_termbank++;
              else stats.terms_from_suggestions++;
            }
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      }

      // ── 2b. REGRA: substituir as 2 keywords com 0 impressões em 48h ──────
      // Buscar métricas por keyword (últimos 3 dias) via CampaignMetricsDaily por campanha
      // Para cada campanha: identificar keywords sem impressões nas últimas 48h
      const metricsRecent = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
        { amazon_account_id: aid }, '-date', 200
      ).catch(() => []);

      const recentDates = new Set<string>();
      const now_ = new Date();
      for (let d = 0; d < 3; d++) {
        const dd = new Date(now_);
        dd.setDate(dd.getDate() - d);
        recentDates.add(dd.toISOString().slice(0, 10));
      }

      const campaignMetricsMap = new Map<string, { impressions: number; clicks: number }>();
      for (const m of metricsRecent) {
        if (!recentDates.has(m.date)) continue;
        const cid = m.campaign_id;
        if (!cid) continue;
        const ex = campaignMetricsMap.get(cid) || { impressions: 0, clicks: 0 };
        ex.impressions += m.impressions || 0;
        ex.clicks += m.clicks || 0;
        campaignMetricsMap.set(cid, ex);
      }

      // Identificar campanhas do ASIN com zero impressões nas últimas 48h
      const zeroImpressionCamps = camps.filter((c: any) => {
        const cid = c.campaign_id || c.amazon_campaign_id;
        const m = campaignMetricsMap.get(cid);
        // Sem métricas = sem impressões
        const impressions = m?.impressions || 0;
        // Campanha com >= 48h de existência
        const ageHours = hoursAgo(c.created_at || c.created_date || now);
        return impressions === 0 && ageHours >= ZERO_IMPRESSION_HOURS;
      });

      // Pegar as 2 piores (com maior idade sem impressão)
      const worstTwo = zeroImpressionCamps
        .sort((a: any, b: any) => {
          const ageA = hoursAgo(a.created_at || a.created_date || now);
          const ageB = hoursAgo(b.created_at || b.created_date || now);
          return ageB - ageA; // mais velhas primeiro (piores)
        })
        .slice(0, 2);

      for (const camp of worstTwo) {
        const campaignId = camp.campaign_id || camp.amazon_campaign_id;
        const ageHours = hoursAgo(camp.created_at || camp.created_date || now);

        // Buscar keywords atuais da campanha
        const campKwRes = await adsCall(token, account, 'POST', '/sp/keywords/list', {
          stateFilter: { include: ['ENABLED'] },
          campaignIdFilter: { include: [campaignId] },
          maxResults: 50,
        }).catch(() => ({ ok: false, data: {} }));

        const campKeywords: any[] = campKwRes?.data?.keywords || [];
        const campKwTexts = new Set<string>(campKeywords.map((k: any) => (k.keywordText || '').toLowerCase().trim()));

        // ── Se >= KEYWORD_PAUSE_HOURS: pausar as keywords atuais definitivamente ──
        if (ageHours >= KEYWORD_PAUSE_HOURS && campKeywords.length > 0) {
          await adsCall(token, account, 'PUT', '/sp/keywords', {
            keywords: campKeywords.map((k: any) => ({ keywordId: k.keywordId, state: 'PAUSED' })),
          }).catch(() => {});
          stats.keywords_paused += campKeywords.length;

          // Registrar decisão de pausa
          await base44.asServiceRole.entities.OptimizationDecision.create({
            amazon_account_id: aid,
            decision_type: 'pause',
            entity_type: 'keyword',
            campaign_id: campaignId,
            asin,
            action: `Pausadas ${campKeywords.length} keyword(s) sem impressões após ${Math.round(ageHours)}h`,
            rationale: `Campanha ${campaignId} ficou ${Math.round(ageHours)}h sem impressões (limite: ${KEYWORD_PAUSE_HOURS}h). Keywords pausadas definitivamente.`,
            status: 'executed',
            risk: 'medium',
            requires_approval: false,
            confidence: 90,
            source_function: 'enforceManualCampaignMinTerms',
            executed_at: now,
            created_at: now,
          }).catch(() => {});
        }

        // ── Buscar termos substitutos (excluindo os já usados no ASIN inteiro) ──
        const globalUsedTexts = new Set<string>([...activeKeywordTexts, ...campKwTexts]);

        // Primeiro: TermBank ranqueado para o ASIN
        const termBankSubs = allTermBank
          .filter((st: any) => st.asin === asin
            && !globalUsedTexts.has((st.search_term || st.keyword_text || '').toLowerCase().trim())
            && (st.search_term || st.keyword_text || '').trim().length >= 3
            && (st.orders_14d || st.orders || st.clicks || 0) > 0
          )
          .sort((a: any, b: any) => termBankScore(b) - termBankScore(a))
          .slice(0, 4); // pegar 4, escolher os 2 melhores

        let substitutes: { keyword: string; bid: number; source: string }[] = termBankSubs.map((st: any) => ({
          keyword: (st.search_term || st.keyword_text || '').trim(),
          // bid calculado pelas metas cadastradas
          bid: calcBidFromGoals(perfSettings, product, st.avg_cpc ? st.avg_cpc * 1.1 : DEFAULT_BID),
          source: 'termbank',
        }));

        // Complementar com sugestões Amazon se necessário
        if (substitutes.length < 2) {
          const needed = 2 - substitutes.length;
          const alreadyPickedTexts = new Set<string>([...globalUsedTexts, ...substitutes.map(s => s.keyword.toLowerCase())]);
          const suggSubs = allSuggestions
            .filter((s: any) => s.asin === asin
              && !['archived_by_policy', 'superseded', 'created'].includes(s.status || '')
              && !alreadyPickedTexts.has((s.keyword || '').toLowerCase().trim())
              && (s.keyword || '').trim().length >= 3
            )
            .sort((a: any, b: any) => suggestionScore(b) - suggestionScore(a))
            .slice(0, needed);

          substitutes = substitutes.concat(suggSubs.map((s: any) => ({
            keyword: (s.keyword || '').trim(),
            // bid calculado pelas metas cadastradas
            bid: calcBidFromGoals(perfSettings, product, s.amazon_suggested_bid || DEFAULT_BID),
            source: 'suggestion',
          })));
        }

        // Pegar exatamente 2 melhores
        substitutes = substitutes.slice(0, 2);
        if (substitutes.length === 0) continue;

        // Buscar adGroupId da campanha
        const agRes2 = await adsCall(token, account, 'POST', '/sp/adGroups/list', {
          campaignIdFilter: { include: [campaignId] },
          stateFilter: { include: ['ENABLED', 'PAUSED'] },
          maxResults: 1,
        }).catch(() => ({ ok: false, data: {} }));
        const adGroupId2 = agRes2?.data?.adGroups?.[0]?.adGroupId;
        if (!adGroupId2) continue;

        // Adicionar substitutos
        const addRes2 = await adsCall(token, account, 'POST', '/sp/keywords', {
          keywords: substitutes.map(s => ({
            campaignId,
            adGroupId: adGroupId2,
            state: 'ENABLED',
            keywordText: s.keyword,
            matchType: 'EXACT',
            bid: s.bid,
          })),
        }).catch(() => ({ ok: false, data: {} }));

        const addedSubs = addRes2?.data?.keywords?.success?.length || 0;
        stats.campaigns_substituted += addedSubs > 0 ? 1 : 0;
        stats.keywords_added += addedSubs;

        for (const s of substitutes.slice(0, addedSubs)) {
          if (s.source === 'termbank') stats.terms_from_termbank++;
          else stats.terms_from_suggestions++;
        }

        // Reativar campanha se estava pausada
        await adsCall(token, account, 'PUT', '/sp/campaigns', {
          campaigns: [{ campaignId, state: 'ENABLED' }],
        }).catch(() => {});

        // Registrar decisão de substituição — executada automaticamente pelas metas
        const goalSummary = perfSettings
          ? `Metas: ACoS alvo ${perfSettings.target_acos}% | bid max R$${(perfSettings.max_bid || MAX_BID).toFixed(2)} | budget/camp R$${calcBudgetFromGoals(perfSettings).toFixed(2)}`
          : 'Sem metas configuradas — fallback padrão';
        await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id: aid,
          decision_type: 'create_keyword',
          entity_type: 'keyword',
          campaign_id: campaignId,
          asin,
          action: `Substituição automática: ${addedSubs} keyword(s) novas após ${Math.round(ageHours)}h sem impressões. ${substitutes.slice(0, addedSubs).map(s => `"${s.keyword}" bid R$${s.bid.toFixed(2)} (${s.source})`).join('; ')}`,
          rationale: `Campanha ${campaignId} ficou ${Math.round(ageHours)}h sem impressões. ${goalSummary}. Busca: TermBank → Amazon Suggestions. Executado sem aprovação humana.`,
          status: 'executed',
          risk: 'low',
          requires_approval: false,
          confidence: 85,
          source_function: 'enforceManualCampaignMinTerms',
          executed_at: now,
          created_at: now,
        }).catch(() => {});

        // Atualizar campanha no banco
        await base44.asServiceRole.entities.Campaign.update(camp.id, {
          last_review_at: now,
          last_review_reason: `Substituição automática: ${Math.round(ageHours)}h sem impressões. ${addedSubs} keyword(s) nova(s) adicionadas.`,
        }).catch(() => {});

        await new Promise(r => setTimeout(r, 800));
      }
    }

    return Response.json({
      ok: true,
      duration_ms: Date.now() - startedAt,
      stats,
      rules: {
        min_terms_per_asin: MIN_TERMS_PER_ASIN,
        zero_impression_hours: ZERO_IMPRESSION_HOURS,
        keyword_pause_hours: KEYWORD_PAUSE_HOURS,
      },
    });

  } catch (error: any) {
    return Response.json({ ok: false, error: error.message, duration_ms: Date.now() - startedAt }, { status: 500 });
  }
});