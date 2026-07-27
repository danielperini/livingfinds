import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { secrets } from 'base44:runtime';

/**
 * refreshProductMarketPrice v2 — Amazon SP-API (Product Pricing)
 *
 * Fonte única: GET /products/pricing/v0/competitivePrice via SP-API.
 * Autenticação: LWA inline com SP_REFRESH_TOKEN, SP_CLIENT_ID, SP_CLIENT_SECRET.
 *
 * Parâmetros:
 *   amazon_account_id  — obrigatório
 *   product_id         — consulta produto específico
 *   asin               — alternativa a product_id
 *   next_active        — boolean; seleciona próximo produto ativo não consultado
 *   force              — boolean; ignora cache de 7 dias
 */

const CACHE_DAYS = 7;
const LOCK_MINUTES = 10;
const SP_API_BASE = 'https://sellingpartnerapi-na.amazon.com';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function filterOutliers(prices: number[]): { prices: number[]; excluded: number } {
  if (prices.length < 5) return { prices, excluded: 0 };
  const med = median(prices);
  const filtered = prices.filter(p => p >= med * 0.4 && p <= med * 2.5);
  return { prices: filtered, excluded: prices.length - filtered.length };
}

function calcStats(prices: number[]) {
  const { prices: valid, excluded } = filterOutliers(prices);
  if (valid.length === 0) return null;
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  return {
    average: round2(avg),
    minimum: round2(Math.min(...valid)),
    maximum: round2(Math.max(...valid)),
    median: round2(median(valid)),
    offer_count: valid.length,
    excluded_offer_count: excluded,
  };
}

async function getSpApiToken(): Promise<string> {
  const refreshToken = secrets.get('SP_REFRESH_TOKEN') || secrets.get('AMAZON_SP_REFRESH_TOKEN');
  const clientId = secrets.get('SP_CLIENT_ID') || secrets.get('AMAZON_LWA_CLIENT_ID');
  const clientSecret = secrets.get('SP_CLIENT_SECRET') || secrets.get('AMAZON_LWA_CLIENT_SECRET');

  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error('SP-API credentials not configured (SP_REFRESH_TOKEN, SP_CLIENT_ID, SP_CLIENT_SECRET)');
  }

  const resp = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw Object.assign(new Error(`lwa_error_${resp.status}`), { status: resp.status, detail: text.slice(0, 200) });
  }

  const data = await resp.json();
  if (!data.access_token) throw new Error('LWA returned no access_token');
  return String(data.access_token);
}

async function fetchViaSpApi(asin: string, marketplaceId: string, accessToken: string): Promise<{ prices: number[]; basis: string } | null> {
  const url = `${SP_API_BASE}/products/pricing/v0/competitivePrice?Asins=${encodeURIComponent(asin)}&MarketplaceId=${encodeURIComponent(marketplaceId)}`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'x-amz-access-token': accessToken,
      'x-amz-user-agent': 'LivingFinds/1.0 (Language=TypeScript)',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (resp.status === 401 || resp.status === 403) {
    throw Object.assign(new Error('sp_api_auth_error'), { status: resp.status });
  }
  if (resp.status === 429) {
    const retryAfter = parseInt(resp.headers.get('x-amzn-RateLimit-Limit') || '60', 10);
    throw Object.assign(new Error('rate_limited'), { status: 429, retry_after: retryAfter });
  }
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`sp_api_http_${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json().catch(() => null);
  if (!data) return null;

  // payload shape: { payload: { ASIN, status, Product: { CompetitivePricing: { CompetitivePrices: [] } } } }
  const payload = data.payload;
  if (!payload || payload.status === 'ClientError' || payload.status === 'ServerError') return null;

  const competitivePrices: any[] = payload?.Product?.CompetitivePricing?.CompetitivePrices || [];

  const prices: number[] = [];
  for (const entry of competitivePrices) {
    // Filtrar: condição New, apenas concorrentes (belongsToRequester=false)
    const condition = String(entry.condition || '').toLowerCase();
    if (condition !== 'new') continue;
    if (entry.belongsToRequester === true) continue;

    const priceObj = entry.Price;
    if (!priceObj) continue;

    // Preferir LandedPrice (inclui frete), fallback para ListingPrice
    const amount = priceObj.LandedPrice?.Amount ?? priceObj.ListingPrice?.Amount;
    if (amount == null) continue;

    const parsed = parseFloat(String(amount));
    if (!isFinite(parsed) || parsed <= 0) continue;

    prices.push(round2(parsed));
  }

  return { prices, basis: 'ITEM_ONLY' };
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({})) as any;
    const { amazon_account_id, product_id, asin: bodyAsin, next_active, force } = body;

    if (!amazon_account_id) return Response.json({ error: 'amazon_account_id obrigatório' }, { status: 400 });

    // ── Selecionar produto ────────────────────────────────────────────────────
    let product: any = null;

    if (product_id) {
      const p = await base44.asServiceRole.entities.Product.get(product_id).catch(() => null);
      if (!p || p.amazon_account_id !== amazon_account_id) {
        return Response.json({ error: 'Produto não encontrado' }, { status: 404 });
      }
      product = p;
    } else if (bodyAsin) {
      const list = await base44.asServiceRole.entities.Product.filter(
        { amazon_account_id, asin: bodyAsin }, null, 1
      ).catch(() => []);
      product = list[0] || null;
      if (!product) return Response.json({ error: `ASIN ${bodyAsin} não encontrado` }, { status: 404 });
    } else if (next_active) {
      const allActive = await base44.asServiceRole.entities.Product.filter(
        { amazon_account_id, status: 'active' }, null, 500
      ).catch(() => []);

      const eligible = allActive.filter((p: any) =>
        p.asin && String(p.asin).trim().length >= 10 &&
        (Number(p.fba_inventory || 0) > 0 || p.listing_buyable !== false)
      );

      const notChecked = eligible.filter((p: any) =>
        !p.market_price_status || p.market_price_status === 'not_checked'
      );
      if (notChecked.length > 0) {
        product = notChecked[0];
      } else {
        const sorted = eligible.sort((a: any, b: any) => {
          const ta = a.market_price_last_checked_at ? new Date(a.market_price_last_checked_at).getTime() : 0;
          const tb = b.market_price_last_checked_at ? new Date(b.market_price_last_checked_at).getTime() : 0;
          return ta - tb;
        });
        product = sorted[0] || null;
      }
      if (!product) return Response.json({ ok: true, message: 'Nenhum produto elegível encontrado' });
    } else {
      return Response.json({ error: 'Forneça product_id, asin ou next_active=true' }, { status: 400 });
    }

    const asin = String(product.asin).trim().toUpperCase();
    const marketplaceId = secrets.get('AMAZON_MARKETPLACE_ID') || 'A2Q3Y263D00KWC'; // BR fallback

    // ── Cache ─────────────────────────────────────────────────────────────────
    if (!force && product.market_price_status === 'success' && product.market_price_last_checked_at) {
      const ageDays = (Date.now() - new Date(product.market_price_last_checked_at).getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays < CACHE_DAYS) {
        return Response.json({
          ok: true,
          cache_hit: true,
          product_id: product.id,
          asin,
          market_price_average: product.market_price_average,
          market_price_minimum: product.market_price_minimum,
          market_price_maximum: product.market_price_maximum,
          market_price_offer_count: product.market_price_offer_count,
          market_price_source: product.market_price_source,
          market_price_last_checked_at: product.market_price_last_checked_at,
          message: `Cache válido (${Math.round(ageDays * 10) / 10} dias). Use force=true para forçar atualização.`,
        });
      }
    }

    // ── Lock (10 min) ─────────────────────────────────────────────────────────
    if (product.market_price_status === 'processing' && product.market_price_last_checked_at) {
      const lockAgeMin = (Date.now() - new Date(product.market_price_last_checked_at).getTime()) / 60000;
      if (lockAgeMin < LOCK_MINUTES) {
        return Response.json({ ok: false, message: `Consulta já em andamento (lock ativo há ${Math.round(lockAgeMin)} min)` });
      }
    }

    // Marcar como processing
    await base44.asServiceRole.entities.Product.update(product.id, {
      market_price_status: 'processing',
      market_price_last_checked_at: new Date().toISOString(),
    }).catch(() => {});

    const startMs = Date.now();

    try {
      // ── Obter token SP-API ────────────────────────────────────────────────
      let accessToken: string;
      try {
        accessToken = await getSpApiToken();
      } catch (e: any) {
        const status = e.status;
        const errStatus = (status === 401 || status === 403) ? 'failed' : 'failed';
        await base44.asServiceRole.entities.Product.update(product.id, {
          market_price_status: errStatus,
          market_price_error: `SP-API auth error: ${e.message}`.slice(0, 300),
        }).catch(() => {});
        return Response.json({ ok: false, status: 'failed', error: `SP-API authentication failed: ${e.message}` }, { status: 503 });
      }

      // ── Chamar SP-API ─────────────────────────────────────────────────────
      let result: { prices: number[]; basis: string } | null = null;
      try {
        result = await fetchViaSpApi(asin, marketplaceId, accessToken);
      } catch (e: any) {
        const code = e.message || '';
        if (code.startsWith('sp_api_auth_error') || e.status === 401 || e.status === 403) {
          await base44.asServiceRole.entities.Product.update(product.id, {
            market_price_status: 'failed',
            market_price_error: 'SP-API: autenticação inválida (401/403)',
          }).catch(() => {});
          return Response.json({ ok: false, status: 'failed', error: 'SP-API auth error' }, { status: 401 });
        }
        if (code === 'rate_limited') {
          await base44.asServiceRole.entities.Product.update(product.id, {
            market_price_status: 'rate_limited',
            market_price_error: 'SP-API rate limit',
            market_price_next_check_at: new Date(Date.now() + (e.retry_after || 60) * 1000).toISOString(),
          }).catch(() => {});
          return Response.json({ ok: false, status: 'rate_limited', message: 'SP-API rate limit — tente mais tarde' });
        }
        throw e;
      }

      const durationMs = Date.now() - startMs;

      // ── Sem ofertas ───────────────────────────────────────────────────────
      if (!result || result.prices.length === 0) {
        await base44.asServiceRole.entities.Product.update(product.id, {
          market_price_status: 'no_offers',
          market_price_last_checked_at: new Date().toISOString(),
          market_price_source: 'sp_api',
          market_price_provider: 'Amazon SP-API',
          market_price_error: null,
          market_price_updated_by: user.id,
        }).catch(() => {});
        return Response.json({
          ok: true,
          status: 'no_offers',
          product_id: product.id,
          asin,
          message: 'Nenhuma oferta de concorrente (New) encontrada para este ASIN',
          duration_ms: durationMs,
        });
      }

      // ── Calcular stats e persistir ────────────────────────────────────────
      const stats = calcStats(result.prices);
      if (!stats) {
        await base44.asServiceRole.entities.Product.update(product.id, {
          market_price_status: 'no_offers',
          market_price_last_checked_at: new Date().toISOString(),
        }).catch(() => {});
        return Response.json({ ok: false, status: 'no_offers', message: 'Sem ofertas após filtro de outliers' });
      }

      await base44.asServiceRole.entities.Product.update(product.id, {
        market_price_status: 'success',
        market_price_average: stats.average,
        market_price_minimum: stats.minimum,
        market_price_maximum: stats.maximum,
        market_price_median: stats.median,
        market_price_offer_count: stats.offer_count,
        market_price_excluded_offer_count: stats.excluded_offer_count,
        market_price_currency: 'BRL',
        market_price_source: 'sp_api',
        market_price_provider: 'Amazon SP-API',
        market_price_marketplace: 'BR',
        market_price_basis: result.basis,
        market_price_request_id: null,
        market_price_last_checked_at: new Date().toISOString(),
        market_price_next_check_at: new Date(Date.now() + CACHE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
        market_price_error: null,
        market_price_updated_by: user.id,
      }).catch(() => {});

      return Response.json({
        ok: true,
        status: 'success',
        product_id: product.id,
        asin,
        provider: 'Amazon SP-API',
        offer_count: stats.offer_count,
        excluded_offer_count: stats.excluded_offer_count,
        average: stats.average,
        minimum: stats.minimum,
        maximum: stats.maximum,
        median: stats.median,
        currency: 'BRL',
        checked_at: new Date().toISOString(),
        duration_ms: durationMs,
      });

    } catch (e: any) {
      const sanitized = String(e.message || 'erro').replace(/Bearer\s+[A-Za-z0-9._-]+/gi, '[REDACTED]');
      await base44.asServiceRole.entities.Product.update(product.id, {
        market_price_status: 'failed',
        market_price_error: sanitized.slice(0, 500),
        market_price_next_check_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        market_price_updated_by: user.id,
      }).catch(() => {});
      return Response.json({
        ok: false,
        status: 'failed',
        product_id: product.id,
        asin,
        error: sanitized,
      }, { status: 500 });
    }

  } catch (error: any) {
    const safe = String(error.message || 'erro').replace(/Bearer\s+[A-Za-z0-9._-]+/gi, '[REDACTED]');
    return Response.json({ error: safe }, { status: 500 });
  }
}