import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';
import { secrets } from 'base44:runtime';

/**
 * refreshProductMarketPrice
 *
 * Consulta preços públicos de mercado para um ASIN na Amazon Brasil.
 * Fontes em ordem: Zinc (se configurado p/ BR) → ScrapingBee Pricing.
 *
 * Parâmetros:
 *   amazon_account_id  — obrigatório
 *   product_id         — optional; consulta produto específico
 *   asin               — optional; alternativa a product_id
 *   next_active        — boolean; selecionar próximo produto ativo não consultado
 *   force              — boolean; ignorar cache de 7 dias
 *
 * SECRETS: ZINC_API_KEY, SCRAPINGBEE_API_KEY — jamais expostos em resposta/log.
 */

const CACHE_DAYS = 7;
const LOCK_MINUTES = 10;
const MAX_RETRIES = 3;

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

async function fetchViaScrapingBee(asin: string, apiKey: string): Promise<{ prices: number[]; basis: string; request_id: string } | null> {
  const url = new URL('https://app.scrapingbee.com/api/v1/amazon/pricing/');
  url.searchParams.set('query', asin);
  url.searchParams.set('domain', 'com.br');
  url.searchParams.set('add_html', 'false');
  url.searchParams.set('tag', 'livingfinds_market_price');

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    attempt++;
    let resp: Response;
    try {
      resp = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
    } catch (e: any) {
      if (attempt >= MAX_RETRIES) throw e;
      await new Promise(r => setTimeout(r, 1000 * attempt));
      continue;
    }

    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get('Retry-After') || '60', 10);
      throw Object.assign(new Error('rate_limited'), { status: 429, retry_after: retryAfter });
    }
    if (resp.status === 402) {
      throw Object.assign(new Error('credit_limit_reached'), { status: 402 });
    }
    if (resp.status === 401 || resp.status === 403) {
      throw Object.assign(new Error('scrapingbee_auth_error'), { status: resp.status });
    }
    if (resp.status === 404) return null;
    if (!resp.ok) {
      if (attempt >= MAX_RETRIES) throw Object.assign(new Error(`scrapingbee_http_${resp.status}`), { status: resp.status });
      await new Promise(r => setTimeout(r, 1500 * attempt));
      continue;
    }

    const data = await resp.json().catch(() => null);
    if (!data) return null;

    // ScrapingBee Amazon Pricing retorna objeto com campo "offers" ou array direto
    const rawOffers: any[] = Array.isArray(data) ? data : (data.offers || data.results || []);
    const prices: number[] = [];

    for (const offer of rawOffers) {
      const condition = String(offer.condition || offer.Condition || '').toLowerCase();
      if (condition && condition !== 'new' && condition !== 'novo' && condition !== 'new/novo') continue;
      const available = offer.is_available ?? offer.available ?? offer.inStock ?? true;
      if (available === false) continue;
      const currency = String(offer.currency || offer.Currency || offer.price_currency || 'BRL').toUpperCase();
      if (currency !== 'BRL') continue;

      let itemPrice = parseFloat(String(offer.price || offer.Price || offer.item_price || 0));
      const shippingPrice = parseFloat(String(offer.shipping_price || offer.shipping || 0));
      if (!isFinite(itemPrice) || itemPrice <= 0) continue;

      // Se frete obrigatório (não grátis), somar
      const freeShipping = offer.free_shipping ?? offer.is_free_shipping ?? (shippingPrice === 0);
      const observed = freeShipping ? itemPrice : itemPrice + shippingPrice;
      if (observed <= 0) continue;

      prices.push(round2(observed));
    }

    // Deduplicar preços idênticos do mesmo seller
    const seen = new Set<string>();
    const deduped: number[] = [];
    for (let i = 0; i < rawOffers.length && i < prices.length; i++) {
      const o = rawOffers[i];
      const key = `${o.seller_id || o.seller || ''}:${o.offer_id || ''}:${prices[i]}`;
      if (!seen.has(key)) { seen.add(key); deduped.push(prices[i]); }
    }

    return {
      prices: deduped.length > 0 ? deduped : prices,
      basis: 'ITEM_PLUS_REQUIRED_SHIPPING',
      request_id: resp.headers.get('x-request-id') || data.request_id || '',
    };
  }
  return null;
}

async function fetchViaZinc(asin: string, retailer: string, apiKey: string): Promise<{ prices: number[]; basis: string; request_id: string } | null> {
  const url = `https://api.zinc.io/v1/products/${encodeURIComponent(asin)}/offers?retailer=${encodeURIComponent(retailer)}`;

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    attempt++;
    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
      });
    } catch (e: any) {
      if (attempt >= MAX_RETRIES) throw e;
      await new Promise(r => setTimeout(r, 1000 * attempt));
      continue;
    }

    if (resp.status === 404) return null;
    if (resp.status === 401 || resp.status === 403) {
      throw Object.assign(new Error('zinc_auth_error'), { status: resp.status });
    }
    if (resp.status === 402) {
      throw Object.assign(new Error('credit_limit_reached'), { status: 402 });
    }
    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get('Retry-After') || '60', 10);
      throw Object.assign(new Error('rate_limited'), { status: 429, retry_after: retryAfter });
    }
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      const code = body?.code || '';
      if (code === 'retailer_not_supported' || code === 'unsupported_marketplace') {
        throw Object.assign(new Error('unsupported_marketplace'), { status: resp.status, zinc_code: code });
      }
      if (attempt >= MAX_RETRIES) throw Object.assign(new Error(`zinc_http_${resp.status}`), { status: resp.status });
      await new Promise(r => setTimeout(r, 1500 * attempt));
      continue;
    }

    const data = await resp.json().catch(() => null);
    if (!data) return null;

    const rawOffers: any[] = Array.isArray(data) ? data : (data.offers || []);
    const prices: number[] = [];
    const seen = new Set<string>();

    for (const offer of rawOffers) {
      const condition = String(offer.condition || '').toLowerCase();
      if (condition && condition !== 'new') continue;
      const available = offer.is_available ?? offer.available ?? true;
      if (available === false) continue;
      const currency = String(offer.currency || 'BRL').toUpperCase();
      if (currency !== 'BRL') continue;

      let itemPrice = parseFloat(String(offer.price || offer.item_price || 0));
      if (!isFinite(itemPrice) || itemPrice <= 0) continue;

      const shippingPrice = parseFloat(String(offer.shipping_price || 0));
      const freeShipping = offer.is_prime_eligible || shippingPrice === 0;
      const observed = round2(freeShipping ? itemPrice : itemPrice + shippingPrice);
      if (observed <= 0) continue;

      const key = `${offer.seller_id || offer.seller || ''}:${offer.offer_id || ''}:${observed}`;
      if (!seen.has(key)) { seen.add(key); prices.push(observed); }
    }

    return {
      prices,
      basis: 'ITEM_PLUS_REQUIRED_SHIPPING',
      request_id: data.request_id || resp.headers.get('x-request-id') || '',
    };
  }
  return null;
}

export default async function(req: Request): Promise<Response> {
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
      // Critério: ativo + ASIN válido + fba_inventory > 0, priorizar não consultado
      const allActive = await base44.asServiceRole.entities.Product.filter(
        { amazon_account_id, status: 'active' }, null, 500
      ).catch(() => []);

      const eligible = allActive.filter((p: any) =>
        p.asin && String(p.asin).trim().length >= 10 &&
        (Number(p.fba_inventory || 0) > 0 || p.listing_buyable !== false)
      );

      // Prioridade 1: ainda não consultado
      const notChecked = eligible.filter((p: any) =>
        !p.market_price_status || p.market_price_status === 'not_checked'
      );
      if (notChecked.length > 0) {
        product = notChecked[0];
      } else {
        // Prioridade 2: o mais antigo
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
    const marketplace = String(product.marketplace_id || 'BR');
    const today = new Date().toISOString().slice(0, 10);

    // ── Cache: se já consultado recentemente, retornar sem chamar API ─────────
    if (!force && product.market_price_status === 'success' && product.market_price_last_checked_at) {
      const ageMs = Date.now() - new Date(product.market_price_last_checked_at).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
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

    // ── Lock de idempotência (10 min) ─────────────────────────────────────────
    const lockKey = `${amazon_account_id}:${asin}:MARKET_PRICE:${today}`;
    if (product.market_price_status === 'processing') {
      const lockedAt = product.market_price_last_checked_at;
      if (lockedAt) {
        const lockAgeMin = (Date.now() - new Date(lockedAt).getTime()) / 60000;
        if (lockAgeMin < LOCK_MINUTES) {
          return Response.json({ ok: false, message: `Consulta deste ASIN já está em andamento (lock ativo há ${Math.round(lockAgeMin)} min)` });
        }
      }
    }

    // Marcar como processing
    await base44.asServiceRole.entities.Product.update(product.id, {
      market_price_status: 'processing',
      market_price_last_checked_at: new Date().toISOString(),
    }).catch(() => {});

    const startMs = Date.now();
    let result: { prices: number[]; basis: string; request_id: string } | null = null;
    let providerUsed = '';
    let errorMsg = '';
    let finalStatus = 'failed';

    try {
      // ── Provedor 1: Zinc (somente se retailer BR configurado) ────────────────
      const zincKey = secrets.get('ZINC_API_KEY');
      // zinc_retailer_code_br deve ser configurado manualmente quando suportado
      // Para Amazon Brasil, a Zinc ainda não tem retailer oficial — usar ScrapingBee por padrão
      const zincRetailerBR = ''; // Configurar aqui quando disponível: ex 'amazon_br'
      let triedZinc = false;

      if (zincKey && zincRetailerBR) {
        triedZinc = true;
        try {
          result = await fetchViaZinc(asin, zincRetailerBR, zincKey);
          if (result) providerUsed = 'zinc';
        } catch (e: any) {
          const code = e.message || '';
          if (code === 'unsupported_marketplace') {
            // Fallthrough para ScrapingBee
          } else if (code === 'credit_limit_reached') {
            await base44.asServiceRole.entities.Product.update(product.id, {
              market_price_status: 'credit_limit_reached',
              market_price_error: 'Créditos Zinc esgotados',
            }).catch(() => {});
            return Response.json({ ok: false, status: 'credit_limit_reached', message: 'Créditos Zinc insuficientes' });
          } else if (code === 'rate_limited') {
            await base44.asServiceRole.entities.Product.update(product.id, {
              market_price_status: 'rate_limited',
              market_price_error: 'Rate limit Zinc — tente novamente mais tarde',
              market_price_next_check_at: new Date(Date.now() + (e.retry_after || 60) * 1000).toISOString(),
            }).catch(() => {});
            return Response.json({ ok: false, status: 'rate_limited', message: 'Rate limit Zinc' });
          } else {
            errorMsg = `zinc_error: ${code}`;
            // Fallthrough para ScrapingBee
          }
        }
      }

      // ── Provedor 2: ScrapingBee Pricing (fallback ou padrão para BR) ─────────
      if (!result) {
        const sbKey = secrets.get('SCRAPINGBEE_API_KEY');
        if (!sbKey) {
          await base44.asServiceRole.entities.Product.update(product.id, {
            market_price_status: 'failed',
            market_price_error: 'SCRAPINGBEE_API_KEY não configurada',
          }).catch(() => {});
          return Response.json({
            ok: false,
            status: 'failed',
            message: 'Nenhum provedor configurado. Configure SCRAPINGBEE_API_KEY.',
            missing_secrets: ['SCRAPINGBEE_API_KEY'],
          });
        }

        try {
          result = await fetchViaScrapingBee(asin, sbKey);
          if (result) providerUsed = 'scrapingbee';
        } catch (e: any) {
          const code = e.message || '';
          if (code === 'credit_limit_reached') {
            await base44.asServiceRole.entities.Product.update(product.id, {
              market_price_status: 'credit_limit_reached',
              market_price_error: 'Créditos ScrapingBee esgotados',
            }).catch(() => {});
            return Response.json({ ok: false, status: 'credit_limit_reached', message: 'Créditos ScrapingBee insuficientes' });
          } else if (code === 'rate_limited') {
            await base44.asServiceRole.entities.Product.update(product.id, {
              market_price_status: 'rate_limited',
              market_price_error: 'Rate limit ScrapingBee',
              market_price_next_check_at: new Date(Date.now() + (e.retry_after || 60) * 1000).toISOString(),
            }).catch(() => {});
            return Response.json({ ok: false, status: 'rate_limited', message: 'Rate limit ScrapingBee' });
          }
          errorMsg = `scrapingbee_error: ${code}`;
        }
      }

      // ── Calcular estatísticas ────────────────────────────────────────────────
      const durationMs = Date.now() - startMs;

      if (!result || result.prices.length === 0) {
        finalStatus = 'no_offers';
        await base44.asServiceRole.entities.Product.update(product.id, {
          market_price_status: 'no_offers',
          market_price_last_checked_at: new Date().toISOString(),
          market_price_source: providerUsed || 'none',
          market_price_provider: providerUsed === 'zinc' ? 'Zinc' : providerUsed === 'scrapingbee' ? 'ScrapingBee' : '—',
          market_price_error: errorMsg || null,
          market_price_updated_by: user.id,
        }).catch(() => {});

        return Response.json({
          ok: true,
          status: 'no_offers',
          product_id: product.id,
          asin,
          message: 'Nenhuma oferta válida encontrada para este ASIN',
          duration_ms: durationMs,
        });
      }

      const stats = calcStats(result.prices);
      if (!stats) {
        finalStatus = 'no_offers';
        await base44.asServiceRole.entities.Product.update(product.id, {
          market_price_status: 'no_offers',
          market_price_last_checked_at: new Date().toISOString(),
        }).catch(() => {});
        return Response.json({ ok: false, status: 'no_offers', message: 'Sem ofertas após filtro de qualidade' });
      }

      finalStatus = 'success';

      await base44.asServiceRole.entities.Product.update(product.id, {
        market_price_status: 'success',
        market_price_average: stats.average,
        market_price_minimum: stats.minimum,
        market_price_maximum: stats.maximum,
        market_price_median: stats.median,
        market_price_offer_count: stats.offer_count,
        market_price_excluded_offer_count: stats.excluded_offer_count,
        market_price_currency: 'BRL',
        market_price_source: providerUsed,
        market_price_provider: providerUsed === 'zinc' ? 'Zinc' : 'ScrapingBee',
        market_price_marketplace: 'BR',
        market_price_basis: result.basis,
        market_price_request_id: result.request_id,
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
        provider: providerUsed === 'zinc' ? 'Zinc' : 'ScrapingBee',
        offer_count: stats.offer_count,
        excluded_offer_count: stats.excluded_offer_count,
        average: stats.average,
        minimum: stats.minimum,
        maximum: stats.maximum,
        median: stats.median,
        currency: 'BRL',
        checked_at: new Date().toISOString(),
        duration_ms: Date.now() - startMs,
      });

    } catch (e: any) {
      const sanitizedError = String(e.message || 'erro desconhecido').replace(/Bearer\s+[A-Za-z0-9._-]+/gi, '[REDACTED]');
      // Não sobrescrever preços anteriores ao falhar
      await base44.asServiceRole.entities.Product.update(product.id, {
        market_price_status: 'failed',
        market_price_error: sanitizedError.slice(0, 500),
        market_price_next_check_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        market_price_updated_by: user.id,
      }).catch(() => {});

      return Response.json({
        ok: false,
        status: 'failed',
        product_id: product.id,
        asin,
        error: sanitizedError,
        provider_attempted: providerUsed || 'none',
      }, { status: 500 });
    }

  } catch (error: any) {
    const safe = String(error.message || 'erro').replace(/Bearer\s+[A-Za-z0-9._-]+/gi, '[REDACTED]');
    return Response.json({ error: safe }, { status: 500 });
  }
}