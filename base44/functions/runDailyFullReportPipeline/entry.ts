/**
 * runDailyFullReportPipeline — Pipeline completo de relatórios v3 (base definitiva)
 *
 * Arquitetura assíncrona:
 *   1. Solicita todos os relatórios via requestAmazonAdsReportV3 (idempotente)
 *   2. Retorna imediatamente — polling feito pela automação scheduledAmazonAdsReportPoll (10 min)
 *   3. Cada job processado dispara downloadAndProcessAmazonAdsReportJob automaticamente
 *   4. Dispara motor de decisão + budget usage em tempo real
 *
 * Relatórios v3 (base definitiva):
 *   - spCampaigns       → CampaignMetricsDaily, Campaign
 *   - spTargeting       → Keyword (filtro: expressionType=KEYWORD_BID)
 *   - spSearchTerm      → SearchTerm
 *   - spAdvertisedProduct → ProductAd
 *
 * Sem polling síncrono interno. Sem sleep de 30min.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

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

async function getSPToken() {
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

// ── Configuração dos relatórios v3 (base definitiva) ─────────────────────────
// keywords: spTargeting com filtro KEYWORD_BID (substitui spKeywords)
// Isso inclui exact/phrase/broad keywords e exclui product targets automaticamente

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
    filters: null,
  },
  {
    // spTargeting com filtro KEYWORD_BID = keyword performance real (exclui product targets)
    // Filtro: expressionType IN ['broad','exact','phrase'] via API v3
    key: 'keywords',
    reportTypeId: 'spTargeting',
    groupBy: ['targeting'],
    columns: ['date','campaignId','campaignName','adGroupId','adGroupName',
      'targetingId','targetingExpression','targetingText','matchType',
      'bid','targetingStatus',
      'impressions','clicks','cost',
      'purchases7d','purchases14d','purchases30d',
      'sales7d','sales14d','sales30d',
      'acosClicks14d','roasClicks14d'],
    // Filtro correto v3 reporting: keywordType para excluir product targets
    // Docs: "To see only keywords, set keywordType = TARGETING_EXPRESSION_PREDEFINED"
    // sem filtro retorna todos (keywords + product targets) — filtrar no processamento
    filters: null,
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
    filters: null,
  },
  {
    key: 'products',
    reportTypeId: 'spAdvertisedProduct',
    groupBy: ['advertiser'],
    columns: ['date','campaignId','campaignName','adGroupId','adGroupName',
      'advertisedAsin','advertisedSku',
      'impressions','clicks','cost',
      'purchases14d','purchases30d','sales14d','sales30d'],
    filters: null,
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

    // ── FASE 1: Solicitar todos os relatórios v3 (assíncrono, sem polling) ────
    console.log('[Pipeline] Fase 1: solicitando relatórios v3...');

    const endDate = new Date(); endDate.setDate(endDate.getDate() - 1);
    const startDate = new Date(endDate); startDate.setDate(startDate.getDate() - 29);
    const endDateStr = fmtDate(endDate);
    const startDateStr = fmtDate(startDate);

    // Obter token para solicitar relatórios
    const adsToken = await getAdsToken(account);
    // Headers padrão para relatórios v3
    const adsHeaders: Record<string, string> = {
      'Authorization': `Bearer ${adsToken}`,
      'Amazon-Advertising-API-ClientId': clientId,
      'Amazon-Advertising-API-Scope': profileId,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    const jobIds: Record<string, string> = {};
    const reportResults: any[] = await Promise.all(REPORT_CONFIGS.map(async (rc) => {
      try {
        const payload: any = {
          name: `LivingFinds_${rc.key}_${endDateStr}`,
          startDate: startDateStr,
          endDate: endDateStr,
          configuration: {
            adProduct: 'SPONSORED_PRODUCTS',
            groupBy: rc.groupBy,
            columns: rc.columns,
            reportTypeId: rc.reportTypeId,
            timeUnit: 'DAILY',
            format: 'GZIP_JSON',
          },
        };
        // Filtro para spTargeting: apenas keywords (exclui product targets)
        if (rc.filters) {
          payload.configuration.filters = rc.filters;
        }

        const r = await fetch(`${adsBase}/reporting/reports`, {
          method: 'POST',
          headers: adsHeaders,
          body: JSON.stringify(payload),
        });
        const d = await r.json().catch(() => ({}));

        if (!r.ok) {
          console.warn(`[Pipeline] report ${rc.key} HTTP ${r.status}: ${JSON.stringify(d).slice(0, 200)}`);
        }

        if (r.ok && d.reportId) {
          // Registrar job no banco para polling assíncrono
          const job = await base44.asServiceRole.entities.AmazonAdsReportJob.create({
            amazon_account_id: aid,
            profile_id: profileId,
            region: account.region || 'NA',
            report_id: d.reportId,
            report_name: payload.name,
            report_type_id: rc.reportTypeId,
            ad_product: 'SPONSORED_PRODUCTS',
            time_unit: 'DAILY',
            format: 'GZIP_JSON',
            group_by: rc.groupBy,
            columns: rc.columns,
            filters: rc.filters ? JSON.stringify(rc.filters) : null,
            start_date: startDateStr,
            end_date: endDateStr,
            idempotency_key: `${rc.reportTypeId}|${startDateStr}|${endDateStr}`,
            status: 'pending',
            amazon_status: d.status || 'PENDING',
            requested_at: now,
            next_poll_at: new Date(Date.now() + 10 * 60000).toISOString(), // primeiro poll após 10min
            poll_attempts: 0,
            source_function: 'runDailyFullReportPipeline',
            created_at: now,
            updated_at: now,
          }).catch(() => null);

          if (job) jobIds[rc.key] = job.id;
          return { key: rc.key, ok: true, report_id: d.reportId, job_id: job?.id };
        } else if (r.status === 425) {
          // Já existe um relatório equivalente em andamento — buscar job existente
          const existingJobs = await base44.asServiceRole.entities.AmazonAdsReportJob.filter(
            { amazon_account_id: aid, report_type_id: rc.reportTypeId, status: 'pending' },
            '-created_at', 1
          ).catch(() => []);
          if (existingJobs[0]) jobIds[rc.key] = existingJobs[0].id;
          return { key: rc.key, ok: true, reused: true, status: 425 };
        } else {
          return { key: rc.key, ok: false, error: d?.message || `HTTP ${r.status}` };
        }
      } catch (e: any) {
        return { key: rc.key, ok: false, error: e.message };
      }
    }));

    summary.phases.request = {
      jobs: jobIds,
      count: Object.keys(jobIds).length,
      details: reportResults,
    };
    console.log(`[Pipeline] ${Object.keys(jobIds).length} relatórios solicitados. Polling assíncrono via automação scheduledAmazonAdsReportPoll.`);

    // ── FASE 2: Budget Usage API — dados em tempo quase real ─────────────────
    // Budget Usage API retorna consumo do dia atual sem esperar relatório
    console.log('[Pipeline] Fase 2: Budget Usage API (tempo real)...');
    try {
      // Budget Usage API v3 (SP) — com fallback para campaigns list
      const budgetApiHeaders = {
        'Authorization': `Bearer ${adsToken}`,
        'Amazon-Advertising-API-ClientId': clientId,
        'Amazon-Advertising-API-Scope': profileId,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      };

      let budgetItems: any[] = [];
      const budgetRes = await fetch(`${adsBase}/sp/campaigns/budget/usage`, {
        method: 'POST', headers: budgetApiHeaders, body: JSON.stringify({}),
      });

      if (budgetRes.ok) {
        const d = await budgetRes.json().catch(() => ({}));
        budgetItems = d?.budgetUsageResults || d?.campaigns || [];
      } else {
        // Fallback: SP campaigns list v3
        const listRes = await fetch(`${adsBase}/sp/campaigns/list`, {
          method: 'POST',
          headers: { ...budgetApiHeaders, 'Content-Type': 'application/vnd.spCampaign.v3+json', 'Accept': 'application/vnd.spCampaign.v3+json' },
          body: JSON.stringify({ stateFilter: { include: ['ENABLED', 'PAUSED'] }, maxResults: 500 }),
        });
        if (listRes.ok) {
          const listData = await listRes.json().catch(() => ({}));
          budgetItems = (listData?.campaigns || []).map((c: any) => ({
            campaignId: String(c.campaignId || ''),
            budget: c.budget?.budget || c.dailyBudget || 0,
            budgetUsage: 0,
          }));
        }
      }

      if (budgetItems.length > 0) {
        const existingCamps = await base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 5000).catch(() => []);
        const campByAmazonId = new Map((existingCamps as any[]).map(c => [String(c.amazon_campaign_id || c.campaign_id), c]));
        const budgetUpdates: any[] = [];
        for (const item of budgetItems) {
          const campId = String(item.campaignId || item.id || '');
          const existing = campByAmazonId.get(campId);
          if (!existing) continue;
          const budget = Number(item.budget || item.budgetAmount || 0);
          const spend = Number(item.budgetUsage || 0);
          budgetUpdates.push({ id: existing.id, current_spend: spend, ...(budget > 0 ? { daily_budget: budget } : {}) });
        }
        if (budgetUpdates.length > 0) {
          for (let i = 0; i < budgetUpdates.length; i += BATCH) {
            await base44.asServiceRole.entities.Campaign.bulkUpdate(budgetUpdates.slice(i, i + BATCH)).catch(() => {});
            if (i + BATCH < budgetUpdates.length) await sleep(PAUSE);
          }
        }
        summary.phases.budget_usage = { campaigns: budgetItems.length, updated: budgetUpdates.length };
      } else {
        summary.phases.budget_usage = { skipped: true };
      }
    } catch (e: any) {
      console.warn('[Pipeline] Budget Usage (não crítico):', e.message);
      summary.phases.budget_usage = { error: e.message };
    }

    // ── FASE 3: Inventory FBA via SP-API ─────────────────────────────────────
    try {
      const spToken = await getSPToken();
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
          const record: any = {
            fba_inventory: qty, inventory_status: inventoryStatus, last_sync_at: now,
            reserved_inventory: s.inventoryDetails?.reservedQuantity?.totalReservedQuantity || 0,
            inbound_inventory: (s.inventoryDetails?.inboundWorkingQuantity || 0) + (s.inventoryDetails?.inboundShippedQuantity || 0),
          };
          const existing = prodByAsin.get(s.asin);
          if (existing) invUpdates.push({ id: existing.id, ...record });
          else if (s.asin) invCreates.push({ amazon_account_id: aid, asin: s.asin, sku: s.sellerSku || '', product_name: s.productName || s.asin, status: 'active', ...record });
        }
        await bulkUpsert(base44.asServiceRole.entities.Product, invCreates, invUpdates);
        summary.phases.inventory = { created: invCreates.length, updated: invUpdates.length };
      }
    } catch (e: any) { console.warn('[Pipeline] Inventário FBA (não crítico):', e.message); }

    // ── FASE 4: Atualizar AmazonAccount ──────────────────────────────────────
    await base44.asServiceRole.entities.AmazonAccount.update(aid, { last_sync_at: now, status: 'connected' }).catch(() => {});
    await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id: aid,
      operation: 'runDailyFullReportPipeline',
      status: 'success',
      records_processed: Object.keys(jobIds).length,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
    }).catch(() => {});

    // ── FASE 5: Disparar motor de decisão ─────────────────────────────────────
    console.log('[Pipeline] Fase 5: disparando motor de decisão...');
    try {
      await base44.asServiceRole.functions.invoke('runFullAccountOptimizationWithNewLogic', {
        amazon_account_id: aid, trigger: 'after_report_sync', _service_role: true,
      });
      summary.phases.decision_engine = { triggered: true };
    } catch (e: any) {
      console.warn('[Pipeline] Motor de decisão (não crítico):', e.message);
      summary.phases.decision_engine = { triggered: false, error: e.message };
    }

    // ── FASE 6: Bids de estoque pendentes ─────────────────────────────────────
    try {
      const bidRes = await base44.asServiceRole.functions.invoke('executeStockBidRules', { amazon_account_id: aid });
      summary.phases.stock_bid_execution = { executed: bidRes?.executed || 0, failed: bidRes?.failed || 0 };
    } catch (e: any) {
      summary.phases.stock_bid_execution = { triggered: false, error: e.message };
    }

    summary.duration_s = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('[Pipeline] ✅ Concluído em', summary.duration_s, 's | relatórios em polling assíncrono');
    return Response.json({ ok: true, async_reports: true, summary });

  } catch (err: any) {
    console.error('[runDailyFullReportPipeline]', err.message);
    return Response.json({ ok: false, error: err.message, summary }, { status: 500 });
  }
});