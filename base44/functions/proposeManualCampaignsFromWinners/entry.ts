import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

/**
 * proposeManualCampaignsFromWinners
 *
 * Para cada ASIN com pelo menos 1 venda registrada:
 * 1. Coleta search terms vencedores (orders > 0 ou KeywordBank com winner_tier != 'NONE')
 * 2. Calcula bid inicial = CPC médio histórico por termo (floor R$0.50, cap R$5.00)
 * 3. Verifica se já existe campanha manual ENABLED/PAUSED para o ASIN
 *    → Se sim: propõe keyword_add para os termos novos
 *    → Se não: propõe campaign_create
 * 4. Cria OptimizationDecision com requires_approval=true (nunca publica automaticamente)
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, preview_only = false } = body;

    if (!amazon_account_id) {
      return Response.json({ error: 'amazon_account_id obrigatório' }, { status: 400 });
    }

    const today = new Date().toISOString().slice(0, 10);
    const BID_FLOOR = 0.50;
    const BID_CAP = 5.00;
    const BUDGET_MIN = 15.00;

    // ── 1. ASINs com vendas ─────────────────────────────────────────────────
    // Busca search terms com orders > 0
    const winningTerms = await base44.asServiceRole.entities.SearchTerm.filter(
      { amazon_account_id, orders: { $gt: 0 } },
      '-orders',
      2000
    ).catch(() => []);

    // Busca KeywordBank com winner_tier != 'NONE'
    const kwBankWinners = await base44.asServiceRole.entities.KeywordBank.filter(
      { amazon_account_id },
      '-orders',
      2000
    ).catch(() => []);

    const kwBankFiltered = kwBankWinners.filter(k =>
      k.winner_tier && k.winner_tier !== 'NONE' && k.asin && k.orders > 0
    );

    // Consolidar por ASIN → mapa de termos
    const asinTermsMap = new Map();

    const addTerm = (asin, keyword, cpc, orders, source) => {
      if (!asin || !keyword) return;
      const kNorm = keyword.toLowerCase().trim();
      if (!asinTermsMap.has(asin)) asinTermsMap.set(asin, new Map());
      const asinMap = asinTermsMap.get(asin);
      if (!asinMap.has(kNorm)) {
        asinMap.set(kNorm, { keyword: kNorm, cpc_samples: [], orders: 0, source });
      }
      const entry = asinMap.get(kNorm);
      if (cpc && cpc > 0) entry.cpc_samples.push(cpc);
      entry.orders += (orders || 0);
    };

    for (const st of winningTerms) {
      addTerm(
        st.advertised_asin || st.asin,
        st.query || st.keyword_text || st.keyword,
        st.cpc,
        st.orders,
        'search_term'
      );
    }

    for (const k of kwBankFiltered) {
      addTerm(k.asin, k.keyword || k.normalized_keyword, k.cpc, k.orders, 'keyword_bank');
    }

    if (asinTermsMap.size === 0) {
      return Response.json({
        ok: true,
        message: 'Nenhum ASIN com termos vencedores encontrado.',
        proposals: [],
        decisions_created: 0,
      });
    }

    // ── 2. Campanhas manuais existentes por ASIN ──────────────────────────
    const existingManual = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id, targeting_type: 'MANUAL' },
      null,
      1000
    ).catch(() => []);

    const manualByAsin = new Map();
    for (const c of existingManual) {
      const state = (c.state || c.status || '').toLowerCase();
      if (state === 'archived') continue;
      const asin = c.asin;
      if (!asin) continue;
      if (!manualByAsin.has(asin)) manualByAsin.set(asin, []);
      manualByAsin.get(asin).push(c);
    }

    // ── 3. Montar propostas ───────────────────────────────────────────────
    const proposals = [];

    for (const [asin, termMap] of asinTermsMap.entries()) {
      const terms = Array.from(termMap.values());
      if (terms.length === 0) continue;

      // Calcular bid por termo
      const keywordsWithBids = terms.map(t => {
        const avgCpc = t.cpc_samples.length > 0
          ? t.cpc_samples.reduce((a, b) => a + b, 0) / t.cpc_samples.length
          : BID_FLOOR;
        const bid = Math.min(BID_CAP, Math.max(BID_FLOOR, parseFloat(avgCpc.toFixed(2))));
        return { keyword: t.keyword, bid, orders: t.orders, source: t.source };
      }).sort((a, b) => b.orders - a.orders);

      const avgBid = keywordsWithBids.reduce((s, k) => s + k.bid, 0) / keywordsWithBids.length;
      const suggestedBudget = Math.max(BUDGET_MIN, parseFloat((avgBid * keywordsWithBids.length * 2).toFixed(2)));
      const existingCampaigns = manualByAsin.get(asin) || [];
      const hasExisting = existingCampaigns.length > 0;
      const existingCampaignId = hasExisting ? existingCampaigns[0].campaign_id : null;

      // Verificar idempotência: decisão já proposta hoje para este ASIN
      const idempotencyKey = `${asin}_manual_exact_${today}`;
      const existing = await base44.asServiceRole.entities.OptimizationDecision.filter(
        { amazon_account_id, idempotency_key: idempotencyKey },
        null,
        1
      ).catch(() => []);

      if (existing.length > 0) {
        proposals.push({
          asin,
          status: 'already_proposed',
          decision_id: existing[0].id,
          keywords_count: keywordsWithBids.length,
          avg_bid: parseFloat(avgBid.toFixed(2)),
          suggested_budget: suggestedBudget,
          action: hasExisting ? 'keyword_add' : 'campaign_create',
          keywords: keywordsWithBids,
        });
        continue;
      }

      proposals.push({
        asin,
        status: 'new',
        keywords_count: keywordsWithBids.length,
        avg_bid: parseFloat(avgBid.toFixed(2)),
        suggested_budget: suggestedBudget,
        action: hasExisting ? 'keyword_add' : 'campaign_create',
        existing_campaign_id: existingCampaignId,
        keywords: keywordsWithBids,
        idempotency_key: idempotencyKey,
      });
    }

    if (preview_only) {
      return Response.json({ ok: true, proposals, decisions_created: 0 });
    }

    // ── 4. Criar OptimizationDecisions ──────────────────────────────────
    let decisionsCreated = 0;
    const createdIds = [];

    for (const p of proposals) {
      if (p.status === 'already_proposed') continue;

      const campaignName = `SP | MANUAL | EXACT | ${p.asin} | Winners`;
      const actionLabel = p.action === 'campaign_create'
        ? `Criar campanha manual exact com ${p.keywords_count} keyword(s) vencedora(s)`
        : `Adicionar ${p.keywords_count} keyword(s) vencedora(s) à campanha manual existente`;

      const decision = await base44.asServiceRole.entities.OptimizationDecision.create({
        amazon_account_id,
        decision_type: p.action === 'campaign_create' ? 'campaign_create' : 'keyword_add',
        entity_type: p.action === 'campaign_create' ? 'campaign' : 'keyword',
        asin: p.asin,
        campaign_id: p.existing_campaign_id || null,
        action: actionLabel,
        rationale: `Campanha manual exact proposta com base em ${p.keywords_count} search terms vencedores (orders > 0). ` +
          `Bid médio: R$${p.avg_bid.toFixed(2)} (baseado em CPC histórico, floor R$${BID_FLOOR}, cap R$${BID_CAP}). ` +
          `Budget diário sugerido: R$${p.suggested_budget.toFixed(2)}.`,
        data_used: JSON.stringify({
          keywords: p.keywords,
          avg_bid: p.avg_bid,
          suggested_budget: p.suggested_budget,
          campaign_name: campaignName,
          existing_campaign_id: p.existing_campaign_id || null,
        }),
        proposed_value: p.avg_bid,
        confidence: 80,
        risk: 'low',
        requires_approval: true,
        status: 'proposed',
        source_function: 'proposeManualCampaignsFromWinners',
        idempotency_key: p.idempotency_key,
        evaluated_at: new Date().toISOString(),
        approved_by: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).catch(e => {
        console.error(`Erro ao criar decisão para ${p.asin}:`, e.message);
        return null;
      });

      if (decision?.id) {
        decisionsCreated++;
        createdIds.push(decision.id);
        p.decision_id = decision.id;
        p.status = 'proposed';
      }
    }

    return Response.json({
      ok: true,
      message: `${decisionsCreated} decisão(ões) criada(s) para revisão. Aprovação humana obrigatória antes de qualquer criação na Amazon.`,
      proposals,
      decisions_created: decisionsCreated,
      decision_ids: createdIds,
    });

  } catch (error) {
    console.error('proposeManualCampaignsFromWinners error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});