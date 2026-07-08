/**
 * processNewOrRestockedProductsForTermBank
 *
 * Analisa produtos novos ou recém-reabastecidos e gera 4 termos iniciais de alta qualidade
 * no Term Bank para apoiar o Kick-off. NÃO cria campanhas manuais automaticamente.
 *
 * Seguro: somente leitura e criação de termos. Não altera campanhas, bids, budgets, tokens.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const MIN_CONFIDENCE = 75;
const TERMS_PER_PRODUCT = 4;
const BATCH_SIZE = 5;
const TERM_CACHE_TTL_DAYS = 14;

// ── Utilitários ───────────────────────────────────────────────────────────────

function now() { return new Date().toISOString(); }

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

function normalizeText(t) {
  return (t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Validação de termo completo ───────────────────────────────────────────────

const INCOMPLETE_ENDINGS = ['de', 'da', 'do', 'dos', 'das', 'para', 'com', 'sem', 'em', 'por', 'a', 'e', 'ou', 'ao', 'na', 'no'];
const TRUNCATION_PATTERNS = [/autom$/i, /infra$/i, /anti$/i, /usb\s*c?$/i, /clor$/i, /micr$/i, /sens$/i, /mater$/i];

function isTermComplete(term) {
  if (!term || term.length < 8) return false;
  const words = term.trim().split(/\s+/);
  if (words.length < 2) return false;
  const lastWord = words[words.length - 1].toLowerCase();
  if (INCOMPLETE_ENDINGS.includes(lastWord)) return false;
  if (TRUNCATION_PATTERNS.some(p => p.test(term))) return false;
  // rejeitar se ultima palavra tem menos de 3 chars e não é número/unidade
  if (lastWord.length < 3 && !/^\d+[lkgmcm]*$/.test(lastWord)) return false;
  return true;
}

// ── Parser determinístico de título ──────────────────────────────────────────

function extractConceptsFromTitle(title, sku, brand, category) {
  const t = title || '';
  const norm = normalizeText(t);

  // Extrair números com unidade (13l, 5kg, 500ml, etc.)
  const measures = [...t.matchAll(/(\d+(?:[,.]\d+)?\s*(?:l|ml|kg|g|cm|mm|m|litros?|gramas?|kilos?))/gi)].map(m => m[1].toLowerCase().trim());

  // Extrair cores
  const colorWords = ['preto', 'preta', 'branco', 'branca', 'cinza', 'azul', 'vermelho', 'vermelha', 'verde', 'amarelo', 'amarela', 'roxo', 'roxa', 'rose', 'dourado', 'dourada', 'prata', 'bege', 'marrom'];
  const colors = colorWords.filter(c => norm.includes(c));

  // Extrair palavras principais (substantivos) — ignorar stopwords
  const stopwords = new Set(['com', 'para', 'sem', 'de', 'da', 'do', 'das', 'dos', 'em', 'ao', 'no', 'na', 'e', 'a', 'o', 'por', 'um', 'uma', 'seu', 'sua', 'kit', 'pack', 'unidade', 'unidades', 'peca', 'pecas', 'novo', 'nova']);
  const words = norm.split(/\s+/).filter(w => w.length > 3 && !stopwords.has(w));

  // Extrair partes diretamente do título original para manter acentuação
  const titleParts = t.split(/[,\-–|]/).map(p => p.trim()).filter(p => p.length > 5);
  const mainPart = titleParts[0] || t;

  return { measures, colors, words, mainPart, titleParts, brand: brand || '', category: category || '' };
}

function buildDeterministicTerms(title, sku, brand, category) {
  const { measures, colors, words, mainPart, titleParts } = extractConceptsFromTitle(title, sku, brand, category);

  const candidates = [];

  // Termo 1: usar as primeiras 3-5 palavras significativas do título principal
  const mainWords = mainPart.split(/\s+/);
  const keyWords = mainWords.filter(w => w.length > 2).slice(0, 5);
  if (keyWords.length >= 2) {
    candidates.push({ term: keyWords.join(' ').toLowerCase(), type: 'primary_high_conversion', base_conf: 80 });
  }

  // Termo 2: primeiro conceito + complemento (segunda parte do título se houver)
  if (titleParts.length >= 2) {
    const part2Words = titleParts[1].split(/\s+/).filter(w => w.length > 2).slice(0, 4);
    if (part2Words.length >= 2) {
      const combo = `${keyWords.slice(0, 3).join(' ')} ${part2Words.slice(0, 2).join(' ')}`.toLowerCase();
      if (combo.split(' ').length >= 3) {
        candidates.push({ term: combo, type: 'mid_tail', base_conf: 77 });
      }
    }
  }

  // Termo 3: produto + medida/tamanho se houver
  if (measures.length > 0) {
    const withMeasure = `${keyWords.slice(0, 4).join(' ')} ${measures[0]}`.toLowerCase();
    if (withMeasure.split(' ').length >= 3) {
      candidates.push({ term: withMeasure, type: 'long_tail', base_conf: 78 });
    }
  }

  // Termo 4: produto + cor se houver
  if (colors.length > 0) {
    const withColor = `${keyWords.slice(0, 4).join(' ')} ${colors[0]}`.toLowerCase();
    if (withColor.split(' ').length >= 3) {
      candidates.push({ term: withColor, type: 'alternative_purchase_intent', base_conf: 76 });
    }
  }

  // Preencher com variações se não chegou a 4
  if (candidates.length < TERMS_PER_PRODUCT && titleParts.length > 0) {
    for (const part of titleParts.slice(1, 4)) {
      if (candidates.length >= TERMS_PER_PRODUCT) break;
      const partWords = part.split(/\s+/).filter(w => w.length > 3).slice(0, 5);
      if (partWords.length >= 2) {
        candidates.push({ term: partWords.join(' ').toLowerCase(), type: 'alternative_purchase_intent', base_conf: 75 });
      }
    }
  }

  return candidates
    .filter(c => isTermComplete(c.term))
    .map(c => ({ ...c, term: c.term.trim(), confidence: c.base_conf }))
    .slice(0, TERMS_PER_PRODUCT);
}

// ── Geração de termos via IA (Claude) ────────────────────────────────────────

async function generateTermsWithAI(base44, title, asin, sku, brand, category) {
  const prompt = `Você é um especialista em Amazon Ads Brasil. Analise o título abaixo e gere exatamente 4 termos de busca de alta qualidade para o Term Bank de Amazon Sponsored Products.

PRODUTO:
Título: ${title}
ASIN: ${asin || 'N/A'}
SKU: ${sku || 'N/A'}
Marca: ${brand || 'N/A'}
Categoria: ${category || 'N/A'}

REGRAS OBRIGATÓRIAS:
1. Todos os termos em PORTUGUÊS BRASILEIRO
2. Cada termo deve ser COMPLETO e COMERCIAL (nunca cortado, nunca fragmentado)
3. Confiança mínima de 75. Preferir 85+
4. Sem termos genéricos demais, sem fragmentos, sem preposição final
5. Tipo de cada termo:
   - Termo 1 (primary_high_conversion): termo principal direto do produto
   - Termo 2 (mid_tail): produto + característica principal
   - Termo 3 (long_tail): produto + uso + atributo específico
   - Termo 4 (alternative_purchase_intent): outra expressão que o comprador usaria

EXEMPLOS DE TERMOS VÁLIDOS:
- "lixeira automática com sensor"
- "microfone de lapela sem fio"
- "organizador de malas para viagem"

EXEMPLOS INVÁLIDOS (NÃO GERAR):
- "lixeira autom" (cortado)
- "sensor infra" (incompleto)
- "cesto de" (preposição final)
- "produto premium" (genérico)

Responda SOMENTE com JSON válido no formato:
{
  "terms": [
    {"term": "...", "term_type": "primary_high_conversion", "confidence": 95, "recommended_match_type": "PHRASE"},
    {"term": "...", "term_type": "mid_tail", "confidence": 91, "recommended_match_type": "PHRASE"},
    {"term": "...", "term_type": "long_tail", "confidence": 88, "recommended_match_type": "PHRASE"},
    {"term": "...", "term_type": "alternative_purchase_intent", "confidence": 86, "recommended_match_type": "PHRASE"}
  ]
}`;

  const res = await base44.asServiceRole.integrations.Core.InvokeLLM({
    prompt,
    model: 'claude_sonnet_4_6',
    response_json_schema: {
      type: 'object',
      properties: {
        terms: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              term: { type: 'string' },
              term_type: { type: 'string' },
              confidence: { type: 'number' },
              recommended_match_type: { type: 'string' }
            }
          }
        }
      }
    }
  });

  const terms = (res?.terms || []).filter(t =>
    t.term && isTermComplete(t.term) && (t.confidence || 0) >= MIN_CONFIDENCE
  );

  return terms.slice(0, TERMS_PER_PRODUCT);
}

const MAX_SUGGESTIONS_PER_ASIN = 10;

// ── Verificar se produto já tem termos suficientes ────────────────────────────

async function hasEnoughTerms(base44, aid, asin) {
  const existing = await base44.asServiceRole.entities.TermBank.filter(
    { amazon_account_id: aid, asin, status: 'active' }, null, 10
  );
  const goodTerms = existing.filter(t => (t.confidence || 0) >= MIN_CONFIDENCE);
  return goodTerms.length >= TERMS_PER_PRODUCT;
}

// ── Verificar limite de sugestões ativas por ASIN ─────────────────────────────

async function hasReachedSuggestionLimit(base44, aid, asin) {
  const existing = await base44.asServiceRole.entities.KeywordSuggestion.filter(
    { amazon_account_id: aid, asin }, null, MAX_SUGGESTIONS_PER_ASIN + 1
  );
  const active = existing.filter(s => !['rejected', 'deleted'].includes(s.status) && s.deleted_by_user !== true);
  return active.length >= MAX_SUGGESTIONS_PER_ASIN;
}

// ── Verificar cache ───────────────────────────────────────────────────────────

async function checkCache(base44, aid, asin, titleHash) {
  try {
    const cached = await base44.asServiceRole.entities.ProductTitleTermCache.filter({
      amazon_account_id: aid, asin, title_hash: titleHash
    }, null, 1);
    if (!cached.length) return null;
    const c = cached[0];
    if (c.expires_at && new Date(c.expires_at) < new Date()) return null;
    if ((c.terms_count || 0) < TERMS_PER_PRODUCT) return null;
    return JSON.parse(c.terms_json || '[]');
  } catch { return null; }
}

async function saveCache(base44, aid, asin, sku, title, titleHash, terms, source) {
  try {
    const expires = new Date();
    expires.setDate(expires.getDate() + TERM_CACHE_TTL_DAYS);
    const existing = await base44.asServiceRole.entities.ProductTitleTermCache.filter({
      amazon_account_id: aid, asin, title_hash: titleHash
    }, null, 1);
    const payload = {
      amazon_account_id: aid, asin, sku: sku || '', title_hash: titleHash,
      product_title: title, terms_json: JSON.stringify(terms),
      terms_count: terms.length, min_confidence: Math.min(...terms.map(t => t.confidence || 0)),
      source, created_at: now(), expires_at: expires.toISOString()
    };
    if (existing.length) {
      await base44.asServiceRole.entities.ProductTitleTermCache.update(existing[0].id, payload);
    } else {
      await base44.asServiceRole.entities.ProductTitleTermCache.create(payload);
    }
  } catch { /* non-fatal */ }
}

// ── Criar termos no TermBank ──────────────────────────────────────────────────

async function saveTermsToBank(base44, aid, product, terms) {
  const nowTs = now();
  let created = 0, updated = 0;

  for (const t of terms) {
    const termNorm = normalizeText(t.term);
    // Verificar duplicata
    const existing = await base44.asServiceRole.entities.TermBank.filter({
      amazon_account_id: aid, asin: product.asin, term_normalized: termNorm
    }, null, 1);

    const payload = {
      amazon_account_id: aid,
      asin: product.asin,
      sku: product.sku || '',
      term: t.term,
      term_normalized: termNorm,
      product_name: (product.product_name || product.display_name || '').slice(0, 200),
      product_title: (product.product_name || product.display_name || '').slice(0, 500),
      match_type: (t.recommended_match_type || 'PHRASE').toLowerCase(),
      recommended_match_type: t.recommended_match_type || 'PHRASE',
      source: t.source || 'product_title_ai_analysis',
      source_detail: 'new_or_restocked_product',
      created_from: 'processNewOrRestockedProductsForTermBank',
      term_type: t.term_type || 'general',
      status: 'active',
      promotion_status: 'kickoff_candidate',
      confidence: t.confidence || MIN_CONFIDENCE,
      impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0,
      acos: 0, roas: 0, cpc: 0, ctr: 0, cvr: 0, conversion_rate: 0,
      classification: 'new',
      first_seen_at: nowTs,
      last_seen_at: nowTs,
      created_at: nowTs,
      updated_at: nowTs,
    };

    if (existing.length) {
      // Só atualizar se confidence melhorou
      if ((t.confidence || 0) > (existing[0].confidence || 0)) {
        await base44.asServiceRole.entities.TermBank.update(existing[0].id, {
          confidence: payload.confidence,
          term_type: payload.term_type,
          promotion_status: 'kickoff_candidate',
          source: payload.source,
          updated_at: nowTs,
          last_seen_at: nowTs,
        });
        updated++;
      }
    } else {
      await base44.asServiceRole.entities.TermBank.create(payload);
      created++;
    }
  }

  return { created, updated };
}

// ── Verificação pós-criação ───────────────────────────────────────────────────

async function verifyInitialTermsCreated(base44, aid, asin) {
  const terms = await base44.asServiceRole.entities.TermBank.filter({
    amazon_account_id: aid, asin, status: 'active', promotion_status: 'kickoff_candidate'
  }, null, 20);

  const valid = terms.filter(t =>
    (t.confidence || 0) >= MIN_CONFIDENCE &&
    isTermComplete(t.term) &&
    t.asin && t.term
  );

  const seen = new Set();
  const noDupes = valid.filter(t => {
    const k = normalizeText(t.term);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    ok: noDupes.length >= TERMS_PER_PRODUCT,
    count: noDupes.length,
    issues: noDupes.length < TERMS_PER_PRODUCT ? [`Apenas ${noDupes.length}/${TERMS_PER_PRODUCT} termos válidos`] : [],
  };
}

// ── Verificar elegibilidade do produto ────────────────────────────────────────

function isEligible(product, reason) {
  if (!product.asin) { reason.push('sem_asin'); return false; }
  if (!product.sku) { reason.push('sem_sku'); return false; }
  const title = product.product_name || product.display_name || '';
  if (!title || title.length < 10) { reason.push('titulo_insuficiente'); return false; }
  if (product.status === 'archived') { reason.push('arquivado'); return false; }
  if (product.inventory_status === 'out_of_stock' && !product.fba_inventory) { reason.push('sem_estoque'); return false; }
  if ((product.fba_inventory || 0) === 0 && product.inventory_status === 'out_of_stock') { reason.push('sem_estoque'); return false; }
  return true;
}

// ── Handler principal ────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  try {
    // Autenticação — aceita chamadas de automação (sem usuário) via service role
    let isAutomation = false;
    try {
      const user = await base44.auth.me();
      if (!user) isAutomation = true;
    } catch { isAutomation = true; }

    const body = await req.json().catch(() => ({}));
    const trigger = body.trigger || 'manual';
    const forceAsin = body.asin || null; // processar só um produto específico
    const dryRun = body.dry_run === true;

    // Selecionar conta
    let account = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1);
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada.' });

    const aid = account.id;
    const nowTs = now();

    // Criar registro de run
    const runRecord = await base44.asServiceRole.entities.NewProductTermBankRun.create({
      amazon_account_id: aid,
      started_at: nowTs,
      trigger,
      status: 'running',
      products_scanned: 0,
      new_products_found: 0,
      restocked_products_found: 0,
      products_processed: 0,
      terms_generated: 0,
      terms_created: 0,
      terms_updated: 0,
      terms_rejected: 0,
      ai_calls_used: 0,
      fallback_used: 0,
      products_skipped: 0,
      errors: [],
    });

    // Buscar produtos elegíveis
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    let allProducts = [];

    if (forceAsin) {
      allProducts = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid, asin: forceAsin }, null, 5);
    } else {
      // Produtos ativos com estoque
      const withStock = await base44.asServiceRole.entities.Product.filter(
        { amazon_account_id: aid, status: 'active', inventory_status: 'in_stock' }, '-updated_date', 100
      );
      // Produtos recém criados (sem filtro de estoque)
      const recent = await base44.asServiceRole.entities.Product.filter(
        { amazon_account_id: aid, status: 'active' }, '-created_date', 50
      );
      // Deduplicar por ASIN
      const seen = new Set();
      for (const p of [...withStock, ...recent]) {
        if (!seen.has(p.asin)) { seen.add(p.asin); allProducts.push(p); }
      }
    }

    const stats = {
      products_scanned: allProducts.length,
      new_products_found: 0,
      restocked_products_found: 0,
      products_processed: 0,
      terms_generated: 0,
      terms_created: 0,
      terms_updated: 0,
      terms_rejected: 0,
      ai_calls_used: 0,
      fallback_used: 0,
      products_skipped: 0,
      errors: [] as string[],
    };

    // Filtrar elegíveis
    const eligible = [];
    for (const p of allProducts) {
      const reason: string[] = [];
      if (!isEligible(p, reason)) {
        stats.products_skipped++;
        continue;
      }
      const alreadyHas = await hasEnoughTerms(base44, aid, p.asin);
      if (alreadyHas && !forceAsin) {
        stats.products_skipped++;
        continue;
      }
      // Bloquear se já atingiu o limite de sugestões ativas
      const atLimit = await hasReachedSuggestionLimit(base44, aid, p.asin);
      if (atLimit) {
        stats.products_skipped++;
        console.log(`[processNewOrRestocked] ASIN ${p.asin} no limite de ${MAX_SUGGESTIONS_PER_ASIN} sugestões — pulando.`);
        continue;
      }

      // Classificar como novo ou reabastecido
      const createdDate = p.created_date || p.created_at || '';
      const isNew = createdDate && createdDate > sevenDaysAgo && !p.has_campaign;
      const isRestocked = p.inventory_status === 'in_stock' && (p.fba_inventory || 0) > 0;

      if (isNew) stats.new_products_found++;
      else if (isRestocked) stats.restocked_products_found++;

      eligible.push(p);
    }

    // Processar em lotes
    for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
      const batch = eligible.slice(i, i + BATCH_SIZE);

      for (const product of batch) {
        const title = product.product_name || product.display_name || '';
        const titleHash = hashStr(title + (product.sku || ''));
        let terms: any[] = [];
        let termSource = 'product_title_ai_analysis';

        // Verificar cache
        const cached = await checkCache(base44, aid, product.asin, titleHash);
        if (cached && cached.length >= TERMS_PER_PRODUCT) {
          terms = cached;
          termSource = 'cache';
        } else {
          // Tentar IA
          let aiSuccess = false;
          if (!dryRun) {
            try {
              const aiTerms = await generateTermsWithAI(
                base44, title, product.asin, product.sku,
                product.brand || '', product.category || ''
              );
              if (aiTerms.length >= 2) {
                terms = aiTerms.map(t => ({ ...t, source: 'product_title_ai_analysis' }));
                stats.ai_calls_used++;
                aiSuccess = true;
              }
            } catch (e) {
              stats.errors.push(`IA falhou para ${product.asin}: ${e.message}`);
            }
          }

          // Fallback determinístico
          if (!aiSuccess || terms.length < TERMS_PER_PRODUCT) {
            const detTerms = buildDeterministicTerms(title, product.sku, product.brand, product.category);
            if (terms.length === 0) {
              terms = detTerms.map(t => ({ ...t, source: 'deterministic_title_parser' }));
              termSource = 'deterministic_title_parser';
              stats.fallback_used++;
            } else {
              // Completar com determinísticos os que faltaram
              const needed = TERMS_PER_PRODUCT - terms.length;
              const extras = detTerms.filter(d =>
                !terms.some(t => normalizeText(t.term) === normalizeText(d.term))
              ).slice(0, needed);
              terms = [...terms, ...extras.map(t => ({ ...t, source: 'deterministic_title_parser' }))];
            }
          }

          // Validar e filtrar
          terms = terms.filter(t => isTermComplete(t.term) && (t.confidence || 0) >= MIN_CONFIDENCE);
          stats.terms_rejected += (TERMS_PER_PRODUCT - Math.min(terms.length, TERMS_PER_PRODUCT));

          // Salvar cache
          if (terms.length >= 2) {
            await saveCache(base44, aid, product.asin, product.sku, title, titleHash, terms, termSource);
          }
        }

        if (terms.length === 0) {
          stats.products_skipped++;
          stats.errors.push(`Nenhum termo válido gerado para ${product.asin}`);
          // Marcar produto para retry se possível
          try {
            await base44.asServiceRole.entities.Product.update(product.id, {
              catalog_sync_status: 'pending',
            });
          } catch {}
          continue;
        }

        // Salvar no TermBank
        if (!dryRun) {
          const saveResult = await saveTermsToBank(base44, aid, product, terms);
          stats.terms_created += saveResult.created;
          stats.terms_updated += saveResult.updated;
          stats.terms_generated += terms.length;
        } else {
          stats.terms_generated += terms.length;
        }

        stats.products_processed++;

        // Verificar criação
        if (!dryRun) {
          const verification = await verifyInitialTermsCreated(base44, aid, product.asin);
          if (!verification.ok) {
            stats.errors.push(`Verificação falhou para ${product.asin}: ${verification.issues.join(', ')}`);
          }
        }

        await sleep(200); // rate limit suave
      }

      // Pausa entre lotes
      if (i + BATCH_SIZE < eligible.length) await sleep(1000);
    }

    // Finalizar run
    const finishedAt = now();
    const runStatus = stats.errors.length === 0 ? 'completed' : (stats.products_processed > 0 ? 'partial' : 'failed');
    await base44.asServiceRole.entities.NewProductTermBankRun.update(runRecord.id, {
      finished_at: finishedAt,
      status: runStatus,
      ...stats,
    });

    return Response.json({
      ok: true,
      dry_run: dryRun,
      run_id: runRecord.id,
      status: runStatus,
      stats,
      eligible_products: eligible.length,
    });

  } catch (error) {
    console.error('[processNewOrRestockedProductsForTermBank]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});