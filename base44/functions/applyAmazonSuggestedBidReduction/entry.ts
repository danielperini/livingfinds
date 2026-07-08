/**
 * applyAmazonSuggestedBidReduction — ECONOMY_FIRST_DECISION_RULE
 *
 * Regra: se amazon_suggested_bid < current_bid → reduzir para o sugerido.
 *        se amazon_suggested_bid >= current_bid → NÃO alterar (nunca aumentar por sugestão).
 *
 * Prioridade máxima: bloqueia qualquer aumento de bid concorrente no mesmo ciclo.
 * Toda ação vai para AmazonActionQueue com idempotência e registro de economia estimada.
 */
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const today = new Date().toISOString().slice(0, 10);

    // Resolver conta
    let account = null;
    if (body.amazon_account_id) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id });
      account = accs[0];
    }
    if (!account) {
      const accs = await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, '-created_date', 1);
      account = accs[0];
    }
    if (!account) return Response.json({ ok: false, error: 'Conta não encontrada.' });
    const aid = account.id;

    // Carregar configuração de bid mínimo
    const configs = await base44.asServiceRole.entities.AutopilotConfig.filter({ amazon_account_id: aid }).catch(() => []);
    const cfg = configs[0] || {};
    const MIN_BID = Math.max(0.10, cfg.min_bid || 0.10);

    // Validar frescor dos dados
    if (account.last_sync_at) {
      const ageH = (Date.now() - new Date(account.last_sync_at).getTime()) / 3600000;
      if (ageH > 48) return Response.json({ ok: false, skipped: true, reason: `Dados desatualizados (${Math.round(ageH)}h). Motor bloqueado.` });
    }

    // Carregar keywords e campanhas ativas
    const [keywords, campaigns, products] = await Promise.all([
      base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: aid }, '-spend', 1000),
      base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: aid }, null, 300),
      base44.asServiceRole.entities.Product.filter({ amazon_account_id: aid }, null, 200),
    ]);

    // Índices de referência
    const campaignMap = new Map(campaigns.map(c => [c.campaign_id, c]));
    const productMap = new Map(products.map(p => [p.asin, p]));

    // Ações já pendentes hoje (idempotência)
    const existingActions = await base44.asServiceRole.entities.AmazonActionQueue.filter(
      { amazon_account_id: aid }, '-created_date', 500
    ).catch(() => []);
    const usedKeys = new Set(existingActions.map(a => String(a.idempotency_key || '')));

    // Métricas para estimativa de economia (cliques médios)
    const metricsRaw = await base44.asServiceRole.entities.CampaignMetricsDaily.filter(
      { amazon_account_id: aid }, '-date', 200
    ).catch(() => []);
    const clicksByCampaign = {};
    for (const m of metricsRaw) {
      if (!m.campaign_id) continue;
      if (!clicksByCampaign[m.campaign_id]) clicksByCampaign[m.campaign_id] = { clicks: 0, days: 0 };
      clicksByCampaign[m.campaign_id].clicks += m.clicks || 0;
      clicksByCampaign[m.campaign_id].days++;
    }

    const toEnqueue = [];
    const skipped = [];
    const stats = { evaluated: 0, no_suggestion: 0, suggestion_higher: 0, blocked_stock: 0, blocked_inactive: 0, blocked_dup: 0, enqueued: 0 };

    for (const kw of keywords) {
      stats.evaluated++;

      const currentBid = kw.current_bid || kw.bid || 0;
      const suggestedBid = kw.amazon_suggested_bid || kw.suggested_bid || null;

      // Sem sugestão da Amazon
      if (suggestedBid == null || isNaN(Number(suggestedBid)) || Number(suggestedBid) <= 0) {
        stats.no_suggestion++;
        continue;
      }

      const suggested = Number(suggestedBid);
      const current = Number(currentBid);

      // REGRA CENTRAL: só reduzir, nunca aumentar
      if (suggested >= current) {
        stats.suggestion_higher++;
        continue;
      }

      // Validações obrigatórias
      const kwState = String(kw.state || kw.status || '').toLowerCase();
      if (!['enabled', 'active'].includes(kwState)) {
        stats.blocked_inactive++;
        skipped.push({ id: kw.keyword_id, reason: 'keyword_inactive' });
        continue;
      }

      const campaign = kw.campaign_id ? campaignMap.get(kw.campaign_id) : null;
      if (campaign) {
        const campState = String(campaign.state || campaign.status || '').toLowerCase();
        if (!['enabled', 'active'].includes(campState)) {
          stats.blocked_inactive++;
          skipped.push({ id: kw.keyword_id, reason: 'campaign_inactive' });
          continue;
        }
        if (String(campaign.metrics_status || '') === 'missing' || campaign.is_operational === false) {
          stats.blocked_inactive++;
          skipped.push({ id: kw.keyword_id, reason: 'campaign_incomplete' });
          continue;
        }
      }

      // Verificar estoque
      const product = kw.asin ? productMap.get(kw.asin) : null;
      if (product?.inventory_status === 'out_of_stock') {
        stats.blocked_stock++;
        skipped.push({ id: kw.keyword_id, reason: 'out_of_stock' });
        continue;
      }

      // Calcular novo bid — nunca abaixo do min_bid
      const newBid = Math.max(MIN_BID, Math.round(suggested * 100) / 100);

      // Idempotência: account + tipo + keyword_id + current + suggested + data
      const iKey = `suggestedbid|${aid}|kw|${kw.keyword_id || kw.id}|${Math.round(current * 100)}|${Math.round(suggested * 100)}|${today}`;
      if (usedKeys.has(iKey)) {
        stats.blocked_dup++;
        continue;
      }

      // Economia estimada
      const savingsPerClick = current - newBid;
      const campaignMetrics = kw.campaign_id ? clicksByCampaign[kw.campaign_id] : null;
      const avgDailyClicks = campaignMetrics && campaignMetrics.days > 0
        ? Math.round(campaignMetrics.clicks / campaignMetrics.days)
        : 0;
      const expectedSavings = Math.round(savingsPerClick * avgDailyClicks * 100) / 100;

      toEnqueue.push({
        amazon_account_id: aid,
        operation: 'update_bid',
        entity_type: 'keyword',
        entity_id: kw.keyword_id || kw.id,
        campaign_id: kw.campaign_id,
        ad_group_id: kw.ad_group_id,
        keyword_id: kw.keyword_id,
        asin: kw.asin,
        payload: JSON.stringify({
          bid: newBid,
          bid_before: current,
          amazon_suggested_bid: suggested,
          min_bid_used: MIN_BID,
          savings_per_click: Math.round(savingsPerClick * 100) / 100,
          avg_daily_clicks: avgDailyClicks,
          expected_savings_per_day: expectedSavings,
        }),
        idempotency_key: iKey,
        scheduled_at: new Date().toISOString(),
        priority: 1, // ECONOMY_FIRST: máxima prioridade
        confidence: 95,
        status: 'approved', // sem necessidade de aprovação manual — redução de custo
        source_function: 'applyAmazonSuggestedBidReduction',
        reason: 'amazon_suggested_bid_lower_than_current',
        expected_impact: `Redução automática para bid sugerido pela Amazon (R$${current.toFixed(2)} → R$${newBid.toFixed(2)}). Economia estimada: R$${expectedSavings.toFixed(2)}/dia.`,
        rule_applied: 'ECONOMY_FIRST_DECISION_RULE',
        value_before: current,
        value_after: newBid,
        expected_savings: expectedSavings,
        created_at: new Date().toISOString(),
      });
      stats.enqueued++;
    }

    // Salvar em lotes
    for (let i = 0; i < toEnqueue.length; i += 50) {
      await base44.asServiceRole.entities.AmazonActionQueue.bulkCreate(toEnqueue.slice(i, i + 50));
    }

    // Registrar histórico no AdsBidChangeLog
    const historyEntries = toEnqueue.map(a => {
      const p = JSON.parse(a.payload || '{}');
      return {
        amazon_account_id: aid,
        campaign_id: a.campaign_id,
        ad_group_id: a.ad_group_id,
        keyword_id: a.keyword_id,
        asin: a.asin,
        previous_bid: p.bid_before,
        new_bid: a.value_after,
        amazon_suggested_bid: p.amazon_suggested_bid,
        min_bid_used: p.min_bid_used,
        savings_per_click: p.savings_per_click,
        expected_savings: a.expected_savings,
        change_type: 'amazon_suggested_reduction',
        reason: a.reason,
        rule_applied: a.rule_applied,
        execution_id: a.idempotency_key,
        created_at: new Date().toISOString(),
      };
    });
    for (let i = 0; i < historyEntries.length; i += 50) {
      await base44.asServiceRole.entities.AdsBidChangeLog.bulkCreate(historyEntries.slice(i, i + 50)).catch(() => {});
    }

    const totalSavings = toEnqueue.reduce((s, a) => s + (a.expected_savings || 0), 0);

    return Response.json({
      ok: true,
      stats,
      actions_enqueued: toEnqueue.length,
      total_expected_savings_per_day: Math.round(totalSavings * 100) / 100,
      min_bid_used: MIN_BID,
      skipped_count: skipped.length,
    });

  } catch (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
});