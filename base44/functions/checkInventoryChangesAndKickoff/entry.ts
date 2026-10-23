import { readAllDashboardPages } from '../../shared/dashboardReads.js';
import { availableAdsStock, hasFreshAdsInventory } from '../../shared/stockAdsPolicy.ts';
import { campaignCoverageEligible } from '../../shared/campaignCoverageEligibility.ts';
import { belongsToStockCampaignAlert, planStockCampaignAlertReconciliation } from '../../shared/stockCampaignAlertPolicy.js';
import { resolveProductScope } from '../../shared/skuCampaignScope.ts';
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
  let inventorySyncConfirmed: boolean | null = null;
  let stockGuardConfirmed: boolean | null = null;
  let inventorySyncReused = false;

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
      if (!accounts.length) return Response.json({ ok: false, error: 'Nenhuma conta Amazon conectada.', inventory_sync_confirmed: false, stock_guard_confirmed: false }, { status: 409 });
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
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada.', inventory_sync_confirmed: false, stock_guard_confirmed: false }, { status: 404 });
    const aid = account.id;

    // ── 1. Sincronizar catálogo (inventário atualizado antes de qualquer decisão) ──
    if (!dryRun) {
      const lastInventorySyncAt = Date.parse(String(account.sp_data_last_sync_at || ''));
      const inventoryAgeMs = Date.now() - lastInventorySyncAt;
      const recentlyConfirmed = Number.isFinite(lastInventorySyncAt) && inventoryAgeMs >= 0 && inventoryAgeMs < 10 * 60_000;
      if (recentlyConfirmed) {
        inventorySyncConfirmed = true;
        inventorySyncReused = true;
      } else {
        const sync = await base44.asServiceRole.functions.invoke('syncProductCatalogV2', {
          amazon_account_id: aid, trigger_type: 'inventory_check', _service_role: true,
        });
        inventorySyncConfirmed = sync?.data?.ok === true;
      }
      if (!inventorySyncConfirmed) return Response.json({ ok: false, error: 'Inventário não confirmado; kickoff bloqueado.', inventory_sync_confirmed: false, stock_guard_confirmed: false }, { status: 409 });
      const guard = await base44.asServiceRole.functions.invoke('autoStockCampaignGuard', {
        amazon_account_id: aid, _service_role: true,
      });
      const guardData = guard?.data || guard;
      if (guardData?.ok !== true) {
        stockGuardConfirmed = false;
        const pauseErrors = (guardData?.accounts || []).flatMap((row: any) => row.errors || [])
          .filter((row: any) => row.step === 'pause' && row.asin);
        for (const failure of pauseErrors) {
          await base44.asServiceRole.functions.invoke('upsertOperationalAlert', {
            amazon_account_id: aid,
            alert_type: 'campaign_active_no_stock',
            alert_family: 'campaign',
            severity: 'high',
            entity_type: 'product',
            entity_id: String(failure.sku || failure.asin).toUpperCase(),
            asin: String(failure.asin).toUpperCase(),
            sku: failure.sku ? String(failure.sku).toUpperCase() : undefined,
            title: `Pausa automática pendente: ${String(failure.asin).toUpperCase()}`,
            message: `O estoque FBA foi confirmado como zero, mas a pausa das campanhas não foi confirmada pela Amazon. Erro: ${String(failure.error || 'falha sem detalhe').slice(0, 300)}`,
            data_freshness: 'fresh',
            source_function: 'checkInventoryChangesAndKickoff',
          }).catch((error: any) => console.error('[checkInventoryChangesAndKickoff] failed to persist stock pause alert:', error?.message));
        }
        return Response.json({ ok: false, error: 'Pausas de estoque não confirmadas; kickoff bloqueado.', guard: guardData, inventory_sync_confirmed: true, stock_guard_confirmed: false }, { status: 409 });
      }
      stockGuardConfirmed = true;
    }

    // ── 2. Carregar todos os produtos da conta ────────────────────────────
    const [allProducts, campaigns, kickoffQueue, productAds] = await Promise.all([
      readAllDashboardPages(base44.asServiceRole.entities.Product, { filter: { amazon_account_id: aid } }),
      readAllDashboardPages(base44.asServiceRole.entities.Campaign, { filter: { amazon_account_id: aid } }),
      readAllDashboardPages(base44.asServiceRole.entities.ProductKickoffQueue, { filter: { amazon_account_id: aid } }),
      readAllDashboardPages(base44.asServiceRole.entities.ProductAd, { filter: { amazon_account_id: aid } }),
    ]);

    // ── Índices auxiliares ────────────────────────────────────────────────
    // Campanhas vinculadas por SKU. ASIN sozinho não pode misturar variantes.
    const activeCampaignsBySku = new Map<string, any[]>();
    const pausedCampaignsBySku = new Map<string, any[]>();
    const productsBySku = new Map<string, any[]>();
    for (const product of allProducts) {
      const sku = String(product.sku || '').trim().toUpperCase();
      if (sku) productsBySku.set(sku, [...(productsBySku.get(sku) || []), product]);
    }
    const scopedCampaigns = campaigns.map((campaign: any) => ({
      campaign,
      scope: resolveProductScope(campaign, productAds, allProducts),
    }));
    const ambiguousCampaignAsins = new Set<string>();
    for (const { campaign: c, scope } of scopedCampaigns) {
      const sku = scope.status === 'resolved' ? String(scope.sku || '').toUpperCase() : '';
      if (!sku && scope.asin) ambiguousCampaignAsins.add(String(scope.asin).toUpperCase());
      if (!sku) continue;
      const state = (c.state || c.status || '').toLowerCase();
      if (state === 'archived') continue;
      if (state === 'enabled') {
        if (!activeCampaignsBySku.has(sku)) activeCampaignsBySku.set(sku, []);
        activeCampaignsBySku.get(sku)!.push(c);
      } else if (state === 'paused') {
        if (!pausedCampaignsBySku.has(sku)) pausedCampaignsBySku.set(sku, []);
        pausedCampaignsBySku.get(sku)!.push(c);
      }
    }

    // SKUs já na fila de kick-off (pendente/processing)
    const inQueueSkus = new Set<string>();
    for (const queueItem of kickoffQueue.filter((q: any) => ['scheduled', 'processing'].includes(q.status))) {
      const queueSku = String(queueItem.sku || '').trim().toUpperCase();
      if (queueSku) {
        inQueueSkus.add(queueSku);
        continue;
      }
      const matchingSkus = new Set(allProducts.filter((product: any) =>
        String(product.asin || '').trim().toUpperCase() === String(queueItem.asin || '').trim().toUpperCase()
      ).map((product: any) => String(product.sku || '').trim().toUpperCase()).filter(Boolean));
      if (matchingSkus.size === 1) inQueueSkus.add([...matchingSkus][0]);
    }

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
      campaign_identity_ambiguous: 0,
      skipped: 0,
      errors: [] as string[],
    };

    for (const product of allProducts) {
      const asin = product.asin;
      if (!asin || !product.sku) { stats.skipped++; continue; }
      const skuKey = String(product.sku).trim().toUpperCase();
      if (product.status === 'archived') { stats.skipped++; continue; }

      if (!hasFreshAdsInventory(product) || !campaignCoverageEligible(product)) { stats.skipped++; continue; }
      const qty = availableAdsStock(product);
      const prevQty = Number(product.previous_available_quantity ?? qty);
      const prevStatus = product.previous_inventory_status || product.inventory_status || 'unknown';
      const currentStatus = qty > 0 ? (qty > 5 ? 'in_stock' : 'low_stock') : 'out_of_stock';

      const justRestocked = prevStatus === 'out_of_stock' && qty >= RESTOCK_MIN_QTY;
      const stockChangedSignificantly = prevQty > 0 && Math.abs(qty - prevQty) / prevQty >= STOCK_CHANGE_THRESHOLD;

      const hasActiveCampaign = activeCampaignsBySku.has(skuKey);
      const hasPausedCampaign = pausedCampaignsBySku.has(skuKey);
      const alreadyQueued = inQueueSkus.has(skuKey);

      if (ambiguousCampaignAsins.has(String(asin).toUpperCase())) {
        stats.campaign_identity_ambiguous++;
        stats.skipped++;
        continue;
      }

      // ── CASO 1: Produto novo com estoque, sem campanha ─────────────────
      if (qty > 0 && product.cost_confirmed === true && product.ads_scope_status === 'authorized' && !hasActiveCampaign && !hasPausedCampaign && !alreadyQueued) {
        stats.new_products_found++;
        if (!dryRun) {
          await base44.asServiceRole.entities.ProductKickoffQueue.create({
            amazon_account_id: aid,
            asin,
            sku: product.sku,
            product_name: (product.product_name || product.display_name || asin).slice(0, 200),
            mode: 'auto_only',
            status: 'scheduled',
            queue_hour: inWindow ? getBrtHour() : parseInt(scheduledFor.slice(11, 13)),
            queue_window: inWindow ? 'now' : 'next',
            scheduled_at: inWindow ? nowIso() : scheduledFor,
            attempt_count: 0,
            max_attempts: 5,
          });
          inQueueSkus.add(skuKey);
          stats.kickoffs_queued++;
        }
        continue;
      }

      // ── CASO 2: Reabastecimento — produto voltou do out_of_stock ───────
      if (justRestocked) {
        stats.restocked_found++;

        // autoStockCampaignGuard owns stock-only reactivation, confirmed by Amazon.

        // Reabastecimento é evento histórico, não falha que exija atenção.
        // A fila de kickoff e o guard executam a reativação; evitar abrir um
        // alerta ativo repetido para uma ação que o próprio motor já conduz.

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

    // ── 3. Conciliar pausas automáticas e alertas de estoque ─────────────
    // O guard confirma a pausa na Amazon antes daqui. Mantemos um único alerta
    // acionável apenas se ainda houver campanha ativa; alertas legados são
    // resolvidos depois da pausa confirmada ou quando o estoque retorna.
    let oosCampaignsActive = 0;
    const activeAlerts = await readAllDashboardPages(base44.asServiceRole.entities.Alert, { filter: { amazon_account_id: aid, status: 'active' } });
    for (const [sku, camps] of activeCampaignsBySku.entries()) {
      const skuProducts = productsBySku.get(sku) || [];
      const product = skuProducts.length === 1 ? skuProducts[0] : null;
      if (!product) continue;
      const asin = String(product.asin || '');
      const qty = availableAdsStock(product);
      if (qty === 0 && camps.length > 0) {
        oosCampaignsActive++;
        if (!dryRun) {
          await base44.asServiceRole.functions.invoke('upsertOperationalAlert', {
            amazon_account_id: aid,
            alert_type: 'campaign_active_no_stock',
            alert_family: 'campaign',
            severity: 'high',
            entity_type: 'product',
            entity_id: sku,
            asin: String(asin).toUpperCase(),
            sku,
            title: `Pausa automática pendente: ${String(asin).toUpperCase()}`,
            message: `${product.product_name || asin} ainda tem ${camps.length} campanha(s) ativa(s) após a verificação automática. A pausa precisa ser reconciliada com a Amazon.`,
            details: { active_campaign_ids: camps.map((campaign: any) => campaign.amazon_campaign_id || campaign.campaign_id).filter(Boolean) },
            data_freshness: 'fresh',
            source_function: 'checkInventoryChangesAndKickoff',
          }).catch((error: any) => console.error('[checkInventoryChangesAndKickoff] failed to upsert stock alert:', error?.message));
          stats.alerts_created++;
        }
      }
    }

    if (!dryRun) {
      for (const product of allProducts) {
        const asin = String(product.asin || '').toUpperCase();
        const sku = String(product.sku || '').trim().toUpperCase();
        if (!asin || !sku) continue;
        const quantity = availableAdsStock(product);
        if (quantity < 0) continue; // dado ausente/inválido não autoriza limpar alerta
        const activeCount = quantity === 0 ? (activeCampaignsBySku.get(sku) || []).length : 0;
        const reconciliation = planStockCampaignAlertReconciliation(activeAlerts, {
          asin,
          sku,
          productId: product.id,
          activeCampaignCount: activeCount,
        });
        for (const duplicate of reconciliation.resolve) {
          if (!duplicate.id) continue;
          await base44.asServiceRole.entities.Alert.update(duplicate.id, {
            status: 'resolved',
            resolved_at: nowIso(),
            resolution_reason: activeCount > 0 ? 'duplicate_consolidated' : quantity > 0 ? 'stock_restored' : 'campaigns_paused_by_stock_guard',
            updated_at: nowIso(),
          }).catch(() => {});
        }
        if (activeCount === 0) {
          await base44.asServiceRole.functions.invoke('upsertOperationalAlert', {
            amazon_account_id: aid,
            alert_type: 'campaign_active_no_stock',
            entity_type: 'product',
            entity_id: sku,
            asin,
            sku,
            title: '-',
            message: '-',
            resolved: true,
            resolution_reason: quantity > 0 ? 'stock_restored' : 'campaigns_paused_by_stock_guard',
            source_function: 'checkInventoryChangesAndKickoff',
          }).catch(() => {});
        }
      }
    }

    const kickoffExecution = dryRun ? { ok: true, skipped: true } :
      (await base44.asServiceRole.functions.invoke('processProductKickoffQueueV2', {
        amazon_account_id: aid, _service_role: true,
      }))?.data;

    return Response.json({
      ok: kickoffExecution?.ok === true && !(kickoffExecution?.results || []).some((r: any) => r.ok === false),
      inventory_sync_confirmed: dryRun ? null : inventorySyncConfirmed,
      inventory_sync_reused: inventorySyncReused,
      stock_guard_confirmed: dryRun ? null : stockGuardConfirmed,
      kickoff_execution: kickoffExecution,
      dry_run: dryRun,
      source_pagination_complete: true,
      source_counts: { products: allProducts.length, campaigns: campaigns.length, product_ads: productAds.length, kickoff_queue: kickoffQueue.length, active_alerts: activeAlerts.length },
      in_amazon_window: inWindow,
      scheduled_for: inWindow ? 'now' : scheduledFor,
      stats: { ...stats, oos_with_active_campaign: oosCampaignsActive },
    });

  } catch (error: any) {
    console.error('[checkInventoryChangesAndKickoff]', error.message);
    return Response.json({ ok: false, error: error.message, inventory_sync_confirmed: inventorySyncConfirmed === true, stock_guard_confirmed: false, source_pagination_complete: false }, { status: 500 });
  }
});
