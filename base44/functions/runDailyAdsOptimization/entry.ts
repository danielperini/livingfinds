/**
 * runDailyAdsOptimization — Orquestrador oficial único do Ads Autopilot.
 * Todas as outras funções de otimização são wrappers ou auxiliares deste.
 * Grava decisões EXCLUSIVAMENTE em OptimizationDecision.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const tokenCache = {};

async function getAdsToken(account) {
  const key = account?.id || 'default';
  const cached = tokenCache[key];
  if (cached && cached.expires_at > Date.now()) return cached.access_token;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: account?.ads_refresh_token || Deno.env.get('ADS_REFRESH_TOKEN'),
    client_id: Deno.env.get('ADS_CLIENT_ID'),
    client_secret: Deno.env.get('ADS_CLIENT_SECRET'),
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Token failed');
  tokenCache[key] = { access_token: data.access_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}

function getAdsBaseUrl(account) {
  const r = (account?.region || Deno.env.get('ADS_REGION') || 'NA').toUpperCase();
  if (r.includes('EU')) return 'https://advertising-api-eu.amazon.com';
  if (r.includes('FE')) return 'https://advertising-api-fe.amazon.com';
  return 'https://advertising-api.amazon.com';
}

async function adsRequest(account, method, path, body) {
  const token = await getAdsToken(account);
  const profileId = account?.ads_profile_id || account?.profile_id || Deno.env.get('ADS_PROFILE_ID');
  const res = await fetch(`${getAdsBaseUrl(account)}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Amazon-Advertising-API-ClientId': Deno.env.get('ADS_CLIENT_ID'),
      'Amazon-Advertising-API-Scope': String(profileId),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

function makeIdempotencyKey(amazonAccountId, decisionType, entityType, entityId, action, windowDate) {
  return `${amazonAccountId}|${decisionType}|${entityType}|${entityId}|${action}|${windowDate}`;
}

Deno.serve(async (req) => {
  const startTime = Date.now();
  const base44 = createClientFromRequest(req);
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  let runRecord = null;
  let amazonAccountId = null;

  try {
    const body = await req.json().catch(() => ({}));
    amazonAccountId = body.amazon_account_id;

    // Resolver conta
    let account = null;
    if (amazonAccountId) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: amazonAccountId });
      account = accs[0] || null;
    } else {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0] || null;
      if (account) amazonAccountId = account.id;
    }
    if (!account) return Response.json({ ok: false, message: 'Nenhuma conta Amazon conectada.' });

    const currencySymbol = account.currency_symbol || 'R$';
    const currencyCode = account.currency_code || 'BRL';

    // ── 1. Verificar lock do AutopilotRun ──
    const activeRuns = await base44.asServiceRole.entities.AutopilotRun.filter({ amazon_account_id: amazonAccountId, status: 'running' }, '-started_at', 5);
    for (const ar of activeRuns) {
      const ageMin = (Date.now() - new Date(ar.started_at).getTime()) / 60000;
      if (ageMin < 60) {
        return Response.json({ ok: false, skipped: true, reason: 'Autopilot já em execução', age_minutes: Math.round(ageMin), run_id: ar.id });
      }
      // Stale run > 60 min → marcar como failed
      await base44.asServiceRole.entities.AutopilotRun.update(ar.id, {
        status: 'failed', completed_at: now,
        error_message: `Lock liberado automaticamente após ${Math.round(ageMin)} minutos`,
      });
    }

    // Verificar lock de SyncExecutionLog
    const activeSyncs = await base44.asServiceRole.entities.SyncExecutionLog.filter({ amazon_account_id: amazonAccountId, status: 'started', operation: 'full_sync' }, '-started_at', 3);
    for (const s of activeSyncs) {
      const ageMin = (Date.now() - new Date(s.started_at).getTime()) / 60000;
      if (ageMin < 30) {
        return Response.json({ ok: false, skipped: true, reason: 'Sync em andamento — aguarde completar', age_minutes: Math.round(ageMin) });
      }
      await base44.asServiceRole.entities.SyncExecutionLog.update(s.id, {
        status: 'error', completed_at: now, error_message: 'Lock antigo liberado automaticamente',
      });
    }

    // Buscar configuração
    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: amazonAccountId });
    const cfg = configs[0] || {};
    const autonomyLevel = cfg.autonomy_level ?? 2;
    if (!cfg.enabled && cfg.enabled !== undefined) {
      return Response.json({ ok: true, skipped: true, reason: 'Autopilot desabilitado na configuração' });
    }

    const targetAcos = cfg.target_acos || cfg.acos_target || 25;
    const maxAcos = cfg.maximum_acos || 40;
    const minBid = cfg.min_bid || 0.10;
    const maxBid = cfg.max_bid || 5.0;
    const minClicks = cfg.min_clicks_for_decision || 8;
    const minSpend = cfg.min_spend_for_decision || 5;
    const minOrders = cfg.min_orders_for_scale || 2;
    const cooldownHours = cfg.cooldown_hours || 24;
    const maxBidIncreasePct = cfg.max_bid_increase_pct || 15;
    const maxBidDecreasePct = cfg.max_bid_decrease_pct || 20;
    const autoApplyLowRisk = cfg.auto_apply_low_risk !== false;
    const harvestEnabled = cfg.harvest_enabled !== false;

    // Criar run record
    runRecord = await base44.asServiceRole.entities.AutopilotRun.create({
      amazon_account_id: amazonAccountId,
      status: 'running',
      trigger: body.trigger || 'scheduled',
      started_at: now,
    });

    // ── 2. Carregar dados ──
    const [campaigns, keywords, products, searchTerms] = await Promise.all([
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: amazonAccountId }, '-spend', 500),
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: amazonAccountId }, '-spend', 1000),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: amazonAccountId }, null, 500),
      base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: amazonAccountId }, '-orders_14d', 2000),
    ]);

    const productMap = new Map(products.map(p => [p.asin, p]));
    const campaignMap = new Map(campaigns.map(c => [c.campaign_id, c]));

    // Buscar decisões pendentes existentes para deduplicação
    const existingDecisions = await base44.asServiceRole.entities.OptimizationDecision.filter(
      { amazon_account_id: amazonAccountId, status: 'pending' }, '-created_at', 500
    );
    const existingKeys = new Set(existingDecisions.map(d => d.idempotency_key).filter(Boolean));

    const decisionsToCreate = [];
    const stats = { bid_increase: 0, bid_decrease: 0, harvest: 0, negative: 0, pause_campaign: 0, budget_change: 0, skipped_dup: 0 };

    // ── 3. Análise de Search Terms ──
    if (cfg.search_term_optimization_enabled !== false && harvestEnabled) {
      // Agrupar por search_term + asin (pegar o mais recente / mais pedidos)
      const stMap = new Map();
      for (const st of searchTerms) {
        const key = `${st.search_term || st.keyword_text}|${st.advertised_asin}`;
        const existing = stMap.get(key);
        if (!existing || (st.orders_14d || 0) > (existing.orders_14d || 0)) stMap.set(key, st);
      }

      for (const st of stMap.values()) {
        const term = st.search_term || st.keyword_text;
        if (!term || !st.advertised_asin) continue;
        const orders14 = st.orders_14d || 0;
        const sales14 = st.sales_14d || 0;
        const acos14 = st.acos_14d || 0;
        const clicks = st.clicks || 0;
        const spend = st.spend || 0;

        // FIRST_SALE: primeira venda → criar keyword manual exact
        if (orders14 >= 1 && sales14 > 0 && !st.promoted_to_manual && st.relevance_status !== 'irrelevant') {
          const iKey = makeIdempotencyKey(amazonAccountId, 'harvest_search_term', 'search_term', st.id, 'create_keyword', today);
          if (!existingKeys.has(iKey)) {
            decisionsToCreate.push({
              amazon_account_id: amazonAccountId,
              decision_type: 'harvest_search_term',
              entity_type: 'search_term',
              entity_id: st.id,
              campaign_id: st.campaign_id,
              ad_group_id: st.ad_group_id,
              asin: st.advertised_asin,
              keyword_text: term,
              action: 'create_keyword',
              value_before: null,
              value_after: st.cpc > 0 ? Math.min(st.cpc * 1.10, maxBid) : Math.max(minBid, 0.30),
              rationale: `FIRST_SALE: termo "${term}" gerou ${orders14} pedido(s) com ${currencySymbol}${sales14.toFixed(2)} em vendas (14d). Criar keyword exact manual.`,
              data_used: `orders_14d=${orders14}, sales_14d=${sales14.toFixed(2)}, spend=${spend.toFixed(2)}, cpc=${(st.cpc||0).toFixed(2)}`,
              risk: 'low',
              requires_approval: autonomyLevel < 2,
              status: autonomyLevel >= 2 && autoApplyLowRisk ? 'approved' : 'pending',
              country_code: account.country_code || 'BR',
              currency_code: currencyCode,
              currency_symbol: currencySymbol,
              objective: 'growth',
              confidence: 80,
              idempotency_key: iKey,
              source_search_term_id: st.id,
              source_function: 'runDailyAdsOptimization',
              created_at: now,
            });
            stats.harvest++;
          } else { stats.skipped_dup++; }

          // Atualizar classificação do SearchTerm
          await base44.asServiceRole.entities.SearchTerm.update(st.id, {
            classification: 'FIRST_SALE',
            last_evaluated_at: now,
            evaluation_count: (st.evaluation_count || 0) + 1,
            first_sale_at: st.first_sale_at || now,
          });
        }
        // WINNER
        else if (orders14 >= minOrders && acos14 > 0 && acos14 <= targetAcos) {
          await base44.asServiceRole.entities.SearchTerm.update(st.id, { classification: 'WINNER', last_evaluated_at: now });
        }
        // HIGH_ACOS
        else if (orders14 >= 1 && acos14 > targetAcos) {
          await base44.asServiceRole.entities.SearchTerm.update(st.id, { classification: 'HIGH_ACOS', last_evaluated_at: now });
        }
        // WASTING
        else if (orders14 === 0 && clicks >= minClicks && spend >= minSpend) {
          // Negativar apenas após 2+ avaliações
          if ((st.evaluation_count || 0) >= 2 && st.relevance_status !== 'relevant') {
            const iKey = makeIdempotencyKey(amazonAccountId, 'negative_keyword', 'search_term', st.id, 'negative_exact', today);
            if (!existingKeys.has(iKey)) {
              decisionsToCreate.push({
                amazon_account_id: amazonAccountId,
                decision_type: 'negative_keyword',
                entity_type: 'search_term',
                entity_id: st.id,
                campaign_id: st.campaign_id,
                asin: st.advertised_asin,
                keyword_text: term,
                action: 'negative_exact',
                rationale: `WASTING após ${st.evaluation_count} avaliações: "${term}" com ${clicks} cliques e ${currencySymbol}${spend.toFixed(2)} spend sem conversão.`,
                data_used: `clicks=${clicks}, spend=${spend.toFixed(2)}, orders_14d=0, evaluations=${st.evaluation_count}`,
                risk: 'medium',
                requires_approval: true,
                status: 'pending',
                country_code: account.country_code || 'BR',
                currency_code: currencyCode,
                currency_symbol: currencySymbol,
                idempotency_key: iKey,
                source_search_term_id: st.id,
                source_function: 'runDailyAdsOptimization',
                created_at: now,
              });
              stats.negative++;
            }
          }
          await base44.asServiceRole.entities.SearchTerm.update(st.id, {
            classification: 'WASTING',
            evaluation_count: (st.evaluation_count || 0) + 1,
            last_evaluated_at: now,
          });
        }
      }
    }

    // ── 4. Análise de Keywords ──
    if (cfg.bid_optimization_enabled !== false) {
      for (const kw of keywords) {
        if ((kw.state || kw.status) === 'archived') continue;
        const currentBid = kw.current_bid || kw.bid || 0.25;
        const acos = kw.acos || 0;
        const clicks = kw.clicks || 0;
        const spend = kw.spend || 0;
        const sales = kw.sales || 0;
        const orders = kw.orders || 0;

        // Validar produto ativo
        const product = kw.asin ? productMap.get(kw.asin) : null;
        const outOfStock = product?.inventory_status === 'out_of_stock';
        const lowStock = product?.inventory_status === 'low_stock';

        // Não aumentar bid sem estoque ou buy box
        const canIncrease = !outOfStock && !lowStock && product?.buy_box_status !== 'lost';

        // Redução: sem gasto significativo e zero vendas
        if (clicks >= minClicks && spend >= minSpend && sales === 0) {
          const reducePct = Math.min(maxBidDecreasePct, 20) / 100;
          const newBid = Math.max(currentBid * (1 - reducePct), minBid);
          if (newBid < currentBid - 0.001) {
            const iKey = makeIdempotencyKey(amazonAccountId, 'bid_change', 'keyword', kw.keyword_id, 'reduce_wasting', today);
            if (!existingKeys.has(iKey)) {
              decisionsToCreate.push({
                amazon_account_id: amazonAccountId,
                decision_type: 'bid_change',
                entity_type: 'keyword',
                entity_id: kw.keyword_id,
                campaign_id: kw.campaign_id,
                ad_group_id: kw.ad_group_id,
                keyword_id: kw.keyword_id,
                keyword_text: kw.keyword_text || kw.keyword,
                asin: kw.asin,
                action: 'reduce_bid',
                value_before: currentBid,
                value_after: Number(newBid.toFixed(2)),
                change_pct: Number(((newBid / currentBid - 1) * 100).toFixed(1)),
                rationale: `WASTING: ${clicks} cliques, ${currencySymbol}${spend.toFixed(2)} gasto, zero vendas. Reduzir bid em ${Math.round(reducePct * 100)}%.`,
                data_used: `clicks=${clicks}, spend=${spend.toFixed(2)}, orders=0`,
                risk: 'low',
                requires_approval: autonomyLevel < 2,
                status: (autonomyLevel >= 2 && autoApplyLowRisk) ? 'approved' : 'pending',
                country_code: account.country_code || 'BR',
                currency_code: currencyCode,
                currency_symbol: currencySymbol,
                idempotency_key: iKey,
                source_function: 'runDailyAdsOptimization',
                created_at: now,
              });
              stats.bid_decrease++;
            } else { stats.skipped_dup++; }
          }
        }
        // Redução: ACoS acima da meta
        else if (acos > targetAcos && clicks >= 5 && orders >= 1) {
          const newBid = Math.max(currentBid * (targetAcos / acos), minBid);
          const cappedBid = Math.max(newBid, currentBid * (1 - maxBidDecreasePct / 100));
          if (cappedBid < currentBid - 0.001) {
            const iKey = makeIdempotencyKey(amazonAccountId, 'bid_change', 'keyword', kw.keyword_id, 'reduce_high_acos', today);
            if (!existingKeys.has(iKey)) {
              decisionsToCreate.push({
                amazon_account_id: amazonAccountId,
                decision_type: 'bid_change',
                entity_type: 'keyword',
                entity_id: kw.keyword_id,
                campaign_id: kw.campaign_id,
                ad_group_id: kw.ad_group_id,
                keyword_id: kw.keyword_id,
                keyword_text: kw.keyword_text || kw.keyword,
                asin: kw.asin,
                action: 'reduce_bid',
                value_before: currentBid,
                value_after: Number(cappedBid.toFixed(2)),
                change_pct: Number(((cappedBid / currentBid - 1) * 100).toFixed(1)),
                rationale: `HIGH_ACOS: ACoS ${acos.toFixed(1)}% acima da meta ${targetAcos}%. Bid calculado: ${currencySymbol}${cappedBid.toFixed(2)}.`,
                data_used: `acos=${acos.toFixed(1)}%, clicks=${clicks}, orders=${orders}, spend=${currencySymbol}${spend.toFixed(2)}`,
                risk: 'medium',
                requires_approval: autonomyLevel < 3,
                status: 'pending',
                country_code: account.country_code || 'BR',
                currency_code: currencyCode,
                currency_symbol: currencySymbol,
                idempotency_key: iKey,
                source_function: 'runDailyAdsOptimization',
                created_at: now,
              });
              stats.bid_decrease++;
            } else { stats.skipped_dup++; }
          }
        }
        // Aumento: WINNER
        else if (canIncrease && orders >= minOrders && acos > 0 && acos <= targetAcos && clicks >= 10) {
          const increasePct = Math.min(maxBidIncreasePct, 15) / 100;
          const newBid = Math.min(currentBid * (1 + increasePct), maxBid);
          if (newBid > currentBid + 0.001) {
            const iKey = makeIdempotencyKey(amazonAccountId, 'bid_change', 'keyword', kw.keyword_id, 'increase_winner', today);
            if (!existingKeys.has(iKey)) {
              decisionsToCreate.push({
                amazon_account_id: amazonAccountId,
                decision_type: 'bid_change',
                entity_type: 'keyword',
                entity_id: kw.keyword_id,
                campaign_id: kw.campaign_id,
                ad_group_id: kw.ad_group_id,
                keyword_id: kw.keyword_id,
                keyword_text: kw.keyword_text || kw.keyword,
                asin: kw.asin,
                action: 'increase_bid',
                value_before: currentBid,
                value_after: Number(newBid.toFixed(2)),
                change_pct: Number(((newBid / currentBid - 1) * 100).toFixed(1)),
                rationale: `WINNER: ACoS ${acos.toFixed(1)}% ≤ meta ${targetAcos}% com ${orders} pedidos. Aumentar bid +${Math.round(increasePct * 100)}%.`,
                data_used: `acos=${acos.toFixed(1)}%, orders=${orders}, clicks=${clicks}, sales=${currencySymbol}${sales.toFixed(2)}`,
                risk: 'medium',
                requires_approval: autonomyLevel < 3,
                status: 'pending',
                country_code: account.country_code || 'BR',
                currency_code: currencyCode,
                currency_symbol: currencySymbol,
                idempotency_key: iKey,
                source_function: 'runDailyAdsOptimization',
                created_at: now,
              });
              stats.bid_increase++;
            } else { stats.skipped_dup++; }
          }
        }
      }
    }

    // ── 5. Campanhas: estoque zero → pausar ──
    if (cfg.auto_pause_zero_stock !== false) {
      const activeCampaigns = campaigns.filter(c => (c.state === 'enabled' || c.status === 'enabled') && !c.archived);
      for (const c of activeCampaigns) {
        const product = c.asin ? productMap.get(c.asin) : null;
        if (product && product.inventory_status === 'out_of_stock') {
          const iKey = makeIdempotencyKey(amazonAccountId, 'pause', 'campaign', c.campaign_id, 'pause_zero_stock', today);
          if (!existingKeys.has(iKey)) {
            decisionsToCreate.push({
              amazon_account_id: amazonAccountId,
              decision_type: 'pause',
              entity_type: 'campaign',
              entity_id: c.campaign_id,
              campaign_id: c.campaign_id,
              asin: c.asin,
              action: 'pause_campaign',
              rationale: `Produto ${c.asin} sem estoque. Pausar campanha para evitar gasto desnecessário.`,
              data_used: `inventory_status=out_of_stock`,
              risk: 'low',
              requires_approval: autonomyLevel < 2,
              status: (autonomyLevel >= 2 && cfg.auto_pause_zero_stock) ? 'approved' : 'pending',
              country_code: account.country_code || 'BR',
              currency_code: currencyCode,
              currency_symbol: currencySymbol,
              idempotency_key: iKey,
              source_function: 'runDailyAdsOptimization',
              created_at: now,
            });
            stats.pause_campaign++;
          } else { stats.skipped_dup++; }
        }
      }
    }

    // ── 6. Gravar decisões em lotes ──
    let decisionsCreated = 0;
    for (let i = 0; i < decisionsToCreate.length; i += 50) {
      const batch = decisionsToCreate.slice(i, i + 50);
      await base44.asServiceRole.entities.OptimizationDecision.bulkCreate(batch);
      decisionsCreated += batch.length;
    }

    // ── 7. Finalizar AutopilotRun ──
    const completedAt = new Date().toISOString();
    await base44.asServiceRole.entities.AutopilotRun.update(runRecord.id, {
      status: 'completed',
      completed_at: completedAt,
      campaigns_analyzed: campaigns.length,
      keywords_analyzed: keywords.length,
      decisions_generated: decisionsCreated,
      total_spend_analyzed: campaigns.reduce((s, c) => s + (c.spend || 0), 0),
    });

    return Response.json({
      ok: true,
      decisions_created: decisionsCreated,
      skipped_duplicates: stats.skipped_dup,
      breakdown: stats,
      autonomy_level: autonomyLevel,
      duration_ms: Date.now() - startTime,
    });

  } catch (error) {
    // Garantir que o run nunca fique preso em "running"
    if (runRecord?.id) {
      try {
        const base44Inner = createClientFromRequest(req);
        await base44Inner.asServiceRole.entities.AutopilotRun.update(runRecord.id, {
          status: 'failed', completed_at: new Date().toISOString(), error_message: error.message,
        });
      } catch {}
    }
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});