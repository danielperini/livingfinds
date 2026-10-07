import { availableAdsStock, hasFreshAdsInventory } from '../../shared/stockAdsPolicy.ts';
import { campaignCoverageEligible } from '../../shared/campaignCoverageEligibility.ts';
/** Synchronize sellable stock, enforce stock pauses and process due kickoff jobs immediately. */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const RESTOCK_MIN_QTY = 1;           // unidades mínimas para considerar "voltou"
const STOCK_CHANGE_THRESHOLD = 0.20; // variação ≥ 20% = mudança significativa
function nowIso() { return new Date().toISOString(); }

function getBrtHour(): number {
  // BRT = UTC-3
  const brt = new Date(Date.now() - 3 * 3600000);
  return brt.getUTCHours();
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);

  try {
    // Auth — aceita automação (service role) ou usuário autenticado
    let userId: string | null = null;
    try {
      const user = await base44.auth.me();
      userId = user?.id || null;
    } catch { /* automação */ }

    const body = await req.json().catch(() => ({}));
    if (!userId && body._service_role !== true) return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    const dryRun = body.dry_run === true;
    const forceAccountId = body.amazon_account_id || null;

    if (!forceAccountId) {
      const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' });
      const results = [];
      for (const account of accounts) {
        const result = await base44.asServiceRole.functions.invoke('checkInventoryChangesAndKickoff', {
          ...body, amazon_account_id: account.id, _service_role: true,
        });
        results.push({ account_id: account.id, ...result.data });
      }
      return Response.json({ ok: results.every(r => r.ok === true), accounts: results });
    }
    const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ id: forceAccountId }, null, 1);
    const account = rows[0];
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada.' }, { status: 404 });
    const aid = account.id;

    // ── 1. Sincronizar catálogo (inventário atualizado antes de qualquer decisão) ──
    if (!dryRun) {
      const sync = await base44.asServiceRole.functions.invoke('syncProductCatalogV2', {
        amazon_account_id: aid, trigger_type: 'inventory_check', _service_role: true,
      });
      if (sync?.data?.ok !== true) return Response.json({ ok: false, error: 'Inventário não confirmado; kickoff bloqueado.' }, { status: 409 });
      const guard = await base44.asServiceRole.functions.invoke('autoStockCampaignGuard', {
        amazon_account_id: aid, _service_role: true,
      });
      if (guard?.data?.ok !== true) return Response.json({ ok: false, error: 'Pausas de estoque não confirmadas; kickoff bloqueado.' }, { status: 409 });
    }

    // ── 2. Carregar todos os produtos da conta ────────────────────────────
    const [allProducts, campaigns, kickoffQueue] = await Promise.all([
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, '-updated_date', 500),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 300),
      base44.asServiceRole.entities.ProductKickoffQueue.filter(
        { amazon_account_id: aid }, '-created_date', 100
      ).catch(() => []),
    ]);

    // ── Índices auxiliares ────────────────────────────────────────────────
    // Campanhas ativas por ASIN
    const activeCampaignsByAsin = new Map<string, any[]>();
    const pausedCampaignsByAsin = new Map<string, any[]>();
    for (const c of campaigns) {
      const asin = c.asin;
      if (!asin) continue;
      const state = (c.state || c.status || '').toLowerCase();
      if (state === 'archived') continue;
      if (state === 'enabled') {
        if (!activeCampaignsByAsin.has(asin)) activeCampaignsByAsin.set(asin, []);
        activeCampaignsByAsin.get(asin)!.push(c);
      } else if (state === 'paused') {
        if (!pausedCampaignsByAsin.has(asin)) pausedCampaignsByAsin.set(asin, []);
        pausedCampaignsByAsin.get(asin)!.push(c);
      }
    }

    // ASINs já na fila de kick-off (pendente/processing)
    const inQueueAsins = new Set(
      kickoffQueue
        .filter((q: any) => ['scheduled', 'processing'].includes(q.status))
        .map((q: any) => q.asin)
    );

    const inWindow = true; // Fresh inventory launches without a time-of-day wait.
    const scheduledFor = nowIso();

    const stats = {
      total_scanned: allProducts.length,
      new_products_found: 0,
      restocked_found: 0,
      stock_changed: 0,
      kickoffs_queued: 0,
      campaigns_reactivated: 0,
      alerts_created: 0,
      skipped: 0,
      errors: [] as string[],
    };

    for (const product of allProducts) {
      const asin = product.asin;
      if (!asin || !product.sku) { stats.skipped++; continue; }
      if (product.status === 'archived') { stats.skipped++; continue; }

      if (!hasFreshAdsInventory(product) || !campaignCoverageEligible(product)) { stats.skipped++; continue; }
      const qty = availableAdsStock(product);
      const prevQty = Number(product.previous_available_quantity ?? qty);
      const prevStatus = product.previous_inventory_status || product.inventory_status || 'unknown';
      const currentStatus = qty > 0 ? (qty > 5 ? 'in_stock' : 'low_stock') : 'out_of_stock';

      const justRestocked = prevStatus === 'out_of_stock' && qty >= RESTOCK_MIN_QTY;
      const stockChangedSignificantly = prevQty > 0 && Math.abs(qty - prevQty) / prevQty >= STOCK_CHANGE_THRESHOLD;

      const hasActiveCampaign = activeCampaignsByAsin.has(asin);
      const hasPausedCampaign = pausedCampaignsByAsin.has(asin);
      const alreadyQueued = inQueueAsins.has(asin);

      // ── CASO 1: Produto novo com estoque, sem campanha ─────────────────
      if (qty > 0 && product.cost_confirmed === true && product.ads_scope_status === 'authorized' && !hasActiveCampaign && !hasPausedCampaign && !alreadyQueued) {
        stats.new_products_found++;
        if (!dryRun) {
          await base44.asServiceRole.entities.ProductKickoffQueue.create({
            amazon_account_id: aid,
            asin,
            sku: product.sku,
            product_name: (product.product_name || product.display_name || asin).slice(0, 200),
            mode: 'auto_plus_four',
            status: 'scheduled',
            queue_hour: inWindow ? getBrtHour() : parseInt(scheduledFor.slice(11, 13)),
            queue_window: inWindow ? 'now' : 'next',
            scheduled_at: inWindow ? nowIso() : scheduledFor,
            attempt_count: 0,
            max_attempts: 5,
          });
          inQueueAsins.add(asin);
          stats.kickoffs_queued++;
        }
        continue;
      }

      // ── CASO 2: Reabastecimento — produto voltou do out_of_stock ───────
      if (justRestocked) {
        stats.restocked_found++;

        // autoStockCampaignGuard owns stock-only reactivation, confirmed by Amazon.

        // 2c. Criar alerta de reabastecimento
        if (!dryRun) {
          await base44.asServiceRole.entities.Alert.create({
            amazon_account_id: aid,
            type: 'restock_detected',
            severity: 'info',
            title: `Reabastecimento detectado: ${asin}`,
            message: `Produto ${product.product_name || asin} voltou ao estoque com ${qty} unidades. ${!hasActiveCampaign && !hasPausedCampaign ? 'Kick-off agendado.' : hasPausedCampaign ? 'Campanhas sendo reativadas.' : 'Campanhas já ativas.'}`,
            entity_id: product.id,
            entity_type: 'product',
            status: 'active',
            created_at: nowIso(),
          }).catch(() => {});
          stats.alerts_created++;
        }

        // Atualizar previous_inventory_status para não disparar novamente amanhã
        if (!dryRun) {
          await base44.asServiceRole.entities.Product.update(product.id, {
            previous_inventory_status: currentStatus,
            previous_fba_inventory: qty,
          }).catch(() => {});
        }
        continue;
      }

      // ── CASO 3: Mudança significativa de estoque ────────────────────────
      if (stockChangedSignificantly && !dryRun) {
        stats.stock_changed++;
        await base44.asServiceRole.entities.Product.update(product.id, {
          previous_fba_inventory: qty,
          previous_inventory_status: currentStatus,
        }).catch(() => {});

        // Alerta apenas se mudança for relevante (queda ≥ 50% ou saiu do low_stock para out_of_stock)
        const bigDrop = qty < prevQty && (prevQty - qty) / prevQty >= 0.5;
        const wentOos = qty === 0 && prevQty > 0;
        if (bigDrop || wentOos) {
          await base44.asServiceRole.entities.Alert.create({
            amazon_account_id: aid,
            type: wentOos ? 'out_of_stock' : 'stock_drop',
            severity: wentOos ? 'critical' : 'warning',
            title: wentOos ? `SEM ESTOQUE: ${asin}` : `Queda de estoque: ${asin}`,
            message: `${product.product_name || asin}: estoque ${wentOos ? 'zerou' : `caiu de ${prevQty} para ${qty} unidades (${Math.round((prevQty - qty) / prevQty * 100)}%)`}.`,
            entity_id: product.id,
            entity_type: 'product',
            status: 'active',
            created_at: nowIso(),
          }).catch(() => {});
          stats.alerts_created++;
        }
        continue;
      }

      // Atualizar snapshot de inventário se mudou status
      if (currentStatus !== prevStatus && !dryRun) {
        await base44.asServiceRole.entities.Product.update(product.id, {
          previous_inventory_status: currentStatus,
          previous_fba_inventory: qty,
        }).catch(() => {});
      }
    }

    // ── 3. Verificar produtos com campanha ativa mas SEM estoque ─────────
    // (não lança alert novo se já tem um ativo nos últimos 6h)
    let oosCampaignsActive = 0;
    for (const [asin, camps] of activeCampaignsByAsin.entries()) {
      const product = allProducts.find((p: any) => p.asin === asin);
      if (!product) continue;
      const qty = availableAdsStock(product);
      if (qty === 0 && camps.length > 0) {
        oosCampaignsActive++;
        if (!dryRun) {
          await base44.asServiceRole.entities.Alert.create({
            amazon_account_id: aid,
            type: 'campaign_active_no_stock',
            severity: 'warning',
            title: `Campanha ativa sem estoque: ${asin}`,
            message: `${product.product_name || asin} tem ${camps.length} campanha(s) ativa(s) mas estoque = 0. Risco de gasto sem conversão.`,
            entity_id: product.id,
            entity_type: 'product',
            status: 'active',
            created_at: nowIso(),
          }).catch(() => {});
          stats.alerts_created++;
        }
      }
    }

    const kickoffExecution = dryRun ? { ok: true, skipped: true } :
      (await base44.asServiceRole.functions.invoke('processProductKickoffQueueV2', {
        amazon_account_id: aid, _service_role: true,
      }))?.data;

    return Response.json({
      ok: kickoffExecution?.ok === true && !(kickoffExecution?.results || []).some((r: any) => r.ok === false),
      kickoff_execution: kickoffExecution,
      dry_run: dryRun,
      in_amazon_window: inWindow,
      scheduled_for: inWindow ? 'now' : scheduledFor,
      stats: { ...stats, oos_with_active_campaign: oosCampaignsActive },
    });

  } catch (error: any) {
    console.error('[checkInventoryChangesAndKickoff]', error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});