import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function currentBrazilHour() {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === 'hour')?.value || 0);
}

function due(item: any) {
  if (!item?.scheduled_at) return true;
  const timestamp = new Date(item.scheduled_at).getTime();
  return Number.isNaN(timestamp) || timestamp <= Date.now();
}

function errorText(data: any) {
  const value = data?.errors?.[0]?.message
    || data?.error?.message
    || data?.error_description
    || data?.error
    || data?.message
    || 'Falha no Kick-off';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function stockQuantity(product: any) {
  return Number(product?.fba_inventory ?? product?.available_quantity ?? product?.fulfillable_quantity ?? 0);
}

function isOutOfStock(product: any) {
  return !product || product?.inventory_status === 'out_of_stock' || stockQuantity(product) <= 0;
}

function classify(data: any) {
  const text = errorText(data).toLowerCase();
  const status = Number(data?.status || data?.statusCode || 0);
  const outOfStock = data?.reason === 'out_of_stock'
    || text.includes('sem estoque')
    || text.includes('out_of_stock')
    || text.includes('out of stock')
    || text.includes('inventory unavailable');
  const duplicate = status === 409 || text.includes('duplicate') || text.includes('already exists') || text.includes('já existe');
  const auth = status === 401 || status === 403 || text.includes('unauthorized') || text.includes('forbidden');
  const timeout = status === 524 || status === 504 || text.includes('524') || text.includes('504') || text.includes('timeout') || text.includes('time limit');
  const throttled = status === 429 || text.includes('rate limit') || text.includes('throttl');
  const malformed = text.includes('start of structure or map found where not expected');
  return { text, status, outOfStock, duplicate, auth, timeout, throttled, malformed };
}

async function setWaitingStock(base44: any, item: any, product: any, reason = 'Produto sem estoque confirmado pela SP-API') {
  await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id, {
    status: 'waiting_stock',
    started_at: null,
    completed_at: null,
    scheduled_at: null,
    last_error: reason,
    waiting_stock_since: item.waiting_stock_since || new Date().toISOString(),
    stock_quantity_at_wait: stockQuantity(product),
  }).catch(() => {});
}

async function cleanupQueue(base44: any, accountId?: string) {
  const statuses = ['scheduled', 'failed', 'processing', 'waiting_stock'];
  const rows: any[] = [];
  for (const status of statuses) {
    const found = await base44.asServiceRole.entities.ProductKickoffQueue.filter({
      ...(accountId ? { amazon_account_id: accountId } : {}),
      status,
    }, '-scheduled_at', 500).catch(() => []);
    rows.push(...found);
  }

  const productCache = new Map<string, any>();
  let waitingStock = 0;
  let resumedFromStock = 0;
  let unlocked = 0;
  let duplicatesRemoved = 0;
  const seen = new Set<string>();

  for (const item of rows) {
    const key = `${item.amazon_account_id}|${item.asin}|${item.mode}|${String(item.keyword || '').trim().toLowerCase()}`;
    if (seen.has(key) && item.status !== 'processing') {
      await base44.asServiceRole.entities.ProductKickoffQueue.delete(item.id).catch(() => {});
      duplicatesRemoved++;
      continue;
    }
    seen.add(key);

    const productKey = `${item.amazon_account_id}|${item.asin}`;
    if (!productCache.has(productKey)) {
      const products = await base44.asServiceRole.entities.Product.filter({
        amazon_account_id: item.amazon_account_id,
        asin: item.asin,
      }, '-updated_at', 1).catch(() => []);
      productCache.set(productKey, products[0] || null);
    }
    const product = productCache.get(productKey);

    if (isOutOfStock(product)) {
      if (item.status !== 'waiting_stock') {
        await setWaitingStock(base44, item, product);
        waitingStock++;
      }
      continue;
    }

    if (item.status === 'waiting_stock') {
      await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id, {
        status: 'scheduled',
        scheduled_at: new Date().toISOString(),
        started_at: null,
        completed_at: null,
        last_error: null,
        stock_restored_at: new Date().toISOString(),
      }).catch(() => {});
      resumedFromStock++;
      continue;
    }

    if (item.status === 'processing') {
      const started = new Date(item.started_at || item.updated_at || item.created_at || 0).getTime();
      if (!started || Date.now() - started > 20 * 60 * 1000) {
        await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id, {
          status: 'scheduled',
          scheduled_at: new Date().toISOString(),
          started_at: null,
          last_error: 'Lock antigo liberado automaticamente',
        }).catch(() => {});
        unlocked++;
      }
    }
  }

  return {
    waiting_stock: waitingStock,
    resumed_from_stock: resumedFromStock,
    unlocked,
    duplicates_removed: duplicatesRemoved,
  };
}

Deno.serve(async (request) => {
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    if (!body._service_role) return Response.json({ ok: false, error: 'Uso interno' }, { status: 403 });

    const hour = Number(body.hour ?? currentBrazilHour());
    const forceRun = body.force === true || body._service_role === true;
    if (!forceRun && ![0, 1, 2, 3, 13].includes(hour)) {
      return Response.json({ ok: true, skipped: true, reason: 'Fora da janela Amazon', hour });
    }

    const cleanup = await cleanupQueue(base44, body.amazon_account_id);
    const queue = (await base44.asServiceRole.entities.ProductKickoffQueue.filter({
      ...(body.amazon_account_id ? { amazon_account_id: body.amazon_account_id } : {}),
      status: 'scheduled',
    }, 'scheduled_at', 50).catch(() => [])).filter(due).slice(0, 2);

    const results: any[] = [];

    for (const item of queue) {
      const products = await base44.asServiceRole.entities.Product.filter({
        amazon_account_id: item.amazon_account_id,
        asin: item.asin,
      }, '-updated_at', 1).catch(() => []);
      const product = products[0];

      if (isOutOfStock(product)) {
        await setWaitingStock(base44, item, product);
        results.push({ id: item.id, asin: item.asin, ok: true, waiting_stock: true, reason: 'out_of_stock' });
        continue;
      }

      // ── Guard de escopo: bloquear kickoff para produtos não autorizados ──
      const scopeStatus = product?.ads_scope_status || 'not_authorized';
      const eligStatus = product?.ads_eligibility_status || 'unknown';
      if (scopeStatus !== 'authorized' || eligStatus !== 'eligible') {
        await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id, {
          status: scopeStatus !== 'authorized' ? 'cancelled' : 'waiting_stock',
          last_error: `Kickoff bloqueado: ads_scope_status=${scopeStatus}, ads_eligibility_status=${eligStatus}`,
          scheduled_at: null,
        }).catch(() => {});
        results.push({ id: item.id, asin: item.asin, ok: false, blocked: true, reason: `scope=${scopeStatus} eligibility=${eligStatus}` });
        continue;
      }

      const attempts = Number(item.attempt_count || 0) + 1;
      await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id, {
        status: 'processing',
        started_at: new Date().toISOString(),
        attempt_count: attempts,
        last_error: null,
      });

      try {
        const response = item.mode === 'manual_only'
          ? await base44.asServiceRole.functions.invoke('createManualCampaignV2', {
              amazon_account_id: item.amazon_account_id,
              asin: item.asin,
              sku: item.sku || product?.sku || null,
              product_name: item.product_name || product?.product_name || item.asin,
              keyword: item.keyword,
              bid: 0.5,
              budget: 5,
              _window_execution: true,
              _service_role: true,
            })
          : await base44.asServiceRole.functions.invoke('autoKickoffProductV2', {
              amazon_account_id: item.amazon_account_id,
              asin: item.asin,
              sku: item.sku || product?.sku || null,
              product_name: item.product_name || product?.product_name || item.asin,
              max_keywords: 4,
              minimum_ai_confidence: 0.90,
              _window_execution: true,
              _service_role: true,
            });

        const data = response?.data || response || {};
        const flags = classify(data);
        const success = data?.ok === true || (flags.duplicate && data?.already_exists === true);

        if (flags.outOfStock) {
          await setWaitingStock(base44, item, product, errorText(data).slice(0, 500));
          results.push({ id: item.id, asin: item.asin, ok: true, waiting_stock: true, reason: 'out_of_stock' });
          continue;
        }

        if (success || flags.duplicate) {
          await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id, {
            status: 'completed',
            completed_at: new Date().toISOString(),
            started_at: null,
            last_error: null,
          });
          results.push({ id: item.id, asin: item.asin, ok: true, duplicate_resolved: flags.duplicate, response: data });
          continue;
        }

        const retryable = Boolean(data?.retryable || flags.auth || flags.timeout || flags.throttled || flags.malformed);
        const maxAttempts = Number(item.max_attempts || 5);
        const retry = retryable && attempts < maxAttempts;
        const backoffMs = flags.auth ? 10 * 60000 : flags.timeout ? 15 * 60000 : flags.throttled ? 5 * 60000 : flags.malformed ? 2 * 60000 : 60000;

        await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id, {
          status: retry ? 'scheduled' : 'failed',
          completed_at: retry ? null : new Date().toISOString(),
          started_at: null,
          scheduled_at: retry ? new Date(Date.now() + backoffMs).toISOString() : item.scheduled_at,
          last_error: errorText(data).slice(0, 500),
        });

        results.push({ id: item.id, asin: item.asin, ok: false, retry_scheduled: retry, retry_in_seconds: retry ? Math.round(backoffMs / 1000) : 0, response: data });
      } catch (error) {
        const text = String(error?.message || error);
        const flags = classify({ error: text });

        if (flags.outOfStock) {
          await setWaitingStock(base44, item, product, text.slice(0, 500));
          results.push({ id: item.id, asin: item.asin, ok: true, waiting_stock: true, reason: 'out_of_stock' });
          continue;
        }

        const maxAttempts = Number(item.max_attempts || 5);
        const retry = attempts < maxAttempts;
        const backoffMs = flags.timeout ? 15 * 60000 : flags.malformed ? 2 * 60000 : 5 * 60000;

        await base44.asServiceRole.entities.ProductKickoffQueue.update(item.id, {
          status: retry ? 'scheduled' : 'failed',
          scheduled_at: retry ? new Date(Date.now() + backoffMs).toISOString() : item.scheduled_at,
          completed_at: retry ? null : new Date().toISOString(),
          started_at: null,
          last_error: text.slice(0, 500),
        });
        results.push({ id: item.id, asin: item.asin, ok: false, retry_scheduled: retry, error: text });
      }

      await wait(15000);
    }

    for (const accountId of [...new Set(queue.map((item: any) => item.amazon_account_id))]) {
      await base44.asServiceRole.functions.invoke('syncAds', {
        amazon_account_id: accountId,
        trigger_type: 'post_kickoff_queue',
        _service_role: true,
      }).catch(() => null);
      await base44.asServiceRole.functions.invoke('fixProductCampaignLinks', {
        amazon_account_id: accountId,
        _service_role: true,
      }).catch(() => null);
    }

    return Response.json({ ok: true, processed: results.length, batch_size: 2, spacing_seconds: 15, cleanup, results });
  } catch (error) {
    return Response.json({ ok: false, error: error?.message || 'Erro ao processar fila de Kick-off V2' }, { status: 500 });
  }
});