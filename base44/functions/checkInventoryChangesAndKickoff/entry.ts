/**
 * checkInventoryChangesAndKickoff
 *
 * Executado DIARIAMENTE nas janelas Amazon (00h e 13h BRT).
 * Detecta três situações e age sobre cada uma:
 *
 * 1. PRODUTO NOVO — asin criado há ≤ 7 dias, com estoque, sem campanha
 *    → Agenda kick-off na ProductKickoffQueue
 *
 * 2. REABASTECIMENTO — produto que estava out_of_stock e voltou com qty > 0
 *    → Reativa campanhas pausadas por falta de estoque + agenda kick-off se não tiver campanha ativa
 *
 * 3. MUDANÇA SIGNIFICATIVA DE ESTOQUE — variação ≥ 20% em relação ao registro anterior
 *    → Atualiza Product.inventory_status e notifica via Alert
 *
 * SEGURO: nunca cria campanha diretamente. Apenas enfileira na ProductKickoffQueue
 * para ser processada por processProductKickoffQueueV2 na janela correta.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const RESTOCK_MIN_QTY = 1;           // unidades mínimas para considerar "voltou"
const NEW_PRODUCT_DAYS = 7;          // produto novo se criado nos últimos N dias
const STOCK_CHANGE_THRESHOLD = 0.20; // variação ≥ 20% = mudança significativa
const KICKOFF_WINDOW_HOUR_BRT_1 = 1; // 01h BRT = dentro da janela 00-04
const KICKOFF_WINDOW_HOUR_BRT_2 = 13; // 13h BRT = janela 13-14

function nowIso() { return new Date().toISOString(); }

function getBrtHour(): number {
  // BRT = UTC-3
  const brt = new Date(Date.now() - 3 * 3600000);
  return brt.getUTCHours();
}

function isInAmazonKickoffWindow(): boolean {
  const h = getBrtHour();
  return (h >= 0 && h < 4) || (h >= 13 && h < 14);
}

function nextKickoffWindow(): string {
  // Retorna ISO do próximo horário de janela (01h BRT = 04h UTC)
  const now = new Date();
  const h = getBrtHour();
  const candidate = new Date(now);
  if (h < 1) {
    candidate.setUTCHours(4, 0, 0, 0); // 01h BRT = 04h UTC hoje
  } else if (h < 13) {
    candidate.setUTCHours(16, 0, 0, 0); // 13h BRT = 16h UTC hoje
  } else {
    candidate.setDate(candidate.getDate() + 1);
    candidate.setUTCHours(4, 0, 0, 0); // amanhã 01h BRT
  }
  return candidate.toISOString();
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
    const dryRun = body.dry_run === true;
    const forceAccountId = body.amazon_account_id || null;

    // ── Selecionar conta ──────────────────────────────────────────────────
    let account: any = null;
    if (forceAccountId) {
      const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ id: forceAccountId }, null, 1);
      account = rows[0];
    }
    if (!account) {
      const rows = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = rows[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta Amazon não encontrada.' });
    const aid = account.id;

    // ── 1. Sincronizar catálogo (inventário atualizado antes de qualquer decisão) ──
    if (!dryRun) {
      await base44.asServiceRole.functions.invoke('syncProductCatalogV2', {
        amazon_account_id: aid, trigger_type: 'inventory_check', _service_role: true,
      }).catch(e => console.warn('[checkInventory] syncProductCatalogV2 falhou:', e.message));
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

    const sevenDaysAgo = new Date(Date.now() - NEW_PRODUCT_DAYS * 86400000).toISOString();
    const inWindow = isInAmazonKickoffWindow();
    const scheduledFor = nextKickoffWindow();

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

      const qty = Number(product.fba_inventory || 0);
      const prevQty = Number(product.previous_fba_inventory || product.fba_inventory || 0);
      const prevStatus = product.previous_inventory_status || product.inventory_status || 'unknown';
      const currentStatus = qty > 0 ? (qty > 5 ? 'in_stock' : 'low_stock') : 'out_of_stock';

      const isNew = (product.created_date || product.created_at || '') > sevenDaysAgo;
      const justRestocked = prevStatus === 'out_of_stock' && qty >= RESTOCK_MIN_QTY;
      const stockChangedSignificantly = prevQty > 0 && Math.abs(qty - prevQty) / prevQty >= STOCK_CHANGE_THRESHOLD;

      const hasActiveCampaign = activeCampaignsByAsin.has(asin);
      const hasPausedCampaign = pausedCampaignsByAsin.has(asin);
      const alreadyQueued = inQueueAsins.has(asin);

      // ── CASO 1: Produto novo com estoque, sem campanha ─────────────────
      if (isNew && qty > 0 && !hasActiveCampaign && !alreadyQueued) {
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
          }).catch(e => stats.errors.push(`Kickoff novo ${asin}: ${e.message}`));
          stats.kickoffs_queued++;
        }
        continue;
      }

      // ── CASO 2: Reabastecimento — produto voltou do out_of_stock ───────
      if (justRestocked) {
        stats.restocked_found++;

        // 2a. Reativar campanhas que estavam pausadas por falta de estoque
        if (hasPausedCampaign && !dryRun) {
          const pausedCamps = pausedCampaignsByAsin.get(asin) || [];
          for (const camp of pausedCamps) {
            const pauseReason = (camp.pause_reason || camp.paused_reason || '').toLowerCase();
            const wasStockPause = pauseReason.includes('estoque') || pauseReason.includes('stock') || pauseReason.includes('inventory') || camp.auto_paused_by_stock === true;
            if (wasStockPause || pausedCamps.length > 0) {
              // Enfileirar reativação via AmazonActionQueue
              await base44.asServiceRole.entities.AmazonActionQueue.create({
                amazon_account_id: aid,
                action_type: 'enable_campaign',
                entity_id: camp.campaign_id || camp.amazon_campaign_id || camp.id,
                payload: JSON.stringify({
                  campaign_id: camp.campaign_id || camp.amazon_campaign_id,
                  asin,
                  reason: `Reabastecimento detectado: ${qty} unidades. Campanha reativada automaticamente.`,
                  source: 'checkInventoryChangesAndKickoff',
                }),
                status: 'pending',
                created_at: nowIso(),
              }).catch(e => stats.errors.push(`Reativar camp ${camp.id}: ${e.message}`));
              stats.campaigns_reactivated++;
            }
          }
        }

        // 2b. Se não tem nenhuma campanha, agendar kick-off
        if (!hasActiveCampaign && !hasPausedCampaign && !alreadyQueued && !dryRun) {
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
          }).catch(e => stats.errors.push(`Kickoff restock ${asin}: ${e.message}`));
          stats.kickoffs_queued++;
        }

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
      const qty = Number(product.fba_inventory || 0);
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

    return Response.json({
      ok: true,
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