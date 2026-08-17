import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

/**
 * runZeroSalesBidGuard
 *
 * Motor diário de proteção de margem para keywords com zero vendas.
 *
 * Rodada 1 — ACTIONABLE: cliques >= 10 OU gasto >= maximum_ad_spend_per_order
 *   → reduz bid em 20% (respeitando min_bid), registra em AdsBidChangeLog, cooldown 72h.
 *
 * Rodada 2 — 72h após 1ª redução, ainda orders=0 E cliques suficientes:
 *   → pausa o termo (state='paused'), registra motivo.
 *
 * Keywords protegidas (protected_high_performance=true) → sempre ignoradas.
 * Cooldown controlado via Keyword.last_seen_at (não reutiliza campos de dayparting).
 */

const WINDOW_DAYS = 14;
const COOLDOWN_HOURS = 72;
const BID_REDUCTION_PCT = 0.20;
const MIN_CLICKS_THRESHOLD = 10;
const DEFAULT_MIN_BID = 0.30;

export default async function handler(req: Request): Promise<Response> {
  const startedAt = new Date().toISOString();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'admin') return Response.json({ error: 'Forbidden' }, { status: 403 });

    const body = await req.json().catch(() => ({})) as any;
    const { amazon_account_id, dry_run = false, trigger_type = 'automatic' } = body;
    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id obrigatório' }, { status: 400 });

    // ── Buscar conta e configurações ─────────────────────────────────────────
    const [accounts, autopilotConfigs, perfSettings] = await Promise.all([
      base44.asServiceRole.entities.AmazonAccount.filter({ id: amazon_account_id }, null, 1),
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id }, null, 1),
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id }, null, 1),
    ]);

    const account = accounts[0];
    if (!account) return Response.json({ error: 'Conta não encontrada' }, { status: 404 });

    const profileId = account.ads_profile_id || Deno.env.get('ADS_PROFILE_ID') || '';
    const minBid = autopilotConfigs[0]?.min_bid || perfSettings[0]?.min_bid || DEFAULT_MIN_BID;

    // ── Buscar keywords ativas com spend > 0 ─────────────────────────────────
    const allKeywords = await base44.asServiceRole.entities.Keyword.filter(
      { amazon_account_id }, null, 2000
    );

    const activeKeywords = allKeywords.filter((k: any) => {
      const state = (k.state || k.status || '').toLowerCase();
      return state === 'enabled' && !k.protected_high_performance && Number(k.spend || 0) > 0;
    });

    // ── Buscar métricas 14d por campanha → somar por keyword ─────────────────
    const cutoff = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
    const recentMetrics = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id }, '-date', 5000
    ).catch(() => []);

    // Somar métricas por campaign_id nos últimos 14d
    const metricsByCampaign = new Map<string, { clicks: number; spend: number; orders: number }>();
    for (const m of recentMetrics) {
      if (!m.date || m.date < cutoff) continue;
      const cid = m.campaign_id;
      const prev = metricsByCampaign.get(cid) || { clicks: 0, spend: 0, orders: 0 };
      prev.clicks += m.clicks || 0;
      prev.spend  += m.spend  || 0;
      prev.orders += m.orders || 0;
      metricsByCampaign.set(cid, prev);
    }

    // ── Buscar produtos para maximum_ad_spend_per_order ───────────────────────
    const products = await base44.asServiceRole.entities.Product.filter(
      { amazon_account_id }, null, 500
    ).catch(() => []);
    const productByAsin = new Map<string, any>();
    for (const p of products) { if (p.asin) productByAsin.set(p.asin, p); }

    // ── Obter token Ads ────────────────────────────────────────────────────────
    let accessToken = '';
    if (!dry_run) {
      try {
        const tokenRes = await base44.asServiceRole.functions.invoke('amazonAdsTokenManager', {
          amazon_account_id, _service_role: true,
        });
        const tokenData = tokenRes?.data || tokenRes || {};
        if (tokenData.ok && tokenData.access_token) {
          accessToken = String(tokenData.access_token);
        }
      } catch {
        // Continuar sem token — só dry_run funcionará
      }
    }

    const now = Date.now();
    const cooldownMs = COOLDOWN_HOURS * 3600 * 1000;

    const results = {
      reduced: [] as any[],
      paused: [] as any[],
      skipped_insufficient_data: [] as any[],
      skipped_cooldown: [] as any[],
      skipped_protected: [] as any[],
      errors: [] as any[],
    };

    for (const kw of activeKeywords) {
      // Cooldown: usar last_seen_at como marcador de última ação do motor
      const lastAction = kw.last_seen_at;
      if (lastAction) {
        const ageMs = now - new Date(lastAction).getTime();
        if (ageMs < cooldownMs) {
          results.skipped_cooldown.push({ keyword: kw.keyword_text, reason: 'cooldown_72h' });
          continue;
        }
      }

      // Métricas: do campo direto ou das métricas diárias da campanha
      const campaignMetrics = metricsByCampaign.get(kw.campaign_id) || { clicks: 0, spend: 0, orders: 0 };
      const clicks = Number(kw.clicks || 0) > 0 ? Number(kw.clicks || 0) : campaignMetrics.clicks;
      const spend  = Number(kw.spend  || 0) > 0 ? Number(kw.spend  || 0) : campaignMetrics.spend;
      const orders = Number(kw.orders || 0) > 0 ? Number(kw.orders || 0) : campaignMetrics.orders;

      // Apenas processar keywords com zero pedidos
      if (orders > 0) continue;
      if (spend <= 0) continue;

      const product = kw.asin ? productByAsin.get(kw.asin) : null;
      const maxAdSpend = Number(product?.maximum_ad_spend_per_order || 0);

      // Classificar: ACTIONABLE ou INSUFFICIENT_DATA
      const isActionable =
        clicks >= MIN_CLICKS_THRESHOLD ||
        (maxAdSpend > 0 && spend >= maxAdSpend);

      if (!isActionable) {
        results.skipped_insufficient_data.push({
          keyword: kw.keyword_text, clicks, spend,
          reason: 'insufficient_data',
        });
        continue;
      }

      const currentBid = Number(kw.bid || kw.current_bid || 0.5);
      const isSecondRound = lastAction !== null && lastAction !== undefined; // já teve ação anterior

      try {
        if (isSecondRound) {
          // ── Rodada 2: pausar keyword ────────────────────────────────────
          if (!dry_run && accessToken && kw.keyword_id) {
            const adsBase = (() => {
              const r = String(account.region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
              if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
              if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
              return 'https://advertising-api.amazon.com';
            })();
            const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
            const resp = await fetch(`${adsBase}/v2/sp/keywords`, {
              method: 'PUT',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Amazon-Advertising-API-ClientId': clientId,
                'Amazon-Advertising-API-Scope': profileId,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify([{ keywordId: kw.keyword_id, state: 'paused' }]),
              signal: AbortSignal.timeout(15000),
            });
            const text = await resp.text().catch(() => '');
            let parsed: any = {};
            try { parsed = text ? JSON.parse(text) : {}; } catch {}
            const item = Array.isArray(parsed) ? parsed[0] : (parsed?.keywords?.[0] || {});
            if (resp.status !== 207 && !resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
            if (String(item?.code || '').toUpperCase() === 'FAILURE') throw new Error(`Amazon error: ${item?.description}`);
          }

          if (!dry_run) {
            await base44.asServiceRole.entities.Keyword.update(kw.id, {
              state: 'paused',
              status: 'paused',
              last_seen_at: new Date().toISOString(),
            }).catch(() => {});

            await base44.asServiceRole.entities.AdsBidChangeLog.create({
              amazon_account_id,
              date: new Date().toISOString().slice(0, 10),
              campaign_id: kw.campaign_id,
              ad_group_id: kw.ad_group_id,
              keyword_id: kw.keyword_id,
              keyword_text: kw.keyword_text,
              asin: kw.asin,
              entity_type: 'keyword',
              entity_id: kw.keyword_id || kw.id,
              old_bid: currentBid,
              new_bid: currentBid,
              bid_before: currentBid,
              bid_after: currentBid,
              change_amount: 0,
              direction: 'unchanged',
              action: 'pause_keyword',
              reason: 'zero_sales_pause',
              evidence: `clicks=${clicks} spend=${spend.toFixed(2)} orders=0 após 72h de cooldown`,
              classification: 'zero_sales_guard',
              status: 'executed',
              source: 'runZeroSalesBidGuard',
              created_at: new Date().toISOString(),
            }).catch(() => {});
          }

          results.paused.push({ keyword: kw.keyword_text, keyword_id: kw.keyword_id, clicks, spend, asin: kw.asin });

        } else {
          // ── Rodada 1: reduzir bid 20% ────────────────────────────────────
          const newBid = Math.max(minBid, Math.round(currentBid * (1 - BID_REDUCTION_PCT) * 100) / 100);

          if (!dry_run && accessToken && kw.keyword_id && newBid !== currentBid) {
            const adsBase = (() => {
              const r = String(account.region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
              if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
              if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
              return 'https://advertising-api.amazon.com';
            })();
            const clientId = Deno.env.get('ADS_CLIENT_ID') || '';
            const resp = await fetch(`${adsBase}/v2/sp/keywords`, {
              method: 'PUT',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Amazon-Advertising-API-ClientId': clientId,
                'Amazon-Advertising-API-Scope': profileId,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify([{ keywordId: kw.keyword_id, bid: newBid }]),
              signal: AbortSignal.timeout(15000),
            });
            const text = await resp.text().catch(() => '');
            let parsed: any = {};
            try { parsed = text ? JSON.parse(text) : {}; } catch {}
            const item = Array.isArray(parsed) ? parsed[0] : (parsed?.keywords?.[0] || {});
            if (resp.status !== 207 && !resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
            if (String(item?.code || '').toUpperCase() === 'FAILURE') throw new Error(`Amazon error: ${item?.description}`);
          }

          if (!dry_run) {
            await base44.asServiceRole.entities.Keyword.update(kw.id, {
              bid: newBid,
              current_bid: newBid,
              last_seen_at: new Date().toISOString(),
            }).catch(() => {});

            await base44.asServiceRole.entities.AdsBidChangeLog.create({
              amazon_account_id,
              date: new Date().toISOString().slice(0, 10),
              campaign_id: kw.campaign_id,
              ad_group_id: kw.ad_group_id,
              keyword_id: kw.keyword_id,
              keyword_text: kw.keyword_text,
              asin: kw.asin,
              entity_type: 'keyword',
              entity_id: kw.keyword_id || kw.id,
              old_bid: currentBid,
              new_bid: newBid,
              bid_before: currentBid,
              bid_after: newBid,
              change_amount: Math.round((newBid - currentBid) * 100) / 100,
              change_percent: -BID_REDUCTION_PCT * 100,
              change_pct: -BID_REDUCTION_PCT * 100,
              direction: 'decrease',
              action: 'reduce_bid_zero_sales',
              reason: 'zero_sales_bid_reduction',
              evidence: `clicks=${clicks} spend=${spend.toFixed(2)} orders=0 max_ad_spend=${maxAdSpend.toFixed(2)}`,
              classification: 'zero_sales_guard',
              status: 'executed',
              source: 'runZeroSalesBidGuard',
              created_at: new Date().toISOString(),
            }).catch(() => {});
          }

          results.reduced.push({
            keyword: kw.keyword_text, keyword_id: kw.keyword_id,
            old_bid: currentBid, new_bid: newBid, clicks, spend, asin: kw.asin,
          });
        }
      } catch (e: any) {
        results.errors.push({ keyword: kw.keyword_text, error: e.message?.slice(0, 200) });
      }
    }

    // ── Log ───────────────────────────────────────────────────────────────────
    const totalActions = results.reduced.length + results.paused.length;
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id,
      operation: 'zero_sales_bid_guard',
      trigger_type,
      status: dry_run ? 'skipped' : results.errors.length > 0 && totalActions === 0 ? 'error' : 'success',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      records_processed: totalActions,
      result_summary: dry_run
        ? `dry_run: actionable=${results.reduced.length + results.paused.length} insufficient=${results.skipped_insufficient_data.length}`
        : `reduced=${results.reduced.length} paused=${results.paused.length} insufficient=${results.skipped_insufficient_data.length} cooldown=${results.skipped_cooldown.length} errors=${results.errors.length}`,
      error_message: results.errors.length > 0
        ? results.errors.slice(0, 3).map((e: any) => `${e.keyword}: ${e.error}`).join(' | ')
        : undefined,
    }).catch(() => {});

    return Response.json({
      ok: true,
      dry_run,
      reduced: results.reduced.length,
      paused: results.paused.length,
      skipped_insufficient_data: results.skipped_insufficient_data.length,
      skipped_cooldown: results.skipped_cooldown.length,
      errors: results.errors,
      detail: results,
    });

  } catch (error: any) {
    await base44.asServiceRole?.entities?.SyncExecutionLog?.create({
      amazon_account_id: '',
      operation: 'zero_sales_bid_guard',
      trigger_type: 'automatic',
      status: 'error',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      records_processed: 0,
      error_message: error.message,
    }).catch(() => {});
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}