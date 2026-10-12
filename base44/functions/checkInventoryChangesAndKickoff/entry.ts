import { availableAdsStock, hasFreshAdsInventory } from '../../shared/stockAdsPolicy.ts';
import { campaignCoverageEligible } from '../../shared/campaignCoverageEligibility.ts';
import { belongsToStockCampaignAlert, planStockCampaignAlertReconciliation } from '../../shared/stockCampaignAlertPolicy.js';
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
      const guardData = guard?.data || guard;
      if (guardData?.ok !== true) {
        const pauseErrors = (guardData?.accounts || []).flatMap((row: any) => row.errors || [])
          .filter((row: any) => row.step === 'pause' && row.asin);
        for (const failure of pauseErrors) {
          await base44.asServiceRole.functions.invoke('upsertOperationalAlert', {
            amazon_account_id: aid,
            alert_type: 'campaign_active_no_stock',
            alert_family: 'campaign',
            severity: 'high',
            entity_type: 'product',
            entity_id: String(failure.asin).toUpperCase(),
            asin: String(failure.asin).toUpperCase(),
            title: `Pausa automática pendente: ${String(failure.asin).toUpperCase()}`,
            message: `O estoque FBA foi confirmado como zero, mas a pausa das campanhas não foi confirmada pela Amazon. Erro: ${String(failure.error || 'falha sem detalhe').slice(0, 300)}`,
            data_freshness: 'fresh',
            source_function: 'checkInventoryChangesAndKickoff',
          }).catch((error: any) => console.error('[checkInventoryChangesAndKickoff] failed to persist stock pause alert:', error?.message));
        }
        return Response.json({ ok: false, error: 'Pausas de estoque não confirmadas; kickoff bloqueado.', guard: guardData }, { status: 409 });
      }
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
      const asin = String(c.asin || '').toUpperCase();
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
    const activeAlerts = await base44.asServiceRole.entities.Alert.filter(
      { amazon_account_id: aid, status: 'active' }, '-created_at', 1000
    ).catch(() => []);
    const accountProducts = new Map<string, any>();
    for (const product of allProducts) {
      if (!product.asin) continue;
      const asin = String(product.asin).toUpperCase();
      const existing = accountProducts.get(asin);
      const freshness = Date.parse(product.last_catalog_sync_at || product.updated_at || product.updated_date || 0) || 0;
      const existingFreshness = Date.parse(existing?.last_catalog_sync_at || existing?.updated_at || existing?.updated_date || 0) || 0;
      if (!existing || freshness > existingFreshness) accountProducts.set(asin, product);
    }
    for (const [asin, camps] of activeCampaignsByAsin.entries()) {
      const product = accountProducts.get(String(asin).toUpperCase());
      if (!product) continue;
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
            entity_id: String(asin).toUpperCase(),
            asin: String(asin).toUpperCase(),
            sku: product.sku,
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
        if (!asin) continue;
        const quantity = availableAdsStock(product);
        if (quantity < 0) continue; // dado ausente/inválido não autoriza limpar alerta
        const activeCount = quantity === 0 ? (activeCampaignsByAsin.get(asin) || []).length : 0;
        const reconciliation = planStockCampaignAlertReconciliation(activeAlerts, {
          asin,
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
            entity_id: asin,
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
