/**
 * suggestKeywordsForKickoff
 * Analisa termos e keywords já existentes na conta e retorna sugestões
 * compatíveis com um produto específico para pré-popular o Kickoff.
 *
 * Fontes analisadas (em ordem de prioridade):
 *  1. SearchTerms com orders_7d > 0 de campanhas AUTO do mesmo ASIN
 *  2. Keywords existentes em campanhas MANUAL do mesmo ASIN (reutilização)
 *  3. KeywordSuggestions aprovadas ou criadas para o mesmo ASIN
 *  4. SearchTerms convertidos (orders > 0) de outros ASINs com título similar
 *     → validados pelo Claude para compatibilidade semântica
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import Anthropic from 'npm:@anthropic-ai/sdk@0.32.1';

function norm(str) {
  return (str || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleSimilarity(a, b) {
  const ta = new Set(norm(a).split(' ').filter(w => w.length > 3));
  const tb = new Set(norm(b).split(' ').filter(w => w.length > 3));
  if (!ta.size || !tb.size) return 0;
  const inter = [...ta].filter(w => tb.has(w)).length;
  return inter / Math.min(ta.size, tb.size);
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, asin, product_name } = body;
    if (!amazon_account_id || !asin) {
      return Response.json({ error: 'amazon_account_id e asin são obrigatórios' }, { status: 400 });
    }

    const aid = amazon_account_id;
    const suggestions = new Map(); // norm(keyword) → { keyword, source, confidence, bid, match_type, reason }

    // ── 1. SearchTerms convertidos do próprio ASIN (fonte mais confiável) ─────
    const ownSearchTerms = await base44.asServiceRole.entities.SearchTerm.filter(
      { amazon_account_id: aid, advertised_asin: asin },
      '-orders_7d', 200
    );

    for (const st of ownSearchTerms) {
      const term = (st.search_term || '').trim().toLowerCase();
      if (!term || term.length < 4) continue;
      const n = norm(term);
      const orders = (st.orders_7d || 0) + (st.orders_14d || 0);
      if (orders > 0 && !suggestions.has(n)) {
        suggestions.set(n, {
          keyword: term,
          source: 'search_term_converted',
          source_label: 'Termo convertido (AUTO deste ASIN)',
          confidence: Math.min(0.95, 0.75 + (orders * 0.05)),
          bid: st.cpc ? parseFloat((st.cpc * 1.1).toFixed(2)) : 0.50,
          match_type: 'exact',
          reason: `${orders} pedido(s) em 14d — CPC médio R$${(st.cpc || 0).toFixed(2)}`,
        });
      }
    }

    // ── 2. Keywords existentes em campanhas do mesmo ASIN ─────────────────────
    const ownKeywords = await base44.asServiceRole.entities.Keyword.filter(
      { amazon_account_id: aid, asin, state: 'enabled' },
      '-orders', 300
    );
    for (const kw of ownKeywords) {
      const term = (kw.keyword_text || kw.keyword || '').trim().toLowerCase();
      if (!term) continue;
      const n = norm(term);
      if (!suggestions.has(n)) {
        suggestions.set(n, {
          keyword: term,
          source: 'existing_keyword',
          source_label: 'Keyword ativa neste ASIN',
          confidence: kw.orders > 0 ? 0.90 : 0.70,
          bid: kw.current_bid || kw.bid || 0.50,
          match_type: kw.match_type || 'exact',
          reason: kw.orders > 0
            ? `${kw.orders} pedidos — ACoS ${(kw.acos || 0).toFixed(0)}%`
            : 'Keyword ativa sem conversão ainda',
        });
      }
    }

    // ── 3. KeywordSuggestions já aprovadas/criadas para este ASIN ─────────────
    const existingSuggestions = await base44.asServiceRole.entities.KeywordSuggestion.filter(
      { amazon_account_id: aid, asin },
      '-created_at', 200
    );
    for (const s of existingSuggestions) {
      if (!['suggested', 'approved'].includes(s.status)) continue;
      const term = (s.keyword || '').trim().toLowerCase();
      if (!term) continue;
      const n = norm(term);
      if (!suggestions.has(n)) {
        suggestions.set(n, {
          keyword: term,
          source: 'ai_suggestion',
          source_label: 'Sugestão IA (pendente)',
          confidence: s.confidence || 0.80,
          bid: s.recommended_bid || 0.50,
          match_type: s.match_type || 'exact',
          reason: s.reason || 'Sugerida pela IA para este produto',
        });
      }
    }

    // ── 3.5. TermBank — banco de termos com performance comprovada ────────────
    // Busca termos do banco que: (a) vieram deste ASIN, ou (b) têm este ASIN
    // em compatible_asins, ou (c) têm título de produto ≥80% similar
    const termBankEntries = await base44.asServiceRole.entities.TermBank.filter(
      { amazon_account_id: aid }, '-performance_score', 500
    );

    for (const entry of termBankEntries) {
      const term = (entry.term || '').trim().toLowerCase();
      if (!term || term.length < 3) continue;
      const n = norm(term);
      if (suggestions.has(n)) continue; // já temos de fonte melhor

      const isOwnAsin = entry.asin === asin;
      const isCrossAsin = (entry.compatible_asins || []).includes(asin);
      const titleSim = product_name
        ? titleSimilarity(entry.product_name || '', product_name)
        : 0;

      // Incluir se: mesmo ASIN, ou compatível, ou título ≥80% similar E performance positiva
      if (isOwnAsin || isCrossAsin || (titleSim >= 0.80 && (entry.orders || 0) > 0)) {
        const confidence = isOwnAsin
          ? Math.min(0.97, 0.70 + (entry.performance_score || 0) / 100 * 0.27)
          : isCrossAsin
            ? Math.min(0.92, 0.65 + (entry.performance_score || 0) / 100 * 0.27)
            : Math.min(0.88, 0.60 + titleSim * 0.28);

        suggestions.set(n, {
          keyword: term,
          source: isOwnAsin ? 'search_term_converted' : 'cross_asin_validated',
          source_label: isOwnAsin
            ? `Banco de termos — ${entry.orders || 0} pedidos`
            : isCrossAsin
              ? `Cross-ASIN comprovado — ${entry.orders || 0} pedidos`
              : `Produto similar (${Math.round(titleSim * 100)}% compat.)`,
          confidence,
          bid: entry.bid_current || entry.cpc
            ? parseFloat(((entry.bid_current || entry.cpc || 0.50) * 1.05).toFixed(2))
            : 0.50,
          match_type: entry.match_type || 'exact',
          reason: entry.orders > 0
            ? `${entry.orders} pedidos · ACoS ${(entry.acos || 0).toFixed(0)}% · Score ${entry.performance_score || 0}/100`
            : `No banco de termos — ${entry.classification || 'novo'}`,
          _from_term_bank: true,
        });
      }
    }

    // ── 4. SearchTerms convertidos de outros ASINs com título similar ─────────
    // Só executar se o produto tem nome e se temos poucas sugestões da fonte 1
    if ((suggestions.size < 5) && product_name) {
      // Carregar todos os produtos para encontrar ASINs similares
      const allProducts = await base44.asServiceRole.entities.Product.filter(
        { amazon_account_id: aid, status: 'active' }, null, 200
      );
      const similarAsins = allProducts
        .filter(p => p.asin !== asin && titleSimilarity(p.product_name || p.display_name || '', product_name) >= 0.5)
        .map(p => p.asin)
        .slice(0, 5);

      if (similarAsins.length > 0) {
        // Buscar termos convertidos desses ASINs similares
        const crossTerms = await base44.asServiceRole.entities.SearchTerm.filter(
          { amazon_account_id: aid },
          '-orders_14d', 500
        );
        const convertedCross = crossTerms.filter(st =>
          similarAsins.includes(st.advertised_asin) &&
          (st.orders_14d || 0) > 0 &&
          !suggestions.has(norm(st.search_term || ''))
        ).slice(0, 30);

        if (convertedCross.length > 0 && product_name) {
          // Validar com Claude se esses termos fazem sentido para o produto atual
          const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });

          const termList = convertedCross.map(st =>
            `- "${st.search_term}" (${st.orders_14d} pedidos, CPC R$${(st.cpc || 0).toFixed(2)})`
          ).join('\n');

          const prompt = `Você é um especialista em Amazon Ads para o mercado brasileiro.

Produto alvo: "${product_name}" (ASIN: ${asin})

Abaixo estão termos de busca que geraram pedidos em produtos similares. Avalie quais são semanticamente compatíveis e relevantes para o produto alvo.

Termos:
${termList}

Responda APENAS com JSON no formato:
{
  "compatible": [
    { "term": "...", "reason": "...", "confidence": 0.85 }
  ]
}

Inclua apenas termos com alta probabilidade de relevância (confidence >= 0.75). Máximo 10 termos.`;

          const response = await anthropic.messages.create({
            model: 'claude-3-5-haiku-20241022',
            max_tokens: 1000,
            messages: [{ role: 'user', content: prompt }],
          });

          const raw = response.content[0]?.text || '{}';
          let parsed = {};
          try {
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
          } catch {}

          for (const item of (parsed.compatible || [])) {
            const term = (item.term || '').trim().toLowerCase();
            if (!term) continue;
            const n = norm(term);
            if (!suggestions.has(n)) {
              const srcTerm = convertedCross.find(st => norm(st.search_term || '') === n);
              suggestions.set(n, {
                keyword: term,
                source: 'cross_asin_validated',
                source_label: 'Compatível (produto similar)',
                confidence: item.confidence || 0.80,
                bid: srcTerm?.cpc ? parseFloat((srcTerm.cpc * 1.1).toFixed(2)) : 0.50,
                match_type: 'exact',
                reason: item.reason || 'Validado pela IA como compatível com este produto',
              });
            }
          }
        }
      }
    }

    // ── Ordenar e limitar resultado ────────────────────────────────────────────
    const SOURCE_PRIORITY = {
      search_term_converted: 1,
      existing_keyword: 2,
      ai_suggestion: 3,
      cross_asin_validated: 4,
    };

    const result = [...suggestions.values()]
      .sort((a, b) => {
        const pa = SOURCE_PRIORITY[a.source] || 9;
        const pb = SOURCE_PRIORITY[b.source] || 9;
        if (pa !== pb) return pa - pb;
        return (b.confidence || 0) - (a.confidence || 0);
      })
      .slice(0, 15);

    return Response.json({
      ok: true,
      asin,
      suggestions: result,
      total: result.length,
      sources: {
        search_terms_own: ownSearchTerms.filter(st => (st.orders_7d || 0) + (st.orders_14d || 0) > 0).length,
        keywords_own: ownKeywords.length,
        ai_suggestions: existingSuggestions.filter(s => ['suggested', 'approved'].includes(s.status)).length,
        cross_asin: result.filter(s => s.source === 'cross_asin_validated').length,
      },
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});