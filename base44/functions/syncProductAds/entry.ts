/**
 * syncProductAds — Sincroniza Product Ads (anúncios individuais SP) com ASIN/SKU
 * Também sincroniza Targets e Product Targets
 * Payload: { amazon_account_id }
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = new Map<string, { access_token: string; expires_at: number }>();
type AdsCredentials = { refreshToken: string; profileId: string; clientId: string; clientSecret: string; region: string };

async function getToken(credentials: AdsCredentials): Promise<string> {
  const cacheKey = credentials.refreshToken;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: credentials.refreshToken,
    client_id: credentials.clientId, client_secret: credentials.clientSecret,
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || 'Token refresh failed');
  tokenCache.set(cacheKey, { access_token: data.access_token, expires_at: Date.now() + (Number(data.expires_in || 3600) - 60) * 1000 });
  return data.access_token;
}

function baseUrl(region: string) {
  const r = String(region || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function call(method: string, path: string, body: any, ct: string, credentials: AdsCredentials) {
  const token = await getToken(credentials);
  const opts: any = { method, headers: {
    'Authorization': `Bearer ${token}`, 'Amazon-Advertising-API-ClientId': credentials.clientId,
    'Amazon-Advertising-API-Scope': String(credentials.profileId), 'Content-Type': ct, 'Accept': ct,
  }};
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl(credentials.region)}${path}`, opts);
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`ADS ${res.status} ${path}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function listAllPages(path: string, initialBody: any, responseKey: string, ct: string, credentials: AdsCredentials) {
  const rows: any[] = [], seenTokens = new Set<string>();
  let nextToken: string | null = null, pages = 0;
  do {
    const body = { ...initialBody, ...(nextToken ? { nextToken } : {}) };
    const data = await call('POST', path, body, ct, credentials);
    const pageRows = data?.[responseKey] || (Array.isArray(data) ? data : []);
    if (!Array.isArray(pageRows)) throw new Error(`Resposta inválida em ${path}: ${responseKey} ausente`);
    rows.push(...pageRows);
    nextToken = data?.nextToken ? String(data.nextToken) : null;
    if (nextToken && seenTokens.has(nextToken)) throw new Error(`Token de paginação repetido em ${path}`);
    if (nextToken) seenTokens.add(nextToken);
    if (++pages > 1000) throw new Error(`Limite de paginação excedido em ${path}`);
  } while (nextToken);
  return rows;
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  let syncRunId = null;
  let base44;

  try {
    base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));
    if (!body._service_role) {
      const user = await base44.auth.me().catch(() => null);
      if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const amazonAccountId = body.amazon_account_id;
    if (!amazonAccountId) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazonAccountId }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada' }, { status: 404 });
    const credentials: AdsCredentials = {
      refreshToken: account.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN') || '',
      profileId: String(account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || ''),
      clientId: Deno.env.get('ADS_CLIENT_ID') || '',
      clientSecret: Deno.env.get('ADS_CLIENT_SECRET') || '',
      region: account.region || Deno.env.get('ADS_REGION') || 'NA',
    };
    if (!credentials.refreshToken || !credentials.profileId || !credentials.clientId || !credentials.clientSecret) {
      return Response.json({ ok: false, error: 'Credenciais/perfil da conta Amazon Ads incompletos' }, { status: 409 });
    }

    const syncRun = await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id: amazonAccountId,
      operation: 'syncProductAds',
      status: 'running',
      started_at: new Date().toISOString(),
    });
    syncRunId = syncRun.id;

    let totalReceived = 0, totalUpserted = 0;
    const errors = [];

    // ── Product Ads SP ──
    try {
      const adsList = await listAllPages('/sp/productAds/list',
        { stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] }, maxResults: 1000 },
        'productAds', 'application/vnd.spProductAd.v3+json', credentials);
      totalReceived += adsList.length;

      const existingProductAds = await base44.asServiceRole.entities.ProductAd.filter(
        { amazon_account_id: amazonAccountId }, null, 5000
      ).catch(() => []);
      const productAdMap = new Map(
        existingProductAds.map((row) => [String(row.product_ad_id), row])
      );
      const productAdsToCreate = [];
      const productAdsToUpdate = [];
      const now = new Date().toISOString();

      for (const ad of adsList) {
        const productAdId = String(ad.adId || ad.productAdId || '');
        if (!productAdId) continue;
        const state = String(ad.state || 'enabled').toLowerCase();
        const productAdRecord = {
          amazon_account_id: amazonAccountId,
          product_ad_id: productAdId,
          campaign_id: String(ad.campaignId || ''),
          ad_group_id: String(ad.adGroupId || ''),
          asin: ad.asin || null,
          sku: ad.sku || null,
          state,
          status: state,
          synced_at: now,
        };
        const existingProductAd = productAdMap.get(productAdId);
        if (existingProductAd) {
          productAdsToUpdate.push({ id: existingProductAd.id, ...productAdRecord });
        } else {
          productAdsToCreate.push(productAdRecord);
        }

        // ProductAd é o vínculo real campanha→SKU. Não atualizamos Product por ASIN,
        // pois um ASIN pode corresponder a mais de um SKU seller.
      }

      const BATCH = 100;
      for (let i = 0; i < productAdsToCreate.length; i += BATCH)
        await base44.asServiceRole.entities.ProductAd.bulkCreate(productAdsToCreate.slice(i, i + BATCH));
      for (let i = 0; i < productAdsToUpdate.length; i += BATCH)
        await base44.asServiceRole.entities.ProductAd.bulkUpdate(productAdsToUpdate.slice(i, i + BATCH));
      totalUpserted += productAdsToCreate.length + productAdsToUpdate.length;
    } catch (e) { errors.push(`ProductAds: ${e.message}`); }

    // ── SP Targets (product targeting) ──
    try {
      const targetList = await listAllPages('/sp/targets/list',
        { stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] }, maxResults: 1000 },
        'targetingClauses', 'application/vnd.spTargetingClause.v3+json', credentials);
      totalReceived += targetList.length;
      // Targets ASIN são guardados como keywords com matchType = 'targeting'
      for (const t of targetList) {
        if (!t.targetId) continue;
        const asin = t.expression?.[0]?.value || t.resolvedExpression?.[0]?.value;
        const existing = await base44.asServiceRole.entities.Keyword.filter({
          amazon_account_id: amazonAccountId,
          keyword_id: `tgt_${t.targetId}`,
        });
        const record = {
          amazon_account_id: amazonAccountId,
          campaign_id: String(t.campaignId),
          ad_group_id: String(t.adGroupId),
          keyword_id: `tgt_${t.targetId}`,
          keyword_text: asin || t.expression?.[0]?.type || 'product_target',
          match_type: 'targeting',
          state: (t.state || 'enabled').toLowerCase(),
          bid: t.bid || 0,
          synced_at: new Date().toISOString(),
        };
        if (existing.length > 0) {
          await base44.asServiceRole.entities.Keyword.update(existing[0].id, record);
        } else {
          await base44.asServiceRole.entities.Keyword.create(record);
        }
        totalUpserted++;
      }
    } catch (e) { errors.push(`Targets: ${e.message}`); }

    let skuCampaignAnalysis: any = null;
    if (errors.length === 0) {
      const refreshed = await base44.asServiceRole.functions.invoke('syncAdsCampaignStatesV2', {
        _service_role: true, amazon_account_id: amazonAccountId, trigger_type: 'sku_campaign_daily_analysis',
      }).catch((error: any) => ({ data: { ok: false, error: error?.message } }));
      const refreshedData = refreshed?.data || refreshed || {};
      if (refreshedData.ok === false) throw new Error(`Campaign state refresh failed: ${refreshedData.error || 'unknown'}`);
      const [campaignRows, productRows] = await Promise.all([
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId }, '-updated_at', 5000),
        base44.asServiceRole.entities.Product.filter({ amazon_account_id: amazonAccountId }, '-updated_at', 5000),
      ]);
      const campaignById = new Map<string, any>();
      for (const row of campaignRows) {
        const id = String(row.campaign_id || row.amazon_campaign_id || '');
        if (id && !campaignById.has(id)) campaignById.set(id, row);
      }
      const productsByAsin = new Map<string, any[]>();
      for (const product of productRows) {
        const asin = String(product.asin || '').trim().toUpperCase();
        if (asin) productsByAsin.set(asin, [...(productsByAsin.get(asin) || []), product]);
      }
      const perSku = new Map<string, any>();
      let ambiguousProductAds = 0, unlinkedProductAds = 0;
      for (const ad of adsList) {
        let sku = String(ad.sku || '').trim();
        const asin = String(ad.asin || '').trim().toUpperCase();
        if (!sku && asin) {
          const matches = productsByAsin.get(asin) || [];
          if (matches.length === 1) sku = String(matches[0].sku || '').trim();
          else if (matches.length > 1) ambiguousProductAds++;
        }
        if (!sku) { unlinkedProductAds++; continue; }
        const cid = String(ad.campaignId || '');
        const campaign = campaignById.get(cid);
        const state = String(campaign?.amazon_status || campaign?.state || campaign?.status || ad.state || '').toLowerCase();
        const enabled = ['enabled', 'active'].includes(state);
        const name = String(campaign?.name || campaign?.campaign_name || '');
        const targeting = String(campaign?.targeting_type || '').toUpperCase() ||
          (/^\s*AUTO\s*\|/i.test(name) ? 'AUTO' : /^\s*SP\s*\|\s*MANUAL\s*\|/i.test(name) ? 'MANUAL' : '');
        const key = sku.toUpperCase();
        const row = perSku.get(key) || { sku, asin, activeAuto: new Set(), pausedAuto: new Set(), activeManual: new Set(), pausedManual: new Set(), allCampaigns: new Set() };
        if (cid) {
          row.allCampaigns.add(cid);
          if (targeting === 'AUTO') (enabled ? row.activeAuto : row.pausedAuto).add(cid);
          if (targeting === 'MANUAL') (enabled ? row.activeManual : row.pausedManual).add(cid);
        }
        perSku.set(key, row);
      }
      const seenSku = new Set<string>();
      const skuRows = productRows.filter((p: any) => String(p.sku || '').trim()).flatMap((product: any) => {
        const sku = String(product.sku).trim(), key = sku.toUpperCase();
        if (seenSku.has(key)) return [];
        seenSku.add(key);
        const stats = perSku.get(key), activeAuto = stats?.activeAuto.size || 0, activeManual = stats?.activeManual.size || 0;
        return [{
          sku, asin: String(product.asin || '').toUpperCase(),
          active_auto_campaigns: activeAuto, paused_auto_campaigns: stats?.pausedAuto.size || 0,
          active_manual_campaigns: activeManual, paused_manual_campaigns: stats?.pausedManual.size || 0,
          distinct_campaigns: stats?.allCampaigns.size || 0,
          recommendation: activeAuto === 0 ? 'review_automatic_coverage' :
            activeManual === 0 ? 'manual_only_after_verified_winner' : 'coverage_present',
        }];
      });
      skuCampaignAnalysis = {
        date: new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10),
        amazon_account_id: amazonAccountId, source: 'amazon_sp_productAds_list_plus_campaigns',
        product_ads_received: adsList.length, distinct_skus: skuRows.length, sku_rows: skuRows,
        ambiguous_product_ads: ambiguousProductAds, unlinked_product_ads: unlinkedProductAds,
        counts_are_distinct_campaign_ids: true, campaign_budgets_are_independent_references: true,
      };
      await base44.asServiceRole.entities.SyncExecutionLog.create({
        amazon_account_id: amazonAccountId, operation: 'sku_campaign_daily_analysis',
        trigger_type: body.trigger_type || 'scheduled', status: 'success',
        execution_date: skuCampaignAnalysis.date, started_at: new Date(startTime).toISOString(),
        completed_at: new Date().toISOString(), records_processed: adsList.length,
        result_summary: JSON.stringify(skuCampaignAnalysis),
      });
    }

    await base44.asServiceRole.entities.SyncRun.update(syncRunId, {
      status: errors.length > 0 && totalUpserted === 0 ? 'error' : errors.length > 0 ? 'partial' : 'success',
      records_received: totalReceived,
      records_upserted: totalUpserted,
      error_message: errors.join('; ') || null,
      duration_ms: Date.now() - startTime,
      completed_at: new Date().toISOString(),
    });

    return Response.json({ ok: errors.length === 0, totalReceived, totalUpserted, errors, sku_campaign_analysis: skuCampaignAnalysis }, { status: errors.length ? 207 : 200 });

  } catch (error) {
    if (syncRunId && base44) {
      await base44.asServiceRole.entities.SyncRun.update(syncRunId, {
        status: 'error', error_message: error.message,
        duration_ms: Date.now() - startTime, completed_at: new Date().toISOString(),
      }).catch(() => {});
    }
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});
