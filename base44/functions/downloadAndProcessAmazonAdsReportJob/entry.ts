/**
 * downloadAndProcessAmazonAdsReportJob
 *
 * Baixa URL do relatório, descompacta GZIP_JSON, parseia e faz upsert em CampaignMetricsDaily.
 * Marca job como processed.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { waitUntil } from 'base44:runtime';
import {
  canonicalMatchType,
  normalizeSearchTerm,
  resolveSameSkuAttribution,
} from '../../shared/searchTermHarvestPolicy.ts';

async function decompress(buf: ArrayBuffer): Promise<any[]> {
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(new Uint8Array(buf));
  writer.close();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return JSON.parse(new TextDecoder().decode(merged));
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

const ASIN_RE = /\b(B0[A-Z0-9]{8})\b/i;

function campaignTypeOf(campaign: any): string {
  const targeting = String(campaign?.targeting_type || '').toUpperCase();
  const name = String(campaign?.name || campaign?.campaign_name || '').toUpperCase();
  return targeting.includes('AUTO') || /^AUTO\s*\|/.test(name) || /\|\s*AUTO\s*\|/.test(name)
    ? 'AUTO'
    : 'MANUAL';
}

async function bulkUpsertBatched(entity: any, records: any[], batchSize = 100) {
  for (let i = 0; i < records.length; i += batchSize) {
    await entity.bulkCreate(records.slice(i, i + batchSize));
    if (i + batchSize < records.length) await sleep(150);
  }
}

async function upsertByNaturalKey(entity: any, records: any[], batchSize = 20) {
  let upserted = 0;
  for (let i = 0; i < records.length; i += batchSize) {
    await Promise.all(records.slice(i, i + batchSize).map(async (record) => {
      const existing = await entity.filter({ unique_key: record.unique_key }, '-updated_at', 1).catch(() => []);
      if (existing[0]?.id) await entity.update(existing[0].id, record);
      else await entity.create(record);
      upserted++;
    }));
  }
  return upserted;
}

async function upsertDailySearchTerms(base44: any, accountId: string, records: any[]) {
  const existing: any[] = [];
  for (let skip = 0; skip < 20000; skip += 5000) {
    const page = await base44.asServiceRole.entities.SearchTerm.filter(
      { amazon_account_id: accountId }, '-date', 5000, skip,
    ).catch(() => []);
    existing.push(...page);
    if (page.length < 5000) break;
  }
  const byKey = new Map(existing.filter((row: any) => row.unique_key).map((row: any) => [row.unique_key, row]));
  const creates: any[] = [];
  const updates: any[] = [];
  for (const record of records) {
    const current: any = byKey.get(record.unique_key);
    if (current?.id) updates.push({
      id: current.id,
      ...record,
      classification: current.promoted_to_manual === true ? 'PROMOTED_EXACT' : record.classification,
      evaluation_count: Number(current.evaluation_count || 0) + 1,
    });
    else creates.push({ ...record, first_seen_at: record.synced_at });
  }
  for (let index = 0; index < creates.length; index += 100) {
    await base44.asServiceRole.entities.SearchTerm.bulkCreate(creates.slice(index, index + 100));
  }
  for (let index = 0; index < updates.length; index += 100) {
    await base44.asServiceRole.entities.SearchTerm.bulkUpdate(updates.slice(index, index + 100));
  }
  return { created: creates.length, updated: updates.length, total: records.length };
}

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    if (!body._service_role) {
      return Response.json({ ok: false, error: 'Uso interno apenas' }, { status: 403 });
    }

    const { job_id } = body;
    if (!job_id) return Response.json({ ok: false, error: 'job_id obrigatório' }, { status: 400 });

    const now = new Date().toISOString();

    // Carregar job
    const jobs = await base44.asServiceRole.entities.AmazonAdsReportJob.filter({ id: job_id }, undefined, 1);
    const job = jobs[0];
    if (!job) return Response.json({ ok: false, error: 'Job não encontrado' }, { status: 404 });

    if (!job.url) {
      // Verificar se URL expirou
      if (job.status === 'expired') {
        return Response.json({ ok: false, error: 'URL do relatório expirada — recriação necessária', expired: true });
      }
      return Response.json({ ok: false, error: 'Job sem URL de download ainda' });
    }

    // Verificar se URL expirou
    if (job.url_expires_at && job.url_expires_at < now) {
      await base44.asServiceRole.entities.AmazonAdsReportJob.update(job_id, {
        status: 'expired',
        error_message: 'URL de download expirou antes do download',
        updated_at: now,
      }).catch(() => {});
      return Response.json({ ok: false, error: 'URL do relatório expirada', expired: true });
    }

    // Marcar como downloading
    await base44.asServiceRole.entities.AmazonAdsReportJob.update(job_id, {
      status: 'downloaded',
      downloaded_at: now,
      updated_at: now,
    }).catch(() => {});

    // Baixar arquivo
    const dlRes = await fetch(job.url);
    if (!dlRes.ok) {
      await base44.asServiceRole.entities.AmazonAdsReportJob.update(job_id, {
        status: 'failed',
        error_message: `Falha ao baixar: HTTP ${dlRes.status}`,
        updated_at: now,
      }).catch(() => {});
      return Response.json({ ok: false, error: `Falha ao baixar relatório: HTTP ${dlRes.status}` });
    }

    const buf = await dlRes.arrayBuffer();
    const rows = await decompress(buf);

    console.log(`[downloadProcess] Job ${job_id}: ${rows.length} linhas no relatório`);

    if (rows.length === 0) {
      await base44.asServiceRole.entities.AmazonAdsReportJob.update(job_id, {
        status: 'processed',
        processed_at: now,
        records_processed: 0,
        updated_at: now,
      }).catch(() => {});
      return Response.json({ ok: true, records: 0, message: 'Relatório vazio processado' });
    }

    const accountId = job.amazon_account_id;
    const endDate = job.end_date;

    // Construir registros de métricas por data+campanha
    const metricsMap = new Map<string, any>();

    // Detectar tipo de relatório pelo conteúdo da primeira linha
    const firstRow = rows[0] || {};
    const isTargetingReport = 'targetingId' in firstRow || 'targetingExpression' in firstRow;
    const isKeywordsReport = 'keywordId' in firstRow && !isTargetingReport;
    const isSearchTermReport = job.report_type_id === 'spSearchTerm' || 'searchTerm' in firstRow;
    const groupBy = Array.isArray(job.group_by) ? job.group_by : [];
    const isPlacementReport = groupBy.includes('campaignPlacement');
    const isCanonicalCampaignReport = job.report_type_id === 'spCampaigns' &&
      groupBy.includes('campaign') && !isPlacementReport;

    const dimension = job.report_type_id === 'spTargeting' ? 'targeting'
      : job.report_type_id === 'spAdGroups' ? 'ad_group'
      : isPlacementReport ? 'placement'
      : job.report_type_id === 'spPurchasedProduct' ? 'purchased_product'
      : job.report_type_id === 'spSearchTermImpressionShare' ? 'impression_share'
      : null;

    let searchTermRecords: any[] = [];

    // Nem toda conta devolve ASIN/SKU no relatório de termos. O vínculo é
    // resolvido pelo ProductAd/ad group e pela campanha canônica. Ambiguidade é
    // persistida explicitamente e impede promoção automática.
    if (isSearchTermReport) {
      const [campaigns, productAds] = await Promise.all([
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, undefined, 5000).catch(() => []),
        base44.asServiceRole.entities.ProductAd.filter({ amazon_account_id: accountId }, undefined, 5000).catch(() => []),
      ]);
      const campaignById = new Map<string, any>();
      for (const campaign of campaigns) {
        for (const id of [campaign.id, campaign.campaign_id, campaign.amazon_campaign_id].filter(Boolean)) {
          campaignById.set(String(id), campaign);
        }
      }
      const adsByAdGroup = new Map<string, any[]>();
      const adsByCampaign = new Map<string, any[]>();
      for (const ad of productAds) {
        if (String(ad.state || ad.status || '').toLowerCase() === 'archived') continue;
        const adGroupId = String(ad.ad_group_id || '');
        const campaignId = String(ad.campaign_id || '');
        if (adGroupId) adsByAdGroup.set(adGroupId, [...(adsByAdGroup.get(adGroupId) || []), ad]);
        if (campaignId) adsByCampaign.set(campaignId, [...(adsByCampaign.get(campaignId) || []), ad]);
      }

      const resolveAdvertisedProduct = (row: any) => {
        const reportAsin = String(row.advertisedAsin || '').trim().toUpperCase();
        if (reportAsin) return { asin: reportAsin, sku: String(row.advertisedSku || ''), status: 'resolved_report' };

        const campaignId = String(row.campaignId || '');
        const adGroupId = String(row.adGroupId || '');
        const adCandidates = adsByAdGroup.get(adGroupId) || adsByCampaign.get(campaignId) || [];
        const distinctAsins = [...new Set(adCandidates.map((ad: any) => String(ad.asin || '').toUpperCase()).filter(Boolean))];
        if (distinctAsins.length === 1) {
          const ad =
            adCandidates.find(
              (candidate: any) =>
                String(
                  candidate.asin || ''
                ).toUpperCase() ===
                distinctAsins[0]
            ) || {};

          /*
           * V3:
           *
           * O ad group/campaign anuncia inequivocamente
           * um único ASIN.
           *
           * searchTermHarvestPolicy usa exatamente este
           * sinal para o fallback determinístico quando
           * a Amazon não devolve as colunas promoted/
           * same-SKU separadamente.
           */
          return {
            asin: distinctAsins[0],
            sku: String(ad.sku || ''),
            status: 'single_advertised_sku'
          };
        }
        if (distinctAsins.length > 1) return { asin: '', sku: '', status: 'ambiguous' };

        const campaign = campaignById.get(campaignId);
        if (campaign?.asin) return { asin: String(campaign.asin).toUpperCase(), sku: String(campaign.sku || ''), status: 'resolved_campaign' };

        const match = `${row.adGroupName || ''} ${row.campaignName || ''}`.match(ASIN_RE);
        return match
          ? { asin: match[1].toUpperCase(), sku: '', status: 'resolved_name' }
          : { asin: '', sku: '', status: 'missing' };
      };

      searchTermRecords = rows.map((row: any) => {
        const date = String(row.date || endDate || '');
        const campaignId = String(row.campaignId || '');
        const adGroupId = String(row.adGroupId || '');
        const keywordId = String(row.keywordId || '');
        const term = String(row.searchTerm || '').trim();
        const normalizedTerm = normalizeSearchTerm(term);
        const campaign = campaignById.get(campaignId);
        const campaignType = campaignTypeOf(campaign);
        const rawMatchType = String(row.matchType || row.keywordType || '').toLowerCase();
        const normalizedMatchType = canonicalMatchType(rawMatchType, campaignType);
        const sourceType = campaignType === 'AUTO' ? 'AUTO_SEARCH_TERM'
          : String(row.targetingExpression || row.targetExpression || '').trim() ? 'PRODUCT_TARGETING_SEARCH_TERM'
          : normalizedMatchType === 'exact' ? 'MANUAL_EXACT_SEARCH_TERM'
          : normalizedMatchType === 'phrase' ? 'MANUAL_PHRASE_SEARCH_TERM'
          : 'MANUAL_BROAD_SEARCH_TERM';
        const product = resolveAdvertisedProduct(row);
        const attribution = resolveSameSkuAttribution(row);
        const impressions = Number(row.impressions || 0);
        const clicks = Number(row.clicks || 0);
        const spend = Number(row.cost || row.spend || 0);
        const sourceIdentity = keywordId || rawMatchType || 'auto';

        return {
          amazon_account_id: accountId,
          date,
          campaign_id: campaignId,
          campaign_name: row.campaignName || campaign?.name || campaign?.campaign_name || '',
          ad_group_id: adGroupId,
          ad_group_name: row.adGroupName || '',
          keyword_id: keywordId,
          keyword_text: row.keyword || row.keywordText || '',
          keyword_type: row.keywordType || '',
          match_type: normalizedMatchType,
          search_term: term,
          normalized_search_term: normalizedTerm,
          search_term_original: term,
          search_term_normalized: normalizedTerm,
          campaign_type: campaignType,
          targeting_type: campaign?.targeting_type || (campaignType === 'AUTO' ? 'AUTO' : 'MANUAL'),
          target_id: String(row.targetingId || row.targetId || keywordId || ''),
          target_expression: String(row.targetingExpression || row.targetExpression || ''),
          source_type: sourceType,
          advertised_asin: product.asin,
          advertised_sku: product.sku,
          sku_resolution_status: product.status,
          impressions,
          clicks,
          ctr: impressions > 0 ? clicks / impressions * 100 : 0,
          cpc: clicks > 0 ? spend / clicks : 0,
          spend,
          orders_1d: Number(row.purchases1d || 0),
          orders_7d: Number(row.purchases7d || 0),
          orders_14d: Number(row.purchases14d || 0),
          orders_30d: Number(row.purchases30d || 0),
          units_1d: Number(row.unitsSoldClicks1d || 0),
          units_7d: Number(row.unitsSoldClicks7d || 0),
          units_14d: Number(row.unitsSoldClicks14d || 0),
          units_30d: Number(row.unitsSoldClicks30d || 0),
          sales_1d: Number(row.sales1d || 0),
          sales_7d: Number(row.sales7d || 0),
          sales_14d: Number(row.sales14d || 0),
          sales_30d: Number(row.sales30d || 0),
          total_orders: attribution.totalOrders,
          total_sales: attribution.totalSales,
          same_sku_orders: attribution.sameSkuOrders,
          same_sku_units: attribution.sameSkuOrders,
          same_sku_sales: attribution.sameSkuSales,
          halo_orders: attribution.haloOrders,
          halo_units: attribution.haloOrders,
          halo_sales: attribution.haloSales,
          same_asin_order: attribution.sameSkuOrders > 0,
          halo_order: attribution.haloOrders > 0,
          same_sku_attribution_verified: attribution.verified,
          attribution_window_days: attribution.windowDays,
          attribution_source: attribution.source,
          acos_7d: Number(row.sales7d || 0) > 0 ? spend / Number(row.sales7d) * 100 : 0,
          acos_14d: Number(row.sales14d || 0) > 0 ? spend / Number(row.sales14d) * 100 : 0,
          roas_7d: spend > 0 ? Number(row.sales7d || 0) / spend : 0,
          roas_14d: spend > 0 ? Number(row.sales14d || 0) / spend : 0,
          conversion_rate: clicks > 0 ? attribution.totalOrders / clicks * 100 : 0,
          source_campaign_type: campaignType,
          source_target_type: rawMatchType || (campaignType === 'AUTO' ? 'auto' : 'unknown'),
          source_target_id: keywordId,
          report_job_id: job.id,
          report_id: String(job.report_id || ''),
          performance_window: `${job.start_date || date}|${job.end_date || date}`,
          unique_key: [accountId, campaignId, adGroupId, sourceIdentity, normalizedTerm, date].join('|'),
          synced_at: now,
          metrics_fresh_at: now,
          last_seen_at: `${date}T23:59:59-03:00`,
          last_evaluated_at: now,
          evaluation_count: 1,
          classification: attribution.sameSkuOrders > 0 ? 'FIRST_SALE' : 'NEW',
        };
      }).filter((row: any) => row.campaign_id && row.search_term && row.date);

      const persisted = await upsertDailySearchTerms(base44, accountId, searchTermRecords);
      console.log(`[downloadProcess] SearchTerm: ${persisted.created} criados + ${persisted.updated} atualizados; mesmo-SKU explícito=${searchTermRecords.filter((row: any) => row.same_sku_attribution_verified).length}`);
    }

    // Relatórios auxiliares ficam em uma dimensão própria. Eles nunca podem
    // apagar ou substituir CampaignMetricsDaily, cuja fonte canônica é spCampaigns/campaign.
    if (dimension) {
      const dimensionRecords = rows.map((row: any) => {
        const date = row.date || endDate;
        const campaignId = String(row.campaignId || '');
        const adGroupId = String(row.adGroupId || '');
        const targetId = String(row.targetingId || row.targetId || '');
        const keywordId = String(row.keywordId || '');
        const purchasedAsin = String(row.purchasedAsin || '');
        const placement = String(row.placementClassification || '');
        const searchTerm = String(row.searchTerm || '');
        return {
          amazon_account_id: accountId,
          report_job_id: job.id,
          report_id: String(job.report_id || ''),
          report_type_id: String(job.report_type_id || ''),
          dimension,
          date,
          campaign_id: campaignId,
          campaign_name: row.campaignName || '',
          ad_group_id: adGroupId,
          ad_group_name: row.adGroupName || '',
          keyword_id: keywordId,
          keyword_text: row.keyword || '',
          targeting_id: targetId,
          targeting_expression: row.targetingExpression || row.targetingText || '',
          match_type: String(row.matchType || '').toLowerCase(),
          placement,
          advertised_asin: row.advertisedAsin || '',
          advertised_sku: row.advertisedSku || '',
          purchased_asin: purchasedAsin,
          search_term: searchTerm,
          impression_share: Number(row.searchTermImpressionShare || row.impressionShare || 0),
          impression_rank: Number(row.searchTermImpressionRank || row.impressionRank || 0),
          impressions: Number(row.impressions || 0),
          clicks: Number(row.clicks || 0),
          spend: Number(row.cost || row.spend || 0),
          sales: Number(row.sales14d || row.sales7d || row.sales30d || 0),
          orders: Number(row.purchases14d || row.purchases7d || row.purchases30d || 0),
          units: Number(row.unitsSoldClicks14d || row.unitsSoldClicks7d || row.unitsSoldClicks30d || 0),
          raw_data: row,
          unique_key: dimension === 'targeting'
            ? [accountId, targetId || keywordId, date].join('|')
            : dimension === 'ad_group'
              ? [accountId, adGroupId, date].join('|')
              : dimension === 'placement'
                ? [accountId, campaignId, placement, date].join('|')
                : dimension === 'purchased_product'
                  ? [accountId, campaignId, purchasedAsin, date].join('|')
                  : [accountId, campaignId, keywordId, searchTerm, date].join('|'),
          synced_at: now,
        };
      });
      const withRatios = dimensionRecords.map((row: any) => ({
        ...row,
        target_id: row.targeting_id,
        target_expression: row.targeting_expression,
        targeting_type: row.targeting_id ? 'target' : row.keyword_id ? 'keyword' : '',
        acos: row.sales > 0 ? row.spend / row.sales * 100 : 0,
        roas: row.spend > 0 ? row.sales / row.spend : 0,
        cpc: row.clicks > 0 ? row.spend / row.clicks : 0,
        ctr: row.impressions > 0 ? row.clicks / row.impressions * 100 : 0,
        conversion_rate: row.clicks > 0 ? row.orders / row.clicks * 100 : 0,
        data_status: 'confirmed',
      }));
      const entityName = dimension === 'targeting' ? 'TargetingMetricsDaily'
        : dimension === 'ad_group' ? 'AdGroupMetricsDaily'
        : dimension === 'placement' ? 'PlacementMetricsDaily'
        : dimension === 'purchased_product' ? 'PurchasedProductMetricsDaily'
        : 'AdsPerformanceDimensionDaily';
      const entity = base44.asServiceRole.entities[entityName];
      const dedicatedRecords = entityName === 'AdsPerformanceDimensionDaily' ? withRatios : withRatios.map((row: any) => {
        const common = {
          amazon_account_id: row.amazon_account_id,
          campaign_id: row.campaign_id,
          ad_group_id: row.ad_group_id,
          date: row.date,
          synced_at: row.synced_at,
          report_id: row.report_id,
          unique_key: row.unique_key,
        };
        if (dimension === 'targeting') return {
          ...common,
          target_id: row.target_id,
          keyword_id: row.keyword_id,
          keyword_text: row.keyword_text,
          target_expression: row.target_expression,
          targeting_type: row.targeting_type,
          match_type: row.match_type,
          impressions: row.impressions, clicks: row.clicks, spend: row.spend,
          sales: row.sales, orders: row.orders, acos: row.acos, roas: row.roas,
          cpc: row.cpc, ctr: row.ctr, conversion_rate: row.conversion_rate,
          data_status: row.data_status,
        };
        if (dimension === 'ad_group') return {
          ...common,
          ad_group_name: row.ad_group_name,
          impressions: row.impressions, clicks: row.clicks, spend: row.spend,
          sales: row.sales, orders: row.orders, acos: row.acos, roas: row.roas,
          cpc: row.cpc, ctr: row.ctr, data_status: row.data_status,
        };
        if (dimension === 'placement') return {
          ...common,
          placement: row.placement,
          impressions: row.impressions, clicks: row.clicks, spend: row.spend,
          sales: row.sales, orders: row.orders, acos: row.acos, roas: row.roas,
          cpc: row.cpc, ctr: row.ctr, conversion_rate: row.conversion_rate,
          data_status: row.data_status,
        };
        return {
          ...common,
          keyword_id: row.keyword_id,
          target_id: row.target_id,
          advertised_asin: row.advertised_asin,
          purchased_asin: row.purchased_asin,
          units: row.units,
          orders: row.orders,
          sales: row.sales,
        };
      });
      const persisted = await upsertByNaturalKey(entity, dedicatedRecords);
      console.log(`[downloadProcess] ${entityName}/${dimension}: ${persisted} registros em upsert; histórico preservado`);
    }

    for (const row of rows) {
      const date = row.date || endDate;
      const campaignId = String(row.campaignId || '');
      if (!campaignId) continue;

      // spTargeting: targetingId/targetingText/bid — excluir product targets (targetingExpression começa com 'asin=')
      // spKeywords: keywordId/keyword/keywordBid
      const targetingExpr = String(row.targetingExpression || '');
      const isProductTarget = isTargetingReport && (targetingExpr.startsWith('asin=') || targetingExpr.startsWith('similar-product'));

      const keywordId = String(row.targetingId || row.keywordId || '');
      const keywordText = row.targetingText || row.keyword || '';
      const bid = Number(row.bid || row.keywordBid) || 0;
      const matchType = (row.matchType || '').toLowerCase();

      // Para relatórios de keyword/targeting (excluindo product targets): popular entidade Keyword
      if ((isTargetingReport || isKeywordsReport) && keywordId && !isSearchTermReport && !isProductTarget) {
        const kwKey = `kw|${keywordId}|${date}`;
        if (!metricsMap.has(kwKey)) {
          metricsMap.set(kwKey, {
            _type: 'keyword',
            amazon_account_id: accountId,
            campaign_id: campaignId,
            campaign_name: row.campaignName || '',
            ad_group_id: String(row.adGroupId || ''),
            ad_group_name: row.adGroupName || '',
            keyword_id: keywordId,
            keyword_text: keywordText,
            match_type: matchType,
            bid,
            date,
            impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0,
          });
        }
        const kw = metricsMap.get(kwKey)!;
        kw.impressions += Number(row.impressions) || 0;
        kw.clicks += Number(row.clicks) || 0;
        kw.spend += Number(row.cost) || 0;
        kw.sales += Number(row.sales14d || row.sales7d || row.sales30d) || 0;
        kw.orders += Number(row.purchases14d || row.purchases7d || row.purchases30d) || 0;
        continue;
      }

      const key = `${campaignId}|${date}`;
      if (!metricsMap.has(key)) {
        metricsMap.set(key, {
          _type: 'campaign',
          amazon_account_id: accountId,
          campaign_id: campaignId,
          campaign_name: row.campaignName || '',
          date,
          impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0,
        });
      }

      const m = metricsMap.get(key)!;
      m.impressions += Number(row.impressions) || 0;
      m.clicks += Number(row.clicks) || 0;
      m.spend += Number(row.cost) || 0;
      m.sales += Number(row.sales14d || row.sales7d || row.sales30d) || 0;
      m.orders += Number(row.purchases14d || row.purchases7d || row.purchases30d) || 0;
    }

    // Separar registros por tipo
    const allEntries = Array.from(metricsMap.values());
    const keywordEntries = allEntries.filter(m => m._type === 'keyword');
    const campaignEntries = allEntries.filter(m => m._type !== 'keyword');

    // ── CampaignMetricsDaily ──
    const metricsRecords = campaignEntries.map(({ _type, ...m }) => ({
      ...m,
      acos: m.sales > 0 ? (m.spend / m.sales * 100) : 0,
      roas: m.spend > 0 ? (m.sales / m.spend) : 0,
      ctr: m.impressions > 0 ? (m.clicks / m.impressions * 100) : 0,
      cpc: m.clicks > 0 ? (m.spend / m.clicks) : 0,
    }));

    if (isCanonicalCampaignReport && metricsRecords.length > 0) {
      // Purgar registros com mais de 90 dias (retenção de dados)
      const cutoff90d = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
      await base44.asServiceRole.entities.CampaignMetricsDaily.deleteMany({
        amazon_account_id: accountId,
        date: { $lt: cutoff90d },
      }).catch(() => {});
      await sleep(150);

      // Deletar apenas as datas cobertas por este relatório antes de reescrever
      const datesToReplace = [...new Set(metricsRecords.map((r: any) => r.date))];
      for (const d of datesToReplace) {
        await base44.asServiceRole.entities.CampaignMetricsDaily.deleteMany({ amazon_account_id: accountId, date: d }).catch(() => {});
        await sleep(80);
      }
      await bulkUpsertBatched(base44.asServiceRole.entities.CampaignMetricsDaily, metricsRecords);
      console.log(`[downloadProcess] CampaignMetricsDaily: ${metricsRecords.length} registros em ${datesToReplace.length} datas (retenção 90d)`);
    }

    // ── Keyword (spTargeting) — upsert por keyword_id ──
    if (keywordEntries.length > 0) {
      const existingKeywords = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, undefined, 5000).catch(() => []);
      const kwById = new Map((existingKeywords as any[]).map(k => [String(k.keyword_id), k]));

      // Agregar por keyword_id (soma 30d)
      const kwAgg = new Map<string, any>();
      for (const kw of keywordEntries) {
        if (!kwAgg.has(kw.keyword_id)) {
          kwAgg.set(kw.keyword_id, { ...kw, spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0 });
        }
        const a = kwAgg.get(kw.keyword_id)!;
        a.spend += kw.spend; a.sales += kw.sales; a.clicks += kw.clicks; a.impressions += kw.impressions; a.orders += kw.orders;
        if (kw.bid > 0) a.bid = kw.bid; // manter bid mais recente
      }

      const kwCreates: any[] = [];
      const kwUpdates: any[] = [];
      for (const [kid, agg] of kwAgg.entries()) {
        const { _type, date, ...baseFields } = agg;
        const record = {
          ...baseFields,
          acos: agg.sales > 0 ? agg.spend / agg.sales * 100 : 0,
          roas: agg.spend > 0 ? agg.sales / agg.spend : 0,
          ctr: agg.impressions > 0 ? agg.clicks / agg.impressions * 100 : 0,
          cpc: agg.clicks > 0 ? agg.spend / agg.clicks : 0,
          synced_at: now,
          performance_confirmed_at: now,
        };
        const existing = kwById.get(kid);
        if (existing) kwUpdates.push({ id: existing.id, ...record });
        else kwCreates.push(record);
      }
      await bulkUpsertBatched(base44.asServiceRole.entities.Keyword, kwCreates);
      if (kwUpdates.length > 0) {
        for (let i = 0; i < kwUpdates.length; i += 100) {
          await base44.asServiceRole.entities.Keyword.bulkUpdate(kwUpdates.slice(i, i + 100)).catch(() => {});
          if (i + 100 < kwUpdates.length) await sleep(150);
        }
      }
      console.log(`[downloadProcess] Keyword (spTargeting): ${kwCreates.length} criadas + ${kwUpdates.length} atualizadas`);
    }

    // ── Atualizar métricas agregadas em Campaign ──
    const campAgg = new Map<string, any>();
    for (const m of campaignEntries) {
      if (!campAgg.has(m.campaign_id)) campAgg.set(m.campaign_id, { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0 });
      const c = campAgg.get(m.campaign_id)!;
      c.spend += m.spend; c.sales += m.sales; c.clicks += m.clicks; c.impressions += m.impressions; c.orders += m.orders;
    }

    const existingCamps = isCanonicalCampaignReport
      ? await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, undefined, 5000).catch(() => [])
      : [];
    const campMap = new Map((existingCamps as any[]).map(c => [c.campaign_id, c]));
    const campUpdates = isCanonicalCampaignReport ? Array.from(campAgg.entries())
      .filter(([id]) => campMap.has(id))
      .map(([id, agg]) => {
        const existing = campMap.get(id) as any;
        return {
          id: existing.id,
          spend: agg.spend, sales: agg.sales, clicks: agg.clicks, impressions: agg.impressions, orders: agg.orders,
          acos: agg.sales > 0 ? (agg.spend / agg.sales * 100) : 0,
          roas: agg.spend > 0 ? (agg.sales / agg.spend) : 0,
          ctr: agg.impressions > 0 ? (agg.clicks / agg.impressions * 100) : 0,
          cpc: agg.clicks > 0 ? (agg.spend / agg.clicks) : 0,
          synced_at: now,
        };
      }) : [];

    if (campUpdates.length > 0) {
      for (let i = 0; i < campUpdates.length; i += 100) {
        await base44.asServiceRole.entities.Campaign.bulkUpdate(campUpdates.slice(i, i + 100)).catch(() => {});
        if (i + 100 < campUpdates.length) await sleep(150);
      }
    }
    console.log(`[downloadProcess] Campaign: ${campUpdates.length} atualizadas`);

    // Atualizar job como processed
    await base44.asServiceRole.entities.AmazonAdsReportJob.update(job_id, {
      status: 'processed',
      processed_at: now,
      records_processed: metricsRecords.length + keywordEntries.length + searchTermRecords.length,
      updated_at: now,
    }).catch(() => {});

    // Atualizar last_sync_at da conta + sinalizar dados frescos para todas as páginas
    await base44.asServiceRole.entities.AmazonAccount.update(accountId, {
      last_sync_at: now,
      status: 'connected',
      ads_metrics_last_sync_at: now,
      ads_data_fresh_at: now,
    }).catch(() => {});

    // Registrar SyncExecutionLog
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: accountId,
      operation: 'ads_sync',
      trigger_type: 'automatic',
      status: 'success',
      execution_date: now.slice(0, 10),
      started_at: now,
      completed_at: now,
      records_processed: metricsRecords.length + searchTermRecords.length,
      duration_ms: Date.now() - t0,
    }).catch(() => {});

    // ── Atualizar HourlySalesPattern quando o relatório tiver dados por ASIN (spAdvertisedProduct) ──
    if (job.report_type_id === 'spAdvertisedProduct' && rows.some((r: any) => r.advertisedAsin)) {
      console.log('[downloadProcess] Atualizando HourlySalesPattern a partir de spAdvertisedProduct...');
      try {
        // Carregar target_acos
        const perfList = await base44.asServiceRole.entities.PerformanceSettings
          .filter({ amazon_account_id: accountId }, undefined, 1).catch(() => []);
        const targetAcos = Number((perfList as any[])[0]?.target_acos || 15);

        // Agregar por day_of_week + hour (via data, sem hora — mapear por dia da semana)
        const slotMap = new Map<string, any>();
        const DAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
        for (const r of rows) {
          const date = r.date || '';
          if (!date) continue;
          const d = new Date(date);
          if (isNaN(d.getTime())) continue;
          const dow = d.getDay();
          // Sem granularidade horária real neste relatório — usar hora 0 como agregado do dia
          // O snapshotHourlySalesPattern existente já usa HourlyMetric com hora real
          // Aqui populamos apenas o padrão de dia-da-semana (hour=0) com dados ASIN
          const key = `${dow}|0`;
          if (!slotMap.has(key)) {
            slotMap.set(key, { day_of_week: dow, hour: 0, orders: 0, sales: 0, spend: 0, clicks: 0, impressions: 0, occurrences: 0 });
          }
          const s = slotMap.get(key)!;
          s.orders      += Number(r.purchases14d || r.purchases7d || 0);
          s.sales       += Number(r.sales14d || r.sales7d || 0);
          s.spend       += Number(r.cost || 0);
          s.clicks      += Number(r.clicks || 0);
          s.impressions += Number(r.impressions || 0);
          s.occurrences++;
        }

        const totalOrders = Array.from(slotMap.values()).reduce((s, v) => s + v.orders, 0);
        const patterns: any[] = [];
        const nowPat = new Date().toISOString();

        for (const [, s] of slotMap) {
          const cvr  = s.clicks > 0 ? s.orders / s.clicks : 0;
          const acos = s.sales  > 0 ? (s.spend / s.sales) * 100 : 0;
          const roas = s.spend  > 0 ? s.sales / s.spend : 0;
          const cpc  = s.clicks > 0 ? s.spend / s.clicks : 0;
          const aov  = s.orders > 0 ? s.sales / s.orders : 0;
          const ordersSharePct = totalOrders > 0 ? (s.orders / totalOrders) * 100 : 0;
          const shareScore = Math.min(40, ordersSharePct * 8);
          const cvrScore   = Math.min(35, cvr * 3500);
          const acosScore  = acos > 0 && targetAcos > 0 ? Math.min(25, Math.max(0, (1 - acos / targetAcos) * 30)) : 0;
          const rawScore   = shareScore + cvrScore + acosScore;
          const peakScore  = Math.round(Math.max(0, Math.min(100, s.occurrences >= 4 ? rawScore : rawScore * 0.5)));
          const classifyFn = (sc: number) => sc >= 80 ? 'PEAK_ELITE' : sc >= 60 ? 'PEAK_STRONG' : sc >= 40 ? 'NORMAL' : sc >= 20 ? 'WEAK' : 'LOSS';
          const classification = s.occurrences >= 2 ? classifyFn(peakScore) : 'INSUFFICIENT_DATA';
          const bm = classification === 'PEAK_ELITE' ? parseFloat((1.0 + Math.min(0.20, peakScore / 500)).toFixed(4))
                   : classification === 'PEAK_STRONG' ? parseFloat((1.0 + Math.min(0.12, peakScore / 600)).toFixed(4))
                   : classification === 'WEAK' ? 0.92 : classification === 'LOSS' ? 0.85 : 1.0;
          patterns.push({
            amazon_account_id: accountId,
            day_of_week: s.day_of_week, hour: s.hour,
            slot_label: `${DAY_LABELS[s.day_of_week]}_dia`,
            orders: s.orders, sales: parseFloat(s.sales.toFixed(4)), spend: parseFloat(s.spend.toFixed(4)),
            clicks: s.clicks, impressions: s.impressions, cvr: parseFloat(cvr.toFixed(4)),
            acos: parseFloat(acos.toFixed(4)), roas: parseFloat(roas.toFixed(4)),
            cpc: parseFloat(cpc.toFixed(4)), aov: parseFloat(aov.toFixed(4)),
            occurrences: s.occurrences, orders_share_pct: parseFloat(ordersSharePct.toFixed(4)),
            peak_score: peakScore, classification, bid_multiplier: bm,
            is_peak_hour: classification === 'PEAK_ELITE' || classification === 'PEAK_STRONG',
            data_window_days: 14, last_computed_at: nowPat,
          });
        }

        // Upsert
        const existing: any[] = await base44.asServiceRole.entities.HourlySalesPattern
          .filter({ amazon_account_id: accountId }, undefined, 200).catch(() => []);
        const existingMap = new Map(existing.map((e: any) => [`${e.day_of_week}|${e.hour}`, e]));
        for (const p of patterns) {
          const k = `${p.day_of_week}|${p.hour}`;
          if (existingMap.has(k)) {
            await base44.asServiceRole.entities.HourlySalesPattern.update((existingMap.get(k) as any).id, p).catch(() => {});
          } else {
            await base44.asServiceRole.entities.HourlySalesPattern.create(p).catch(() => {});
          }
        }
        console.log(`[downloadProcess] HourlySalesPattern: ${patterns.length} slots atualizados`);

        // Disparo de dayparting se slot atual for ELITE/STRONG e dayparting habilitado
        const autopilotList = await base44.asServiceRole.entities.AutopilotConfig
          .filter({ amazon_account_id: accountId }, undefined, 1).catch(() => []);
        const daypartingEnabled = (autopilotList as any[])[0]?.dayparting_enabled !== false;
        if (daypartingEnabled) {
          const brtNow = new Date(Date.now() - 3 * 3600000);
          const brtHour = brtNow.getUTCHours();
          const brtDow  = brtNow.getUTCDay();
          const currentSlot = patterns.find(p => p.day_of_week === brtDow && p.hour === brtHour);
          const isElite = currentSlot && (currentSlot.classification === 'PEAK_ELITE' || currentSlot.classification === 'PEAK_STRONG');
          if (isElite) {
            const acos14d = (() => {
              const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
              const recent = allEntries.filter(m => m._type !== 'keyword' && (m.date || '') >= cutoff);
              const ts = recent.reduce((s: number, m: any) => s + m.spend, 0);
              const tv = recent.reduce((s: number, m: any) => s + m.sales, 0);
              return tv > 0 ? (ts / tv) * 100 : 0;
            })();
            if (acos14d === 0 || acos14d <= targetAcos * 1.20) {
              base44.asServiceRole.functions.invoke('runDaypartingDecisionEngine', {
                amazon_account_id: accountId, dry_run: false, _service_role: true,
              }).catch((e: any) => console.warn('[downloadProcess] Dayparting (não crítico):', e.message));
              console.log(`[downloadProcess] ✓ Dayparting disparado — slot ${brtDow}|${brtHour} = ${currentSlot.classification}`);
            }
          }
        }
      } catch (patErr: any) {
        console.warn('[downloadProcess] HourlySalesPattern update (não crítico):', patErr.message);
      }
    }

    // Disparar motor de decisão com os dados recém-processados
    // Só para relatórios de campanha (spCampaigns) — são os que têm métricas diárias completas
    if ((metricsRecords.length > 0 || campUpdates.length > 0) && (job.report_type_id === 'spCampaigns' || !job.report_type_id)) {
      console.log(`[downloadProcess] Disparando motor de decisão após processamento de ${metricsRecords.length} registros`);
      base44.asServiceRole.functions.invoke('runFullAccountOptimizationWithNewLogic', {
        amazon_account_id: accountId,
        trigger: 'report_processed',
        _service_role: true,
      }).catch((e: any) => console.warn('[downloadProcess] Motor de decisão (não crítico):', e.message));
    }

    // A promoção começa assim que a Amazon entrega o relatório. Se as colunas
    // de mesmo SKU ou o vínculo ASIN/SKU faltarem, o motor apenas registra o
    // termo e não cria campanha.
    if (isSearchTermReport && searchTermRecords.length > 0) {
      waitUntil(base44.asServiceRole.functions.invoke('runImmediateSameSkuSearchTermHarvest', {
        amazon_account_id: accountId,
        trigger_type: 'search_term_report_processed',
        max_promotions: 25,
        _service_role: true,
      }).catch((error: any) => console.warn('[downloadProcess] Colheita imediata:', error?.message || error)));
      // O mesmo relatório que atualiza gasto por termo dispara imediatamente
      // a proteção de lucro; não espera o próximo cron de cinco minutos.
      waitUntil(base44.asServiceRole.functions.invoke('enforceSkuProfitProtection', {
        amazon_account_id: accountId,
        trigger_type: 'search_term_report_processed_immediate_bid_guard',
        dry_run: false,
        _service_role: true,
      }).catch((error: any) => console.warn('[downloadProcess] Proteção intradiária imediata:', error?.message || error)));
    }

    return Response.json({
      ok: true,
      job_id,
      report_type_id: job.report_type_id,
      records: metricsRecords.length,
      search_terms_upserted: searchTermRecords.length,
      campaigns_updated: campUpdates.length,
      duration_ms: Date.now() - t0,
      message: 'Relatório pronto e processado.',
    });

  } catch (err: any) {
    console.error('[downloadProcess] Erro:', err.message);
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
});
