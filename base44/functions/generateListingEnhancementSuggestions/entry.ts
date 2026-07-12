/**
 * generateListingEnhancementSuggestions v2
 * Gera propostas de melhoria para título, bullets, descrição e termos orgânicos
 * usando dados reais: TermBank, SearchTerms com conversão, sugestões Amazon.
 * Para título e bullets, usa IA (Claude) com dados reais como contexto.
 *
 * REGRAS INVIOLÁVEIS:
 * - Nenhum dado fictício
 * - Nenhuma marca de terceiro
 * - Aprovação humana obrigatória antes de qualquer submissão
 * - Preço não pode ser alterado
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import Anthropic from 'npm:@anthropic-ai/sdk@0.30.1';

/**
 * BRAND SAFETY — contextos de aplicação:
 *
 * BLOQUEIO ABSOLUTO (organic_content):
 *   organic_terms, listing_title, bullet_points, description,
 *   backend_search_terms, a_plus_content
 *
 * PERMITIDO COM CONTROLE (paid_keyword):
 *   keyword paga, product targeting — marcas de terceiros são válidas
 *   como segmentação competitiva, NÃO devem aparecer no conteúdo do listing.
 *
 * Ref: Amazon Sponsored Products — keyword targeting policy.
 */
const THIRD_PARTY_BRANDS = [
  'samsung','apple','xiaomi','lg','sony','intelbras','philips','nike','adidas',
  'motorola','huawei','positivo','multilaser','britania','britânia','mondial',
  'electrolux','brastemp','consul','whirlpool','bosch','siemens','panasonic',
  'toshiba','dell','hp','lenovo','asus','acer','microsoft','google','amazon',
];

/**
 * Valida conteúdo orgânico (listing, termos orgânicos, bullets, descrição).
 * Marcas de terceiros são BLOQUEADAS neste contexto.
 */
function validateNoThirdPartyBrand(text: string): { safe: boolean; detected: string[] } {
  const normalized = (text || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[-_./]/g, ' ');
  const detected: string[] = [];
  for (const brand of THIRD_PARTY_BRANDS) {
    if (new RegExp(`\\b${brand}\\b`).test(normalized)) detected.push(brand);
  }
  return { safe: detected.length === 0, detected };
}

/**
 * Classifica uma keyword paga pelo tipo de marca envolvida.
 * Marcas de terceiros em paid keywords são PERMITIDAS como segmentação competitiva.
 * Retorna competitor_brand_keyword, own_brand_keyword ou generic_keyword.
 * NUNCA usar este resultado para conteúdo do listing — apenas para campanhas pagas.
 */
function classifyPaidKeyword(text: string, ownBrandTerms: string[] = []): {
  keyword_type: 'generic_keyword' | 'own_brand_keyword' | 'competitor_brand_keyword';
  detected_brand: string | null;
  requires_human_approval: boolean;
  allowed_match_types: string[];
  risk_level: 'low' | 'medium' | 'high';
  note: string;
} {
  const normalized = (text || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[-_./]/g, ' ');

  // Própria marca
  for (const own of ownBrandTerms) {
    if (normalized.includes(own.toLowerCase())) {
      return {
        keyword_type: 'own_brand_keyword', detected_brand: own,
        requires_human_approval: false,
        allowed_match_types: ['EXACT', 'PHRASE', 'BROAD'],
        risk_level: 'low', note: 'Keyword da própria marca — sem restrições.',
      };
    }
  }

  // Marca de terceiro (competidor)
  for (const brand of THIRD_PARTY_BRANDS) {
    if (new RegExp(`\\b${brand}\\b`).test(normalized)) {
      return {
        keyword_type: 'competitor_brand_keyword', detected_brand: brand,
        requires_human_approval: true,
        allowed_match_types: ['EXACT'], // somente EXACT para competidor
        risk_level: 'high',
        note: `Keyword contém marca concorrente "${brand}". Requer aprovação humana, campanha separada, match EXACT, bid reduzido e avaliação após 72h. NUNCA inserir a marca no listing.`,
      };
    }
  }

  return {
    keyword_type: 'generic_keyword', detected_brand: null,
    requires_human_approval: false,
    allowed_match_types: ['EXACT', 'PHRASE', 'BROAD'],
    risk_level: 'low', note: 'Keyword genérica — sem restrição de marca.',
  };
}

function buildOrganicTermProposals(params: {
  searchTerms: any[]; termBank: any[]; suggestions: any[];
  currentTerms: string[]; maxBytes?: number;
}): { terms: string[]; sources: string[]; blocked: string[] } {
  const { searchTerms, termBank, suggestions, currentTerms, maxBytes = 249 } = params;
  const candidates = new Map<string, { score: number; source: string }>();

  for (const st of searchTerms) {
    const term = (st.search_term || st.keyword_text || '').trim().toLowerCase();
    if (!term || term.length < 3) continue;
    if ((st.orders || 0) > 0 || (st.conversions || 0) > 0) {
      const score = (st.orders || 0) * 3 + (st.clicks || 0) * 0.1;
      if (!candidates.has(term) || candidates.get(term)!.score < score)
        candidates.set(term, { score, source: 'search_term_with_conversion' });
    }
  }
  for (const tb of termBank) {
    const term = (tb.keyword || tb.term || '').trim().toLowerCase();
    if (!term || term.length < 3) continue;
    const conf = Number(tb.confidence || tb.score || 0);
    if (conf >= 0.90) {
      const score = conf * 10 + (tb.orders || 0) * 2;
      if (!candidates.has(term) || candidates.get(term)!.score < score)
        candidates.set(term, { score, source: 'term_bank' });
    }
  }
  for (const s of suggestions) {
    const term = (s.keyword_text || s.suggested_keyword || '').trim().toLowerCase();
    if (!term || term.length < 3) continue;
    if (!candidates.has(term))
      candidates.set(term, { score: Number(s.score || s.rank || 0) * 0.5, source: 'amazon_suggestion' });
  }

  const sorted = Array.from(candidates.entries()).sort((a, b) => b[1].score - a[1].score);
  const selected: string[] = [];
  const sources: string[] = [];
  const blocked: string[] = [];
  let totalBytes = 0;

  for (const [term, meta] of sorted) {
    // Contexto: organic_terms → bloqueio absoluto de marcas de terceiros
    const brandCheck = validateNoThirdPartyBrand(term);
    if (!brandCheck.safe) { blocked.push(term); continue; }
    if (currentTerms.some(t => t.toLowerCase() === term)) continue;
    const termBytes = new TextEncoder().encode(term).length;
    if (totalBytes + termBytes + (selected.length > 0 ? 1 : 0) > maxBytes) continue;
    selected.push(term);
    sources.push(meta.source);
    totalBytes += termBytes + (selected.length > 1 ? 1 : 0);
  }
  return { terms: selected, sources, blocked };
}

async function generateWithAI(prompt: string, apiKey: string): Promise<string> {
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  return (msg.content[0] as any).text || '';
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, asin, proposal_types = ['organic_terms', 'title', 'bullet', 'description'] } = body;

    if (!amazon_account_id || !asin)
      return Response.json({ error: 'amazon_account_id e asin obrigatórios' }, { status: 400 });

    const snapshots = await base44.asServiceRole.entities.ListingSnapshot.filter({ amazon_account_id, asin }, '-created_at', 1);
    const snapshot = snapshots[0];
    if (!snapshot)
      return Response.json({ ok: false, error: 'Snapshot não encontrado. Execute syncListingEnhancementData primeiro.' }, { status: 404 });

    const [searchTerms, termBank, suggestions, product] = await Promise.all([
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id, asin }, '-orders', 200).catch(() => []),
      base44.asServiceRole.entities.TermBank.filter({ amazon_account_id, asin, status: 'active' }, '-score', 200).catch(() => []),
      base44.asServiceRole.entities.KeywordSuggestion.filter({ amazon_account_id, asin, status: 'ranked' }, '-score', 100).catch(() => []),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id, asin }, null, 1).then(r => r[0] || null).catch(() => null),
    ]);

    const now = new Date().toISOString();
    const proposals: any[] = [];

    let currentAttributes: any = {};
    let currentBullets: string[] = [];
    let currentTerms: string[] = [];
    try { currentAttributes = JSON.parse(snapshot.attributes || '{}'); } catch {}
    try { currentBullets = JSON.parse(snapshot.bullets || '[]'); } catch {}
    try { currentTerms = JSON.parse(snapshot.organic_terms || '[]'); } catch {}

    const productName = product?.product_name || product?.display_name || snapshot.title || 'produto';
    const topTerms = searchTerms
      .filter((st: any) => (st.orders || 0) > 0)
      .sort((a: any, b: any) => (b.orders || 0) - (a.orders || 0))
      .slice(0, 10)
      .map((st: any) => st.search_term || st.keyword_text || '');
    const topTermBankTerms = termBank
      .filter((tb: any) => Number(tb.confidence || tb.score || 0) >= 0.90)
      .slice(0, 10)
      .map((tb: any) => tb.keyword || tb.term || '');
    const allTopTerms = [...new Set([...topTerms, ...topTermBankTerms])].slice(0, 15);

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY') || '';
    const hasAI = !!apiKey;

    const upsertProposal = async (data: any) => {
      const existing = await base44.asServiceRole.entities.ListingEnhancementProposal.filter({
        amazon_account_id, asin,
        proposal_type: data.proposal_type,
        approval_status: 'draft',
      }, null, 1).catch(() => []);
      if (existing.length > 0) {
        await base44.asServiceRole.entities.ListingEnhancementProposal.update(existing[0].id, data);
        return { action: 'updated', id: existing[0].id };
      }
      const created = await base44.asServiceRole.entities.ListingEnhancementProposal.create(data);
      return { action: 'created', id: created.id };
    };

    // ── Termos Orgânicos ─────────────────────────────────────────────────────
    if (proposal_types.includes('organic_terms')) {
      const result = buildOrganicTermProposals({ searchTerms, termBank, suggestions, currentTerms });
      if (result.terms.length > 0) {
        const proposed = result.terms.join(' ');
        const brandCheck = validateNoThirdPartyBrand(proposed);
        const r = await upsertProposal({
          amazon_account_id, asin, sku: snapshot.sku, marketplace_id: snapshot.marketplace_id,
          product_id: snapshot.product_id, product_type: snapshot.product_type,
          proposal_type: 'organic_terms', field_name: 'generic_keyword',
          current_value: currentTerms.join(' '), proposed_value: proposed,
          diff: `Adicionados ${result.terms.length} termos: ${result.terms.slice(0, 5).join(', ')}${result.terms.length > 5 ? '...' : ''}`,
          source: [...new Set(result.sources)].join(','),
          rationale: `${result.terms.length} termos com alta intenção de compra a partir de dados reais (search terms com conversão, term bank, sugestões Amazon). ${result.blocked.length > 0 ? `${result.blocked.length} termos bloqueados por marca de terceiro.` : ''}`,
          data_sources: JSON.stringify({ search_terms: searchTerms.length, term_bank: termBank.length, suggestions: suggestions.length }),
          confidence: 0.92, risk: 'low',
          brand_safety_status: brandCheck.safe ? 'clear' : 'brand_review_required',
          attribute_validation_status: 'valid', schema_validation_status: 'pending',
          approval_status: 'pending_review',
          submission_status: 'not_submitted', snapshot_id: snapshot.id,
          created_at: now, updated_at: now,
        });
        proposals.push({ type: 'organic_terms', ...r });
      }
    }

    // ── Título via IA ────────────────────────────────────────────────────────
    if (proposal_types.includes('title') && hasAI && snapshot.title) {
      try {
        const titlePrompt = `Você é um especialista em SEO para Amazon Brasil.

Produto: "${productName}"
ASIN: ${asin}
Título atual: "${snapshot.title}"
Termos com conversão real: ${allTopTerms.join(', ') || 'N/A'}

Tarefa: Sugira um título otimizado para Amazon Brasil seguindo estas regras:
1. Máximo 200 caracteres
2. Inclua os termos com maior conversão real (listados acima) naturalmente
3. Mantenha a essência do produto atual — não invente características
4. NÃO mencione nenhuma marca de terceiro (Samsung, Apple, LG, Sony, etc.)
5. Não use caracteres especiais excessivos
6. Escreva em português brasileiro
7. Responda APENAS com o título sugerido, sem explicações

Título sugerido:`;

        const proposedTitle = (await generateWithAI(titlePrompt, apiKey)).trim()
          .replace(/^["']|["']$/g, '').slice(0, 200);

        if (proposedTitle && proposedTitle !== snapshot.title) {
          const brandCheck = validateNoThirdPartyBrand(proposedTitle);
          if (brandCheck.safe) {
            const r = await upsertProposal({
              amazon_account_id, asin, sku: snapshot.sku, marketplace_id: snapshot.marketplace_id,
              product_id: snapshot.product_id, product_type: snapshot.product_type,
              proposal_type: 'title', field_name: 'item_name',
              current_value: snapshot.title, proposed_value: proposedTitle,
              diff: `Título otimizado com ${topTerms.length} termos de conversão`,
              source: 'ai_with_real_data',
              rationale: `Título gerado por IA usando ${topTerms.length} termos com conversão real. Mantém as características do produto original.`,
              data_sources: JSON.stringify({ top_converting_terms: topTerms }),
              confidence: 0.78, risk: 'medium',
              brand_safety_status: 'clear',
              attribute_validation_status: 'pending', schema_validation_status: 'pending',
              approval_status: 'pending_review', submission_status: 'not_submitted',
              snapshot_id: snapshot.id, created_at: now, updated_at: now,
            });
            proposals.push({ type: 'title', ...r });
          }
        }
      } catch (e: any) {
        console.error('[generateListingEnhancementSuggestions] title AI error:', e.message);
      }
    }

    // ── Bullets via IA ───────────────────────────────────────────────────────
    if (proposal_types.includes('bullet') && hasAI) {
      try {
        const bulletPrompt = `Você é um especialista em copywriting para Amazon Brasil.

Produto: "${productName}"
ASIN: ${asin}
Título atual: "${snapshot.title || productName}"
Bullets atuais:
${currentBullets.map((b, i) => `${i + 1}. ${b}`).join('\n') || 'Nenhum bullet cadastrado'}
Termos com conversão real: ${allTopTerms.join(', ') || 'N/A'}

Tarefa: Crie 5 bullet points otimizados para Amazon Brasil seguindo estas regras:
1. Cada bullet deve ter no máximo 250 caracteres
2. Comece cada bullet com um benefício ou característica em MAIÚSCULAS
3. Inclua os termos com conversão real naturalmente
4. Mantenha APENAS características reais do produto — não invente
5. NÃO mencione nenhuma marca de terceiro
6. Escreva em português brasileiro

Responda APENAS com os 5 bullets, um por linha, sem numeração:`;

        const bulletResponse = (await generateWithAI(bulletPrompt, apiKey)).trim();
        const proposedBullets = bulletResponse.split('\n')
          .map((b: string) => b.replace(/^[-•*\d.]\s*/, '').trim())
          .filter((b: string) => b.length > 10 && b.length <= 250)
          .slice(0, 5);

        if (proposedBullets.length >= 3) {
          const proposedValue = JSON.stringify(proposedBullets);
          const brandCheck = validateNoThirdPartyBrand(proposedBullets.join(' '));
          if (brandCheck.safe) {
            const r = await upsertProposal({
              amazon_account_id, asin, sku: snapshot.sku, marketplace_id: snapshot.marketplace_id,
              product_id: snapshot.product_id, product_type: snapshot.product_type,
              proposal_type: 'bullet', field_name: 'bullet_point',
              current_value: JSON.stringify(currentBullets), proposed_value: proposedValue,
              diff: `${proposedBullets.length} bullets otimizados (antes: ${currentBullets.length})`,
              source: 'ai_with_real_data',
              rationale: `Bullets gerados por IA incorporando ${topTerms.length} termos com conversão real. Mantém características reais do produto.`,
              data_sources: JSON.stringify({ top_converting_terms: topTerms, current_bullets: currentBullets.length }),
              confidence: 0.75, risk: 'medium',
              brand_safety_status: 'clear',
              attribute_validation_status: 'pending', schema_validation_status: 'pending',
              approval_status: 'pending_review', submission_status: 'not_submitted',
              snapshot_id: snapshot.id, created_at: now, updated_at: now,
            });
            proposals.push({ type: 'bullet', ...r });
          }
        }
      } catch (e: any) {
        console.error('[generateListingEnhancementSuggestions] bullet AI error:', e.message);
      }
    }

    // ── Descrição via IA ─────────────────────────────────────────────────────
    if (proposal_types.includes('description') && hasAI && !snapshot.description) {
      try {
        const descPrompt = `Você é um especialista em copywriting para Amazon Brasil.

Produto: "${productName}"
Título: "${snapshot.title || productName}"
Termos com conversão real: ${allTopTerms.join(', ') || 'N/A'}

Tarefa: Escreva uma descrição de produto para Amazon Brasil:
1. Entre 200 e 500 caracteres
2. Destaque benefícios reais do produto
3. Inclua os termos de conversão naturalmente
4. NÃO mencione nenhuma marca de terceiro
5. Português brasileiro

Responda APENAS com a descrição:`;

        const proposedDesc = (await generateWithAI(descPrompt, apiKey)).trim().slice(0, 500);
        if (proposedDesc && proposedDesc.length >= 100) {
          const brandCheck = validateNoThirdPartyBrand(proposedDesc);
          if (brandCheck.safe) {
            const r = await upsertProposal({
              amazon_account_id, asin, sku: snapshot.sku, marketplace_id: snapshot.marketplace_id,
              product_id: snapshot.product_id, product_type: snapshot.product_type,
              proposal_type: 'description', field_name: 'product_description',
              current_value: snapshot.description || '', proposed_value: proposedDesc,
              diff: `Descrição criada (${proposedDesc.length} chars)`,
              source: 'ai_with_real_data',
              rationale: 'Descrição gerada por IA — produto sem descrição cadastrada. Incorpora termos com conversão real.',
              data_sources: JSON.stringify({ top_converting_terms: topTerms }),
              confidence: 0.72, risk: 'low',
              brand_safety_status: 'clear',
              attribute_validation_status: 'pending', schema_validation_status: 'pending',
              approval_status: 'pending_review', submission_status: 'not_submitted',
              snapshot_id: snapshot.id, created_at: now, updated_at: now,
            });
            proposals.push({ type: 'description', ...r });
          }
        }
      } catch (e: any) {
        console.error('[generateListingEnhancementSuggestions] description AI error:', e.message);
      }
    }

    return Response.json({
      ok: true, asin,
      proposals_created: proposals.filter(p => p.action === 'created').length,
      proposals_updated: proposals.filter(p => p.action === 'updated').length,
      proposals,
      ai_enabled: hasAI,
      note: 'Todas as propostas requerem aprovação humana antes de qualquer submissão à Amazon.',
    });

  } catch (error: any) {
    console.error('[generateListingEnhancementSuggestions]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});