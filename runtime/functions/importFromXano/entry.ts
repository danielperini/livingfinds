/**
 * importFromXano — Importa TODOS os dados do Xano para a Base44 sem limites.
 * Endpoints usados:
 *   GET /campaigns  → todas as campanhas
 *   GET /products   → todos os produtos
 *   GET /keywords?campaign_id=X → keywords por campanha (quando campaign_id disponível)
 *   GET /dashboard  → KPIs resumo
 *
 * Payload: { amazon_account_id, action? }
 *   "dashboard" → só KPIs (default)
 *   "sync"      → campanhas + produtos + keywords + KPIs
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const XANO_BASE = 'https://x8ki-letl-twmt.n7.xano.io/api:amazon';

function buildUrl(path, params = {}) {
  const key = Deno.env.get('XANO_API_KEY') || '';
  const qs = new URLSearchParams({ ...params, api_key: key }).toString();
  return `${XANO_BASE}${path}?${qs}`;
}

async function xanoGet(path, params = {}) {
  const key = Deno.env.get('XANO_API_KEY') || '';
  const res = await fetch(buildUrl(path, params), {
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': key,
      'Authorization': `Bearer ${key}`,
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`[${path}] ${res.status}: ${data?.message || data?.error || text.slice(0, 150)}`);
  // Normalizar: data.data[] ou data[] ou []
  const inner = data?.data ?? data;
  return Array.isArray(inner) ? inner : (inner?.data && Array.isArray(inner.data) ? inner.data : data);
}

async function xanoGetObj(path, params = {}) {
  const key = Deno.env.get('XANO_API_KEY') || '';
  const res = await fetch(buildUrl(path, params), {
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': key,
      'Authorization': `Bearer ${key}`,
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`[${path}] ${res.status}: ${data?.message || data?.error || text.slice(0, 150)}`);
  return data?.data ?? data;
}

// Batch upsert: apaga registos antigos da conta e recria tudo de uma vez
async function batchReplace(entity, amazonAccountId, records, base44) {
  if (records.length === 0) return;
  // Apagar existentes desta conta
  await base44.asServiceRole.entities[entity].deleteMany({ amazon_account_id: amazonAccountId });
  // Inserir todos de uma vez em lotes de 500
  for (let i = 0; i < records.length; i += 500) {
    await base44.asServiceRole.entities[entity].bulkCreate(records.slice(i, i + 500));
  }
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    if (!Deno.env.get('XANO_API_KEY')) {
      return Response.json({ ok: false, error: 'XANO_API_KEY não configurada.' }, { status: 503 });
    }

    const body = await req.json().catch(() => ({}));
    const amazonAccountId = body.amazon_account_id;
    const action = body.action || 'dashboard';
    if (!amazonAccountId) return Response.json({ error: 'amazon_account_id required' }, { status: 400 });

    const result = { action, ok: true };

    // ── 1. Dashboard KPIs ──────────────────────────────────────────────────
    try {
      const dash = await xanoGetObj('/dashboard');
      result.dashboard = dash;
      result.kpis = {
        revenue_30d: dash?.revenue_30d || 0,
        spend_30d: dash?.spend_30d || 0,
        acos_30d: dash?.acos_30d || 0,
        clicks_30d: dash?.clicks_30d || 0,
        impressions_30d: dash?.impressions_30d || 0,
        orders_30d: dash?.orders_30d || 0,
        campaigns_count: dash?.campaigns_count || 0,
        active_campaigns_count: dash?.active_campaigns_count || 0,
        products_count: dash?.products_count || 0,
      };
    } catch (e) {
      result.dashboard_error = e.message;
    }

    if (action === 'sync') {
      // ── 2. Campanhas — TODAS sem limite ──────────────────────────────────
      try {
        const campaigns = await xanoGet('/campaigns');
        result.campaigns_received = campaigns.length;
        const allCampaignRecords = [];
        const allKeywords = [];
        let campaignsUpserted = 0;

        for (const c of campaigns) {
          const campaignId = String(c.campaign_id || c.campaignId || c.id || '');
          const name = c.name || c.campaignName || `Campaign ${campaignId}`;
          const stateRaw = (c.status || c.state || 'enabled').toLowerCase();
          const state = stateRaw.includes('paus') ? 'paused' : stateRaw.includes('arch') ? 'archived' : 'enabled';

          const record = {
            amazon_account_id: amazonAccountId,
            campaign_id: campaignId || name, // fallback ao nome se id vazio
            name,
            campaign_type: c.campaign_type || c.campaignType || 'SP',
            state,
            daily_budget: c.daily_budget || c.dailyBudget || 0,
            spend: c.spend_30d || c.spend || c.cost || 0,
            sales: c.sales_30d || c.sales || c.attributedSales30d || 0,
            impressions: c.impressions_30d || c.impressions || 0,
            clicks: c.clicks_30d || c.clicks || 0,
            orders: c.orders_30d || c.orders || c.attributedConversions30d || 0,
            acos: c.acos_30d || c.acos || 0,
            roas: c.roas_30d || c.roas || 0,
            ctr: c.ctr_30d || c.ctr || 0,
            cpc: c.cpc_30d || c.cpc || 0,
            synced_at: new Date().toISOString(),
          };

          allCampaignRecords.push(record);
          campaignsUpserted++;

              // ── 3. Keywords por campanha (se campaign_id disponível) ──────────
          if (campaignId) {
            try {
              const keywords = await xanoGet('/keywords', { campaign_id: campaignId });
              for (const kw of keywords) {
                const kwId = String(kw.keyword_id || kw.keywordId || kw.id || '');
                if (!kwId) continue;
                allKeywords.push({
                  amazon_account_id: amazonAccountId,
                  campaign_id: campaignId,
                  ad_group_id: String(kw.ad_group_id || kw.adGroupId || ''),
                  keyword_id: kwId,
                  keyword_text: kw.keyword_text || kw.keyword || kw.keywordText || kw.searchTerm || '',
                  match_type: (kw.match_type || kw.matchType || 'broad').toLowerCase(),
                  state: (kw.state || kw.status || 'enabled').toLowerCase(),
                  bid: kw.bid || kw.keywordBid || 0,
                  impressions: kw.impressions_30d || kw.impressions || 0,
                  clicks: kw.clicks_30d || kw.clicks || 0,
                  spend: kw.spend_30d || kw.spend || kw.cost || 0,
                  sales: kw.sales_30d || kw.sales || 0,
                  acos: kw.acos_30d || kw.acos || 0,
                  cpc: kw.cpc_30d || kw.cpc || 0,
                  synced_at: new Date().toISOString(),
                });
              }
              result.keywords_received = (result.keywords_received || 0) + keywords.length;
            } catch (_) {
              // keywords podem não existir para todas as campanhas — ignorar silenciosamente
            }
          }
        }
        // Batch replace campanhas e keywords
        await batchReplace('Campaign', amazonAccountId, allCampaignRecords, base44);
        if (allKeywords.length > 0) {
          await batchReplace('Keyword', amazonAccountId, allKeywords, base44);
        }
        result.campaigns_upserted = campaignsUpserted;
        result.keywords_upserted = allKeywords.length;
      } catch (e) {
        result.campaigns_error = e.message;
      }

      // ── 4. Produtos — TODOS sem limite ───────────────────────────────────
      try {
        const products = await xanoGet('/products');
        result.products_received = products.length;
        const allProductRecords = [];

        for (const p of products) {
          const asin = String(p.asin || p.ASIN || '');
          if (!asin) continue;
          allProductRecords.push({
            amazon_account_id: amazonAccountId,
            asin,
            sku: p.sku || p.SKU || '',
            name: p.title || p.name || p.productName || asin,
            status: (p.status || 'active').toLowerCase(),
            price: p.price || 0,
            fba_inventory: p.inventory || p.fba_inventory || 0,
            total_revenue_30d: p.sales_30d || p.revenue_30d || 0,
            units_sold_30d: p.units_30d || p.unitsSold30d || 0,
            synced_at: new Date().toISOString(),
          });
        }
        await batchReplace('Product', amazonAccountId, allProductRecords, base44);
        result.products_upserted = allProductRecords.length;
      } catch (e) {
        result.products_error = e.message;
      }
    }

    // ── 5. Atualizar conta + SyncRun ─────────────────────────────────────
    await base44.asServiceRole.entities.AmazonAccount.update(amazonAccountId, {
      last_sync_at: new Date().toISOString(),
      status: 'connected',
    });

    const hasError = result.campaigns_error || result.products_error || result.dashboard_error;
    await base44.asServiceRole.entities.SyncRun.create({
      amazon_account_id: amazonAccountId,
      operation: `importFromXano:${action}`,
      status: hasError ? 'partial' : 'success',
      records_upserted: (result.campaigns_upserted || 0) + (result.products_upserted || 0),
      duration_ms: Date.now() - startTime,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    });

    return Response.json({ ...result, duration_ms: Date.now() - startTime });

  } catch (error) {
    console.error('importFromXano failed:', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});