import { createClientFromRequest } from 'npm:@base44/sdk@0.8.40';

const LOSS_LIMIT = 5;
const MIN_BID = 0.25;
const MAX_ACTIONS = 20;
const FRESHNESS_MINUTES = 40;

const n = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const text = (value: unknown) => String(value || '').trim();
const nowIso = () => new Date().toISOString();
const brtDate = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const roundBid = (value: number) => Math.max(MIN_BID, Math.round(value * 100) / 100);
const ageMinutes = (value: unknown) => {
  const ts = new Date(String(value || 0)).getTime();
  return Number.isFinite(ts) ? (Date.now() - ts) / 60000 : Number.POSITIVE_INFINITY;
};
const enabled = (row: any) => ['enabled', 'active'].includes(text(row?.state || row?.status).toLowerCase());

function reductionPct(loss: number) {
  if (loss >= 15) return 0.60;
  if (loss >= 10) return 0.45;
  if (loss >= 7.5) return 0.35;
  return 0.25;
}

Deno.serve(async (request) => {
  const startedAt = Date.now();
  try {
    const base44 = createClientFromRequest(request);
    const body = await request.json().catch(() => ({}));
    const authenticated = await base44.auth.isAuthenticated().catch(() => false);
    if (!authenticated && !body._service_role) {
      return Response.json({ ok: false, error: 'Não autorizado' }, { status: 401 });
    }

    const accounts = body.amazon_account_id
      ? await base44.asServiceRole.entities.AmazonAccount.filter({ id: body.amazon_account_id }, null, 1)
      : await base44.asServiceRole.entities.AmazonAccount.filter({ status: 'connected' }, null, 100);
    const results: any[] = [];

    for (const account of accounts) {
      const accountId = account.id;
      const [terms, keywords, campaigns, rules, priorDecisions] = await Promise.all([
        base44.asServiceRole.entities.SearchTerm.filter({ amazon_account_id: accountId }, '-updated_date', 5000).catch(() => []),
        base44.asServiceRole.entities.Keyword.filter({ amazon_account_id: accountId }, '-updated_at', 5000).catch(() => []),
        base44.asServiceRole.entities.Campaign.filter({ amazon_account_id: accountId }, '-updated_at', 2000).catch(() => []),
        base44.asServiceRole.entities.BudgetRule.filter({ amazon_account_id: accountId }, '-updated_date', 10).catch(() => []),
        base44.asServiceRole.entities.OptimizationDecision.filter({ amazon_account_id: accountId }, '-created_at', 1000).catch(() => []),
      ]);

      const targetAcos = Math.max(1, n(rules[0]?.target_acos, 15));
      const today = brtDate();
      const campaignById = new Map(campaigns.map((row: any) => [text(row.campaign_id || row.amazon_campaign_id || row.id), row]));
      const keywordCandidates = keywords.filter(enabled);
      const activeDecisionKeys = new Set(priorDecisions
        .filter((row: any) => ['approved', 'executing', 'waiting_retry', 'executed'].includes(text(row.status)))
        .map((row: any) => text(row.idempotency_key)));

      const candidates: any[] = [];
      for (const term of terms) {
        const rowDate = text(term.date || term.report_date || term.metric_date || term.start_date).slice(0, 10);
        const updatedAt = term.updated_at || term.updated_date || term.synced_at || term.created_at;
        if (rowDate && rowDate !== today) continue;
        if (!rowDate && ageMinutes(updatedAt) > FRESHNESS_MINUTES) continue;

        const campaignId = text(term.campaign_id || term.amazon_campaign_id);
        const campaign = campaignById.get(campaignId);
        if (campaign && !enabled(campaign)) continue;

        const spend = n(term.spend);
        const sales = n(term.sales_14d ?? term.sales);
        const orders = n(term.orders_14d ?? term.orders);
        const clicks = n(term.clicks);
        const cpc = clicks > 0 ? spend / clicks : n(term.cpc);
        const allowedSpend = sales * targetAcos / 100;
        const loss = Math.max(0, spend - allowedSpend);
        const projectedNextClickLoss = loss + Math.max(cpc, MIN_BID);
        if (projectedNextClickLoss < LOSS_LIMIT || clicks < 2) continue;

        const keywordText = text(term.keyword_text || term.keyword || term.search_term).toLocaleLowerCase('pt-BR');
        const keywordId = text(term.keyword_id || term.amazon_keyword_id);
        const keyword = keywordCandidates.find((row: any) =>
          (keywordId && text(row.keyword_id || row.id) === keywordId) ||
          (text(row.campaign_id) === campaignId &&
            text(row.ad_group_id) === text(term.ad_group_id) &&
            text(row.keyword_text || row.keyword).toLocaleLowerCase('pt-BR') === keywordText)
        );
        if (!keyword) continue;

        const currentBid = n(keyword.current_bid ?? keyword.bid ?? term.bid, 0);
        if (currentBid <= MIN_BID) continue;

        const winner = orders > 0 && sales > 0 && spend / sales * 100 <= targetAcos;
        if (winner || keyword.protected_high_performance === true) continue;

        const pct = reductionPct(loss);
        const nextBid = roundBid(currentBid * (1 - pct));
        if (nextBid >= currentBid) continue;

        const entityId = text(keyword.keyword_id || keyword.id);
        const idempotencyKey = `intraday-loss:${accountId}:${entityId}:${today}:${nextBid.toFixed(2)}`;
        if (activeDecisionKeys.has(idempotencyKey)) continue;

        candidates.push({ term, keyword, campaignId, entityId, currentBid, nextBid, pct, spend, sales, orders, clicks, cpc, loss, projectedNextClickLoss, idempotencyKey });
      }

      candidates.sort((a, b) => b.loss - a.loss);
      let created = 0;
      for (const item of candidates.slice(0, Math.min(MAX_ACTIONS, n(body.max_actions, MAX_ACTIONS)))) {
        const rationale = `Proteção intradiária: prejuízo publicitário estimado R$ ${item.loss.toFixed(2)}; próximo clique projetaria R$ ${item.projectedNextClickLoss.toFixed(2)}, acima do limite R$ ${LOSS_LIMIT.toFixed(2)}. Bid reduzido ${(item.pct * 100).toFixed(0)}%, sem aumento e sem pausar vencedor.`;
        await base44.asServiceRole.entities.OptimizationDecision.create({
          amazon_account_id: accountId,
          entity_type: 'keyword',
          entity_id: item.entityId,
          keyword_id: text(item.keyword.keyword_id || item.keyword.id),
          keyword_text: text(item.keyword.keyword_text || item.keyword.keyword || item.term.search_term),
          campaign_id: item.campaignId,
          ad_group_id: text(item.keyword.ad_group_id || item.term.ad_group_id),
          asin: text(item.keyword.asin || item.term.asin),
          action: 'reduce_bid',
          canonical_action_type: 'INTRADAY_LOSS_GUARD',
          decision_type: 'intraday_ads_loss_guard',
          value_before: item.currentBid,
          value_after: item.nextBid,
          current_value: item.currentBid,
          proposed_value: item.nextBid,
          change_pct: -Math.round(item.pct * 100),
          status: body.dry_run === true ? 'suggested' : 'approved',
          queue_status: body.dry_run === true ? 'not_queued' : 'pending',
          execution_mode: 'EXPEDITED_QUEUE',
          priority_class: 'P1',
          confidence: 0.99,
          requires_approval: false,
          requires_fresh_data: true,
          maximum_data_age_minutes: FRESHNESS_MINUTES,
          data_window_end: nowIso(),
          idempotency_key: item.idempotencyKey,
          conflict_group: `keyword_bid:${accountId}:${item.entityId}`,
          rationale,
          reason: rationale,
          evidence: {
            date_brt: today,
            spend: item.spend,
            sales: item.sales,
            orders: item.orders,
            clicks: item.clicks,
            cpc: item.cpc,
            target_acos: targetAcos,
            estimated_loss: item.loss,
            projected_next_click_loss: item.projectedNextClickLoss,
            loss_limit: LOSS_LIMIT,
            source: 'SearchTerm intraday persisted data',
          },
          source_function: 'runIntradayAdsLossGuard',
          max_attempts: 3,
          attempt_count: 0,
          created_at: nowIso(),
          updated_at: nowIso(),
        });
        created++;
      }

      results.push({
        account_id: accountId,
        target_acos: targetAcos,
        loss_limit: LOSS_LIMIT,
        evaluated_terms: terms.length,
        eligible: candidates.length,
        decisions_created: created,
        dry_run: body.dry_run === true,
      });
    }

    return Response.json({
      ok: true,
      engine: 'intraday-ads-loss-guard-v1',
      policy: {
        anticipates_next_click: true,
        loss_limit_brl: LOSS_LIMIT,
        reductions: '25% / 35% / 45% / 60%',
        minimum_bid_brl: MIN_BID,
        winner_protection: true,
        no_bid_increase: true,
      },
      results,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error: any) {
    return Response.json({ ok: false, error: error?.message || 'Falha no guardrail intradiário' }, { status: 500 });
  }
});
