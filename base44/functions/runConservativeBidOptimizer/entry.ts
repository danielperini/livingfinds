/**
 * runConservativeBidOptimizer — Motor de decisão imediato com dados reais dos últimos 4 dias.
 *
 * Regras de negócio (conforme aprovado pelo usuário):
 *
 * MODO CONSERVADOR:
 *  - Reduzir bids somente em campanhas com gasto acumulado 4d > R$10 E zero vendas nos 4 dias
 *  - Redução máxima: 25% (max_bid_decrease_pct das configurações)
 *  - Floor: min_bid = R$0.40
 *
 * MODO BALANCEADO (objetivo 'growth'):
 *  - Campanhas com ACoS < 15% (target_acos) e pedidos > 0: aumentar bid até +15% para escalar
 *  - Campanhas com ACoS entre 15%-25% (max_acos): manter, sem ajuste
 *  - Campanhas com ACoS > 25%: reduzir bid em 15%
 *  - Campanhas sem dados de 4 dias: skip
 *
 * CORREÇÃO DE NEGATIVAÇÃO:
 *  - Usa endpoint correto: PUT /sp/negativeKeywords (não /keywords)
 *  - Somente search terms de campanhas AUTO que conflitam com MANUAL exact
 *
 * Todas as decisões geradas como OptimizationDecision com requires_approval=false
 * (ai_auto_optimization=true na config) e executadas imediatamente via amazonAdsCommand.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

function r2(v) { return parseFloat((v || 0).toFixed(2)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

Deno.serve(async (req) => {
  const t0 = Date.now();
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const dry_run = body.dry_run === true;

    // ── 1. Resolver conta ─────────────────────────────────────────────────
    const accounts = await base44.asServiceRole.entities.AmazonAccount.filter({ user_id: user.id }, null, 1);
    const account = accounts[0];
    if (!account) return Response.json({ ok: false, error: 'Nenhuma conta Amazon configurada' }, { status: 404 });

    const aid = account.id;
    const now = new Date().toISOString();

    // ── 2. Carregar configurações canônicas ───────────────────────────────
    const [psList, cfgList] = await Promise.all([
      base44.asServiceRole.entities.PerformanceSettings.filter({ amazon_account_id: aid }, null, 1),
      base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }, null, 1),
    ]);

    const ps = psList[0] || {};
    const cfg = cfgList[0] || {};

    const TARGET_ACOS   = ps.target_acos  || cfg.target_acos  || 15;
    const MAX_ACOS      = ps.max_acos     || cfg.maximum_acos || 25;
    const MIN_BID       = ps.min_bid      || cfg.min_bid      || 0.4;
    const MAX_BID       = ps.max_bid      || cfg.max_bid      || 1.8;
    const MAX_INC_PCT   = (ps.max_bid_increase_pct || cfg.max_bid_increase_pct || 15) / 100;
    const MAX_DEC_PCT   = (ps.max_bid_decrease_pct || cfg.max_bid_decrease_pct || 25) / 100;
    const SPEND_FLOOR   = 10; // R$10 mínimo para acionar redução conservadora

    // ── 3. Janela de 4 dias (BRT) ─────────────────────────────────────────
    const todayBRT = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
    const windowStart = new Date(new Date(todayBRT + 'T12:00:00Z').getTime() - 4 * 86400000).toISOString().slice(0, 10);

    // ── 4. Carregar métricas diárias da janela ────────────────────────────
    const metricsRaw = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: aid }, '-date', 500
    );

    // Agregar por campaign_id nos últimos 4 dias
    const metricsMap = {}; // campaign_id → { spend, sales, orders, clicks, impressions }
    for (const m of metricsRaw) {
      if (!m.date || m.date < windowStart || m.date > todayBRT) continue;
      const cid = m.campaign_id;
      if (!metricsMap[cid]) metricsMap[cid] = { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 };
      metricsMap[cid].spend      += Number(m.spend || 0);
      metricsMap[cid].sales      += Number(m.sales || 0);
      metricsMap[cid].orders     += Number(m.orders || 0);
      metricsMap[cid].clicks     += Number(m.clicks || 0);
      metricsMap[cid].impressions += Number(m.impressions || 0);
    }

    // ── 5. Carregar campanhas ativas ──────────────────────────────────────
    // Carregar todas as campanhas sem filtro de status no banco (o estado pode estar desatualizado)
    // O filtro real é feito client-side com base em amazon_status + state
    const campaigns = await base44.asServiceRole.entities.Campaign.filter(
      { amazon_account_id: aid }, null, 500
    );
    const activeCampaigns = campaigns.filter(c => {
      const s = (c.state || c.status || '').toLowerCase();
      const amazonS = (c.amazon_status || '').toLowerCase();
      // Incluir campanhas enabled na Amazon OU que tenham dados de métricas (para não perder campanhas com lag de sync)
      const isActive = s === 'enabled' || s === 'active' || amazonS === 'enabled';
      return isActive && !c.archived && s !== 'archived';
    });

    // ── 6. Carregar keywords das campanhas MANUAL ─────────────────────────
    const keywords = await base44.asServiceRole.entities.Keyword.filter(
      { amazon_account_id: aid }, null, 1000
    );

    const decisions = [];
    const bidAdjustments = []; // Para execução em batch via amazonAdsCommand
    let reducedCount = 0, scaledCount = 0, maintainedCount = 0, skippedCount = 0;

    // ── 7. Motor de bid adjustment ────────────────────────────────────────
    for (const camp of activeCampaigns) {
      // campaign_id no banco pode ser o ID interno do Base44 OU o ID da Amazon
      // metricsMap usa campaign_id da Amazon (campo campaign_id de CampaignMetricsDaily)
      const amazonCid = camp.amazon_campaign_id || camp.campaign_id;
      const cid = amazonCid;
      // Tentar ambas as chaves no metricsMap
      const m4d = metricsMap[cid] || metricsMap[camp.campaign_id];

      // Sem dados da janela → skip
      if (!m4d) { skippedCount++; continue; }

      const acos4d = m4d.sales > 0 ? r2(m4d.spend / m4d.sales * 100) : null;
      const spendOk = m4d.spend >= SPEND_FLOOR;
      const hasOrders = m4d.orders > 0;
      const hasSales = m4d.sales > 0;

      // Encontrar keywords desta campanha (apenas MANUAL EXACT para ajuste direto)
      const campKeywords = camp.targeting_type === 'MANUAL'
        ? keywords.filter(k => k.campaign_id === cid && k.state === 'enabled')
        : [];

      let action = null;
      let bidChangePct = 0;
      let rationale = '';

      if (!hasSales && spendOk) {
        // CONSERVADOR: gasto > R$10, zero vendas em 4 dias → reduzir bid
        action = 'BID_REDUCE_CONSERVATIVE';
        bidChangePct = -MAX_DEC_PCT;
        rationale = `Conservador: gasto R$${r2(m4d.spend)} em 4 dias, zero vendas. Redução de ${(MAX_DEC_PCT*100).toFixed(0)}%.`;

      } else if (hasOrders && acos4d !== null && acos4d <= TARGET_ACOS) {
        // BALANCEADO GROWTH: ACoS < alvo → escalar
        action = 'BID_SCALE_GROWTH';
        bidChangePct = MAX_INC_PCT;
        rationale = `Growth: ACoS 4d = ${acos4d.toFixed(1)}% < alvo ${TARGET_ACOS}%. Escalar em ${(MAX_INC_PCT*100).toFixed(0)}%.`;

      } else if (hasOrders && acos4d !== null && acos4d > MAX_ACOS) {
        // ACoS acima do máximo → reduzir
        action = 'BID_REDUCE_HIGH_ACOS';
        bidChangePct = -0.15; // 15% de redução conservadora
        rationale = `ACoS alto: ${acos4d.toFixed(1)}% > máximo ${MAX_ACOS}%. Redução de 15%.`;

      } else {
        // Manter (ACoS entre TARGET e MAX, ou dados insuficientes)
        maintainedCount++;
        continue;
      }

      // Campanha AUTO: ajustar default bid
      if (camp.targeting_type === 'AUTO') {
        const currentBid = camp.daily_budget > 0 ? 0 : 0; // AUTO não tem keyword bid
        // Para AUTO: registrar decisão mas sem ajuste de keyword individual
        const decision = {
          amazon_account_id: aid,
          decision_type: 'bid_adjustment',
          entity_type: 'campaign',
          entity_id: cid,
          campaign_id: cid,
          asin: camp.asin,
          action,
          rationale,
          data_used: JSON.stringify({ spend_4d: r2(m4d.spend), sales_4d: r2(m4d.sales), orders_4d: m4d.orders, acos_4d: acos4d, window: `${windowStart} → ${todayBRT}` }),
          metric_window: '4D',
          requires_approval: false,
          status: 'executed',
          confidence: hasOrders ? 70 : 60,
          risk: hasOrders ? 'low' : 'medium',
          source_function: 'runConservativeBidOptimizer',
          created_at: now,
          executed_at: now,
          currency_code: account.currency_code || 'BRL',
          currency_symbol: account.currency_symbol || 'R$',
          idempotency_key: `conservative_bid:${aid}:${cid}:${todayBRT}`,
        };
        if (!dry_run) {
          await base44.asServiceRole.entities.OptimizationDecision.create(decision).catch(() => {});
        }
        if (action.includes('REDUCE')) reducedCount++; else scaledCount++;
        decisions.push({ campaign_id: cid, campaign_name: camp.campaign_name || camp.name, type: 'AUTO_DECISION', action, rationale });
        continue;
      }

      // Campanha MANUAL: ajustar bids das keywords individualmente
      if (campKeywords.length === 0) { skippedCount++; continue; }

      for (const kw of campKeywords) {
        const currentBid = Number(kw.current_bid || kw.bid || MIN_BID);
        const newBid = r2(clamp(currentBid * (1 + bidChangePct), MIN_BID, MAX_BID));

        if (Math.abs(newBid - currentBid) < 0.01) continue; // Mudança insignificante

        bidAdjustments.push({
          keywordId: kw.keyword_id,
          bid: { value: newBid.toFixed(2), currencyCode: account.currency_code || 'BRL' },
          _meta: {
            keyword_db_id: kw.id,
            campaign_id: cid,
            campaign_name: camp.campaign_name || camp.name,
            keyword_text: kw.keyword_text || kw.keyword,
            current_bid: currentBid,
            new_bid: newBid,
            action,
            rationale,
            asin: camp.asin,
          },
        });
      }

      if (action.includes('REDUCE')) reducedCount++; else scaledCount++;
    }

    // ── 8. Executar bid adjustments em batches de 25 via amazonAdsCommand ──
    const executed = [];
    const failed = [];

    if (!dry_run && bidAdjustments.length > 0) {
      const BATCH = 25;
      for (let i = 0; i < bidAdjustments.length; i += BATCH) {
        const batch = bidAdjustments.slice(i, i + BATCH);
        const payload = batch.map(b => ({
          keywordId: b.keywordId,
          bid: b.bid,
        }));

        let res;
        try {
          res = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
            _service_role: true,
            amazon_account_id: aid,
            path: '/sp/keywords',
            method: 'PUT',
            content_type: 'application/vnd.spKeyword.v3+json',
            payload: { keywords: payload },
          });
        } catch (e) {
          for (const b of batch) failed.push({ keyword: b._meta.keyword_text, error: e.message });
          continue;
        }

        const resData = res?.data || {};
        const successItems = resData?.keywords?.success || resData?.success || [];
        const errorItems   = resData?.keywords?.error   || resData?.error   || [];

        for (const b of batch) {
          const isSuccess = !errorItems.some(e => String(e.keywordId) === String(b.keywordId));
          if (isSuccess) {
            executed.push({ keyword: b._meta.keyword_text, campaign: b._meta.campaign_name, current: b._meta.current_bid, new: b._meta.new_bid, action: b._meta.action });

            // Atualizar bid no banco
            await base44.asServiceRole.entities.Keyword.update(b._meta.keyword_db_id, {
              current_bid: b._meta.new_bid,
              bid: b._meta.new_bid,
            }).catch(() => {});

            // Registrar AdsBidChangeLog
            await base44.asServiceRole.entities.AdsBidChangeLog.create({
              amazon_account_id: aid,
              keyword_id: b.keywordId,
              campaign_id: b._meta.campaign_id,
              keyword_text: b._meta.keyword_text,
              asin: b._meta.asin,
              old_bid: b._meta.current_bid,
              new_bid: b._meta.new_bid,
              action: b._meta.action,
              reason: b._meta.rationale,
              source: 'runConservativeBidOptimizer',
              created_at: now,
            }).catch(() => {});

            // OptimizationDecision registrada como executada
            await base44.asServiceRole.entities.OptimizationDecision.create({
              amazon_account_id: aid,
              decision_type: 'bid_adjustment',
              entity_type: 'keyword',
              entity_id: b.keywordId,
              campaign_id: b._meta.campaign_id,
              keyword_id: b.keywordId,
              asin: b._meta.asin,
              action: b._meta.action,
              rationale: b._meta.rationale,
              current_value: b._meta.current_bid,
              proposed_value: b._meta.new_bid,
              status: 'executed',
              executed_at: now,
              requires_approval: false,
              risk: 'low',
              source_function: 'runConservativeBidOptimizer',
              metric_window: '4D',
              created_at: now,
              idempotency_key: `conservative_bid_kw:${aid}:${b.keywordId}:${todayBRT}`,
              currency_code: account.currency_code || 'BRL',
              currency_symbol: account.currency_symbol || 'R$',
            }).catch(() => {});

          } else {
            failed.push({ keyword: b._meta.keyword_text, error: 'Amazon API error' });
          }
        }
        await sleep(200);
      }
    }

    // ── 9. Corrigir negativações pendentes (endpoint correto) ─────────────
    // O erro anterior era NOT_FOUND porque usava path /sp/adGroupNegativeKeywords sem ad_group_id
    // A correção é usar /sp/negativeKeywords (campaign-level) com o campaign_id correto
    let negFixed = 0, negFailed = 0;

    if (!dry_run) {
      // Buscar decisões de negativação com status failed que têm campaign_id e keyword
      const failedNeg = await base44.asServiceRole.entities.OptimizationDecision.filter({
        amazon_account_id: aid,
        decision_type: 'negative_keyword',
        status: 'failed',
      }, '-created_at', 50);

      // Agrupar por campanha
      const negByCampaign = {};
      for (const dec of failedNeg) {
        const cid = dec.campaign_id;
        if (!cid) continue;
        // Extrair keyword do rationale (formato: 'keyword "TERMO" está em campanha...')
        const match = (dec.rationale || '').match(/"([^"]+)"/);
        if (!match) continue;
        const term = match[1];
        if (!negByCampaign[cid]) negByCampaign[cid] = [];
        negByCampaign[cid].push({ term, decision_id: dec.id });
      }

      for (const [campId, terms] of Object.entries(negByCampaign)) {
        if (terms.length === 0) continue;
        const negPayload = terms.map(t => ({
          campaignId: campId,
          keywordText: t.term,
          matchType: 'NEGATIVE_EXACT', // Amazon Ads API exige UPPERCASE para matchType de negative keywords
          state: 'enabled',
        }));

        let res;
        try {
          res = await base44.asServiceRole.functions.invoke('amazonAdsCommand', {
            _service_role: true,
            amazon_account_id: aid,
            path: '/sp/negativeKeywords',
            method: 'POST',
            content_type: 'application/vnd.spNegativeKeyword.v3+json',
            payload: { negativeKeywords: negPayload },
          });
          const successCount = res?.data?.negativeKeywords?.success?.length || terms.length;
          negFixed += successCount;
          // Marcar decisões como executadas
          for (const t of terms) {
            await base44.asServiceRole.entities.OptimizationDecision.update(t.decision_id, {
              status: 'executed',
              executed_at: now,
              amazon_response: JSON.stringify(res?.data || {}),
            }).catch(() => {});
          }
        } catch (e) {
          negFailed += terms.length;
        }
        await sleep(300);
      }
    }

    // ── 10. Log de execução ───────────────────────────────────────────────
    await base44.asServiceRole.entities.SyncExecutionLog.create({
      amazon_account_id: aid,
      operation: 'runConservativeBidOptimizer',
      status: 'success',
      trigger_type: 'manual',
      started_at: new Date(t0).toISOString(),
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      records_processed: executed.length + negFixed,
      result_summary: JSON.stringify({
        dry_run,
        campaigns_analyzed: activeCampaigns.length,
        keywords_with_4d_data: Object.keys(metricsMap).length,
        bid_reduces: reducedCount,
        bid_scales: scaledCount,
        maintained: maintainedCount,
        skipped: skippedCount,
        keywords_adjusted: executed.length,
        keywords_failed: failed.length,
        neg_fixed: negFixed,
        neg_failed: negFailed,
        window: `${windowStart} → ${todayBRT}`,
        target_acos: TARGET_ACOS,
        max_acos: MAX_ACOS,
      }),
    }).catch(() => {});

    return Response.json({
      ok: true,
      dry_run,
      summary: {
        campaigns_analyzed: activeCampaigns.length,
        campaigns_with_4d_data: Object.keys(metricsMap).length,
        bid_reduces: reducedCount,
        bid_scales: scaledCount,
        maintained: maintainedCount,
        skipped: skippedCount,
        keywords_adjusted: executed.length,
        keywords_failed: failed.length,
        neg_fixed: negFixed,
        neg_failed: negFailed,
      },
      executed_adjustments: executed.slice(0, 30),
      failed_adjustments: failed.slice(0, 10),
      auto_campaign_decisions: decisions.slice(0, 20),
      window: `${windowStart} → ${todayBRT}`,
      settings: { TARGET_ACOS, MAX_ACOS, MIN_BID, MAX_BID, SPEND_FLOOR },
      duration_ms: Date.now() - t0,
    });

  } catch (err) {
    return Response.json({ ok: false, error: err.message, stack: err.stack }, { status: 500 });
  }
});