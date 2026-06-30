/**
 * researchKeywordsForAsin — Pesquisa palavras-chave na web para um ASIN
 * Usa LLM com contexto da internet para descobrir termos relevantes
 * Classifica por relevância, intenção e tipo
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, asin, product_name, category } = body;

    if (!amazon_account_id || !asin) {
      return Response.json({ error: 'amazon_account_id and asin required' }, { status: 400 });
    }

    // Carregar produto se não fornecido
    let productName = product_name;
    let productCategory = category;

    if (!productName) {
      const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id, asin });
      if (products.length > 0) {
        productName = products[0].product_name || products[0].display_name;
        productCategory = products[0].category;
      }
    }

    if (!productName) {
      return Response.json({ error: 'Produto não encontrado. Forneça product_name.' }, { status: 404 });
    }

    // Prompt para LLM com pesquisa na web
    const prompt = `
Você é um especialista em SEO e Amazon Ads. Sua tarefa é pesquisar e identificar palavras-chave relevantes para um produto da Amazon.

PRODUTO:
- ASIN: ${asin}
- Nome: ${productName || 'Não informado'}
- Categoria: ${productCategory || 'Não informada'}

INSTRUÇÕES:
1. Pesquise na internet termos relacionados a este produto
2. Identifique sinônimos, variações e termos de cauda longa
3. Considere: uso, benefícios, problemas resolvidos, público-alvo, ambientes de uso
4. NÃO inclua marcas protegidas ou termos irrelevantes
5. Classifique cada termo por:
   - Tipo: principal, cauda_media, cauda_longa, atributo, uso, beneficio, problema, publico
   - Intencao: informacional, navegacional, comercial, transacional
   - Relevancia: 0-100 (apenas termos >= 60 devem ser listados)
   - Contexto: onde/quando o termo é usado

RETORNE APENAS JSON VÁLIDO neste formato exato:
{
  "keywords": [
    {
      "term": "termo exato",
      "type": "principal|cauda_media|cauda_longa|atributo|uso|beneficio|problema|publico",
      "intention": "informacional|navegacional|commercial|transacional",
      "relevance_score": 0-100,
      "context": "breve descrição do contexto",
      "search_volume_estimate": "baixo|medio|alto" (baseado em tendências, não invente números)
    }
  ]
}

Gere entre 20-50 palavras-chave relevantes. Foque em termos com intenção de compra.
Idioma: Português do Brasil (mercado Brazil).
`.trim();

    // Chamar LLM com contexto da internet
    const llmResult = await base44.integrations.Core.InvokeLLM({
      prompt,
      add_context_from_internet: true,
      response_json_schema: {
        type: 'object',
        properties: {
          keywords: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                term: { type: 'string' },
                type: { type: 'string' },
                intention: { type: 'string' },
                relevance_score: { type: 'number' },
                context: { type: 'string' },
                search_volume_estimate: { type: 'string' },
              },
              required: ['term', 'type', 'intention', 'relevance_score'],
            },
          },
        },
        required: ['keywords'],
      },
    });

    const keywords = llmResult.keywords || [];

    // Filtrar por relevância mínima
    const filteredKeywords = keywords.filter(k => k.relevance_score >= 60);

    // Salvar no banco
    const saved = [];
    const now = new Date().toISOString();

    for (const kw of filteredKeywords) {
      const record = await base44.asServiceRole.entities.KeywordResearch.create({
        amazon_account_id,
        asin,
        product_name: productName,
        term: kw.term,
        type: kw.type,
        intention: kw.intention,
        relevance_score: kw.relevance_score,
        context: kw.context,
        search_volume_estimate: kw.search_volume_estimate,
        source: 'web_research_llm',
        status: 'pending_review',
        created_at: now,
      });
      saved.push(record);
    }

    // Estatísticas
    const byType = {};
    const byIntention = {};
    const byRelevance = { high: 0, medium: 0, low: 0 };

    for (const kw of filteredKeywords) {
      byType[kw.type] = (byType[kw.type] || 0) + 1;
      byIntention[kw.intention] = (byIntention[kw.intention] || 0) + 1;

      if (kw.relevance_score >= 90) byRelevance.high++;
      else if (kw.relevance_score >= 75) byRelevance.medium++;
      else byRelevance.low++;
    }

    return Response.json({
      ok: true,
      asin,
      product_name: productName,
      total_keywords_found: keywords.length,
      total_keywords_saved: saved.length,
      min_relevance_threshold: 60,
      by_type: byType,
      by_intention: byIntention,
      by_relevance: byRelevance,
      keywords: filteredKeywords,
      saved_ids: saved.map(s => s.id),
      generated_at: now,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});