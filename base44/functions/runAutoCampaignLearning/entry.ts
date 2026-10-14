/**
 * runAutoCampaignLearning — Motor Determinístico de Jornada de Aprendizado das Campanhas AUTO
 *
 * Implementa a jornada completa:
 *   1. Detecta campanhas AUTO novas (bid inicial R$0,50)
 *   2. Primeira análise após 24h confirmadas
 *   3. Ajuste de bid sem gasto: +R$0,10 / +R$0,05 progressivo
 *   4. Campanha gastando: redução gradual R$0,05/dia baseada em CPC real
 *   5. Perda de entrega após redução: recuperação +R$0,10
 *   6. Deixa promoção e negativação para o fluxo canônico, que exige pelo
 *      menos três pedidos same-SKU, consulta literal e margem positiva.
 *
 * REGRA FINANCEIRA: sem IA para cálculos. Nenhuma keyword é criada por este
 * fluxo; os termos reais passam pelo harvest same-SKU canônico.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
import { inventoryDecisionPreflight } from '../../shared/inventorySyncPolicy.ts';
import { availableAdsStock, hasFreshAdsInventory } from '../../shared/stockAdsPolicy.ts';
import { campaignCoverageEligible } from '../../shared/campaignCoverageEligibility.ts';

const INITIAL_BID = 0.50;
const INCREASE_NO_SPEND_1 = 0.10;
const INCREASE_NO_SPEND_2 = 0.05;
const REDUCE_LOW_CPC = 0.05;
const RECOVER_DELIVERY = 0.10;
const DEFAULT_BID_CEILING = 3.00;
const MIN_BID = 0.10;

function hoursAgo(dateStr: string): number {
  if (!dateStr) return 9999;
  return (Date.now() - new Date(dateStr).getTime()) / 3600000;
}

function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * 3600000).toISOString();
}

async function loadPage(entity: any, filter: object, sort: string, limit: number, offset: number): Promise<any[]> {
  return entity.filter(filter, sort, limit, offset);
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  const base44 = createClientFromRequest(req);
  const now = new Date().toISOString();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

  try {
    const body = await req.json().catch(() => ({}));

    // Resolver conta
    let account: any = null;
    const aid: string = body.amazon_account_id || '';
    if (aid) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: aid });
      account = accs[0] || null;
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
    }
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon conectada.' });
    const amazonAccountId = account.id;
    const sym = account.currency_symbol || 'R$';

    const inventory = await base44.asServiceRole.functions.invoke('checkInventoryChangesAndKickoff', {
      _service_role: true, amazon_account_id: amazonAccountId,
      dry_run: body.dry_run === true, trigger_type: 'auto_campaign_learning_inventory_preflight',
    }).then((r: any) => r?.data || r).catch((error: any) => ({ ok: false, error: error?.message || String(error) }));
    const inventoryPreflight = inventoryDecisionPreflight(inventory, body.dry_run === true);
    if (!inventoryPreflight.allowed) {
      return Response.json({ ok: false, blocked: true, inventory_preflight: inventoryPreflight, inventory }, { status: 409 });
    }

    // Carregar configuração
    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: amazonAccountId });
    const cfg = configs[0] || {};
    const TARGET_ACOS = Number(cfg.target_acos ?? 25);
    const MAX_BID_CFG = cfg.max_bid || DEFAULT_BID_CEILING;
    const MIN_BID_CFG = cfg.min_bid || MIN_BID;

    const stats = {
      campaigns_analyzed: 0,
      bid_increases: 0,
      bid_reductions: 0,
      bid_recoveries: 0,
      new_learning_records: 0,
      blocked: 0,
      blocked_stale_metrics: 0,
      blocked_product_identity: 0,
    };

    // ── 1. Carregar campanhas AUTO ativas ──────────────────────────────────
    const allCampaigns: any[] = [];
    let offset = 0;
    while (true) {
      const page = await loadPage(
        base44.asServiceRole.entities.Campaign,
        { amazon_account_id: amazonAccountId },
        '-created_date', 300, offset
      );
      allCampaigns.push(...page);
      if (page.length < 300) break;
      offset += 300;
    }

    // Deduplicar por campaign_id, excluir arquivadas
    const campMap = new Map<string, any>();
    for (const c of allCampaigns) {
      if (c.archived || c.state === 'archived') continue;
      const key = c.campaign_id;
      if (!key) continue;
      const ex = campMap.get(key);
      const ts = (d: string) => d ? new Date(d).getTime() : 0;
      const cTime = ts(c.last_sync_at || c.updated_date || c.created_date);
      const eTime = ex ? ts(ex.last_sync_at || ex.updated_date || ex.created_date) : 0;
      if (!ex || cTime >= eTime) campMap.set(key, c);
    }
    const autoCampaigns = [...campMap.values()].filter(c =>
      (c.targeting_type === 'AUTO' || (c.name || '').toUpperCase().includes('AUTO')) &&
      (c.state === 'enabled' || c.status === 'enabled' || c.state === 'paused')
    );

    // Carregar learning records existentes
    const learningRecords: any[] = await base44.asServiceRole.entities.AutoCampaignLearning.filter(
      { amazon_account_id: amazonAccountId }, '-created_date', 500
    );
    const learningMap = new Map<string, any>(learningRecords.map((r: any) => [r.campaign_id, r]));

    // Carregar produtos para verificação de estoque
    const products: any[] = [];
    let productOffset = 0;
    while (true) {
      const page = await loadPage(base44.asServiceRole.entities.Product,
        { amazon_account_id: amazonAccountId }, '-updated_date', 300, productOffset);
      products.push(...page);
      if (page.length < 300) break;
      productOffset += 300;
    }
    const productsByAsin = new Map<string, any[]>();
    const productsBySku = new Map<string, any[]>();
    for (const product of products) {
      if (product.status === 'archived') continue;
      const asinKey = String(product.asin || '').trim().toUpperCase();
      const skuKey = String(product.sku || '').trim().toUpperCase();
      if (asinKey) productsByAsin.set(asinKey, [...(productsByAsin.get(asinKey) || []), product]);
      if (skuKey) productsBySku.set(skuKey, [...(productsBySku.get(skuKey) || []), product]);
    }

    // ProductAd is the authoritative campaign-to-SKU link when an imported
    // Campaign row predates SKU persistence. Multiple linked SKUs are blocked.
    const productAds: any[] = await base44.asServiceRole.entities.ProductAd.filter(
      { amazon_account_id: amazonAccountId }, '-synced_at', 5000
    ).catch(() => []);
    const skusByCampaign = new Map<string, Set<string>>();
    for (const ad of productAds) {
      const campaignId = String(ad.amazon_campaign_id || ad.campaign_id || '').trim();
      const linkedSku = String(ad.sku || '').trim().toUpperCase();
      if (!campaignId || !linkedSku) continue;
      const linked = skusByCampaign.get(campaignId) || new Set<string>();
      linked.add(linkedSku);
      skusByCampaign.set(campaignId, linked);
    }

    // Carregar histórico de bids do dia para idempotência
    const todayBidHistory: any[] = await base44.asServiceRole.entities.CampaignBidHistory.filter(
      { amazon_account_id: amazonAccountId }, '-created_at', 200
    );
    const bidChangedToday = new Set<string>(
      todayBidHistory
        .filter((h: any) => {
          const age = hoursAgo(h.created_at || h.created_date);
          return age < 24;
        })
        .map((h: any) => h.campaign_id)
    );

    // ── 2. Processar cada campanha AUTO ───────────────────────────────────
    for (const camp of autoCampaigns) {
      stats.campaigns_analyzed++;
      const campId = camp.campaign_id;
      const asin = String(camp.asin || '').trim().toUpperCase();
      const linkedSkus = skusByCampaign.get(String(camp.amazon_campaign_id || campId)) || new Set<string>();
      const storedSku = String(camp.sku || camp.advertised_sku || camp.product_ad_sku || '').trim().toUpperCase();
      if (linkedSkus.size > 1 || (storedSku && linkedSkus.size === 1 && !linkedSkus.has(storedSku))) {
        stats.blocked++;
        stats.blocked_product_identity++;
        continue;
      }
      const sku = storedSku || (linkedSkus.size === 1 ? [...linkedSkus][0] : '');
      const skuMatches = sku ? (productsBySku.get(sku) || []) : [];
      const asinMatches = asin ? (productsByAsin.get(asin) || []) : [];
      const product = skuMatches.length === 1 ? skuMatches[0]
        : skuMatches.length > 1 ? null
        : !sku && asinMatches.length === 1 ? asinMatches[0] : null;
      if (!product) {
        stats.blocked++;
        stats.blocked_product_identity++;
        continue;
      }
      if (!hasFreshAdsInventory(product) || availableAdsStock(product) <= 0 || !campaignCoverageEligible(product)) {
        stats.blocked++;
        continue;
      }
      const canonicalAsin = String(product.asin || asin).trim().toUpperCase();
      const campState = (camp.state || camp.status || '').toLowerCase();

      // Proteções: nunca ajustar bid quando campanha está fora do ar
      if (campState === 'archived') continue;
      const isPaused = campState === 'paused';

      let lr = learningMap.get(campId);

      // ── 2a. Criar learning record se não existir ─────────────────────
      if (!lr) {
        const confirmedAt = camp.last_api_sync_at || camp.created_at || camp.synced_at || now;
        const firstAnalysisDue = new Date(new Date(confirmedAt).getTime() + 24 * 3600000).toISOString();
        lr = await base44.asServiceRole.entities.AutoCampaignLearning.create({
          amazon_account_id: amazonAccountId,
          campaign_id: campId,
          ad_group_id: camp.ad_group_id || '',
          asin: canonicalAsin,
          sku: product.sku,
          campaign_name: camp.name || camp.campaign_name || campId,
          learning_state: 'learning_24h',
          current_bid: INITIAL_BID,
          bid_floor_operational: INITIAL_BID,
          bid_ceiling: MAX_BID_CFG,
          confirmed_at: confirmedAt,
          first_analysis_due_at: firstAnalysisDue,
          next_review_at: firstAnalysisDue,
          created_at: now,
        });
        learningMap.set(campId, lr);
        stats.new_learning_records++;

        // Registrar bid inicial
        await base44.asServiceRole.entities.CampaignBidHistory.create({
          amazon_account_id: amazonAccountId,
          campaign_id: campId,
          ad_group_id: camp.ad_group_id || '',
          asin: canonicalAsin,
          sku: product.sku,
          previous_bid: 0,
          new_bid: INITIAL_BID,
          change_type: 'initial_bid',
          reason: 'Bid inicial padrão para campanha AUTO nova — R$0,50 determinístico',
          impressions_before: 0,
          clicks_before: 0,
          spend_before: 0,
          orders_before: 0,
          average_cpc_before: 0,
          created_at: now,
          next_review_at: firstAnalysisDue,
          execution_id: `init_${campId}_${today}`,
        });
        continue;
      }

      // ── 2b. Verificar se chegou a hora da análise ────────────────────
      const reviewDue = lr.next_review_at || lr.first_analysis_due_at;
      if (reviewDue && new Date(reviewDue).getTime() > Date.now()) {
        continue;
      }

      // ── 2c. Proteções: não ajustar se campanha pausada ou com problema ─
      if (isPaused) {
        await base44.asServiceRole.entities.AutoCampaignLearning.update(lr.id, {
          last_analysis_at: now,
          next_review_at: hoursFromNow(24),
          block_reason: 'CAMPAIGN_PAUSED',
        });
        continue;
      }

      if (product) {
        if (product.inventory_status === 'out_of_stock') {
          await base44.asServiceRole.entities.AutoCampaignLearning.update(lr.id, {
            last_analysis_at: now,
            next_review_at: hoursFromNow(12),
            learning_state: 'blocked',
            block_reason: 'OUT_OF_STOCK',
          });
          stats.blocked++;
          continue;
        }
        if (product.buy_box_status === 'lost') {
          await base44.asServiceRole.entities.AutoCampaignLearning.update(lr.id, {
            last_analysis_at: now,
            next_review_at: hoursFromNow(6),
            learning_state: 'blocked',
            block_reason: 'BUY_BOX_LOST',
          });
          stats.blocked++;
          continue;
        }
      }

      // ── 2d. Idempotência: evitar dois ajustes no mesmo dia ─────────────
      if (bidChangedToday.has(campId)) continue;

      // Métricas da campanha dos últimos 2 dias
      const metrics: any[] = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
        { amazon_account_id: amazonAccountId, campaign_id: campId },
        '-date', 7
      );

      const latestMetricDate = metrics.map((row: any) => String(row.date || '').slice(0, 10)).filter(Boolean).sort().at(-1) || '';
      const freshnessCutoff = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
      if (!latestMetricDate || latestMetricDate < freshnessCutoff || latestMetricDate > today) {
        stats.blocked++;
        stats.blocked_stale_metrics++;
        await base44.asServiceRole.entities.AutoCampaignLearning.update(lr.id, {
          last_analysis_at: now, next_review_at: hoursFromNow(6), block_reason: 'STALE_OR_MISSING_CAMPAIGN_METRICS',
        });
        continue;
      }

      // Daily reports may be revised as attribution matures. If duplicate
      // rows exist for one campaign/date, retain the newest stored revision.
      const metricByDate = new Map<string, any>();
      for (const row of metrics) {
        const date = String(row.date || '').slice(0, 10);
        const previous = metricByDate.get(date);
        const rowAt = Date.parse(row.updated_at || row.synced_at || row.created_at || '') || 0;
        const previousAt = Date.parse(previous?.updated_at || previous?.synced_at || previous?.created_at || '') || 0;
        if (date && (!previous || rowAt >= previousAt)) metricByDate.set(date, row);
      }
      const metricCutoff = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
      const recentMetrics = [...metricByDate.entries()]
        .filter(([date]) => date >= metricCutoff && date <= today)
        .map(([, row]) => row);

      const totalSpend = recentMetrics.reduce((s, m) => s + (m.spend || 0), 0);
      const totalClicks = recentMetrics.reduce((s, m) => s + (m.clicks || 0), 0);
      const totalImpressions = recentMetrics.reduce((s, m) => s + (m.impressions || 0), 0);
      const totalOrders = recentMetrics.reduce((s, m) => s + (m.orders || 0), 0);
      const totalSales = recentMetrics.reduce((s, m) => s + (m.sales || 0), 0);
      const avgCpc = totalClicks > 0 ? totalSpend / totalClicks : 0;
      const avgAcos = totalSales > 0 ? (totalSpend / totalSales) * 100 : 0;

      const currentBid = lr.current_bid || INITIAL_BID;
      const bidCeiling = lr.bid_ceiling || MAX_BID_CFG;
      const currentState = lr.learning_state || 'learning_24h';
      let newState = currentState;
      let newBid = currentBid;
      let changeType: string | null = null;
      let changeReason = '';

      // ════════════════════════════════════════════════════════════════
      // REGRAS DE AJUSTE DETERMINÍSTICO
      // ════════════════════════════════════════════════════════════════

      const hasSpend = totalSpend > 0.01;
      const hasImpressions = totalImpressions > 5;
      const hasDelivery = hasSpend || hasImpressions;

      // CENÁRIO A: campanha sem entrega após um ciclo diário confirmado.
      if (!hasDelivery && ['learning_24h', 'learning_48h', 'no_spend', 'bid_increase_10', 'observing_24h', 'observing_48h', 'bid_increase_05'].includes(currentState)) {
        const hoursSinceLastChange = hoursAgo(lr.last_bid_change_at || lr.confirmed_at || now);
        const increaseCount = lr.bid_increase_count || 0;

        if (['learning_24h', 'learning_48h', 'no_spend'].includes(currentState)) {
          // Primeiro aumento: +R$0,10
          if (hoursSinceLastChange >= 24) {
            newBid = Math.min(currentBid + INCREASE_NO_SPEND_1, bidCeiling);
            changeType = 'increase_no_spend_10';
            changeReason = `Campanha sem gasto após ${Math.round(hoursSinceLastChange)}h. Aumento de ${sym}0,10 para tentar obter impressões.`;
            newState = 'bid_increase_10';
          }
        } else if (currentState === 'bid_increase_10' || currentState === 'observing_24h') {
          // Segunda análise: se segue sem entrega após mais um ciclo diário, +R$0,05.
          if (hoursSinceLastChange >= 24) {
            newBid = Math.min(currentBid + INCREASE_NO_SPEND_2, bidCeiling);
            changeType = 'increase_no_spend_05';
            changeReason = `Campanha sem gasto após ajuste de R$0,10 (${Math.round(hoursSinceLastChange)}h). Aumento adicional de ${sym}0,05.`;
            newState = 'bid_increase_05';
          }
        } else if (['bid_increase_05', 'observing_48h'].includes(currentState)) {
          // Aumentos subsequentes conservadores: +R$0,05 por ciclo de 24-48h
          if (hoursSinceLastChange >= 24 && currentBid < bidCeiling) {
            newBid = Math.min(currentBid + INCREASE_NO_SPEND_2, bidCeiling);
            changeType = 'increase_no_spend_05';
            changeReason = `Continuação do ajuste sem gasto. Incremento conservador de ${sym}0,05. Verificado estoque, Buy Box e elegibilidade.`;
            newState = 'bid_increase_05';
          }
        }

      // CENÁRIO B: campanha gastando — parar aumentos e analisar para redução
      } else if (hasDelivery) {
        if (['learning_24h', 'learning_48h', 'no_spend', 'bid_increase_10', 'observing_24h', 'observing_48h', 'bid_increase_05'].includes(currentState)) {
          newState = 'spending';
          // Primeira vez que detectamos gasto — só registrar
        } else if (currentState === 'spending' || currentState === 'stable') {
          // Verificar se CPC real é inferior ao bid atual → reduzir
          const hoursSinceLastChange = hoursAgo(lr.last_bid_change_at || lr.confirmed_at || now);
          const hasEnoughData = totalClicks >= 10 && hoursSinceLastChange >= 24;

          if (hasEnoughData && avgCpc > 0 && avgCpc < currentBid * 0.92) {
            // CPC real está ao menos 8% abaixo do bid — margem para reduzir
            newBid = Math.max(currentBid - REDUCE_LOW_CPC, MIN_BID_CFG);
            if (newBid < currentBid - 0.004) {
              changeType = 'reduce_low_cpc_05';
              changeReason = `CPC médio real ${sym}${avgCpc.toFixed(2)} < bid atual ${sym}${currentBid.toFixed(2)}. Redução de ${sym}0,05 por dia para aproximar bid do CPC real.`;
              newState = 'bid_reduction_05';
            }
          } else if (hasEnoughData && avgAcos > 0 && avgAcos > TARGET_ACOS * 1.2 && totalOrders >= 1) {
            // ACoS muito acima da meta: reduzir para meta
            newBid = Math.max(currentBid - REDUCE_LOW_CPC, MIN_BID_CFG);
            if (newBid < currentBid - 0.004) {
              changeType = 'reduce_for_goal_05';
              changeReason = `ACoS ${avgAcos.toFixed(1)}% acima da meta ${TARGET_ACOS}%. Redução de ${sym}0,05 para controle de custo.`;
              newState = 'bid_reduction_05';
            }
          }
        } else if (currentState === 'bid_reduction_05') {
          // Verificar perda de entrega após redução
          const prevImpressions = lr.total_impressions || 0;
          if (prevImpressions > 0 && totalImpressions < prevImpressions * 0.3) {
            // Queda > 70% de impressões → recuperar delivery
            newBid = Math.min(currentBid + RECOVER_DELIVERY, bidCeiling);
            changeType = 'recover_delivery_10';
            changeReason = `Queda crítica de impressões após redução de bid (${totalImpressions} vs ${prevImpressions} anteriores). Recuperação +${sym}0,10 para restaurar entrega.`;
            newState = 'bid_recovery_10';
            // Registrar último bid com entrega
            await base44.asServiceRole.entities.AutoCampaignLearning.update(lr.id, {
              last_bid_without_delivery: currentBid,
              last_bid_with_delivery: newBid,
            });
          } else {
            // Redução continuada se ainda há entrega
            const hoursSinceLastChange = hoursAgo(lr.last_bid_change_at || lr.confirmed_at || now);
            if (hoursSinceLastChange >= 24 && totalImpressions > 0) {
              if (avgCpc > 0 && avgCpc < currentBid * 0.92) {
                newBid = Math.max(currentBid - REDUCE_LOW_CPC, MIN_BID_CFG);
                if (newBid < currentBid - 0.004) {
                  changeType = 'reduce_low_cpc_05';
                  changeReason = `Redução continuada: CPC ${sym}${avgCpc.toFixed(2)} < bid ${sym}${currentBid.toFixed(2)}. Entrega mantida.`;
                }
              } else {
                newState = 'stable';
              }
            }
          }
        } else if (currentState === 'bid_recovery_10') {
          // Após recuperação: manter e estabilizar
          newState = 'stable';
          await base44.asServiceRole.entities.AutoCampaignLearning.update(lr.id, {
            stable_bid: currentBid,
          });
        }
      }

      // ── Aplicar mudança de bid se necessária ────────────────────────
      if (changeType && newBid !== currentBid) {
        // Atualizar learning record
        const updateData: any = {
          learning_state: newState,
          current_bid: newBid,
          last_bid_change_at: now,
          last_analysis_at: now,
          next_review_at: hoursFromNow(24),
          total_impressions: totalImpressions,
          total_clicks: totalClicks,
          total_spend: totalSpend,
          total_orders: totalOrders,
          total_sales: totalSales,
          avg_cpc: avgCpc,
          avg_acos: avgAcos,
          bid_increase_count: (lr.bid_increase_count || 0) + (changeType.startsWith('increase') ? 1 : 0),
          bid_reduction_count: (lr.bid_reduction_count || 0) + (changeType.startsWith('reduce') ? 1 : 0),
        };

        if (changeType === 'recover_delivery_10') {
          updateData.bid_floor_operational = newBid;
          updateData.stable_bid = newBid;
        }
        if (hasDelivery && !lr.last_bid_with_delivery) {
          updateData.last_bid_with_delivery = currentBid;
        }

        await base44.asServiceRole.entities.AutoCampaignLearning.update(lr.id, updateData);

        // Registrar no histórico
        await base44.asServiceRole.entities.CampaignBidHistory.create({
          amazon_account_id: amazonAccountId,
          campaign_id: campId,
          ad_group_id: camp.ad_group_id || lr.ad_group_id || '',
          asin: canonicalAsin,
          sku: product.sku,
          previous_bid: currentBid,
          new_bid: newBid,
          change_type: changeType,
          reason: changeReason,
          impressions_before: totalImpressions,
          clicks_before: totalClicks,
          spend_before: totalSpend,
          orders_before: totalOrders,
          sales_before: totalSales,
          average_cpc_before: avgCpc,
          acos_before: avgAcos,
          roas_before: totalSales > 0 && totalSpend > 0 ? totalSales / totalSpend : 0,
          created_at: now,
          next_review_at: hoursFromNow(24),
          execution_id: `${changeType}_${campId}_${today}`,
        });

        // Enfileirar atualização do bid na Amazon via queue
        await base44.asServiceRole.entities.AmazonActionQueue.create({
          amazon_account_id: amazonAccountId,
          operation: 'update_bid',
          entity_type: 'ad_group',
          entity_id: camp.ad_group_id || campId,
          payload: {
            campaign_id: campId,
            ad_group_id: camp.ad_group_id || '',
            new_bid: newBid,
            change_type: changeType,
          },
          idempotency_key: `bid_${campId}_${changeType}_${today}`,
          priority: 'normal',
          status: 'pending',
          scheduled_at: now,
          source: 'runAutoCampaignLearning',
        });

        bidChangedToday.add(campId);
        if (changeType.startsWith('increase')) stats.bid_increases++;
        else if (changeType.startsWith('reduce')) stats.bid_reductions++;
        else if (changeType === 'recover_delivery_10') stats.bid_recoveries++;

        lr = { ...lr, ...updateData };
      } else {
        // Sem mudança: apenas atualizar métricas e estado
        await base44.asServiceRole.entities.AutoCampaignLearning.update(lr.id, {
          learning_state: newState,
          last_analysis_at: now,
          next_review_at: hoursFromNow(24),
          total_impressions: totalImpressions,
          total_clicks: totalClicks,
          total_spend: totalSpend,
          total_orders: totalOrders,
          total_sales: totalSales,
          avg_cpc: avgCpc,
          avg_acos: avgAcos,
        });
      }

    }

    return Response.json({
      ok: true,
      duration_ms: Date.now() - startTime,
      stats,
      auto_campaigns_found: autoCampaigns.length,
      inventory_preflight: inventoryPreflight,
    });

  } catch (error) {
    console.error('[runAutoCampaignLearning] Error:', error?.message);
    return Response.json({ ok: false, error: error?.message || 'Erro no motor de aprendizado' }, { status: 500 });
  }
});
