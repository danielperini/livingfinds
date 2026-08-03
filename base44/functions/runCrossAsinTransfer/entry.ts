/**
 * runCrossAsinTransfer — Motor de expansão cross-ASIN
 *
 * Agrupa ASINs por heurística de título, identifica keywords provadas
 * em um ASIN que ainda não cobertas em outros do mesmo grupo,
 * e enfileira criação de campanhas manuais EXACT via ProductKickoffQueue.
 *
 * Idempotente via idempotency_key = account_id+normalized_keyword+dest_asin+date
 * Limite: 20 novas transferências por execução.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const MAX_TRANSFERS_PER_RUN = 20;

const STOPWORDS = new Set([
  'de','do','da','dos','das','em','no','na','nos','nas','ao','aos','à','às',
  'e','a','o','os','as','um','uma','uns','umas','para','por','com','sem',
  'que','se','mas','ou','nem','pois','porque','quando','como','seu','sua',
  'seus','suas','este','esta','estes','estas','esse','essa','esses','essas',
  'it','the','for','and','or','with','without','from','to','in','on','at',
  'cm','mm','m','kg','g','l','ml','w','v','hz','led','pro','kit','set',
  'novo','nova','novos','novas','preto','preta','branco','branca',
]);

function normalize(text) {
  return (text || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  return normalize(text).split(' ').filter(w => w.length >= 3 && !STOPWORDS.has(w));
}

function normalizeKeyword(kw) {
  return normalize(kw).replace(/\s+/g, ' ').trim();
}

// Retorna true se keyword e título do produto destino compartilham ao menos 1 token >= 4 chars
function keywordRelevantToDestination(keyword: string, destProductTitle: string): boolean {
  const MIN_TOKEN_LEN = 4;
  const kwTokens = new Set(
    tokenize(keyword).filter(t => t.length >= MIN_TOKEN_LEN)
  );
  const titleTokens = new Set(
    tokenize(destProductTitle).filter(t => t.length >= MIN_TOKEN_LEN)
  );
  if (kwTokens.size === 0 || titleTokens.size === 0) return false;
  for (const t of kwTokens) {
    if (titleTokens.has(t)) return true;
  }
  return false;
}

// Agrupa produtos por termos em comum no título (heurística)
function groupProductsByTitle(products) {
  // Para cada produto, extrair tokens significativos do nome
  const productTokens = products.map(p => ({
    ...p,
    tokens: new Set(tokenize(p.display_name || p.product_name || '')),
  }));

  const groups = []; // { name, asins: [], products: [] }
  const assigned = new Set();

  for (let i = 0; i < productTokens.length; i++) {
    if (assigned.has(productTokens[i].asin)) continue;
    if (productTokens[i].tokens.size === 0) continue;

    const group = {
      products: [productTokens[i]],
      asins: [productTokens[i].asin],
      commonTokens: new Set(productTokens[i].tokens),
    };
    assigned.add(productTokens[i].asin);

    for (let j = i + 1; j < productTokens.length; j++) {
      if (assigned.has(productTokens[j].asin)) continue;
      if (productTokens[j].tokens.size === 0) continue;

      // Verificar intersecção de tokens — ao menos 2 tokens em comum
      let commonCount = 0;
      for (const t of productTokens[j].tokens) {
        if (group.commonTokens.has(t)) commonCount++;
      }
      if (commonCount >= 2) {
        group.products.push(productTokens[j]);
        group.asins.push(productTokens[j].asin);
        assigned.add(productTokens[j].asin);
        // Manter apenas tokens comuns a todos os membros
        for (const t of [...group.commonTokens]) {
          if (!productTokens[j].tokens.has(t)) group.commonTokens.delete(t);
        }
      }
    }

    // Grupos com ao menos 2 ASINs fazem sentido para cross-transfer
    if (group.asins.length >= 2) {
      const nameParts = [...group.commonTokens].slice(0, 3).join(' ');
      groups.push({
        name: nameParts || group.products[0].product_name || 'Grupo',
        asins: group.asins,
        products: group.products,
      });
    }
  }

  return groups;
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, force = false } = body;

    // Resolver conta
    let account;
    if (amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1);
      account = accs[0];
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta conectada' }, { status: 404 });

    const accountId = account.id;
    const todayBRT = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
    const now = new Date().toISOString();

    // Carregar configurações (max_acos)
    const [perfList] = await Promise.all([
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: accountId }, null, 1).catch(() => []),
    ]);
    const perf = perfList[0] || {};
    const maxAcos = Number(perf.max_acos || perf.target_acos || 25);

    // Carregar produtos ativos com estoque
    const allProducts = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id: accountId }, null, 200
    ).catch(() => []);
    const activeProducts = allProducts.filter(p =>
      p.status !== 'archived' &&
      p.status !== 'inactive' &&
      p.asin &&
      (p.fba_inventory > 0 || p.available_quantity > 0)
    );
    if (activeProducts.length < 2) {
      return Response.json({ ok: true, message: 'Menos de 2 produtos ativos com estoque, cross-transfer ignorado', groups: 0, transfers_created: 0 });
    }

    // Agrupar por heurística de título
    const groups = groupProductsByTitle(activeProducts);
    if (groups.length === 0) {
      return Response.json({ ok: true, message: 'Nenhum grupo de produtos identificado', groups: 0, transfers_created: 0 });
    }

    // Carregar TermBank e KeywordBank para todos os ASINs dos grupos
    const allGroupAsins = [...new Set(groups.flatMap(g => g.asins))];

    // Carregar campanhas MANUAL EXACT por ASIN para checar cobertura
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: accountId }, null, 500
    ).catch(() => []);
    const manualExactCampaigns = allCampaigns.filter(c => {
      const targeting = (c.targeting_type || '').toUpperCase();
      const status = (c.state || c.status || '').toLowerCase();
      return targeting === 'MANUAL' && status !== 'archived' && status !== 'incomplete';
    });

    // Carregar keywords das campanhas manuais
    const allKeywords = await base44.asServiceRole.entities.Keyword.filter(
      { amazon_account_id: accountId }, null, 1000
    ).catch(() => []);
    const exactKeywords = allKeywords.filter(k => (k.match_type || '').toLowerCase() === 'exact');

    // Construir índice: asin+keyword_normalized → exists
    const coverageIndex = new Set();
    for (const kw of exactKeywords) {
      if (!kw.asin || !kw.keyword_text) continue;
      const key = `${kw.asin}|${normalizeKeyword(kw.keyword_text)}`;
      coverageIndex.add(key);
    }
    // Também indexar por campaign_id → asin para keywords sem asin direto
    const campaignAsinMap = new Map();
    for (const c of manualExactCampaigns) {
      if (c.campaign_id && c.asin) campaignAsinMap.set(c.campaign_id, c.asin);
    }
    for (const kw of exactKeywords) {
      if (kw.asin) continue; // já indexado acima
      const asin = campaignAsinMap.get(kw.campaign_id);
      if (!asin || !kw.keyword_text) continue;
      coverageIndex.add(`${asin}|${normalizeKeyword(kw.keyword_text)}`);
    }

    // Carregar TermBank e KeywordBank
    const [termBankRaw, keywordBankRaw] = await Promise.all([
      base44.asServiceRole.entities.TermBank.filter({ amazon_account_id: accountId }, null, 500).catch(() => []),
      base44.asServiceRole.entities.KeywordBank.filter({ amazon_account_id: accountId }, null, 500).catch(() => []),
    ]);

    // Carregar transferências já criadas hoje (dedup)
    const existingTransfers = await base44.asServiceRole.entities.CrossAsinTransfer.filter(
      { amazon_account_id: accountId }, '-created_at', 200
    ).catch(() => []);
    const existingKeys = new Set(existingTransfers.map(t => t.idempotency_key).filter(Boolean));

    // Identificar candidatas por grupo
    const transfersToCreate = [];
    const transfersBlocked = [];
    const groupResults = [];

    for (const group of groups) {
      const { asins, name } = group;

      // Construir mapa de keywords candidatas por ASIN (fonte: TermBank + KeywordBank)
      // Uma keyword é "doadora confirmada" se: clicks > 0 e (acos=0 ou acos<=maxAcos)
      const donorMap = new Map(); // normalizedKw → { keyword, asin, acos, clicks, confidence, source }

      // ── Calcular conversion_score composto para cada donor ─────────────────
      function calcConversionScore(donor) {
        const orders = Number(donor.orders || 0);
        const cvr = Number(donor.cvr || 0);      // 0-1 float
        const acos = Number(donor.acos || 0);
        const clicks = Number(donor.clicks || 0);
        const conf = Number(donor.confidence || 0);
        const acos_efficiency = acos > 0 ? Math.max(0, 1 - acos / maxAcos) : 0.5; // 0.5 neutral when no data
        const clicks_bonus = Math.min(1, clicks / 20);
        if (orders === 0 && clicks === 0) {
          // Sem dados de conversão: score baseado em confidence (0-50 range)
          return Math.round((conf / 100) * 50);
        }
        return Math.min(100, Math.round(
          (orders * 10) + (cvr * 30) + (acos_efficiency * 40) + (clicks_bonus * 20)
        ));
      }

      for (const term of termBankRaw) {
        if (!asins.includes(term.asin)) continue;
        if (!term.term) continue;
        const conf = term.confidence != null ? (term.confidence <= 1 ? Math.round(term.confidence * 100) : Math.round(term.confidence)) : 0;
        const clicks = Number(term.clicks || 0);
        const acos = Number(term.acos || 0);
        const isDonor = (conf >= 75 || clicks > 0) && (acos === 0 || acos <= maxAcos);
        if (!isDonor) continue;
        const nkw = normalizeKeyword(term.term);
        if (!nkw || nkw.length < 3) continue;
        const entry = {
          keyword: term.term,
          asin: term.asin,
          acos,
          clicks,
          orders: Number(term.orders || 0),
          cvr: Number(term.cvr || 0),
          cpc: Number(term.cpc || 0),
          confidence: conf,
          source: 'TermBank',
        };
        if (!donorMap.has(nkw) || clicks > (donorMap.get(nkw).clicks || 0)) {
          donorMap.set(nkw, entry);
        }
      }

      for (const kb of keywordBankRaw) {
        if (!asins.includes(kb.asin)) continue;
        if (!kb.keyword) continue;
        const conf = Number(kb.confidence_score || 0);
        const clicks = Number(kb.clicks || 0);
        const acos = Number(kb.acos || 0);
        // Campaign Factory is the source of truth for expansion: terms already
        // classified as Strong Winner or Harvest Ready are valid donors even
        // before enough click volume accumulates on every sibling ASIN.
        const isStrongWinner = String(kb.winner_tier || '').toUpperCase() === 'STRONG_WINNER';
        const isHarvestReady = kb.harvest_candidate === true || String(kb.harvest_action || '').toUpperCase() === 'CREATE_EXACT';
        const isDonor = (isStrongWinner || isHarvestReady || conf >= 75 || clicks > 0) && (acos === 0 || acos <= maxAcos);
        if (!isDonor) continue;
        const nkw = normalizeKeyword(kb.keyword);
        if (!nkw || nkw.length < 3) continue;
        const entry = {
          keyword: kb.keyword,
          asin: kb.asin,
          acos,
          clicks,
          orders: Number(kb.orders || 0),
          cvr: Number(kb.cvr || 0),
          cpc: Number(kb.cpc || 0),
          confidence: conf,
          winnerTier: isStrongWinner ? 'STRONG_WINNER' : (isHarvestReady ? 'HARVEST_READY' : 'NONE'),
          source: isStrongWinner ? 'CampaignFactory:StrongWinner' : (isHarvestReady ? 'CampaignFactory:HarvestReady' : 'KeywordBank'),
        };
        if (!donorMap.has(nkw) || clicks > (donorMap.get(nkw).clicks || 0)) {
          donorMap.set(nkw, entry);
        }
      }

      // ── Montar candidatas brutas (sem limite ainda) ─────────────────────
      const groupCandidates = [];
      const rawCandidates = []; // { nkw, donor, destAsin, idempKey, destProduct, conversionScore }

      for (const [nkw, donor] of donorMap.entries()) {
        for (const destAsin of asins) {
          if (destAsin === donor.asin) continue;

          const covKey = `${destAsin}|${nkw}`;
          if (coverageIndex.has(covKey)) {
            groupCandidates.push({ keyword: donor.keyword, dest_asin: destAsin, status: 'already_covered' });
            continue;
          }

          const idempKey = `crossasin:${accountId}:${nkw}:${destAsin}:${todayBRT}`;
          if (existingKeys.has(idempKey)) {
            groupCandidates.push({ keyword: donor.keyword, dest_asin: destAsin, status: 'already_queued' });
            continue;
          }

          const destProduct = activeProducts.find(p => p.asin === destAsin);
          if (!destProduct) continue;

          // ── Hard block: filtro de relevância semântica ─────────────────
          const destTitle = destProduct.display_name || destProduct.product_name || '';
          if (!keywordRelevantToDestination(donor.keyword, destTitle)) {
            // Registrar como bloqueado para auditoria (sem enfileirar)
            transfersBlocked.push({
              amazon_account_id: accountId,
              keyword: donor.keyword,
              normalized_keyword: nkw,
              match_type: 'exact',
              source_asin: donor.asin,
              destination_asin: destAsin,
              destination_product_name: destTitle || destAsin,
              destination_sku: destProduct.sku || '',
              hard_blocker_detected: true,
              hard_blocker_reason: 'keyword_category_mismatch: nenhum token do keyword encontrado no título do destino',
              transfer_decision: 'DO_NOT_TRANSFER',
              status: 'REJECTED',
              idempotency_key: idempKey,
              relevance_score: 0,
              conversion_score: 0,
              proposed_at: now,
              created_at: now,
            });
            groupCandidates.push({ keyword: donor.keyword, dest_asin: destAsin, status: 'hard_blocked_category_mismatch' });
            continue;
          }

          rawCandidates.push({
            nkw, donor, destAsin, idempKey, destProduct,
            conversionScore: calcConversionScore(donor),
          });
        }
      }

      // ── Ordenar por conversion_score desc antes de aplicar o limite ─────
      rawCandidates.sort((a, b) => b.conversionScore - a.conversionScore);

      let groupTransfers = 0;

      for (const cand of rawCandidates) {
        if (transfersToCreate.length >= MAX_TRANSFERS_PER_RUN) break;

        const { nkw, donor, destAsin, idempKey, destProduct, conversionScore } = cand;

        // Keywords com evidência real de conversão → elevar decisão e confiança
        const hasRealConversion = donor.orders >= 1 && donor.cvr >= 0.05;
        const highScore = conversionScore >= 70;

        const transferDecision = hasRealConversion ? 'HIGH_CONFIDENCE_TRANSFER' : 'HIGH_CONFIDENCE_TRANSFER';
        const transferConfidence = hasRealConversion ? 'HIGH' : (donor.confidence >= 90 ? 'HIGH' : 'MEDIUM');
        const evaluationWindowHours = highScore ? 48 : 0;
        const campaignJob = highScore ? 'VALIDATION' : 'VALIDATION';

        // Calcular bid inicial: CPC da origem × 0,75 (desconto 25%), mínimo R$0,30
        const initialBid = donor.cpc > 0
          ? Math.min(1, Math.max(0.30, Math.round(donor.cpc * 0.75 * 100) / 100))
          : 0.50;

        transfersToCreate.push({
          amazon_account_id: accountId,
          keyword: donor.keyword,
          normalized_keyword: nkw,
          match_type: 'exact',
          source_asin: donor.asin,
          destination_asin: destAsin,
          destination_product_name: destProduct.display_name || destProduct.product_name || destAsin,
          destination_sku: destProduct.sku || '',
          destination_fba_inventory: destProduct.fba_inventory || 0,
          source_orders: donor.orders,
          source_acos: donor.acos,
          source_cvr: donor.cvr,
          source_cpc: donor.cpc,
          source_winner_tier: donor.winnerTier || (donor.orders >= 1 ? 'WINNER' : 'NONE'),
          initial_bid: initialBid,
          relevance_score: conversionScore,
          relevance_phase: 'HEURISTIC_ONLY',
          heuristic_score: donor.confidence || 50,
          conversion_score: conversionScore,
          evaluation_window_hours: evaluationWindowHours,
          transfer_decision: transferDecision,
          transfer_confidence: transferConfidence,
          campaign_job: campaignJob,
          status: 'PROPOSED',
          idempotency_key: idempKey,
          proposed_at: now,
          created_at: now,
          product_family: name,
          relevance_breakdown: JSON.stringify({
            orders: donor.orders,
            cvr: donor.cvr,
            acos: donor.acos,
            clicks: donor.clicks,
            acos_efficiency: donor.acos > 0 ? Math.max(0, 1 - donor.acos / maxAcos) : 0.5,
            clicks_bonus: Math.min(1, donor.clicks / 20),
            confidence: donor.confidence,
            source: donor.source,
          }),
        });
        groupTransfers++;
        groupCandidates.push({ keyword: donor.keyword, dest_asin: destAsin, status: 'queued', conversion_score: conversionScore });
      }

      groupResults.push({
        group: name,
        asins,
        donors: donorMap.size,
        transfers: groupTransfers,
      });
    }

    // Persistir CrossAsinTransfer aprovadas em lotes
    let created = 0;
    for (let i = 0; i < transfersToCreate.length; i += 20) {
      const batch = transfersToCreate.slice(i, i + 20);
      await base44.asServiceRole.entities.CrossAsinTransfer.bulkCreate(batch).catch(() => {});
      created += batch.length;
    }

    // Persistir bloqueadas (hard block) — somente as que ainda não existem no índice
    const blockedToSave = transfersBlocked.filter(b => !existingKeys.has(b.idempotency_key));
    for (let i = 0; i < blockedToSave.length; i += 20) {
      await base44.asServiceRole.entities.CrossAsinTransfer.bulkCreate(blockedToSave.slice(i, i + 20)).catch(() => {});
    }

    // Enfileirar na ProductKickoffQueue via scheduleManualCampaignFromTerm (apenas aprovadas)
    let queued = 0;
    for (const t of transfersToCreate) {
      const destProd = activeProducts.find(p => p.asin === t.destination_asin);
      const res = await base44.asServiceRole.functions.invoke('scheduleManualCampaignFromTerm', {
        amazon_account_id: accountId,
        asin: t.destination_asin,
        keyword: t.keyword,
        product_name: destProd?.display_name || destProd?.product_name || t.destination_asin,
        sku: destProd?.sku || null,
        bid_initial: t.initial_bid,
      }).catch(() => null);
      if (res?.ok !== false) queued++;
    }

    // Log de execução
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'runCrossAsinTransfer',
      status: 'success',
      trigger_type: force ? 'manual' : 'automatic',
      started_at: now,
      completed_at: new Date().toISOString(),
      records_processed: created,
      result_summary: JSON.stringify({
        groups_analyzed: groups.length,
        transfers_created: created,
        transfers_queued: queued,
        transfers_blocked_hard: blockedToSave.length,
        hard_block_examples: blockedToSave.slice(0, 5).map(b => ({
          keyword: b.keyword,
          dest_asin: b.destination_asin,
          reason: b.hard_blocker_reason,
        })),
        group_results: groupResults,
      }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      groups_analyzed: groups.length,
      transfers_created: created,
      transfers_queued: queued,
      transfers_blocked_hard: blockedToSave.length,
      hard_block_examples: blockedToSave.slice(0, 5).map(b => ({
        keyword: b.keyword,
        dest_asin: b.destination_asin,
        reason: b.hard_blocker_reason,
      })),
      group_results: groupResults,
      duration_ms: Date.now() - t0,
    });

  } catch (err) {
    return Response.json({ ok: false, error: err.message, duration_ms: Date.now() - t0 }, { status: 500 });
  }
});
