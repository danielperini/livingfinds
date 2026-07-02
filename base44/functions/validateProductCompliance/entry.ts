/**
 * validateProductCompliance — Motor de Conformidade Amazon Ads (Manual §4–18)
 *
 * Executa TODOS os filtros de política antes de qualquer criação de campanha.
 * Retorna classificação do produto + pontuação de conformidade por termo.
 *
 * Produto status: APPROVED | RESTRICTED | PROHIBITED | REVIEW_REQUIRED | INSUFFICIENT_DATA
 * Termo status:   APPROVED | REJECTED | REVIEW_REQUIRED
 *
 * Pontuação de conformidade (§9):
 *   Produto elegível              20
 *   Termo diretamente relevante   20
 *   Atributo confirmado na página 15
 *   Sem linguagem proibida        15
 *   Sem alegação enganosa         10
 *   Sem conflito de marca         10
 *   Adequado ao público geral     10
 *   Total máximo: 100 — mínimo para publicação: 100
 *
 * Separação obrigatória (§10):
 *   commercial_confidence >= 80 (da suggestProductKeywordsWithAI)
 *   policy_confidence = 100     (desta função)
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── Listas de risco (§5, §6, §7) ─────────────────────────────────────────────
const PROHIBITED_PATTERNS = [
  // Alegações médicas/saúde proibidas (§14)
  /cura\s*(garantida|total|definitiva|rapida)/i,
  /trata\s*(doenca|cancer|diabetes|ansiedade|depressao)/i,
  /elimina\s*(doenca|cancer|virus|bacteria)/i,
  /garante\s*(emagrecimento|cura|resultado|saude)/i,
  /substitui\s*(medicamento|remedio|tratamento medico)/i,
  /resultado\s*clinico\s*garantido/i,
  /sem\s*(qualquer\s*)?efeito\s*colateral/i,
  // Alegações absolutas proibidas (§6)
  /100%\s*(sem\s*risco|eficaz|garantido|comprovado)/i,
  /numero\s*[1um]\s*(do brasil|comprovado|garantido)/i,
  /melhor\s*(do brasil|do mundo|garantido)/i,
  /resultado\s*imediato\s*(garantido)?/i,
  /totalmente\s*indestrutivel/i,
  // Conteúdo adulto/violento (§5)
  /conteudo\s*adulto/i,
  /sexualmente\s*explicito/i,
  /violencia\s*explicita/i,
  // Jogos de azar (§5)
  /cassino|apostas\s*online|jogo\s*de\s*azar/i,
];

const REVIEW_REQUIRED_PATTERNS = [
  // Saúde e bem-estar (§14) — requer revisão reforçada
  /suplemento|vitamina|emagrecimento|dieta|detox|imunidade|colesterol|glicemia|pressao\s*arterial/i,
  // Marcas de terceiros (§15)
  /compativel\s*com|para\s*uso\s*com|substituto\s*de/i,
  // Álcool (§5)
  /bebida\s*alcoolica|cerveja|vinho|whisky|vodka/i,
  // Armas (§5)
  /arma\s*de\s*fogo|municao|pistola|rifle/i,
  // Garantias absolutas não comprovadas
  /garantia\s*(vitalicia|total|absoluta)/i,
  /resultado\s*(garantido|assegurado)/i,
];

const OFFENSIVE_WORDS = [
  /palavrao|palavroes|ofensa|discrimina|preconceito|racista|sexista/i,
];

// Categorias proibidas para publicidade automática (§5)
const PROHIBITED_CATEGORIES = [
  'adult', 'gambling', 'weapons', 'illegal_drugs', 'tobacco', 'prescription_drugs',
];

// Categorias que requerem revisão (§5)
const RESTRICTED_CATEGORIES = [
  'health', 'beauty', 'supplements', 'alcohol', 'baby', 'medical_devices',
  'financial_services', 'real_estate',
];

// ── Normalizar texto ───────────────────────────────────────────────────────────
function norm(str) {
  return (str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Classificar produto (§4) ──────────────────────────────────────────────────
function classifyProduct(product) {
  if (!product) return { status: 'INSUFFICIENT_DATA', reason: 'Produto não encontrado' };

  const title    = norm(product.product_name || product.display_name || '');
  const category = (product.category || '').toLowerCase();

  // Verificar categorias proibidas
  for (const cat of PROHIBITED_CATEGORIES) {
    if (category.includes(cat)) return { status: 'PROHIBITED', reason: `Categoria proibida para publicidade automática: ${cat}` };
  }

  // Verificar padrões proibidos no título
  for (const pat of PROHIBITED_PATTERNS) {
    if (pat.test(title)) return { status: 'PROHIBITED', reason: `Conteúdo proibido detectado no título: "${title.match(pat)?.[0]}"` };
  }

  // Verificar categorias restritas
  for (const cat of RESTRICTED_CATEGORIES) {
    if (category.includes(cat)) return { status: 'RESTRICTED', reason: `Categoria restrita — requer revisão adicional: ${cat}` };
  }

  // Verificar padrões de revisão requerida no título
  for (const pat of REVIEW_REQUIRED_PATTERNS) {
    if (pat.test(title)) return { status: 'REVIEW_REQUIRED', reason: `Conteúdo de risco detectado — requer revisão humana: "${title.match(pat)?.[0]}"` };
  }

  // Dados insuficientes
  if (!title || title.length < 5) return { status: 'INSUFFICIENT_DATA', reason: 'Título do produto insuficiente para análise de conformidade' };

  return { status: 'APPROVED', reason: 'Produto passou em todos os filtros de conformidade' };
}

// ── Validar termo via 7 filtros (§8) ─────────────────────────────────────────
function validateTerm(term, product, existingKeywords = [], negativeKeywords = []) {
  const nTerm    = norm(term);
  const title    = norm(product.product_name || product.display_name || '');
  const category = norm(product.category || '');
  const titleWords = new Set(title.split(' ').filter(w => w.length > 2));

  const result = {
    term,
    policy_confidence: 100,
    status: 'APPROVED',
    block_reason: null,
    filters: {
      relevance: 'PASSED',
      page_match: 'PASSED',
      policy: 'PASSED',
      trademark: 'PASSED',
      intent: 'PASSED',
      confidence: 'PASSED',
      duplicate: 'PASSED',
    },
    audit: {
      prohibited_pattern: null,
      review_pattern: null,
      trademark_detected: false,
      health_flag: false,
    },
  };

  // Filtro 7 — Duplicidade (§8 F7)
  const normTerm = nTerm;
  if (negativeKeywords.some(n => norm(n) === normTerm)) {
    result.status = 'REJECTED';
    result.policy_confidence = 0;
    result.block_reason = 'IRRELEVANT_TERM: termo está na lista de palavras-chave negativas';
    result.filters.duplicate = 'FAILED';
    return result;
  }
  if (existingKeywords.some(e => norm(e) === normTerm)) {
    result.status = 'REJECTED';
    result.policy_confidence = 0;
    result.block_reason = 'Termo já existe como keyword ativa (duplicata)';
    result.filters.duplicate = 'FAILED';
    return result;
  }

  // Filtro 3 — Política: padrões proibidos (§8 F3)
  for (const pat of PROHIBITED_PATTERNS) {
    if (pat.test(nTerm)) {
      result.status = 'REJECTED';
      result.policy_confidence = 0;
      result.block_reason = `MISLEADING_CLAIM ou PROHIBITED: conteúdo proibido detectado — "${nTerm.match(pat)?.[0]}"`;
      result.filters.policy = 'FAILED';
      result.audit.prohibited_pattern = nTerm.match(pat)?.[0] || null;
      return result; // falha crítica — retorno imediato (§9)
    }
  }

  // Filtro 3 — Linguagem ofensiva (§8 F3)
  for (const pat of OFFENSIVE_WORDS) {
    if (pat.test(nTerm)) {
      result.status = 'REJECTED';
      result.policy_confidence = 0;
      result.block_reason = 'OFFENSIVE_TERM: linguagem ofensiva ou discriminatória detectada';
      result.filters.policy = 'FAILED';
      return result;
    }
  }

  // Filtro 4 — Marca registada de terceiros (§8 F4, §15)
  // Heurística: termo contém palavras que não aparecem no título do produto E parecem ser marca
  const termWords = nTerm.split(' ');
  const unknownBrandWords = termWords.filter(w =>
    w.length > 3 &&
    !titleWords.has(w) &&
    !category.includes(w) &&
    /^[a-z]+[0-9]*$/.test(w) && // padrão de marca
    !['para', 'com', 'de', 'em', 'por', 'tipo', 'modo', 'uso'].includes(w)
  );
  // Se > 50% das palavras do termo são "desconhecidas", pode ser marca de terceiro
  if (unknownBrandWords.length > 0 && unknownBrandWords.length / termWords.length > 0.5 && termWords.length > 2) {
    result.status = 'REVIEW_REQUIRED';
    result.policy_confidence = 70;
    result.block_reason = `TRADEMARK_RISK: termo "${term}" pode conter referência a marca de terceiro — requer revisão humana (§15)`;
    result.filters.trademark = 'REVIEW_REQUIRED';
    result.audit.trademark_detected = true;
    return result;
  }

  // Filtro 3 — Padrões que requerem revisão (§8 F3)
  for (const pat of REVIEW_REQUIRED_PATTERNS) {
    if (pat.test(nTerm)) {
      result.status = 'REVIEW_REQUIRED';
      result.policy_confidence = 60;
      result.block_reason = `REVIEW_REQUIRED: termo contém conteúdo de risco — "${nTerm.match(pat)?.[0]}"`;
      result.filters.policy = 'REVIEW_REQUIRED';
      result.audit.review_pattern = nTerm.match(pat)?.[0] || null;
      result.audit.health_flag = /suplemento|vitamina|emagrecimento|dieta|imunidade|colesterol|glicemia/.test(nTerm);
      return result;
    }
  }

  // Filtro 1 — Relevância: termo deve ter pelo menos 1 palavra do título (§8 F1)
  const termHasTitleWord = termWords.some(w => w.length > 3 && titleWords.has(w));
  if (!termHasTitleWord && title.length > 5) {
    result.policy_confidence -= 20;
    result.filters.relevance = 'WARN';
    // Não bloqueia, mas reduz pontuação
  }

  // Filtro 2 — Correspondência com a página (§8 F2): termos com números/tamanhos que não existem no título
  const termNumbers = nTerm.match(/\d+\s*(ml|l|litro|kg|g|cm|mm|m\b|pol|polegada)/g) || [];
  const titleNumbers = title.match(/\d+\s*(ml|l|litro|kg|g|cm|mm|m\b|pol|polegada)/g) || [];
  if (termNumbers.length > 0 && titleNumbers.length > 0) {
    const termNumNorm = termNumbers.map(n => n.replace(/\s/g, ''));
    const titleNumNorm = titleNumbers.map(n => n.replace(/\s/g, ''));
    const hasConflict = termNumNorm.some(n => !titleNumNorm.some(tn => tn.startsWith(n.slice(0, 3))));
    if (hasConflict) {
      result.status = 'REJECTED';
      result.policy_confidence = 0;
      result.block_reason = `UNSUPPORTED_ATTRIBUTE: atributo numérico "${termNumbers[0]}" não corresponde à página do produto (título: "${titleNumbers[0] || 'sem medida'}")`;
      result.filters.page_match = 'FAILED';
      return result;
    }
  }

  // Filtro 5 — Intenção comercial (§8 F5): termos extremamente genéricos
  const GENERIC_TERMS = ['produto', 'item', 'coisa', 'objeto', 'mercadoria', 'artigo'];
  if (GENERIC_TERMS.some(g => normTerm === g || normTerm === `${g}s`)) {
    result.status = 'REJECTED';
    result.policy_confidence = 0;
    result.block_reason = 'IRRELEVANT_TERM: termo demasiado genérico sem intenção comercial';
    result.filters.intent = 'FAILED';
    return result;
  }

  // Calcular pontuação final (§9)
  let score = 0;
  score += 20; // produto elegível (já validado antes de chegar aqui)
  score += termHasTitleWord ? 20 : 0; // relevância
  score += (termNumbers.length === 0 || titleNumbers.length > 0) ? 15 : 0; // atributo confirmado
  score += 15; // sem linguagem proibida (passou filtro 3)
  score += 10; // sem alegação enganosa (passou padrões proibidos)
  score += result.filters.trademark === 'PASSED' ? 10 : 0; // sem conflito de marca
  score += 10; // adequado ao público geral (sem padrões de restrição)

  result.policy_confidence = Math.min(score, 100);

  // Regra: policy_confidence deve ser 100 para publicação automática (§10)
  if (result.policy_confidence < 100) {
    result.status = 'REVIEW_REQUIRED';
    result.block_reason = `Pontuação de conformidade ${result.policy_confidence}/100 — abaixo do mínimo de 100 para publicação automática`;
  }

  return result;
}

// ── Validar via Claude (para produtos com dados insuficientes ou REVIEW_REQUIRED) ──
async function validateWithClaude(product, terms) {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return null;

  const title = product.product_name || product.display_name || '';
  const category = product.category || '';

  const prompt = `Você é especialista em políticas de publicidade da Amazon Brasil (amazon.com.br).

Analise o produto e os termos de pesquisa abaixo. Para cada termo, responda se está APPROVED, REJECTED ou REVIEW_REQUIRED segundo as políticas da Amazon Ads.

PRODUTO:
- Título: ${title}
- Categoria: ${category}
- ASIN: ${product.asin}

TERMOS PARA ANÁLISE (máximo 10):
${terms.slice(0, 10).map((t, i) => `${i + 1}. "${t}"`).join('\n')}

REGRAS OBRIGATÓRIAS:
1. REJECTED se: conteúdo proibido, alegação médica não comprovada, linguagem ofensiva, marca concorrente de forma enganosa, atributo inexistente no produto
2. REVIEW_REQUIRED se: saúde/bem-estar, marca de terceiro legítima, alegação que requer comprovação
3. APPROVED se: descreve factualmente o produto, relevante para o público, sem riscos de política

Responda APENAS em JSON válido:
{
  "product_assessment": "APPROVED|RESTRICTED|PROHIBITED|REVIEW_REQUIRED",
  "product_reason": "motivo em português",
  "terms": [
    {"term": "...", "status": "APPROVED|REJECTED|REVIEW_REQUIRED", "reason": "motivo breve em português", "block_code": "PROHIBITED_PATTERN|MISLEADING_CLAIM|TRADEMARK_RISK|IRRELEVANT_TERM|APPROVED|null"}
  ]
}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1500,
      temperature: 0.1,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) return null;
  const data = await res.json();
  const text = (data.content?.[0]?.text || '').trim();
  try {
    const parsed = JSON.parse(text);
    return parsed;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch {} }
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
Deno.serve(async (req) => {
  const startTime = Date.now();
  const base44 = createClientFromRequest(req);

  try {
    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, asin, product_id, terms = [], use_claude = false } = body;

    if (!asin && !product_id) {
      return Response.json({ ok: false, error: 'asin ou product_id obrigatório' }, { status: 400 });
    }

    // Resolver conta
    let account = null;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id });
      account = accs[0] || null;
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
    }

    const aid = account?.id;

    // Carregar produto
    let product = null;
    if (product_id) {
      const prods = await base44.asServiceRole.entities.Product.filter({ id: product_id });
      product = prods[0] || null;
    }
    if (!product && asin && aid) {
      const prods = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid, asin });
      product = prods[0] || null;
    }
    if (!product) {
      return Response.json({ ok: false, error: `Produto não encontrado: ${asin || product_id}` });
    }

    // Carregar keywords existentes para deduplicação
    const [existingKws, negativeKws] = aid ? await Promise.all([
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid, asin, state: 'enabled' }, null, 200)
        .then(kws => kws.map(k => k.keyword_text || k.keyword || '')).catch(() => []),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid, asin, state: 'archived' }, null, 200)
        .then(kws => kws.map(k => k.keyword_text || k.keyword || '')).catch(() => []),
    ]) : [[], []];

    // ── 1. Classificar produto ────────────────────────────────────────────
    const productClassification = classifyProduct(product);

    // ── 2. Validar cada termo pelos 7 filtros ─────────────────────────────
    const termResults = terms.map(term => validateTerm(term, product, existingKws, negativeKws));

    // ── 3. Se solicitado ou necessário: validação Claude ──────────────────
    let claudeResult = null;
    const needsClaude = use_claude ||
      productClassification.status === 'REVIEW_REQUIRED' ||
      termResults.some(t => t.status === 'REVIEW_REQUIRED');

    if (needsClaude && terms.length > 0) {
      claudeResult = await validateWithClaude(product, terms).catch(() => null);

      // Enriquecer resultados com avaliação Claude
      if (claudeResult?.terms) {
        for (const tr of termResults) {
          const claudeTerm = claudeResult.terms.find(ct => norm(ct.term) === norm(tr.term));
          if (claudeTerm) {
            // Claude tem voto de desempate para REVIEW_REQUIRED
            if (tr.status === 'REVIEW_REQUIRED' && claudeTerm.status === 'APPROVED') {
              tr.status = 'APPROVED';
              tr.policy_confidence = 100;
              tr.block_reason = null;
              tr.filters.policy = 'PASSED';
              tr.audit.claude_override = 'APPROVED por revisão Claude';
            } else if (claudeTerm.status === 'REJECTED') {
              tr.status = 'REJECTED';
              tr.policy_confidence = 0;
              tr.block_reason = claudeTerm.reason || 'REJECTED por revisão Claude';
              tr.audit.claude_override = `REJECTED: ${claudeTerm.block_code || 'policy_violation'}`;
            }
          }
        }
        // Atualizar classificação do produto com avaliação Claude
        if (claudeResult.product_assessment && productClassification.status === 'REVIEW_REQUIRED') {
          productClassification.status = claudeResult.product_assessment;
          productClassification.reason = claudeResult.product_reason || productClassification.reason;
          productClassification.claude_assessed = true;
        }
      }
    }

    // ── 4. Sumário ────────────────────────────────────────────────────────
    const approved = termResults.filter(t => t.status === 'APPROVED');
    const rejected = termResults.filter(t => t.status === 'REJECTED');
    const review   = termResults.filter(t => t.status === 'REVIEW_REQUIRED');

    // Motivos de bloqueio (§24)
    const blockReasons = [...new Set(
      [...rejected, ...review]
        .map(t => t.block_reason)
        .filter(Boolean)
    )];

    return Response.json({
      ok: true,
      product: {
        asin: product.asin,
        sku: product.sku,
        title: product.product_name || product.display_name,
        status: productClassification.status,
        reason: productClassification.reason,
        can_create_campaign: productClassification.status === 'APPROVED',
        claude_assessed: productClassification.claude_assessed || false,
      },
      terms: termResults,
      summary: {
        total: termResults.length,
        approved: approved.length,
        rejected: rejected.length,
        review_required: review.length,
        eligible_for_campaign: approved.length > 0 && productClassification.status === 'APPROVED',
        block_reasons: blockReasons,
      },
      policy_rules: {
        min_commercial_confidence: 80,
        required_policy_confidence: 100,
        marketplace: 'amazon.com.br',
        language: 'pt-BR',
        currency: 'BRL',
      },
      duration_ms: Date.now() - startTime,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});