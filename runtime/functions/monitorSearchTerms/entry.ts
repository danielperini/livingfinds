/**
 * monitorSearchTerms — Monitor diário de Search Terms de campanhas AUTO
 *
 * Para cada campanha AUTO ativa:
 * 1. Analisa search terms capturados (da entidade Keyword)
 * 2. Classifica em: rentáveis (promover → keyword manual), desperdiçadores (negativar)
 * 3. Usa IA para decisão e grava NegativeKeywordSuggestion + Keyword (manual sugerida)
 * 4. Grava log em LearningEvent
 *
 * Chamado pela automação diária às 07:00 BRT (10:00 UTC)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // Autenticação — aceita chamadas de automação (service role) ou user
    let isAuth = false;
    try {
      const user = await base44.auth.me();
      isAuth = !!user;
    } catch {
      isAuth = true; // automação scheduled não tem user token
    }

    const body = await req.json().catch(() => ({}));

    // Resolver conta Amazon
    let accounts = [];
    if (body.amazon_account_id) {
      const acc = await base44.asServiceRole.entities.AmazonAccount.get(body.amazon_account_id).catch(() => null);
      if (acc) accounts = [acc];
    }
    if (accounts.length === 0) {
      accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });
    }
    if (accounts.length === 0) {
      accounts = await base44.asServiceRole.entities.AmazonAccount.list('-created_date', 1);
    }
    if (accounts.length === 0) {
      return Response.json({ ok: false, message: 'Nenhuma conta Amazon encontrada' });
    }

    const results = [];

    for (const account of accounts) {
      const amazonAccountId = account.id;
      const now = new Date().toISOString();
      const today = now.slice(0, 10);

      // Buscar campanhas AUTO ativas
      const autoCampaigns = await base44.asServiceRole.entities.Campaign.filter(
        { amazon_account_id: amazonAccountId, targeting_type: 'AUTO', state: 'enabled' },
        '-spend',
        200
      );

      if (autoCampaigns.length === 0) {
        results.push({ account: amazonAccountId, message: 'Sem campanhas AUTO ativas', suggestions: 0 });
        continue;
      }

      console.log(`[monitorSearchTerms] ${autoCampaigns.length} campanhas AUTO ativas para ${amazonAccountId}`);

      // Buscar todos os search terms destas campanhas
      const campaignIds = autoCampaigns.map(c => c.campaign_id);
      const allKeywords = await base44.asServiceRole.entities.Keyword.filter(
        { amazon_account_id: amazonAccountId, source: 'search_term' },
        '-spend',
        2000
      );

      // Filtrar apenas os pertencentes às campanhas AUTO
      const autoKeywords = allKeywords.filter(kw => campaignIds.includes(kw.campaign_id));

      if (autoKeywords.length === 0) {
        results.push({ account: amazonAccountId, message: 'Sem search terms capturados ainda', suggestions: 0 });
        continue;
      }

      console.log(`[monitorSearchTerms] ${autoKeywords.length} search terms para análise`);

      // Buscar negativações já existentes para evitar duplicar
      const existingNegatives = await base44.asServiceRole.entities.NegativeKeywordSuggestion.filter(
        { amazon_account_id: amazonAccountId },
        '-created_date',
        1000
      );
      const existingNegSet = new Set(existingNegatives.map(n => `${n.campaign_id}|${n.keyword_text}`));

      // Classificação local antes da IA:
      // - Rentável: clicks > 3, vendas > 0, acos < 40% → promover
      // - Desperdiçador: clicks > 5, spend > 2, vendas == 0 → negativar
      // - Caro: acos > 80%, spend > 5 → negativar
      const toPromote = autoKeywords.filter(kw =>
        (kw.clicks || 0) >= 3 &&
        (kw.sales || 0) > 0 &&
        (kw.acos || 0) > 0 &&
        (kw.acos || 0) < 40
      ).slice(0, 20);

      const toNegate = autoKeywords.filter(kw =>
        ((kw.clicks || 0) >= 5 && (kw.spend || 0) >= 2 && (kw.sales || 0) === 0) ||
        ((kw.acos || 0) > 80 && (kw.spend || 0) >= 5)
      ).slice(0, 30);

      // Análise IA para os termos menos óbvios
      const grayZone = autoKeywords.filter(kw =>
        !toPromote.includes(kw) &&
        !toNegate.includes(kw) &&
        (kw.clicks || 0) >= 2 &&
        (kw.spend || 0) >= 1
      ).slice(0, 20);

      let aiSuggestions = { promote: [], negate: [] };
      if (grayZone.length > 0) {
        try {
          const prompt = `Analisa estes search terms de campanhas Amazon Ads AUTO e classifica cada um como "promote" (adicionar como keyword manual) ou "negate" (adicionar como keyword negativa) ou "keep" (manter observando).
Contexto: campanha Sponsored Products AUTO, target ACoS < 35%.
Search terms:
${grayZone.map(kw => `- "${kw.keyword_text}": ${kw.clicks} clicks, $${(kw.spend||0).toFixed(2)} spend, $${(kw.sales||0).toFixed(2)} vendas, ACoS ${(kw.acos||0).toFixed(0)}%`).join('\n')}

Regras: promote se ACoS < 35% e clicks >= 3; negate se spend >= 1.5 e vendas = 0 ou ACoS > 70%; keep nos outros casos.`;

          const aiRes = await base44.asServiceRole.integrations.Core.InvokeLLM({
            prompt,
            response_json_schema: {
              type: 'object',
              properties: {
                promote: { type: 'array', items: { type: 'string' } },
                negate: { type: 'array', items: { type: 'string' } },
              },
            },
          });
          aiSuggestions = aiRes || { promote: [], negate: [] };
        } catch (e) {
          console.warn('[monitorSearchTerms] IA falhou:', e.message);
        }
      }

      const now2 = new Date().toISOString();
      let suggestionsCreated = 0;

      // 1. Gravar sugestões de negativação
      const negToSave = [
        ...toNegate.map(kw => ({ kw, reason: (kw.sales || 0) === 0 ? 'zero_sales' : 'high_acos' })),
        ...grayZone
          .filter(kw => (aiSuggestions.negate || []).includes(kw.keyword_text))
          .map(kw => ({ kw, reason: 'ai_recommended' })),
      ];

      for (const { kw, reason } of negToSave) {
        const negKey = `${kw.campaign_id}|${kw.keyword_text}`;
        if (existingNegSet.has(negKey)) continue;
        existingNegSet.add(negKey);

        const camp = autoCampaigns.find(c => c.campaign_id === kw.campaign_id);
        await base44.asServiceRole.entities.NegativeKeywordSuggestion.create({
          amazon_account_id: amazonAccountId,
          campaign_id: kw.campaign_id,
          campaign_name: camp?.name || camp?.campaign_name || kw.campaign_id,
          ad_group_id: kw.ad_group_id || '',
          keyword_text: kw.keyword_text || kw.keyword || '',
          match_type: 'exact',
          clicks: kw.clicks || 0,
          spend: kw.spend || 0,
          sales: kw.sales || 0,
          acos: kw.acos || 0,
          reason: reason === 'zero_sales'
            ? `${kw.clicks} clicks, $${(kw.spend||0).toFixed(2)} gasto, zero vendas`
            : reason === 'high_acos'
            ? `ACoS ${(kw.acos||0).toFixed(0)}% muito acima do target`
            : `IA recomendou negativação — spend $${(kw.spend||0).toFixed(2)}, ACoS ${(kw.acos||0).toFixed(0)}%`,
          status: 'pending',
        }).catch(() => {});
        suggestionsCreated++;
      }

      // 2. Gravar keywords rentáveis como sugestões de promoção
      // Marcar source='suggested' e guardar na entidade Keyword para visibilidade
      const promoteTerms = [
        ...toPromote,
        ...grayZone.filter(kw => (aiSuggestions.promote || []).includes(kw.keyword_text)),
      ];

      const existingManualKws = await base44.asServiceRole.entities.Keyword.filter(
        { amazon_account_id: amazonAccountId, source: 'manual' },
        '-created_date',
        2000
      );
      const manualKwSet = new Set(existingManualKws.map(k => `${k.campaign_id}|${k.keyword_text}`));

      for (const kw of promoteTerms.slice(0, 15)) {
        const kwText = kw.keyword_text || kw.keyword || '';
        if (!kwText) continue;
        // Sugerir como keyword MANUAL na mesma campanha
        const sugKey = `${kw.campaign_id}|${kwText}`;
        if (manualKwSet.has(sugKey)) continue;
        manualKwSet.add(sugKey);

        await base44.asServiceRole.entities.Keyword.create({
          amazon_account_id: amazonAccountId,
          campaign_id: kw.campaign_id,
          ad_group_id: kw.ad_group_id || '',
          keyword_id: `sug_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          keyword_text: kwText,
          match_type: 'exact',
          state: 'paused', // sugerida, ainda não ativa
          status: 'paused',
          current_bid: 0.30,
          bid: 0.30,
          spend: kw.spend || 0,
          sales: kw.sales || 0,
          clicks: kw.clicks || 0,
          impressions: kw.impressions || 0,
          acos: kw.acos || 0,
          source: 'suggested',
          first_seen_at: now2,
          last_seen_at: now2,
          synced_at: now2,
        }).catch(() => {});
        suggestionsCreated++;
      }

      // 3. Log de aprendizado
      await base44.asServiceRole.entities.LearningEvent.create({
        amazon_account_id: amazonAccountId,
        event_type: 'search_term_analysis',
        entity_type: 'campaign',
        entity_id: autoCampaigns[0]?.campaign_id || '',
        observation: `Monitor diário ${today}: ${autoKeywords.length} search terms analisados. ${negToSave.length} para negativar, ${promoteTerms.length} para promover. IA analisou ${grayZone.length} termos na zona cinzenta.`,
        recorded_at: now2,
      }).catch(() => {});

      results.push({
        account: amazonAccountId,
        campaigns_analyzed: autoCampaigns.length,
        search_terms: autoKeywords.length,
        to_negate: negToSave.length,
        to_promote: promoteTerms.length,
        suggestions_created: suggestionsCreated,
      });

      console.log(`[monitorSearchTerms] Conta ${amazonAccountId}: ${suggestionsCreated} sugestões criadas`);
    }

    return Response.json({ ok: true, results });

  } catch (error) {
    console.error('[monitorSearchTerms] Erro:', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});