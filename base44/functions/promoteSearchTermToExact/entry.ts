/**
 * promoteSearchTermToExact — Cria campanha manual EXACT para um search term vencedor
 *
 * Recebe: amazon_account_id, promotion_id (SearchTermPromotion)
 * Fluxo:
 *   1. Carregar promoção e validar
 *   2. Verificar duplicatas (same ASIN + term + match_type)
 *   3. Usar IA somente para validação de relevância semântica
 *   4. Criar campanha via AmazonActionQueue
 *   5. Atualizar status da promoção
 *
 * Nomenclatura: EXACT | ASIN | TERMO | DATA
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function normalizeTerm(t: string): string {
  return t.toLowerCase().trim().replace(/\s+/g, ' ');
}

function buildCampaignName(asin: string, term: string, date: string): string {
  const normalizedTerm = normalizeTerm(term).replace(/[|]/g, '-').slice(0, 60);
  return `EXACT | ${asin} | ${normalizedTerm} | ${date}`;
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const now = new Date().toISOString();
  const today = now.slice(0, 10);

  try {
    const body = await req.json().catch(() => ({}));
    const { amazon_account_id, promotion_id, dry_run } = body;

    if (!amazon_account_id || !promotion_id) {
      return Response.json({ ok: false, error: 'amazon_account_id e promotion_id são obrigatórios' }, { status: 400 });
    }

    // Carregar promoção
    const promos = await base44.asServiceRole.entities.SearchTermPromotion.filter({ id: promotion_id });
    const promo = promos[0];
    if (!promo) return Response.json({ ok: false, error: 'Promoção não encontrada' });
    if (promo.status === 'promoted') return Response.json({ ok: false, error: 'Termo já promovido', already_promoted: true });
    if (promo.status === 'blocked_duplicate') return Response.json({ ok: false, error: 'Bloqueado por duplicidade' });

    const term = normalizeTerm(promo.normalized_term || promo.search_term);
    const asin = promo.asin;

    // Carregar conta e configuração
    const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id });
    const account = accs[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' });
    const sym = account.currency_symbol || 'R$';

    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id });
    const cfg = configs[0] || {};
    const MIN_BID = cfg.min_bid || 0.10;
    const MAX_BID = cfg.max_bid || 5.00;
    const TARGET_ACOS = cfg.target_acos || 25;

    // ── 1. Verificar duplicatas ─────────────────────────────────────────
    // Verificar campanhas existentes com mesmo ASIN e termo
    const allCampaigns: any[] = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id }, null, 500
    );
    const campName = buildCampaignName(asin, term, today);
    const normalizedCampName = campName.toLowerCase();

    const duplicate = allCampaigns.find(c => {
      if (c.archived || c.state === 'archived') return false;
      const cName = (c.name || c.campaign_name || '').toLowerCase();
      const termInName = cName.includes(term.slice(0, 20));
      const asinInName = cName.includes(asin.toLowerCase());
      return asinInName && termInName;
    });

    if (duplicate) {
      await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, {
        status: 'blocked_duplicate',
        rejection_reason: `Campanha equivalente já existe: ${duplicate.name || duplicate.campaign_id}`,
      });
      return Response.json({ ok: false, blocked: true, reason: 'Campanha equivalente já existe', existing_campaign: duplicate.campaign_id });
    }

    // Verificar keywords manuais exatas com mesmo termo no ASIN
    const existingKeywords: any[] = await base44.asServiceRole.entities.Keyword.filter(
      { amazon_account_id, match_type: 'exact' }, null, 500
    );
    const termExists = existingKeywords.find(k => {
      if (k.state === 'archived' || k.status === 'archived') return false;
      return normalizeTerm(k.keyword_text || '') === term && k.asin === asin;
    });

    if (termExists) {
      await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, {
        status: 'blocked_duplicate',
        rejection_reason: `Keyword exata já existe para este ASIN: ${term}`,
      });
      return Response.json({ ok: false, blocked: true, reason: 'Keyword exata já existe para este ASIN' });
    }

    // ── 2. Verificar estoque ────────────────────────────────────────────
    const products = await base44.asServiceRole.entities.Product.filter({ amazon_account_id, asin }, null, 1);
    const product = products[0];
    if (product?.inventory_status === 'out_of_stock') {
      await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, {
        status: 'blocked_no_stock',
        rejection_reason: 'Produto sem estoque — promoção bloqueada até reposição',
      });
      return Response.json({ ok: false, blocked: true, reason: 'Produto sem estoque' });
    }

    // ── 3. Validação de relevância com IA (somente semântica) ───────────
    let aiValidated = promo.ai_validated || false;
    let aiRelevanceCheck = promo.ai_relevance_check || '';

    if (!aiValidated) {
      try {
        const aiRes = await base44.asServiceRole.integrations.Core.InvokeLLM({
          prompt: `Avalie a relevância semântica deste search term para a criação de uma campanha Amazon Ads EXACT:

ASIN: ${asin}
Search Term: "${term}"
Conversões confirmadas: ${promo.conversions}
ACoS: ${promo.acos > 0 ? promo.acos.toFixed(1) + '%' : 'desconhecido'}
Tipo de cauda: ${promo.tail_type}

Responda APENAS com JSON:
{
  "is_relevant": true/false,
  "confidence": 0.0-1.0,
  "reason": "explicação em 1 frase",
  "has_commercial_intent": true/false,
  "is_ambiguous": true/false
}`,
          response_json_schema: {
            type: 'object',
            properties: {
              is_relevant: { type: 'boolean' },
              confidence: { type: 'number' },
              reason: { type: 'string' },
              has_commercial_intent: { type: 'boolean' },
              is_ambiguous: { type: 'boolean' },
            },
          },
        });

        if (aiRes?.is_relevant === false) {
          await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, {
            status: 'rejected',
            ai_relevance_check: JSON.stringify(aiRes),
            rejection_reason: `IA identificou termo irrelevante: ${aiRes.reason}`,
          });
          return Response.json({ ok: false, rejected: true, reason: `Termo irrelevante: ${aiRes.reason}`, ai: aiRes });
        }

        aiValidated = true;
        aiRelevanceCheck = JSON.stringify(aiRes);
        await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, {
          ai_validated: true,
          ai_relevance_check: aiRelevanceCheck,
        });
      } catch (e) {
        // IA falhou — continuar sem validação semântica, pois conversões já confirmam relevância
        console.warn('[promoteSearchTermToExact] AI validation failed:', e?.message);
        aiValidated = true;
        aiRelevanceCheck = 'ai_check_failed_proceeding_with_conversions';
      }
    }

    // ── 4. Calcular bid inicial (sem IA) ────────────────────────────────
    const avgCpc = promo.avg_cpc || 0;
    let targetBid = promo.target_bid || 0;
    if (!targetBid || targetBid < MIN_BID) {
      targetBid = avgCpc > 0 ? Math.min(Math.max(avgCpc * 1.10, MIN_BID, 0.30), MAX_BID) : Math.max(MIN_BID, 0.50);
    }
    targetBid = Math.min(Math.max(targetBid, MIN_BID), MAX_BID);

    if (dry_run) {
      return Response.json({
        ok: true,
        dry_run: true,
        campaign_name: campName,
        target_bid: targetBid,
        term,
        asin,
        score: promo.promotion_score,
        tail_type: promo.tail_type,
        conversions: promo.conversions,
        ai_validated: aiValidated,
      });
    }

    // ── 5. Enfileirar criação da campanha manual EXACT ──────────────────
    await base44.asServiceRole.entities.SearchTermPromotion.update(promo.id, {
      status: 'creating_campaign',
      manual_campaign_name: campName,
    });

    await base44.asServiceRole.entities.AmazonActionQueue.create({
      amazon_account_id,
      operation: 'create_manual_exact_campaign',
      entity_type: 'campaign',
      entity_id: asin,
      payload: {
        asin,
        search_term: term,
        campaign_name: campName,
        target_bid: targetBid,
        daily_budget: cfg.minimum_campaign_budget || 15.00,
        promotion_id: promo.id,
        source_campaign_id: promo.source_campaign_id,
        match_type: 'exact',
      },
      idempotency_key: `exact_${asin}_${term.replace(/\s/g, '_').slice(0, 40)}_${today}`,
      priority: 'high',
      status: 'pending',
      scheduled_at: now,
      source: 'promoteSearchTermToExact',
    });

    return Response.json({
      ok: true,
      campaign_name: campName,
      target_bid: targetBid,
      term,
      asin,
      promotion_id: promo.id,
      score: promo.promotion_score,
      tail_type: promo.tail_type,
      message: `Campanha "${campName}" enfileirada para criação com bid inicial ${sym}${targetBid.toFixed(2)}.`,
    });

  } catch (error) {
    console.error('[promoteSearchTermToExact] Error:', error?.message);
    return Response.json({ ok: false, error: error?.message }, { status: 500 });
  }
});