/**
 * updateTermBankFromAutomaticCampaigns
 * Roda semanalmente: coleta search terms de campanhas AUTO confirmadas
 * e atualiza o TermBank sem duplicar termos.
 * Chave de deduplicação: amazon_account_id + asin + normalized_search_term + source_campaign_id
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function normalize(term) {
  return (term || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);

    // Aceita chamada de serviço (automação agendada) ou usuário autenticado
    let amazonAccountId;
    try {
      const body = await req.json().catch(() => ({}));
      amazonAccountId = body.amazon_account_id;
    } catch {}

    const accounts = await base44.asServiceRole.entities.AmazonAccount.list('-created_date', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon encontrada' });

    const aid = amazonAccountId || account.id;

    // 1. Buscar campanhas AUTO e MANUAL confirmadas (enabled ou paused, com campaign_id real)
    const allCampaigns = await base44.asServiceRole.entities.Campaign.filter({
      amazon_account_id: aid,
    }, '-spend', 500);

    const validCampaigns = allCampaigns.filter(c =>
      c.campaign_id &&
      ['enabled', 'paused'].includes((c.state || c.status || '').toLowerCase()) &&
      !c.archived
    );

    if (validCampaigns.length === 0) {
      return Response.json({ ok: true, skipped: true, reason: 'Nenhuma campanha válida encontrada', campaigns_checked: allCampaigns.length });
    }

    const campaignIds = new Set(validCampaigns.map(c => c.campaign_id));

    // 2. Buscar search terms dessas campanhas — filtrar por >= 3 pedidos (30d) ou >= 2 (14d)
    const allSearchTerms = await base44.asServiceRole.entities.SearchTerm.filter(
      { amazon_account_id: aid }, '-orders_30d', 3000
    );

    // Critério: orders_30d >= 3 OU orders_14d >= 2 (ambos indicam termo com conversão consistente)
    // Não restringir por campaign_id pois os IDs podem divergir entre SearchTerm e Campaign
    const MIN_ORDERS_30D = 3;
    const MIN_ORDERS_14D = 2;
    const autoSearchTerms = allSearchTerms.filter(st => {
      if (!st.search_term || st.search_term.length < 3) return false;
      // Ignorar ASINs como search term
      if (/^B0[A-Z0-9]{8}$/i.test(st.search_term.trim())) return false;
      const o30 = st.orders_30d || 0;
      const o14 = st.orders_14d || 0;
      const oGeneric = st.orders || 0;
      return o30 >= MIN_ORDERS_30D || o14 >= MIN_ORDERS_14D || oGeneric >= MIN_ORDERS_30D;
    });
    const MIN_ORDERS = MIN_ORDERS_30D; // para o log

    if (autoSearchTerms.length === 0) {
      return Response.json({ ok: true, skipped: true, reason: 'Nenhum search term encontrado nas campanhas AUTO', valid_campaigns: validCampaigns.length });
    }

    // 3. Buscar TermBank existente para deduplicação (por asin + term normalizado)
    const existingTerms = await base44.asServiceRole.entities.TermBank.filter(
      { amazon_account_id: aid }, null, 5000
    );

    // Índice por asin + term normalizado (sem depender de source_campaign_id)
    const termIndex = new Map();
    for (const t of existingTerms) {
      const norm = normalize(t.term || t.normalized_search_term || '');
      const key = `${t.asin || ''}|${norm}`;
      termIndex.set(key, t);
    }

    // Construir mapa de campanha por campaign_id E amazon_campaign_id
    const campaignMap = new Map();
    for (const c of validCampaigns) {
      if (c.campaign_id) campaignMap.set(c.campaign_id, c);
      if (c.amazon_campaign_id) campaignMap.set(c.amazon_campaign_id, c);
    }

    const now = new Date().toISOString();
    const toCreate = [];
    const toUpdateMap = new Map(); // id → record — evita IDs duplicados no bulkUpdate

    for (const st of autoSearchTerms) {
      if (!st.search_term) continue;
      const norm = normalize(st.search_term);
      if (!norm || norm.length < 3) continue;

      const campaign = campaignMap.get(st.campaign_id);
      const asin = st.advertised_asin || campaign?.asin || '';
      const key = `${asin}|${norm}`;

      const spend = st.spend || 0;
      const clicks = st.clicks || 0;
      const impressions = st.impressions || 0;
      const orders = Math.max(st.orders_30d || 0, st.orders_14d || 0, st.orders || 0);
      const sales = Math.max(st.sales_30d || 0, st.sales_14d || 0, st.sales || 0);
      const cpc = clicks > 0 ? spend / clicks : 0;
      const ctr = impressions > 0 ? clicks / impressions * 100 : 0;
      const convRate = clicks > 0 ? orders / clicks * 100 : 0;
      const acos = sales > 0 ? spend / sales * 100 : 0;
      const roas = spend > 0 ? sales / spend : 0;
      // Classificar: winner se tem conversões e ACOS razoável
      const classification = orders >= 3 ? (acos > 0 && acos < 60 ? 'winner' : 'learning') : 'learning';
      const campaignType = campaign?.targeting_type || 'AUTO';

      const record = {
        amazon_account_id: aid,
        term: st.search_term,
        term_normalized: norm,
        asin,
        sku: st.advertised_sku || campaign?.sku || '',
        product_name: campaign?.name || '',
        match_type: (st.match_type || 'auto').toLowerCase(),
        source: campaignType === 'MANUAL' ? 'search_term_auto' : 'search_term_auto',
        source_detail: `${campaignType} | ${st.campaign_name || campaign?.campaign_name || campaign?.name || ''}`,
        campaign_id: st.campaign_id || '',
        amazon_campaign_id: campaign?.amazon_campaign_id || st.campaign_id || '',
        impressions,
        clicks,
        spend,
        orders,
        sales,
        cpc: Math.round(cpc * 100) / 100,
        ctr: Math.round(ctr * 1000) / 1000,
        conversion_rate: Math.round(convRate * 100) / 100,
        acos: Math.round(acos * 100) / 100,
        roas: Math.round(roas * 100) / 100,
        cvr: Math.round(convRate * 100) / 100,
        status: 'active',
        classification,
        confidence: orders >= 5 ? 95 : orders >= 3 ? 85 : 75,
        promotion_status: 'in_auto_campaign',
        last_seen_at: now,
        updated_at: now,
      };

      const existing = termIndex.get(key);
      if (existing) {
        // Deduplicar por ID: se o mesmo registro já foi mapeado, manter o com mais pedidos
        const prev = toUpdateMap.get(existing.id);
        if (!prev || orders > (prev.orders || 0)) {
          toUpdateMap.set(existing.id, { id: existing.id, ...record });
        }
      } else {
        toCreate.push({ ...record, first_seen_at: now, created_at: now });
      }
    }

    const toUpdate = Array.from(toUpdateMap.values());

    // 4. Persistir em batches de 100
    const BATCH = 100;
    let created = 0;
    let updated = 0;

    for (let i = 0; i < toCreate.length; i += BATCH) {
      await base44.asServiceRole.entities.TermBank.bulkCreate(toCreate.slice(i, i + BATCH));
      created += toCreate.slice(i, i + BATCH).length;
    }

    for (let i = 0; i < toUpdate.length; i += BATCH) {
      await base44.asServiceRole.entities.TermBank.bulkUpdate(toUpdate.slice(i, i + BATCH));
      updated += toUpdate.slice(i, i + BATCH).length;
    }

    console.log(`[updateTermBank] Concluído: ${created} criados, ${updated} atualizados, ${autoSearchTerms.length} termos com >= ${MIN_ORDERS} pedidos (de ${allSearchTerms.length} total)`);

    return Response.json({
      ok: true,
      campaigns_valid: validCampaigns.length,
      search_terms_total: allSearchTerms.length,
      search_terms_with_min_orders: autoSearchTerms.length,
      min_orders_filter: MIN_ORDERS,
      terms_created: created,
      terms_updated: updated,
      completed_at: now,
    });

  } catch (error) {
    console.error('[updateTermBank] Erro:', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});