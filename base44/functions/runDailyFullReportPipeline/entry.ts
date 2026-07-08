/**
 * runDailyFullReportPipeline — Pipeline completo de relatórios + decisões
 *
 * Fluxo unificado em uma única chamada agendada:
 *   1. Solicita relatórios Amazon Ads (campaigns, keywords, searchTerms, products)
 *   2. Aguarda geração com polling (max 8 min)
 *   3. Baixa, descomprime e popula 100% das entidades:
 *      Campaign, CampaignMetricsDaily, AdsMetricsHistory,
 *      Keyword, AdGroup, SearchTerm, ProductAd, Product (inventory FBA)
 *   4. Dispara motor de decisão determinístico (bids, budgets, keywords)
 *   5. Salva SalesDaily via SP-API (pedidos reais)
 *   6. Dispara fila de execução Amazon
 *
 * Sem botão de interface. Totalmente autônomo.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

// ── Helpers ───────────────────────────────────────────────────────────────────

function getAdsBase(region: string) {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

function getSPBase(region: string) {
  const r = (region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://sellingpartnerapi-eu.amazon.com';
  if (r.includes('FE')) return 'https://sellingpartnerapi-fe.amazon.com';
  return 'https://sellingpartnerapi-na.amazon.com';
}

function fmtDate(d: Date) { return d.toISOString().slice(0, 10); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
const BATCH = 100;
const PAUSE = 150;

async function bulkUpsert(entity: any, creates: any[], updates: any[]) {
  for (let i = 0; i < creates.length; i += BATCH) {
    await entity.bulkCreate(creates.slice(i, i + BATCH));
    if (i + BATCH < creates.length) await sleep(PAUSE);
  }
  for (let i = 0; i < updates.length; i += BATCH) {
    await entity.bulkUpdate(updates.slice(i, i + BATCH));
    if (i + BATCH < updates.length) await sleep(PAUSE);
  }
}

async function getAdsToken(account: any) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '',
    client_id: Deno.env.get('ADS_CLIENT_ID') || '',
    client_secret: Deno.env.get('ADS_CLIENT_SECRET') || '',
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
  });
  const d = await res.json();
  if (!res.ok) throw new Error(`ADS token: ${d.error_description || res.status}`);
  return d.access_token as string;
}

async function getSPToken(account: any) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: Deno.env.get('AMAZON_SP_REFRESH_TOKEN') || Deno.env.get('SP_REFRESH_TOKEN') || '',
    client_id: Deno.env.get('AMAZON_LWA_CLIENT_ID') || Deno.env.get('SP_CLIENT_ID') || '',
    client_secret: Deno.env.get('AMAZON_LWA_CLIENT_SECRET') || Deno.env.get('SP_CLIENT_SECRET') || '',
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
  });
  const d = await res.json();
  if (!res.ok) throw new Error(`SP-API token: ${d.error_description || res.status}`);
  return d.access_token as string;
}

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

// ── Configuração dos relatórios ───────────────────────────────────────────────

const REPORT_CONFIGS = [
  {
    key: 'campaigns',
    reportTypeId: 'spCampaigns',
    groupBy: ['campaign'],
    columns: ['date','campaignId','campaignName','campaignStatus','campaignBudgetAmount',
      'impressions','clicks','cost',
      'purchases1d','purchases7d','purchases14d','purchases30d',
      'sales1d','sales7d','sales14d','sales30d',
      'acosClicks14d','roasClicks14d'],
  },
  {
    key: 'keywords',
    reportTypeId: 'spKeywords',
    groupBy: ['keyword'],
    columns: ['date','campaignId','campaignName','adGroupId','adGroupName',
      'keywordId','keyword','matchType','keywordBid','keywordStatus',
      'impressions','clicks','cost',
      'purchases7d','purchases14d','purchases30d',
      'sales7d','sales14d','sales30d',
      'acosClicks14d','roasClicks14d'],
  },
  {
    key: 'searchTerms',
    reportTypeId: 'spSearchTerm',
    groupBy: ['searchTerm'],
    columns: ['date','campaignId','campaignName','adGroupId','adGroupName',
      'keywordId','keyword','matchType','searchTerm',
      'impressions','clicks','cost',
      'purchases7d','purchases14d','purchases30d',
      'sales7d','sales14d','sales30d',
      'acosClicks14d','roasClicks14d'],
  },
  {
    key: 'products',
    reportTypeId: 'spAdvertisedProduct',
    groupBy: ['advertiser'],
    columns: ['date','campaignId','campaignName','adGroupId','adGroupName',
      'advertisedAsin','advertisedSku',
      'impressions','clicks','cost',
      'purchases14d','purchases30d','sales14d','sales30d'],
  },
];

// ── Handler principal ─────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const startTime = Date.now();
  const startedAt = new Date().toISOString();
  const now = startedAt;
  const summary: Record<string, any> = { phases: {} };

  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    const forceSync = body.force === true;

    // Resolver conta
    const accounts = await base44.asServiceRole.entities.AmazonAccount.list('-created_date', 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon encontrada' });

    const aid = account.id;
    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
    const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
    const marketplaceId = account.marketplace_id || Deno.env.get('AMAZON_MARKETPLACE_ID') || 'A2Q3Y263D00KWC';
    const adsBase = getAdsBase(account.region || Deno.env.get('ADS_REGION') || 'NA');
    const spBase = getSPBase(account.region || '');

    // Guard TTL 23h
    if (!forceSync && account.last_sync_at) {
      const ageH = (Date.now() - new Date(account.last_sync_at).getTime()) / 3600000;
      if (ageH < 23) {
        return Response.json({ ok: true, skipped: true, reason: 'already_synced_today', age_hours: Math.round(ageH) });
      }
    }

    // ── FASE 1: Solicitar relatórios Ads ─────────────────────────────────────
    console.log('[Pipeline] Fase 1: solicitando relatórios...');
    const adsToken = await getAdsToken(account);
    const adsHeaders: Record<string, string> = {
      'Authorization': `Bearer ${adsToken}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': profileId,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    const endDate = new Date(); endDate.setDate(endDate.getDate() - 1);
    const startDate = new Date(endDate); startDate.setDate(startDate.getDate() - 29);
    const endDateStr = fmtDate(endDate);

    const reportIds: Record<string, string> = {};
    await Promise.all(REPORT_CONFIGS.map(async (rc) => {
      try {
        const r = await fetch(`${adsBase}/reporting/reports`, {
          method: 'POST', headers: adsHeaders,
          body: JSON.stringify({
            name: `SP_${rc.key}_${endDateStr}_${Date.now()}`,
            startDate: fmtDate(startDate), endDate: endDateStr,
            configuration: {
              adProduct: 'SPONSORED_PRODUCTS',
              groupBy: rc.groupBy, columns: rc.columns,
              reportTypeId: rc.reportTypeId, timeUnit: 'DAILY', format: 'GZIP_JSON',
            },
          }),
        });
        const d = await r.json().catch(() => ({}));
        if (r.status === 425) {
          const match = JSON.stringify(d).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
          if (match) reportIds[rc.key] = match[0];
        } else if (r.ok && d.reportId) {
          reportIds[rc.key] = d.reportId;
        }
      } catch (e: any) { console.warn(`[Pipeline] report ${rc.key}: ${e.message}`); }
    }));

    summary.phases.request = { reportIds, count: Object.keys(reportIds).length };
    console.log(`[Pipeline] ${Object.keys(reportIds).length} relatórios solicitados`);

    // ── FASE 2: Polling — estratégia de espera inteligente ───────────────────
    // Relatórios Amazon Ads raramente ficam prontos antes de 20 min.
    // Estratégia: esperar 20 min fixos antes do PRIMEIRO poll (economiza ~20 chamadas
    // desnecessárias), depois checar a cada 30s por até 10 min adicionais.
    console.log('[Pipeline] Fase 2: aguardando 20 min antes do primeiro poll (padrão Amazon)...');
    await sleep(20 * 60 * 1000); // 20 min — janela mínima real da Amazon

    let ready: { key: string; url: string }[] = [];
    const pendingIds = { ...reportIds };
    let attempts = 0;
    const MAX_ATTEMPTS = 20; // 20 × 30s = até 10 min adicionais após a espera inicial

    while (attempts < MAX_ATTEMPTS && Object.keys(pendingIds).length > 0) {
      attempts++;
      const statuses = await Promise.all(
        Object.entries(pendingIds).map(async ([key, rid]) => {
          const r = await fetch(`${adsBase}/reporting/reports/${rid}`, { headers: adsHeaders }).catch(() => null);
          if (!r) return { key, status: 'ERROR', url: '' };
          const d = await r.json().catch(() => ({}));
          return { key, status: d.status, url: d.url || '' };
        })
      );

      for (const s of statuses) {
        if (s.status === 'COMPLETED' && s.url) {
          ready.push(s as any);
          delete pendingIds[s.key];
        } else if (['FAILED', 'EXPIRED'].includes(s.status)) {
          delete pendingIds[s.key];
        }
      }

      console.log(`[Pipeline] Poll ${attempts}: ready=${ready.length} pending=${Object.keys(pendingIds).length}`);
      if (Object.keys(pendingIds).length === 0) break;
      await sleep(30000); // 30s entre checks após a espera inicial
    }

    if (ready.length === 0) {
      return Response.json({ ok: false, error: `Nenhum relatório ficou pronto após 20 min de espera + ${attempts} polls`, summary });
    }
    if (Object.keys(pendingIds).length > 0) {
      console.warn(`[Pipeline] ${Object.keys(pendingIds).length} relatório(s) não prontos após timeout: ${Object.keys(pendingIds).join(', ')}`);
    }

    // ── FASE 3: Download + parse ──────────────────────────────────────────────
    console.log(`[Pipeline] Fase 3: baixando ${ready.length} relatórios...`);
    const reportData: Record<string, any[]> = {};
    for (const s of ready) {
      try {
        const r = await fetch(s.url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = await r.arrayBuffer();
        reportData[s.key] = await decompress(buf);
        console.log(`[Pipeline] ${s.key}: ${reportData[s.key].length} linhas`);
      } catch (e: any) { console.error(`[Pipeline] download ${s.key}: ${e.message}`); }
    }
    summary.phases.download = { reports: Object.fromEntries(Object.entries(reportData).map(([k, v]) => [k, v.length])) };

    // ── FASE 4: Limpar dados antigos e popular todas as entidades ─────────────
    console.log('[Pipeline] Fase 4: populando entidades...');

    // Limpar tabelas de métricas diárias (dados são substituídos completamente)
    await base44.asServiceRole.entities.AdsMetricsHistory.deleteMany({ amazon_account_id: aid }).catch(() => {});
    await sleep(200);
    await base44.asServiceRole.entities.SearchTerm.deleteMany({ amazon_account_id: aid }).catch(() => {});
    await sleep(200);
    await base44.asServiceRole.entities.CampaignMetricsDaily.deleteMany({ amazon_account_id: aid }).catch(() => {});
    await sleep(200);

    // Construir AdsMetricsHistory (registro bruto de tudo)
    const historyRecords: any[] = [];
    const histSeen = new Set<string>();
    for (const [key, rows] of Object.entries(reportData)) {
      for (const row of rows) {
        const date = row.date || endDateStr;
        const uniqueKey = `${date}|${key}|${row.campaignId || ''}|${row.adGroupId || ''}|${row.searchTerm || ''}|${row.keywordId || ''}|${row.advertisedAsin || ''}`;
        if (histSeen.has(uniqueKey)) continue;
        histSeen.add(uniqueKey);
        historyRecords.push({
          amazon_account_id: aid, date, report_type: key,
          campaign_id: String(row.campaignId || ''), campaign_name: row.campaignName || '',
          ad_group_id: String(row.adGroupId || ''), ad_group_name: row.adGroupName || '',
          keyword_id: String(row.keywordId || ''), keyword_text: row.keyword || '',
          search_term: row.searchTerm || '', match_type: (row.matchType || '').toLowerCase(),
          advertised_asin: row.advertisedAsin || '', advertised_sku: row.advertisedSku || '',
          impressions: Number(row.impressions) || 0, clicks: Number(row.clicks) || 0,
          spend: Number(row.cost) || 0,
          orders_7d: Number(row.purchases7d) || 0, orders_14d: Number(row.purchases14d) || 0, orders_30d: Number(row.purchases30d) || 0,
          sales_7d: Number(row.sales7d) || 0, sales_14d: Number(row.sales14d) || 0, sales_30d: Number(row.sales30d) || 0,
          acos_14d: Number(row.acosClicks14d) || 0, roas_14d: Number(row.roasClicks14d) || 0,
          unique_key: uniqueKey, synced_at: now,
        });
      }
    }
    await bulkUpsert(base44.asServiceRole.entities.AdsMetricsHistory, historyRecords, []);

    // CampaignMetricsDaily (agregado por campanha + data)
    const metricsMap = new Map<string, any>();
    for (const r of historyRecords) {
      if (!r.campaign_id) continue;
      const k = `${r.campaign_id}|${r.date}`;
      if (!metricsMap.has(k)) metricsMap.set(k, { amazon_account_id: aid, campaign_id: r.campaign_id, campaign_name: r.campaign_name, date: r.date, spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0, _isPrimary: false });
      const m = metricsMap.get(k)!;
      if (r.report_type === 'campaigns') {
        m.spend = r.spend; m.sales = r.sales_14d; m.clicks = r.clicks; m.impressions = r.impressions; m.orders = r.orders_14d; m._isPrimary = true;
      } else if (!m._isPrimary) {
        m.spend += r.spend; m.sales += r.sales_14d; m.clicks += r.clicks; m.impressions += r.impressions; m.orders += r.orders_14d;
      }
    }
    const metricsRecords = Array.from(metricsMap.values()).map(({ _isPrimary, ...m }) => ({
      ...m,
      acos: m.sales > 0 ? (m.spend / m.sales * 100) : 0, roas: m.spend > 0 ? (m.sales / m.spend) : 0,
      ctr: m.impressions > 0 ? (m.clicks / m.impressions * 100) : 0, cpc: m.clicks > 0 ? (m.spend / m.clicks) : 0,
      synced_at: now,
    }));
    await bulkUpsert(base44.asServiceRole.entities.CampaignMetricsDaily, metricsRecords, []);

    // SearchTerm
    const stRecords = historyRecords.filter(r => r.report_type === 'searchTerms').map(r => ({
      amazon_account_id: aid, date: r.date,
      campaign_id: r.campaign_id, campaign_name: r.campaign_name,
      ad_group_id: r.ad_group_id, ad_group_name: r.ad_group_name,
      keyword_id: r.keyword_id, keyword_text: r.keyword_text, match_type: r.match_type,
      search_term: r.search_term, advertised_asin: r.advertised_asin, advertised_sku: r.advertised_sku,
      impressions: r.impressions, clicks: r.clicks, spend: r.spend,
      orders_7d: r.orders_7d, orders_14d: r.orders_14d, orders_30d: r.orders_30d,
      sales_7d: r.sales_7d, sales_14d: r.sales_14d, sales_30d: r.sales_30d,
      acos_14d: r.acos_14d, roas_14d: r.roas_14d,
      ctr: r.impressions > 0 ? (r.clicks / r.impressions * 100) : 0,
      cpc: r.clicks > 0 ? (r.spend / r.clicks) : 0,
      conversion_rate: r.clicks > 0 ? (r.orders_14d / r.clicks * 100) : 0,
      unique_key: r.unique_key, synced_at: now,
    }));
    await bulkUpsert(base44.asServiceRole.entities.SearchTerm, stRecords, []);

    // Keyword — upsert por keyword_id
    let keywordsUpdated = 0;
    if (reportData['keywords']?.length) {
      const existingKeywords = await base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, null, 5000).catch(() => []);
      const kwById = new Map((existingKeywords as any[]).map(k => [String(k.keyword_id), k]));

      // Agregar métricas por keywordId (30d)
      const kwAgg = new Map<string, any>();
      for (const r of historyRecords.filter(r => r.report_type === 'keywords' && r.keyword_id)) {
        if (!kwAgg.has(r.keyword_id)) kwAgg.set(r.keyword_id, { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0, cpc_sum: 0, rows: 0, campaign_id: r.campaign_id, ad_group_id: r.ad_group_id, keyword_text: r.keyword_text, match_type: r.match_type });
        const a = kwAgg.get(r.keyword_id)!;
        a.spend += r.spend; a.sales += r.sales_14d; a.clicks += r.clicks; a.impressions += r.impressions; a.orders += r.orders_14d;
        if (r.clicks > 0) { a.cpc_sum += r.spend; a.rows++; }
      }

      const kwCreates: any[] = [];
      const kwUpdates: any[] = [];
      for (const [kid, agg] of kwAgg.entries()) {
        const acos = agg.sales > 0 ? agg.spend / agg.sales * 100 : 0;
        const cpc = agg.clicks > 0 ? agg.spend / agg.clicks : 0;
        const record: any = {
          amazon_account_id: aid, keyword_id: kid,
          campaign_id: agg.campaign_id, ad_group_id: agg.ad_group_id,
          keyword_text: agg.keyword_text || agg.keyword, match_type: agg.match_type,
          spend: agg.spend, sales: agg.sales, clicks: agg.clicks, impressions: agg.impressions, orders: agg.orders,
          acos, roas: agg.spend > 0 ? agg.sales / agg.spend : 0, cpc,
          ctr: agg.impressions > 0 ? agg.clicks / agg.impressions * 100 : 0,
          synced_at: now,
        };
        const existing = kwById.get(kid);
        if (existing) kwUpdates.push({ id: existing.id, ...record });
        else kwCreates.push(record);
      }
      await bulkUpsert(base44.asServiceRole.entities.Keyword, kwCreates, kwUpdates);
      keywordsUpdated = kwCreates.length + kwUpdates.length;
    }

    // AdGroup — upsert por ad_group_id
    let adGroupsUpdated = 0;
    const adGroupAgg = new Map<string, any>();
    for (const r of historyRecords) {
      if (!r.ad_group_id) continue;
      if (!adGroupAgg.has(r.ad_group_id)) adGroupAgg.set(r.ad_group_id, { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0, campaign_id: r.campaign_id, ad_group_name: r.ad_group_name });
      const a = adGroupAgg.get(r.ad_group_id)!;
      a.spend += r.spend; a.sales += r.sales_14d; a.clicks += r.clicks; a.impressions += r.impressions; a.orders += r.orders_14d;
    }
    if (adGroupAgg.size > 0) {
      const existingAGs = await base44.asServiceRole.entities.AdGroup.filter({ amazon_account_id: aid }, null, 5000).catch(() => []);
      const agById = new Map((existingAGs as any[]).map(ag => [String(ag.ad_group_id), ag]));
      const agCreates: any[] = [];
      const agUpdates: any[] = [];
      for (const [agid, agg] of adGroupAgg.entries()) {
        const record: any = {
          amazon_account_id: aid, ad_group_id: agid, ad_group_name: agg.ad_group_name,
          campaign_id: agg.campaign_id,
          spend: agg.spend, sales: agg.sales, clicks: agg.clicks, impressions: agg.impressions, orders: agg.orders,
          acos: agg.sales > 0 ? agg.spend / agg.sales * 100 : 0,
          roas: agg.spend > 0 ? agg.sales / agg.spend : 0,
          cpc: agg.clicks > 0 ? agg.spend / agg.clicks : 0,
          synced_at: now,
        };
        const existing = agById.get(agid);
        if (existing) agUpdates.push({ id: existing.id, ...record });
        else agCreates.push(record);
      }
      await bulkUpsert(base44.asServiceRole.entities.AdGroup, agCreates, agUpdates);
      adGroupsUpdated = agCreates.length + agUpdates.length;
    }

    // ProductAd — upsert por advertisedAsin
    let productAdsUpdated = 0;
    if (reportData['products']?.length) {
      const existingPAs = await base44.asServiceRole.entities.ProductAd.filter({ amazon_account_id: aid }, null, 5000).catch(() => []);
      const paByAsin = new Map((existingPAs as any[]).map(p => [p.asin || p.advertised_asin, p]));
      const productAgg = new Map<string, any>();
      for (const r of historyRecords.filter(r => r.report_type === 'products' && r.advertised_asin)) {
        const asin = r.advertised_asin;
        if (!productAgg.has(asin)) productAgg.set(asin, { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0, campaign_id: r.campaign_id, ad_group_id: r.ad_group_id, sku: r.advertised_sku });
        const a = productAgg.get(asin)!;
        a.spend += r.spend; a.sales += r.sales_14d; a.clicks += r.clicks; a.impressions += r.impressions; a.orders += r.orders_14d;
      }
      const paCreates: any[] = [];
      const paUpdates: any[] = [];
      for (const [asin, agg] of productAgg.entries()) {
        const record: any = {
          amazon_account_id: aid, asin, sku: agg.sku,
          campaign_id: agg.campaign_id, ad_group_id: agg.ad_group_id,
          spend: agg.spend, sales: agg.sales, clicks: agg.clicks, impressions: agg.impressions, orders: agg.orders,
          acos: agg.sales > 0 ? agg.spend / agg.sales * 100 : 0,
          roas: agg.spend > 0 ? agg.sales / agg.spend : 0,
          synced_at: now,
        };
        const existing = paByAsin.get(asin);
        if (existing) paUpdates.push({ id: existing.id, ...record });
        else paCreates.push(record);
      }
      await bulkUpsert(base44.asServiceRole.entities.ProductAd, paCreates, paUpdates);
      productAdsUpdated = paCreates.length + paUpdates.length;
    }

    // Atualizar métricas agregadas nas entidades Campaign
    const campAgg = new Map<string, any>();
    for (const r of historyRecords) {
      if (!r.campaign_id) continue;
      if (!campAgg.has(r.campaign_id)) campAgg.set(r.campaign_id, { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0 });
      const c = campAgg.get(r.campaign_id)!;
      if (r.report_type === 'campaigns') { c.spend = r.spend; c.sales = r.sales_14d; c.clicks = r.clicks; c.impressions = r.impressions; c.orders = r.orders_14d; }
    }
    const existingCamps = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 5000).catch(() => []);
    const campMap = new Map((existingCamps as any[]).map(c => [c.campaign_id, c]));
    const campUpdates = Array.from(campAgg.entries())
      .filter(([id]) => campMap.has(id))
      .map(([id, agg]) => {
        const ex = campMap.get(id) as any;
        return { id: ex.id, spend: agg.spend, sales: agg.sales, clicks: agg.clicks, impressions: agg.impressions, orders: agg.orders,
          acos: agg.sales > 0 ? agg.spend / agg.sales * 100 : 0, roas: agg.spend > 0 ? agg.sales / agg.spend : 0,
          ctr: agg.impressions > 0 ? agg.clicks / agg.impressions * 100 : 0, cpc: agg.clicks > 0 ? agg.spend / agg.clicks : 0, synced_at: now };
      });
    await bulkUpsert(base44.asServiceRole.entities.Campaign, [], campUpdates);

    summary.phases.entities = {
      history: historyRecords.length, metrics_daily: metricsRecords.length,
      search_terms: stRecords.length, keywords: keywordsUpdated, ad_groups: adGroupsUpdated,
      product_ads: productAdsUpdated, campaigns: campUpdates.length,
    };
    console.log('[Pipeline] Fase 4 concluída:', JSON.stringify(summary.phases.entities));

    // ── FASE 5: Inventory FBA via SP-API ─────────────────────────────────────
    try {
      const spToken = await getSPToken(account);
      const invRes = await fetch(
        `${spBase}/fba/inventory/v1/summaries?granularityType=Marketplace&granularityId=${marketplaceId}&marketplaceIds=${marketplaceId}`,
        { headers: { 'Authorization': `Bearer ${spToken}`, 'x-amz-access-token': spToken } }
      );
      if (invRes.ok) {
        const invData = await invRes.json();
        const summaries: any[] = invData?.payload?.inventorySummaries || [];
        const existProds = await base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 2000).catch(() => []);
        const prodByAsin = new Map((existProds as any[]).map(p => [p.asin, p]));
        const invCreates: any[] = [];
        const invUpdates: any[] = [];
        for (const s of summaries) {
          const qty = s.inventoryDetails?.fulfillableQuantity ?? s.totalQuantity ?? 0;
          const inventoryStatus = qty === 0 ? 'out_of_stock' : qty < 5 ? 'low_stock' : 'in_stock';
          const record: any = { fba_inventory: qty, inventory_status: inventoryStatus, last_sync_at: now,
            reserved_inventory: s.inventoryDetails?.reservedQuantity?.totalReservedQuantity || 0,
            inbound_inventory: (s.inventoryDetails?.inboundWorkingQuantity || 0) + (s.inventoryDetails?.inboundShippedQuantity || 0) };
          const existing = prodByAsin.get(s.asin);
          if (existing) invUpdates.push({ id: existing.id, ...record });
          else if (s.asin) invCreates.push({ amazon_account_id: aid, asin: s.asin, sku: s.sellerSku || '', product_name: s.productName || s.asin, status: 'active', ...record });
        }
        await bulkUpsert(base44.asServiceRole.entities.Product, invCreates, invUpdates);
        summary.phases.inventory = { created: invCreates.length, updated: invUpdates.length };
      }
    } catch (e: any) { console.warn('[Pipeline] Inventário FBA (não crítico):', e.message); }

    // ── FASE 6: SalesDaily via SP-API Orders ──────────────────────────────────
    try {
      const spToken = await getSPToken(account);
      const salesEnd = new Date(); salesEnd.setDate(salesEnd.getDate() - 1);
      const salesStart = new Date(salesEnd); salesStart.setDate(salesStart.getDate() - 29);
      const ordersRes = await fetch(`${spBase}/reports/2021-06-30/reports`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${spToken}`, 'x-amz-access-token': spToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL', marketplaceIds: [marketplaceId], dataStartTime: salesStart.toISOString(), dataEndTime: salesEnd.toISOString() }),
      });
      if (ordersRes.ok) {
        const { reportId } = await ordersRes.json();
        if (reportId) {
          // Esperar 3 min antes do primeiro poll (SP-API Orders raramente fica pronto antes disso)
          await sleep(3 * 60 * 1000);
          let docId = '';
          for (let i = 0; i < 8 && !docId; i++) {
            const st = await fetch(`${spBase}/reports/2021-06-30/reports/${reportId}`, { headers: { 'Authorization': `Bearer ${spToken}`, 'x-amz-access-token': spToken } });
            if (st.ok) { const sd = await st.json(); if (sd.processingStatus === 'DONE') docId = sd.reportDocumentId; }
            if (!docId) await sleep(30000); // 30s entre checks
          }
          if (docId) {
            const docRes = await fetch(`${spBase}/reports/2021-06-30/documents/${docId}`, { headers: { 'Authorization': `Bearer ${spToken}`, 'x-amz-access-token': spToken } });
            if (docRes.ok) {
              const { url } = await docRes.json();
              if (url) {
                const content = await fetch(url).then(r => r.text()).catch(() => '');
                const lines = content.split('\n').filter(l => l.trim());
                if (lines.length > 1) {
                  const headers = lines[0].split('\t').map(h => h.trim().toLowerCase());
                  const byDateAsin = new Map<string, any>();
                  for (let i = 1; i < lines.length; i++) {
                    const vals = lines[i].split('\t');
                    const row: any = {};
                    headers.forEach((h, idx) => { row[h] = (vals[idx] || '').trim(); });
                    const date = (row['purchase-date'] || row['order-date'] || '').slice(0, 10);
                    if (!date) continue;
                    const asin = row['asin'] || '';
                    const qty = parseFloat(row['quantity'] || row['quantity-purchased'] || '1') || 0;
                    const price = parseFloat(String(row['item-price'] || '0').replace(/[^0-9.-]/g, '')) || 0;
                    const key = `${date}|${asin}`;
                    if (!byDateAsin.has(key)) byDateAsin.set(key, { amazon_account_id: aid, asin, date, units_ordered: 0, ordered_product_sales: 0 });
                    const entry = byDateAsin.get(key)!;
                    entry.units_ordered += qty; entry.ordered_product_sales += price;
                  }
                  const salesRecords = Array.from(byDateAsin.values());
                  if (salesRecords.length > 0) {
                    await base44.asServiceRole.entities.SalesDaily.deleteMany({ amazon_account_id: aid, date: { $gte: fmtDate(salesStart), $lte: fmtDate(salesEnd) } }).catch(() => {});
                    await bulkUpsert(base44.asServiceRole.entities.SalesDaily, salesRecords, []);
                    summary.phases.sales_daily = { records: salesRecords.length };
                  }
                }
              }
            }
          }
        }
      }
    } catch (e: any) { console.warn('[Pipeline] SalesDaily (não crítico):', e.message); }

    // ── FASE 7: Atualizar AmazonAccount com timestamp ─────────────────────────
    await base44.asServiceRole.entities.AmazonAccount.update(aid, { last_sync_at: now, status: 'connected' }).catch(() => {});
    await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id: aid, operation: 'runDailyFullReportPipeline', status: 'success',
      records_processed: historyRecords.length, started_at: startedAt, completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
    }).catch(() => {});

    // ── FASE 8: Disparar motor de decisão ─────────────────────────────────────
    console.log('[Pipeline] Fase 8: disparando motor de decisão...');
    try {
      await base44.asServiceRole.functions.invoke('runFullAccountOptimizationWithNewLogic', {
        amazon_account_id: aid, trigger: 'after_report_sync', _service_role: true,
      });
      summary.phases.decision_engine = { triggered: true };
    } catch (e: any) {
      console.warn('[Pipeline] Motor de decisão (não crítico):', e.message);
      summary.phases.decision_engine = { triggered: false, error: e.message };
    }

    // ── FASE 9: Executar ações de bid geradas pelo motor determinístico ──────
    console.log('[Pipeline] Fase 9: executando bids de estoque pendentes...');
    try {
      const bidRes = await base44.asServiceRole.functions.invoke('executeStockBidRules', {
        amazon_account_id: aid,
      });
      summary.phases.stock_bid_execution = {
        executed: bidRes?.executed || 0,
        failed: bidRes?.failed || 0,
        total_pending: bidRes?.total_pending || 0,
      };
    } catch (e: any) {
      console.warn('[Pipeline] executeStockBidRules (não crítico):', e.message);
      summary.phases.stock_bid_execution = { triggered: false, error: e.message };
    }

    summary.duration_s = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('[Pipeline] ✅ Concluído em', summary.duration_s, 's');
    return Response.json({ ok: true, summary });

  } catch (err: any) {
    console.error('[runDailyFullReportPipeline]', err.message);
    return Response.json({ ok: false, error: err.message, summary }, { status: 500 });
  }
});