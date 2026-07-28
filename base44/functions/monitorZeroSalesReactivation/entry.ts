import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { normalize } from '../../shared/textUtils.ts';

export default async function(req) {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { amazon_account_id } = body;
    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    const base44sr = base44.asServiceRole;
    const now = new Date();
    const since14 = new Date(now.getTime() - 14 * 86400000).toISOString().slice(0, 10);

    // Buscar keywords arquivadas por zero_sales
    const archivedKws = await base44sr.entities.Keyword.filter(
      { amazon_account_id, archive_reason: 'archived_from_zero_sales' },
      '-archived_at',
      500
    ).catch(() => []);

    if (archivedKws.length === 0) {
      return Response.json({ ok: true, monitored: 0, reactivated: 0, message: 'Nenhuma keyword em monitoramento' });
    }

    // Buscar métricas dos últimos 14 dias para detectar conversões
    const recentMetrics = await base44sr.entities.CampaignMetricsDaily.filter(
      { amazon_account_id },
      '-date',
      1000
    ).catch(() => []);

    // Buscar search terms recentes com conversão (proxy)
    const recentSearchTerms = await base44sr.entities.SearchTerm.filter(
      { amazon_account_id },
      '-last_seen_at',
      500
    ).catch(() => []);

    // Buscar keywords ativas com conversão
    const activeKws = await base44sr.entities.Keyword.filter(
      { amazon_account_id },
      '-orders',
      500
    ).catch(() => []);

    // Map de termo normalizado → { orders, acos, asin }
    const convertingTerms = new Map();
    for (const kw of activeKws) {
      if ((kw.orders || 0) < 1) continue;
      const state = (kw.state || kw.status || '').toLowerCase();
      if (state === 'archived') continue;
      const norm = normalize(kw.keyword_text || kw.keyword || '');
      if (!norm) continue;
      const key = `${kw.asin || ''}::${norm}`;
      if (!convertingTerms.has(key)) {
        convertingTerms.set(key, { orders: kw.orders || 0, acos: kw.acos || 0, asin: kw.asin });
      }
    }

    // Também buscar em search terms
    for (const st of recentSearchTerms) {
      if ((st.orders || st.conversions || 0) < 1) continue;
      const norm = normalize(st.keyword_text || st.keyword || '');
      if (!norm) continue;
      const key = `${st.asin || ''}::${norm}`;
      if (!convertingTerms.has(key)) {
        convertingTerms.set(key, { orders: st.orders || st.conversions || 0, acos: st.acos || 0, asin: st.asin });
      }
    }

    let reactivated = 0;
    const reactivatedTerms = [];

    for (const kw of archivedKws) {
      const norm = normalize(kw.keyword_text || kw.keyword || '');
      if (!norm || !kw.asin) continue;

      const key = `${kw.asin}::${norm}`;
      const convertingData = convertingTerms.get(key);
      if (!convertingData) continue;

      // Verificar se já tem campanha ou kickoff pendente para este termo
      const existingKickoff = await base44sr.entities.ProductKickoffQueue.filter(
        { amazon_account_id, asin: kw.asin, keyword: kw.keyword_text },
        null,
        1
      ).catch(() => []);

      if (existingKickoff.length > 0) continue;

      // Verificar estoque
      const products = await base44sr.entities.Product.filter(
        { amazon_account_id, asin: kw.asin },
        null,
        1
      ).catch(() => []);
      const hasStock = (products[0]?.fba_inventory || 0) > 0;
      if (!hasStock) continue;

      // Criar kickoff para nova campanha MANUAL EXACT
      await base44sr.entities.ProductKickoffQueue.create({
        amazon_account_id,
        asin: kw.asin,
        keyword: kw.keyword_text,
        mode: 'manual_only',
        status: 'scheduled',
        queue_hour: new Date().getHours(),
        queue_window: 'zero_sales_reactivation',
        scheduled_at: new Date(now.getTime() + 10 * 60000).toISOString(),
      }).catch(() => {});

      // Atualizar SearchTermPromotion para reativada
      await base44sr.entities.SearchTermPromotion.updateMany(
        {
          amazon_account_id,
          asin: kw.asin,
          normalized_keyword: `__cleanup__${kw.asin}`,
          status: 'monitoring',
        },
        { $set: { status: 'reactivated', reactivated_at: now.toISOString() } }
      ).catch(() => {});

      reactivatedTerms.push({
        asin: kw.asin,
        keyword: kw.keyword_text,
        orders: convertingData.orders,
        acos: convertingData.acos,
      });
      reactivated++;

      if (reactivated >= 10) break;
    }

    // Registrar log
    await base44sr.entities.SyncExecutionLog.create({
      amazon_account_id,
      operation: 'zero_sales_reactivation_monitor',
      trigger_type: 'automatic',
      status: 'completed',
      started_at: now.toISOString(),
      completed_at: new Date().toISOString(),
      records_processed: archivedKws.length,
      result_summary: `Monitor: ${archivedKws.length} termos observados, ${reactivated} reativados com kickoff agendado.`,
    }).catch(() => {});

    return Response.json({
      ok: true,
      monitored: archivedKws.length,
      reactivated,
      reactivated_terms: reactivatedTerms,
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}