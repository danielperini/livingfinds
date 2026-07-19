/**
 * Cross-ASIN Transfer Engine — Identifica keywords vencedoras em um ASIN
 * e calcula relevância para transferência para outros ASINs da mesma loja.
 *
 * Pipeline:
 *  1. Varrer KeywordBank buscando WINNER/STRONG_WINNER
 *  2. Buscar ASINs destino elegíveis (ativos, com estoque)
 *  3. Relevance Score híbrido (heurística + LLM zona cinzenta 70-95%)
 *  4. Hard Blockers detection
 *  5. Regra dos 90%: criar CrossAsinTransfer e (se auto-level) campanha de validação
 *  6. ProductFamilyKeywordBank: registrar winners multi-ASIN
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const RULE_VERSION = '1.0';
const MIN_SOURCE_ORDERS = 3;
const TRANSFER_RELEVANCE_MIN = 90;
const MANUAL_REVIEW_MIN = 80;
const HEURISTIC_HIGH_CONF = 95;
const HEURISTIC_LOW_CONF = 70;
const MAX_TRANSFERS_PER_DAY = 5;
const DEST_BID_FACTOR = 0.85; // 85% do sustainable CPC destino vs CPC real fonte

function normalizeText(s: string): string {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function tokenize(s: string): Set<string> {
  const stopWords = new Set(['de','da','do','para','com','sem','uma','um','os','as','o','a','e','em','no','na','por','que','se','ao','pela','pelo','das','dos','mais']);
  return new Set(normalizeText(s).split(' ').filter(t => t.length >= 2 && !stopWords.has(t)));
}

// Heurística de relevância (0-100)
function calcHeuristicScore(
  kwText: string,
  sourceTitle: string, sourceBullets: string, sourceCategory: string,
  destTitle: string, destBullets: string, destCategory: string,
): { score: number; breakdown: Record<string, number> } {

  const kwTokens = tokenize(kwText);
  const srcTokens = tokenize(sourceTitle + ' ' + sourceBullets + ' ' + sourceCategory);
  const dstTokens = tokenize(destTitle + ' ' + destBullets + ' ' + destCategory);

  if (kwTokens.size === 0 || dstTokens.size === 0) return { score: 0, breakdown: {} };

  // 1. Tipo/função principal (35pts) — sobreposição categoria + tokens principais
  const catSrc = normalizeText(sourceCategory);
  const catDst = normalizeText(destCategory);
  const catOverlap = catSrc && catDst
    ? tokenize(catSrc).size > 0
      ? [...tokenize(catSrc)].filter(t => tokenize(catDst).has(t)).length / Math.max(tokenize(catSrc).size, 1)
      : 0
    : 0;
  const cat35 = Math.round(catOverlap * 35);

  // 2. Caso de uso (20pts) — tokens da keyword presentes no destino
  let kwInDst = 0;
  for (const t of kwTokens) { if (dstTokens.has(t)) kwInDst++; }
  const use20 = Math.round((kwInDst / Math.max(kwTokens.size, 1)) * 20);

  // 3. Atributos compatíveis (15pts) — tokens src ∩ dst
  const attrOverlap = [...srcTokens].filter(t => dstTokens.has(t)).length;
  const attr15 = Math.min(15, Math.round((attrOverlap / Math.max(srcTokens.size, 1)) * 20));

  // 4. Mesma categoria (10pts) — já calculado em cat35, mas bônus explícito
  const cat10 = catSrc === catDst ? 10 : catOverlap >= 0.6 ? 6 : 0;

  // 5. Compatibilidade atributos específicos (10pts) — tokens de alta relevância
  const highRelevanceTokens = ['automatica','automatico','sensor','eletrico','eletrica','inox','led',
    'recarregavel','bivolt','portatil','sem','fio','digital','inteligente'];
  const srcHigh = new Set(highRelevanceTokens.filter(t => srcTokens.has(t)));
  const dstHigh = new Set(highRelevanceTokens.filter(t => dstTokens.has(t)));
  const highMatch = [...srcHigh].filter(t => dstHigh.has(t)).length;
  const compat10 = srcHigh.size > 0 ? Math.round((highMatch / srcHigh.size) * 10) : 5;

  // 6. Similaridade semântica geral título+bullets (10pts)
  const titleSrcT = tokenize(sourceTitle);
  const titleDstT = tokenize(destTitle);
  const titleOver = [...titleSrcT].filter(t => titleDstT.has(t)).length;
  const sem10 = Math.min(10, Math.round((titleOver / Math.max(titleSrcT.size, 1)) * 15));

  const total = cat35 + use20 + attr15 + cat10 + compat10 + sem10;

  return {
    score: Math.min(100, Math.max(0, total)),
    breakdown: { cat35, use20, attr15, cat10, compat10, sem10 },
  };
}

// Hard Blockers
function detectHardBlockers(
  kwText: string,
  srcTitle: string, dstTitle: string,
  srcBullets: string, dstBullets: string,
): { blocked: boolean; reason: string } {

  const kw = normalizeText(kwText);
  const srcFull = normalizeText(srcTitle + ' ' + srcBullets);
  const dstFull = normalizeText(dstTitle + ' ' + dstBullets);

  // Voltagem incompatível
  const voltages = ['110v','220v','bivolt','110','220'];
  const srcVolt = voltages.find(v => srcFull.includes(v));
  const dstVolt = voltages.find(v => dstFull.includes(v));
  if (srcVolt && dstVolt && srcVolt !== dstVolt && !(srcVolt.includes('bivolt') || dstVolt.includes('bivolt'))) {
    return { blocked: true, reason: `Voltagem incompatível: ${srcVolt} vs ${dstVolt}` };
  }

  // Gênero incompatível (quando essencial)
  const masculine = ['masculino','masc','homem','homens','men'];
  const feminine  = ['feminino','fem','mulher','mulheres','women'];
  const srcMasc = masculine.some(t => srcFull.includes(t));
  const srcFem  = feminine.some(t => srcFull.includes(t));
  const dstMasc = masculine.some(t => dstFull.includes(t));
  const dstFem  = feminine.some(t => dstFull.includes(t));
  if ((srcMasc && dstFem) || (srcFem && dstMasc)) {
    return { blocked: true, reason: 'Gênero incompatível detectado' };
  }

  // Categorias completamente diferentes
  const electronicsTerms = ['impressora','computador','notebook','celular','smartphone','tablet','monitor'];
  const kitchenTerms     = ['panela','frigideira','liqüidificador','liquidificador','batedeira'];
  const srcElec = electronicsTerms.some(t => srcFull.includes(t));
  const dstKit  = kitchenTerms.some(t => dstFull.includes(t));
  const srcKit  = kitchenTerms.some(t => srcFull.includes(t));
  const dstElec = electronicsTerms.some(t => dstFull.includes(t));
  if ((srcElec && dstKit) || (srcKit && dstElec)) {
    return { blocked: true, reason: 'Categorias funcionais completamente diferentes' };
  }

  return { blocked: false, reason: '' };
}

// Sustainable CPC destino
function destSustainableCpc(destAov: number, expectedCvr: number, targetAcos: number): number {
  if (destAov <= 0 || targetAcos <= 0) return 0;
  const cvr = expectedCvr > 0 ? expectedCvr : 0.05; // fallback 5% se desconhecido
  return parseFloat((destAov * cvr * (targetAcos / 100)).toFixed(2));
}

// LLM Relevance via ANTHROPIC_API_KEY
async function llmValidateRelevance(
  kwText: string,
  srcTitle: string, srcBullets: string,
  dstTitle: string, dstBullets: string,
  heuristicScore: number,
): Promise<{ score: number; reason: string; hard_blocker: boolean; hard_blocker_reason: string }> {

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return { score: heuristicScore, reason: 'ANTHROPIC_API_KEY não configurado', hard_blocker: false, hard_blocker_reason: '' };

  const prompt = `Você é um especialista em Amazon Ads. Avalie se a keyword abaixo (vencedora no ASIN ORIGEM) é relevante para o ASIN DESTINO para fins de publicidade.

KEYWORD: "${kwText}"

ASIN ORIGEM:
Título: ${srcTitle}
Bullets: ${srcBullets.slice(0, 500)}

ASIN DESTINO:
Título: ${dstTitle}
Bullets: ${dstBullets.slice(0, 500)}

Responda em JSON:
{
  "relevance_score": (0-100, onde 90+ = transferência recomendada),
  "reasoning": "explicação em 1-2 frases",
  "hard_blocker": false ou true,
  "hard_blocker_reason": "razão se hard_blocker=true, senão vazio"
}

Hard Blockers que eliminam a transferência: incompatibilidade funcional, marca específica diferente, modelo incompatível, tamanho essencial incompatível, voltagem incompatível, gênero/idade incompatível quando essencial.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: Deno.env.get('AI_WEEKLY_REVIEW_MODEL') || 'claude-3-5-haiku-20241022',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}`);
    const data = await res.json();
    const text = data?.content?.[0]?.text || '{}';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('JSON não encontrado na resposta');
    const parsed = JSON.parse(match[0]);
    return {
      score: Number(parsed.relevance_score || heuristicScore),
      reason: String(parsed.reasoning || ''),
      hard_blocker: Boolean(parsed.hard_blocker),
      hard_blocker_reason: String(parsed.hard_blocker_reason || ''),
    };
  } catch (e: any) {
    return { score: heuristicScore, reason: `LLM erro: ${e.message}`, hard_blocker: false, hard_blocker_reason: '' };
  }
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body   = await req.json().catch(() => ({}));
    const { amazon_account_id, dry_run = false, source_asin_filter } = body;

    // Resolver conta
    let account: any;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
      account = accs[0];
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({}, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta configurada' }, { status: 404 });

    const accountId = account.id;
    const now   = new Date().toISOString();
    const today = now.slice(0, 10);

    // Carregar configurações
    const [perfList, economicsList] = await Promise.all([
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, null, 1).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: accountId }, null, 500).catch(() => []),
    ]);
    const perf = perfList[0] || {};
    const targetAcos = Number(perf.target_acos || 15);
    const minBid = Number(perf.min_bid || 0.25);
    const maxBid = Number(perf.max_bid || 2.5);

    // Economics por ASIN
    const econMap = new Map<string, any>();
    for (const e of economicsList) { if (e.asin) econMap.set(e.asin, e); }

    // Carregar winners do KeywordBank
    const kwBankFilter: any = {
      amazon_account_id: accountId,
      lifecycle_status: 'WINNER',
    };
    if (source_asin_filter) kwBankFilter.asin = source_asin_filter;

    const winnerEntries = await base44.asServiceRole.entities.KeywordBank.filter(
      kwBankFilter, '-promotion_score', 200
    ).catch(() => []);

    // Filtrar: orders >= min_source_orders, ACoS <= target, confidence >= MEDIUM
    const qualifiedWinners = winnerEntries.filter((w: any) =>
      Number(w.orders || 0) >= MIN_SOURCE_ORDERS &&
      Number(w.acos || 0) > 0 &&
      Number(w.acos || 0) <= targetAcos &&
      ['MEDIUM', 'HIGH', 'VERY_HIGH'].includes(w.source_confidence || '') &&
      ['WINNER', 'STRONG_WINNER'].includes(w.winner_tier || '')
    );

    // Carregar todos os produtos ativos
    const allProducts = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id: accountId, status: 'active' }, null, 500
    ).catch(() => []);
    const activeAsins = new Set<string>(allProducts.filter((p: any) => Number(p.fba_inventory || 0) > 0).map((p: any) => p.asin));

    // Carregar ListingSnapshots
    const allSnapshots = await base44.asServiceRole.entities.ListingSnapshot.filter(
      { amazon_account_id: accountId }, null, 500
    ).catch(() => []);
    const snapshotMap = new Map<string, any>();
    for (const s of allSnapshots) { if (s.asin) snapshotMap.set(s.asin, s); }

    // Carregar KeywordBank existente para dedup de destino
    const existingBankEntries = await base44.asServiceRole.entities.KeywordBank.filter(
      { amazon_account_id: accountId }, null, 2000
    ).catch(() => []);
    // keyword_hash = marketplace|asin|normalized|matchType|job
    const existingBankHashes = new Set<string>(existingBankEntries.map((e: any) => e.keyword_hash).filter(Boolean));

    // Carregar transferências criadas hoje (limit MAX_TRANSFERS_PER_DAY)
    const transfersToday = await base44.asServiceRole.entities.CrossAsinTransfer.filter(
      { amazon_account_id: accountId, cycle_date: today }, null, 50
    ).catch(() => []);
    let transfersCreatedToday = transfersToday.length;

    // ProductFamilyKeywordBank existente
    const familyBankEntries = await base44.asServiceRole.entities.ProductFamilyKeywordBank.filter(
      { amazon_account_id: accountId }, null, 500
    ).catch(() => []);
    const familyBankMap = new Map<string, any>();
    for (const f of familyBankEntries) {
      const key = `${f.family_name}|${f.normalized_keyword || (f.keyword || '').toLowerCase()}`;
      familyBankMap.set(key, f);
    }

    const results: any[] = [];
    const doNotTransfer: any[] = [];
    const manualReview: any[] = [];
    const familyBankUpdates: any[] = [];

    for (const winner of qualifiedWinners) {
      if (transfersCreatedToday >= MAX_TRANSFERS_PER_DAY && !dry_run) break;

      const srcAsin     = winner.asin;
      const kwText      = winner.keyword;
      const normKw      = winner.normalized_keyword || kwText.toLowerCase().trim();
      const srcSnapshot = snapshotMap.get(srcAsin);

      const srcTitle    = srcSnapshot?.title || '';
      const srcBullets  = (() => { try { return JSON.parse(srcSnapshot?.bullets || '[]').join(' '); } catch { return srcSnapshot?.bullets || ''; } })();
      const srcCategory = srcSnapshot?.product_type || '';
      const srcProduct  = allProducts.find((p: any) => p.asin === srcAsin);
      const srcCpc      = Number(winner.cpc || 0);

      // Destinos elegíveis: outros ASINs ativos com estoque
      const destAsins = [...activeAsins].filter(a =>
        a !== srcAsin &&
        !existingBankHashes.has(`BR|${a}|${normKw}|exact|VALIDATION`) &&
        !existingBankHashes.has(`BR|${a}|${normKw}|exact|PROFIT`) &&
        !existingBankHashes.has(`BR|${a}|${normKw}|exact|SCALE`)
      );

      for (const destAsin of destAsins) {
        const destSnapshot = snapshotMap.get(destAsin);
        if (!destSnapshot) continue;

        const destTitle   = destSnapshot.title || '';
        const destBullets = (() => { try { return JSON.parse(destSnapshot.bullets || '[]').join(' '); } catch { return destSnapshot.bullets || ''; } })();
        const destCategory= destSnapshot.product_type || '';
        const destProduct = allProducts.find((p: any) => p.asin === destAsin);
        const destEcon    = econMap.get(destAsin);
        const destAov     = Number(destEcon?.average_sale_price || destEcon?.current_price || destProduct?.price || 0);
        const destTargetAcos = Number(destEcon?.target_acos || targetAcos);

        // Hard Blockers heurísticos
        const blocker = detectHardBlockers(kwText, srcTitle, destTitle, srcBullets, destBullets);
        if (blocker.blocked) {
          doNotTransfer.push({
            source_asin: srcAsin, destination_asin: destAsin,
            keyword: kwText, rule_id: 'CROSS_ASIN_BLOCK_HARD_BLOCKER',
            reason: blocker.reason,
          });
          continue;
        }

        // Heurística
        const { score: heuristicScore, breakdown } = calcHeuristicScore(
          kwText, srcTitle, srcBullets, srcCategory, destTitle, destBullets, destCategory
        );

        // Fase decisão
        let finalScore = heuristicScore;
        let relevancePhase: string = 'HEURISTIC_ONLY';
        let llmScore: number | null = null;
        let llmReason = '';
        let hardBlockerFromLlm = false;
        let hardBlockerLlmReason = '';

        if (heuristicScore < HEURISTIC_LOW_CONF) {
          // Score < 70 → DO_NOT_TRANSFER sem LLM
          doNotTransfer.push({
            source_asin: srcAsin, destination_asin: destAsin,
            keyword: kwText, heuristic_score: heuristicScore,
            rule_id: 'CROSS_ASIN_BLOCK_LOW_RELEVANCE',
            reason: `Relevância heurística ${heuristicScore} < ${HEURISTIC_LOW_CONF}`,
          });
          continue;
        }

        if (heuristicScore >= HEURISTIC_HIGH_CONF) {
          // Score > 95 → HIGH_CONFIDENCE sem LLM
          relevancePhase = 'HEURISTIC_ONLY';
        } else {
          // Zona cinzenta 70-95 → validar com LLM
          const llmResult = await llmValidateRelevance(kwText, srcTitle, srcBullets, destTitle, destBullets, heuristicScore);
          llmScore  = llmResult.score;
          llmReason = llmResult.reason;
          hardBlockerFromLlm      = llmResult.hard_blocker;
          hardBlockerLlmReason    = llmResult.hard_blocker_reason;
          finalScore = Math.round((heuristicScore * 0.4) + (llmResult.score * 0.6));
          relevancePhase = 'LLM_VALIDATED';

          if (hardBlockerFromLlm) {
            doNotTransfer.push({
              source_asin: srcAsin, destination_asin: destAsin,
              keyword: kwText, heuristic_score: heuristicScore, llm_score: llmScore,
              rule_id: 'CROSS_ASIN_BLOCK_HARD_BLOCKER',
              reason: hardBlockerLlmReason,
            });
            continue;
          }
        }

        // Regra dos 90%
        let transferDecision: string;
        let ruleId: string;
        if (finalScore >= TRANSFER_RELEVANCE_MIN) {
          transferDecision = 'HIGH_CONFIDENCE_TRANSFER';
          ruleId = 'CROSS_ASIN_TRANSFER_90';
        } else if (finalScore >= MANUAL_REVIEW_MIN) {
          transferDecision = 'MANUAL_REVIEW';
          ruleId = 'CROSS_ASIN_MANUAL_REVIEW';
          manualReview.push({ source_asin: srcAsin, destination_asin: destAsin, keyword: kwText, score: finalScore });
          continue;
        } else {
          doNotTransfer.push({
            source_asin: srcAsin, destination_asin: destAsin, keyword: kwText,
            heuristic_score: heuristicScore, final_score: finalScore,
            rule_id: 'CROSS_ASIN_BLOCK_LOW_RELEVANCE',
            reason: `Score final ${finalScore} < ${TRANSFER_RELEVANCE_MIN}`,
          });
          continue;
        }

        // Calcular bid inicial
        const destSusCpc = destSustainableCpc(destAov, winner.cvr || 0.05, destTargetAcos);
        let initialBid = destSusCpc > 0
          ? Math.min(srcCpc, destSusCpc * DEST_BID_FACTOR)
          : srcCpc * DEST_BID_FACTOR;
        initialBid = Math.max(minBid, Math.min(maxBid, initialBid));
        initialBid = parseFloat(initialBid.toFixed(2));

        // Family bank check — boost de confiança
        const srcFamily = srcProduct?.category || srcSnapshot?.product_type || '';
        const familyKey = `${srcFamily}|${normKw}`;
        const familyEntry = familyBankMap.get(familyKey);
        const familyBoost = familyEntry && familyEntry.winning_asin_count >= 2;

        const transfer: any = {
          amazon_account_id: accountId,
          marketplace: 'BR',
          keyword: kwText,
          normalized_keyword: normKw,
          match_type: 'exact',
          source_asin: srcAsin,
          source_keyword_bank_id: winner.id,
          source_orders: Number(winner.orders || 0),
          source_acos: Number(winner.acos || 0),
          source_cvr: Number(winner.cvr || 0),
          source_cpc: srcCpc,
          source_winner_tier: winner.winner_tier,
          destination_asin: destAsin,
          destination_product_name: destProduct?.product_name || destProduct?.display_name || '',
          destination_sku: destProduct?.sku || '',
          destination_fba_inventory: Number(destProduct?.fba_inventory || 0),
          destination_aov: destAov,
          destination_target_acos: destTargetAcos,
          destination_sustainable_cpc: destSusCpc,
          relevance_score: finalScore,
          relevance_phase: relevancePhase,
          heuristic_score: heuristicScore,
          llm_score: llmScore || null,
          llm_reason: llmReason || null,
          hard_blocker_detected: false,
          relevance_breakdown: JSON.stringify({ ...breakdown, final_score: finalScore }),
          transfer_decision: transferDecision,
          rule_id: ruleId,
          transfer_confidence: familyBoost ? 'VERY_HIGH' : finalScore >= 95 ? 'HIGH' : 'MEDIUM',
          family_bank_boost: familyBoost,
          initial_bid: initialBid,
          campaign_job: 'VALIDATION',
          status: 'PROPOSED',
          validation_result: 'PENDING',
          proposed_at: now,
          cycle_date: today,
          created_at: now,
        };

        results.push(transfer);
        transfersCreatedToday++;

        // Atualizar ProductFamilyKeywordBank
        if (srcFamily) {
          familyBankUpdates.push({
            family_name: srcFamily,
            keyword: kwText,
            normalized_keyword: normKw,
            asin: srcAsin,
            orders: winner.orders,
            acos: winner.acos,
            cvr: winner.cvr,
            cpc: srcCpc,
          });
        }
      }
    }

    // Persistir
    if (!dry_run) {
      if (results.length > 0) {
        await base44.asServiceRole.entities.CrossAsinTransfer.bulkCreate(results).catch(() => {});
      }

      // Upsert ProductFamilyKeywordBank
      for (const upd of familyBankUpdates) {
        const key = `${upd.family_name}|${upd.normalized_keyword}`;
        const existing = familyBankMap.get(key);
        if (existing) {
          const winningAsins: string[] = existing.winning_asins || [];
          if (!winningAsins.includes(upd.asin)) winningAsins.push(upd.asin);
          await base44.asServiceRole.entities.ProductFamilyKeywordBank.update(existing.id, {
            winning_asins: winningAsins,
            winning_asin_count: winningAsins.length,
            total_orders: (existing.total_orders || 0) + (upd.orders || 0),
            avg_acos: upd.acos,
            avg_cvr: upd.cvr,
            best_cpc: Math.min(existing.best_cpc || 999, upd.cpc || 999),
            high_confidence_transfer: winningAsins.length >= 2,
            transfer_confidence: winningAsins.length >= 2 ? 'VERY_HIGH' : 'HIGH',
            last_updated_at: now,
          }).catch(() => {});
        } else {
          await base44.asServiceRole.entities.ProductFamilyKeywordBank.create({
            amazon_account_id: accountId,
            family_name: upd.family_name,
            keyword: upd.keyword,
            normalized_keyword: upd.normalized_keyword,
            winning_asins: [upd.asin],
            winning_asin_count: 1,
            total_orders: upd.orders || 0,
            avg_acos: upd.acos,
            avg_cvr: upd.cvr,
            best_cpc: upd.cpc,
            transfer_confidence: 'MEDIUM',
            high_confidence_transfer: false,
            last_updated_at: now,
            created_at: now,
          }).catch(() => {});
        }
      }
    }

    return Response.json({
      ok: true,
      dry_run,
      cycle_date: today,
      qualified_winners: qualifiedWinners.length,
      transfers_proposed: results.length,
      manual_review: manualReview.length,
      blocked: doNotTransfer.length,
      family_bank_updates: familyBankUpdates.length,
      transfers: dry_run ? results.slice(0, 10) : results.map((r: any) => ({
        source_asin: r.source_asin,
        destination_asin: r.destination_asin,
        keyword: r.keyword,
        relevance_score: r.relevance_score,
        transfer_decision: r.transfer_decision,
        initial_bid: r.initial_bid,
        relevance_phase: r.relevance_phase,
      })),
      manual_review_list: manualReview.slice(0, 10),
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});