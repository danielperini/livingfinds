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
 *
 * Helpers compartilhados em base44/shared/crossAsinHelpers.ts
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { normalizeText, tokenize, calcHeuristicScore, detectHardBlockers, destSustainableCpc, parseBullets } from '../../shared/crossAsinHelpers.ts';

const RULE_VERSION = '1.0';
const MIN_SOURCE_ORDERS = 3;
const TRANSFER_RELEVANCE_MIN = 90;
const MANUAL_REVIEW_MIN = 80;
const HEURISTIC_HIGH_CONF = 95;
const HEURISTIC_LOW_CONF = 70;
const MAX_TRANSFERS_PER_DAY = 5;
const DEST_BID_FACTOR = 0.85;

// LLM Relevance via OPENAI_API_KEY
async function llmValidateRelevance(
  kwText: string,
  srcTitle: string, srcBullets: string,
  dstTitle: string, dstBullets: string,
  heuristicScore: number,
): Promise<{ score: number; reason: string; hard_blocker: boolean; hard_blocker_reason: string }> {

  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) return { score: heuristicScore, reason: 'OPENAI_API_KEY não configurado', hard_blocker: false, hard_blocker_reason: '' };

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
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 512,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '{}';
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

    const [perfList, economicsList] = await Promise.all([
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, null, 1).catch(() => []),
      base44.asServiceRole.entities.ProductEconomics.filter({ amazon_account_id: accountId }, null, 500).catch(() => []),
    ]);
    const perf = perfList[0] || {};
    const targetAcos = Number(perf.target_acos || 15);
    const minBid = Number(perf.min_bid || 0.25);
    const maxBid = Number(perf.max_bid || 2.5);

    const econMap = new Map<string, any>();
    for (const e of economicsList) { if (e.asin) econMap.set(e.asin, e); }

    const kwBankFilter: any = { amazon_account_id: accountId, lifecycle_status: 'WINNER' };
    if (source_asin_filter) kwBankFilter.asin = source_asin_filter;

    const winnerEntries = await base44.asServiceRole.entities.KeywordBank.filter(
      kwBankFilter, '-promotion_score', 200
    ).catch(() => []);

    const qualifiedWinners = winnerEntries.filter((w: any) =>
      Number(w.orders || 0) >= MIN_SOURCE_ORDERS &&
      Number(w.acos || 0) > 0 &&
      Number(w.acos || 0) <= targetAcos &&
      ['MEDIUM', 'HIGH', 'VERY_HIGH'].includes(w.source_confidence || '') &&
      ['WINNER', 'STRONG_WINNER'].includes(w.winner_tier || '')
    );

    const allProducts = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id: accountId, status: 'active' }, null, 500
    ).catch(() => []);
    const activeAsins = new Set<string>(allProducts.filter((p: any) => Number(p.fba_inventory || 0) > 0).map((p: any) => p.asin));

    const allSnapshots = await base44.asServiceRole.entities.ListingSnapshot.filter(
      { amazon_account_id: accountId }, null, 500
    ).catch(() => []);
    const snapshotMap = new Map<string, any>();
    for (const s of allSnapshots) { if (s.asin) snapshotMap.set(s.asin, s); }

    const existingBankEntries = await base44.asServiceRole.entities.KeywordBank.filter(
      { amazon_account_id: accountId }, null, 2000
    ).catch(() => []);
    const existingBankHashes = new Set<string>(existingBankEntries.map((e: any) => e.keyword_hash).filter(Boolean));

    const transfersToday = await base44.asServiceRole.entities.CrossAsinTransfer.filter(
      { amazon_account_id: accountId, cycle_date: today }, null, 50
    ).catch(() => []);
    let transfersCreatedToday = transfersToday.length;

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
      const srcBullets  = parseBullets(srcSnapshot?.bullets || '');
      const srcCategory = srcSnapshot?.product_type || '';
      const srcProduct  = allProducts.find((p: any) => p.asin === srcAsin);
      const srcCpc      = Number(winner.cpc || 0);

      const destAsins = [...activeAsins].filter(a =>
        a !== srcAsin &&
        !existingBankHashes.has(`BR|${a}|${normKw}|exact|VALIDATION`) &&
        !existingBankHashes.has(`BR|${a}|${normKw}|exact|PROFIT`) &&
        !existingBankHashes.has(`BR|${a}|${normKw}|exact|SCALE`)
      );

      for (const destAsin of destAsins) {
        const destSnapshot = snapshotMap.get(destAsin);
        if (!destSnapshot) continue;

        const destTitle    = destSnapshot.title || '';
        const destBullets  = parseBullets(destSnapshot.bullets || '');
        const destCategory = destSnapshot.product_type || '';
        const destProduct  = allProducts.find((p: any) => p.asin === destAsin);
        const destEcon     = econMap.get(destAsin);
        const destAov      = Number(destEcon?.average_sale_price || destEcon?.current_price || destProduct?.price || 0);
        const destTargetAcos = Number(destEcon?.target_acos || targetAcos);

        const blocker = detectHardBlockers(kwText, srcTitle, destTitle, srcBullets, destBullets);
        if (blocker.blocked) {
          doNotTransfer.push({ source_asin: srcAsin, destination_asin: destAsin, keyword: kwText, rule_id: 'CROSS_ASIN_BLOCK_HARD_BLOCKER', reason: blocker.reason });
          continue;
        }

        const { score: heuristicScore, breakdown } = calcHeuristicScore(
          kwText, srcTitle, srcBullets, srcCategory, destTitle, destBullets, destCategory
        );

        let finalScore = heuristicScore;
        let relevancePhase = 'HEURISTIC_ONLY';
        let llmScore: number | null = null;
        let llmReason = '';
        let hardBlockerFromLlm = false;
        let hardBlockerLlmReason = '';

        if (heuristicScore < HEURISTIC_LOW_CONF) {
          doNotTransfer.push({ source_asin: srcAsin, destination_asin: destAsin, keyword: kwText, heuristic_score: heuristicScore, rule_id: 'CROSS_ASIN_BLOCK_LOW_RELEVANCE', reason: `Relevância heurística ${heuristicScore} < ${HEURISTIC_LOW_CONF}` });
          continue;
        }

        if (heuristicScore < HEURISTIC_HIGH_CONF) {
          const llmResult = await llmValidateRelevance(kwText, srcTitle, srcBullets, destTitle, destBullets, heuristicScore);
          llmScore = llmResult.score;
          llmReason = llmResult.reason;
          hardBlockerFromLlm = llmResult.hard_blocker;
          hardBlockerLlmReason = llmResult.hard_blocker_reason;
          finalScore = Math.round((heuristicScore * 0.4) + (llmResult.score * 0.6));
          relevancePhase = 'LLM_VALIDATED';

          if (hardBlockerFromLlm) {
            doNotTransfer.push({ source_asin: srcAsin, destination_asin: destAsin, keyword: kwText, heuristic_score: heuristicScore, llm_score: llmScore, rule_id: 'CROSS_ASIN_BLOCK_HARD_BLOCKER', reason: hardBlockerLlmReason });
            continue;
          }
        }

        let transferDecision: string, ruleId: string;
        if (finalScore >= TRANSFER_RELEVANCE_MIN) {
          transferDecision = 'HIGH_CONFIDENCE_TRANSFER';
          ruleId = 'CROSS_ASIN_TRANSFER_90';
        } else if (finalScore >= MANUAL_REVIEW_MIN) {
          transferDecision = 'MANUAL_REVIEW';
          ruleId = 'CROSS_ASIN_MANUAL_REVIEW';
          manualReview.push({ source_asin: srcAsin, destination_asin: destAsin, keyword: kwText, score: finalScore });
          continue;
        } else {
          doNotTransfer.push({ source_asin: srcAsin, destination_asin: destAsin, keyword: kwText, heuristic_score: heuristicScore, final_score: finalScore, rule_id: 'CROSS_ASIN_BLOCK_LOW_RELEVANCE', reason: `Score final ${finalScore} < ${TRANSFER_RELEVANCE_MIN}` });
          continue;
        }

        const destSusCpc = destSustainableCpc(destAov, winner.cvr || 0.05, destTargetAcos);
        let initialBid = destSusCpc > 0 ? Math.min(srcCpc, destSusCpc * DEST_BID_FACTOR) : srcCpc * DEST_BID_FACTOR;
        initialBid = Math.max(minBid, Math.min(maxBid, parseFloat(initialBid.toFixed(2))));

        const srcFamily = srcProduct?.category || srcSnapshot?.product_type || '';
        const familyKey = `${srcFamily}|${normKw}`;
        const familyEntry = familyBankMap.get(familyKey);
        const familyBoost = familyEntry && familyEntry.winning_asin_count >= 2;

        results.push({
          amazon_account_id: accountId, marketplace: 'BR',
          keyword: kwText, normalized_keyword: normKw, match_type: 'exact',
          source_asin: srcAsin, source_keyword_bank_id: winner.id,
          source_orders: Number(winner.orders || 0), source_acos: Number(winner.acos || 0),
          source_cvr: Number(winner.cvr || 0), source_cpc: srcCpc,
          source_winner_tier: winner.winner_tier,
          destination_asin: destAsin,
          destination_product_name: destProduct?.product_name || destProduct?.display_name || '',
          destination_sku: destProduct?.sku || '',
          destination_fba_inventory: Number(destProduct?.fba_inventory || 0),
          destination_aov: destAov, destination_target_acos: destTargetAcos,
          destination_sustainable_cpc: destSusCpc,
          relevance_score: finalScore, relevance_phase: relevancePhase,
          heuristic_score: heuristicScore, llm_score: llmScore || null, llm_reason: llmReason || null,
          hard_blocker_detected: false,
          relevance_breakdown: JSON.stringify({ ...breakdown, final_score: finalScore }),
          transfer_decision: transferDecision, rule_id: ruleId,
          transfer_confidence: familyBoost ? 'VERY_HIGH' : finalScore >= 95 ? 'HIGH' : 'MEDIUM',
          family_bank_boost: familyBoost, initial_bid: initialBid, campaign_job: 'VALIDATION',
          status: 'PROPOSED', validation_result: 'PENDING',
          proposed_at: now, cycle_date: today, created_at: now,
        });
        transfersCreatedToday++;

        if (srcFamily) {
          familyBankUpdates.push({ family_name: srcFamily, keyword: kwText, normalized_keyword: normKw, asin: srcAsin, orders: winner.orders, acos: winner.acos, cvr: winner.cvr, cpc: srcCpc });
        }
      }
    }

    if (!dry_run) {
      if (results.length > 0) await base44.asServiceRole.entities.CrossAsinTransfer.bulkCreate(results).catch(() => {});

      for (const upd of familyBankUpdates) {
        const key = `${upd.family_name}|${upd.normalized_keyword}`;
        const existing = familyBankMap.get(key);
        if (existing) {
          const winningAsins: string[] = existing.winning_asins || [];
          if (!winningAsins.includes(upd.asin)) winningAsins.push(upd.asin);
          await base44.asServiceRole.entities.ProductFamilyKeywordBank.update(existing.id, {
            winning_asins: winningAsins, winning_asin_count: winningAsins.length,
            total_orders: (existing.total_orders || 0) + (upd.orders || 0),
            avg_acos: upd.acos, avg_cvr: upd.cvr,
            best_cpc: Math.min(existing.best_cpc || 999, upd.cpc || 999),
            high_confidence_transfer: winningAsins.length >= 2,
            transfer_confidence: winningAsins.length >= 2 ? 'VERY_HIGH' : 'HIGH',
            last_updated_at: now,
          }).catch(() => {});
        } else {
          await base44.asServiceRole.entities.ProductFamilyKeywordBank.create({
            amazon_account_id: accountId, family_name: upd.family_name,
            keyword: upd.keyword, normalized_keyword: upd.normalized_keyword,
            winning_asins: [upd.asin], winning_asin_count: 1,
            total_orders: upd.orders || 0, avg_acos: upd.acos, avg_cvr: upd.cvr, best_cpc: upd.cpc,
            transfer_confidence: 'MEDIUM', high_confidence_transfer: false,
            last_updated_at: now, created_at: now,
          }).catch(() => {});
        }
      }
    }

    return Response.json({
      ok: true, dry_run, cycle_date: today,
      qualified_winners: qualifiedWinners.length,
      transfers_proposed: results.length, manual_review: manualReview.length,
      blocked: doNotTransfer.length, family_bank_updates: familyBankUpdates.length,
      transfers: dry_run ? results.slice(0, 10) : results.map((r: any) => ({
        source_asin: r.source_asin, destination_asin: r.destination_asin,
        keyword: r.keyword, relevance_score: r.relevance_score,
        transfer_decision: r.transfer_decision, initial_bid: r.initial_bid,
        relevance_phase: r.relevance_phase,
      })),
      manual_review_list: manualReview.slice(0, 10),
      duration_ms: Date.now() - t0,
    });

  } catch (err: any) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});