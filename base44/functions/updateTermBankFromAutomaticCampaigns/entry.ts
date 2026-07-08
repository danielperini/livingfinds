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

    // 1. Buscar campanhas AUTO confirmadas (enabled ou paused, com campaign_id real)
    const autoCampaigns = await base44.asServiceRole.entities.Campaign.filter({
      amazon_account_id: aid,
      targeting_type: 'AUTO',
    }, '-spend', 200);

    const validCampaigns = autoCampaigns.filter(c =>
      c.campaign_id &&
      c.amazon_campaign_id &&
      ['enabled', 'paused'].includes((c.state || c.status || '').toLowerCase()) &&
      !c.archived
    );

    if (validCampaigns.length === 0) {
      return Response.json({ ok: true, skipped: true, reason: 'Nenhuma campanha AUTO válida encontrada', campaigns_checked: autoCampaigns.length });
    }

    const campaignIds = validCampaigns.map(c => c.campaign_id);

    // 2. Buscar search terms dessas campanhas (dos últimos 30 dias)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const allSearchTerms = await base44.asServiceRole.entities.SearchTerm.filter(
      { amazon_account_id: aid }, '-spend', 2000
    );

    // Filtrar apenas termos de campanhas AUTO válidas
    const autoSearchTerms = allSearchTerms.filter(st =>
      st.campaign_id && campaignIds.includes(st.campaign_id)
    );

    if (autoSearchTerms.length === 0) {
      return Response.json({ ok: true, skipped: true, reason: 'Nenhum search term encontrado nas campanhas AUTO', valid_campaigns: validCampaigns.length });
    }

    // 3. Buscar TermBank existente para deduplicação
    const existingTerms = await base44.asServiceRole.entities.TermBank.filter(
      { amazon_account_id: aid }, null, 5000
    );

    // Índice por chave composta
    const termIndex = new Map();
    for (const t of existingTerms) {
      const key = `${t.asin || ''}|${t.normalized_search_term || ''}|${t.source_campaign_id || ''}`;
      termIndex.set(key, t);
    }

    // Também construir mapa de campanha por campaign_id
    const campaignMap = new Map(validCampaigns.map(c => [c.campaign_id, c]));

    const now = new Date().toISOString();
    const toCreate = [];
    const toUpdate = [];

    for (const st of autoSearchTerms) {
      if (!st.search_term) continue;
      const norm = normalize(st.search_term);
      if (!norm || norm.length < 3) continue;

      const campaign = campaignMap.get(st.campaign_id);
      const asin = st.advertised_asin || campaign?.asin || '';
      const key = `${asin}|${norm}|${st.campaign_id || ''}`;

      const spend = st.spend || 0;
      const clicks = st.clicks || 0;
      const impressions = st.impressions || 0;
      const orders = st.orders_14d || st.orders_30d || 0;
      const sales = st.sales_14d || st.sales_30d || 0;
      const cpc = clicks > 0 ? spend / clicks : 0;
      const ctr = impressions > 0 ? clicks / impressions * 100 : 0;
      const convRate = clicks > 0 ? orders / clicks * 100 : 0;
      const acos = sales > 0 ? spend / sales * 100 : 0;
      const roas = spend > 0 ? sales / spend : 0;

      const record = {
        amazon_account_id: aid,
        asin,
        sku: st.advertised_sku || campaign?.asin || '',
        source_campaign_id: st.campaign_id || '',
        source_campaign_name: st.campaign_name || campaign?.name || campaign?.campaign_name || '',
        source_ad_group_id: st.ad_group_id || '',
        search_term: st.search_term,
        normalized_search_term: norm,
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
        report_date: st.date || st.synced_at?.slice(0, 10) || now.slice(0, 10),
        updated_at: now,
        status: 'active',
      };

      const existing = termIndex.get(key);
      if (existing) {
        toUpdate.push({ id: existing.id, ...record });
      } else {
        toCreate.push({ ...record, created_at: now });
      }
    }

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

    console.log(`[updateTermBank] Concluído: ${created} criados, ${updated} atualizados, ${autoSearchTerms.length} search terms processados`);

    return Response.json({
      ok: true,
      campaigns_valid: validCampaigns.length,
      search_terms_processed: autoSearchTerms.length,
      terms_created: created,
      terms_updated: updated,
      completed_at: now,
    });

  } catch (error) {
    console.error('[updateTermBank] Erro:', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});