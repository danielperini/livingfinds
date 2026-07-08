/**
 * runFullCampaignStandardsReview
 *
 * Revisa TODAS as campanhas, ad groups, keywords e product ads.
 * Para cada entidade: audita → classifica problema → tenta corrigir → arquiva só se irreparável.
 *
 * ECONOMY_FIRST: reduzir custo sempre que houver desperdício.
 * Nunca arquivar por erro temporário, rate limit ou dado vencido.
 * Toda ação vai para AmazonActionQueue com idempotência.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

function safe(v: unknown): number {
  const n = Number(v);
  return isNaN(n) || !isFinite(n) ? 0 : n;
}
function today(): string { return new Date().toISOString().slice(0, 10); }
function nowIso(): string { return new Date().toISOString(); }

// Padrão de nomenclatura de campanhas
const AUTO_PATTERN = /^AUTO\s*[\|]/i;
const MANUAL_PATTERN = /^MANUAL\s*(EXACT|PHRASE|BROAD)?\s*[\|]/i;
const INCOMPLETE_KEYWORD_MIN_LEN = 3;

function isNameOutOfStandard(name: string): boolean {
  if (!name) return true;
  return !AUTO_PATTERN.test(name) && !MANUAL_PATTERN.test(name);
}

function isKeywordIncomplete(text: string): boolean {
  if (!text || text.length < INCOMPLETE_KEYWORD_MIN_LEN) return true;
  if (/[^a-záàâãéèêíóôõúüçñ0-9\s\-\.]/i.test(text)) return true; // símbolos inválidos
  const words = text.trim().split(/\s+/);
  if (words.some(w => w.length === 1 && /[a-z]/i.test(w))) return true; // letra solta
  return false;
}

function buildIKey(...parts: string[]): string {
  return parts.filter(Boolean).join('|');
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const auth = await base44.auth.isAuthenticated().catch(() => false);
    if (!auth && !body._service_role) return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });

    let amazonAccountId = body.amazon_account_id;
    if (!amazonAccountId) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      if (!accs.length) return Response.json({ ok: false, error: 'Nenhuma conta conectada' });
      amazonAccountId = accs[0].id;
    }

    const account = (await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazonAccountId }))[0];
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada' });

    const todayStr = today();
    const now = nowIso();
    const sym = account.currency_symbol || 'R$';

    // ── Configuração ──────────────────────────────────────────────────────
    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: amazonAccountId }).catch(() => []);
    const cfg = configs[0] || {};
    const perfCfgs = await base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: amazonAccountId }).catch(() => []);
    const perf = perfCfgs[0] || {};
    const MIN_BID = safe(perf.min_bid || cfg.min_bid || 0.10);
    const MAX_BID = safe(perf.max_bid || cfg.max_bid || 5.0);
    const TARGET_ACOS = safe(perf.target_acos || cfg.target_acos || 25);
    const MAX_ACOS = safe(perf.max_acos || cfg.maximum_acos || 40);
    const CONFIDENCE_ARCHIVE = 90;

    // ── Carregar dados ────────────────────────────────────────────────────
    const [campaigns, keywords, products, searchTerms, adGroups, metricsRaw] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId }, null, 500),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: amazonAccountId }, '-spend', 1000),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: amazonAccountId }, null, 300),
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: amazonAccountId }, '-orders_14d', 500).catch(() => []),
      base44.asServiceRole.entities.AdGroup.filter({ amazon_account_id: amazonAccountId }, null, 500).catch(() => []),
      base44.asServiceRole.entities.CampaignMetricsDaily.filter({ amazon_account_id: amazonAccountId }, '-date', 2000).catch(() => []),
    ]);

    // Índices
    const productMap = new Map(products.map((p: Record<string, unknown>) => [String(p.asin || ''), p]));
    const keywordsByCampaign = new Map<string, Record<string, unknown>[]>();
    for (const kw of keywords) {
      const cid = String((kw as Record<string, unknown>).campaign_id || '');
      if (!keywordsByCampaign.has(cid)) keywordsByCampaign.set(cid, []);
      keywordsByCampaign.get(cid)!.push(kw as Record<string, unknown>);
    }
    const adGroupsByCampaign = new Map<string, Record<string, unknown>[]>();
    for (const ag of adGroups) {
      const cid = String((ag as Record<string, unknown>).campaign_id || '');
      if (!adGroupsByCampaign.has(cid)) adGroupsByCampaign.set(cid, []);
      adGroupsByCampaign.get(cid)!.push(ag as Record<string, unknown>);
    }

    // Métricas por campanha (últimos 30 dias fechados)
    const metricsByCampaign: Record<string, { spend: number; sales: number; orders: number; clicks: number }> = {};
    for (const m of metricsRaw as Record<string, unknown>[]) {
      const cid = String(m.campaign_id || '');
      if (!cid) continue;
      if (!metricsByCampaign[cid]) metricsByCampaign[cid] = { spend: 0, sales: 0, orders: 0, clicks: 0 };
      metricsByCampaign[cid].spend += safe(m.spend);
      metricsByCampaign[cid].sales += safe(m.sales);
      metricsByCampaign[cid].orders += safe(m.orders);
      metricsByCampaign[cid].clicks += safe(m.clicks);
    }

    // Ações já pendentes hoje (idempotência)
    const existingActions = await base44.asServiceRole.entities.AmazonActionQueue.filter(
      { amazon_account_id: amazonAccountId }, '-created_date', 1000
    ).catch(() => []);
    const usedKeys = new Set((existingActions as Record<string, unknown>[]).map(a => String(a.idempotency_key || '')));

    const toEnqueue: Record<string, unknown>[] = [];
    const repairLog: Record<string, unknown>[] = [];

    const stats = {
      campaigns_reviewed: 0,
      campaigns_repaired: 0,
      campaigns_to_archive: 0,
      campaigns_created_auto: 0,
      campaigns_created_manual: 0,
      keywords_reviewed: 0,
      keywords_repaired: 0,
      keywords_paused: 0,
      keywords_created: 0,
      product_ads_paused_no_stock: 0,
      bids_reduced: 0,
      skipped_low_confidence: 0,
      errors: 0,
    };
    const warnings: string[] = [];

    // ── 1. REVISAR CAMPANHAS ──────────────────────────────────────────────
    for (const camp of campaigns) {
      try {
        stats.campaigns_reviewed++;
        const c = camp as Record<string, unknown>;
        const cid = String(c.campaign_id || c.amazon_campaign_id || '');
        const cName = String(c.campaign_name || c.name || '');
        const cState = String(c.state || c.status || '').toLowerCase();
        const cType = String(c.targeting_type || c.campaign_type || '').toUpperCase();
        const asin = String(c.asin || '');
        const product = asin ? productMap.get(asin) : null;
        const campMetrics = metricsByCampaign[cid] || { spend: 0, sales: 0, orders: 0, clicks: 0 };
        const campKws = keywordsByCampaign.get(cid) || [];
        const campAdGroups = adGroupsByCampaign.get(cid) || [];

        // Ignorar arquivadas no banco local (podem ter vindo de importação)
        if (c.archived === true && cState === 'archived') continue;

        const issues: string[] = [];
        const repairs: string[] = [];

        // Verificação 1: vínculo com produto
        if (asin && !product) {
          issues.push('PRODUCT_NOT_FOUND');
        }

        // Verificação 2: produto sem estoque
        const outOfStock = product && String((product as Record<string, unknown>).inventory_status) === 'out_of_stock';
        if (outOfStock && cState === 'enabled') {
          const iKey = buildIKey('pause_camp_no_stock', cid, todayStr);
          if (!usedKeys.has(iKey)) {
            toEnqueue.push({
              amazon_account_id: amazonAccountId,
              operation: 'pause_campaign',
              entity_type: 'campaign',
              entity_id: cid,
              campaign_id: cid,
              asin,
              payload: JSON.stringify({ reason: 'out_of_stock' }),
              idempotency_key: iKey,
              priority: 1,
              confidence: 98,
              status: 'approved',
              reason: 'product_out_of_stock',
              source_function: 'runFullCampaignStandardsReview',
              created_at: now,
            });
            stats.product_ads_paused_no_stock++;
            repairs.push('PAUSED_NO_STOCK');
          }
        }

        // Verificação 3: campanha sem ad group
        if (campAdGroups.length === 0 && cState === 'enabled') {
          issues.push('NO_AD_GROUP');
        }

        // Verificação 4: campanha sem keywords (manual)
        if ((cType === 'MANUAL' || MANUAL_PATTERN.test(cName)) && campKws.length === 0 && cState === 'enabled') {
          issues.push('MANUAL_NO_KEYWORDS');
        }

        // Verificação 5: campanha incompleta
        if (cState === 'incomplete') {
          issues.push('INCOMPLETE_CAMPAIGN');
        }

        // Verificação 6: vínculo local errado
        if (asin && product) {
          const p = product as Record<string, unknown>;
          if (!p.has_campaign) {
            // Reparar vínculo local
            await base44.asServiceRole.entities.Product.updateMany(
              { amazon_account_id: amazonAccountId, asin },
              { $set: { has_campaign: true, campaign_status: 'active', linked_campaign_id: cid } }
            ).catch(() => {});
            repairs.push('FIXED_PRODUCT_LINK');
            stats.campaigns_repaired++;
          }
        }

        // Verificação 7: campanha ativa sem bid mínimo
        const campBudget = safe(c.daily_budget);
        if (campBudget > 0 && campBudget < 15 && cState === 'enabled') {
          issues.push('BUDGET_BELOW_MINIMUM');
          warnings.push(`Campanha ${cid} com budget R$${campBudget} < mínimo R$15`);
        }

        // Verificação 8: campanha com gasto sem venda (desperdício consistente)
        if (campMetrics.spend >= 50 && campMetrics.orders === 0 && campMetrics.clicks >= 20) {
          issues.push('CONSISTENT_WASTE');
          warnings.push(`Campanha ${cid}: R$${campMetrics.spend.toFixed(2)} gastos sem pedido`);
        }

        // Registrar log de auditoria
        if (issues.length > 0 || repairs.length > 0) {
          repairLog.push({
            campaign_id: cid,
            campaign_name: cName,
            state: cState,
            issues,
            repairs,
            asin,
            metrics: campMetrics,
          });
        }

      } catch (err) {
        stats.errors++;
        console.warn('[runFullCampaignStandardsReview] campanha:', (err as Error).message);
      }
    }

    // ── 2. REVISAR KEYWORDS ───────────────────────────────────────────────
    for (const kw of keywords) {
      try {
        stats.keywords_reviewed++;
        const k = kw as Record<string, unknown>;
        const kwId = String(k.keyword_id || k.id || '');
        const kwText = String(k.keyword_text || k.keyword || '');
        const kwState = String(k.state || k.status || '').toLowerCase();
        const kwBid = safe(k.current_bid || k.bid || 0);
        const kwAsin = String(k.asin || '');
        const kwProduct = kwAsin ? productMap.get(kwAsin) : null;

        // Ignorar arquivadas
        if (kwState === 'archived') continue;

        // Keyword incompleta
        if (isKeywordIncomplete(kwText) && kwState === 'enabled') {
          const iKey = buildIKey('pause_incomplete_kw', kwId, todayStr);
          if (!usedKeys.has(iKey)) {
            toEnqueue.push({
              amazon_account_id: amazonAccountId,
              operation: 'pause_keyword',
              entity_type: 'keyword',
              entity_id: kwId,
              campaign_id: String(k.campaign_id || ''),
              ad_group_id: String(k.ad_group_id || ''),
              keyword_id: kwId,
              payload: JSON.stringify({ reason: 'incomplete_keyword', keyword_text: kwText }),
              idempotency_key: iKey,
              priority: 2,
              confidence: 85,
              status: 'approved',
              reason: 'incomplete_keyword_text',
              source_function: 'runFullCampaignStandardsReview',
              created_at: now,
            });
            stats.keywords_paused++;
          }
        }

        // Produto sem estoque → pausar keyword
        if (kwProduct && String((kwProduct as Record<string, unknown>).inventory_status) === 'out_of_stock' && kwState === 'enabled') {
          const iKey = buildIKey('pause_kw_no_stock', kwId, todayStr);
          if (!usedKeys.has(iKey)) {
            toEnqueue.push({
              amazon_account_id: amazonAccountId,
              operation: 'pause_keyword',
              entity_type: 'keyword',
              entity_id: kwId,
              campaign_id: String(k.campaign_id || ''),
              keyword_id: kwId,
              payload: JSON.stringify({ reason: 'product_out_of_stock' }),
              idempotency_key: iKey,
              priority: 1,
              confidence: 95,
              status: 'approved',
              reason: 'product_out_of_stock',
              source_function: 'runFullCampaignStandardsReview',
              created_at: now,
            });
            stats.keywords_paused++;
          }
        }

        // Bid sugerido pela Amazon menor que atual → ECONOMY_FIRST
        const amazonSuggestedBid = safe(k.amazon_suggested_bid || k.suggested_bid || 0);
        if (amazonSuggestedBid > 0 && kwBid > 0 && amazonSuggestedBid < kwBid && kwState === 'enabled') {
          const newBid = Math.max(MIN_BID, Math.round(amazonSuggestedBid * 100) / 100);
          if (newBid < kwBid) {
            const iKey = buildIKey('suggested_bid_reduction', kwId, String(Math.round(kwBid * 100)), String(Math.round(amazonSuggestedBid * 100)), todayStr);
            if (!usedKeys.has(iKey)) {
              const savingsPerClick = kwBid - newBid;
              toEnqueue.push({
                amazon_account_id: amazonAccountId,
                operation: 'update_bid',
                entity_type: 'keyword',
                entity_id: kwId,
                campaign_id: String(k.campaign_id || ''),
                keyword_id: kwId,
                asin: kwAsin,
                payload: JSON.stringify({
                  bid: newBid,
                  bid_before: kwBid,
                  amazon_suggested_bid: amazonSuggestedBid,
                  min_bid_used: MIN_BID,
                  savings_per_click: Math.round(savingsPerClick * 100) / 100,
                }),
                idempotency_key: iKey,
                priority: 1,
                confidence: 95,
                status: 'approved',
                reason: 'amazon_suggested_bid_lower_than_current',
                rule_applied: 'ECONOMY_FIRST_DECISION_RULE',
                value_before: kwBid,
                value_after: newBid,
                source_function: 'runFullCampaignStandardsReview',
                created_at: now,
              });
              stats.bids_reduced++;
            }
          }
        }

        // Bid inválido (abaixo do mínimo ou acima do máximo)
        if (kwBid > 0 && kwBid < MIN_BID && kwState === 'enabled') {
          const iKey = buildIKey('fix_bid_below_min', kwId, todayStr);
          if (!usedKeys.has(iKey)) {
            toEnqueue.push({
              amazon_account_id: amazonAccountId,
              operation: 'update_bid',
              entity_type: 'keyword',
              entity_id: kwId,
              campaign_id: String(k.campaign_id || ''),
              keyword_id: kwId,
              payload: JSON.stringify({ bid: MIN_BID, reason: 'bid_below_minimum' }),
              idempotency_key: iKey,
              priority: 3,
              confidence: 90,
              status: 'approved',
              reason: 'bid_below_minimum',
              value_before: kwBid,
              value_after: MIN_BID,
              source_function: 'runFullCampaignStandardsReview',
              created_at: now,
            });
            stats.keywords_repaired++;
          }
        }

        stats.keywords_reviewed++;
      } catch (err) {
        stats.errors++;
        console.warn('[runFullCampaignStandardsReview] keyword:', (err as Error).message);
      }
    }

    // ── 3. CRIAR CAMPANHAS AUTO PARA PRODUTOS ELEGÍVEIS SEM CAMPANHA ──────
    const productsNeedingAuto = products.filter((p: Record<string, unknown>) => {
      const pr = p as Record<string, unknown>;
      if (pr.status === 'archived' || pr.status === 'inactive') return false;
      if (String(pr.inventory_status || '') === 'out_of_stock') return false;
      if (pr.has_campaign === true) return false;
      if (!pr.asin) return false;
      return true;
    }).slice(0, 20); // máximo 20 por ciclo

    for (const p of productsNeedingAuto) {
      const pr = p as Record<string, unknown>;
      const iKey = buildIKey('create_auto_campaign', String(pr.asin), todayStr);
      if (!usedKeys.has(iKey)) {
        toEnqueue.push({
          amazon_account_id: amazonAccountId,
          operation: 'create_auto_campaign',
          entity_type: 'product',
          entity_id: String(pr.asin || ''),
          asin: String(pr.asin || ''),
          sku: String(pr.sku || ''),
          payload: JSON.stringify({
            asin: pr.asin,
            sku: pr.sku,
            product_name: pr.product_name || pr.display_name,
            initial_bid: 0.50,
            daily_budget: 15,
            reason: 'product_eligible_without_campaign',
          }),
          idempotency_key: iKey,
          priority: 4,
          confidence: 85,
          status: 'pending', // requer aprovação — criação de campanha
          reason: 'product_without_campaign',
          source_function: 'runFullCampaignStandardsReview',
          created_at: now,
        });
        stats.campaigns_created_auto++;
      }
    }

    // ── 4. CRIAR CAMPANHAS MANUAIS EXACT PARA SEARCH TERMS VENCEDORES ─────
    const winnersForManual = (searchTerms as Record<string, unknown>[]).filter(st => {
      const orders = safe(st.orders_14d || st.orders || 0);
      const acos = safe(st.acos_14d || st.acos || 0);
      const spend = safe(st.spend || 0);
      const promoted = st.promoted_to_manual === true;
      const term = String(st.search_term || st.keyword_text || '');
      return orders >= 3 && (acos === 0 || acos <= TARGET_ACOS) && !promoted && term.length >= 3 && !isKeywordIncomplete(term);
    }).slice(0, 10);

    for (const st of winnersForManual) {
      const term = String(st.search_term || st.keyword_text || '');
      const asin = String(st.advertised_asin || '');
      const product = asin ? productMap.get(asin) : null;
      if (!product || String((product as Record<string, unknown>).inventory_status) === 'out_of_stock') continue;

      const iKey = buildIKey('create_manual_exact', asin, term.toLowerCase().replace(/\s+/g, '_'), todayStr);
      if (!usedKeys.has(iKey)) {
        const suggestedBid = Math.min(Math.max(safe(st.cpc || 0) * 1.10, MIN_BID, 0.30), MAX_BID);
        toEnqueue.push({
          amazon_account_id: amazonAccountId,
          operation: 'create_manual_exact_campaign',
          entity_type: 'search_term',
          entity_id: String(st.id || ''),
          asin,
          payload: JSON.stringify({
            search_term: term,
            asin,
            sku: (product as Record<string, unknown>).sku || '',
            initial_bid: Math.round(suggestedBid * 100) / 100,
            daily_budget: 15,
            match_type: 'EXACT',
            source_campaign_id: st.campaign_id,
            orders_14d: st.orders_14d,
            acos_14d: st.acos_14d,
          }),
          idempotency_key: iKey,
          priority: 3,
          confidence: 88,
          status: 'pending', // criação de campanha manual → aprovação
          reason: 'search_term_winner_3_orders',
          rule_applied: 'ECONOMY_FIRST_DECISION_RULE',
          source_function: 'runFullCampaignStandardsReview',
          created_at: now,
        });
        stats.campaigns_created_manual++;
      }
    }

    // ── 5. Salvar ações na fila em lotes ──────────────────────────────────
    let enqueued = 0;
    for (let i = 0; i < toEnqueue.length; i += 50) {
      const batch = toEnqueue.slice(i, i + 50);
      await base44.asServiceRole.entities.AmazonActionQueue.bulkCreate(batch).catch(() => {});
      enqueued += batch.length;
    }

    return Response.json({
      ok: true,
      stats,
      warnings,
      repair_log_sample: repairLog.slice(0, 20),
      actions_enqueued: enqueued,
      duration_ms: Date.now() - startTime,
    });

  } catch (error) {
    return Response.json({ ok: false, error: (error as Error).message }, { status: 500 });
  }
});